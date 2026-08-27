// api/temperatura.js
//
// Función de servidor (Vercel Serverless Function) que recibe las
// lecturas del sensor infrarrojo de temperatura (uno por sede) y las
// deja disponibles para que la app las muestre. Sigue el mismo patrón
// que api/chat.js y api/tts.js: nada de claves ni tokens en el HTML.
//
// Por qué necesita una base de datos aparte (Vercel KV): las funciones
// de este tipo no "recuerdan" nada de una llamada a la siguiente — cada
// vez que el sensor manda una lectura, esta función se ejecuta de cero.
// Por eso la lectura hay que guardarla en algún lado para que, segundos
// después, la app pueda venir a buscarla. Vercel KV (basado en Upstash)
// es la forma más simple de hacerlo sin instalar nada adicional: se
// activa desde el panel de Vercel y queda accesible por HTTP con una
// clave, igual que ElevenLabs o Anthropic.
//
// Cómo se activa (una sola vez):
// 1. En Vercel → el proyecto → pestaña "Storage" → "Create Database" →
//    elegir "KV" (Upstash Redis). Conectarla al proyecto.
// 2. Eso agrega automáticamente las variables de entorno KV_REST_API_URL
//    y KV_REST_API_TOKEN — no hay que copiarlas a mano.
// 3. En Vercel → Settings → Environment Variables, agregar una más,
//    elegida por ti (un token secreto cualquiera, como una contraseña
//    larga), para que solo el sensor autorizado pueda mandar lecturas:
//      TEMP_SENSOR_TOKEN = (inventa un token largo, ej: una cadena de 30+ caracteres)
//    Ese mismo token va también en el código que se sube al ESP32
//    (ver el plan de sensor de temperatura para el firmware completo).
// 4. Volver a desplegar (Redeploy).
//
// Mientras KV no esté conectado, este endpoint responde con un error
// controlado y la app simplemente no muestra el bloque de temperatura —
// no rompe nada más de la app.

const TIEMPO_MAX_VALIDEZ_MS = 5 * 60 * 1000; // una lectura de hace más de 5 min se considera "sin datos recientes"

function claveKvPorSede(sede){
  return 'temperatura_actual_' + (sede === 'monteria' ? 'monteria' : 'chinu');
}

async function kvSet(url, token, clave, valor){
  const resp = await fetch(url + '/set/' + encodeURIComponent(clave), {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(valor)
  });
  return resp.ok;
}
async function kvGet(url, token, clave){
  const resp = await fetch(url + '/get/' + encodeURIComponent(clave), {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  if(!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  if(!data || data.result == null) return null;
  try { return JSON.parse(data.result); } catch(e){ return null; }
}

module.exports = async function handler(req, res){
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if(!kvUrl || !kvToken){
    res.status(500).json({ error: 'falta_configurar_kv', mensaje: 'El servidor no tiene conectada la base de datos KV (Vercel Storage).' });
    return;
  }

  if(req.method === 'POST'){
    // Llamada del sensor (ESP32) reportando una lectura nueva.
    let body = req.body;
    if(typeof body === 'string'){ try { body = JSON.parse(body); } catch(e){ body = {}; } }
    body = body || {};

    const tokenEsperado = process.env.TEMP_SENSOR_TOKEN;
    if(!tokenEsperado || body.token !== tokenEsperado){
      res.status(401).json({ error: 'token_invalido' });
      return;
    }

    const temperatura = Number(body.temperatura);
    if(!Number.isFinite(temperatura)){
      res.status(400).json({ error: 'temperatura_invalida' });
      return;
    }
    const sede = body.sede === 'monteria' ? 'monteria' : 'chinu';
    const estacion = String(body.estacion || 'pase').slice(0, 60);

    const guardado = await kvSet(kvUrl, kvToken, claveKvPorSede(sede), {
      temperatura, estacion, ts: Date.now()
    });
    if(!guardado){
      res.status(502).json({ error: 'no_se_pudo_guardar' });
      return;
    }
    res.status(200).json({ ok: true });
    return;
  }

  if(req.method === 'GET'){
    // Llamada de la app pidiendo la última lectura de su sede.
    const sede = req.query && req.query.sede === 'monteria' ? 'monteria' : 'chinu';
    const lectura = await kvGet(kvUrl, kvToken, claveKvPorSede(sede));
    if(!lectura){
      res.status(200).json({ disponible: false });
      return;
    }
    const antiguedadMs = Date.now() - (lectura.ts || 0);
    res.status(200).json({
      disponible: true,
      temperatura: lectura.temperatura,
      estacion: lectura.estacion || '',
      hace_segundos: Math.round(antiguedadMs / 1000),
      reciente: antiguedadMs <= TIEMPO_MAX_VALIDEZ_MS
    });
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
};
