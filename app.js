// Jarvis XR — orbe de realidad mixta para Meta Quest 3.
// Cerebro: Groq (chat + Whisper). Voz: speechSynthesis del navegador. Todo gratis.
import * as THREE from "three";

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem("jarvis." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("jarvis." + k, JSON.stringify(v)); } catch {} },
};

// ---------------- Configuración ----------------
// Groq retira modelos con frecuencia: estas listas van en orden de preferencia y
// al guardar la clave se elige el primero que tu cuenta tenga disponible.
const CHAT_PREFS = ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
const STT_PREFS = ["whisper-large-v3-turbo", "whisper-large-v3"];
const RETIRED = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
const cfg = {
  key: store.get("key", ""),
  model: RETIRED.includes(store.get("model", "")) ? CHAT_PREFS[0] : store.get("model", CHAT_PREFS[0]),
  stt: store.get("stt", "whisper-large-v3-turbo"),
  handsFree: store.get("handsFree", true),
  name: store.get("name", ""),
};
$("#name").value = cfg.name;
$("#name").addEventListener("change", (e) => { cfg.name = e.target.value.trim().slice(0, 40); store.set("name", cfg.name); });
$("#key").value = cfg.key;
$("#model").value = cfg.model;
$("#stt").value = cfg.stt;
$("#handsfree").checked = cfg.handsFree;
$("#cur-model").textContent = cfg.model + " (sin comprobar)";

let tasks = store.get("tasks", []);
let turns = [];
let state = "idle"; // idle | listening | thinking | speaking
let lastText = "Sistemas en línea. Mantén el gatillo para hablarme, o di «Jarvis».";
let lastHeard = "";
let followUntil = 0; // ventana para seguir hablando sin decir «Jarvis»
const ok = { key: false, mic: false, tts: false, xr: false };

function dot(id, v) { const d = $("#d-" + id); d.classList.toggle("ok", v === true); d.classList.toggle("bad", v === false); }
function refreshEnter() {
  $("#enter").disabled = !(ok.key && ok.mic);
  $("#ptt").disabled = !(ok.key && ok.mic);
  $("#enter-hint").textContent = !ok.key ? "Primero guarda tu clave de Groq." :
    !ok.mic ? "Activa el micrófono." :
    ok.xr ? "Todo listo. Entra y coloca el orbe donde quieras." :
    "Este navegador no tiene realidad mixta; ábrelo en el Quest 3. Aquí puedes probarlo en 2D.";
}

// ---------------- Groq ----------------
const API = "https://api.groq.com/openai/v1";
async function groqError(r) {
  let msg = "";
  try { const j = await r.json(); msg = j.error?.message || ""; } catch {}
  if (r.status === 401) return "La clave de Groq no es válida.";
  if (r.status === 429) return "Llegaste al límite gratis de Groq por ahora. Espera un minuto.";
  if (r.status === 404 || /does not exist|do not have access|decommissioned/i.test(msg)) return `El modelo «${cfg.model}» ya no está disponible en Groq. Toca «Guardar y probar» para que elija otro automáticamente.`;
  return `Groq respondió ${r.status}. ${msg}`.trim();
}
async function chat(messages) {
  const r = await fetch(API + "/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + cfg.key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model, messages, temperature: 0.6, max_completion_tokens: 1500,
      ...(cfg.model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
    }),
  });
  if (!r.ok) throw new Error(await groqError(r));
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || "";
}
async function transcribe(blob) {
  const fd = new FormData();
  const ext = blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm";
  fd.append("file", blob, "voz." + ext);
  fd.append("model", cfg.stt);
  fd.append("language", "es");
  fd.append("response_format", "json");
  fd.append("temperature", "0");
  // pista de vocabulario para que Whisper escriba «Jarvis» correctamente
  fd.append("prompt", "Jarvis.");
  const r = await fetch(API + "/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + cfg.key }, body: fd });
  if (!r.ok) throw new Error(await groqError(r));
  return ((await r.json()).text || "").trim();
}

async function pickModels() {
  const r = await fetch(API + "/models", { headers: { Authorization: "Bearer " + cfg.key } });
  if (!r.ok) throw new Error(await groqError(r));
  const ids = new Set(((await r.json()).data || []).filter((m) => m.active !== false).map((m) => m.id));
  if (!ids.has(cfg.model)) {
    const m = CHAT_PREFS.find((id) => ids.has(id)) || [...ids].find((id) => !/whisper|guard|orpheus|tts/i.test(id));
    if (!m) throw new Error("Tu cuenta de Groq no tiene modelos de chat disponibles.");
    cfg.model = m;
  }
  if (!ids.has(cfg.stt)) cfg.stt = STT_PREFS.find((id) => ids.has(id)) || cfg.stt;
  $("#model").value = cfg.model; $("#stt").value = cfg.stt;
  $("#cur-model").textContent = cfg.model;
  store.set("model", cfg.model); store.set("stt", cfg.stt);
}

$("#save").addEventListener("click", async () => {
  cfg.key = $("#key").value.trim();
  cfg.model = $("#model").value.trim() || CHAT_PREFS[0];
  cfg.stt = $("#stt").value.trim() || STT_PREFS[0];
  store.set("key", cfg.key);
  $("#save").disabled = true; $("#save").textContent = "Probando…";
  try {
    await pickModels();
    addLog("j", "Modelo elegido: " + cfg.model);
    const t = await chat([{ role: "user", content: "Responde solo: OK" }]);
    ok.key = !!t; dot("key", true);
    addLog("j", "Conexión con el cerebro establecida.");
  } catch (e) {
    ok.key = false; dot("key", false); addLog("e", e.message);
  }
  $("#save").disabled = false; $("#save").textContent = "Guardar y probar";
  refreshEnter();
});
$("#handsfree").addEventListener("change", (e) => { cfg.handsFree = e.target.checked; store.set("handsFree", cfg.handsFree); });

// ---------------- Log y pendientes (2D) ----------------
function addLog(kind, text) {
  const d = document.createElement("div"); d.className = "msg " + kind; d.textContent = text;
  $("#log").append(d); $("#log").scrollTop = $("#log").scrollHeight;
}
function renderTasks() {
  const ul = $("#tasks"); ul.innerHTML = "";
  if (!tasks.length) { const li = document.createElement("li"); li.className = "done"; li.style.textDecoration = "none"; li.textContent = "Sin pendientes. Dile: «Jarvis, añade repasar química»."; ul.append(li); }
  tasks.forEach((t, i) => { const li = document.createElement("li"); li.textContent = `${i + 1}. ${t.text}`; if (t.done) li.className = "done"; ul.append(li); });
  panelDirty = true;
}

function setState(s) {
  state = s;
  $("#state").textContent = { idle: "En línea", listening: "Escuchando", thinking: "Procesando", speaking: "Hablando" }[s];
  panelDirty = true;
}

// ---------------- Temporizador ----------------
const timer = { end: 0, total: 0, label: "" };
function startTimer(min) { timer.total = min * 60; timer.end = Date.now() + timer.total * 1000; timer.label = min <= 10 ? "Descanso" : "Enfoque"; panelDirty = true; }
function timerLeft() { return timer.end ? Math.max(0, (timer.end - Date.now()) / 1000) : 0; }
const mmss = (s) => String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(Math.floor(s % 60)).padStart(2, "0");
setInterval(() => {
  if (timer.end && Date.now() >= timer.end) {
    timer.end = 0; chime();
    const msg = timer.label === "Descanso" ? "Terminó el descanso. De vuelta al trabajo cuando estés listo." : `Bloque de ${Math.round(timer.total / 60)} minutos completado. Buen trabajo. Tómate cinco minutos.`;
    say(msg);
  }
  // solo redibuja si corre el temporizador o cambió el minuto del reloj
  const minute = new Date().getMinutes();
  if (timer.end || minute !== lastMinute) { lastMinute = minute; panelDirty = true; }
}, 1000);
let lastMinute = -1;

// ---------------- Cerebro ----------------
const ACT = /\[\[\s*(TAREA|HECHA|BORRAR|TIMER|ENCARGO|TEAMS|HACER_TEAMS|CONECTAR_TEAMS)\s*:?\s*([^\]]*)\]\]/gi;
function rules() {
  const list = tasks.length ? tasks.map((t, i) => `${i + 1}. [${t.done ? "x" : " "}] ${t.text}`).join("\n") : "(ninguno)";
  return `Eres JARVIS, la inteligencia artificial personal de un estudiante, y vives como un orbe holográfico en sus lentes de realidad mixta. Tu estilo: mayordomo digital británico en español. Formal pero cálido, seguro, eficiente, con humor seco y sutil; nunca empalagoso ni exagerado. Frases como «A su servicio», «Enseguida», «Me permito sugerir…» encajan, sin abusar. No asumas el género del usuario.${cfg.name ? ` Dirígete al usuario como «${cfg.name}».` : ""}
Reglas:
- Todo lo que escribes se lee en voz alta: respuestas breves (2 a 5 frases) salvo que pidan detalle. Sin markdown, sin listas largas, sin emojis.
- Si explicas algo, sé claro y da un ejemplo concreto. En un quiz, haz UNA pregunta a la vez y espera la respuesta.
- Si el estudiante te pide hacer una tarea, ensayo o trabajo, no le expliques cómo hacerlo: mándalo como ENCARGO a su PC (si el puente está conectado) y confirma en una frase.
- La entrada viene de un reconocimiento de voz: si algo suena raro, interpreta lo más probable.
Fecha y hora: ${new Date().toLocaleString("es-MX", { dateStyle: "full", timeStyle: "short" })}.
Temporizador: ${timer.end ? "quedan " + mmss(timerLeft()) : "apagado"}.
Pendientes:
${list}
Para ejecutar acciones, escribe al FINAL de tu respuesta estas etiquetas exactas, cada una en su línea, solo cuando el estudiante lo pida:
[[TAREA: texto]] añade un pendiente · [[HECHA: n]] marca hecho el número n · [[BORRAR: n]] elimina el número n · [[TIMER: minutos]] inicia un temporizador de enfoque.
${bridge.ok
    ? `[[ENCARGO: descripción completa]] manda la tarea a Claude en la PC del estudiante, que la hace completa como borrador (ensayo redactado con referencias reales, o ejercicios resueltos con procedimiento) más unas notas con los puntos clave, en la carpeta Tareas. Úsalo cuando el estudiante diga que tiene una tarea o trabajo y quiera que la hagas. Incluye en la descripción materia, tema, qué piden y fecha de entrega si las dijo. Si falta lo esencial (materia o qué piden), pregúntalo antes de encargar. Acompáñalo de [[TAREA: …]] para anotarla en pendientes.
Encargos recientes en la PC: ${bridge.list.slice(-5).map((e) => `«${e.texto.slice(0, 60)}» (${e.estado})`).join("; ") || "ninguno"}.
Microsoft Teams (${teamsInfo.estado}): [[TEAMS]] revisa las tareas pendientes de Teams (úsalo cuando pida checar sus tareas o pendientes de Teams) · [[HACER_TEAMS: n]] manda la tarea n de la lista de Teams a Claude para que la haga (una etiqueta por tarea; si dice «hazlas todas», pon una por cada tarea) · [[CONECTAR_TEAMS]] inicia la conexión con Teams si no está conectado.
Tareas de Teams conocidas: ${teamsInfo.list.length ? teamsInfo.list.map((t, i) => `${i + 1}. ${t.clase ? t.clase + " — " : ""}${t.titulo} (entrega ${t.entrega ? t.entrega.slice(0, 10) : "sin fecha"})`).join("; ") : "aún no revisadas"}.`
    : "La conexión con la PC está apagada: si el estudiante pide mandar una tarea a Claude en su PC, explícale que abra el puente en su PC y lo conecte en la configuración de Jarvis."}`;
}
function runActions(text) {
  let changed = false; const done = [], del = [];
  for (const [, k, a] of text.matchAll(ACT)) {
    const K = k.toUpperCase(), v = a.trim();
    if (K === "TAREA" && v) { tasks.push({ text: v.slice(0, 120), done: false }); changed = true; }
    if (K === "HECHA") done.push(parseInt(v, 10) - 1);
    if (K === "BORRAR") del.push(parseInt(v, 10) - 1);
    if (K === "TIMER") startTimer(Math.min(180, Math.max(1, parseInt(v, 10) || 25)));
    if (K === "ENCARGO" && v) sendEncargo(v);
    if (K === "TEAMS") teamsCheck();
    if (K === "CONECTAR_TEAMS") teamsConnect();
    if (K === "HACER_TEAMS") teamsDo(parseInt(v, 10));
  }
  done.forEach((i) => { if (tasks[i]) { tasks[i].done = true; changed = true; } });
  del.sort((a, b) => b - a).forEach((i) => { if (tasks[i]) { tasks.splice(i, 1); changed = true; } });
  if (changed) { store.set("tasks", tasks); renderTasks(); }
}
const clean = (t) => t.replace(ACT, "").replace(/[*#_`]/g, "").trim();

let busy = false;
async function ask(text) {
  if (busy || !text) return;
  busy = true;
  lastHeard = text; addLog("u", text);
  turns.push({ role: "user", content: text });
  setState("thinking");
  try {
    const reply = await chat([{ role: "system", content: rules() }, ...turns.slice(-12)]);
    turns.push({ role: "assistant", content: reply });
    runActions(reply);
    const shown = clean(reply) || "Hecho.";
    addLog("j", shown);
    await say(shown);
    followUntil = Date.now() + 8000;
  } catch (e) {
    turns.pop();
    addLog("e", e.message);
    lastText = e.message; setState("idle");
  }
  busy = false;
}

// ---------------- Puente con la PC (Claude Code) ----------------
const bridge = { url: store.get("bridgeUrl", ""), code: store.get("bridgeCode", ""), ok: false, list: [], announced: new Set(store.get("announced", [])) };
$("#bridge-url").value = bridge.url;
$("#bridge-code").value = bridge.code;
function bridgeLink() { const u = $("#bridge-url").value.trim().replace(/\/+$/, ""); $("#bridge-open").href = u || "#"; return u; }
bridgeLink();
$("#bridge-url").addEventListener("input", bridgeLink);

async function bridgeFetch(path, opts = {}) {
  const r = await fetch(bridge.url + path, {
    ...opts,
    headers: { "X-Jarvis-Code": bridge.code, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "El puente respondió " + r.status);
  return j;
}
async function bridgeConnect(quiet = false) {
  bridge.url = bridgeLink(); bridge.code = $("#bridge-code").value.trim();
  store.set("bridgeUrl", bridge.url); store.set("bridgeCode", bridge.code);
  if (!bridge.url || !bridge.code) { bridge.ok = false; dot("pc", null); return; }
  try {
    const j = await bridgeFetch("/api/ping");
    bridge.ok = true; dot("pc", true);
    if (!quiet) addLog("j", j.claude ? "Conectado con su PC. Ya puedo mandarle tareas a Claude." : "Conectado con su PC, pero no encuentro Claude Code instalado allá.");
    pollBridge(true);
  } catch (e) {
    bridge.ok = false; dot("pc", false);
    if (!quiet) addLog("e", e.message === "Failed to fetch" || e.name === "TypeError"
      ? "No llego a su PC. Revise que el puente esté abierto, que estén en el mismo Wi-Fi y toque «Abrir puente» para aceptar el aviso de seguridad."
      : e.message);
  }
}
$("#bridge-connect").addEventListener("click", () => bridgeConnect(false));

async function sendEncargo(texto) {
  if (!bridge.ok) { addLog("e", "No puedo mandar el encargo: el puente con su PC no está conectado."); return; }
  try {
    await bridgeFetch("/api/encargos", { method: "POST", body: JSON.stringify({ texto }) });
    addLog("j", "Encargo enviado a Claude en su PC: " + texto);
    pollBridge(true);
  } catch (e) { addLog("e", "No pude mandar el encargo: " + e.message); }
}

const pendingNews = [];
async function pollBridge(silentFirst = false) {
  if (!bridge.ok) return;
  try {
    const { encargos } = await bridgeFetch("/api/encargos");
    bridge.list = encargos || [];
    for (const e of bridge.list) {
      if ((e.estado === "listo" || e.estado === "error") && !bridge.announced.has(e.id)) {
        bridge.announced.add(e.id);
        if (!silentFirst || Date.now() - new Date(e.creado).getTime() < 3 * 3600e3) pendingNews.push(e);
      }
    }
    store.set("announced", [...bridge.announced].slice(-100));
    dot("pc", true);
  } catch { dot("pc", false); }
}
setInterval(() => pollBridge(), 20000);
// Avisa cuando Jarvis está libre, sin interrumpir lo que está diciendo.
setInterval(() => {
  if (!pendingNews.length || busy || state !== "idle" || recorder) return;
  const e = pendingNews.shift();
  if (e.estado === "voz") { say(e.texto); return; }
  const tema =e.texto.length > 50 ? e.texto.slice(0, 50) + "…" : e.texto;
  if (e.estado === "listo") {
    turns.push({ role: "assistant", content: `(Aviso) El material del encargo «${e.texto}» está listo en la carpeta Tareas de la PC. Resumen: ${e.resumen}` });
    addLog("j", `Material listo: ${tema}\n${e.resumen}`);
    say(`Su material está listo: ${tema}. ${e.resumen}`);
  } else {
    addLog("e", `El encargo «${tema}» falló: ${e.resumen}`);
    say("Hubo un problema con un encargo en su PC. Le dejé el detalle en la conversación.");
  }
}, 3000);
if (bridge.url && bridge.code) bridgeConnect(true);

// ---------------- Microsoft Teams (a través del puente) ----------------
const teamsInfo = { estado: "sin revisar", list: [] };
const fecha = (iso) => iso ? new Date(iso).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" }) : "sin fecha";
async function teamsCheck() {
  if (!bridge.ok) { say("Para revisar Teams necesito el puente con su PC encendido."); return; }
  try {
    const st = await bridgeFetch("/api/teams/estado");
    teamsInfo.estado = st.estado;
    if (st.estado !== "conectado") { await teamsConnect(); return; }
    const { tareas } = await bridgeFetch("/api/teams/tareas");
    teamsInfo.list = tareas || [];
    dot("teams", true);
    const n = teamsInfo.list.length;
    const lista = teamsInfo.list.map((t, i) => `${i + 1}. ${t.clase ? t.clase + ": " : ""}${t.titulo}, entrega ${fecha(t.entrega)}`);
    addLog("j", n ? "Tareas pendientes en Teams:\n" + lista.join("\n") : "No hay tareas pendientes en Teams.");
    turns.push({ role: "assistant", content: n ? "(Revisé Teams) Pendientes:\n" + lista.join("\n") : "(Revisé Teams) No hay pendientes." });
    pendingNews.push({ estado: "voz", texto: n
      ? `Tiene ${n} ${n === 1 ? "tarea pendiente" : "tareas pendientes"} en Teams. ${lista.slice(0, 4).join(". ")}. ¿Quiere que empiece con alguna, o con todas?`
      : "Revisé Teams: no tiene tareas pendientes. Bien hecho." });
  } catch (e) { addLog("e", "Teams: " + e.message); say("No pude revisar Teams. Le dejé el detalle en la conversación."); }
}
async function teamsConnect() {
  try {
    const st = await bridgeFetch("/api/teams/login", { method: "POST", body: "{}" });
    if (st.estado === "error") throw new Error(st.mensaje);
    teamsInfo.estado = "esperando";
    lastText = st.mensaje; panelDirty = true;
    addLog("j", "Conectar Teams: " + st.mensaje);
    pendingNews.push({ estado: "voz", texto: "Para conectar Teams abrí Microsoft Edge en su PC. Inicie sesión ahí con su cuenta de la escuela, una sola vez. Cuando termine, la ventana se cierra sola y reviso sus tareas." });
    const t0 = Date.now();
    const iv = setInterval(async () => {
      try {
        const s = await bridgeFetch("/api/teams/estado");
        if (s.estado === "conectado") { clearInterval(iv); teamsInfo.estado = "conectado"; dot("teams", true); addLog("j", "Teams conectado."); teamsCheck(); }
        else if (s.estado === "error" || Date.now() - t0 > 15 * 60e3) { clearInterval(iv); dot("teams", false); addLog("e", "Teams: " + (s.mensaje || "no se completó la conexión.")); }
      } catch { /* reintenta en el siguiente ciclo */ }
    }, 5000);
  } catch (e) { dot("teams", false); addLog("e", "Teams: " + e.message); }
}
async function teamsDo(n) {
  const t = teamsInfo.list[n - 1];
  if (!t) { addLog("e", `No tengo la tarea ${n} de Teams; primero pídame revisar Teams.`); return; }
  try {
    await bridgeFetch("/api/teams/encargar", { method: "POST", body: JSON.stringify({ id: t.id }) });
    addLog("j", `Encargo enviado a Claude: ${t.titulo}`);
    pollBridge(true);
  } catch (e) { addLog("e", "No pude mandar la tarea de Teams: " + e.message); }
}
$("#teams-connect").addEventListener("click", () => (bridge.ok ? teamsCheck() : addLog("e", "Primero conecte el puente con su PC.")));

// ---------------- Voz de Jarvis (TTS) ----------------
// Dos motores: la voz del sistema (speechSynthesis) si hay una en español, y si no
// (el navegador del Quest no trae), Piper: una voz neural gratis que corre dentro
// del navegador. El modelo (~60 MB) se descarga una vez y queda guardado.
// Perfiles de voz. «rate» < 1 hace la voz más grave y pausada (estilo mayordomo);
// «fx» le agrega un filtro con un leve eco metálico, como de asistente holográfico.
const VOICES = {
  jarvis: { id: "es_ES-davefx-medium", rate: 0.93, fx: true, label: "Jarvis · formal (España)" },
  jarvisMx: { id: "es_MX-ald-medium", rate: 0.91, fx: true, label: "Jarvis · latino" },
  natural: { id: "es_MX-ald-medium", rate: 1, fx: false, label: "Natural (México)" },
};
let voiceProfile = VOICES[store.get("voice", "jarvis")] || VOICES.jarvis;
let PIPER_VOICE = voiceProfile.id;
let voice = null, engine = null, piper = null, piperLoading = null, currentAudio = null, speakToken = 0;
const ttsNote = (t) => { $("#tts-note").textContent = t ? " · " + t : ""; };

const voiceSel = $("#voice");
for (const [k, v] of Object.entries(VOICES)) { const o = document.createElement("option"); o.value = k; o.textContent = v.label; voiceSel.append(o); }
voiceSel.value = store.get("voice", "jarvis");
voiceSel.addEventListener("change", async () => {
  store.set("voice", voiceSel.value);
  voiceProfile = VOICES[voiceSel.value];
  if (voiceProfile.id !== PIPER_VOICE) { PIPER_VOICE = voiceProfile.id; piperLoading = null; if (engine === "piper") engine = null; await loadPiper(); }
  say("Voz actualizada. A su servicio.");
});

function pickVoice() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  const es = vs.filter((v) => /^es/i.test(v.lang));
  voice = es.find((v) => /mx|419|us/i.test(v.lang)) || es[0] || null;
  // la voz del sistema solo se usa mientras la neural carga, o si no se puede cargar
  if (voice && !engine) { engine = "native"; ok.tts = true; dot("tts", true); }
}
if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
setTimeout(loadPiper, 800);

// Efecto «holográfico»: filtro + eco corto. Usa su propio AudioContext de salida.
let outAc = null;
function withFx(audio) {
  try {
    outAc = outAc || new (window.AudioContext || window.webkitAudioContext)();
    if (outAc.state !== "running") outAc.resume().catch(() => {});
    const src = outAc.createMediaElementSource(audio);
    const hp = outAc.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 120;
    const pres = outAc.createBiquadFilter(); pres.type = "peaking"; pres.frequency.value = 2800; pres.gain.value = 4; pres.Q.value = 0.9;
    const comp = outAc.createDynamicsCompressor();
    const delay = outAc.createDelay(0.1); delay.delayTime.value = 0.017;
    const wet = outAc.createGain(); wet.gain.value = 0.22;
    src.connect(hp).connect(pres);
    pres.connect(comp);
    pres.connect(delay).connect(wet).connect(comp);
    comp.connect(outAc.destination);
  } catch {}
}

// La voz neural se genera en un Web Worker (hilo aparte): así el orbe y la realidad
// mixta no se congelan mientras Jarvis prepara lo que va a decir.
const PIPER_URL = "https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/+esm";
const WORKER_SRC = `
import * as tts from "${PIPER_URL}";
self.onmessage = async (e) => {
  const { id, type, voiceId, text } = e.data;
  try {
    if (type === "load") {
      const stored = await tts.stored().catch(() => []);
      if (!stored.includes(voiceId)) await tts.download(voiceId, (p) => self.postMessage({ id, progress: p.total ? p.loaded / p.total : 0 }));
      self.postMessage({ id, done: true });
    } else {
      const wav = await tts.predict({ text, voiceId });
      self.postMessage({ id, done: true, wav });
    }
  } catch (err) { self.postMessage({ id, error: String((err && err.message) || err) }); }
};`;
let ttsWorker = null, ttsMode = "";
function workerCall(msg, onProgress) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const onMsg = (e) => {
      if (e.data.id !== id) return;
      if (e.data.progress !== undefined) { onProgress?.(e.data.progress); return; }
      ttsWorker.removeEventListener("message", onMsg);
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.wav);
    };
    ttsWorker.addEventListener("message", onMsg);
    ttsWorker.postMessage({ id, ...msg });
  });
}
async function makePiperBackend(voiceId, onProgress) {
  try {
    if (!ttsWorker) {
      ttsWorker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" })), { type: "module" });
      ttsWorker.addEventListener("error", () => {}); // los errores llegan por la promesa
    }
    await workerCall({ type: "load", voiceId }, onProgress);
    ttsMode = "hilo aparte";
    return { predict: ({ text, voiceId: v }) => workerCall({ type: "predict", text, voiceId: v }) };
  } catch (e) {
    // Si el navegador no deja usar el worker, se usa el hilo principal (funciona, pero puede trabarse).
    ttsWorker?.terminate(); ttsWorker = null;
    const mod = await import(PIPER_URL);
    const stored = await mod.stored().catch(() => []);
    if (!stored.includes(voiceId)) await mod.download(voiceId, (p) => p.total && onProgress?.(p.loaded / p.total));
    ttsMode = "hilo principal";
    return mod;
  }
}

function loadPiper() {
  if (piperLoading) return piperLoading;
  ttsNote("cargando voz…");
  const want = PIPER_VOICE;
  piperLoading = (async () => {
    try {
      const backend = await makePiperBackend(want, (f) => ttsNote(`descargando voz ${Math.round(f * 100)}%`));
      if (want !== PIPER_VOICE) return;
      piper = backend; engine = "piper"; ok.tts = true; dot("tts", true); ttsNote(`${voiceProfile.label} (${ttsMode})`);
    } catch (e) {
      piperLoading = null;
      if (engine === "native") ttsNote("voz del sistema (la neural no cargó)");
      else { ok.tts = false; dot("tts", false); ttsNote("no se pudo cargar: " + (e.message || e)); }
    }
  })();
  return piperLoading;
}

function sentences(text) {
  const raw = text.match(/[^.!?…]+[.!?…]*/g)?.map((s) => s.trim()).filter(Boolean) || [text];
  const out = [];
  for (const s of raw) { if (out.length && out[out.length - 1].length < 40) out[out.length - 1] += " " + s; else out.push(s); }
  return out;
}
function playBlob(blob, styled = false) {
  return new Promise((res) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio(url); currentAudio = a;
    if (styled) {
      a.preservesPitch = false; a.mozPreservesPitch = false; a.webkitPreservesPitch = false;
      a.playbackRate = voiceProfile.rate;
      if (voiceProfile.fx) withFx(a);
    }
    const done = () => { URL.revokeObjectURL(url); if (currentAudio === a) currentAudio = null; res(); };
    a.onended = done; a.onerror = done;
    a.play().catch(done);
  });
}
async function sayPiper(text, token) {
  const parts = sentences(text);
  let next = piper.predict({ text: parts[0], voiceId: PIPER_VOICE });
  for (let i = 0; i < parts.length; i++) {
    const wav = await next;
    if (token !== speakToken) return;
    if (i + 1 < parts.length) next = piper.predict({ text: parts[i + 1], voiceId: PIPER_VOICE });
    await playBlob(wav, true);
    if (token !== speakToken) return;
  }
}
function sayNative(text) {
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voice?.lang || "es-MX"; if (voice) u.voice = voice;
    u.rate = voiceProfile.rate; u.pitch = voiceProfile.fx ? 0.8 : 1;
    u.onend = resolve; u.onerror = resolve;
    speechSynthesis.speak(u);
    setTimeout(resolve, 60000);
  });
}
async function say(text) {
  lastText = text; panelDirty = true;
  const token = ++speakToken;
  if (!ok.tts || !engine) { setState("idle"); return; }
  setState("speaking");
  try { engine === "piper" ? await sayPiper(text, token) : await sayNative(text); }
  catch (e) { addLog("e", "La voz falló: " + (e.message || e)); }
  if (token === speakToken && state === "speaking") setState("idle");
}
function hush() {
  speakToken++;
  if (window.speechSynthesis) speechSynthesis.cancel();
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (state === "speaking") setState("idle");
}
$("#test-voice").addEventListener("click", async () => {
  if (!ok.tts) { await loadPiper(); }
  say(`Buenas. Todos los sistemas en línea${cfg.name ? ", " + cfg.name : ""}. ¿En qué trabajamos hoy?`);
});

// ---------------- Micrófono, manos libres y push-to-talk ----------------
let stream = null, analyser = null, ac = null, level = 0, recorder = null, chunks = [], recStart = 0, recMode = null;
let voiceSince = 0, silenceSince = 0, noise = 0.01, peak = 0;
// Umbrales que se adaptan al ruido de fondo: el micrófono del Quest es más bajo que el de una PC.
const vadOn = () => Math.max(0.012, noise * 3.5);
const vadOff = () => Math.max(0.008, noise * 2);
const wakeAudio = () => { if (ac && ac.state !== "running") ac.resume().catch(() => {}); };
addEventListener("pointerdown", wakeAudio);

$("#mic-on").addEventListener("click", async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    ac = new (window.AudioContext || window.webkitAudioContext)();
    await ac.resume().catch(() => {});
    const track = stream.getAudioTracks()[0];
    if (track) { track.onmute = micDiag; track.onunmute = micDiag; track.onended = micDiag; }
    ac.onstatechange = micDiag;
    setTimeout(micDiag, 300);
    const src = ac.createMediaStreamSource(stream);
    analyser = ac.createAnalyser(); analyser.fftSize = 1024; src.connect(analyser);
    ok.mic = true; dot("mic", true);
    $("#mic-on").textContent = "Micrófono activo";
    $("#mic-on").disabled = true;
    // desbloquea la voz en navegadores que la exigen tras un toque
    if (window.speechSynthesis) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); }
  } catch (e) {
    ok.mic = false; dot("mic", false);
    addLog("e", "No pude usar el micrófono. Revisa el permiso del navegador para este sitio.");
  }
  refreshEnter();
});

// Diagnóstico: dice en palabras si el sistema bloquea el micrófono o si el audio está pausado.
function micDiag() {
  const el = $("#mic-diag"); if (!el) return;
  const tr = stream?.getAudioTracks()[0];
  if (!tr) { el.textContent = "Micrófono sin activar."; return; }
  const parts = [];
  if (tr.readyState === "ended") parts.push("El micrófono se desconectó: vuelve a tocar «Activar micrófono».");
  else if (tr.muted) parts.push("El sistema del Quest está silenciando el micrófono: revisa Configuración → Privacidad y seguridad → Micrófono y permite el navegador.");
  if (ac && ac.state !== "running") parts.push("Audio en pausa: toca cualquier botón de la página.");
  el.textContent = parts.join(" ") || `Micrófono conectado (${tr.label || "predeterminado"}).`;
}
setInterval(micDiag, 2000);

$("#mic-test").addEventListener("click", async () => {
  const btn = $("#mic-test");
  if (!stream) { addLog("e", "Primero toca «Activar micrófono»."); return; }
  wakeAudio();
  const m = mime();
  const rec = new MediaRecorder(stream, m ? { mimeType: m } : undefined);
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  rec.onstop = async () => {
    const blob = new Blob(parts, { type: rec.mimeType || "audio/webm" });
    btn.disabled = false; btn.textContent = "Grabar prueba (3 s)";
    addLog("j", `Grabé ${(blob.size / 1024).toFixed(1)} KB. Te lo reproduzco…`);
    await playBlob(blob);
    if (ok.key) {
      try {
        const t = (await transcribe(blob)).trim();
        // Whisper "oye" frases como «Gracias» cuando el audio está en silencio.
        if (!t || JUNK.test(t)) addLog("e", "La grabación llegó en silencio: tu micrófono parece silenciado en el Quest. Revisa el micrófono en Configuración rápida del Quest.");
        else addLog("j", `Entendí: «${t}»`);
      }
      catch (e) { addLog("e", "No pude transcribir: " + e.message); }
    }
  };
  btn.disabled = true; btn.textContent = "Grabando… habla";
  rec.start();
  setTimeout(() => rec.stop(), 3000);
});

const buf = new Float32Array(1024);
function readLevel() {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(buf);
  let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}
function mime() {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}
function startRec(mode) {
  if (!stream || recorder) return;
  chunks = []; recMode = mode; recStart = performance.now();
  const m = mime();
  recorder = new MediaRecorder(stream, m ? { mimeType: m } : undefined);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = onRecStop;
  recorder.start();
  setState("listening");
}
function stopRec() { if (recorder && recorder.state !== "inactive") recorder.stop(); }

// En español «Jarvis» suele transcribirse como Yarbis, Jarbis, Charvis, Harvis…: aceptamos todas.
const WAKE_SRC = String.raw`\b(?:j|y|ch|g|h|ll|sh|dj|zh)[aáeé]r[vbw][iíe][sz]?\b|\btravis\b`;
const WAKE = new RegExp(WAKE_SRC, "i");
const JUNK = /^[¡!¿\s]*(gracias( por ver( el video)?)?|muchas gracias|subt[ií]tulos.*|suscr[ií]bete.*|\.+|)[.!\s]*$/i;
async function onRecStop() {
  const dur = performance.now() - recStart, mode = recMode;
  const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
  recorder = null; recMode = null;
  if (dur < 450) { if (state === "listening") setState("idle"); if (mode === "ptt") { lastText = "Mantén el gatillo mientras hablas y suéltalo al terminar."; panelDirty = true; } return; }
  setState("thinking");
  let text = "";
  try { text = await transcribe(blob); }
  catch (e) { addLog("e", "No pude entender el audio: " + e.message); lastText = e.message; setState("idle"); return; }
  text = text.trim();
  if (JUNK.test(text)) {
    if (mode === "ptt") { lastText = "No escuché nada claro. Acércate o habla un poco más fuerte."; addLog("e", lastText); }
    setState("idle"); return;
  }
  if (mode === "ptt") { setState("idle"); ask(text); return; }
  // manos libres: hace falta «Jarvis», salvo justo después de que respondió
  const woke = WAKE.test(text);
  if (!woke && Date.now() > followUntil) {
    lastHeard = text; lastText = "Te escuché, pero no dijiste «Jarvis». Empieza tu frase con «Jarvis, …».";
    addLog("u", "(ignorado) " + text);
    setState("idle"); return;
  }
  setState("idle");
  const cmd = text.replace(new RegExp(String.raw`^.*?(?:${WAKE_SRC})[\s,.:!¡¿?]*`, "i"), "").trim();
  if (!cmd || cmd.length < 2) { followUntil = Date.now() + 8000; await say("¿Sí?"); followUntil = Date.now() + 8000; return; }
  ask(woke ? cmd : text);
}

function vadTick() {
  level = readLevel();
  peak = Math.max(level, peak * 0.97);
  const meter = $("#mic-level");
  if (meter) meter.style.width = Math.min(100, (peak / 0.08) * 100) + "%";
  if (!recorder && state !== "speaking") noise = noise * 0.995 + Math.min(level, 0.05) * 0.005;
  if (!cfg.handsFree || !inputReady() || busy || state === "speaking" || state === "thinking" || recMode === "ptt") { voiceSince = 0; return; }
  const now = performance.now();
  if (!recorder) {
    if (level > vadOn()) { if (!voiceSince) voiceSince = now; if (now - voiceSince > 120) { startRec("vad"); silenceSince = 0; } }
    else voiceSince = 0;
  } else {
    if (level < vadOff()) { if (!silenceSince) silenceSince = now; if (now - silenceSince > 1000) stopRec(); }
    else silenceSince = 0;
    if (now - recStart > 15000) stopRec();
  }
}
const inputReady = () => ok.key && ok.mic;

function pttStart() {
  wakeAudio();
  if (!ok.mic) { lastText = "El micrófono no está activo. Sal del modo inmersivo y toca «Activar micrófono»."; panelDirty = true; return; }
  if (!ok.key) { lastText = "Falta la clave de Groq. Sal y toca «Guardar y probar»."; panelDirty = true; return; }
  if (busy) return;
  hush(); if (recorder) { recorder.onstop = null; recorder.stop(); recorder = null; } startRec("ptt"); }
function pttEnd() { if (recMode === "ptt") stopRec(); }

const pttBtn = $("#ptt");
pttBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); pttStart(); pttBtn.classList.add("live"); pttBtn.textContent = "Suelta para enviar"; });
const pttUp = () => { pttEnd(); pttBtn.classList.remove("live"); pttBtn.textContent = "Mantén para hablar"; };
pttBtn.addEventListener("pointerup", pttUp);
pttBtn.addEventListener("pointerleave", () => { if (recMode === "ptt") pttUp(); });

function chime() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    [660, 880, 990].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + i * 0.18;
      o.frequency.value = f; g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.6);
    });
  } catch {}
}

// ---------------- Escena 3D ----------------
const canvas = $("#scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 50);
camera.position.set(0, 1.3, 0);
camera.lookAt(0, 1.35, -0.8);

const COLORS = { idle: new THREE.Color(0x62d6ff), listening: new THREE.Color(0xff7a6b), thinking: new THREE.Color(0xffb547), speaking: new THREE.Color(0x67e3a6) };
const tint = new THREE.Color(0x62d6ff);

const orb = new THREE.Group();
const saved = store.get("orbPos", null);
orb.position.set(...(saved || [0, 1.35, -0.8]));
scene.add(orb);

const add = (m) => new THREE.MeshBasicMaterial({ color: 0x62d6ff, transparent: true, opacity: m, blending: THREE.AdditiveBlending, depthWrite: false });
const coreMat = add(0.9), shellMat = add(0.18), ringMat = add(0.85), ring2Mat = add(0.55), ring3Mat = add(0.35);
const core = new THREE.Mesh(new THREE.SphereGeometry(0.035, 32, 16), coreMat);
const heart = new THREE.Mesh(new THREE.SphereGeometry(0.016, 16, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06, 2), shellMat);
shellMat.wireframe = true;
orb.add(core, heart, shell);

function segRing(r, tube, segs, mat) {
  const g = new THREE.Group(), span = (Math.PI * 2) / segs;
  for (let i = 0; i < segs; i++) {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 6, 24, span * 0.62), mat);
    m.rotation.z = i * span; g.add(m);
  }
  return g;
}
const ring1 = segRing(0.085, 0.004, 10, ringMat);
const ring2 = segRing(0.11, 0.0025, 3, ring2Mat);
const ring3 = segRing(0.135, 0.0015, 24, ring3Mat);
ring2.rotation.x = Math.PI / 2.6; ring3.rotation.y = Math.PI / 3;
orb.add(ring1, ring2, ring3);

// halo
const hc = document.createElement("canvas"); hc.width = hc.height = 128;
const hx = hc.getContext("2d"); const hg = hx.createRadialGradient(64, 64, 0, 64, 64, 64);
hg.addColorStop(0, "rgba(255,255,255,0.9)"); hg.addColorStop(0.25, "rgba(255,255,255,0.25)"); hg.addColorStop(1, "rgba(255,255,255,0)");
hx.fillStyle = hg; hx.fillRect(0, 0, 128, 128);
const haloMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(hc), color: 0x62d6ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
const halo = new THREE.Sprite(haloMat); halo.scale.set(0.42, 0.42, 1); orb.add(halo);

// partículas orbitando
const N = 90, pg = new THREE.BufferGeometry(), pp = new Float32Array(N * 3), seeds = [];
for (let i = 0; i < N; i++) seeds.push({ r: 0.15 + Math.random() * 0.08, a: Math.random() * 6.28, y: (Math.random() - 0.5) * 0.12, s: 0.2 + Math.random() * 0.6 });
pg.setAttribute("position", new THREE.BufferAttribute(pp, 3));
const pMat = new THREE.PointsMaterial({ color: 0x62d6ff, size: 0.006, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
orb.add(new THREE.Points(pg, pMat));

// panel holográfico
const pc = document.createElement("canvas"); pc.width = 1024; pc.height = 640;
const px = pc.getContext("2d");
const panelTex = new THREE.CanvasTexture(pc); panelTex.colorSpace = THREE.SRGBColorSpace;
const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.3), new THREE.MeshBasicMaterial({ map: panelTex, transparent: true, depthWrite: false }));
scene.add(panel);
let panelDirty = true;

function wrap(ctx, text, maxW, maxLines) {
  const words = text.split(/\s+/), lines = []; let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { const cut = lines.slice(lines.length - maxLines); cut[0] = "… " + cut[0]; return cut; }
  return lines;
}
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
function drawPanel() {
  const W = pc.width, H = pc.height, col = "#" + tint.getHexString();
  px.clearRect(0, 0, W, H);
  rr(px, 6, 6, W - 12, H - 12, 28); px.fillStyle = "rgba(4,10,16,0.78)"; px.fill();
  px.lineWidth = 3; px.strokeStyle = col; px.globalAlpha = 0.6; px.stroke(); px.globalAlpha = 1;
  // cabecera
  px.font = "600 34px 'Chakra Petch', 'Segoe UI', sans-serif"; px.fillStyle = col;
  px.fillText({ idle: "EN LÍNEA", listening: "ESCUCHANDO", thinking: "PROCESANDO", speaking: "HABLANDO" }[state], 40, 62);
  px.font = "500 32px 'IBM Plex Mono', monospace"; px.fillStyle = "#dcf0f6"; px.textAlign = "right";
  const clock = new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
  px.fillText(timer.end ? `${timer.label.toUpperCase()} ${mmss(timerLeft())}   ${clock}` : clock, W - 40, 62);
  px.textAlign = "left";
  px.fillStyle = "rgba(134,163,174,0.35)"; px.fillRect(40, 84, W - 80, 2);
  // lo último que escuchó
  let y = 128;
  if (lastHeard) {
    px.font = "italic 400 26px 'IBM Plex Sans', sans-serif"; px.fillStyle = "#86a3ae";
    px.fillText("« " + wrap(px, lastHeard, W - 120, 1)[0] + " »", 40, y); y += 46;
  }
  // respuesta
  px.font = "400 32px 'IBM Plex Sans', sans-serif"; px.fillStyle = "#dcf0f6";
  for (const l of wrap(px, lastText, W - 80, lastHeard ? 7 : 8)) { px.fillText(l, 40, y); y += 42; }
  // pendientes
  const open = tasks.map((t, i) => ({ ...t, n: i + 1 })).filter((t) => !t.done).slice(0, 3);
  px.fillStyle = "rgba(134,163,174,0.35)"; px.fillRect(40, H - 128, W - 80, 2);
  px.font = "600 22px 'Chakra Petch', sans-serif"; px.fillStyle = "#86a3ae";
  px.fillText(`PENDIENTES · ${tasks.filter((t) => !t.done).length}`, 40, H - 92);
  px.font = "400 24px 'IBM Plex Sans', sans-serif"; px.fillStyle = "#dcf0f6";
  px.fillText(open.length ? open.map((t) => `${t.n}. ${t.text}`).join("   ·   ").slice(0, 70) : "Nada pendiente.", 40, H - 54);
  panelTex.needsUpdate = true;
}
document.fonts?.ready.then(() => (panelDirty = true));

// ---------------- Controles XR (gatillo / pellizco) ----------------
const ctrls = [];
const tmp = new THREE.Vector3();
let grabbing = null;
for (let i = 0; i < 2; i++) {
  const c = renderer.xr.getController(i);
  scene.add(c); ctrls.push(c);
  c.addEventListener("selectstart", () => {
    c.getWorldPosition(tmp);
    if (tmp.distanceTo(orb.position) < 0.2) { grabbing = c; return; }
    pttStart();
  });
  c.addEventListener("selectend", () => {
    if (grabbing === c) { grabbing = null; store.set("orbPos", orb.position.toArray()); return; }
    pttEnd();
  });
  c.addEventListener("squeezestart", () => { c.getWorldPosition(tmp); if (tmp.distanceTo(orb.position) < 0.3) grabbing = c; });
  c.addEventListener("squeezeend", () => { if (grabbing === c) { grabbing = null; store.set("orbPos", orb.position.toArray()); } });
}

// ---------------- Realidad mixta ----------------
let xrMode = "immersive-ar";
(async () => {
  try {
    if (navigator.xr && await navigator.xr.isSessionSupported("immersive-ar")) ok.xr = true;
    else if (navigator.xr && await navigator.xr.isSessionSupported("immersive-vr")) { ok.xr = true; xrMode = "immersive-vr"; }
  } catch {}
  dot("xr", ok.xr ? true : false);
  refreshEnter();
})();

$("#enter").addEventListener("click", async () => {
  if (!ok.xr) { addLog("e", "Este navegador no soporta realidad mixta. Abre esta página en el navegador del Quest 3."); return; }
  try {
    wakeAudio();
    const session = await navigator.xr.requestSession(xrMode, { requiredFeatures: ["local-floor"], optionalFeatures: ["hand-tracking"] });
    session.addEventListener("selectstart", wakeAudio);
    renderer.xr.setFoveation(1); // menos detalle en la orilla de la vista = más fluidez
    await renderer.xr.setSession(session);
    session.addEventListener("end", () => { setState("idle"); });
    const h = new Date().getHours();
    say(`${h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches"}. Sistemas en línea.`);
  } catch (e) {
    addLog("e", "No pude entrar a realidad mixta: " + (e.message || e));
  }
});

// ---------------- Bucle ----------------
function resize() {
  if (renderer.xr.isPresenting) return;
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener("resize", resize); resize();

const clock3 = new THREE.Clock();
const camPos = new THREE.Vector3();
let lastDraw = 0;
renderer.setAnimationLoop(() => {
  const dt = clock3.getDelta(), t = clock3.elapsedTime;
  vadTick();

  tint.lerp(COLORS[state], Math.min(1, dt * 6));
  for (const m of [coreMat, shellMat, ringMat, ring2Mat, ring3Mat, pMat]) m.color.copy(tint);
  haloMat.color.copy(tint);

  const speed = state === "thinking" ? 3 : state === "idle" ? 0.6 : 1.5;
  ring1.rotation.z += dt * speed * 0.8;
  ring2.rotation.z -= dt * speed * 0.5;
  ring3.rotation.z += dt * speed * 0.3;
  shell.rotation.y += dt * 0.2; shell.rotation.x += dt * 0.1;

  let pulse = 1 + Math.sin(t * 1.6) * 0.03;
  if (state === "listening" || recorder) pulse = 1 + Math.min(0.35, level * 6);
  if (state === "speaking") pulse = 1 + Math.abs(Math.sin(t * 9)) * 0.12;
  if (state === "thinking") pulse = 1 + Math.sin(t * 6) * 0.06;
  if (state === "idle" && ok.mic) pulse += Math.min(0.15, peak * 3); // el orbe "oye": late con tu voz
  core.scale.setScalar(pulse); shell.scale.setScalar(1 + (pulse - 1) * 0.5);
  halo.material.opacity = 0.35 + (pulse - 1) * 1.2;

  for (let i = 0; i < N; i++) {
    const s = seeds[i]; s.a += dt * s.s * speed;
    pp[i * 3] = Math.cos(s.a) * s.r; pp[i * 3 + 1] = s.y + Math.sin(s.a * 2) * 0.01; pp[i * 3 + 2] = Math.sin(s.a) * s.r;
  }
  pg.attributes.position.needsUpdate = true;

  if (grabbing) { grabbing.getWorldPosition(tmp); orb.position.lerp(tmp, 0.5); }

  // panel bajo el orbe, mirando al usuario
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  cam.getWorldPosition(camPos);
  panel.position.set(orb.position.x, orb.position.y - 0.27, orb.position.z);
  panel.lookAt(camPos.x, panel.position.y, camPos.z);
  orb.lookAt(camPos.x, orb.position.y, camPos.z);

  // El panel es una textura grande: redibujarlo seguido traba el Quest. Máximo 4 veces por segundo
  // y solo cuando cambió algo (estado, texto, reloj o temporizador).
  if (panelDirty && t - lastDraw > 0.25) { drawPanel(); panelDirty = false; lastDraw = t; }

  renderer.render(scene, camera);
});

// ---------------- Inicio ----------------
renderTasks();
if (cfg.key) {
  ok.key = true; dot("key", true);
  pickModels().catch((e) => { ok.key = false; dot("key", false); addLog("e", e.message); refreshEnter(); });
}
refreshEnter();
addLog("j", "Hola. Guarda tu clave de Groq, activa el micrófono y entra a realidad mixta.");
