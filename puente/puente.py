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


# ---------------- Microsoft Teams (Graph, tareas de clase) ----------------
# Inicio de sesión por «código de dispositivo»: entras en microsoft.com/devicelogin con tu cuenta
# de la escuela. Se usa el cliente público de Microsoft Graph PowerShell (el mismo que usa el
# módulo oficial). El token se guarda solo en esta PC (Documentos/Jarvis/teams.json).
import urllib.parse
import urllib.request
import urllib.error
import html as htmlmod

MS_CLIENT = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
MS_SCOPE = "EduAssignments.ReadBasic User.Read offline_access"
MS_AUTH = "https://login.microsoftonline.com/organizations/oauth2/v2.0"
TEAMS_FILE = BASE / "teams.json"
teams = {"estado": "desconectado", "mensaje": "", "codigo": "", "url": ""}
teams_tok = load_json(TEAMS_FILE, {}) if TEAMS_FILE.exists() else {}
if teams_tok.get("refresh_token"):
    teams["estado"] = "conectado"


def http_json(url, data=None, token=None):
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def explica_error_ms(j):
    e = j.get("error")
    d = j.get("error_description") or (e.get("message") if isinstance(e, dict) else "") or str(e or "")
    if "AADSTS65001" in d or "AADSTS90094" in d or ("admin" in d.lower() and ("consent" in d.lower() or "approv" in d.lower())):
        return "Tu escuela pide que un administrador apruebe el acceso; con la API no se puede. Hay que usar el método del navegador automático."
    if "AADSTS53003" in d or "AADSTS50105" in d:
        return "Tu escuela bloquea este tipo de acceso para tu cuenta."
    return d[:300] or "Error desconocido de Microsoft."


def teams_login_thread(dc):
    interval = int(dc.get("interval", 5))
    fin = time.time() + int(dc.get("expires_in", 900))
    while time.time() < fin:
        time.sleep(interval)
        st, j = http_json(MS_AUTH + "/token", {
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "client_id": MS_CLIENT, "device_code": dc["device_code"]})
        if st == 200 and j.get("access_token"):
            j["obtenido"] = time.time()
            teams_tok.clear(); teams_tok.update(j)
            save_json(TEAMS_FILE, teams_tok)
            teams.update(estado="conectado", mensaje="Conectado a Teams.", codigo="", url="")
            log("Teams conectado.")
            return
        err = j.get("error")
        if err == "authorization_pending":
            continue
        if err == "slow_down":
            interval += 5
            continue
        teams.update(estado="error", mensaje=explica_error_ms(j), codigo="", url="")
        log("Teams: " + teams["mensaje"])
        return
    teams.update(estado="desconectado", mensaje="El código expiró. Vuelve a pedirlo.", codigo="", url="")


def teams_login():
    st, j = http_json(MS_AUTH + "/devicecode", {"client_id": MS_CLIENT, "scope": MS_SCOPE})
    if st != 200:
        teams.update(estado="error", mensaje=explica_error_ms(j))
        return teams
    teams.update(estado="esperando", codigo=j["user_code"], url=j["verification_uri"],
                 mensaje=f"Entra a {j['verification_uri']} y escribe el código {j['user_code']}.")
    threading.Thread(target=teams_login_thread, args=(j,), daemon=True).start()
    return teams


def teams_token():
    if teams_tok.get("access_token") and time.time() - teams_tok.get("obtenido", 0) < int(teams_tok.get("expires_in", 3600)) - 120:
        return teams_tok["access_token"]
    if not teams_tok.get("refresh_token"):
        raise RuntimeError("Teams no está conectado.")
    st, j = http_json(MS_AUTH + "/token", {"grant_type": "refresh_token", "client_id": MS_CLIENT,
                                           "refresh_token": teams_tok["refresh_token"], "scope": MS_SCOPE})
    if st != 200:
        teams.update(estado="desconectado", mensaje="La sesión de Teams expiró. Vuelve a conectar.")
        raise RuntimeError(teams["mensaje"])
    j["obtenido"] = time.time()
    teams_tok.update(j)
    save_json(TEAMS_FILE, teams_tok)
    return teams_tok["access_token"]


def texto_plano(h):
    h = re.sub(r"<(br|/p|/div|/li)[^>]*>", "\n", h or "", flags=re.I)
    return re.sub(r"\n{3,}", "\n\n", htmlmod.unescape(re.sub(r"<[^>]+>", "", h))).strip()


teams_cache = {"lista": [], "hora": 0}


def teams_tareas():
    tok = teams_token()
    G = "https://graph.microsoft.com/v1.0"
    st, cls = http_json(G + "/education/me/classes?$select=id,displayName", token=tok)
    clases = {c["id"]: c.get("displayName", "") for c in cls.get("value", [])} if st == 200 else {}
    st, j = http_json(G + "/education/me/assignments?$expand=submissions&$top=200", token=tok)
    if st != 200:
        st, j = http_json(G + "/education/me/assignments?$top=200", token=tok)
    if st != 200:
        raise RuntimeError(explica_error_ms(j))
    ahora = datetime.utcnow().isoformat()
    out = []
    for a in j.get("value", []):
        if a.get("status") not in (None, "assigned"):
            continue
        subs = a.get("submissions") or []
        if any(s.get("status") in ("submitted", "returned") for s in subs):
            continue
        due = a.get("dueDateTime") or ""
        if due and due < ahora[:10]:
            continue  # ya venció
        out.append({"id": a["id"], "clase": clases.get(a.get("classId"), ""), "titulo": a.get("displayName", ""),
                    "entrega": due, "instrucciones": texto_plano((a.get("instructions") or {}).get("content", ""))[:3000],
                    "url": a.get("webUrl", "")})
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
        if self.path not in ("/api/encargos", "/api/teams/login", "/api/teams/encargar"):
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
