// api/sheet-proxy.js
//
// Puente simple para traer el CSV público de Google Sheets (como la hoja
// "Recolección de data - Cordova Restaurant" que usa Montería en
// Encuesta de satisfacción). El navegador NO puede pedirle ese CSV
// directamente a docs.google.com — Google no deja esa petición cruzar de
// un sitio a otro (CORS), así que el navegador recibe "Failed to fetch"
// aunque la hoja sí sea pública. La solución: el navegador le pide el
// CSV a ESTE servidor (mismo dominio, sin problema de CORS), y este
// servidor sí puede pedírselo directamente a Google sin restricción
// (las peticiones servidor-a-servidor no tienen CORS).
//
// Por seguridad, solo deja pasar URLs que apunten a docs.google.com —
// nunca a cualquier otra dirección — para que esto no se pueda usar como
// un proxy abierto hacia cualquier sitio.
//
// Cómo usarlo desde el navegador:
//   /api/sheet-proxy?url=<URL de docs.google.com, codificada>

module.exports = async function handler(req, res){
  if(req.method !== 'GET'){
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const url = String(req.query.url || '');
  if(!url){
    res.status(400).json({ error: 'falta_url' });
    return;
  }

  let destino;
  try{
    destino = new URL(url);
  } catch(e){
    res.status(400).json({ error: 'url_invalida' });
    return;
  }
  if(destino.hostname !== 'docs.google.com'){
    res.status(400).json({ error: 'dominio_no_permitido', mensaje: 'Solo se permite traer datos de docs.google.com.' });
    return;
  }

  try{
    const respuesta = await fetch(destino.toString(), { cache: 'no-store' });
    if(!respuesta.ok){
      res.status(502).json({ error: 'google_sheets_error', status: respuesta.status });
      return;
    }
    const texto = await respuesta.text();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(texto);
  } catch(err){
    console.error('Error en sheet-proxy:', err);
    res.status(500).json({ error: 'error_interno', mensaje: 'No se pudo conectar con Google Sheets desde el servidor.' });
  }
};
