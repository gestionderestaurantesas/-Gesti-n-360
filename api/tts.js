// api/tts.js
//
// Función de servidor (Vercel Serverless Function) que convierte el texto
// que va a decir "Sonia" en audio con la voz clonada de Harol, usando
// ElevenLabs. Sigue el mismo patrón que api/chat.js: la clave de la API
// vive SOLO en el servidor (variable de entorno), nunca en el HTML, así
// que nadie puede copiarla desde el código del sitio.
//
// Qué hay que hacer para activarlo (una sola vez):
// 1. Crear una cuenta en https://elevenlabs.io (plan "Starter" o superior,
//    porque la clonación de voz instantánea no está en el plan gratis).
// 2. En ElevenLabs, ir a "Voices" → "Add voice" → "Instant Voice Cloning",
//    y subir unas grabaciones de la voz de Harol (unos minutos de audio
//    limpio, sin ruido de fondo, alcanza).
// 3. Copiar el "Voice ID" de esa voz clonada (aparece en el dashboard).
// 4. Ir a "Profile" o "API Keys" en ElevenLabs y copiar la clave de API.
// 5. En Vercel → el proyecto → Settings → Environment Variables, agregar:
//      ELEVENLABS_API_KEY   = (la clave de API de ElevenLabs)
//      ELEVENLABS_VOICE_ID  = (el Voice ID de la voz clonada)
//    y volver a desplegar (Redeploy).
//
// Mientras esas variables no estén configuradas, este endpoint responde
// con un error controlado y el HTML sigue usando la voz normal del
// navegador como respaldo — no se rompe nada si todavía no se activa esto.

const ELEVENLABS_TTS_URL_BASE = 'https://api.elevenlabs.io/v1/text-to-speech/';
const MAX_LARGO_TEXTO = 800; // límite de seguridad de tamaño/costo por mensaje
// Modelo multilingüe (soporta español) recomendado por ElevenLabs para
// voces clonadas con buena calidad y latencia razonable.
const MODELO_ELEVENLABS = 'eleven_multilingual_v2';

module.exports = async function handler(req, res){
  if(req.method !== 'POST'){
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let body = req.body;
  if(typeof body === 'string'){
    try { body = JSON.parse(body); } catch(e){ body = {}; }
  }
  body = body || {};

  const texto = String(body.texto || '').slice(0, MAX_LARGO_TEXTO).trim();
  if(!texto){
    res.status(400).json({ error: 'texto_vacio' });
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if(!apiKey || !voiceId){
    // No es un error del usuario: falta configurar las variables de
    // entorno en Vercel. El HTML interpreta esto y usa la voz del
    // navegador mientras tanto.
    res.status(500).json({ error: 'falta_configurar_voz', mensaje: 'El servidor no tiene configurada la voz clonada (ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID).' });
    return;
  }

  try {
    const respuestaApi = await fetch(ELEVENLABS_TTS_URL_BASE + encodeURIComponent(voiceId), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: texto,
        model_id: MODELO_ELEVENLABS,
        // speed > 1.0 = un poco más rápida que el ritmo natural de la voz
        // clonada (rango permitido por ElevenLabs: 0.7 a 1.2).
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.1 }
      })
    });

    if(!respuestaApi.ok){
      const detalle = await respuestaApi.text().catch(() => '');
      console.error('ElevenLabs API error', respuestaApi.status, detalle);
      res.status(502).json({ error: 'voz_no_disponible', mensaje: 'No se pudo generar el audio con la voz clonada en este momento.' });
      return;
    }

    const arrayBuffer = await respuestaApi.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuffer).toString('base64');
    res.status(200).json({ audio: audioBase64, formato: 'audio/mpeg' });
  } catch(err){
    console.error('Error llamando a ElevenLabs', err);
    res.status(500).json({ error: 'error_interno', mensaje: 'Ocurrió un error al conectar con el servicio de voz.' });
  }
};
