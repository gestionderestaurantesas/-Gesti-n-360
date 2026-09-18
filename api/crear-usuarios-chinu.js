// api/crear-usuarios-chinu.js
//
// Función de USO MANUAL (una sola vez, no tiene cron). Crea o actualiza en
// Firebase Authentication las cuentas del personal de Chinú para el piloto,
// con una clave alfanumérica (letras + números) para cada uno.
//
// Reproduce EXACTAMENTE la misma transformación que ya usa el login de la
// app (ver ch-gestion-restaurantes.html, función iniciarSesionReal):
//   - correo interno  = usuario + "@cordova.appgestion360.local"
//   - clave en Firebase = "cordova_" + PIN
// El empleado solo escribe su "usuario" y su PIN de 4 dígitos en el login
// normal de la app — nunca ve el correo interno ni el prefijo.
//
// Se usa igual que las otras funciones manuales: abrir en el navegador
//   https://TU-DOMINIO.vercel.app/api/crear-usuarios-chinu?secret=TU_SYNC_SECRET
// (mismo SYNC_SECRET que ya configuraste en Vercel).
//
// IMPORTANTE: después de correrla y confirmar que los PINes funcionan,
// borra este archivo del repositorio (o al menos quítalo de GitHub) —
// no conviene dejar publicada una función que puede resetear claves.

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const DOMINIO_INTERNO_LOGIN = 'cordova.appgestion360.local';
const PREFIJO_CLAVE_LOGIN = 'cordova_';

// Personal de Chinú (mismos "usuario" ya guardados en la colección
// "usuarios" de la app) + la clave alfanumérica asignada para el piloto.
const PERSONAL_CHINU = [
  { usuario: 'leidis.vergara',     nombre: 'Leidis Ester Sarmiento Vergara',        clave: 'Lv48x2Qr' },
  { usuario: 'sandy.soto',         nombre: 'Sandy Torres Soto',                     clave: 'Ss73k9Lm' },
  { usuario: 'deimer.villadiego',  nombre: 'Deimer Alfonso Zapata Villadiego',      clave: 'Dv29p6Zt' },
  { usuario: 'yoenys.bello',       nombre: 'Yoenys Yanith Humanez Bello',           clave: 'Yb61w3Nc' },
  { usuario: 'luisana.bello',      nombre: 'Luisana Monterroza Bello',              clave: 'Lb34r8Hs' },
  { usuario: 'julio.simanca',      nombre: 'Julio Eduardo Garcia Simanca',          clave: 'Js87d2Kf' },
  { usuario: 'heriberto.urdaneta', nombre: 'Heriberto De Jesus Sarmiento Urdaneta', clave: 'Hu19t5Gp' },
  { usuario: 'alberto.moteroza',   nombre: 'Alberto Lobo Moteroza',                 clave: 'Am50q7Wc' },
  { usuario: 'beatriz.monterroza', nombre: 'Beatriz Elena Sarmiento Monterroza',    clave: 'Bm92e4Xr' },
  { usuario: 'juan.mendoza',       nombre: 'Juan Sebastian Perez Mendoza',          clave: 'Jm36y1Vb' },
  { usuario: 'valentina.dias',     nombre: 'Valentina Alvarez Dias',                clave: 'Vd70n9Ts' },
];

module.exports = async (req, res) => {
  const secretoEsperado = process.env.SYNC_SECRET;
  const secretoRecibido = req.query.secret || req.headers['x-sync-secret'];
  if (secretoEsperado && secretoRecibido !== secretoEsperado) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  const resultados = [];
  for (const persona of PERSONAL_CHINU) {
    const email = persona.usuario.trim().toLowerCase() + '@' + DOMINIO_INTERNO_LOGIN;
    const password = PREFIJO_CLAVE_LOGIN + persona.clave;
    try {
      let userRecord;
      try {
        userRecord = await admin.auth().getUserByEmail(email);
        await admin.auth().updateUser(userRecord.uid, { password, displayName: persona.nombre });
        resultados.push({ usuario: persona.usuario, accion: 'clave actualizada', ok: true });
      } catch (errBusqueda) {
        if (errBusqueda.code === 'auth/user-not-found') {
          userRecord = await admin.auth().createUser({ email, password, displayName: persona.nombre });
          resultados.push({ usuario: persona.usuario, accion: 'usuario creado', ok: true });
        } else {
          throw errBusqueda;
        }
      }
    } catch (err) {
      resultados.push({ usuario: persona.usuario, ok: false, error: err.message });
    }
  }

  res.status(200).json({
    resumen: `${resultados.filter(r => r.ok).length} de ${PERSONAL_CHINU.length} cuentas listas.`,
    resultados,
  });
};
