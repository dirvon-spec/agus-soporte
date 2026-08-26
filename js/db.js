// Capa de acceso a datos (contrato 2.3 del PLAN-MVP.md).
// sql.js es síncrono internamente; se envuelve todo en funciones async para
// aislar la capa y facilitar el reemplazo futuro por un driver nativo de Capacitor.
// Ningún error se traga: todo se relanza con {code, message} vía crearError().

import { DDL, SCHEMA_VERSION, MIGRACION_V1_A_V2 } from './schema.js';
import { generarSeed } from './seed.js';
import { calcularEstadosCalendario, Estado } from './calendar.js';
import { crearError } from './utils/errors.js';
import { uuidV7 } from './utils/uuid.js';
import { hoy, ahoraIso, esFechaIsoValida, esFutura, sumarDias, rango, diaDeSemana, diaDelMes, ultimoDiaDelMes } from './utils/date.js';
import { formatearCentavos } from './utils/money.js';
import { construirEnlaceWhatsApp } from './utils/whatsapp.js';

const SERVICIOS_VALIDOS = ['AGUA', 'LUZ', 'INTERNET', 'GAS', 'CABLE', 'OTRO'];
const FRECUENCIAS_VALIDAS = ['DIARIA', 'SEMANAL', 'MENSUAL'];

/**
 * §2.8: valida {frecuencia?, dia_semana?, dia_mes?} de un acuerdo y devuelve
 * la terna normalizada (default DIARIA, con dia_semana/dia_mes en NULL salvo
 * en el campo que corresponda a la frecuencia elegida). Usado por
 * crearClienteConAcuerdo y crearAcuerdo — una sola fuente de verdad para la
 * coherencia que el CHECK de la tabla ya exige a nivel DB.
 * @param {{frecuencia?:string, dia_semana?:?number, dia_mes?:?number}} datos
 * @returns {{frecuencia:string, dia_semana:?number, dia_mes:?number}}
 */
function validarFrecuencia({ frecuencia, dia_semana, dia_mes }) {
  const frecuenciaFinal = frecuencia === undefined || frecuencia === null ? 'DIARIA' : frecuencia;
  if (!FRECUENCIAS_VALIDAS.includes(frecuenciaFinal)) {
    throw crearError('VALIDATION_ERROR', `La frecuencia debe ser una de: ${FRECUENCIAS_VALIDAS.join(', ')}.`, { campo: 'frecuencia' });
  }

  if (frecuenciaFinal === 'DIARIA') {
    if (dia_semana !== undefined && dia_semana !== null) {
      throw crearError('VALIDATION_ERROR', 'La frecuencia DIARIA no admite día de la semana.', { campo: 'dia_semana' });
    }
    if (dia_mes !== undefined && dia_mes !== null) {
      throw crearError('VALIDATION_ERROR', 'La frecuencia DIARIA no admite día del mes.', { campo: 'dia_mes' });
    }
    return { frecuencia: 'DIARIA', dia_semana: null, dia_mes: null };
  }

  if (frecuenciaFinal === 'SEMANAL') {
    if (dia_mes !== undefined && dia_mes !== null) {
      throw crearError('VALIDATION_ERROR', 'La frecuencia SEMANAL no admite día del mes.', { campo: 'dia_mes' });
    }
    if (!Number.isInteger(dia_semana) || dia_semana < 0 || dia_semana > 6) {
      throw crearError(
        'VALIDATION_ERROR',
        'La frecuencia SEMANAL requiere un día de la semana entre 0 (domingo) y 6 (sábado).',
        { campo: 'dia_semana' }
      );
    }
    return { frecuencia: 'SEMANAL', dia_semana, dia_mes: null };
  }

  // MENSUAL
  if (dia_semana !== undefined && dia_semana !== null) {
    throw crearError('VALIDATION_ERROR', 'La frecuencia MENSUAL no admite día de la semana.', { campo: 'dia_semana' });
  }
  if (!Number.isInteger(dia_mes) || dia_mes < 1 || dia_mes > 31) {
    throw crearError('VALIDATION_ERROR', 'La frecuencia MENSUAL requiere un día del mes entre 1 y 31.', { campo: 'dia_mes' });
  }
  return { frecuencia: 'MENSUAL', dia_semana: null, dia_mes };
}

// A-002 (auditoría independiente): ?verify=1 usa una base de IndexedDB y un
// lock de instancia SEPARADOS de los de la demo — la demo nunca se toca en
// modo verificación, y cada corrida de verify arranca de datos limpios.
const NOMBRE_DB_INDEXEDDB_DEMO = 'agus-app-almacen';
const NOMBRE_DB_INDEXEDDB_VERIFY = 'agus-db-verify';
const NOMBRE_LOCK_DEMO = 'agus-db';
const NOMBRE_LOCK_VERIFY = 'agus-db-verify-lock';
const NOMBRE_STORE = 'archivos';
const CLAVE_ARCHIVO = 'sqlite-principal';

/** @type {any} instancia de la clase SQL.Database de sql.js */
let db = null;
/** @type {any} namespace SQL de sql.js (SQL.Database, etc.) */
let SQL = null;

let inicializado = false;
let soloLectura = false;
let listenersRegistrados = false;
let modoVerify = false;
let nombreDbIndexedDbActual = NOMBRE_DB_INDEXEDDB_DEMO;
let nombreLockActual = NOMBRE_LOCK_DEMO;

/** True si la URL actual trae ?verify=1 (modo de verificación en vivo, dev-verify.js). */
function detectarModoVerify() {
  if (typeof window === 'undefined' || !window.location) return false;
  try {
    return new URLSearchParams(window.location.search).get('verify') === '1';
  } catch (e) {
    return false;
  }
}

/** Borra una base de IndexedDB por nombre. No lanza si no existe. */
function borrarBaseIndexedDb(nombreDb) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(nombreDb);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve(); // best-effort: no bloquea el arranque
      req.onblocked = () => resolve();
    } catch (e) {
      resolve();
    }
  });
}

let temporizadorGuardado = null;
let guardadoPendiente = false;

// ============================================================
// Helpers internos de SQL
// ============================================================

function todasLasFilas(sql, params = [], dbRef = db) {
  const stmt = dbRef.prepare(sql);
  try {
    if (params && params.length) stmt.bind(params);
    const filas = [];
    while (stmt.step()) filas.push(stmt.getAsObject());
    return filas;
  } finally {
    stmt.free();
  }
}

function unaFila(sql, params = [], dbRef = db) {
  const filas = todasLasFilas(sql, params, dbRef);
  return filas.length ? filas[0] : null;
}

function ejecutarSQL(sql) {
  db.run(sql);
}

/**
 * Serializa la DB actual. IMPORTANTE: sql.js reinicia PRAGMA foreign_keys al
 * valor por defecto (0) en la conexión activa como efecto secundario de
 * export() — sin esto, R-003 quedaría desactivado silenciosamente después de
 * cada guardado (que ocurre tras cada escritura). Se reafirma de inmediato.
 */
function exportarBytesDb() {
  const bytes = db.export();
  ejecutarSQL('PRAGMA foreign_keys = ON;');
  return bytes;
}

function normalizarError(e) {
  if (e && typeof e === 'object' && e.code && ['VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT', 'DB_ERROR'].includes(e.code)) {
    return e;
  }
  return crearError('DB_ERROR', (e && e.message) ? e.message : String(e), { original: e });
}

function verificarEscritura() {
  if (soloLectura) {
    throw crearError('CONFLICT', 'La app ya está abierta en otra pestaña; cerrala para editar aquí.');
  }
}

function obtenerMetaInterno(clave) {
  const fila = unaFila('SELECT valor FROM meta WHERE clave = ?', [clave]);
  return fila ? fila.valor : null;
}

function setMetaInterno(clave, valor) {
  db.run('INSERT OR REPLACE INTO meta (clave, valor) VALUES (?, ?)', [clave, valor]);
}

/** Fórmula de saldo de 2.2, aplicada hasta una fecha de corte (inclusive). */
function calcularSaldoInterno(clienteId, hastaFecha) {
  const fila = unaFila(
    `SELECT COALESCE(SUM(
        CASE WHEN tipo='CARGO' THEN monto_centavos
             WHEN tipo='ABONO' THEN -monto_centavos
             WHEN tipo='AJUSTE' THEN monto_centavos
             ELSE 0 END
      ), 0) AS saldo
     FROM movimientos WHERE cliente_id = ? AND deleted_at IS NULL AND fecha <= ?`,
    [clienteId, hastaFecha]
  );
  return fila ? fila.saldo : 0;
}

/** Crédito que aporta un movimiento ABONO/AJUSTE a la fecha del día (misma convención que calendar.js). */
function creditoDeMovimiento(m) {
  if (m.tipo === 'ABONO') return m.monto_centavos;
  if (m.tipo === 'AJUSTE') return -m.monto_centavos;
  return 0;
}

/**
 * Busca en una lista de acuerdos (ya cargados en memoria) el vigente en una
 * fecha, con el MISMO desempate que calendar.js (mitigación B1): si hay más
 * de un acuerdo aplicable a la misma fecha, se toma el de vigente_desde más
 * reciente, y entre iguales el de created_at más reciente. Compartido por
 * calcularArrastreCumplimiento() y obtenerCalendarioGlobal() para no repetir
 * la regla de desempate en tres lugares distintos.
 * @param {Array<{vigente_desde:string, vigente_hasta:?string, created_at?:string}>} acuerdos
 * @param {string} fecha
 * @returns {object|null}
 */
function buscarAcuerdoVigenteEnLista(acuerdos, fecha) {
  const candidatos = acuerdos.filter(
    (a) => a.vigente_desde <= fecha && (a.vigente_hasta == null || a.vigente_hasta >= fecha)
  );
  if (candidatos.length === 0) return null;
  if (candidatos.length === 1) return candidatos[0];
  candidatos.sort((a, b) => {
    if (a.vigente_desde !== b.vigente_desde) return a.vigente_desde < b.vigente_desde ? 1 : -1;
    const ca = a.created_at || '';
    const cb = b.created_at || '';
    if (ca === cb) return 0;
    return ca < cb ? 1 : -1;
  });
  return candidatos[0];
}

/**
 * §2.8: réplica local (deliberada, no se importa de calendar.js) de la misma
 * regla de "día exigible" que usa calendar.js — DIARIA exige todos los días,
 * SEMANAL solo su dia_semana, MENSUAL solo su dia_mes (clamp a fin de mes).
 * @param {{frecuencia?:string, dia_semana?:?number, dia_mes?:?number}} acuerdo
 * @param {string} fecha
 * @returns {boolean}
 */
function esDiaExigible(acuerdo, fecha) {
  const frecuencia = acuerdo.frecuencia || 'DIARIA';
  if (frecuencia === 'DIARIA') return true;
  if (frecuencia === 'SEMANAL') return diaDeSemana(fecha) === acuerdo.dia_semana;
  if (frecuencia === 'MENSUAL') {
    const diaExigibleClamp = Math.min(acuerdo.dia_mes, ultimoDiaDelMes(fecha));
    return diaDelMes(fecha) === diaExigibleClamp;
  }
  return true;
}

/**
 * arrastreInicial de CUMPLIMIENTO DE CUOTA (2.5), NO el saldo del ledger (2.2).
 *
 * FIX (Builder B, verificación en vivo — corregido en PLAN-MVP.md §2.5, gate
 * 25-ago-2026): usar -calcularSaldo() acá es incorrecto porque el saldo del
 * ledger no tiene noción de "cuota exigida por día" — un cliente que pagó bien
 * un tramo largo y luego dejó de pagar (sin CARGOs de por medio) queda con un
 * saldo del ledger muy "a favor" que no refleja los días de cuota impaga desde
 * entonces. Acá se hace el barrido histórico real que pide el plan: desde el
 * primer acuerdo del cliente hasta hastaFecha (inclusive), sumando el crédito
 * de cada día (ABONO/AJUSTE) y restando la cuota exigible de cada día con
 * acuerdo vigente — exactamente la misma aritmética de calendar.js, pero sin
 * clasificar estados (solo se necesita el arrastre numérico final). No se
 * modifica calendar.js: es una réplica local y deliberada de su lógica,
 * incluyendo el mismo desempate de acuerdos superpuestos (mitigación B1).
 *
 * @param {Array<{vigente_desde:string, vigente_hasta:?string, monto_cuota_centavos:number, created_at?:string}>} acuerdos
 * @param {Array<{tipo:string, monto_centavos:number, fecha:string}>} movimientos - ABONO/AJUSTE, cualquier fecha
 * @param {string} hastaFecha - 'YYYY-MM-DD', inclusive
 * @returns {number}
 */
function calcularArrastreCumplimiento(acuerdos, movimientos, hastaFecha) {
  if (!acuerdos.length) return 0;

  const primerVigenteDesde = acuerdos.reduce(
    (min, a) => (a.vigente_desde < min ? a.vigente_desde : min),
    acuerdos[0].vigente_desde
  );
  if (hastaFecha < primerVigenteDesde) return 0; // el rango termina antes de que exista obligación alguna

  const creditoPorFecha = new Map();
  for (const m of movimientos) {
    if (m.fecha > hastaFecha) continue; // solo el tramo histórico relevante
    const credito = creditoDeMovimiento(m);
    creditoPorFecha.set(m.fecha, (creditoPorFecha.get(m.fecha) || 0) + credito);
  }

  let arrastre = 0;
  for (const fecha of rango(primerVigenteDesde, hastaFecha)) {
    const acuerdoVigente = buscarAcuerdoVigenteEnLista(acuerdos, fecha);
    if (!acuerdoVigente) continue; // SIN_OBLIGACION: no consume ni genera arrastre
    const creditoDelDia = creditoPorFecha.get(fecha) || 0;
    if (!esDiaExigible(acuerdoVigente, fecha)) {
      // §2.8: día no exigible por frecuencia — el crédito se banca igual
      // (abonos de cualquier día suman crédito) sin restar cuota.
      arrastre += creditoDelDia;
      continue;
    }
    arrastre = arrastre + creditoDelDia - acuerdoVigente.monto_cuota_centavos;
  }
  return arrastre;
}

// ============================================================
// IndexedDB (almacenamiento crudo del archivo .sqlite serializado)
// ============================================================

function abrirIndexedDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(nombreDbIndexedDbActual, 1);
    req.onupgradeneeded = () => {
      const almacen = req.result;
      if (!almacen.objectStoreNames.contains(NOMBRE_STORE)) {
        almacen.createObjectStore(NOMBRE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function leerArchivoDeIndexedDB() {
  try {
    const idb = await abrirIndexedDB();
    return await new Promise((resolve, reject) => {
      const tx = idb.transaction(NOMBRE_STORE, 'readonly');
      const store = tx.objectStore(NOMBRE_STORE);
      const req = store.get(CLAVE_ARCHIVO);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    // Primer arranque o IndexedDB no disponible: se trata como "no hay datos".
    return null;
  }
}

async function guardarArchivoEnIndexedDB(bytes) {
  const idb = await abrirIndexedDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(NOMBRE_STORE, 'readwrite');
    const store = tx.objectStore(NOMBRE_STORE);
    store.put(bytes, CLAVE_ARCHIVO);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================================
// Persistencia (debounce 500ms + flush en pagehide/visibilitychange) — mitigación C1
// ============================================================

function flushGuardado() {
  if (temporizadorGuardado) {
    clearTimeout(temporizadorGuardado);
    temporizadorGuardado = null;
  }
  if (!guardadoPendiente || !db) return;
  guardadoPendiente = false;
  const bytes = exportarBytesDb();
  // Fire-and-forget: en pagehide no podemos garantizar esperar la promesa,
  // pero disparamos la escritura igual (best effort de los navegadores modernos).
  guardarArchivoEnIndexedDB(bytes).catch((e) => {
    console.error('[db] Error al persistir en IndexedDB:', e);
  });
}

async function persistirInmediato() {
  if (temporizadorGuardado) {
    clearTimeout(temporizadorGuardado);
    temporizadorGuardado = null;
  }
  guardadoPendiente = false;
  if (!db) return;
  const bytes = exportarBytesDb();
  await guardarArchivoEnIndexedDB(bytes);
}

/**
 * Serializa la DB actual y la guarda en IndexedDB, debounced ~500ms.
 * @returns {Promise<void>}
 */
export async function persistirEnIndexedDB() {
  guardadoPendiente = true;
  if (temporizadorGuardado) clearTimeout(temporizadorGuardado);
  temporizadorGuardado = setTimeout(flushGuardado, 500);
}

function registrarListenersDeFlush() {
  if (listenersRegistrados) return;
  if (typeof window === 'undefined') return;
  window.addEventListener('pagehide', flushGuardado);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushGuardado();
    });
  }
  listenersRegistrados = true;
}

// ============================================================
// Lock de instancia única (mitigación C2)
// ============================================================

async function adquirirLockInstanciaUnica() {
  if (typeof navigator === 'undefined' || !navigator.locks || typeof navigator.locks.request !== 'function') {
    console.warn('[db] navigator.locks no disponible en este navegador; no se puede garantizar instancia única.');
    soloLectura = false;
    return;
  }
  await new Promise((resolveOuter) => {
    navigator.locks.request(nombreLockActual, { ifAvailable: true }, (lock) => {
      if (!lock) {
        soloLectura = true;
        console.warn(`[db] Lock "${nombreLockActual}" no disponible: la app ya está abierta en otra pestaña. Modo solo-lectura.`);
        resolveOuter();
        return Promise.resolve();
      }
      soloLectura = false;
      // Mantenemos el lock tomado mientras dure la pestaña: la promesa que
      // devolvemos acá no se resuelve hasta que la app se cierre/recargue.
      return new Promise(() => {
        resolveOuter();
      });
    });
  });
}

export function estaSoloLectura() {
  return soloLectura;
}

// ============================================================
// Ciclo de vida / infraestructura
// ============================================================

async function solicitarAlmacenamientoPersistente() {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
      return await navigator.storage.persist();
    }
  } catch (e) {
    console.warn('[db] Error al solicitar navigator.storage.persist():', e);
  }
  return false;
}

async function insertarSeedEnTransaccion() {
  const datos = generarSeed();
  ejecutarSQL('BEGIN;');
  try {
    for (const c of datos.clientes) {
      db.run(
        `INSERT INTO clientes (id, nombre, telefono, notas, created_at, updated_at, deleted_at)
         VALUES (?,?,?,?,?,?,NULL)`,
        [c.id, c.nombre, c.telefono ?? null, c.notas ?? null, c.created_at, c.updated_at]
      );
    }
    for (const a of datos.acuerdos) {
      db.run(
        `INSERT INTO acuerdos (id, cliente_id, monto_cuota_centavos, frecuencia, dia_semana, dia_mes, vigente_desde, vigente_hasta, created_at, updated_at, deleted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
        [
          a.id,
          a.cliente_id,
          a.monto_cuota_centavos,
          a.frecuencia ?? 'DIARIA',
          a.dia_semana ?? null,
          a.dia_mes ?? null,
          a.vigente_desde,
          a.vigente_hasta ?? null,
          a.created_at,
          a.updated_at,
        ]
      );
    }
    for (const m of datos.movimientos) {
      db.run(
        `INSERT INTO movimientos (id, cliente_id, tipo, monto_centavos, fecha, servicio, referencia, nota, movimiento_original_id, created_at, updated_at, deleted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`,
        [
          m.id,
          m.cliente_id,
          m.tipo,
          m.monto_centavos,
          m.fecha,
          m.servicio ?? null,
          m.referencia ?? null,
          m.nota ?? null,
          m.movimiento_original_id ?? null,
          m.created_at,
          m.updated_at,
        ]
      );
    }
    setMetaInterno('modo_demo', '1');
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw crearError('DB_ERROR', 'No se pudo insertar el seed de datos de ejemplo.', { original: String(e) });
  }
}

/** Re-sembrado automático anti-congelamiento (mitigación D1), SOLO en modo_demo=1. */
/**
 * §2.8 (gate del dueño 25-ago-2026): si la base local existente quedó en
 * schema_version=1, aplica MIGRACION_V1_A_V2 (ALTER TABLE, sin tocar datos) y
 * actualiza meta a la versión vigente. No-op si ya está al día.
 */
async function migrarEsquemaSiHaceFalta() {
  const version = obtenerMetaInterno('schema_version');
  if (version === SCHEMA_VERSION) return;
  if (version !== '1') {
    throw crearError(
      'DB_ERROR',
      `La base local tiene un schema_version desconocido ("${version}") y no se puede migrar automáticamente.`
    );
  }

  ejecutarSQL('BEGIN;');
  try {
    for (const sql of MIGRACION_V1_A_V2) db.run(sql);
    setMetaInterno('schema_version', SCHEMA_VERSION);
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw crearError('DB_ERROR', 'No se pudo migrar el esquema local (v1 -> v2, frecuencia de cobro).', { original: String(e) });
  }
  await persistirInmediato();
  console.info(`[db] Migración de esquema aplicada: v1 -> v${SCHEMA_VERSION} (frecuencia de cobro configurable). Datos preservados.`);
}

async function revisarReSembradoAntiCongelamiento() {
  const modoDemo = obtenerMetaInterno('modo_demo');
  if (modoDemo !== '1') return;

  const filaMax = unaFila("SELECT MAX(fecha) AS maxFecha FROM movimientos WHERE deleted_at IS NULL");
  const maxFecha = filaMax ? filaMax.maxFecha : null;
  const ayer = sumarDias(hoy(), -1);

  if (maxFecha !== null && maxFecha >= ayer) return; // datos frescos, nada que hacer

  ejecutarSQL('BEGIN;');
  try {
    db.run('DELETE FROM movimientos;');
    db.run('DELETE FROM acuerdos;');
    db.run('DELETE FROM clientes;');
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw crearError('DB_ERROR', 'No se pudo re-sembrar la demo.', { original: String(e) });
  }
  await insertarSeedEnTransaccion();
  await persistirInmediato();
  console.info('[db] Re-sembrado automático anti-congelamiento ejecutado (modo_demo=1, seed vencido).');
}

/**
 * Carga sql-wasm.wasm, abre/crea la DB, activa foreign_keys, adquiere lock de
 * instancia única, solicita almacenamiento persistente, siembra si hace falta.
 * @returns {Promise<void>}
 */
export async function initDb() {
  if (inicializado) return;

  // A-002: resolver el modo ANTES de tocar IndexedDB. En modo verify se usa
  // una base y un lock separados de la demo, y esa base de verify se borra al
  // arrancar para que cada corrida de ?verify=1 parta de datos limpios — la
  // base de demo (NOMBRE_DB_INDEXEDDB_DEMO) jamás se lee ni se escribe acá.
  modoVerify = detectarModoVerify();
  nombreDbIndexedDbActual = modoVerify ? NOMBRE_DB_INDEXEDDB_VERIFY : NOMBRE_DB_INDEXEDDB_DEMO;
  nombreLockActual = modoVerify ? NOMBRE_LOCK_VERIFY : NOMBRE_LOCK_DEMO;

  if (modoVerify) {
    await borrarBaseIndexedDb(nombreDbIndexedDbActual);
  }

  const initSqlJsVendor = typeof window !== 'undefined' ? window.initSqlJs : undefined;
  if (typeof initSqlJsVendor !== 'function') {
    throw crearError(
      'DB_ERROR',
      'No se encontró sql.js (window.initSqlJs). Verificá que js/vendor/sql-wasm.js esté cargado antes de app.js.'
    );
  }

  try {
    SQL = await initSqlJsVendor({ locateFile: (file) => `js/vendor/${file}` });
  } catch (e) {
    throw crearError(
      'DB_ERROR',
      'No se pudo inicializar sql.js. Verificá que js/vendor/sql-wasm.wasm esté presente y sea accesible.',
      { original: String(e) }
    );
  }

  await adquirirLockInstanciaUnica();

  const bytesGuardados = await leerArchivoDeIndexedDB();

  let esNueva = false;
  try {
    db = bytesGuardados ? new SQL.Database(bytesGuardados) : new SQL.Database();
    esNueva = !bytesGuardados;
  } catch (e) {
    throw crearError('DB_ERROR', 'No se pudo abrir la base de datos SQLite.', { original: String(e) });
  }

  // R-003: sql.js trae foreign_keys desactivado por defecto; sin esto las REFERENCES son decorativas.
  ejecutarSQL('PRAGMA foreign_keys = ON;');

  if (esNueva) {
    ejecutarSQL('BEGIN;');
    try {
      db.run(DDL);
      setMetaInterno('schema_version', SCHEMA_VERSION);
      db.run('COMMIT;');
    } catch (e) {
      db.run('ROLLBACK;');
      throw crearError('DB_ERROR', 'No se pudo crear el esquema inicial.', { original: String(e) });
    }
    await insertarSeedEnTransaccion();
    await persistirInmediato();
  } else if (!soloLectura) {
    await migrarEsquemaSiHaceFalta();
    await revisarReSembradoAntiCongelamiento();
  }
  // persistirInmediato()/revisarReSembradoAntiCongelamiento() exportan la DB (db.export()),
  // lo que reinicia PRAGMA foreign_keys en sql.js (ver exportarBytesDb) — se reafirma acá
  // como garantía final antes de que la app empiece a leer/escribir (R-003).
  ejecutarSQL('PRAGMA foreign_keys = ON;');

  registrarListenersDeFlush();

  const persistido = await solicitarAlmacenamientoPersistente();
  console.info('[db] navigator.storage.persist():', persistido ? 'concedido' : 'denegado');
  if (!persistido) {
    console.warn('[db] Almacenamiento persistente denegado: el navegador podría liberar espacio si el dispositivo anda justo de memoria. Se recomienda exportar un respaldo seguido.');
  }

  inicializado = true;
}

// ============================================================
// Export / Import de respaldo (2.7, mitigación E1)
// ============================================================

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * @returns {Promise<{blob: Blob, nombreArchivo: string}>}
 */
export async function exportarRespaldo() {
  const bytes = exportarBytesDb();
  const blob = new Blob([bytes], { type: 'application/x-sqlite3' });
  const ahora = new Date();
  const nombreArchivo = `respaldo-${ahora.getFullYear()}${pad2(ahora.getMonth() + 1)}${pad2(ahora.getDate())}-${pad2(ahora.getHours())}${pad2(ahora.getMinutes())}.sqlite`;
  return { blob, nombreArchivo };
}

/**
 * Valida ANTES de reemplazar nada: schema_version soportada (v1 o v2; v1 se
 * migra en memoria antes de aceptar — §2.8) + cero huérfanos.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<void>}
 */
export async function importarRespaldo(arrayBuffer) {
  verificarEscritura();

  let dbCandidata;
  try {
    dbCandidata = new SQL.Database(new Uint8Array(arrayBuffer));
  } catch (e) {
    throw crearError('VALIDATION_ERROR', 'El archivo no es un respaldo válido de esta app.');
  }

  try {
    const filaVersion = unaFila("SELECT valor FROM meta WHERE clave = 'schema_version'", [], dbCandidata);
    if (!filaVersion) {
      throw new Error('sin schema_version');
    }
    if (filaVersion.valor === '1') {
      // §2.8: un respaldo v1 es válido, pero se migra en memoria (mismas
      // sentencias que initDb()) ANTES de correr la validación de huérfanos.
      dbCandidata.run('BEGIN;');
      for (const sql of MIGRACION_V1_A_V2) dbCandidata.run(sql);
      dbCandidata.run("UPDATE meta SET valor = ? WHERE clave = 'schema_version'", [SCHEMA_VERSION]);
      dbCandidata.run('COMMIT;');
    } else if (filaVersion.valor !== SCHEMA_VERSION) {
      throw new Error(`schema_version "${filaVersion.valor}" no soportada`);
    }
    const huerfanosMov = unaFila(
      'SELECT COUNT(*) AS c FROM movimientos WHERE cliente_id NOT IN (SELECT id FROM clientes)',
      [],
      dbCandidata
    );
    const huerfanosAcu = unaFila(
      'SELECT COUNT(*) AS c FROM acuerdos WHERE cliente_id NOT IN (SELECT id FROM clientes)',
      [],
      dbCandidata
    );
    if (!huerfanosMov || huerfanosMov.c !== 0 || !huerfanosAcu || huerfanosAcu.c !== 0) {
      throw new Error('filas huérfanas detectadas');
    }
  } catch (e) {
    dbCandidata.close();
    throw crearError('VALIDATION_ERROR', 'El archivo no es un respaldo válido de esta app.', { original: String(e) });
  }

  if (db) db.close();
  db = dbCandidata;
  ejecutarSQL('PRAGMA foreign_keys = ON;');
  setMetaInterno('modo_demo', '0');
  await persistirInmediato();
}

// ============================================================
// Clientes
// ============================================================

/**
 * @param {{nombre:string, telefono?:string, notas?:string, monto_cuota_centavos:number, vigente_desde:string, frecuencia?:string, dia_semana?:number, dia_mes?:number}} datos
 * @returns {Promise<{cliente:object, acuerdo:object}>}
 */
export async function crearClienteConAcuerdo({ nombre, telefono, notas, monto_cuota_centavos, vigente_desde, frecuencia, dia_semana, dia_mes }) {
  verificarEscritura();

  const nombreLimpio = typeof nombre === 'string' ? nombre.trim() : '';
  if (nombreLimpio.length < 2) {
    throw crearError('VALIDATION_ERROR', 'El nombre debe tener al menos 2 caracteres.', { campo: 'nombre' });
  }
  if (!Number.isInteger(monto_cuota_centavos) || monto_cuota_centavos <= 0) {
    throw crearError('VALIDATION_ERROR', 'La cuota diaria debe ser un monto entero positivo, en centavos.', { campo: 'monto_cuota_centavos' });
  }
  if (!esFechaIsoValida(vigente_desde)) {
    throw crearError('VALIDATION_ERROR', 'La fecha de vigencia no es una fecha válida.', { campo: 'vigente_desde' });
  }
  if (esFutura(vigente_desde)) {
    throw crearError('VALIDATION_ERROR', 'La fecha de vigencia no puede ser futura.', { campo: 'vigente_desde' });
  }
  const frecuenciaNormalizada = validarFrecuencia({ frecuencia, dia_semana, dia_mes });

  const idCliente = uuidV7();
  const idAcuerdo = uuidV7();
  const ts = ahoraIso();

  ejecutarSQL('BEGIN;');
  try {
    db.run(
      `INSERT INTO clientes (id, nombre, telefono, notas, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,NULL)`,
      [idCliente, nombreLimpio, telefono || null, notas || null, ts, ts]
    );
    db.run(
      `INSERT INTO acuerdos (id, cliente_id, monto_cuota_centavos, frecuencia, dia_semana, dia_mes, vigente_desde, vigente_hasta, created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,?,?,NULL,?,?,NULL)`,
      [
        idAcuerdo,
        idCliente,
        monto_cuota_centavos,
        frecuenciaNormalizada.frecuencia,
        frecuenciaNormalizada.dia_semana,
        frecuenciaNormalizada.dia_mes,
        vigente_desde,
        ts,
        ts,
      ]
    );
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }

  await persistirEnIndexedDB();

  return {
    cliente: unaFila('SELECT * FROM clientes WHERE id = ?', [idCliente]),
    acuerdo: unaFila('SELECT * FROM acuerdos WHERE id = ?', [idAcuerdo]),
  };
}

/**
 * @param {{busqueda?:string, pagina?:number, tamanioPagina?:number}} opciones
 * @returns {Promise<{clientes:object[], total:number}>}
 */
export async function listarClientes({ busqueda = '', pagina = 1, tamanioPagina = 20 } = {}) {
  const hoyStr = hoy();
  const textoBusqueda = (busqueda || '').trim();
  const filtroBusqueda = textoBusqueda
    ? `AND (LOWER(c.nombre) LIKE LOWER(?) OR LOWER(COALESCE(c.telefono, '')) LIKE LOWER(?))`
    : '';
  const like = `%${textoBusqueda}%`;
  const paramsBusqueda = textoBusqueda ? [like, like] : [];

  const totalFila = unaFila(
    `SELECT COUNT(*) AS total FROM clientes c WHERE c.deleted_at IS NULL ${filtroBusqueda}`,
    paramsBusqueda
  );
  const total = totalFila ? totalFila.total : 0;

  const offset = Math.max(0, (pagina - 1) * tamanioPagina);
  const filas = todasLasFilas(
    `SELECT c.*,
        COALESCE((SELECT SUM(
            CASE WHEN m.tipo='CARGO' THEN m.monto_centavos
                 WHEN m.tipo='ABONO' THEN -m.monto_centavos
                 WHEN m.tipo='AJUSTE' THEN m.monto_centavos
                 ELSE 0 END)
          FROM movimientos m WHERE m.cliente_id = c.id AND m.deleted_at IS NULL AND m.fecha <= ?), 0) AS saldo_centavos,
        (SELECT a.monto_cuota_centavos FROM acuerdos a
          WHERE a.cliente_id = c.id AND a.deleted_at IS NULL
            AND a.vigente_desde <= ? AND (a.vigente_hasta IS NULL OR a.vigente_hasta >= ?)
          ORDER BY a.vigente_desde DESC, a.created_at DESC LIMIT 1) AS cuota_vigente_centavos,
        EXISTS(SELECT 1 FROM movimientos m2 WHERE m2.cliente_id = c.id AND m2.deleted_at IS NULL) AS tiene_movimientos
     FROM clientes c
     WHERE c.deleted_at IS NULL ${filtroBusqueda}
     ORDER BY c.nombre ASC
     LIMIT ? OFFSET ?`,
    [hoyStr, hoyStr, hoyStr, ...paramsBusqueda, tamanioPagina, offset]
  );
  // sql.js/SQLite no tiene tipo boolean nativo: EXISTS(...) vuelve 0/1 entero.
  const clientes = filas.map((c) => ({ ...c, tiene_movimientos: !!c.tiene_movimientos }));

  return { clientes, total };
}

/**
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function obtenerCliente(id) {
  return unaFila('SELECT * FROM clientes WHERE id = ?', [id]);
}

/**
 * @param {string} id
 * @param {{nombre?:string, telefono?:string, notas?:string}} cambios
 * @returns {Promise<object>}
 */
export async function actualizarCliente(id, cambios = {}) {
  verificarEscritura();

  const actual = unaFila('SELECT * FROM clientes WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!actual) throw crearError('NOT_FOUND', 'Cliente no encontrado.', { id });

  let nombre = actual.nombre;
  if (cambios.nombre !== undefined) {
    const nombreLimpio = String(cambios.nombre).trim();
    if (nombreLimpio.length < 2) {
      throw crearError('VALIDATION_ERROR', 'El nombre debe tener al menos 2 caracteres.', { campo: 'nombre' });
    }
    nombre = nombreLimpio;
  }
  const telefono = cambios.telefono !== undefined ? cambios.telefono : actual.telefono;
  const notas = cambios.notas !== undefined ? cambios.notas : actual.notas;
  const ts = ahoraIso();

  ejecutarSQL('BEGIN;');
  try {
    db.run('UPDATE clientes SET nombre=?, telefono=?, notas=?, updated_at=? WHERE id=?', [nombre, telefono, notas, ts, id]);
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }

  await persistirEnIndexedDB();
  return unaFila('SELECT * FROM clientes WHERE id = ?', [id]);
}

/**
 * @param {string} id
 * @param {{forzar?:boolean}} opciones
 * @returns {Promise<void>}
 */
export async function borrarClienteLogico(id, opciones = {}) {
  verificarEscritura();

  const forzar = !!opciones.forzar;
  const cliente = unaFila('SELECT * FROM clientes WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!cliente) throw crearError('NOT_FOUND', 'Cliente no encontrado.', { id });

  const saldo = calcularSaldoInterno(id, hoy());
  if (saldo !== 0 && !forzar) {
    throw crearError('CONFLICT', 'El cliente tiene saldo pendiente distinto de cero. Confirmá para borrar de todas formas.', { saldo });
  }

  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run('UPDATE clientes SET deleted_at=?, updated_at=? WHERE id=?', [ts, ts, id]);
    // Cascada lógica manual (sin ON DELETE CASCADE): cierra acuerdos activos del cliente.
    db.run('UPDATE acuerdos SET deleted_at=?, updated_at=? WHERE cliente_id=? AND deleted_at IS NULL', [ts, ts, id]);
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }

  await persistirEnIndexedDB();
}

// ============================================================
// Acuerdos
// ============================================================

/**
 * @param {{cliente_id:string, monto_cuota_centavos:number, vigente_desde:string, frecuencia?:string, dia_semana?:number, dia_mes?:number}} datos
 * @returns {Promise<object>}
 */
export async function crearAcuerdo({ cliente_id, monto_cuota_centavos, vigente_desde, frecuencia, dia_semana, dia_mes }) {
  verificarEscritura();

  const cliente = unaFila('SELECT * FROM clientes WHERE id = ? AND deleted_at IS NULL', [cliente_id]);
  if (!cliente) throw crearError('NOT_FOUND', 'Cliente no encontrado.', { cliente_id });

  if (!Number.isInteger(monto_cuota_centavos) || monto_cuota_centavos <= 0) {
    throw crearError('VALIDATION_ERROR', 'La cuota diaria debe ser un monto entero positivo, en centavos.', { campo: 'monto_cuota_centavos' });
  }
  if (!esFechaIsoValida(vigente_desde)) {
    throw crearError('VALIDATION_ERROR', 'La fecha de vigencia no es una fecha válida.', { campo: 'vigente_desde' });
  }
  if (esFutura(vigente_desde)) {
    throw crearError('VALIDATION_ERROR', 'La fecha de vigencia no puede ser futura.', { campo: 'vigente_desde' });
  }
  const frecuenciaNormalizada = validarFrecuencia({ frecuencia, dia_semana, dia_mes });

  const abierto = unaFila(
    `SELECT * FROM acuerdos WHERE cliente_id = ? AND deleted_at IS NULL AND vigente_hasta IS NULL ORDER BY vigente_desde DESC, created_at DESC LIMIT 1`,
    [cliente_id]
  );

  // R-004: rechazar ANTES de tocar la DB si la nueva vigencia es anterior al acuerdo abierto.
  if (abierto && vigente_desde < abierto.vigente_desde) {
    throw crearError('VALIDATION_ERROR', 'La nueva vigencia no puede ser anterior al acuerdo actual.', { campo: 'vigente_desde' });
  }

  const idAcuerdo = uuidV7();
  const ts = ahoraIso();

  ejecutarSQL('BEGIN;');
  try {
    if (abierto) {
      if (vigente_desde === abierto.vigente_desde) {
        // Regla mismo-día (R-004): el acuerdo abierto no gobernó un día completo,
        // es una corrección, no una renegociación: se marca deleted_at y el nuevo lo sustituye.
        db.run('UPDATE acuerdos SET deleted_at=?, updated_at=? WHERE id=?', [ts, ts, abierto.id]);
      } else {
        const vigenteHastaCierre = sumarDias(vigente_desde, -1);
        db.run('UPDATE acuerdos SET vigente_hasta=?, updated_at=? WHERE id=?', [vigenteHastaCierre, ts, abierto.id]);
      }
    }
    db.run(
      `INSERT INTO acuerdos (id, cliente_id, monto_cuota_centavos, frecuencia, dia_semana, dia_mes, vigente_desde, vigente_hasta, created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,?,?,NULL,?,?,NULL)`,
      [
        idAcuerdo,
        cliente_id,
        monto_cuota_centavos,
        frecuenciaNormalizada.frecuencia,
        frecuenciaNormalizada.dia_semana,
        frecuenciaNormalizada.dia_mes,
        vigente_desde,
        ts,
        ts,
      ]
    );
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }

  await persistirEnIndexedDB();
  return unaFila('SELECT * FROM acuerdos WHERE id = ?', [idAcuerdo]);
}

/**
 * @param {string} cliente_id
 * @returns {Promise<object[]>} ordenado por vigente_desde ascendente, incluye cerrados
 */
export async function listarAcuerdos(cliente_id) {
  return todasLasFilas(
    'SELECT * FROM acuerdos WHERE cliente_id = ? AND deleted_at IS NULL ORDER BY vigente_desde ASC',
    [cliente_id]
  );
}

/**
 * @param {string} cliente_id
 * @param {string} fecha
 * @returns {Promise<object|null>}
 */
export async function obtenerAcuerdoVigente(cliente_id, fecha) {
  return unaFila(
    `SELECT * FROM acuerdos WHERE cliente_id = ? AND deleted_at IS NULL
       AND vigente_desde <= ? AND (vigente_hasta IS NULL OR vigente_hasta >= ?)
     ORDER BY vigente_desde DESC, created_at DESC LIMIT 1`,
    [cliente_id, fecha, fecha]
  );
}

// ============================================================
// Movimientos
// ============================================================

async function verificarClienteActivo(cliente_id) {
  const cliente = unaFila('SELECT * FROM clientes WHERE id = ? AND deleted_at IS NULL', [cliente_id]);
  if (!cliente) throw crearError('NOT_FOUND', 'Cliente no encontrado o inactivo.', { cliente_id });
  return cliente;
}

/**
 * @param {{cliente_id:string, monto_centavos:number, fecha:string, servicio:string, referencia?:string, nota?:string}} datos
 * @returns {Promise<object>}
 */
export async function registrarCargo({ cliente_id, monto_centavos, fecha, servicio, referencia, nota }) {
  verificarEscritura();
  await verificarClienteActivo(cliente_id);

  if (!Number.isInteger(monto_centavos) || monto_centavos <= 0) {
    throw crearError('VALIDATION_ERROR', 'El monto debe ser un entero positivo, en centavos.', { campo: 'monto_centavos' });
  }
  if (!SERVICIOS_VALIDOS.includes(servicio)) {
    throw crearError('VALIDATION_ERROR', `El servicio debe ser uno de: ${SERVICIOS_VALIDOS.join(', ')}.`, { campo: 'servicio' });
  }
  if (!esFechaIsoValida(fecha)) {
    throw crearError('VALIDATION_ERROR', 'La fecha no es una fecha válida.', { campo: 'fecha' });
  }
  if (esFutura(fecha)) {
    throw crearError('VALIDATION_ERROR', 'No se permiten cargos a futuro.', { campo: 'fecha' });
  }

  const id = uuidV7();
  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run(
      `INSERT INTO movimientos (id, cliente_id, tipo, monto_centavos, fecha, servicio, referencia, nota, movimiento_original_id, created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,?,?,?,NULL,?,?,NULL)`,
      [id, cliente_id, 'CARGO', monto_centavos, fecha, servicio, referencia || null, nota || null, ts, ts]
    );
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }

  await persistirEnIndexedDB();
  return unaFila('SELECT * FROM movimientos WHERE id = ?', [id]);
}

/**
 * @param {{cliente_id:string, monto_centavos:number, fecha:string, nota?:string}} datos
 * @returns {Promise<object>}
 */
export async function registrarAbono({ cliente_id, monto_centavos, fecha, nota }) {
  verificarEscritura();
  await verificarClienteActivo(cliente_id);

  if (!Number.isInteger(monto_centavos) || monto_centavos <= 0) {
    throw crearError('VALIDATION_ERROR', 'El monto debe ser un entero positivo, en centavos.', { campo: 'monto_centavos' });
  }
  if (!esFechaIsoValida(fecha)) {
    throw crearError('VALIDATION_ERROR', 'La fecha no es una fecha válida.', { campo: 'fecha' });
  }
  if (esFutura(fecha)) {
    throw crearError('VALIDATION_ERROR', 'No se permiten abonos a futuro.', { campo: 'fecha' });
  }

  const id = uuidV7();
  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run(
      `INSERT INTO movimientos (id, cliente_id, tipo, monto_centavos, fecha, servicio, referencia, nota, movimiento_original_id, created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,NULL,NULL,?,NULL,?,?,NULL)`,
      [id, cliente_id, 'ABONO', monto_centavos, fecha, nota || null, ts, ts]
    );
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }

  await persistirEnIndexedDB();
  return unaFila('SELECT * FROM movimientos WHERE id = ?', [id]);
}

/**
 * Único mecanismo de "editar/borrar" un movimiento existente. Se permiten
 * VARIOS ajustes sobre el mismo movimiento original (R-010).
 * @param {{movimiento_original_id:string, delta_centavos:number, nota?:string}} datos
 * @returns {Promise<object>}
 */
export async function registrarAjuste({ movimiento_original_id, delta_centavos, nota }) {
  verificarEscritura();

  const original = unaFila('SELECT * FROM movimientos WHERE id = ? AND deleted_at IS NULL', [movimiento_original_id]);
  if (!original) throw crearError('NOT_FOUND', 'Movimiento original no encontrado.', { movimiento_original_id });
  if (!['CARGO', 'ABONO'].includes(original.tipo)) {
    throw crearError('VALIDATION_ERROR', 'Solo se pueden ajustar movimientos de tipo CARGO o ABONO (no se ajustan ajustes).', { movimiento_original_id });
  }
  if (!Number.isInteger(delta_centavos) || delta_centavos === 0) {
    throw crearError('VALIDATION_ERROR', 'El monto del ajuste no puede ser cero.', { campo: 'delta_centavos' });
  }

  const id = uuidV7();
  const ts = ahoraIso();
  const fecha = hoy();
  ejecutarSQL('BEGIN;');
  try {
    db.run(
      `INSERT INTO movimientos (id, cliente_id, tipo, monto_centavos, fecha, servicio, referencia, nota, movimiento_original_id, created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,NULL,NULL,?,?,?,?,NULL)`,
      [id, original.cliente_id, 'AJUSTE', delta_centavos, fecha, nota || null, movimiento_original_id, ts, ts]
    );
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }

  await persistirEnIndexedDB();
  return unaFila('SELECT * FROM movimientos WHERE id = ?', [id]);
}

/**
 * @param {{cliente_id:string, desde?:string, hasta?:string, tipo?:string, pagina?:number, tamanioPagina?:number}} opciones
 * @returns {Promise<{movimientos:object[], total:number}>}
 */
export async function listarMovimientos({ cliente_id, desde, hasta, tipo, pagina = 1, tamanioPagina = 20 } = {}) {
  const condiciones = ['cliente_id = ?', 'deleted_at IS NULL'];
  const params = [cliente_id];
  if (desde) {
    condiciones.push('fecha >= ?');
    params.push(desde);
  }
  if (hasta) {
    condiciones.push('fecha <= ?');
    params.push(hasta);
  }
  if (tipo) {
    condiciones.push('tipo = ?');
    params.push(tipo);
  }
  const where = condiciones.join(' AND ');

  const totalFila = unaFila(`SELECT COUNT(*) AS total FROM movimientos WHERE ${where}`, params);
  const total = totalFila ? totalFila.total : 0;

  const offset = Math.max(0, (pagina - 1) * tamanioPagina);
  const movimientos = todasLasFilas(
    `SELECT * FROM movimientos WHERE ${where} ORDER BY fecha DESC, created_at DESC LIMIT ? OFFSET ?`,
    [...params, tamanioPagina, offset]
  );

  return { movimientos, total };
}

/**
 * @param {string} cliente_id
 * @param {string} [hastaFecha] por defecto, hoy
 * @returns {Promise<number>}
 */
export async function calcularSaldo(cliente_id, hastaFecha) {
  return calcularSaldoInterno(cliente_id, hastaFecha || hoy());
}

// ============================================================
// Reportes / pantallas
// ============================================================

/**
 * @param {string} fecha
 * @returns {Promise<{totalEsperadoCentavos:number, totalCobradoCentavos:number, clientes:object[]}>}
 */
export async function resumenDia(fecha) {
  const fechaObjetivo = fecha || hoy();
  const clientesActivos = todasLasFilas('SELECT * FROM clientes WHERE deleted_at IS NULL ORDER BY nombre ASC');

  const clientesResumen = [];
  let totalEsperadoCentavos = 0;
  let totalCobradoCentavos = 0;

  for (const cliente of clientesActivos) {
    const acuerdoVigente = unaFila(
      `SELECT * FROM acuerdos WHERE cliente_id=? AND deleted_at IS NULL
         AND vigente_desde<=? AND (vigente_hasta IS NULL OR vigente_hasta>=?)
       ORDER BY vigente_desde DESC, created_at DESC LIMIT 1`,
      [cliente.id, fechaObjetivo, fechaObjetivo]
    );
    if (!acuerdoVigente) continue; // sin obligación vigente ese día
    if (!esDiaExigible(acuerdoVigente, fechaObjetivo)) continue; // §2.8: vigente pero no exigible hoy (SEMANAL/MENSUAL)

    const cuotaCentavos = acuerdoVigente.monto_cuota_centavos;

    const movimientosDelDia = todasLasFilas(
      `SELECT tipo, monto_centavos, fecha FROM movimientos
       WHERE cliente_id=? AND deleted_at IS NULL AND fecha=? AND tipo IN ('ABONO','AJUSTE')`,
      [cliente.id, fechaObjetivo]
    );
    // R-007: misma fórmula de crédito-por-día que calendar.js.
    const abonadoHoyCentavos = movimientosDelDia.reduce((acc, m) => acc + creditoDeMovimiento(m), 0);

    const acuerdosCliente = todasLasFilas('SELECT * FROM acuerdos WHERE cliente_id=? AND deleted_at IS NULL', [cliente.id]);
    const movimientosHistoricos = todasLasFilas(
      `SELECT tipo, monto_centavos, fecha FROM movimientos
       WHERE cliente_id=? AND deleted_at IS NULL AND tipo IN ('ABONO','AJUSTE') AND fecha < ?`,
      [cliente.id, fechaObjetivo]
    );
    const arrastreInicial = calcularArrastreCumplimiento(acuerdosCliente, movimientosHistoricos, sumarDias(fechaObjetivo, -1));
    const estados = calcularEstadosCalendario(acuerdosCliente, movimientosDelDia, arrastreInicial, fechaObjetivo, fechaObjetivo);
    const estado = estados.get(fechaObjetivo);

    totalEsperadoCentavos += cuotaCentavos;
    totalCobradoCentavos += abonadoHoyCentavos;

    clientesResumen.push({
      cliente_id: cliente.id,
      nombre: cliente.nombre,
      cuotaCentavos,
      abonadoHoyCentavos,
      estado,
    });
  }

  return { totalEsperadoCentavos, totalCobradoCentavos, clientes: clientesResumen };
}

/**
 * @param {string} anioMes 'YYYY-MM'
 * @returns {Promise<{totalCargosCentavos:number, totalAbonosCentavos:number, carteraPendienteCentavos:number, porCliente:object[]}>}
 */
export async function resumenMensual(anioMes) {
  const [anioStr, mesStr] = anioMes.split('-');
  const anio = Number(anioStr);
  const mes = Number(mesStr);
  const primerDia = `${anioStr}-${mesStr}-01`;
  const ultimoDiaNum = new Date(anio, mes, 0).getDate(); // último día del mes (componentes locales)
  const ultimoDia = `${anioStr}-${mesStr}-${pad2(ultimoDiaNum)}`;

  // A-001 (auditoría independiente): los totales del mes son sobre TODOS los
  // movimientos no borrados, sin importar si el cliente sigue activo — un
  // cliente dado de baja no debe desaparecer de los reportes históricos de
  // meses en los que sí tuvo actividad. Se calculan directo sobre
  // `movimientos`, sin pasar por la lista de clientes.
  const totalCargosFila = unaFila(
    `SELECT COALESCE(SUM(monto_centavos),0) AS total FROM movimientos
     WHERE tipo='CARGO' AND deleted_at IS NULL AND fecha BETWEEN ? AND ?`,
    [primerDia, ultimoDia]
  );
  const totalAbonosFila = unaFila(
    `SELECT COALESCE(SUM(monto_centavos),0) AS total FROM movimientos
     WHERE tipo='ABONO' AND deleted_at IS NULL AND fecha BETWEEN ? AND ?`,
    [primerDia, ultimoDia]
  );
  const totalCargosCentavos = totalCargosFila.total;
  const totalAbonosCentavos = totalAbonosFila.total;

  const clientesActivos = todasLasFilas('SELECT * FROM clientes WHERE deleted_at IS NULL ORDER BY nombre ASC');
  const clientesDadosDeBaja = todasLasFilas('SELECT * FROM clientes WHERE deleted_at IS NOT NULL ORDER BY nombre ASC');

  let carteraPendienteCentavos = 0;
  const porCliente = [];

  function agregarFilaCliente(cliente, dadoDeBaja) {
    const cargosFila = unaFila(
      `SELECT COALESCE(SUM(monto_centavos),0) AS total FROM movimientos
       WHERE cliente_id=? AND tipo='CARGO' AND deleted_at IS NULL AND fecha BETWEEN ? AND ?`,
      [cliente.id, primerDia, ultimoDia]
    );
    const abonosFila = unaFila(
      `SELECT COALESCE(SUM(monto_centavos),0) AS total FROM movimientos
       WHERE cliente_id=? AND tipo='ABONO' AND deleted_at IS NULL AND fecha BETWEEN ? AND ?`,
      [cliente.id, primerDia, ultimoDia]
    );
    const cargos = cargosFila.total;
    const abonos = abonosFila.total;
    const saldoFinMes = calcularSaldoInterno(cliente.id, ultimoDia);

    if (saldoFinMes > 0) carteraPendienteCentavos += saldoFinMes;

    porCliente.push({ cliente_id: cliente.id, nombre: cliente.nombre, cargos, abonos, saldoFinMes, dado_de_baja: dadoDeBaja });
  }

  for (const cliente of clientesActivos) {
    agregarFilaCliente(cliente, false);
  }

  // Clientes dados de baja: solo entran al reporte si tuvieron movimientos
  // este mes o si todavía cargan un saldo pendiente distinto de cero (decisión
  // del orquestador) — no se listan de por vida clientes de baja irrelevantes
  // para el mes consultado.
  for (const cliente of clientesDadosDeBaja) {
    const tieneMovimientoEnElMes = unaFila(
      `SELECT 1 AS x FROM movimientos WHERE cliente_id=? AND deleted_at IS NULL AND fecha BETWEEN ? AND ? LIMIT 1`,
      [cliente.id, primerDia, ultimoDia]
    );
    const saldoFinMesPrevio = calcularSaldoInterno(cliente.id, ultimoDia);
    if (tieneMovimientoEnElMes || saldoFinMesPrevio !== 0) {
      agregarFilaCliente(cliente, true);
    }
  }

  return { totalCargosCentavos, totalAbonosCentavos, carteraPendienteCentavos, porCliente };
}

/**
 * @param {string} cliente_id
 * @param {string} fechaDesde
 * @param {string} fechaHasta
 * @returns {Promise<Map<string,string>>}
 */
export async function obtenerEstadoCalendario(cliente_id, fechaDesde, fechaHasta) {
  const acuerdos = todasLasFilas('SELECT * FROM acuerdos WHERE cliente_id=? AND deleted_at IS NULL', [cliente_id]);

  const movimientosHistoricos = todasLasFilas(
    `SELECT tipo, monto_centavos, fecha FROM movimientos
     WHERE cliente_id=? AND deleted_at IS NULL AND tipo IN ('ABONO','AJUSTE') AND fecha < ?`,
    [cliente_id, fechaDesde]
  );
  const arrastreInicial = calcularArrastreCumplimiento(acuerdos, movimientosHistoricos, sumarDias(fechaDesde, -1));

  const movimientos = todasLasFilas(
    `SELECT tipo, monto_centavos, fecha FROM movimientos
     WHERE cliente_id=? AND deleted_at IS NULL AND tipo IN ('ABONO','AJUSTE') AND fecha BETWEEN ? AND ?`,
    [cliente_id, fechaDesde, fechaHasta]
  );
  return calcularEstadosCalendario(acuerdos, movimientos, arrastreInicial, fechaDesde, fechaHasta);
}

/**
 * Calendario en modo GLOBAL (pantalla 6, Fase 12, gate del dueño 25-ago-2026):
 * agregado día por día de "cuántos clientes tenían obligación ese día" vs.
 * "cuántos cumplieron", para toda la cartera activa en un mes.
 *
 * Reutiliza calcularEstadosCalendario de calendar.js por cliente (mismo
 * camino que obtenerEstadoCalendario) — el algoritmo de estados NO se
 * duplica acá, solo se agrega su resultado por día.
 *
 * Rendimiento: una sola tanda de queries por cliente activo (acuerdos +
 * movimientos históricos + movimientos del mes), NO una consulta por día;
 * el barrido día-a-día que sigue es 100% en memoria.
 *
 * "esperados" = clientes con acuerdo vigente ese día. "cumplieron" = de esos,
 * los que están en PAGADO o GRACIA_ADELANTO. Un día sin ningún cliente con
 * obligación queda con esperados=0 (neutro). Los días futuros (fecha > hoy())
 * se excluyen del mapa por completo — no hay clave para esos días.
 *
 * @param {string} anioMes 'YYYY-MM'
 * @returns {Promise<{
 *   dias: Map<string, {esperados:number, cumplieron:number, detalle: Array<{cliente_id:string, nombre:string, estado:string, abonadoCentavos:number, cuotaCentavos:number}>}>,
 *   resumen: {diasCompletos:number, diasConFaltantes:number, totalCobradoCentavos:number}
 * }>}
 */
export async function obtenerCalendarioGlobal(anioMes) {
  const [anioStr, mesStr] = anioMes.split('-');
  const anio = Number(anioStr);
  const mes = Number(mesStr);
  const primerDia = `${anioStr}-${mesStr}-01`;
  const ultimoDiaNum = new Date(anio, mes, 0).getDate(); // último día del mes (componentes locales)
  const ultimoDiaMes = `${anioStr}-${mesStr}-${pad2(ultimoDiaNum)}`;

  const hoyStr = hoy();
  // Días futuros excluidos del mapa por completo (null honesto en la UI).
  const fechaHastaEfectiva = ultimoDiaMes > hoyStr ? hoyStr : ultimoDiaMes;
  const diasDelMesVisibles = rango(primerDia, fechaHastaEfectiva); // [] si TODO el mes es futuro

  const dias = new Map();
  for (const fecha of diasDelMesVisibles) {
    dias.set(fecha, { esperados: 0, cumplieron: 0, detalle: [] });
  }

  if (diasDelMesVisibles.length === 0) {
    return { dias, resumen: { diasCompletos: 0, diasConFaltantes: 0, totalCobradoCentavos: 0 } };
  }

  const clientesActivos = todasLasFilas('SELECT * FROM clientes WHERE deleted_at IS NULL ORDER BY nombre ASC');

  for (const cliente of clientesActivos) {
    const acuerdos = todasLasFilas('SELECT * FROM acuerdos WHERE cliente_id=? AND deleted_at IS NULL', [cliente.id]);
    if (acuerdos.length === 0) continue; // sin ningún acuerdo: nunca tiene obligación

    const movimientosHistoricos = todasLasFilas(
      `SELECT tipo, monto_centavos, fecha FROM movimientos
       WHERE cliente_id=? AND deleted_at IS NULL AND tipo IN ('ABONO','AJUSTE') AND fecha < ?`,
      [cliente.id, primerDia]
    );
    const arrastreInicial = calcularArrastreCumplimiento(acuerdos, movimientosHistoricos, sumarDias(primerDia, -1));

    const movimientosDelMes = todasLasFilas(
      `SELECT tipo, monto_centavos, fecha FROM movimientos
       WHERE cliente_id=? AND deleted_at IS NULL AND tipo IN ('ABONO','AJUSTE') AND fecha BETWEEN ? AND ?`,
      [cliente.id, primerDia, fechaHastaEfectiva]
    );

    const estadosCliente = calcularEstadosCalendario(acuerdos, movimientosDelMes, arrastreInicial, primerDia, fechaHastaEfectiva);

    const creditoPorFecha = new Map();
    for (const m of movimientosDelMes) {
      creditoPorFecha.set(m.fecha, (creditoPorFecha.get(m.fecha) || 0) + creditoDeMovimiento(m));
    }

    for (const fecha of diasDelMesVisibles) {
      const estado = estadosCliente.get(fecha);
      if (estado === Estado.SIN_OBLIGACION) continue; // este cliente no cuenta como "esperado" ese día

      const acuerdoVigente = buscarAcuerdoVigenteEnLista(acuerdos, fecha);
      const cuotaCentavos = acuerdoVigente.monto_cuota_centavos;
      const abonadoCentavos = creditoPorFecha.get(fecha) || 0;

      const diaAgg = dias.get(fecha);
      diaAgg.esperados += 1;
      if (estado === Estado.PAGADO || estado === Estado.GRACIA_ADELANTO) diaAgg.cumplieron += 1;
      diaAgg.detalle.push({ cliente_id: cliente.id, nombre: cliente.nombre, estado, abonadoCentavos, cuotaCentavos });
    }
  }

  let diasCompletos = 0;
  let diasConFaltantes = 0;
  let totalCobradoCentavos = 0;
  for (const agg of dias.values()) {
    if (agg.esperados > 0 && agg.cumplieron === agg.esperados) diasCompletos++;
    if (agg.esperados > 0 && agg.cumplieron < agg.esperados) diasConFaltantes++;
    for (const fila of agg.detalle) totalCobradoCentavos += fila.abonadoCentavos;
  }

  return { dias, resumen: { diasCompletos, diasConFaltantes, totalCobradoCentavos } };
}

// ============================================================
// Utilitario de mensajería
// ============================================================

/**
 * @param {string} cliente_id
 * @returns {Promise<string>}
 */
export async function generarEnlaceWhatsApp(cliente_id) {
  const cliente = unaFila('SELECT * FROM clientes WHERE id = ?', [cliente_id]);
  if (!cliente) throw crearError('NOT_FOUND', 'Cliente no encontrado.', { cliente_id });
  if (!cliente.telefono || !String(cliente.telefono).trim()) {
    throw crearError('VALIDATION_ERROR', 'Este cliente no tiene teléfono registrado.', { cliente_id });
  }

  const saldo = calcularSaldoInterno(cliente_id, hoy());
  const texto = `Hola ${cliente.nombre}, tu saldo pendiente es de ${formatearCentavos(saldo)}. ¡Gracias!`;
  return construirEnlaceWhatsApp(cliente.telefono, texto);
}

// ============================================================
// Exclusivo para dev-verify.js: acceso de solo lectura a la instancia interna.
// ============================================================

/** @returns {any} la instancia interna de sql.js (uso exclusivo de verificación en dev). */
export function _dbInternaParaVerificacion() {
  return db;
}

/**
 * A-002: inspecciona la base de DEMO (NOMBRE_DB_INDEXEDDB_DEMO) de solo
 * lectura, SIN abrirla como la base activa del módulo (no toca `db`/`SQL` en
 * uso), para que dev-verify.js pueda confirmar que ?verify=1 nunca la
 * contamina. Devuelve [] si la demo todavía no existe o no tiene clientes
 * "Verify". Requiere que sql.js ya esté cargado (SQL != null).
 * @returns {Promise<string[]>} nombres de clientes de la demo que contienen "Verify"
 */
export async function _leerClientesVerifyEnDemo() {
  if (!SQL) return [];

  // Verdaderamente de solo lectura: indexedDB.open(nombre) CREA la base si no
  // existe (aunque no se le agregue ningún dato), así que primero se chequea
  // existencia con databases() para no conjurar una "agus-app-almacen" vacía
  // como efecto secundario de simplemente inspeccionarla.
  if (typeof indexedDB.databases === 'function') {
    const existentes = await indexedDB.databases();
    if (!existentes.some((d) => d.name === NOMBRE_DB_INDEXEDDB_DEMO)) return [];
  }

  const idb = await new Promise((resolve, reject) => {
    const req = indexedDB.open(NOMBRE_DB_INDEXEDDB_DEMO, 1);
    req.onupgradeneeded = () => {
      const almacen = req.result;
      if (!almacen.objectStoreNames.contains(NOMBRE_STORE)) almacen.createObjectStore(NOMBRE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!idb.objectStoreNames.contains(NOMBRE_STORE)) {
    idb.close();
    return [];
  }
  const bytes = await new Promise((resolve, reject) => {
    const tx = idb.transaction(NOMBRE_STORE, 'readonly');
    const req = tx.objectStore(NOMBRE_STORE).get(CLAVE_ARCHIVO);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  idb.close();
  if (!bytes) return [];

  const dbDemo = new SQL.Database(bytes);
  try {
    const stmt = dbDemo.prepare("SELECT nombre FROM clientes WHERE nombre LIKE '%Verify%'");
    const nombres = [];
    while (stmt.step()) nombres.push(stmt.getAsObject().nombre);
    stmt.free();
    return nombres;
  } finally {
    dbDemo.close();
  }
}
