// api/explorar-fudo.js
//
// Función de USO MANUAL (no corre automáticamente, no tiene cron). Sirve
// para descubrir qué recursos ofrece la API de Fudo más allá de /sales y
// /expenses, que son los únicos que ya usamos. Prueba una lista de
// nombres de recursos candidatos contra la API real de Fudo (sede Chinú)
// y devuelve, para cada uno: si existe (200) o no (404/400/etc.), y una
// muestra pequeña (hasta 2 registros) de cómo vienen sus datos reales.
//
// Se usa igual que sincronizar-fudo: abrir en el navegador
//   https://TU-DOMINIO.vercel.app/api/explorar-fudo?secret=TU_SYNC_SECRET
// (mismo SYNC_SECRET que ya configuraste en Vercel).
//
// No escribe nada en Firestore ni modifica nada en Fudo — solo lee y
// muestra. Es seguro correrla las veces que quieras.

const FUDO_AUTH_URL = 'https://auth.fu.do/api';
const FUDO_API_URL = 'https://api.fu.do/v1alpha1';

// Lista de nombres de recursos que podrían existir en la API de Fudo,
// además de los que ya confirmamos (sales, expenses). Son nombres
// típicos de un sistema de punto de venta — algunos van a dar 404
// porque Fudo no los expone o los llama distinto; eso es normal y
// esperado, no es un error de configuración.
const RECURSOS_CANDIDATOS = [
  'products',
  'categories',
  'waiters',
  'users',
  'tables',
  'rooms',
  'paymentMethods',
  'discounts',
  'tips',
  'kitchens',
  'printers',
  'customers',
  'clients',
  'promotions',
  'combos',
  'ingredients',
  'stocks',
  'inventoryMovements',
  'cashRegisters',
  'cashRegisterOperations',
  'shifts',
  'suppliers',
  'purchaseOrders',
  'taxes',
  'saleItems',
  'company',
  'branches',
  'venues',
];

async function obtenerTokenFudo(apiKey, apiSecret) {
  const resp = await fetch(FUDO_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apiKey, apiSecret }),
  });
  if (!resp.ok) {
    const texto = await resp.text();
    throw new Error(`Fallo autenticación Fudo: ${resp.status} ${texto}`);
  }
  const datos = await resp.json();
  return datos.token;
}

// Recorta un objeto para que la respuesta no quede gigante — solo nos
// interesa VER la forma de los datos (qué campos trae), no traer todo.
function recortarMuestra(item) {
  if (!item) return item;
  const recortado = { id: item.id, type: item.type, attributes: {} };
  const attrs = item.attributes || {};
  for (const clave of Object.keys(attrs)) {
    const valor = attrs[clave];
    recortado.attributes[clave] =
      typeof valor === 'string' && valor.length > 80 ? valor.slice(0, 80) + '…' : valor;
  }
  return recortado;
}

async function probarRecurso(token, recurso) {
  const url = `${FUDO_API_URL}/${recurso}?page[size]=2`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!resp.ok) {
      const texto = await resp.text();
      return { recurso, existe: false, status: resp.status, detalle: texto.slice(0, 200) };
    }
    const cuerpo = await resp.json();
    const datos = cuerpo.data || [];
    return {
      recurso,
      existe: true,
      status: 200,
      cantidadEnPagina: datos.length,
      camposDisponibles: datos[0] ? Object.keys(datos[0].attributes || {}) : [],
      muestra: datos.slice(0, 2).map(recortarMuestra),
    };
  } catch (error) {
    return { recurso, existe: false, status: 'error', detalle: error.message };
  }
}

module.exports = async (req, res) => {
  const secretoEsperado = process.env.SYNC_SECRET;
  const secretoRecibido = req.query.secret || req.headers['x-sync-secret'];
  if (secretoEsperado && secretoRecibido !== secretoEsperado) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  const apiKey = process.env.FUDO_API_KEY_CHINU;
  const apiSecret = process.env.FUDO_API_SECRET_CHINU;
  if (!apiKey || !apiSecret) {
    res.status(400).json({ error: 'Faltan las credenciales de Fudo de Chinú en Vercel.' });
    return;
  }

  try {
    const token = await obtenerTokenFudo(apiKey, apiSecret);

    // Se prueban todos los recursos en paralelo para que la exploración
    // sea rápida (son solo lecturas pequeñas, page[size]=2 cada una).
    const resultados = await Promise.all(
      RECURSOS_CANDIDATOS.map((recurso) => probarRecurso(token, recurso))
    );

    const disponibles = resultados.filter((r) => r.existe);
    const noDisponibles = resultados.filter((r) => !r.existe);

    res.status(200).json({
      resumen: `${disponibles.length} de ${RECURSOS_CANDIDATOS.length} recursos existen en esta cuenta de Fudo.`,
      disponibles,
      noDisponibles: noDisponibles.map((r) => ({ recurso: r.recurso, status: r.status })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message, detalle: error.stack });
  }
};
