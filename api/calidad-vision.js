// api/calidad-vision.js
//
// Función de servidor (Vercel Serverless Function) que analiza la foto de
// un plato con IA de visión (Claude) para el módulo "Control de calidad
// 360" (Operación → Cocina → Fotos de platos). Sigue el mismo patrón que
// api/chat.js y api/tts.js: la clave de la API vive SOLO en el servidor
// (variable de entorno ANTHROPIC_API_KEY), nunca en el HTML. Si ya
// configuraste ANTHROPIC_API_KEY para que funcione el chat de Harol-IA,
// este endpoint funciona de una sin necesidad de configurar nada más —
// usa la misma clave.
//
// Qué hace: recibe la foto en base64, le pide a la IA que identifique el
// plato y revise limpieza, proporciones, presentación y objetos extraños
// (cabello, tornillos, insectos, plástico, etc.), y devuelve un veredicto
// estructurado. La app usa ese veredicto para pre-llenar el estado
// (aprobado / corregir / rechazado) y disparar la alarma si detecta un
// problema — el equipo siempre revisa y puede corregir antes de guardar.
//
// IMPORTANTE — esto NO es un modelo entrenado con fotos de Córdova desde
// cero: usa un modelo de visión ya entrenado (Claude), guiado con
// instrucciones. Por eso, mientras el equipo revise y corrija las
// primeras evaluaciones (la app lleva la cuenta de las primeras 100),
// sirve como calibración para ver qué tan bien coincide con el criterio
// real del restaurante — no como un entrenamiento que cambie el modelo.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODELO = 'claude-sonnet-5';
const MAX_TOKENS_RESPUESTA = 500;
const MAX_LARGO_IMAGEN_BASE64 = 8000000; // ~8MB en base64, de sobra para una foto ya comprimida a ~640px de ancho

const SYSTEM_PROMPT = `Eres un inspector de control de calidad de cocina para un restaurante. Te llega la foto de un plato recién emplatado, listo para pasar a servicio. Tu trabajo es:
1. Identificar qué plato es (si lo reconoces por su aspecto; si no estás seguro, describe brevemente lo que ves).
2. Revisar: limpieza del plato y del borde (manchas, salsa derramada fuera del patrón), proporciones/porciones (que no se vean escasas ni desbordadas), presentación general (montaje, centrado, decoración), y muy especialmente cualquier objeto extraño que no debería estar ahí (cabello, insecto, tornillo, plástico, papel, etc. — esto es lo más grave y siempre debe marcarse con severidad "alta").
3. Responder ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, con esta forma exacta:
{"platoIdentificado":"nombre del plato o descripción corta","cumple":true o false,"problemas":["problema 1","problema 2"],"severidad":"baja" o "media" o "alta","explicacion":"una frase corta explicando el veredicto"}
Si no encuentras ningún problema, "cumple" debe ser true, "problemas" un arreglo vacío, y "severidad" "baja". Sé estricto pero razonable: no marques un plato como no conforme por detalles menores de estilo.`;

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
            { type: 'text', text: 'Evalúa esta foto del plato y responde solo con el JSON indicado.' }
          ]
        }]
      })
    });

    if(!respuestaApi.ok){
      const detalle = await respuestaApi.text().catch(() => '');
      console.error('Anthropic API error (vision)', respuestaApi.status, detalle);
      res.status(502).json({ error: 'ia_no_disponible', mensaje: 'No se pudo analizar la foto con IA en este momento.' });
      return;
    }

    const data = await respuestaApi.json();
    const bloquesTexto = Array.isArray(data.content) ? data.content.filter(b => b && b.type === 'text' && b.text) : [];
    const textoCompleto = bloquesTexto.map(b => b.text).join('\n');
    const veredicto = extraerJson(textoCompleto);

    if(!veredicto){
      console.error('Veredicto de visión sin JSON válido:', textoCompleto.slice(0, 500));
      res.status(502).json({ error: 'respuesta_invalida', mensaje: 'La IA no devolvió un veredicto en el formato esperado.' });
      return;
    }

    res.status(200).json({
      platoIdentificado: String(veredicto.platoIdentificado || '').slice(0, 120),
      cumple: veredicto.cumple !== false,
      problemas: Array.isArray(veredicto.problemas) ? veredicto.problemas.slice(0, 10).map(p => String(p).slice(0, 140)) : [],
      severidad: ['baja', 'media', 'alta'].includes(veredicto.severidad) ? veredicto.severidad : 'baja',
      explicacion: String(veredicto.explicacion || '').slice(0, 300)
    });
  } catch(err){
    console.error('Error llamando a Anthropic (vision)', err);
    res.status(500).json({ error: 'error_interno', mensaje: 'Ocurrió un error al conectar con el análisis de IA.' });
  }
};
