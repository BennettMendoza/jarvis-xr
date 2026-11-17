#!/usr/bin/env python3
"""Puente Jarvis -> Claude Code.

Corre en tu PC. Recibe los encargos que le das a Jarvis en el Quest 3 y se los
pasa a Claude Code, que prepara material de estudio en Documentos/Jarvis/Tareas.

Uso:  python puente.py      (o doble clic en iniciar-puente.bat)
Solo usa la biblioteca estándar de Python + openssl (viene con Git para Windows).
"""
import json
import os
import queue
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HOME = Path.home()
BASE = HOME / "Documents" / "Jarvis"
TAREAS = BASE / "Tareas"
CONF = BASE / "puente.json"
DB = BASE / "encargos.json"
CERT, KEY = BASE / "cert.pem", BASE / "key.pem"
PORT = int(os.environ.get("JARVIS_PORT", "8443"))
ORIGINS = {"https://bennettmendoza.github.io", "http://localhost:8765", "http://127.0.0.1:8765"}
CLAUDE = shutil.which("claude") or str(HOME / ".local" / "bin" / "claude.exe")
OPENSSL = shutil.which("openssl") or r"C:\Program Files\Git\usr\bin\openssl.exe"
# Claude puede leer, escribir y buscar en internet, solo dentro de la carpeta del encargo.
# Sin terminal (Bash): no puede ejecutar programas en tu PC.
TOOLS = "Read,Write,Edit,Glob,Grep,WebSearch,WebFetch"

PROMPT = """Trabajas junto a JARVIS, el asistente de estudio en realidad mixta de un estudiante.
El estudiante te encargó esto: «{texto}»

Haz la tarea completa en ESTA carpeta, como borrador listo para que el estudiante lo revise:
- Ensayo, reporte o trabajo escrito: redáctalo COMPLETO en TRABAJO.md (título, introducción,
  desarrollo con subtítulos, conclusión y referencias). Busca en internet y usa solo fuentes reales
  que hayas verificado; cítalas en formato APA. Extensión: la que pida el encargo, o unas
  1000-1500 palabras si no lo dice. Nivel y tono de estudiante universitario, natural, no robótico.
- Ejercicios o problemas: resuélvelos todos en SOLUCIONES.md con el procedimiento completo.
- Siempre: NOTAS.md con los 5-8 puntos clave del trabajo, explicados en sencillo, para que el
  estudiante pueda explicarlo y defenderlo si se lo preguntan.
Escribe todo en español. Si falta información (materia, nivel, extensión), haz suposiciones
razonables y anótalas al inicio de NOTAS.md.

Cuando termines, tu respuesta final debe ser SOLO un resumen de 2 a 4 frases, en español, para
leerse en voz alta: qué hiciste y en qué archivo quedó. Sin markdown."""


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no envía nada; solo elige la interfaz de red
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def ensure_cert(ip, conf):
    if CERT.exists() and KEY.exists() and conf.get("cert_ip") == ip:
        return
    log(f"Creando certificado HTTPS para {ip}…")
    subprocess.run(
        [OPENSSL, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "825",
         "-keyout", str(KEY), "-out", str(CERT), "-subj", "/CN=Jarvis puente",
         "-addext", f"subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost"],
        check=True, capture_output=True,
    )
    conf["cert_ip"] = ip


# ---------------- Encargos ----------------
lock = threading.Lock()
encargos = load_json(DB, []) if DB.exists() else []
trabajo = queue.Queue()


def slug(texto):
    s = re.sub(r"[^\w\s-]", "", texto.lower(), flags=re.UNICODE)
    return re.sub(r"\s+", "-", s).strip("-")[:40] or "encargo"


def nuevo_encargo(texto):
    eid = secrets.token_hex(4)
    carpeta = TAREAS / f"{datetime.now():%Y-%m-%d}_{slug(texto)}_{eid}"
    e = {"id": eid, "texto": texto, "estado": "en cola", "resumen": "", "carpeta": str(carpeta),
         "creado": datetime.now().isoformat(timespec="seconds")}
    with lock:
        encargos.append(e)
        save_json(DB, encargos)
    trabajo.put(eid)
    log(f"Nuevo encargo {eid}: {texto}")
    return e


def actualizar(eid, **cambios):
    with lock:
        for e in encargos:
            if e["id"] == eid:
                e.update(cambios)
        save_json(DB, encargos)


def worker():
    while True:
        eid = trabajo.get()
        e = next((x for x in encargos if x["id"] == eid), None)
        if not e:
            continue
        carpeta = Path(e["carpeta"])
        carpeta.mkdir(parents=True, exist_ok=True)
        (carpeta / "ENCARGO.txt").write_text(e["texto"], encoding="utf-8")
        actualizar(eid, estado="trabajando")
        log(f"Claude trabajando en {eid}…")
        try:
            r = subprocess.run(
                [CLAUDE, "-p", PROMPT.format(texto=e["texto"]), "--output-format", "json",
                 "--allowedTools", TOOLS, "--disallowedTools", "Bash", "--permission-mode", "acceptEdits"],
                cwd=carpeta, capture_output=True, text=True, encoding="utf-8", timeout=1800,
            )
            data = {}
            try:
                data = json.loads(r.stdout)
            except Exception:
                pass
            if r.returncode != 0 or data.get("is_error"):
                msg = (data.get("result") or r.stderr or r.stdout or "error desconocido").strip()[:400]
                low = msg.lower()
                if "login" in low or "auth" in low:
                    msg = "Claude Code no tiene sesión iniciada en la PC. Abre una terminal, escribe claude y entra con tu cuenta."
                elif "limit" in low:
                    hora = re.search(r"resets\s+([0-9:apm]+)", msg)
                    msg = ("Llegaste al límite de uso de tu plan de Claude"
                           + (f"; se libera a las {hora.group(1)}" if hora else "")
                           + ". Vuelve a pedírmelo después.")
                actualizar(eid, estado="error", resumen=msg)
                log(f"Error en {eid}: {msg}")
            else:
                resumen = (data.get("result") or "Listo.").strip()
                actualizar(eid, estado="listo", resumen=resumen)
                log(f"Listo {eid}: {resumen[:120]}")
        except subprocess.TimeoutExpired:
            actualizar(eid, estado="error", resumen="Claude tardó más de 30 minutos y lo detuve.")
        except FileNotFoundError:
            actualizar(eid, estado="error", resumen="No encontré Claude Code en la PC.")


# ---------------- Abrir cosas en la PC ----------------
# Solo abre: páginas web (http/https), apps de una lista fija y documentos/medios de tus carpetas.
# Nunca ejecuta programas sueltos (.exe, .bat, etc.) ni comandos que vengan de afuera.
import random
import unicodedata
import urllib.parse
import webbrowser

APPS = {
    "word": "winword", "excel": "excel", "powerpoint": "powerpnt", "power point": "powerpnt",
    "bloc de notas": "notepad", "notepad": "notepad", "calculadora": "calc", "explorador": "explorer",
    "archivos": "explorer", "chrome": "chrome", "edge": "msedge", "spotify": "spotify:", "teams": "msteams:",
    "outlook": "outlook", "paint": "mspaint", "configuracion": "ms-settings:", "whatsapp": "whatsapp:",
}
DOC_EXT = {".docx", ".doc", ".pdf", ".pptx", ".ppt", ".xlsx", ".xls", ".txt", ".md", ".odt", ".rtf",
           ".jpg", ".jpeg", ".png", ".gif", ".mp4", ".mp3", ".wav", ".m4a", ".csv"}
TIPO_EXT = {"word": {".docx", ".doc"}, "excel": {".xlsx", ".xls", ".csv"}, "powerpoint": {".pptx", ".ppt"},
            "pdf": {".pdf"}, "imagen": {".jpg", ".jpeg", ".png", ".gif"}, "video": {".mp4"}, "audio": {".mp3", ".wav", ".m4a"}}


def _norm(s):
    s = unicodedata.normalize("NFD", s.lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


def _carpetas():
    out = [HOME / "Documents", HOME / "Desktop", HOME / "Downloads", HOME / "Escritorio", HOME / "Documentos"]
    for od in HOME.glob("OneDrive*"):
        out.append(od)
    return [c for c in out if c.is_dir()]


def buscar_archivos(consulta, exts, limite=10):
    palabras = [w for w in _norm(consulta).split() if len(w) > 1]
    hallados, vistos = [], 0
    for base in _carpetas():
        for raiz, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "navegador", "navegador-chrome", "AppData")]
            for f in files:
                vistos += 1
                if vistos > 40000:
                    break
                ext = os.path.splitext(f)[1].lower()
                if ext not in exts or f.startswith("~$"):
                    continue
                n = _norm(f)
                if all(w in n for w in palabras):
                    p = Path(raiz) / f
                    try:
                        hallados.append((p.stat().st_mtime, p))
                    except OSError:
                        pass
    hallados.sort(reverse=True)
    return [p for _, p in hallados[:limite]]


def pc_abrir(tipo, valor, probar=False):
    valor = (valor or "").strip()
    if tipo == "web":
        url = valor if re.match(r"^https?://", valor) else "https://www.google.com/search?q=" + urllib.parse.quote(valor)
        if not re.match(r"^https?://[^\s]+$", url):
            raise ValueError("Esa dirección no parece válida.")
        if not probar:
            webbrowser.open(url)
        return f"Abrí {url[:80]} en tu PC."
    if tipo == "app":
        clave = _norm(valor)
        destino = next((v for k, v in APPS.items() if k in clave), None)
        if not destino:
            raise ValueError("No tengo esa app en mi lista. Puedo abrir: " + ", ".join(sorted(set(APPS))) + ".")
        if not probar:
            subprocess.Popen(["cmd", "/c", "start", "", destino], shell=False)
        return f"Abrí {valor} en tu PC."
    if tipo == "archivo":
        q = _norm(valor)
        exts = next((e for k, e in TIPO_EXT.items() if k in q), DOC_EXT)
        for k in TIPO_EXT:
            q = q.replace(k, " ")
        aleatorio = any(w in q for w in ("aleatorio", "random", "cualquier", "cualquiera"))
        for w in ("aleatorio", "random", "cualquiera", "cualquier", "archivo", "documento", "un ", "el ", "la ", "de "):
            q = q.replace(w, " ")
        candidatos = buscar_archivos(q, exts, limite=200 if aleatorio else 10)
        if not candidatos:
            raise ValueError("No encontré ningún archivo así en Documentos, Escritorio, Descargas ni OneDrive.")
        elegido = random.choice(candidatos) if aleatorio else candidatos[0]
        if not probar:
            os.startfile(str(elegido))
        return f"Abrí {elegido.name} en tu PC."
    raise ValueError("No sé qué abrir.")


# ---------------- Microsoft Teams (navegador automático) ----------------
# Tu escuela no permite que apps externas usen la API de Microsoft, así que el puente abre
# Google Chrome con un perfil propio (Documentos/Jarvis/navegador-chrome), donde inicias sesión UNA
# vez con tu cuenta de la escuela (marcando «mantener la sesión iniciada»). Después lo abre oculto
# y lee las tareas que la app de Tareas de Microsoft descarga. Tu contraseña la escribes tú en Chrome.
import html as htmlmod

NAV_DIR = BASE / "navegador-chrome"
NAV_OK = BASE / "navegador-ok.txt"
DEBUG = BASE / "teams-debug.json"
SESION = BASE / "teams-sesion.json"  # cookies de sesión de Microsoft; quédatela solo en tu PC
nav_lock = threading.Lock()
TEAMS_URL = "https://teams.microsoft.com/v2/"
ASSIGN_URL = "https://assignments.onenote.com/classes/all/list"
teams = {"estado": "conectado" if NAV_OK.exists() else "desconectado", "mensaje": "", "codigo": "", "url": ""}
teams_cache = {"lista": [], "hora": 0}


def texto_plano(h):
    h = re.sub(r"<(br|/p|/div|/li)[^>]*>", "\n", h or "", flags=re.I)
    return re.sub(r"\n{3,}", "\n\n", htmlmod.unescape(re.sub(r"<[^>]+>", "", h))).strip()


def _recorrer(obj, tareas, nombres):
    if isinstance(obj, dict):
        if obj.get("id") and obj.get("displayName"):
            nombres[obj["id"]] = obj["displayName"]
            if "dueDateTime" in obj or "instructions" in obj or "assignTo" in obj:
                tareas[obj["id"]] = obj
        for v in obj.values():
            _recorrer(v, tareas, nombres)
    elif isinstance(obj, list):
        for v in obj:
            _recorrer(v, tareas, nombres)


def _capturar(visible, espera):
    """Abre Chrome (visible para iniciar sesión, oculto para leer) y junta las tareas.
    Devuelve (tareas, nombres, info) donde info dice si vio datos o si pidió iniciar sesión."""
    from playwright.sync_api import sync_playwright
    tareas, nombres, urls = {}, {}, []
    info = {"datos": False, "pide_login": False, "final": ""}
    with nav_lock, sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(NAV_DIR), channel="chrome", headless=not visible, viewport={"width": 1280, "height": 900},
            # la app de Tareas inicia sesión dentro de un iframe: necesita cookies de terceros
            args=["--disable-features=ThirdPartyStoragePartitioning,TrackingProtection3pcd"])
        # Tu escuela no deja que la sesión sobreviva al cerrar Chrome: la guardamos nosotros
        # (solo en esta PC) y la restauramos al abrir.
        if SESION.exists():
            try:
                ctx.add_cookies(load_json(SESION, {}).get("cookies", []))
            except Exception:
                pass

        def on_resp(r):
            try:
                if "json" not in (r.headers.get("content-type") or ""):
                    return
                if not re.search(r"assign|/edu|class", r.url, re.I) or "telemetry" in r.url:
                    return
                urls.append(f"{r.status} {r.url[:180]}")
                if r.status == 200:
                    info["datos"] = True
                    _recorrer(r.json(), tareas, nombres)
            except Exception:
                pass

        ctx.on("response", on_resp)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        if visible:
            # 1) inicio de sesión normal en Teams; esperamos a que llegue a Teams (hasta 10 min)
            page.goto(TEAMS_URL, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(6000)  # deja que Teams redirija al inicio de sesión
            fin, seguidos = time.time() + 600, 0
            while time.time() < fin and seguidos < 8:  # 8 s seguidos dentro de Teams = ya entró
                page.wait_for_timeout(1000)
                seguidos = seguidos + 1 if page.url.startswith("https://teams.microsoft.com/v2") else 0
        # 2) la app de Tareas: aquí se descargan las tareas de todas tus clases
        try:
            page.goto(ASSIGN_URL, wait_until="domcontentloaded", timeout=60000)
        except Exception:
            pass
        fin = time.time() + espera
        reintento = False
        while time.time() < fin and not tareas:
            page.wait_for_timeout(1000)
            if any(("login_required" in f.url or "interaction_required" in f.url) for f in page.frames):
                info["pide_login"] = True
                if visible:
                    continue
                if reintento:
                    break
                # Plan B: entrar «de frente» a Teams y elegir la cuenta guardada, luego volver a Tareas
                reintento = True
                try:
                    page.goto(TEAMS_URL, wait_until="domcontentloaded", timeout=60000)
                    page.wait_for_timeout(6000)
                    if "login.microsoftonline.com" in page.url:
                        tile = page.locator("text=/@/")
                        if tile.count():
                            tile.first.click(timeout=5000)
                            page.wait_for_timeout(8000)
                    if "login.microsoftonline.com" in page.url:
                        break  # pide contraseña: hay que volver a conectar
                    page.goto(ASSIGN_URL, wait_until="domcontentloaded", timeout=60000)
                    info["pide_login"] = False
                    fin = time.time() + espera
                except Exception:
                    break
            if info["datos"] and time.time() > fin - espera + 15:
                break  # ya respondió la lista (aunque venga vacía)
        if tareas:
            page.wait_for_timeout(4000)
        info["final"] = page.url[:200]
        if info["datos"]:
            try:
                save_json(SESION, {"cookies": ctx.storage_state()["cookies"]})
            except Exception:
                pass
        ctx.close()
    save_json(DEBUG, {"urls": urls[-60:], "info": info, "tareas": len(tareas)})
    return tareas, nombres, info


def _login_thread():
    try:
        tareas, _, info = _capturar(visible=True, espera=180)
        if info["datos"]:
            NAV_OK.write_text(datetime.now().isoformat(), encoding="utf-8")
            teams.update(estado="conectado", mensaje="Teams conectado.")
            log("Teams conectado (Chrome).")
        else:
            teams.update(estado="desconectado",
                         mensaje="No alcancé a ver tus tareas. Vuelve a intentarlo: inicia sesión, marca «Sí» en mantener la sesión iniciada y espera a que cargue.")
    except Exception as ex:
        teams.update(estado="error", mensaje=f"No pude abrir Chrome: {ex}"[:300])
        log("Teams: " + teams["mensaje"])


def teams_login():
    if teams["estado"] == "esperando":
        return teams
    teams.update(estado="esperando", codigo="", url="",
                 mensaje="Se abrió Google Chrome en su PC. Inicie sesión con su cuenta de la escuela y, cuando pregunte, elija «Sí» para mantener la sesión iniciada. Luego espere: la ventana se cierra sola.")
    threading.Thread(target=_login_thread, daemon=True).start()
    return teams


def teams_tareas():
    if not NAV_OK.exists():
        raise RuntimeError("Teams no está conectado.")
    tareas, nombres, info = _capturar(visible=False, espera=45)
    if not info["datos"]:
        if info["pide_login"]:
            NAV_OK.unlink(missing_ok=True)
            teams.update(estado="desconectado", mensaje="La sesión de Teams se cerró. Vuelve a conectar y elige «Sí» en mantener la sesión iniciada.")
            raise RuntimeError(teams["mensaje"])
        raise RuntimeError("Abrí Teams pero no encontré la lista de tareas (detalle en teams-debug.json).")
    hoy = datetime.utcnow().isoformat()[:10]
    out = []
    for a in tareas.values():
        if a.get("status") not in (None, "assigned"):
            continue
        subs = a.get("submissions") or []
        if any(isinstance(s, dict) and s.get("status") in ("submitted", "returned") for s in subs):
            continue
        due = a.get("dueDateTime") or ""
        if due and due[:10] < hoy:
            continue
        ins = a.get("instructions")
        ins = ins.get("content", "") if isinstance(ins, dict) else str(ins or "")
        out.append({"id": a["id"], "clase": nombres.get(a.get("classId"), ""), "titulo": a.get("displayName", ""),
                    "entrega": due, "instrucciones": texto_plano(ins)[:3000], "url": a.get("webUrl", "")})
    out.sort(key=lambda x: x["entrega"] or "9999")
    teams_cache.update(lista=out, hora=time.time())
    return out


# ---------------- Servidor ----------------
PAGINA = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Puente Jarvis</title><body style="background:#04080c;color:#dcf0f6;font:20px system-ui;padding:40px">
<h1 style="color:#62d6ff">Puente Jarvis activo ✓</h1>
<p>El navegador ya confía en tu PC. Cierra esta pestaña y vuelve a Jarvis.</p></body>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "PuenteJarvis/1"

    def log_message(self, *a):
        pass

    def cors(self):
        origin = self.headers.get("Origin")
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Jarvis-Code")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def reply(self, code, body, ctype="application/json; charset=utf-8"):
        raw = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def authed(self):
        if secrets.compare_digest(self.headers.get("X-Jarvis-Code", ""), CODE):
            return True
        self.reply(401, {"error": "Código de enlace incorrecto."})
        return False

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            return self.reply(200, PAGINA.encode("utf-8"), "text/html; charset=utf-8")
        if self.path == "/api/ping":
            if self.authed():
                self.reply(200, {"ok": True, "claude": Path(CLAUDE).exists()})
            return
        if self.path == "/api/teams/estado":
            if self.authed():
                self.reply(200, teams)
            return
        if self.path == "/api/teams/tareas":
            if self.authed():
                try:
                    self.reply(200, {"tareas": teams_tareas()})
                except Exception as ex:
                    self.reply(502, {"error": str(ex)})
            return
        if self.path == "/api/encargos":
            if self.authed():
                with lock:
                    lista = [{k: e[k] for k in ("id", "texto", "estado", "resumen", "creado")} for e in encargos[-20:]]
                self.reply(200, {"encargos": lista})
            return
        self.reply(404, {"error": "No existe."})

    def do_POST(self):
        if self.path not in ("/api/encargos", "/api/teams/login", "/api/teams/encargar", "/api/pc/abrir"):
            return self.reply(404, {"error": "No existe."})
        if not self.authed():
            return
        try:
            n = min(int(self.headers.get("Content-Length", 0)), 8000)
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self.reply(400, {"error": "Petición inválida."})
        if self.path == "/api/teams/login":
            return self.reply(200, teams_login())
        if self.path == "/api/pc/abrir":
            try:
                msg = pc_abrir(str(body.get("tipo", "")), str(body.get("valor", ""))[:300], bool(body.get("probar")))
                log(msg)
                return self.reply(200, {"mensaje": msg})
            except Exception as ex:
                return self.reply(400, {"error": str(ex)[:300]})
        if self.path == "/api/teams/encargar":
            t = next((x for x in teams_cache["lista"] if x["id"] == body.get("id")), None)
            if not t:
                return self.reply(404, {"error": "No encontré esa tarea; vuelve a revisar Teams."})
            texto = (f"Tarea de Teams. Clase: {t['clase']}. Título: {t['titulo']}. "
                     f"Entrega: {t['entrega'][:10] or 'sin fecha'}. Instrucciones del profesor: {t['instrucciones'] or '(sin instrucciones)'}")
            e = nuevo_encargo(texto[:4000])
            return self.reply(200, {"id": e["id"], "estado": e["estado"]})
        texto = str(body.get("texto", "")).strip()[:1500]
        if not texto:
            return self.reply(400, {"error": "El encargo está vacío."})
        e = nuevo_encargo(texto)
        self.reply(200, {"id": e["id"], "estado": e["estado"]})


def main():
    global CODE
    TAREAS.mkdir(parents=True, exist_ok=True)
    conf = load_json(CONF, {})
    conf.setdefault("codigo", f"{secrets.randbelow(10**6):06d}")
    CODE = conf["codigo"]
    ip = local_ip()
    ensure_cert(ip, conf)
    save_json(CONF, conf)

    # los que quedaron a medias la última vez vuelven a la cola
    for e in encargos:
        if e["estado"] in ("en cola", "trabajando"):
            trabajo.put(e["id"])
    threading.Thread(target=worker, daemon=True).start()

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)

    print("\n" + "=" * 56)
    print("  PUENTE JARVIS ACTIVO")
    print(f"  Dirección:  https://{ip}:{PORT}")
    print(f"  Código:     {CODE}")
    print(f"  Material:   {TAREAS}")
    print(f"  Claude:     {'OK' if Path(CLAUDE).exists() else 'NO ENCONTRADO'}")
    print("  Deja esta ventana abierta. Ctrl+C para apagar.")
    print("=" * 56 + "\n", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("Puente apagado.")


if __name__ == "__main__":
    main()
