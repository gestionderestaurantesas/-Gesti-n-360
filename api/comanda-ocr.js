// api/comanda-ocr.js
//
// Función de servidor (Vercel Serverless Function) que lee una captura
// de pantalla o foto de un pedido/comanda (por ejemplo, de la pantalla
// de cocina del sistema de punto de venta, o de un ticket impreso) y
// devuelve la mesa, la zona, el mesero y la lista de platos ya
// transcritos — para que en "Comandas por persona" no haya que volver
// a escribir todo a mano, solo repartir esos platos entre cada persona.
// Sigue el mismo patrón que api/chat.js y api/calidad-vision.js: la
// clave vive solo en el servidor (ANTHROPIC_API_KEY), nunca en el HTML.
// Si ya la configuraste para el chat de Harol-IA o para Control de
// calidad 360, esto funciona de una sin nada extra que configurar.
//
// IMPORTANTE: esto lee lo que SE VE en la imagen (transcripción), no
// se conecta al sistema de punto de venta ni jala datos de ahí — por
// eso sigue siendo "semiautomatizado": el equipo revisa lo leído y
// reparte los platos entre las personas de la mesa, porque el sistema
// de punto de venta no guarda esa información (los platos no vienen
// separados por persona del lado de ellos).

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODELO = 'claude-sonnet-5';
const MAX_TOKENS_RESPUESTA = 1200;
const MAX_LARGO_IMAGEN_BASE64 = 8000000;

const SYSTEM_PROMPT = `Eres un asistente que transcribe capturas de pantalla o fotos de pedidos/comandas de un restaurante (pueden venir de una pantalla de cocina de un sistema de punto de venta, con una o varias mesas mostradas como columnas o tarjetas, o de un ticket impreso de papel).

Tu trabajo es transcribir, NO inventar ni resumir. Por cada mesa/pedido distinto que veas en la imagen (puede haber una sola o varias, si es una pantalla con varias columnas/tarjetas), extrae:
- "mesa": el número o nombre de la mesa tal como aparece (ej. "4", "Mesa 62"). Si no se ve, usa "".
- "zona": la zona o estación si aparece (ej. "RANCHO", "SALON VIP", "SALON", "BARRA", "TERRAZA"). Si no se ve, usa "".
- "camarero": el nombre del mesero/camarero que aparezca. Si no se ve, usa "".
- "personas": el número de personas de esa mesa, si aparece explícitamente (número). Si no aparece, usa null.
- "items": un arreglo de strings, una entrada por cada línea de plato/acompañante que veas en esa mesa, tal como está escrito (no combines varias líneas en una, no traduzcas, no corrijas ortografía). Ignora botones de estado como "En preparación", "Pendiente", "Terminar todo" — esos no son platos.

Responde ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, con esta forma exacta:
{"pedidos":[{"mesa":"","zona":"","camarero":"","personas":null,"items":["...","..."]}]}
Si no logras leer ninguna mesa/pedido con claridad, responde {"pedidos":[]}.`;

function extraerJson(texto){
  const inicio = texto.indexOf('{');
  const fin = texto.lastIndexOf('}');
  if(inicio === -1 || fin === -1 || fin < inicio) return null;
  try { return JSON.parse(texto.slice(inicio, fin + 1)); } catch(e){ return null; }
}

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

  const imagenBase64 = String(body.imagenBase64 || '');
  if(!imagenBase64){
    res.status(400).json({ error: 'imagen_vacia' });
    return;
  }
  if(imagenBase64.length > MAX_LARGO_IMAGEN_BASE64){
    res.status(400).json({ error: 'imagen_muy_grande' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if(!apiKey){
    res.status(500).json({ error: 'falta_configurar_api_key', mensaje: 'El servidor no tiene configurada ANTHROPIC_API_KEY.' });
    return;
  }

  try {
    const respuestaApi = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: MAX_TOKENS_RESPUESTA,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imagenBase64 } },
            { type: 'text', text: 'Transcribe el/los pedido(s) de esta imagen y responde solo con el JSON indicado.' }
          ]
        }]
      })
    });

    if(!respuestaApi.ok){
      const detalle = await respuestaApi.text().catch(() => '');
      console.error('Anthropic API error (comanda-ocr)', respuestaApi.status, detalle);
      res.status(502).json({ error: 'ia_no_disponible', mensaje: 'No se pudo leer la imagen con IA en este momento.' });
      return;
    }

    const data = await respuestaApi.json();
    const bloquesTexto = Array.isArray(data.content) ? data.content.filter(b => b && b.type === 'text' && b.text) : [];
    const textoCompleto = bloquesTexto.map(b => b.text).join('\n');
    const resultado = extraerJson(textoCompleto);

    if(!resultado || !Array.isArray(resultado.pedidos)){
      console.error('Respuesta de comanda-ocr sin JSON válido:', textoCompleto.slice(0, 500));
      res.status(502).json({ error: 'respuesta_invalida', mensaje: 'La IA no devolvió el pedido en el formato esperado.' });
      return;
    }

    const pedidosLimpios = resultado.pedidos.slice(0, 12).map(p => ({
      mesa: String((p && p.mesa) || '').slice(0, 40),
      zona: String((p && p.zona) || '').slice(0, 40),
      camarero: String((p && p.camarero) || '').slice(0, 60),
      personas: (p && Number.isFinite(Number(p.personas))) ? Math.max(0, Math.round(Number(p.personas))) : null,
      items: Array.isArray(p && p.items) ? p.items.slice(0, 60).map(i => String(i).slice(0, 140)) : []
    }));

    res.status(200).json({ pedidos: pedidosLimpios });
  } catch(err){
    console.error('Error llamando a Anthropic (comanda-ocr)', err);
    res.status(500).json({ error: 'error_interno', mensaje: 'Ocurrió un error al conectar con el análisis de IA.' });
  }
};
