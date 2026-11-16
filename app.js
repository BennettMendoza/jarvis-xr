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
};
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
  panelDirty = true;
}, 1000);

// ---------------- Cerebro ----------------
const ACT = /\[\[\s*(TAREA|HECHA|BORRAR|TIMER)\s*:\s*([^\]]*)\]\]/gi;
function rules() {
  const list = tasks.length ? tasks.map((t, i) => `${i + 1}. [${t.done ? "x" : " "}] ${t.text}`).join("\n") : "(ninguno)";
  return `Eres JARVIS, el asistente personal de estudio de un estudiante, y vives como un orbe holográfico en sus lentes de realidad mixta. Hablas español con un tono cercano, seguro y un toque elegante de mayordomo, sin exagerar. No asumas el género del usuario.
Reglas:
- Todo lo que escribes se lee en voz alta: respuestas breves (2 a 5 frases) salvo que pidan detalle. Sin markdown, sin listas largas, sin emojis.
- Si explicas algo, sé claro y da un ejemplo concreto. En un quiz, haz UNA pregunta a la vez y espera la respuesta.
- Ayuda a entender; no hagas exámenes o tareas calificadas por el estudiante.
- La entrada viene de un reconocimiento de voz: si algo suena raro, interpreta lo más probable.
Fecha y hora: ${new Date().toLocaleString("es-MX", { dateStyle: "full", timeStyle: "short" })}.
Temporizador: ${timer.end ? "quedan " + mmss(timerLeft()) : "apagado"}.
Pendientes:
${list}
Para ejecutar acciones, escribe al FINAL de tu respuesta estas etiquetas exactas, cada una en su línea, solo cuando el estudiante lo pida:
[[TAREA: texto]] añade un pendiente · [[HECHA: n]] marca hecho el número n · [[BORRAR: n]] elimina el número n · [[TIMER: minutos]] inicia un temporizador de enfoque.`;
}
function runActions(text) {
  let changed = false; const done = [], del = [];
  for (const [, k, a] of text.matchAll(ACT)) {
    const K = k.toUpperCase(), v = a.trim();
    if (K === "TAREA" && v) { tasks.push({ text: v.slice(0, 120), done: false }); changed = true; }
    if (K === "HECHA") done.push(parseInt(v, 10) - 1);
    if (K === "BORRAR") del.push(parseInt(v, 10) - 1);
    if (K === "TIMER") startTimer(Math.min(180, Math.max(1, parseInt(v, 10) || 25)));
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

// ---------------- Voz de Jarvis (TTS) ----------------
// Dos motores: la voz del sistema (speechSynthesis) si hay una en español, y si no
// (el navegador del Quest no trae), Piper: una voz neural gratis que corre dentro
// del navegador. El modelo (~60 MB) se descarga una vez y queda guardado.
const PIPER_VOICE = "es_MX-ald-medium";
let voice = null, engine = null, piper = null, piperLoading = null, currentAudio = null, speakToken = 0;
const ttsNote = (t) => { $("#tts-note").textContent = t ? " · " + t : ""; };

function pickVoice() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  const es = vs.filter((v) => /^es/i.test(v.lang));
  voice = es.find((v) => /mx|419|us/i.test(v.lang)) || es[0] || null;
  if (voice && engine !== "piper" && new URLSearchParams(location.search).get("voz") !== "neural") { engine = "native"; ok.tts = true; dot("tts", true); ttsNote("voz del sistema"); }
}
if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
setTimeout(() => { if (engine !== "native") loadPiper(); }, 1500);

function loadPiper() {
  if (piperLoading) return piperLoading;
  ttsNote("cargando voz neural…");
  piperLoading = (async () => {
    try {
      const mod = await import("https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/+esm");
      const stored = await mod.stored().catch(() => []);
      if (!stored.includes(PIPER_VOICE)) {
        await mod.download(PIPER_VOICE, (p) => { if (p.total) ttsNote(`descargando voz ${Math.round((p.loaded * 100) / p.total)}%`); });
      }
      piper = mod; engine = "piper"; ok.tts = true; dot("tts", true); ttsNote("voz neural lista");
    } catch (e) {
      piperLoading = null;
      if (engine !== "native") { ok.tts = false; dot("tts", false); ttsNote("no se pudo cargar: " + (e.message || e)); }
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
function playBlob(blob) {
  return new Promise((res) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio(url); currentAudio = a;
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
    await playBlob(wav);
    if (token !== speakToken) return;
  }
}
function sayNative(text) {
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voice?.lang || "es-MX"; if (voice) u.voice = voice;
    u.rate = 1.05; u.pitch = 0.95;
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
  say("Hola. Soy Jarvis, tu asistente de estudio. Sistemas en línea.");
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

const WAKE = /\b(j|y|ch|g|h)[aá]r?vi[sz]\b/i;
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
  const cmd = text.replace(/^.*?\b(j|y|ch|g|h)[aá]r?vi[sz]\b[\s,.:!¡¿?]*/i, "").trim();
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

  if (panelDirty && t - lastDraw > 0.1) { drawPanel(); panelDirty = false; lastDraw = t; }
  if (Math.floor(t * 4) % 2 === 0) panelDirty = panelDirty || state !== "idle";

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
