# Jarvis XR

Asistente de estudio en realidad mixta para Meta Quest 3: un orbe holográfico que flota en tu cuarto, te escucha y te responde en voz alta.

- **Cerebro:** Groq (gratis), modelo `llama-3.3-70b-versatile`
- **Oído:** Whisper en Groq (`whisper-large-v3-turbo`)
- **Voz:** la síntesis de voz del navegador
- **Realidad mixta:** WebXR (`immersive-ar` con passthrough) y three.js

La clave de Groq se guarda solo en el navegador del visor (localStorage); no se sube a este repositorio.

## Uso en el Quest 3
1. Abre la URL de GitHub Pages en el navegador del Quest.
2. Pega tu clave de https://console.groq.com/keys y pulsa **Guardar y probar**.
3. Pulsa **Activar micrófono** y acepta el permiso.
4. Pulsa **Entrar a realidad mixta**.
5. Mantén el gatillo (o pellizca) para hablar, o di «Jarvis, …» en modo manos libres.
6. Pellizca el orbe y arrástralo para moverlo.
