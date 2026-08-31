// Capa de acceso a datos (contrato 2.3 del PLAN-MVP.md).
// sql.js es síncrono internamente; se envuelve todo en funciones async para
// aislar la capa y facilitar el reemplazo futuro por un driver nativo de Capacitor.
// Ningún error se traga: todo se relanza con {code, message} vía crearError().

import { DDL, SCHEMA_VERSION, MIGRACION_V1_A_V2, MIGRACION_V2_A_V3, MIGRACION_V3_A_V4 } from './schema.js';
import { generarSeed } from './seed.js';
import { calcularEstadosCalendario, Estado } from './calendar.js';
import { crearError } from './utils/errors.js';
import { uuidV7 } from './utils/uuid.js';
import { hoy, ahoraIso, esFechaIsoValida, esFutura, sumarDias, rango, diaDeSemana, diaDelMes, ultimoDiaDelMes } from './utils/date.js';
import { formatearCentavos } from './utils/money.js';
import { construirEnlaceWhatsApp } from './utils/whatsapp.js';

// §2.9: el enum fijo SERVICIOS_VALIDOS (AGUA/LUZ/INTERNET/GAS/CABLE/OTRO) fue
// RETIRADO — registrarCargo ahora valida `concepto` contra el catálogo vivo
// de la tabla `conceptos` (ver más abajo). FRECUENCIAS_VALIDAS se mantiene
// solo para las funciones LEGACY (crearClienteConAcuerdo/crearAcuerdo,
// @deprecated) que siguen funcionando por compatibilidad histórica.
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

/** Efecto de un movimiento sobre el SALDO (fórmula de 2.2, misma que calcularSaldoInterno). */
function efectoSaldoMovimiento(m) {
  if (m.tipo === 'CARGO') return m.monto_centavos;
  if (m.tipo === 'ABONO') return -m.monto_centavos;
  if (m.tipo === 'AJUSTE') return m.monto_centavos; // ya viene firmado
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

/**
 * URGENTE (bloqueante de producción, 30-ago-2026): true si la base activa
 * sigue en modo demo (`meta.modo_demo = '1'`) — la UI la usa para decidir si
 * mostrar el banner/CTA "Empezar con datos reales" y para saber si el
 * re-sembrado anti-congelamiento (D1) sigue siendo una amenaza latente sobre
 * esta base (SOLO corre si modo_demo='1', ver revisarReSembradoAntiCongelamiento).
 * Si el meta aún no existe (base recién migrada de un esquema muy viejo que
 * nunca lo seteó), se trata como NO-demo — mismo criterio conservador que ya
 * usa revisarReSembradoAntiCongelamiento (`modoDemo !== '1'` → no re-siembra).
 * Requiere initDb() ya resuelto (lee de la base activa, igual que estaSoloLectura()).
 * @returns {boolean}
 */
export function esModoDemo() {
  return obtenerMetaInterno('modo_demo') === '1';
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
    for (const cat of datos.categorias) {
      db.run('INSERT INTO categorias (id, nombre, color, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,NULL)', [
        cat.id,
        cat.nombre,
        cat.color,
        cat.created_at,
        cat.updated_at,
      ]);
    }
    for (const con of datos.conceptos) {
      db.run('INSERT INTO conceptos (id, nombre, created_at, updated_at, deleted_at) VALUES (?,?,?,?,NULL)', [
        con.id,
        con.nombre,
        con.created_at,
        con.updated_at,
      ]);
    }
    for (const c of datos.clientes) {
      db.run(
        `INSERT INTO clientes (id, nombre, telefono, categoria_id, orden, notas, created_at, updated_at, deleted_at)
         VALUES (?,?,?,?,?,?,?,?,NULL)`,
        [c.id, c.nombre, c.telefono ?? null, c.categoria_id ?? null, c.orden ?? null, c.notas ?? null, c.created_at, c.updated_at]
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
    for (const v of datos.visitasSinAbono ?? []) {
      db.run('INSERT INTO visitas_sin_abono (id, cliente_id, fecha, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,NULL)', [
        v.id,
        v.cliente_id,
        v.fecha,
        v.created_at,
        v.updated_at,
      ]);
    }
    setMetaInterno('modo_demo', '1');
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw crearError('DB_ERROR', 'No se pudo insertar el seed de datos de ejemplo.', { original: String(e) });
  }
}

/**
 * §2.9: aplica MIGRACION_V2_A_V3 (DDL: categorias/conceptos nuevas,
 * clientes.categoria_id/orden) + la migración de DATOS que requiere lógica
 * en JS (no entra en un array plano de SQL, a diferencia de v1->v2):
 * sembrar `conceptos` desde los valores distintos ya usados en
 * `movimientos.servicio`, y asignar `orden` inicial a los clientes
 * existentes por fecha de alta (created_at ASC). Comparte una sola
 * implementación entre initDb() e importarRespaldo() — mismo principio de
 * "una sola fuente de verdad" que v1->v2, aunque acá vive en JS y no en el
 * array exportado de schema.js. NO abre su propia transacción: el caller
 * decide el alcance.
 * @param {any} dbObjetivo instancia de sql.js sobre la que migrar
 */
function aplicarMigracionV2AV3(dbObjetivo) {
  for (const sql of MIGRACION_V2_A_V3) dbObjetivo.run(sql);

  const stmtServicios = dbObjetivo.prepare(
    "SELECT DISTINCT servicio FROM movimientos WHERE servicio IS NOT NULL AND trim(servicio) != ''"
  );
  const serviciosDistintos = [];
  while (stmtServicios.step()) serviciosDistintos.push(stmtServicios.getAsObject().servicio);
  stmtServicios.free();

  const tsConceptos = ahoraIso();
  for (const nombreServicio of serviciosDistintos) {
    dbObjetivo.run('INSERT INTO conceptos (id, nombre, created_at, updated_at, deleted_at) VALUES (?,?,?,?,NULL)', [
      uuidV7(),
      nombreServicio,
      tsConceptos,
      tsConceptos,
    ]);
  }

  const stmtClientes = dbObjetivo.prepare('SELECT id FROM clientes ORDER BY created_at ASC');
  const idsClientes = [];
  while (stmtClientes.step()) idsClientes.push(stmtClientes.getAsObject().id);
  stmtClientes.free();
  idsClientes.forEach((id, index) => {
    dbObjetivo.run('UPDATE clientes SET orden = ? WHERE id = ?', [index, id]);
  });
}

/**
 * Si la base local existente quedó en una schema_version vieja, encadena las
 * migraciones necesarias (v1->v2 de §2.8, v2->v3 de §2.9, v3->v4 de §2.11)
 * SIN TOCAR DATOS y actualiza meta a la versión vigente. No-op si ya está al día.
 */
async function migrarEsquemaSiHaceFalta() {
  const versionInicial = obtenerMetaInterno('schema_version');
  if (versionInicial === SCHEMA_VERSION) return;
  if (!['1', '2', '3'].includes(versionInicial)) {
    throw crearError(
      'DB_ERROR',
      `La base local tiene un schema_version desconocido ("${versionInicial}") y no se puede migrar automáticamente.`
    );
  }

  ejecutarSQL('BEGIN;');
  try {
    if (versionInicial === '1') {
      for (const sql of MIGRACION_V1_A_V2) db.run(sql);
    }
    if (versionInicial === '1' || versionInicial === '2') {
      aplicarMigracionV2AV3(db);
    }
    for (const sql of MIGRACION_V3_A_V4) db.run(sql);
    setMetaInterno('schema_version', SCHEMA_VERSION);
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw crearError('DB_ERROR', 'No se pudo migrar el esquema local.', { original: String(e) });
  }
  await persistirInmediato();
  console.info(`[db] Migración de esquema aplicada: v${versionInicial} -> v${SCHEMA_VERSION}. Datos preservados.`);
}

/** Re-sembrado automático anti-congelamiento (mitigación D1), SOLO en modo_demo=1. */

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
 * §2.10: registra la fecha ISO de este export exitoso en meta.ultimo_respaldo
 * (para el recordatorio "tu último respaldo fue hace N días" de la pestaña
 * Global) antes de serializar, así el propio archivo exportado también
 * queda con el registro honesto de que se exportó.
 * @returns {Promise<{blob: Blob, nombreArchivo: string}>}
 */
export async function exportarRespaldo() {
  setMetaInterno('ultimo_respaldo', ahoraIso());
  await persistirEnIndexedDB();

  const bytes = exportarBytesDb();
  const blob = new Blob([bytes], { type: 'application/x-sqlite3' });
  const ahora = new Date();
  const nombreArchivo = `respaldo-${ahora.getFullYear()}${pad2(ahora.getMonth() + 1)}${pad2(ahora.getDate())}-${pad2(ahora.getHours())}${pad2(ahora.getMinutes())}.sqlite`;
  return { blob, nombreArchivo };
}

/**
 * §2.10: fecha ISO 8601 (instante) del último exportarRespaldo() exitoso, o
 * null si nunca se exportó un respaldo desde esta base.
 * @returns {Promise<string|null>}
 */
export async function obtenerUltimoRespaldo() {
  return obtenerMetaInterno('ultimo_respaldo');
}

/**
 * Valida ANTES de reemplazar nada: schema_version soportada (v1..v4; v1/v2/v3
 * se migran en memoria encadenando MIGRACION_V1_A_V2, aplicarMigracionV2AV3 y
 * MIGRACION_V3_A_V4 antes de aceptar — §2.8/§2.9/§2.11) + cero huérfanos.
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
    if (!['1', '2', '3', '4'].includes(filaVersion.valor)) {
      throw new Error(`schema_version "${filaVersion.valor}" no soportada`);
    }
    if (filaVersion.valor !== SCHEMA_VERSION) {
      // Un respaldo v1, v2 o v3 es válido, pero se migra en memoria (mismas
      // sentencias que initDb()) ANTES de correr la validación de huérfanos.
      dbCandidata.run('BEGIN;');
      if (filaVersion.valor === '1') {
        for (const sql of MIGRACION_V1_A_V2) dbCandidata.run(sql);
      }
      if (filaVersion.valor === '1' || filaVersion.valor === '2') {
        aplicarMigracionV2AV3(dbCandidata);
      }
      for (const sql of MIGRACION_V3_A_V4) dbCandidata.run(sql);
      dbCandidata.run("UPDATE meta SET valor = ? WHERE clave = 'schema_version'", [SCHEMA_VERSION]);
      dbCandidata.run('COMMIT;');
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

/**
 * URGENTE (bloqueante de producción, 30-ago-2026): "Empezar con datos
 * reales" — borra TODOS los datos de negocio (clientes, acuerdos,
 * movimientos, categorias, conceptos, visitas_sin_abono) dejando el esquema
 * v4 intacto y vacío, y marca `meta.modo_demo = '0'`. `schema_version` NO se
 * toca. A partir de acá revisarReSembradoAntiCongelamiento() nunca vuelve a
 * disparar sobre esta base (está condicionado a modo_demo='1' — ver arriba),
 * así que el gestor puede dejar de abrir la app por días sin riesgo de que
 * sus datos reales capturados se borren por el re-seed anti-congelamiento.
 *
 * Orden de borrado respeta las FKs manuales (children antes que parents):
 * movimientos/acuerdos/visitas_sin_abono referencian clientes; clientes
 * referencia categorias — mismo principio de "cascada manual, sin ON DELETE
 * CASCADE" que el resto de la capa de datos (STORY.md).
 *
 * Persiste de INMEDIATO (persistirInmediato(), sin el debounce de 500ms de
 * persistirEnIndexedDB()) porque esta operación es irreversible y de una sola
 * vez: no tiene sentido dejar una ventana donde la base activa ya está vacía
 * en memoria pero IndexedDB todavía tiene el snapshot demo viejo.
 * @returns {Promise<void>}
 */
export async function iniciarModoReal() {
  verificarEscritura();

  ejecutarSQL('BEGIN;');
  try {
    db.run('DELETE FROM movimientos;');
    db.run('DELETE FROM acuerdos;');
    db.run('DELETE FROM visitas_sin_abono;');
    db.run('DELETE FROM clientes;');
    db.run('DELETE FROM categorias;');
    db.run('DELETE FROM conceptos;');
    setMetaInterno('modo_demo', '0');
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw crearError('DB_ERROR', 'No se pudo iniciar el modo real.', { original: String(e) });
  }

  await persistirInmediato();
}

// ============================================================
// Categorías (§2.9)
// ============================================================

/**
 * @param {{nombre:string, color:string}} datos
 * @returns {Promise<object>}
 */
export async function crearCategoria({ nombre, color }) {
  verificarEscritura();

  const nombreLimpio = typeof nombre === 'string' ? nombre.trim() : '';
  if (nombreLimpio.length < 1) {
    throw crearError('VALIDATION_ERROR', 'El nombre de la categoría no puede estar vacío.', { campo: 'nombre' });
  }
  const colorLimpio = typeof color === 'string' ? color.trim() : '';
  if (colorLimpio.length < 1) {
    throw crearError('VALIDATION_ERROR', 'El color es obligatorio.', { campo: 'color' });
  }
  // "nombre único-vivo" (2.9): único entre categorías ACTIVAS, no un UNIQUE de
  // SQL — así se puede reusar el nombre de una categoría borrada lógicamente.
  const existente = unaFila('SELECT id FROM categorias WHERE deleted_at IS NULL AND LOWER(nombre) = LOWER(?)', [nombreLimpio]);
  if (existente) {
    throw crearError('CONFLICT', 'Ya existe una categoría activa con ese nombre.', { campo: 'nombre' });
  }

  const id = uuidV7();
  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run('INSERT INTO categorias (id, nombre, color, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,NULL)', [
      id,
      nombreLimpio,
      colorLimpio,
      ts,
      ts,
    ]);
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }
  await persistirEnIndexedDB();
  return unaFila('SELECT * FROM categorias WHERE id = ?', [id]);
}

/**
 * @param {string} id
 * @param {{nombre?:string, color?:string}} cambios
 * @returns {Promise<object>}
 */
export async function actualizarCategoria(id, cambios = {}) {
  verificarEscritura();

  const actual = unaFila('SELECT * FROM categorias WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!actual) throw crearError('NOT_FOUND', 'Categoría no encontrada.', { id });

  let nombreFinal = actual.nombre;
  if (cambios.nombre !== undefined) {
    const nombreLimpio = String(cambios.nombre).trim();
    if (nombreLimpio.length < 1) {
      throw crearError('VALIDATION_ERROR', 'El nombre de la categoría no puede estar vacío.', { campo: 'nombre' });
    }
    const otra = unaFila('SELECT id FROM categorias WHERE deleted_at IS NULL AND LOWER(nombre) = LOWER(?) AND id != ?', [nombreLimpio, id]);
    if (otra) throw crearError('CONFLICT', 'Ya existe otra categoría activa con ese nombre.', { campo: 'nombre' });
    nombreFinal = nombreLimpio;
  }
  const colorFinal = cambios.color !== undefined ? String(cambios.color).trim() : actual.color;
  if (colorFinal.length < 1) {
    throw crearError('VALIDATION_ERROR', 'El color es obligatorio.', { campo: 'color' });
  }

  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run('UPDATE categorias SET nombre=?, color=?, updated_at=? WHERE id=?', [nombreFinal, colorFinal, ts, id]);
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }
  await persistirEnIndexedDB();
  return unaFila('SELECT * FROM categorias WHERE id = ?', [id]);
}

/**
 * Borrado lógico: los clientes de esta categoría quedan en "Sin categoría"
 * (cascada manual, sin ON DELETE CASCADE — mismo patrón que borrarClienteLogico).
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function borrarCategoriaLogica(id) {
  verificarEscritura();

  const actual = unaFila('SELECT * FROM categorias WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!actual) throw crearError('NOT_FOUND', 'Categoría no encontrada.', { id });

  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run('UPDATE categorias SET deleted_at=?, updated_at=? WHERE id=?', [ts, ts, id]);
    db.run('UPDATE clientes SET categoria_id=NULL, updated_at=? WHERE categoria_id=? AND deleted_at IS NULL', [ts, id]);
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }
  await persistirEnIndexedDB();
}

/**
 * @returns {Promise<object[]>} categorías activas, orden alfabético
 */
export async function listarCategorias() {
  return todasLasFilas('SELECT * FROM categorias WHERE deleted_at IS NULL ORDER BY nombre ASC');
}

// ============================================================
// Conceptos (§2.9) — catálogo editable, reemplaza el enum fijo de servicio
// ============================================================

/**
 * Idempotente ("crear al vuelo" no debe fallar si el concepto ya existe):
 * si ya hay un concepto activo con ese nombre (case-insensitive), lo
 * devuelve tal cual en vez de duplicarlo.
 * @param {{nombre:string}} datos
 * @returns {Promise<object>}
 */
export async function crearConcepto({ nombre }) {
  verificarEscritura();

  const nombreLimpio = typeof nombre === 'string' ? nombre.trim() : '';
  if (nombreLimpio.length < 1) {
    throw crearError('VALIDATION_ERROR', 'El nombre del concepto no puede estar vacío.', { campo: 'nombre' });
  }

  const existente = unaFila('SELECT * FROM conceptos WHERE deleted_at IS NULL AND LOWER(nombre) = LOWER(?)', [nombreLimpio]);
  if (existente) return existente;

  const id = uuidV7();
  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run('INSERT INTO conceptos (id, nombre, created_at, updated_at, deleted_at) VALUES (?,?,?,?,NULL)', [id, nombreLimpio, ts, ts]);
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }
  await persistirEnIndexedDB();
  return unaFila('SELECT * FROM conceptos WHERE id = ?', [id]);
}

/**
 * Borrado lógico. NO cascada: movimientos.servicio guarda el nombre como
 * texto plano (sin FK), así que la historia queda intacta — el concepto
 * borrado simplemente deja de ofrecerse como chip para cargos NUEVOS.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function borrarConceptoLogico(id) {
  verificarEscritura();

  const actual = unaFila('SELECT * FROM conceptos WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!actual) throw crearError('NOT_FOUND', 'Concepto no encontrado.', { id });

  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run('UPDATE conceptos SET deleted_at=?, updated_at=? WHERE id=?', [ts, ts, id]);
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }
  await persistirEnIndexedDB();
}

/**
 * @returns {Promise<object[]>} conceptos activos, orden alfabético
 */
export async function listarConceptos() {
  return todasLasFilas('SELECT * FROM conceptos WHERE deleted_at IS NULL ORDER BY nombre ASC');
}

// ============================================================
// Clientes
// ============================================================

/**
 * @deprecated Retirado en v3, ver §2.9/STORY: el sistema de cuotas y
 * frecuencias (§2.8) se retiró de la UI — el alta de cliente ya NO crea
 * acuerdos (usar `crearCliente`). Se mantiene funcional (no se borra) porque
 * la tabla `acuerdos` conserva sus datos históricos append-only y las
 * pruebas LEGACY de dev-verify siguen usando esta función para proteger esa
 * integridad histórica/de migración.
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
 * §2.9: punto de alta VIGENTE de cliente — SIN acuerdo/cuota/frecuencia.
 * `orden` se asigna como MAX(orden) + 1 entre los clientes de su MISMO
 * grupo (misma categoria_id, o "sin categoría" si no se pasa una) — así
 * entra al final de la lista de su grupo, sin alterar el orden de los demás.
 * `nombre` es único-vivo (A-101): CONFLICT si ya existe un cliente ACTIVO
 * con el mismo nombre (case-insensitive, trim) — se puede reusar el nombre
 * de un cliente dado de baja, igual que con categorías (crearCategoria).
 * @param {{nombre:string, telefono?:string, categoria_id?:string, notas?:string}} datos
 * @returns {Promise<object>}
 */
export async function crearCliente({ nombre, telefono, categoria_id, notas }) {
  verificarEscritura();

  const nombreLimpio = typeof nombre === 'string' ? nombre.trim() : '';
  if (nombreLimpio.length < 2) {
    throw crearError('VALIDATION_ERROR', 'El nombre debe tener al menos 2 caracteres.', { campo: 'nombre' });
  }
  // A-101 (auditoría v2): nombre único-vivo, mismo patrón que crearCategoria
  // — único entre clientes ACTIVOS, no un UNIQUE de SQL (permite reusar el
  // nombre de un cliente dado de baja).
  const clienteExistente = unaFila('SELECT id FROM clientes WHERE deleted_at IS NULL AND LOWER(nombre) = LOWER(?)', [nombreLimpio]);
  if (clienteExistente) {
    throw crearError('CONFLICT', `Ya existe un cliente llamado "${nombreLimpio}".`, { campo: 'nombre' });
  }

  let categoriaFinal = null;
  if (categoria_id !== undefined && categoria_id !== null) {
    const categoria = unaFila('SELECT * FROM categorias WHERE id = ? AND deleted_at IS NULL', [categoria_id]);
    if (!categoria) throw crearError('NOT_FOUND', 'Categoría no encontrada.', { categoria_id });
    categoriaFinal = categoria_id;
  }

  const filaOrden =
    categoriaFinal === null
      ? unaFila('SELECT COALESCE(MAX(orden), -1) AS maxOrden FROM clientes WHERE categoria_id IS NULL AND deleted_at IS NULL')
      : unaFila('SELECT COALESCE(MAX(orden), -1) AS maxOrden FROM clientes WHERE categoria_id = ? AND deleted_at IS NULL', [categoriaFinal]);
  const ordenNuevo = (filaOrden ? filaOrden.maxOrden : -1) + 1;

  const id = uuidV7();
  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run(
      `INSERT INTO clientes (id, nombre, telefono, categoria_id, orden, notas, created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,?,?,?,NULL)`,
      [id, nombreLimpio, telefono || null, categoriaFinal, ordenNuevo, notas || null, ts, ts]
    );
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }

  await persistirEnIndexedDB();
  return unaFila('SELECT * FROM clientes WHERE id = ?', [id]);
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
          FROM movimientos m WHERE m.cliente_id = c.id AND m.deleted_at IS NULL), 0) AS saldo_centavos,
        (SELECT a.monto_cuota_centavos FROM acuerdos a
          WHERE a.cliente_id = c.id AND a.deleted_at IS NULL
            AND a.vigente_desde <= ? AND (a.vigente_hasta IS NULL OR a.vigente_hasta >= ?)
          ORDER BY a.vigente_desde DESC, a.created_at DESC LIMIT 1) AS cuota_vigente_centavos,
        EXISTS(SELECT 1 FROM movimientos m2 WHERE m2.cliente_id = c.id AND m2.deleted_at IS NULL) AS tiene_movimientos
     FROM clientes c
     WHERE c.deleted_at IS NULL ${filtroBusqueda}
     ORDER BY c.nombre ASC
     LIMIT ? OFFSET ?`,
    /* §2.12: saldo_centavos ya no se acota a hoyStr (saldo TOTAL, incluye futuro) —
       los dos hoyStr restantes son del acuerdo VIGENTE hoy, algo distinto (R-XXX). */
    [hoyStr, hoyStr, ...paramsBusqueda, tamanioPagina, offset]
  );
  // sql.js/SQLite no tiene tipo boolean nativo: EXISTS(...) vuelve 0/1 entero.
  const clientes = filas.map((c) => ({ ...c, tiene_movimientos: !!c.tiene_movimientos }));

  return { clientes, total };
}

/**
 * §2.9/§2.11, Pantalla 1 (Clientes): lista AGRUPADA por categoría, en el
 * orden manual de cada grupo, con los agregados que necesita la fila de
 * cliente y la fila Σ de cada grupo. Todo en 2 queries (categorías +
 * clientes con subconsultas correlacionadas) — sin N+1; el agrupado y las
 * sumas se hacen en memoria sobre esas 2 queries, no contra la DB.
 *
 * §2.11 — modo POR DÍA: si se pasa `fecha` ('YYYY-MM-DD'), `abonos_mes_centavos`/
 * `cargos_mes_centavos` (mismo nombre de campo, para no romper a Global ni a
 * otros consumidores del modo mensual) pasan a ser del DÍA visto, no del mes,
 * y cada cliente trae además `estado_dia`: 'ABONO' (abonó ese día) |
 * 'CERO' (visita_sin_abono viva ese día, sin abono) | 'SIN_VISITA' (ninguna
 * de las dos). La raíz agrega `resumenDia: {cobradoCentavos, abonaron,
 * dijeronNo, sinVisitar}` sobre la MISMA población devuelta (con busqueda
 * aplicada, si la hay). `saldo_centavos` SIEMPRE es histórico total, en
 * ambos modos. Sin `fecha`: comportamiento mensual idéntico al de antes.
 *
 * El grupo "Sin categoría" siempre va al final, sin importar el orden
 * alfabético de las categorías reales.
 *
 * @param {{anioMes?:string, fecha?:string, busqueda?:string}} opciones anioMes 'YYYY-MM' (default: mes actual, ignorado si se pasa fecha)
 * @returns {Promise<{
 *   grupos: Array<{
 *     categoria_id: string|null,
 *     categoria_nombre: string,
 *     categoria_color: string|null,
 *     clientes: Array<{id:string, nombre:string, telefono:?string, categoria_id:?string, orden:?number, abonos_mes_centavos:number, cargos_mes_centavos:number, saldo_centavos:number, tiene_movimientos:boolean, estado_dia?:string}>,
 *     totales: {abonos_mes_centavos:number, cargos_mes_centavos:number, saldo_centavos:number}
 *   }>,
 *   resumenDia?: {cobradoCentavos:number, abonaron:number, dijeronNo:number, sinVisitar:number}
 * }>}
 */
export async function listarClientesAgrupados({ anioMes, fecha, busqueda = '' } = {}) {
  const hoyStr = hoy();
  const modoDia = !!fecha;

  let fechaInicioPeriodo;
  let fechaFinPeriodo;
  if (modoDia) {
    fechaInicioPeriodo = fecha;
    fechaFinPeriodo = fecha;
  } else {
    const mesObjetivo = anioMes || hoyStr.slice(0, 7);
    const [anioStr, mesStr] = mesObjetivo.split('-');
    fechaInicioPeriodo = `${anioStr}-${mesStr}-01`;
    fechaFinPeriodo = `${anioStr}-${mesStr}-${pad2(new Date(Number(anioStr), Number(mesStr), 0).getDate())}`;
  }

  const textoBusqueda = (busqueda || '').trim();
  const filtroBusqueda = textoBusqueda
    ? `AND (LOWER(c.nombre) LIKE LOWER(?) OR LOWER(COALESCE(c.telefono, '')) LIKE LOWER(?))`
    : '';
  const like = `%${textoBusqueda}%`;
  const paramsBusqueda = textoBusqueda ? [like, like] : [];

  const categorias = todasLasFilas('SELECT * FROM categorias WHERE deleted_at IS NULL ORDER BY nombre ASC');

  const columnasEstadoDia = modoDia
    ? `,
        EXISTS(SELECT 1 FROM movimientos m3 WHERE m3.cliente_id = c.id AND m3.tipo='ABONO' AND m3.deleted_at IS NULL AND m3.fecha = ?) AS tiene_abono_dia,
        EXISTS(SELECT 1 FROM visitas_sin_abono v WHERE v.cliente_id = c.id AND v.deleted_at IS NULL AND v.fecha = ?) AS tiene_visita_cero_dia`
    : '';
  const paramsEstadoDia = modoDia ? [fecha, fecha] : [];

  const filas = todasLasFilas(
    `SELECT c.*,
        COALESCE((SELECT SUM(
            CASE WHEN m.tipo='CARGO' THEN m.monto_centavos
                 WHEN m.tipo='ABONO' THEN -m.monto_centavos
                 WHEN m.tipo='AJUSTE' THEN m.monto_centavos
                 ELSE 0 END)
          FROM movimientos m WHERE m.cliente_id = c.id AND m.deleted_at IS NULL), 0) AS saldo_centavos,
        COALESCE((SELECT SUM(m.monto_centavos) FROM movimientos m
          WHERE m.cliente_id = c.id AND m.tipo='ABONO' AND m.deleted_at IS NULL AND m.fecha BETWEEN ? AND ?), 0) AS abonos_mes_centavos,
        COALESCE((SELECT SUM(m.monto_centavos) FROM movimientos m
          WHERE m.cliente_id = c.id AND m.tipo='CARGO' AND m.deleted_at IS NULL AND m.fecha BETWEEN ? AND ?), 0) AS cargos_mes_centavos,
        EXISTS(SELECT 1 FROM movimientos m2 WHERE m2.cliente_id = c.id AND m2.deleted_at IS NULL) AS tiene_movimientos
        ${columnasEstadoDia}
     FROM clientes c
     WHERE c.deleted_at IS NULL ${filtroBusqueda}
     ORDER BY c.orden ASC`,
    [fechaInicioPeriodo, fechaFinPeriodo, fechaInicioPeriodo, fechaFinPeriodo, ...paramsEstadoDia, ...paramsBusqueda]
  );

  const SIN_CATEGORIA = '__sin_categoria__';
  const balde = new Map();
  balde.set(SIN_CATEGORIA, { categoria_id: null, categoria_nombre: 'Sin categoría', categoria_color: null, clientes: [] });
  for (const cat of categorias) {
    balde.set(cat.id, { categoria_id: cat.id, categoria_nombre: cat.nombre, categoria_color: cat.color, clientes: [] });
  }

  // §2.12: fecha futura → los conteos de "visita" (abonó/dijo-que-no/sin-visitar)
  // no significan nada (nadie "visitó" un día que no pasó) — el semáforo de 3
  // estados se apaga para ese día. Solo lo REGISTRADO (abonos reales, si el
  // gestor ya asentó un adelanto) sigue siendo información real.
  const esFuturo = modoDia && esFutura(fecha);

  let cobradoCentavos = 0;
  let abonaron = 0;
  let dijeronNo = 0;
  let sinVisitar = 0;

  for (const fila of filas) {
    const clienteAgregado = {
      id: fila.id,
      nombre: fila.nombre,
      telefono: fila.telefono,
      categoria_id: fila.categoria_id,
      orden: fila.orden,
      abonos_mes_centavos: fila.abonos_mes_centavos,
      cargos_mes_centavos: fila.cargos_mes_centavos,
      saldo_centavos: fila.saldo_centavos,
      tiene_movimientos: !!fila.tiene_movimientos,
    };

    if (modoDia) {
      if (fila.tiene_abono_dia) {
        // "Registrado" es real incluso a futuro (adelanto ya asentado) — CUENTA siempre.
        clienteAgregado.estado_dia = 'ABONO';
        abonaron += 1;
        cobradoCentavos += fila.abonos_mes_centavos;
      } else if (esFuturo) {
        // Neutro: la UI lo pinta SIN semáforo (no es "sin visitar", es "todavía no llega ese día").
        clienteAgregado.estado_dia = 'FUTURO';
      } else if (fila.tiene_visita_cero_dia) {
        clienteAgregado.estado_dia = 'CERO';
        dijeronNo += 1;
      } else {
        clienteAgregado.estado_dia = 'SIN_VISITA';
        sinVisitar += 1;
      }
    }

    const clave = fila.categoria_id && balde.has(fila.categoria_id) ? fila.categoria_id : SIN_CATEGORIA;
    balde.get(clave).clientes.push(clienteAgregado);
  }

  const grupos = [];
  for (const grupo of balde.values()) {
    if (grupo.clientes.length === 0) continue; // grupo vacío (categoría o "sin categoría"): no ensucia la lista
    const totales = grupo.clientes.reduce(
      (acc, cl) => ({
        abonos_mes_centavos: acc.abonos_mes_centavos + cl.abonos_mes_centavos,
        cargos_mes_centavos: acc.cargos_mes_centavos + cl.cargos_mes_centavos,
        saldo_centavos: acc.saldo_centavos + cl.saldo_centavos,
      }),
      { abonos_mes_centavos: 0, cargos_mes_centavos: 0, saldo_centavos: 0 }
    );
    grupos.push({ ...grupo, totales });
  }

  // "Sin categoría" siempre al final, sin importar el orden alfabético de las categorías reales.
  grupos.sort((a, b) => {
    if (a.categoria_id === null) return 1;
    if (b.categoria_id === null) return -1;
    return a.categoria_nombre < b.categoria_nombre ? -1 : a.categoria_nombre > b.categoria_nombre ? 1 : 0;
  });

  // §2.12: contrato de resumenDia para fecha FUTURA — "null honesto" (STORY.md:
  // sin dato real = null, jamás un conteo inventado) MÁS un flag `esFuturo`
  // explícito para que la UI no tenga que inferir el motivo del null. Se
  // documenta acá como el contrato final: {cobradoCentavos, abonaron: null,
  // dijeronNo: null, sinVisitar: null, esFuturo: true}. Para hoy/pasado, forma
  // idéntica pero con los conteos reales y esFuturo: false (shape ESTABLE en
  // ambos casos, ninguna clave aparece/desaparece según la fecha).
  const resumenDiaFinal = esFuturo
    ? { cobradoCentavos, abonaron: null, dijeronNo: null, sinVisitar: null, esFuturo: true }
    : { cobradoCentavos, abonaron, dijeronNo, sinVisitar, esFuturo: false };

  return modoDia ? { grupos, resumenDia: resumenDiaFinal } : { grupos };
}

/**
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function obtenerCliente(id) {
  return unaFila('SELECT * FROM clientes WHERE id = ?', [id]);
}

/**
 * §2.9: `categoria_id` es opcional — omitido, no toca la categoría actual;
 * `null` explícito manda al cliente a "sin categoría"; un id válido lo mueve
 * de grupo. Al CAMBIAR de grupo, `orden` se recalcula como MAX(orden)+1 del
 * grupo destino (entra al final de su nuevo grupo, igual que un alta nueva).
 * `nombre` (si se pasa) es único-vivo (A-101): CONFLICT si otro cliente
 * ACTIVO ya usa ese nombre (case-insensitive, trim) — excluye al propio
 * cliente, así que no renombrar o solo cambiar casing/espacios no choca.
 * @param {string} id
 * @param {{nombre?:string, telefono?:string, notas?:string, categoria_id?:?string}} cambios
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
    // A-101: único-vivo, excluyendo al propio cliente (renombrar sin cambiar
    // el nombre, o solo cambiar casing/espacios, no debe chocar consigo mismo).
    const otroConMismoNombre = unaFila(
      'SELECT id FROM clientes WHERE deleted_at IS NULL AND LOWER(nombre) = LOWER(?) AND id != ?',
      [nombreLimpio, id]
    );
    if (otroConMismoNombre) {
      throw crearError('CONFLICT', `Ya existe un cliente llamado "${nombreLimpio}".`, { campo: 'nombre' });
    }
    nombre = nombreLimpio;
  }
  const telefono = cambios.telefono !== undefined ? cambios.telefono : actual.telefono;
  const notas = cambios.notas !== undefined ? cambios.notas : actual.notas;

  let categoriaId = actual.categoria_id;
  let orden = actual.orden;
  if (cambios.categoria_id !== undefined && cambios.categoria_id !== actual.categoria_id) {
    if (cambios.categoria_id === null) {
      categoriaId = null;
    } else {
      const categoria = unaFila('SELECT * FROM categorias WHERE id = ? AND deleted_at IS NULL', [cambios.categoria_id]);
      if (!categoria) throw crearError('NOT_FOUND', 'Categoría no encontrada.', { categoria_id: cambios.categoria_id });
      categoriaId = cambios.categoria_id;
    }
    const filaOrden =
      categoriaId === null
        ? unaFila('SELECT COALESCE(MAX(orden), -1) AS maxOrden FROM clientes WHERE categoria_id IS NULL AND deleted_at IS NULL')
        : unaFila('SELECT COALESCE(MAX(orden), -1) AS maxOrden FROM clientes WHERE categoria_id = ? AND deleted_at IS NULL', [categoriaId]);
    orden = (filaOrden ? filaOrden.maxOrden : -1) + 1;
  }

  const ts = ahoraIso();

  ejecutarSQL('BEGIN;');
  try {
    db.run('UPDATE clientes SET nombre=?, telefono=?, notas=?, categoria_id=?, orden=?, updated_at=? WHERE id=?', [
      nombre,
      telefono,
      notas,
      categoriaId,
      orden,
      ts,
      id,
    ]);
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }

  await persistirEnIndexedDB();
  return unaFila('SELECT * FROM clientes WHERE id = ?', [id]);
}

/**
 * §2.9: persiste el orden manual dentro de UN grupo (el gestor arrastra
 * filas dentro de la misma categoría — nunca entre categorías distintas
 * desde esta función). Asigna orden = índice en `idsEnOrden` (0,1,2,...).
 * @param {string[]} idsEnOrden ids de cliente en el nuevo orden deseado
 * @returns {Promise<void>}
 */
export async function actualizarOrdenClientes(idsEnOrden) {
  verificarEscritura();

  if (!Array.isArray(idsEnOrden) || idsEnOrden.length === 0) {
    throw crearError('VALIDATION_ERROR', 'Se requiere una lista de ids de clientes.', { campo: 'idsEnOrden' });
  }
  for (const id of idsEnOrden) {
    const cliente = unaFila('SELECT id FROM clientes WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!cliente) throw crearError('NOT_FOUND', 'Cliente no encontrado.', { id });
  }

  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    idsEnOrden.forEach((id, indice) => {
      db.run('UPDATE clientes SET orden=?, updated_at=? WHERE id=?', [indice, ts, id]);
    });
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }
  await persistirEnIndexedDB();
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

/**
 * §2.10: "↩ Restaurar" de la sección Archivados. NOT_FOUND si el id no
 * existe o si existe pero NO está archivado (deleted_at IS NULL). Único-vivo
 * (A-101): si mientras estuvo archivado otro cliente ACTIVO tomó su nombre,
 * se rechaza con CONFLICT y NO se restaura (no se pisa al que tiene el
 * nombre ahora). Entra al FINAL del orden de su grupo — si su categoría
 * murió mientras estaba archivado, cae en "sin categoría" (mismo criterio
 * que borrarCategoriaLogica aplica a los clientes activos).
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function restaurarCliente(id) {
  verificarEscritura();

  const cliente = unaFila('SELECT * FROM clientes WHERE id = ? AND deleted_at IS NOT NULL', [id]);
  if (!cliente) throw crearError('NOT_FOUND', 'Cliente archivado no encontrado.', { id });

  const conflicto = unaFila('SELECT id FROM clientes WHERE deleted_at IS NULL AND LOWER(nombre) = LOWER(?)', [cliente.nombre]);
  if (conflicto) {
    throw crearError(
      'CONFLICT',
      `No se puede restaurar: ya existe un cliente activo llamado "${cliente.nombre}".`,
      { campo: 'nombre' }
    );
  }

  let categoriaEfectiva = null;
  if (cliente.categoria_id !== null) {
    const categoriaViva = unaFila('SELECT id FROM categorias WHERE id = ? AND deleted_at IS NULL', [cliente.categoria_id]);
    if (categoriaViva) categoriaEfectiva = cliente.categoria_id;
  }

  const filaOrden =
    categoriaEfectiva === null
      ? unaFila('SELECT COALESCE(MAX(orden), -1) AS maxOrden FROM clientes WHERE categoria_id IS NULL AND deleted_at IS NULL')
      : unaFila('SELECT COALESCE(MAX(orden), -1) AS maxOrden FROM clientes WHERE categoria_id = ? AND deleted_at IS NULL', [categoriaEfectiva]);
  const ordenNuevo = (filaOrden ? filaOrden.maxOrden : -1) + 1;

  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run('UPDATE clientes SET deleted_at=NULL, categoria_id=?, orden=?, updated_at=? WHERE id=?', [categoriaEfectiva, ordenNuevo, ts, id]);
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }

  await persistirEnIndexedDB();
  return unaFila('SELECT * FROM clientes WHERE id = ?', [id]);
}

/**
 * §2.10: clientes archivados (deleted_at IS NOT NULL) para la sección
 * colapsable "📦 Archivados" — fuera del buscador/Σ de listarClientesAgrupados
 * (ya excluidos ahí por deleted_at; ver test explícito en dev-verify).
 * `categoria` viene NULL si la categoría del cliente ya no está viva (murió
 * mientras el cliente estaba archivado y la cascada de borrarCategoriaLogica
 * no lo tocó, porque esa cascada solo alcanza a clientes ACTIVOS).
 * @returns {Promise<Array<{id:string, nombre:string, categoria: {id:string,nombre:string,color:string}|null, saldo_centavos:number}>>}
 */
export async function listarClientesArchivados() {
  const filas = todasLasFilas(
    `SELECT c.id, c.nombre, c.categoria_id,
        cat.nombre AS cat_nombre, cat.color AS cat_color,
        COALESCE((SELECT SUM(
            CASE WHEN m.tipo='CARGO' THEN m.monto_centavos
                 WHEN m.tipo='ABONO' THEN -m.monto_centavos
                 WHEN m.tipo='AJUSTE' THEN m.monto_centavos
                 ELSE 0 END)
          FROM movimientos m WHERE m.cliente_id = c.id AND m.deleted_at IS NULL), 0) AS saldo_centavos
     FROM clientes c
     LEFT JOIN categorias cat ON cat.id = c.categoria_id AND cat.deleted_at IS NULL
     WHERE c.deleted_at IS NOT NULL
     ORDER BY c.nombre ASC`
  );

  return filas.map((f) => ({
    id: f.id,
    nombre: f.nombre,
    categoria: f.categoria_id && f.cat_nombre !== null ? { id: f.categoria_id, nombre: f.cat_nombre, color: f.cat_color } : null,
    saldo_centavos: f.saldo_centavos,
  }));
}

// ============================================================
// Acuerdos
// ============================================================

/**
 * @deprecated Retirado en v3, ver §2.9/STORY: el sistema de cuotas y
 * frecuencias (§2.8) se retiró de la UI. Se mantiene funcional (no se borra)
 * porque `acuerdos` conserva su historia append-only y las pruebas LEGACY de
 * dev-verify siguen usando esta función para protegerla.
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
 * @deprecated Retirado en v3, ver §2.9/STORY. Se mantiene funcional por las
 * pruebas LEGACY (protegen la historia de `acuerdos`).
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
 * @deprecated Retirado en v3, ver §2.9/STORY. Se mantiene funcional por las
 * pruebas LEGACY (protegen la historia de `acuerdos`).
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
 * §2.9: `concepto` valida contra el catálogo VIVO de `conceptos` (ya no el
 * enum fijo `SERVICIOS_VALIDOS`, retirado). El texto guardado en
 * `movimientos.servicio` es el nombre CANÓNICO del concepto encontrado en el
 * catálogo (no el texto crudo del caller), para no acumular variantes de
 * casing en el ledger histórico.
 * @param {{cliente_id:string, monto_centavos:number, fecha:string, concepto:string, referencia?:string, nota?:string}} datos
 * @returns {Promise<object>}
 */
export async function registrarCargo({ cliente_id, monto_centavos, fecha, concepto, referencia, nota }) {
  verificarEscritura();
  await verificarClienteActivo(cliente_id);

  if (!Number.isInteger(monto_centavos) || monto_centavos <= 0) {
    throw crearError('VALIDATION_ERROR', 'El monto debe ser un entero positivo, en centavos.', { campo: 'monto_centavos' });
  }
  const conceptoLimpio = typeof concepto === 'string' ? concepto.trim() : '';
  if (conceptoLimpio.length === 0) {
    throw crearError('VALIDATION_ERROR', 'El concepto es obligatorio.', { campo: 'concepto' });
  }
  const conceptoCatalogo = unaFila('SELECT * FROM conceptos WHERE deleted_at IS NULL AND LOWER(nombre) = LOWER(?)', [conceptoLimpio]);
  if (!conceptoCatalogo) {
    throw crearError(
      'VALIDATION_ERROR',
      `"${conceptoLimpio}" no existe en el catálogo de conceptos. Creálo primero con crearConcepto().`,
      { campo: 'concepto' }
    );
  }
  if (!esFechaIsoValida(fecha)) {
    throw crearError('VALIDATION_ERROR', 'La fecha no es una fecha válida.', { campo: 'fecha' });
  }
  // §2.12 (ROUND 5, gate del dueño 30-ago-2026): se desbloquea el futuro para
  // MOVIMIENTOS DE DINERO (adelantos que el cliente paga por anticipado y el
  // gestor asienta en la fecha futura que cubren) — cualquier fecha ISO
  // válida es aceptada, pasada, hoy o futura. Contraste deliberado con
  // registrarVisitaSinAbono, que SIGUE bloqueando futuro (es una marca de
  // ruta del día — "hoy no abonó" no tiene sentido para un día que no pasó).

  const id = uuidV7();
  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run(
      `INSERT INTO movimientos (id, cliente_id, tipo, monto_centavos, fecha, servicio, referencia, nota, movimiento_original_id, created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,?,?,?,NULL,?,?,NULL)`,
      [id, cliente_id, 'CARGO', monto_centavos, fecha, conceptoCatalogo.nombre, referencia || null, nota || null, ts, ts]
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
  // §2.12: ver comentario equivalente en registrarCargo — el futuro se
  // desbloquea acá (adelantos), pero NO en registrarVisitaSinAbono.

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
 * §2.11: borrado lógico de un CARGO/ABONO (el mecanismo AJUSTE queda
 * deprecated en la UI; el ledger sigue append-only, esto es deleted_at, NUNCA
 * DELETE). NO se usa para borrar un AJUSTE directamente — un AJUSTE solo se
 * borra/restaura EN CASCADA junto con su movimiento original.
 *
 * Cascada manual documentada: si el movimiento tiene AJUSTEs vivos vinculados
 * (movimiento_original_id = id), se borran lógicamente CON EL MISMO
 * timestamp que el original — restaurarMovimiento() usa ese match exacto de
 * deleted_at para saber cuáles reactivar junto con él (y no, por ejemplo,
 * un AJUSTE que ya estaba borrado por otra razón en otro momento).
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function borrarMovimientoLogico(id) {
  verificarEscritura();

  const movimiento = unaFila('SELECT * FROM movimientos WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!movimiento) throw crearError('NOT_FOUND', 'Movimiento no encontrado.', { id });
  if (movimiento.tipo === 'AJUSTE') {
    throw crearError(
      'VALIDATION_ERROR',
      'No se puede borrar un AJUSTE directamente; borrá/restaurá el movimiento original.',
      { campo: 'tipo' }
    );
  }

  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run('UPDATE movimientos SET deleted_at=?, updated_at=? WHERE id=?', [ts, ts, id]);
    db.run('UPDATE movimientos SET deleted_at=?, updated_at=? WHERE movimiento_original_id=? AND deleted_at IS NULL', [ts, ts, id]);
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }

  await persistirEnIndexedDB();
}

/**
 * §2.11: para "Deshacer" de borrarMovimientoLogico/corregirMontoMovimiento.
 * NOT_FOUND si el id no existe o no está borrado. Restaura también, en
 * cascada, los AJUSTEs que se borraron JUNTO con él (mismo deleted_at exacto
 * — ver borrarMovimientoLogico), no cualquier AJUSTE vinculado borrado en
 * otro momento por otra razón.
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function restaurarMovimiento(id) {
  verificarEscritura();

  const movimiento = unaFila('SELECT * FROM movimientos WHERE id = ? AND deleted_at IS NOT NULL', [id]);
  if (!movimiento) throw crearError('NOT_FOUND', 'Movimiento borrado no encontrado.', { id });

  const deletedAtOriginal = movimiento.deleted_at;
  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run('UPDATE movimientos SET deleted_at=NULL, updated_at=? WHERE id=?', [ts, id]);
    db.run('UPDATE movimientos SET deleted_at=NULL, updated_at=? WHERE movimiento_original_id=? AND deleted_at=?', [ts, id, deletedAtOriginal]);
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }

  await persistirEnIndexedDB();
  return unaFila('SELECT * FROM movimientos WHERE id = ?', [id]);
}

/**
 * §2.11: "✎ Corregir monto" — reemplaza la regla firme de "nunca UPDATE"
 * por borrado lógico del original + alta de un movimiento nuevo con la
 * MISMA fecha/tipo/concepto/referencia/nota y el monto corregido. El
 * ledger físico sigue append-only y auditable (deleted_at, nunca UPDATE de
 * monto_centavos ni DELETE) — la UI solo muestra el resultado limpio.
 *
 * Si el original tenía AJUSTEs vivos vinculados, se cascada-borran con él
 * (misma regla que borrarMovimientoLogico) — un AJUSTE que corrige un
 * movimiento que ya no existe (fue reemplazado) no tiene sentido dejarlo vivo.
 *
 * No aplica a AJUSTE (su "monto" es un delta firmado, no un monto positivo
 * de negocio) — para eso ya existe registrarAjuste.
 *
 * Deshacer: `corregirMontoMovimiento` devuelve {nuevo, original_id}; para
 * revertir, el caller borra `nuevo.id` (borrarMovimientoLogico) y restaura
 * `original_id` (restaurarMovimiento) — ambos ya reactivan cualquier cascada
 * de AJUSTEs correspondiente.
 * @param {string} id
 * @param {number} nuevoMontoCentavos
 * @returns {Promise<{nuevo:object, original_id:string}>}
 */
export async function corregirMontoMovimiento(id, nuevoMontoCentavos) {
  verificarEscritura();

  const original = unaFila('SELECT * FROM movimientos WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!original) throw crearError('NOT_FOUND', 'Movimiento no encontrado.', { id });
  if (original.tipo === 'AJUSTE') {
    throw crearError('VALIDATION_ERROR', 'No se puede corregir el monto de un AJUSTE directamente.', { campo: 'tipo' });
  }
  if (!Number.isInteger(nuevoMontoCentavos) || nuevoMontoCentavos <= 0) {
    throw crearError('VALIDATION_ERROR', 'El nuevo monto debe ser un entero positivo, en centavos.', { campo: 'nuevoMontoCentavos' });
  }

  const idNuevo = uuidV7();
  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run('UPDATE movimientos SET deleted_at=?, updated_at=? WHERE id=?', [ts, ts, id]);
    db.run('UPDATE movimientos SET deleted_at=?, updated_at=? WHERE movimiento_original_id=? AND deleted_at IS NULL', [ts, ts, id]);
    db.run(
      `INSERT INTO movimientos (id, cliente_id, tipo, monto_centavos, fecha, servicio, referencia, nota, movimiento_original_id, created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,?,?,?,NULL,?,?,NULL)`,
      [idNuevo, original.cliente_id, original.tipo, nuevoMontoCentavos, original.fecha, original.servicio, original.referencia, original.nota, ts, ts]
    );
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }

  await persistirEnIndexedDB();
  return { nuevo: unaFila('SELECT * FROM movimientos WHERE id = ?', [idNuevo]), original_id: id };
}

// ============================================================
// Visitas sin abono (§2.11) — semáforo de 3 estados por cliente-día. NO son
// movimientos de dinero: no tocan saldos ni calendarios de movimientos.
// ============================================================

/**
 * Idempotente: si ya hay una visita viva ese día para ese cliente, devuelve
 * la existente en vez de duplicar. Bloqueada si ese día ya tiene un ABONO
 * vivo (no tiene sentido marcar "dijo que no" si sí abonó).
 * @param {{cliente_id:string, fecha:string}} datos
 * @returns {Promise<object>}
 */
export async function registrarVisitaSinAbono({ cliente_id, fecha }) {
  verificarEscritura();
  await verificarClienteActivo(cliente_id);

  if (!esFechaIsoValida(fecha)) {
    throw crearError('VALIDATION_ERROR', 'La fecha no es una fecha válida.', { campo: 'fecha' });
  }
  if (esFutura(fecha)) {
    throw crearError('VALIDATION_ERROR', 'No se puede registrar una visita a futuro.', { campo: 'fecha' });
  }

  const abonoVivo = unaFila(
    "SELECT id FROM movimientos WHERE cliente_id=? AND tipo='ABONO' AND deleted_at IS NULL AND fecha=?",
    [cliente_id, fecha]
  );
  if (abonoVivo) {
    throw crearError('VALIDATION_ERROR', 'Ya abonó ese día.', { campo: 'fecha' });
  }

  const existente = unaFila('SELECT * FROM visitas_sin_abono WHERE cliente_id=? AND fecha=? AND deleted_at IS NULL', [cliente_id, fecha]);
  if (existente) return existente;

  const id = uuidV7();
  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run('INSERT INTO visitas_sin_abono (id, cliente_id, fecha, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,NULL)', [
      id,
      cliente_id,
      fecha,
      ts,
      ts,
    ]);
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }

  await persistirEnIndexedDB();
  return unaFila('SELECT * FROM visitas_sin_abono WHERE id = ?', [id]);
}

/**
 * Borrado lógico — para "Deshacer" justo después de registrar una visita
 * sin abono por error.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function eliminarVisitaSinAbono(id) {
  verificarEscritura();

  const visita = unaFila('SELECT * FROM visitas_sin_abono WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!visita) throw crearError('NOT_FOUND', 'Visita sin abono no encontrada.', { id });

  const ts = ahoraIso();
  ejecutarSQL('BEGIN;');
  try {
    db.run('UPDATE visitas_sin_abono SET deleted_at=?, updated_at=? WHERE id=?', [ts, ts, id]);
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    throw normalizarError(e);
  }

  await persistirEnIndexedDB();
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

/**
 * §2.9, Pantalla 2 (Persona): datos por día del mes para el calendario de
 * movimientos — saldo acumulado con la fórmula de 2.2 (CARGO +, ABONO -,
 * AJUSTE firmado), en UNA sola pasada (2 queries: saldo inicial + movimientos
 * del mes; el resto es acumulación en memoria, nunca N queries por día).
 *
 * Entrega SOLO los días 1..fin-de-mes (el armado de la grilla completa,
 * semana-a-semana empezando en lunes, con días de meses vecinos de relleno,
 * es responsabilidad de la UI) más el saldo justo antes del día 1, para que
 * la UI pueda derivar cualquier dato de los días de relleno si lo necesita.
 *
 * @param {string} cliente_id
 * @param {string} anioMes 'YYYY-MM'
 * @returns {Promise<{
 *   saldoInicialCentavos: number,
 *   dias: Map<string, {
 *     movimientos: Array<{tipo:string, montoCentavos:number, concepto:?string, referencia:?string}>,
 *     abonosCentavos: number,
 *     cargosCentavos: number,
 *     saldoAcumuladoCentavos: number
 *   }>
 * }>}
 */
export async function obtenerCalendarioMovimientos(cliente_id, anioMes) {
  const [anioStr, mesStr] = anioMes.split('-');
  const anio = Number(anioStr);
  const mes = Number(mesStr);
  const primerDia = `${anioStr}-${mesStr}-01`;
  const ultimoDiaNum = new Date(anio, mes, 0).getDate();
  const ultimoDia = `${anioStr}-${mesStr}-${pad2(ultimoDiaNum)}`;

  const saldoInicialCentavos = calcularSaldoInterno(cliente_id, sumarDias(primerDia, -1));

  const movimientosDelMes = todasLasFilas(
    `SELECT tipo, monto_centavos, fecha, servicio, referencia FROM movimientos
     WHERE cliente_id=? AND deleted_at IS NULL AND fecha BETWEEN ? AND ?
     ORDER BY fecha ASC, created_at ASC`,
    [cliente_id, primerDia, ultimoDia]
  );

  const movimientosPorFecha = new Map();
  for (const m of movimientosDelMes) {
    if (!movimientosPorFecha.has(m.fecha)) movimientosPorFecha.set(m.fecha, []);
    movimientosPorFecha.get(m.fecha).push(m);
  }

  const dias = new Map();
  let saldoAcumulado = saldoInicialCentavos;
  for (const fecha of rango(primerDia, ultimoDia)) {
    const movimientosDelDia = movimientosPorFecha.get(fecha) || [];
    let abonosCentavos = 0;
    let cargosCentavos = 0;
    const movimientos = [];
    for (const m of movimientosDelDia) {
      saldoAcumulado += efectoSaldoMovimiento(m);
      if (m.tipo === 'ABONO') abonosCentavos += m.monto_centavos;
      if (m.tipo === 'CARGO') cargosCentavos += m.monto_centavos;
      movimientos.push({
        tipo: m.tipo,
        montoCentavos: m.monto_centavos,
        concepto: m.tipo === 'CARGO' ? m.servicio : null,
        referencia: m.referencia,
      });
    }
    dias.set(fecha, { movimientos, abonosCentavos, cargosCentavos, saldoAcumuladoCentavos: saldoAcumulado });
  }

  return { saldoInicialCentavos, dias };
}

// ============================================================
// Reportes / pantallas
// ============================================================

/**
 * @deprecated Retirado en v3, ver §2.9/STORY: la pantalla "Hoy" se retiró de
 * la UI (navegación queda en Clientes + Resumen). Se mantiene funcional (no
 * se borra) porque las pruebas LEGACY de dev-verify siguen usando esta
 * función para proteger la integridad histórica del sistema de cuotas.
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
 * §2.10, pestaña Global: calendario de MOVIMIENTOS por fecha (no confundir
 * con el `obtenerCalendarioGlobal` @deprecated, que es de ESTADOS de
 * cumplimiento de cuota — ese es otro concepto retirado en v3).
 *
 * Por día del mes (solo hasta hoy si `anioMes` es el mes en curso — un mes
 * íntegramente futuro da un resultado vacío): abonosCentavos/cargosCentavos
 * son sumas puras por tipo (AJUSTE no suma a ninguno de los dos, igual que
 * resumenMensual/totalCargosCentavos), y `movimientos` trae el detalle
 * completo del día (incluye AJUSTE, con concepto:null) para el popover.
 *
 * INCLUYE movimientos de clientes archivados (misma filosofía A-001: la
 * historia por fecha no se falsea porque alguien se haya archivado después).
 * `totalesMes` reutiliza resumenMensual() (ya corregido por A-001) en vez de
 * duplicar esa lógica.
 *
 * Rendimiento: 1 query para todos los movimientos del rango (con el nombre
 * del cliente ya resuelto vía JOIN) + resumenMensual() internamente hace sus
 * propias queries acotadas — nunca una consulta por día.
 *
 * @param {string} anioMes 'YYYY-MM'
 * @returns {Promise<{
 *   dias: Map<string, {abonosCentavos:number, cargosCentavos:number, movimientos: Array<{cliente_id:string, cliente_nombre:string, tipo:string, concepto:?string, montoCentavos:number, referencia:?string}>}>,
 *   totalesMes: {abonosCentavos:number, cargosCentavos:number, carteraPendienteCentavos:number}
 * }>}
 */
export async function obtenerCalendarioGlobalMovimientos(anioMes) {
  const [anioStr, mesStr] = anioMes.split('-');
  const anio = Number(anioStr);
  const mes = Number(mesStr);
  const primerDia = `${anioStr}-${mesStr}-01`;
  const ultimoDiaMes = `${anioStr}-${mesStr}-${pad2(new Date(anio, mes, 0).getDate())}`;

  // §2.12 (ROUND 5, gate del dueño 30-ago-2026): se desbloquea el futuro para
  // adelantos. Los días pasados/hoy se siguen pre-poblando SIEMPRE (vacíos o
  // no, como antes de §2.12) para que la UI arme esa parte de la grilla sin
  // sorpresas; los días FUTUROS solo entran al mapa si de verdad tienen
  // movimientos (un futuro vacío no aporta nada — la UI arma esa parte de la
  // grilla igual, ahora "tocable" para capturar). La CONSULTA, en cambio,
  // siempre cubre el mes completo (nunca se acota a hoy): antes de §2.12 esto
  // era un no-op porque un movimiento futuro no podía existir; ahora si puede.
  const hoyStr = hoy();
  const fechaHastaBase = ultimoDiaMes > hoyStr ? hoyStr : ultimoDiaMes;
  const diasBase = fechaHastaBase < primerDia ? [] : rango(primerDia, fechaHastaBase);

  const dias = new Map();
  for (const fecha of diasBase) {
    dias.set(fecha, { abonosCentavos: 0, cargosCentavos: 0, movimientos: [] });
  }

  const filas = todasLasFilas(
    `SELECT m.cliente_id, c.nombre AS cliente_nombre, m.tipo, m.monto_centavos, m.fecha, m.servicio, m.referencia
     FROM movimientos m
     JOIN clientes c ON c.id = m.cliente_id
     WHERE m.deleted_at IS NULL AND m.tipo IN ('CARGO','ABONO','AJUSTE') AND m.fecha BETWEEN ? AND ?
     ORDER BY m.fecha ASC, m.created_at ASC`,
    [primerDia, ultimoDiaMes]
  );

  for (const fila of filas) {
    if (!dias.has(fila.fecha)) {
      // Día futuro con movimientos (adelanto): entra al mapa recién acá, on-demand.
      dias.set(fila.fecha, { abonosCentavos: 0, cargosCentavos: 0, movimientos: [] });
    }
    const diaAgg = dias.get(fila.fecha);
    diaAgg.movimientos.push({
      cliente_id: fila.cliente_id,
      cliente_nombre: fila.cliente_nombre,
      tipo: fila.tipo,
      concepto: fila.tipo === 'CARGO' ? fila.servicio : null,
      montoCentavos: fila.monto_centavos,
      referencia: fila.referencia,
    });
    if (fila.tipo === 'ABONO') diaAgg.abonosCentavos += fila.monto_centavos;
    if (fila.tipo === 'CARGO') diaAgg.cargosCentavos += fila.monto_centavos;
  }

  // resumenMensual() nunca acotó su rango a hoy (fecha BETWEEN primerDia AND
  // ultimoDia del mes completo) — ya era future-inclusive antes de §2.12, así
  // que no necesitó cambios para que totalesMes refleje también los adelantos.
  const resumen = await resumenMensual(anioMes);
  const totalesMes = {
    abonosCentavos: resumen.totalAbonosCentavos,
    cargosCentavos: resumen.totalCargosCentavos,
    carteraPendienteCentavos: resumen.carteraPendienteCentavos,
  };

  return { dias, totalesMes };
}

/**
 * @deprecated Retirado en v3, ver §2.9/STORY: el nuevo calendario de la
 * pantalla Persona (`obtenerCalendarioMovimientos`) muestra movimientos y
 * saldo acumulado, no estados de cumplimiento de cuota. Se mantiene
 * funcional (no se borra) por las pruebas LEGACY (protegen la historia).
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
 * @deprecated Retirado en v3, ver §2.9/STORY: la pestaña "Calendario" global
 * se retiró de la UI (navegación queda en Clientes + Resumen). Se mantiene
 * funcional (no se borra) por las pruebas LEGACY (protegen la historia).
 *
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
 * @deprecated Retirado en v3, ver §2.9/STORY: el recordatorio por WhatsApp se
 * retiró de la UI (generaba fricción con los clientes del gestor). Se
 * mantiene funcional (no se borra) por si alguna prueba LEGACY la ejercita.
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
 * URGENTE (30-ago-2026): expone revisarReSembradoAntiCongelamiento() para
 * verificarla directamente. initDb() solo la invoca una vez por carga de
 * página (guardada tras `inicializado=true`), así que no hay forma de
 * ejercitarla de nuevo simulando un "reload" real dentro de la misma corrida
 * de ?verify=1 — este wrapper de solo-test permite probar, sin recargar la
 * página, que con modo_demo='0' el re-seed NUNCA dispara aunque la base esté
 * vacía (el escenario exacto de iniciarModoReal() + una recarga futura).
 * @returns {Promise<void>}
 */
export async function _revisarReSembradoAntiCongelamientoParaVerificacion() {
  return revisarReSembradoAntiCongelamiento();
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
