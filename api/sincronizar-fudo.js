// api/sincronizar-fudo.js
//
// Esta función se ejecuta automáticamente todos los días (vía Vercel Cron).
// Se conecta a Fudo (Chinú y Montería), trae las ventas del día anterior
// (hora Colombia) y guarda un resumen listo para usar en Firestore.
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
// Cada sede tiene su propio apiKey/apiSecret de Fudo, guardados como
// variables de entorno separadas en Vercel.
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

// ---------- Utilidades de fecha (Colombia = UTC-5, sin horario de verano) ----------
function rangoDiaColombiaEnUTC(fechaLocalYYYYMMDD) {
  // fechaLocalYYYYMMDD ej: "2026-09-08"
  // Colombia está siempre en UTC-5, así que el día local
  // 2026-09-08 00:00 a 24:00 (Bogotá) equivale en UTC a:
  //   2026-09-08T05:00:00Z  ->  2026-09-09T04:59:59Z
  const [anio, mes, dia] = fechaLocalYYYYMMDD.split('-').map(Number);
  const inicioUTC = new Date(Date.UTC(anio, mes - 1, dia, 5, 0, 0));
  const finUTC = new Date(inicioUTC.getTime() + 24 * 60 * 60 * 1000 - 1000);
  const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { gte: fmt(inicioUTC), lte: fmt(finUTC) };
}

function fechaDeAyerColombia() {
  const ahoraUTC = new Date();
  // Restamos 5 horas para "ver" la hora actual de Colombia
  const colombiaAhora = new Date(ahoraUTC.getTime() - 5 * 60 * 60 * 1000);
  colombiaAhora.setUTCDate(colombiaAhora.getUTCDate() - 1);
  const anio = colombiaAhora.getUTCFullYear();
  const mes = String(colombiaAhora.getUTCMonth() + 1).padStart(2, '0');
  const dia = String(colombiaAhora.getUTCDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
}

// ---------- Autenticación contra Fudo ----------
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

// ---------- Traer TODAS las ventas del día (con paginación) ----------
async function traerVentasDelDia(token, gte, lte) {
  const includes = [
    'items',
    'payments.paymentMethod',
    'tips',
    'discounts',
    'table',
    'waiter',
  ].join(',');

  let pagina = 1;
  const tamPagina = 100;
  let todasLasVentas = [];
  let todosLosIncluidos = [];

  while (true) {
    const url =
      `${FUDO_API_URL}/sales?` +
      `filter[createdAt]=and(gte.${gte},lte.${lte})` +
      `&include=${includes}` +
      `&page[size]=${tamPagina}&page[number]=${pagina}`;

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!resp.ok) {
      const texto = await resp.text();
      throw new Error(`Fallo consultando /sales: ${resp.status} ${texto}`);
    }
    const cuerpo = await resp.json();
    const datos = cuerpo.data || [];
    const incluidos = cuerpo.included || [];

    todasLasVentas = todasLasVentas.concat(datos);
    todosLosIncluidos = todosLosIncluidos.concat(incluidos);

    if (datos.length < tamPagina) break; // ya no hay más páginas
    pagina += 1;
    if (pagina > 50) break; // límite de seguridad
  }

  return { ventas: todasLasVentas, incluidos: todosLosIncluidos };
}

// ---------- Traer gastos del día (para "Gastos de caja") ----------
async function traerGastosDelDia(token, gte, lte) {
  try {
    const url =
      `${FUDO_API_URL}/expenses?` +
      `filter[createdAt]=and(gte.${gte},lte.${lte})` +
      `&include=expenseCategory&page[size]=100`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!resp.ok) return { gastos: [], incluidos: [] };
    const cuerpo = await resp.json();
    return { gastos: cuerpo.data || [], incluidos: cuerpo.included || [] };
  } catch (e) {
    // Si el endpoint de gastos falla, no debe tumbar toda la sincronización
    return { gastos: [], incluidos: [] };
  }
}

// ---------- Armar un índice rápido de los "included" por tipo+id ----------
function indexarIncluidos(incluidos) {
  const indice = {};
  for (const item of incluidos) {
    indice[`${item.type}:${item.id}`] = item;
  }
  return indice;
}

// ---------- Procesar y agregar toda la información de un día/sede ----------
function agregarDatosDelDia(ventas, incluidos, gastos, gastosIncluidos) {
  const indice = indexarIncluidos(incluidos);
  const indiceGastos = indexarIncluidos(gastosIncluidos);

  const resumen = {
    ventasCantidad: 0,
    ventasTotalDinero: 0,
    personasTotal: 0,
    porMedioPago: {}, // { "Efectivo": 12345, ... }
    propinasTotal: 0,
    propinasPorMedioPago: {},
    productosCanceladosCantidad: 0,
    porMesero: {}, // { "20": { nombre, ventas, totalDinero } }
  };

  const detalleVentas = [];

  for (const venta of ventas) {
    const attrs = venta.attributes || {};
    const rel = venta.relationships || {};
    const estado = attrs.saleState;

    if (estado !== 'CLOSED') continue; // solo contamos ventas cerradas

    const total = Number(attrs.total || 0);
    resumen.ventasCantidad += 1;
    resumen.ventasTotalDinero += total;
    resumen.personasTotal += Number(attrs.people || 0);

    // Mesero
    const waiterRef = rel.waiter && rel.waiter.data;
    let meseroId = null;
    let meseroNombre = 'Sin asignar';
    if (waiterRef) {
      meseroId = waiterRef.id;
      const usuario = indice[`User:${waiterRef.id}`];
      if (usuario && usuario.attributes) meseroNombre = usuario.attributes.name || meseroNombre;
    }
    if (meseroId) {
      if (!resumen.porMesero[meseroId]) {
        resumen.porMesero[meseroId] = { nombre: meseroNombre, ventas: 0, totalDinero: 0 };
      }
      resumen.porMesero[meseroId].ventas += 1;
      resumen.porMesero[meseroId].totalDinero += total;
    }

    // Pagos
    const pagosRef = (rel.payments && rel.payments.data) || [];
    for (const pRef of pagosRef) {
      const pago = indice[`Payment:${pRef.id}`];
      if (!pago || pago.attributes.canceled) continue;
      const monto = Number(pago.attributes.amount || 0);
      const pmRef = pago.relationships && pago.relationships.paymentMethod && pago.relationships.paymentMethod.data;
      const pm = pmRef ? indice[`PaymentMethod:${pmRef.id}`] : null;
      const nombreMedio = (pm && pm.attributes && pm.attributes.name) || 'Desconocido';
      resumen.porMedioPago[nombreMedio] = (resumen.porMedioPago[nombreMedio] || 0) + monto;
    }

    // Propinas
    const tipsRef = (rel.tips && rel.tips.data) || [];
    for (const tRef of tipsRef) {
      const tip = indice[`Tip:${tRef.id}`];
      if (!tip || tip.attributes.canceled) continue;
      const monto = Number(tip.attributes.amount || 0);
      resumen.propinasTotal += monto;
      const pmRef = tip.relationships && tip.relationships.paymentMethod && tip.relationships.paymentMethod.data;
      const pm = pmRef ? indice[`PaymentMethod:${pmRef.id}`] : null;
      const nombreMedio = (pm && pm.attributes && pm.attributes.name) || 'Desconocido';
      resumen.propinasPorMedioPago[nombreMedio] = (resumen.propinasPorMedioPago[nombreMedio] || 0) + monto;
    }

    // Items cancelados (productos cancelados)
    const itemsRef = (rel.items && rel.items.data) || [];
    for (const iRef of itemsRef) {
      const item = indice[`Item:${iRef.id}`];
      if (item && item.attributes.canceled) {
        resumen.productosCanceladosCantidad += 1;
      }
    }

    detalleVentas.push({
      id: venta.id,
      total,
      personas: attrs.people || null,
      saleType: attrs.saleType,
      meseroId,
      meseroNombre,
      mesaId: rel.table && rel.table.data ? rel.table.data.id : null,
      creadaEn: attrs.createdAt,
      cerradaEn: attrs.closedAt,
    });
  }

  // Gastos
  let gastosTotal = 0;
  const gastosDetalle = [];
  for (const gasto of gastos) {
    const attrs = gasto.attributes || {};
    if (attrs.canceled) continue;
    const monto = Number(attrs.amount || 0);
    gastosTotal += monto;
    const catRef = gasto.relationships && gasto.relationships.expenseCategory && gasto.relationships.expenseCategory.data;
    const categoria = catRef ? indiceGastos[`ExpenseCategory:${catRef.id}`] : null;
    gastosDetalle.push({
      id: gasto.id,
      monto,
      categoria: (categoria && categoria.attributes && categoria.attributes.name) || 'Sin categoría',
      descripcion: attrs.description || '',
    });
  }
  resumen.gastosCajaTotal = gastosTotal;

  return { resumen, detalleVentas, gastosDetalle };
}

// ---------- Handler principal (lo que Vercel ejecuta) ----------
module.exports = async (req, res) => {
  // Seguridad simple: solo Vercel Cron (o alguien con el secreto) puede disparar esto
  const secretoEsperado = process.env.SYNC_SECRET;
  const secretoRecibido = req.query.secret || req.headers['x-sync-secret'];
  if (secretoEsperado && secretoRecibido !== secretoEsperado) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  const fechaObjetivo = req.query.fecha || fechaDeAyerColombia();
  const { gte, lte } = rangoDiaColombiaEnUTC(fechaObjetivo);

  const resultados = {};

  for (const sede of SEDES) {
    if (!sede.apiKey || !sede.apiSecret) {
      resultados[sede.id] = { error: 'Faltan credenciales de Fudo para esta sede' };
      continue;
    }
    try {
      const token = await obtenerTokenFudo(sede.apiKey, sede.apiSecret);
      const { ventas, incluidos } = await traerVentasDelDia(token, gte, lte);
      const { gastos, incluidos: gastosIncluidos } = await traerGastosDelDia(token, gte, lte);
      const { resumen, detalleVentas, gastosDetalle } = agregarDatosDelDia(
        ventas,
        incluidos,
        gastos,
        gastosIncluidos
      );

      const docId = `${sede.id}_${fechaObjetivo}`;

      await db.collection('fudo_ventas_dia').doc(docId).set({
        sede: sede.id,
        fecha: fechaObjetivo,
        ...resumen,
        actualizadoEn: admin.firestore.FieldValue.serverTimestamp(),
      });

      await db.collection('fudo_ventas_detalle').doc(docId).set({
        sede: sede.id,
        fecha: fechaObjetivo,
        ventas: detalleVentas,
        gastos: gastosDetalle,
        actualizadoEn: admin.firestore.FieldValue.serverTimestamp(),
      });

      resultados[sede.id] = {
        ok: true,
        ventasEncontradas: ventas.length,
        ventasCerradas: resumen.ventasCantidad,
      };
    } catch (error) {
      resultados[sede.id] = { error: error.message, detalle: error.stack };
    }
  }

  res.status(200).json({ fecha: fechaObjetivo, resultados });
};
