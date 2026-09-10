// api/sincronizar-catalogo-fudo.js
//
// Trae el CATÁLOGO de Fudo (productos, insumos, personal, mesas, salones
// y cocinas) — no son transacciones del día, son configuración del POS
// que cambia poco. Por eso NO se filtra por fecha: siempre trae el estado
// actual completo de cada recurso, con paginación.
//
// A propósito NO incluye "customers" (clientes) — Harol pidió excluirlo
// por ahora porque trae datos personales (teléfono, dirección, cumpleaños).
//
// Esta función NO tiene cron todavía: se corre manualmente (llamando la
// URL con el secreto) cada vez que se quiera refrescar el catálogo.
//
// NO contiene ninguna contraseña ni clave: todas se leen desde las
// variables de entorno configuradas en Vercel (Settings → Environment Variables).

const admin = require('firebase-admin');

// ---------- Inicializar Firebase Admin (una sola vez) ----------
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// ---------- Configuración de las sedes ----------
// Mismas variables de entorno que sincronizar-fudo.js — si una sede no
// tiene credenciales configuradas todavía (ej. Montería), se omite con
// gracia en vez de fallar toda la sincronización.
const SEDES = [
  {
    id: 'chinu',
    apiKey: process.env.FUDO_API_KEY_CHINU,
    apiSecret: process.env.FUDO_API_SECRET_CHINU,
  },
  {
    id: 'monteria',
    apiKey: process.env.FUDO_API_KEY_MONTERIA,
    apiSecret: process.env.FUDO_API_SECRET_MONTERIA,
  },
];

const FUDO_AUTH_URL = 'https://auth.fu.do/api';
const FUDO_API_URL = 'https://api.fu.do/v1alpha1';

// ---------- Autenticación contra Fudo (idéntico a sincronizar-fudo.js) ----------
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

// ---------- Traer TODOS los registros de un recurso sin filtro de fecha ----------
async function traerRecursoCompleto(token, recurso) {
  let pagina = 1;
  const tamPagina = 100;
  let todos = [];

  while (true) {
    const url = `${FUDO_API_URL}/${recurso}?page[size]=${tamPagina}&page[number]=${pagina}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!resp.ok) {
      const texto = await resp.text();
      throw new Error(`Fallo consultando /${recurso}: ${resp.status} ${texto}`);
    }
    const cuerpo = await resp.json();
    const datos = cuerpo.data || [];
    todos = todos.concat(datos);

    if (datos.length < tamPagina) break; // ya no hay más páginas
    pagina += 1;
    if (pagina > 50) break; // límite de seguridad
  }

  return todos;
}

// ---------- Definición de campos relevantes por recurso ----------
// customers NO está en esta lista a propósito (pedido explícito de Harol).
const RECURSOS = [
  {
    nombre: 'products',
    mapear: (r) => ({
      id: r.id,
      name: r.attributes.name,
      price: r.attributes.price,
      cost: r.attributes.cost,
      stock: r.attributes.stock,
      stockControl: r.attributes.stockControl,
      sellAlone: r.attributes.sellAlone,
      preparationTime: r.attributes.preparationTime,
      active: r.attributes.active,
      position: r.attributes.position,
      minStock: r.attributes.minStock,
      imageUrl: r.attributes.imageUrl,
      code: r.attributes.code,
      description: r.attributes.description,
      enableOnlineMenu: r.attributes.enableOnlineMenu,
      enableQrMenu: r.attributes.enableQrMenu,
      favourite: r.attributes.favourite,
      ignoreAvailability: r.attributes.ignoreAvailability,
    }),
  },
  {
    nombre: 'ingredients',
    mapear: (r) => ({
      id: r.id,
      name: r.attributes.name,
      cost: r.attributes.cost,
      minStock: r.attributes.minStock,
      stock: r.attributes.stock,
      stockControl: r.attributes.stockControl,
    }),
  },
  {
    nombre: 'users',
    mapear: (r) => ({
      id: r.id,
      name: r.attributes.name,
      email: r.attributes.email,
      phone: r.attributes.phone,
      active: r.attributes.active,
      admin: r.attributes.admin,
      authPinEnabled: r.attributes.authPinEnabled,
      promotionalCode: r.attributes.promotionalCode,
    }),
  },
  {
    nombre: 'tables',
    mapear: (r) => ({
      id: r.id,
      number: r.attributes.number,
      row: r.attributes.row,
      column: r.attributes.column,
      shape: r.attributes.shape,
      size: r.attributes.size,
    }),
  },
  {
    nombre: 'rooms',
    mapear: (r) => ({
      id: r.id,
      name: r.attributes.name,
    }),
  },
  {
    nombre: 'kitchens',
    mapear: (r) => ({
      id: r.id,
      name: r.attributes.name,
      combinedReceiptPrinting: r.attributes.combinedReceiptPrinting,
    }),
  },
];

// ---------- Handler principal (lo que Vercel ejecuta) ----------
module.exports = async (req, res) => {
  // Seguridad simple: solo alguien con el secreto puede disparar esto
  // (mismo patrón que sincronizar-fudo.js).
  const secretoEsperado = process.env.SYNC_SECRET;
  const secretoRecibido = req.query.secret || req.headers['x-sync-secret'];
  if (secretoEsperado && secretoRecibido !== secretoEsperado) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  const resultados = {};

  for (const sede of SEDES) {
    if (!sede.apiKey || !sede.apiSecret) {
      resultados[sede.id] = { error: 'Faltan credenciales de Fudo para esta sede' };
      continue;
    }
    try {
      const token = await obtenerTokenFudo(sede.apiKey, sede.apiSecret);

      const docFinal = {
        sede: sede.id,
        totales: {},
        erroresPorRecurso: {},
        actualizadoEn: admin.firestore.FieldValue.serverTimestamp(),
      };
      const resumenSede = { ok: true };

      for (const recurso of RECURSOS) {
        try {
          const crudos = await traerRecursoCompleto(token, recurso.nombre);
          const mapeados = crudos.map(recurso.mapear);
          docFinal[recurso.nombre] = mapeados;
          docFinal.totales[recurso.nombre] = mapeados.length;
          resumenSede[recurso.nombre] = mapeados.length;
        } catch (errorRecurso) {
          docFinal[recurso.nombre] = [];
          docFinal.totales[recurso.nombre] = 0;
          docFinal.erroresPorRecurso[recurso.nombre] = errorRecurso.message;
          resumenSede[recurso.nombre] = 0;
          resumenSede.erroresPorRecurso = true;
        }
      }

      await db.collection('fudo_catalogo').doc(sede.id).set(docFinal);

      resultados[sede.id] = resumenSede;
    } catch (error) {
      resultados[sede.id] = { error: error.message, detalle: error.stack };
    }
  }

  res.status(200).json(resultados);
};
