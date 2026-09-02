// Script de verificación en vivo (?verify=1). Corre en el navegador contra la
// DB real (sql.js + IndexedDB) y reporta PASS/FAIL en consola y en el DOM.
// Filosofía del plan: "lo que no se verificó ejecutando, no está hecho."

import {
  initDb,
  crearClienteConAcuerdo,
  crearCliente,
  actualizarCliente,
  actualizarOrdenClientes,
  registrarCargo,
  registrarAbono,
  registrarAjuste,
  borrarMovimientoLogico,
  restaurarMovimiento,
  corregirMontoMovimiento,
  registrarVisitaSinAbono,
  eliminarVisitaSinAbono,
  listarMovimientos,
  calcularSaldo,
  crearAcuerdo,
  listarAcuerdos,
  obtenerAcuerdoVigente,
  listarClientes,
  listarClientesAgrupados,
  obtenerCalendarioMovimientos,
  crearCategoria,
  actualizarCategoria,
  borrarCategoriaLogica,
  listarCategorias,
  crearConcepto,
  borrarConceptoLogico,
  listarConceptos,
  obtenerEstadoCalendario,
  resumenDia,
  resumenMensual,
  borrarClienteLogico,
  restaurarCliente,
  listarClientesArchivados,
  obtenerCalendarioGlobal,
  obtenerCalendarioGlobalMovimientos,
  exportarRespaldo,
  obtenerUltimoRespaldo,
  importarRespaldo,
  iniciarModoReal,
  esModoDemo,
  _dbInternaParaVerificacion,
  _leerClientesVerifyEnDemo,
  _revisarReSembradoAntiCongelamientoParaVerificacion,
} from './db.js';
import { calcularEstadosCalendario, Estado } from './calendar.js';
import { generarSeed } from './seed.js';
import { SCHEMA_VERSION, MIGRACION_V1_A_V2 } from './schema.js';
import { hoy, sumarDias, rango, diaDeSemana } from './utils/date.js';
import { uuidV7 } from './utils/uuid.js';
import { parsearAPesos, formatearCentavos, formatearCompacto } from './utils/money.js';

function assert(cond, mensaje) {
  if (!cond) throw new Error(mensaje || 'Aserción falló');
}

/** Compara un Map<string,string> de calendar.js contra un objeto {fecha: estadoEsperado}. */
function compararMapaEstados(actual, esperado) {
  for (const [fecha, estadoEsperado] of Object.entries(esperado)) {
    const obtenido = actual.get(fecha);
    assert(obtenido === estadoEsperado, `día ${fecha}: esperado ${estadoEsperado}, obtenido ${obtenido}`);
  }
}

// ============================================================
// Helpers para los tests de migración v1->v2 (2.8): construyen una base
// sql.js "v1" (esquema viejo, sin columnas de frecuencia) totalmente en
// memoria, usando el MISMO runtime de sql.js ya cargado por initDb() (vía el
// constructor de la instancia real, sin necesidad de exportar SQL desde db.js).
// ============================================================

const DDL_V1_LITERAL = `
CREATE TABLE IF NOT EXISTS clientes (
  id            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL CHECK (length(trim(nombre)) >= 2),
  telefono      TEXT,
  notas         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE TABLE IF NOT EXISTS acuerdos (
  id                      TEXT PRIMARY KEY,
  cliente_id              TEXT NOT NULL REFERENCES clientes(id),
  monto_cuota_centavos    INTEGER NOT NULL CHECK (monto_cuota_centavos > 0),
  vigente_desde           TEXT NOT NULL,
  vigente_hasta           TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT,
  CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde)
);
CREATE TABLE IF NOT EXISTS movimientos (
  id                        TEXT PRIMARY KEY,
  cliente_id                TEXT NOT NULL REFERENCES clientes(id),
  tipo                       TEXT NOT NULL CHECK (tipo IN ('CARGO', 'ABONO', 'AJUSTE')),
  monto_centavos             INTEGER NOT NULL,
  fecha                      TEXT NOT NULL,
  servicio                   TEXT,
  referencia                 TEXT,
  nota                       TEXT,
  movimiento_original_id     TEXT REFERENCES movimientos(id),
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  deleted_at                 TEXT,
  CHECK (
    (tipo IN ('CARGO','ABONO') AND monto_centavos > 0 AND movimiento_original_id IS NULL)
    OR
    (tipo = 'AJUSTE' AND monto_centavos != 0 AND movimiento_original_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_movimientos_cliente_fecha ON movimientos (cliente_id, fecha);
CREATE INDEX IF NOT EXISTS idx_movimientos_cliente_tipo  ON movimientos (cliente_id, tipo);
CREATE INDEX IF NOT EXISTS idx_acuerdos_cliente_vigencia ON acuerdos (cliente_id, vigente_desde);
CREATE TABLE IF NOT EXISTS meta (
  clave  TEXT PRIMARY KEY,
  valor  TEXT NOT NULL
);
`;

function crearDbV1VaciaConDatos({ clienteId, acuerdoId, movimientoId, fechaAcuerdo }) {
  const DatabaseCtor = _dbInternaParaVerificacion().constructor;
  const dbV1 = new DatabaseCtor();
  dbV1.run(DDL_V1_LITERAL);
  const ts = '2026-01-01T00:00:00.000Z';
  dbV1.run('INSERT INTO clientes (id,nombre,telefono,notas,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,NULL)', [
    clienteId,
    'Cliente Migracion V1 Verify',
    '5215500000099',
    null,
    ts,
    ts,
  ]);
  dbV1.run(
    'INSERT INTO acuerdos (id,cliente_id,monto_cuota_centavos,vigente_desde,vigente_hasta,created_at,updated_at,deleted_at) VALUES (?,?,?,?,NULL,?,?,NULL)',
    [acuerdoId, clienteId, 7500, fechaAcuerdo, ts, ts]
  );
  dbV1.run(
    `INSERT INTO movimientos (id,cliente_id,tipo,monto_centavos,fecha,servicio,referencia,nota,movimiento_original_id,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?,NULL,NULL,NULL,NULL,?,?,NULL)`,
    [movimientoId, clienteId, 'ABONO', 3000, fechaAcuerdo, ts, ts]
  );
  dbV1.run("INSERT INTO meta (clave, valor) VALUES ('schema_version', '1')");
  return dbV1;
}

// v2: acuerdos ya tiene frecuencia/dia_semana/dia_mes (§2.8), pero clientes
// TODAVÍA no tiene categoria_id/orden y NO existen categorias/conceptos —
// exactamente el punto de partida real para probar la migración v2->v3 (§2.9).
const DDL_V2_LITERAL = `
CREATE TABLE IF NOT EXISTS clientes (
  id            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL CHECK (length(trim(nombre)) >= 2),
  telefono      TEXT,
  notas         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE TABLE IF NOT EXISTS acuerdos (
  id                      TEXT PRIMARY KEY,
  cliente_id              TEXT NOT NULL REFERENCES clientes(id),
  monto_cuota_centavos    INTEGER NOT NULL CHECK (monto_cuota_centavos > 0),
  frecuencia              TEXT NOT NULL DEFAULT 'DIARIA' CHECK (frecuencia IN ('DIARIA','SEMANAL','MENSUAL')),
  dia_semana              INTEGER,
  dia_mes                 INTEGER,
  vigente_desde           TEXT NOT NULL,
  vigente_hasta           TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT,
  CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde)
);
CREATE TABLE IF NOT EXISTS movimientos (
  id                        TEXT PRIMARY KEY,
  cliente_id                TEXT NOT NULL REFERENCES clientes(id),
  tipo                       TEXT NOT NULL CHECK (tipo IN ('CARGO', 'ABONO', 'AJUSTE')),
  monto_centavos             INTEGER NOT NULL,
  fecha                      TEXT NOT NULL,
  servicio                   TEXT,
  referencia                 TEXT,
  nota                       TEXT,
  movimiento_original_id     TEXT REFERENCES movimientos(id),
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  deleted_at                 TEXT,
  CHECK (
    (tipo IN ('CARGO','ABONO') AND monto_centavos > 0 AND movimiento_original_id IS NULL)
    OR
    (tipo = 'AJUSTE' AND monto_centavos != 0 AND movimiento_original_id IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS meta (
  clave  TEXT PRIMARY KEY,
  valor  TEXT NOT NULL
);
`;

/** Cliente con un CARGO cuyo `servicio` es un concepto DISTINTO ("Renta") — no
 * está en el catálogo por defecto del seed, para probar que la migración lo
 * siembra desde la historia real y no desde una lista fija. */
function crearDbV2VaciaConDatos({ clienteId, acuerdoId, movimientoId, fechaAcuerdo }) {
  const DatabaseCtor = _dbInternaParaVerificacion().constructor;
  const dbV2 = new DatabaseCtor();
  dbV2.run(DDL_V2_LITERAL);
  const ts = '2026-02-01T00:00:00.000Z';
  dbV2.run('INSERT INTO clientes (id,nombre,telefono,notas,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,NULL)', [
    clienteId,
    'Cliente Migracion V2 Verify',
    '5215500000098',
    null,
    ts,
    ts,
  ]);
  dbV2.run(
    "INSERT INTO acuerdos (id,cliente_id,monto_cuota_centavos,frecuencia,dia_semana,dia_mes,vigente_desde,vigente_hasta,created_at,updated_at,deleted_at) VALUES (?,?,?,?,NULL,NULL,?,NULL,?,?,NULL)",
    [acuerdoId, clienteId, 9000, 'DIARIA', fechaAcuerdo, ts, ts]
  );
  dbV2.run(
    `INSERT INTO movimientos (id,cliente_id,tipo,monto_centavos,fecha,servicio,referencia,nota,movimiento_original_id,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?,?,NULL)`,
    [movimientoId, clienteId, 'CARGO', 15000, fechaAcuerdo, 'Renta', ts, ts]
  );
  dbV2.run("INSERT INTO meta (clave, valor) VALUES ('schema_version', '2')");
  return dbV2;
}

// v3: forma real de una base recién migrada por MIGRACION_V2_A_V3 — ya tiene
// categorias/conceptos/clientes.categoria_id/orden, pero TODAVÍA no existe
// `visitas_sin_abono` (§2.11/v4). Punto de partida exacto para probar
// MIGRACION_V3_A_V4.
const DDL_V3_LITERAL = `
CREATE TABLE IF NOT EXISTS categorias (
  id            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL CHECK (length(trim(nombre)) >= 1),
  color         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE TABLE IF NOT EXISTS conceptos (
  id            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL CHECK (length(trim(nombre)) >= 1),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE TABLE IF NOT EXISTS clientes (
  id            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL CHECK (length(trim(nombre)) >= 2),
  telefono      TEXT,
  categoria_id  TEXT REFERENCES categorias(id),
  orden         INTEGER,
  notas         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE TABLE IF NOT EXISTS acuerdos (
  id                      TEXT PRIMARY KEY,
  cliente_id              TEXT NOT NULL REFERENCES clientes(id),
  monto_cuota_centavos    INTEGER NOT NULL CHECK (monto_cuota_centavos > 0),
  frecuencia              TEXT NOT NULL DEFAULT 'DIARIA' CHECK (frecuencia IN ('DIARIA','SEMANAL','MENSUAL')),
  dia_semana              INTEGER,
  dia_mes                 INTEGER,
  vigente_desde           TEXT NOT NULL,
  vigente_hasta           TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT,
  CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde)
);
CREATE TABLE IF NOT EXISTS movimientos (
  id                        TEXT PRIMARY KEY,
  cliente_id                TEXT NOT NULL REFERENCES clientes(id),
  tipo                       TEXT NOT NULL CHECK (tipo IN ('CARGO', 'ABONO', 'AJUSTE')),
  monto_centavos             INTEGER NOT NULL,
  fecha                      TEXT NOT NULL,
  servicio                   TEXT,
  referencia                 TEXT,
  nota                       TEXT,
  movimiento_original_id     TEXT REFERENCES movimientos(id),
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  deleted_at                 TEXT,
  CHECK (
    (tipo IN ('CARGO','ABONO') AND monto_centavos > 0 AND movimiento_original_id IS NULL)
    OR
    (tipo = 'AJUSTE' AND monto_centavos != 0 AND movimiento_original_id IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS meta (
  clave  TEXT PRIMARY KEY,
  valor  TEXT NOT NULL
);
`;

/** Cliente v3 con categoría/orden ya asignados + un CARGO — para probar que
 * MIGRACION_V3_A_V4 (solo agrega `visitas_sin_abono`) preserva todo intacto. */
function crearDbV3VaciaConDatos({ clienteId, categoriaId, movimientoId, fecha }) {
  const DatabaseCtor = _dbInternaParaVerificacion().constructor;
  const dbV3 = new DatabaseCtor();
  dbV3.run(DDL_V3_LITERAL);
  const ts = '2026-03-01T00:00:00.000Z';
  dbV3.run('INSERT INTO categorias (id,nombre,color,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,NULL)', [
    categoriaId,
    'CategoriaMigracionV3 Verify',
    'turquesa',
    ts,
    ts,
  ]);
  dbV3.run(
    'INSERT INTO clientes (id,nombre,telefono,categoria_id,orden,notas,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,NULL)',
    [clienteId, 'Cliente Migracion V3 Verify', '5215500000099', categoriaId, 1, null, ts, ts]
  );
  dbV3.run(
    `INSERT INTO movimientos (id,cliente_id,tipo,monto_centavos,fecha,servicio,referencia,nota,movimiento_original_id,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?,?,NULL)`,
    [movimientoId, clienteId, 'CARGO', 8000, fecha, 'Agua', ts, ts]
  );
  dbV3.run("INSERT INTO meta (clave, valor) VALUES ('schema_version', '3')");
  return dbV3;
}

export async function ejecutarVerificacion() {
  await initDb();

  const resultados = [];

  function registrar(nombre, ok, detalle) {
    resultados.push({ nombre, ok, detalle });
    const linea = `[${ok ? 'PASS' : 'FAIL'}] ${nombre}${detalle ? ' — ' + detalle : ''}`;
    if (ok) console.log('%c' + linea, 'color: #1a7f37'); else console.error(linea);
  }

  async function verificar(nombre, fn) {
    try {
      await fn();
      registrar(nombre, true);
    } catch (e) {
      registrar(nombre, false, (e && e.message) || String(e));
    }
  }

  console.group('%cVerificación dev — Agus Soporte (?verify=1)', 'font-weight:bold;font-size:13px');

  // ============================================================
  // Sección 1 — Esquema + PRAGMA foreign_keys
  // ============================================================
  await verificar('Existen las 4 tablas (clientes, acuerdos, movimientos, meta)', async () => {
    const dbInterna = _dbInternaParaVerificacion();
    const filas = dbInterna.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;");
    const nombres = filas.length ? filas[0].values.map((v) => v[0]) : [];
    for (const t of ['clientes', 'acuerdos', 'movimientos', 'meta']) {
      assert(nombres.includes(t), `falta la tabla "${t}" (tablas encontradas: ${nombres.join(', ')})`);
    }
  });

  await verificar('PRAGMA foreign_keys devuelve 1', async () => {
    const dbInterna = _dbInternaParaVerificacion();
    const filas = dbInterna.exec('PRAGMA foreign_keys;');
    const valor = filas.length ? filas[0].values[0][0] : null;
    assert(valor === 1, `PRAGMA foreign_keys devolvió ${valor}, esperado 1`);
  });

  // ============================================================
  // Sección 1b — utils: uuid.js y money.js (R-006/A4)
  // ============================================================
  await verificar('uuidV7() genera formato válido y versión 7', async () => {
    const id = uuidV7();
    assert(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id), `formato inválido: ${id}`);
  });

  await verificar('money.js: parsearAPesos acepta "1234.50", "1,234.50" y "$1,234.50"', async () => {
    assert(parsearAPesos('1234.50') === 123450, 'falló "1234.50"');
    assert(parsearAPesos('1,234.50') === 123450, 'falló "1,234.50"');
    assert(parsearAPesos('$1,234.50') === 123450, 'falló "$1,234.50"');
  });

  await verificar('money.js: parsearAPesos rechaza formatos inválidos con VALIDATION_ERROR', async () => {
    for (const texto of ['abc', '1.234,50', '12,34', '', '1..5', '-100']) {
      let lanzo = false;
      try {
        parsearAPesos(texto);
      } catch (e) {
        lanzo = true;
        assert(e.code === 'VALIDATION_ERROR', `code esperado VALIDATION_ERROR para "${texto}"`);
      }
      assert(lanzo, `debería rechazar "${texto}"`);
    }
  });

  await verificar('money.js: formatearCentavos(123450) es formato es-MX con signo $', async () => {
    const texto = formatearCentavos(123450);
    assert(/^\$1,234\.50$/.test(texto), `formato inesperado: ${texto}`);
  });

  // ============================================================
  // LEGACY (retirado en v2, ver §2.9/STORY) — Sección 2: crearClienteConAcuerdo
  // válido/inválido. El sistema de cuotas/frecuencias ya no se usa desde la
  // UI, pero `crearClienteConAcuerdo` sigue funcional y `acuerdos` conserva
  // su historia append-only — estos tests protegen esa función y alimentan
  // con `clienteLegacyId` a las Secciones 5/6/6b (también LEGACY), que sí
  // necesitan un cliente con acuerdos reales para probar reglas del viejo
  // sistema. Las Secciones 3/4 (registrarCargo/Abono/Ajuste/calcularSaldo)
  // son funciones VIGENTES y se probaron con su propio cliente vía
  // `crearCliente` para no depender de esta cadena legacy.
  // ============================================================
  let clienteLegacyId = null;

  await verificar('LEGACY: crearClienteConAcuerdo con datos válidos crea cliente + acuerdo', async () => {
    const r = await crearClienteConAcuerdo({
      nombre: 'Cliente De Prueba Verify',
      telefono: '5215500000000',
      notas: 'test de verificación',
      monto_cuota_centavos: 1000,
      vigente_desde: hoy(),
    });
    assert(r.cliente && r.cliente.id, 'no devolvió cliente');
    assert(r.acuerdo && r.acuerdo.id, 'no devolvió acuerdo');
    assert(r.acuerdo.monto_cuota_centavos === 1000, 'monto de cuota incorrecto');
    assert(r.acuerdo.vigente_hasta === null, 'el acuerdo nuevo debería quedar abierto (vigente_hasta NULL)');
    clienteLegacyId = r.cliente.id;
  });

  await verificar('crearClienteConAcuerdo con nombre corto lanza VALIDATION_ERROR', async () => {
    let lanzo = false;
    try {
      await crearClienteConAcuerdo({ nombre: 'A', monto_cuota_centavos: 1000, vigente_desde: hoy() });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'VALIDATION_ERROR', `code esperado VALIDATION_ERROR, recibido ${e.code}`);
    }
    assert(lanzo, 'no lanzó error con nombre inválido');
  });

  await verificar('crearClienteConAcuerdo con monto_cuota_centavos <= 0 lanza VALIDATION_ERROR', async () => {
    let lanzo = false;
    try {
      await crearClienteConAcuerdo({ nombre: 'Cliente Cuota Invalida', monto_cuota_centavos: 0, vigente_desde: hoy() });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'VALIDATION_ERROR');
    }
    assert(lanzo, 'no lanzó error con cuota inválida');
  });

  await verificar('crearClienteConAcuerdo con vigente_desde futura lanza VALIDATION_ERROR', async () => {
    let lanzo = false;
    try {
      await crearClienteConAcuerdo({
        nombre: 'Cliente Fecha Futura',
        monto_cuota_centavos: 1000,
        vigente_desde: sumarDias(hoy(), 5),
      });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'VALIDATION_ERROR');
    }
    assert(lanzo, 'no lanzó error con fecha futura');
  });

  // ============================================================
  // Sección 2b — A-005: listarClientes expone tiene_movimientos (sin N+1)
  // ============================================================
  await verificar('A-005: listarClientes trae tiene_movimientos correcto (false sin movimientos, true con)', async () => {
    const cliente = await crearCliente({ nombre: 'Cliente A005 TieneMovimientos Verify' });

    const { clientes: antesDeMovimiento } = await listarClientes({ busqueda: 'Cliente A005 TieneMovimientos Verify' });
    const filaAntes = antesDeMovimiento.find((c) => c.id === cliente.id);
    assert(filaAntes, 'no se encontró el cliente recién creado en listarClientes');
    assert(typeof filaAntes.tiene_movimientos === 'boolean', `tiene_movimientos debe ser boolean, es ${typeof filaAntes.tiene_movimientos}`);
    assert(filaAntes.tiene_movimientos === false, 'un cliente recién creado sin movimientos debería dar tiene_movimientos:false');

    await registrarAbono({ cliente_id: cliente.id, monto_centavos: 500, fecha: hoy() });

    const { clientes: despuesDeMovimiento } = await listarClientes({ busqueda: 'Cliente A005 TieneMovimientos Verify' });
    const filaDespues = despuesDeMovimiento.find((c) => c.id === cliente.id);
    assert(filaDespues.tiene_movimientos === true, 'tras registrar un abono, tiene_movimientos debería ser true');
  });

  // ============================================================
  // Sección 3 — registrarCargo / registrarAbono / registrarAjuste (VIGENTES)
  // Cliente propio vía crearCliente (§2.9, sin acuerdo) — desacoplado de la
  // cadena LEGACY de crearClienteConAcuerdo.
  // ============================================================
  const clienteMovimientos = await crearCliente({ nombre: 'Cliente Movimientos Verify', telefono: '5215500000001' });
  const clienteMovimientosId = clienteMovimientos.id;

  await verificar('registrarCargo válido se guarda con tipo CARGO', async () => {
    const mov = await registrarCargo({
      cliente_id: clienteMovimientosId,
      monto_centavos: 5000,
      fecha: hoy(),
      concepto: 'Agua', // sembrado en el catálogo (§2.9)
      referencia: 'X-1',
      nota: 'test',
    });
    assert(mov.tipo === 'CARGO' && mov.monto_centavos === 5000, 'cargo no se guardó como se esperaba');
    assert(mov.servicio === 'Agua', `el nombre canónico del catálogo debería quedar en movimientos.servicio, es "${mov.servicio}"`);
  });

  await verificar('registrarCargo con concepto fuera del catálogo lanza VALIDATION_ERROR', async () => {
    let lanzo = false;
    try {
      await registrarCargo({ cliente_id: clienteMovimientosId, monto_centavos: 5000, fecha: hoy(), concepto: 'NoExisteEnCatalogo' });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'VALIDATION_ERROR', `code esperado VALIDATION_ERROR, recibido ${e.code}`);
    }
    assert(lanzo, 'debería rechazar un concepto que no está en el catálogo vivo');
  });

  await verificar('registrarCargo con concepto vacío lanza VALIDATION_ERROR', async () => {
    let lanzo = false;
    try {
      await registrarCargo({ cliente_id: clienteMovimientosId, monto_centavos: 5000, fecha: hoy(), concepto: '   ' });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'VALIDATION_ERROR');
    }
    assert(lanzo);
  });

  await verificar('§2.12 (ROUND 5): registrarCargo con fecha futura YA NO lanza — cambio de spec intencional (antes rechazaba, ver Sección 17 para el contrato nuevo completo)', async () => {
    const cargoFuturo = await registrarCargo({ cliente_id: clienteMovimientosId, monto_centavos: 5000, fecha: sumarDias(hoy(), 1), concepto: 'Agua' });
    assert(cargoFuturo.fecha === sumarDias(hoy(), 1), 'debería aceptar y guardar la fecha futura tal cual (adelantos, §2.12)');
  });

  await verificar('registrarCargo con cliente inexistente lanza NOT_FOUND', async () => {
    let lanzo = false;
    try {
      await registrarCargo({ cliente_id: 'no-existe', monto_centavos: 5000, fecha: hoy(), concepto: 'Agua' });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'NOT_FOUND');
    }
    assert(lanzo);
  });

  let abonoTestId = null;
  await verificar('registrarAbono válido se guarda con tipo ABONO', async () => {
    const mov = await registrarAbono({ cliente_id: clienteMovimientosId, monto_centavos: 3000, fecha: hoy(), nota: 'abono test' });
    assert(mov.tipo === 'ABONO' && mov.monto_centavos === 3000, 'abono no se guardó como se esperaba');
    abonoTestId = mov.id;
  });

  await verificar('registrarAbono con monto negativo lanza VALIDATION_ERROR', async () => {
    let lanzo = false;
    try {
      await registrarAbono({ cliente_id: clienteMovimientosId, monto_centavos: -100, fecha: hoy() });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'VALIDATION_ERROR');
    }
    assert(lanzo);
  });

  await verificar('registrarAjuste válido crea AJUSTE vinculado al original', async () => {
    const ajuste = await registrarAjuste({ movimiento_original_id: abonoTestId, delta_centavos: -500, nota: 'corrección' });
    assert(ajuste.tipo === 'AJUSTE', 'tipo incorrecto');
    assert(ajuste.movimiento_original_id === abonoTestId, 'no quedó vinculado al original');
    assert(ajuste.monto_centavos === -500, 'monto de ajuste incorrecto');
  });

  await verificar('registrarAjuste permite un segundo ajuste sobre el mismo original (R-010)', async () => {
    const segundo = await registrarAjuste({ movimiento_original_id: abonoTestId, delta_centavos: 100, nota: 'segunda corrección' });
    assert(segundo.movimiento_original_id === abonoTestId);
  });

  await verificar('registrarAjuste con delta_centavos = 0 lanza VALIDATION_ERROR', async () => {
    let lanzo = false;
    try {
      await registrarAjuste({ movimiento_original_id: abonoTestId, delta_centavos: 0 });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'VALIDATION_ERROR');
    }
    assert(lanzo);
  });

  await verificar('registrarAjuste sobre movimiento inexistente lanza NOT_FOUND', async () => {
    let lanzo = false;
    try {
      await registrarAjuste({ movimiento_original_id: 'no-existe', delta_centavos: 100 });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'NOT_FOUND');
    }
    assert(lanzo);
  });

  // ============================================================
  // Sección 4 — calcularSaldo contra un caso calculado a mano (VIGENTE)
  //   CARGO 5000 - ABONO 3000 + AJUSTE(-500) + AJUSTE(+100) = 5000-3000-500+100 = 1600
  // ============================================================
  await verificar('calcularSaldo coincide con el cálculo manual (1600 centavos)', async () => {
    const saldo = await calcularSaldo(clienteMovimientosId);
    assert(saldo === 1600, `saldo esperado 1600, obtenido ${saldo}`);
  });

  // LEGACY (retirado en v2, ver §2.9/STORY) — Sección 5: regla mismo-día de
  // crearAcuerdo (R-004). Usa clienteLegacyId (Sección 2) porque necesita un
  // acuerdo abierto real del viejo sistema.
  // ============================================================
  await verificar('LEGACY: crearAcuerdo el mismo día reemplaza al abierto (sin violar CHECK)', async () => {
    const hoyStr = hoy();
    const primero = await crearAcuerdo({ cliente_id: clienteLegacyId, monto_cuota_centavos: 2000, vigente_desde: hoyStr });
    const segundo = await crearAcuerdo({ cliente_id: clienteLegacyId, monto_cuota_centavos: 2500, vigente_desde: hoyStr });
    const vigente = await obtenerAcuerdoVigente(clienteLegacyId, hoyStr);
    assert(vigente.id === segundo.id, 'el acuerdo vigente debería ser el segundo (el que reemplaza)');
    assert(vigente.monto_cuota_centavos === 2500, 'la cuota vigente no es la del segundo acuerdo');
    const historial = await listarAcuerdos(clienteLegacyId);
    assert(!historial.some((a) => a.id === primero.id), 'el primer acuerdo mismo-día debería quedar excluido del historial (deleted_at)');
  });

  await verificar('LEGACY: crearAcuerdo con vigente_desde anterior al acuerdo abierto lanza VALIDATION_ERROR', async () => {
    let lanzo = false;
    try {
      await crearAcuerdo({ cliente_id: clienteLegacyId, monto_cuota_centavos: 1000, vigente_desde: sumarDias(hoy(), -100) });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'VALIDATION_ERROR');
    }
    assert(lanzo, 'no lanzó error con vigencia anterior al acuerdo actual');
  });

  // LEGACY (retirado en v2, ver §2.9/STORY) — Sección 6: R-001, un CARGO
  // intermedio NO cambia los estados de calendario, pero SÍ sube
  // calcularSaldo de inmediato. Protege obtenerEstadoCalendario (deprecated
  // pero funcional) contra regresiones.
  // ============================================================
  await verificar('LEGACY: R-001 — CARGO intermedio no afecta calendario pero sí el saldo', async () => {
    const desde = sumarDias(hoy(), -4);
    const { cliente } = await crearClienteConAcuerdo({
      nombre: 'Cliente R001 Verify',
      monto_cuota_centavos: 10000,
      vigente_desde: desde,
    });
    for (const f of [sumarDias(hoy(), -4), sumarDias(hoy(), -3), sumarDias(hoy(), -2), sumarDias(hoy(), -1), hoy()]) {
      await registrarAbono({ cliente_id: cliente.id, monto_centavos: 10000, fecha: f });
    }
    const saldoAntes = await calcularSaldo(cliente.id);
    const estadosAntes = await obtenerEstadoCalendario(cliente.id, desde, hoy());

    await registrarCargo({ cliente_id: cliente.id, monto_centavos: 20000, fecha: sumarDias(hoy(), -1), concepto: 'Luz' });

    const saldoDespues = await calcularSaldo(cliente.id);
    const estadosDespues = await obtenerEstadoCalendario(cliente.id, desde, hoy());

    assert(saldoDespues === saldoAntes + 20000, `el saldo debería subir 20000 de inmediato (antes=${saldoAntes}, después=${saldoDespues})`);
    for (const f of [sumarDias(hoy(), -4), sumarDias(hoy(), -3), sumarDias(hoy(), -2), sumarDias(hoy(), -1), hoy()]) {
      assert(
        estadosAntes.get(f) === estadosDespues.get(f),
        `el estado del día ${f} cambió por un CARGO intermedio (antes=${estadosAntes.get(f)}, después=${estadosDespues.get(f)})`
      );
      assert(estadosDespues.get(f) === 'PAGADO', `día ${f} debería seguir PAGADO, es ${estadosDespues.get(f)}`);
    }
  });

  // LEGACY (retirado en v2, ver §2.9/STORY) — Sección 6b: BUG (Builder B,
  // verificación en vivo) de arrastreInicial en obtenerEstadoCalendario()/
  // resumenDia() — usaba -calcularSaldo(), que es la fórmula de SALDO del
  // ledger (2.2, incluye CARGO), no la de CUMPLIMIENTO DE CUOTA (2.5, solo
  // ABONO/AJUSTE vs. cuotas exigidas). Un cliente con un tramo histórico bien
  // pagado seguido de un tramo de incumplimiento parecía "a favor" en vez de
  // en DEUDA. Corregido en PLAN-MVP.md §2.5 (nota del gate 25-ago-2026). Se
  // mantiene para proteger obtenerEstadoCalendario/resumenDia (deprecated
  // pero funcionales) contra que el bug reaparezca silenciosamente.
  // ============================================================
  await verificar(
    'LEGACY: BUG arrastreInicial — ventana de calendario a mitad de un tramo de incumplimiento debe salir DEUDA (no GRACIA_ADELANTO)',
    async () => {
      const vigenteDesde = sumarDias(hoy(), -30);
      const cuota = 10000;
      const { cliente } = await crearClienteConAcuerdo({
        nombre: 'Cliente Arrastre Historico Verify',
        monto_cuota_centavos: cuota,
        vigente_desde: vigenteDesde,
      });
      // 20 días pagados EXACTOS (hoy-30..hoy-11): el arrastre real vuelve a 0.
      for (const f of rango(vigenteDesde, sumarDias(hoy(), -11))) {
        await registrarAbono({ cliente_id: cliente.id, monto_centavos: cuota, fecha: f });
      }
      // hoy-10..hoy: SIN abonar (tramo de incumplimiento, sin CARGOs). El
      // saldo del ledger en ese tramo sigue siendo muy negativo (a favor, por
      // los 20 abonos históricos) aunque el cliente lleve 10+ días sin pagar
      // la cuota — por eso -calcularSaldo() es la fórmula incorrecta acá.
      const ventanaDesde = sumarDias(hoy(), -5);
      const ventanaHasta = sumarDias(hoy(), -1);
      const estados = await obtenerEstadoCalendario(cliente.id, ventanaDesde, ventanaHasta);
      for (const f of rango(ventanaDesde, ventanaHasta)) {
        assert(
          estados.get(f) === 'DEUDA',
          `día ${f} (ventana a mitad de un tramo de incumplimiento) debería ser DEUDA, es ${estados.get(f)}`
        );
      }
    }
  );

  await verificar('LEGACY: BUG arrastreInicial — Manuel Torres (caso 4 del seed, DEUDA franca) debe estar en DEUDA hoy', async () => {
    const { clientes } = await listarClientes({ busqueda: 'Manuel Torres', tamanioPagina: 5 });
    assert(clientes.length >= 1, 'no se encontró a "Manuel Torres" en la DB sembrada');
    const manuel = clientes[0];
    const estados = await obtenerEstadoCalendario(manuel.id, hoy(), hoy());
    assert(estados.get(hoy()) === 'DEUDA', `Manuel Torres (DEUDA franca) debería estar en DEUDA hoy, está en ${estados.get(hoy())}`);
  });

  await verificar('LEGACY: BUG arrastreInicial — resumenDia(hoy) también debe marcar a Manuel Torres en DEUDA', async () => {
    const resumen = await resumenDia(hoy());
    const filaManuel = resumen.clientes.find((c) => c.nombre === 'Manuel Torres');
    assert(filaManuel, 'Manuel Torres no aparece en resumenDia(hoy) (¿sin acuerdo vigente ese día?)');
    assert(filaManuel.estado === 'DEUDA', `resumenDia: Manuel Torres debería estar en DEUDA, está en ${filaManuel.estado}`);
  });

  // ============================================================
  // Sección 6c — A-001 (auditoría independiente): resumenMensual() filtraba
  // clientes WHERE deleted_at IS NULL, así que borrar lógicamente un cliente
  // lo hacía desaparecer de los reportes históricos de meses en los que sí
  // tuvo actividad — cargos/abonos/cartera pendiente de meses pasados quedaban
  // falseados (subestimados). Decisión del orquestador: los totales del mes
  // incluyen TODOS los movimientos no borrados sin importar el estado del
  // cliente; porCliente incluye también a los clientes dados de baja que
  // tengan movimientos o saldo en ese mes, marcados con dado_de_baja:true.
  // ============================================================
  await verificar(
    'A-001: resumenMensual sigue incluyendo a un cliente dado de baja con movimientos ese mes',
    async () => {
      const mesActual = hoy().slice(0, 7); // 'YYYY-MM'
      const antes = await resumenMensual(mesActual);

      const cliente = await crearCliente({ nombre: 'Cliente A001 Dado De Baja Verify' });
      const montoCargo = 12345;
      await registrarCargo({ cliente_id: cliente.id, monto_centavos: montoCargo, fecha: hoy(), concepto: 'Agua' });

      const saldoAntesDeBorrar = await calcularSaldo(cliente.id);
      assert(saldoAntesDeBorrar === montoCargo, `saldo debería ser ${montoCargo} antes de borrar, es ${saldoAntesDeBorrar}`);

      // saldo != 0 => borrarClienteLogico exige forzar:true (CONFLICT si no)
      await borrarClienteLogico(cliente.id, { forzar: true });

      const despues = await resumenMensual(mesActual);

      assert(
        despues.totalCargosCentavos === antes.totalCargosCentavos + montoCargo,
        `totalCargosCentavos debería subir en ${montoCargo} tras dar de baja al cliente (antes=${antes.totalCargosCentavos}, después=${despues.totalCargosCentavos})`
      );

      const fila = despues.porCliente.find((c) => c.cliente_id === cliente.id);
      assert(fila, 'el cliente dado de baja con movimientos este mes debería seguir apareciendo en porCliente');
      assert(fila.dado_de_baja === true, `fila.dado_de_baja debería ser true, es ${fila.dado_de_baja}`);
      assert(fila.cargos === montoCargo, `fila.cargos debería ser ${montoCargo}, es ${fila.cargos}`);
      assert(fila.saldoFinMes === montoCargo, `fila.saldoFinMes debería ser ${montoCargo}, es ${fila.saldoFinMes}`);

      assert(
        despues.carteraPendienteCentavos >= antes.carteraPendienteCentavos + montoCargo,
        `carteraPendienteCentavos debería reflejar el saldo pendiente del cliente dado de baja (antes=${antes.carteraPendienteCentavos}, después=${despues.carteraPendienteCentavos})`
      );
    }
  );

  await verificar('A-001: clientes activos sin dar de baja llevan dado_de_baja:false en porCliente', async () => {
    const mesActual = hoy().slice(0, 7);
    const resumen = await resumenMensual(mesActual);
    const { clientes } = await listarClientes({ tamanioPagina: 1 });
    assert(clientes.length >= 1, 'no hay clientes activos para verificar dado_de_baja:false');
    const filaActivo = resumen.porCliente.find((c) => c.cliente_id === clientes[0].id);
    assert(filaActivo, `el cliente activo ${clientes[0].nombre} debería aparecer en porCliente de este mes`);
    assert(filaActivo.dado_de_baja === false, `dado_de_baja debería ser false para un cliente activo, es ${filaActivo.dado_de_baja}`);
  });

  // ============================================================
  // Sección 7 — R-005: hoy() usa componentes de fecha LOCAL, no UTC
  // ============================================================
  await verificar('R-005: hoy() coincide con los componentes de fecha local del dispositivo', async () => {
    const ahora = new Date();
    const esperado = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`;
    assert(hoy() === esperado, `hoy() devolvió ${hoy()}, esperado (fecha local) ${esperado}`);
  });

  // ============================================================
  // Sección 8 — seed completo: los 9 casos obligatorios de 2.6 están presentes
  // ============================================================
  await verificar('generarSeed() produce los 9 casos obligatorios de 2.6', async () => {
    const datos = generarSeed();
    assert(datos.clientes.length >= 10 && datos.clientes.length <= 12, `cantidad de clientes fuera de 10-12: ${datos.clientes.length}`);

    const [c1, c2, c3, c4, c5, c6, c7, c8] = datos.clientes;
    const movDe = (clienteId) => datos.movimientos.filter((m) => m.cliente_id === clienteId);
    const acuDe = (clienteId) => datos.acuerdos.filter((a) => a.cliente_id === clienteId);

    // Caso 1: siempre PAGADO -> todos los ABONO igualan la cuota vigente.
    const acuerdo1 = acuDe(c1.id)[0];
    assert(movDe(c1.id).every((m) => m.tipo === 'ABONO' && m.monto_centavos === acuerdo1.monto_cuota_centavos), 'caso 1 (siempre PAGADO) no cumple');

    // Caso 2: GRACIA-ADELANTO -> un único abono grande (multiplo de la cuota), sin abonos posteriores.
    const acuerdo2 = acuDe(c2.id)[0];
    const movs2 = movDe(c2.id);
    assert(movs2.length === 1 && movs2[0].monto_centavos > acuerdo2.monto_cuota_centavos, 'caso 2 (GRACIA-ADELANTO) no cumple');

    // Caso 3: PARCIAL recurrente -> todos los abonos son menores que la cuota.
    const acuerdo3 = acuDe(c3.id)[0];
    assert(movDe(c3.id).every((m) => m.monto_centavos < acuerdo3.monto_cuota_centavos && m.monto_centavos > 0), 'caso 3 (PARCIAL) no cumple');

    // Caso 4: DEUDA franca -> sin movimientos en los últimos 10 días.
    const fechasMov4 = movDe(c4.id).map((m) => m.fecha).sort();
    const ultimaFecha4 = fechasMov4[fechasMov4.length - 1];
    assert(ultimaFecha4 < sumarDias(hoy(), -10), `caso 4 (DEUDA franca) debería no tener abonos recientes, última=${ultimaFecha4}`);

    // Caso 5: nuevo a mitad del rango -> vigente_desde reciente (dentro de los últimos 15 días).
    const acuerdo5 = acuDe(c5.id)[0];
    assert(acuerdo5.vigente_desde >= sumarDias(hoy(), -15), 'caso 5 (cliente nuevo) no tiene vigente_desde reciente');

    // Caso 6: cambio de cuota -> 2 acuerdos consecutivos sin solape ni hueco.
    const acuerdos6 = acuDe(c6.id).sort((a, b) => (a.vigente_desde < b.vigente_desde ? -1 : 1));
    assert(acuerdos6.length === 2, 'caso 6 (cambio de cuota) no tiene 2 acuerdos');
    assert(acuerdos6[0].monto_cuota_centavos !== acuerdos6[1].monto_cuota_centavos, 'caso 6: las cuotas deberían ser distintas');
    assert(acuerdos6[0].vigente_hasta === sumarDias(acuerdos6[1].vigente_desde, -1), 'caso 6: los acuerdos deberían empalmar sin hueco ni solape');

    // Caso 7: al menos un AJUSTE.
    assert(movDe(c7.id).some((m) => m.tipo === 'AJUSTE' && m.movimiento_original_id), 'caso 7 (AJUSTE) no está presente');

    // Caso 8: sin teléfono.
    assert(!c8.telefono, 'caso 8 (sin teléfono) no cumple');
  });

  await verificar('la DB sembrada contiene al menos 8 clientes activos (persistencia real)', async () => {
    const { total } = await listarClientes({ tamanioPagina: 50 });
    assert(total >= 8, `total de clientes activos ${total}, esperado >= 8`);
  });

  await verificar('§2.9: generarSeed() siembra 3-4 categorías, catálogo de 4 conceptos y orden manual variado', async () => {
    const datos = generarSeed();
    assert(datos.categorias.length >= 3 && datos.categorias.length <= 4, `categorías fuera de 3-4: ${datos.categorias.length}`);
    for (const cat of datos.categorias) {
      assert(typeof cat.color === 'string' && cat.color.length > 0, `categoría "${cat.nombre}" sin color`);
    }
    const nombresConceptos = datos.conceptos.map((c) => c.nombre);
    for (const esperado of ['Luz', 'Agua', 'Internet', 'Préstamo']) {
      assert(nombresConceptos.includes(esperado), `falta el concepto "${esperado}" en el catálogo del seed`);
    }
    assert(datos.clientes.some((c) => c.categoria_id === null), 'debería haber al menos un cliente SIN categoría en el seed');
    const conCategoria = datos.clientes.filter((c) => c.categoria_id !== null);
    assert(conCategoria.every((c) => Number.isInteger(c.orden)), 'todo cliente con categoría debería tener un orden entero asignado');
    // orden NO debería ser simplemente alfabético dentro de un grupo (prueba de que es "manual").
    const porCategoria = new Map();
    for (const c of conCategoria) {
      if (!porCategoria.has(c.categoria_id)) porCategoria.set(c.categoria_id, []);
      porCategoria.get(c.categoria_id).push(c);
    }
    let algunGrupoNoAlfabetico = false;
    for (const miembros of porCategoria.values()) {
      if (miembros.length < 2) continue;
      const ordenPorOrden = [...miembros].sort((a, b) => a.orden - b.orden).map((c) => c.nombre);
      const ordenAlfabetico = [...miembros].map((c) => c.nombre).sort();
      if (JSON.stringify(ordenPorOrden) !== JSON.stringify(ordenAlfabetico)) algunGrupoNoAlfabetico = true;
    }
    assert(algunGrupoNoAlfabetico, 'el orden manual del seed no debería coincidir siempre con el orden alfabético (para probar que es genuinamente manual)');
  });

  // ============================================================
  // Sección 13 — §2.9 (REDISEÑO V2 "SENCILLO", gate del dueño 28-ago-2026):
  // categorías, conceptos, alta de cliente sin acuerdo, orden manual, y los
  // dos agregados nuevos (listarClientesAgrupados, obtenerCalendarioMovimientos).
  // ============================================================

  // --- Categorías CRUD ---
  let categoriaVerifyId = null;
  await verificar('crearCategoria válida crea la categoría; nombre duplicado (activo) da CONFLICT', async () => {
    const cat = await crearCategoria({ nombre: 'CategoriaPruebaAgrupado Verify', color: 'turquesa' });
    assert(cat.id && cat.nombre === 'CategoriaPruebaAgrupado Verify' && cat.color === 'turquesa', 'categoría no se creó como se esperaba');
    categoriaVerifyId = cat.id;

    let lanzo = false;
    try {
      await crearCategoria({ nombre: 'categoriapruebaagrupado verify', color: 'rojo' }); // mismo nombre, otro casing
    } catch (e) {
      lanzo = true;
      assert(e.code === 'CONFLICT', `code esperado CONFLICT, recibido ${e.code}`);
    }
    assert(lanzo, 'debería rechazar un nombre de categoría duplicado (case-insensitive) entre activas');
  });

  await verificar('actualizarCategoria cambia nombre/color; borrarCategoriaLogica deja a sus clientes sin categoría', async () => {
    const catTemp = await crearCategoria({ nombre: 'CategoriaTemporal Verify', color: 'rosa' });
    const clienteEnCat = await crearCliente({ nombre: 'Cliente CategoriaTemporal Verify', categoria_id: catTemp.id });
    assert(clienteEnCat.categoria_id === catTemp.id, 'el cliente debería quedar en la categoría temporal');

    const actualizada = await actualizarCategoria(catTemp.id, { color: 'morado' });
    assert(actualizada.color === 'morado' && actualizada.nombre === 'CategoriaTemporal Verify', 'actualizarCategoria no aplicó el cambio de color');

    await borrarCategoriaLogica(catTemp.id);
    const categoriasActivas = await listarCategorias();
    assert(!categoriasActivas.some((c) => c.id === catTemp.id), 'la categoría borrada no debería listarse como activa');

    const clienteTrasBorrado = (await listarClientes({ busqueda: 'Cliente CategoriaTemporal Verify' })).clientes[0];
    assert(clienteTrasBorrado.categoria_id === null, 'el cliente debería quedar "sin categoría" tras borrar su categoría (cascada manual)');
  });

  // --- Conceptos: idempotente + borrado lógico ---
  await verificar('crearConcepto es idempotente (mismo nombre case-insensitive devuelve el existente)', async () => {
    const c1 = await crearConcepto({ nombre: 'ConceptoIdempotente Verify' });
    const c2 = await crearConcepto({ nombre: 'conceptoidempotente verify' });
    assert(c1.id === c2.id, 'crear con el mismo nombre (otro casing) debería devolver el concepto existente, no duplicarlo');
  });

  await verificar('borrarConceptoLogico saca el concepto de listarConceptos sin tocar movimientos históricos', async () => {
    const concepto = await crearConcepto({ nombre: 'ConceptoABorrar Verify' });
    const clienteConCargo = await crearCliente({ nombre: 'Cliente ConceptoABorrar Verify' });
    const cargo = await registrarCargo({ cliente_id: clienteConCargo.id, monto_centavos: 1000, fecha: hoy(), concepto: 'ConceptoABorrar Verify' });

    await borrarConceptoLogico(concepto.id);
    const conceptosActivos = await listarConceptos();
    assert(!conceptosActivos.some((c) => c.id === concepto.id), 'el concepto borrado no debería listarse como activo');

    const { movimientos } = await listarMovimientos({ cliente_id: clienteConCargo.id });
    const cargoHistorico = movimientos.find((m) => m.id === cargo.id);
    assert(cargoHistorico && cargoHistorico.servicio === 'ConceptoABorrar Verify', 'el cargo histórico debería conservar el nombre del concepto como texto');
  });

  // --- crearCliente (sin acuerdo) ---
  await verificar('crearCliente NO crea acuerdo y asigna orden=MAX+1 dentro de su grupo', async () => {
    const c1 = await crearCliente({ nombre: 'Cliente Orden Uno Verify', categoria_id: categoriaVerifyId });
    const c2 = await crearCliente({ nombre: 'Cliente Orden Dos Verify', categoria_id: categoriaVerifyId });
    assert(c2.orden === c1.orden + 1, `c2.orden (${c2.orden}) debería ser c1.orden (${c1.orden}) + 1`);

    const acuerdosC1 = await listarAcuerdos(c1.id);
    assert(acuerdosC1.length === 0, 'crearCliente no debería crear ningún acuerdo');
  });

  await verificar('crearCliente con categoria_id inexistente lanza NOT_FOUND', async () => {
    let lanzo = false;
    try {
      await crearCliente({ nombre: 'Cliente Categoria Inexistente Verify', categoria_id: 'no-existe' });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'NOT_FOUND');
    }
    assert(lanzo);
  });

  // --- A-101 (auditoría v2, ALTA): nombre de cliente único-vivo, mismo patrón que crearCategoria ---
  await verificar('A-101: crearCliente rechaza un nombre duplicado (case-insensitive) con CONFLICT', async () => {
    await crearCliente({ nombre: 'Sofía Ramírez Auditoria Verify' });
    let lanzo = false;
    try {
      await crearCliente({ nombre: 'sofía ramírez auditoria verify' }); // mismo nombre, otro casing/espacios
    } catch (e) {
      lanzo = true;
      assert(e.code === 'CONFLICT', `code esperado CONFLICT, recibido ${e.code}`);
    }
    assert(lanzo, 'debería rechazar un segundo cliente con el mismo nombre (case-insensitive) sin avisar');
  });

  await verificar('A-101: actualizarCliente rechaza renombrar a un nombre ya usado por OTRO cliente (CONFLICT)', async () => {
    const clienteA = await crearCliente({ nombre: 'Cliente A101 Original A Verify' });
    await crearCliente({ nombre: 'Cliente A101 Original B Verify' });
    let lanzo = false;
    try {
      await actualizarCliente(clienteA.id, { nombre: '  cliente a101 original b verify  ' }); // con espacios, otro casing
    } catch (e) {
      lanzo = true;
      assert(e.code === 'CONFLICT', `code esperado CONFLICT, recibido ${e.code}`);
    }
    assert(lanzo, 'debería rechazar renombrar a un nombre que ya usa otro cliente activo');
  });

  await verificar('A-101: SÍ se permite reusar el nombre de un cliente dado de baja', async () => {
    const original = await crearCliente({ nombre: 'Cliente A101 Reusable Verify' });
    await borrarClienteLogico(original.id, { forzar: true });
    let lanzoInesperado = false;
    let nuevo = null;
    try {
      nuevo = await crearCliente({ nombre: 'Cliente A101 Reusable Verify' });
    } catch (e) {
      lanzoInesperado = true;
    }
    assert(!lanzoInesperado, 'no debería rechazar un nombre que solo usa un cliente YA dado de baja');
    assert(nuevo && nuevo.id !== original.id, 'debería crear un cliente nuevo, distinto del dado de baja');
  });

  await verificar('actualizarCliente mueve de categoría y recalcula orden en el grupo destino', async () => {
    const catOrigen = await crearCategoria({ nombre: 'CategoriaOrigen Verify', color: 'verde' });
    const catDestino = await crearCategoria({ nombre: 'CategoriaDestino Verify', color: 'naranja' });
    await crearCliente({ nombre: 'Cliente Destino Previo Verify', categoria_id: catDestino.id }); // ya ocupa orden 0 en destino
    const cliente = await crearCliente({ nombre: 'Cliente A Mover Verify', categoria_id: catOrigen.id });

    const movido = await actualizarCliente(cliente.id, { categoria_id: catDestino.id });
    assert(movido.categoria_id === catDestino.id, 'categoria_id debería quedar en el destino');
    assert(movido.orden === 1, `orden en el grupo destino debería ser 1 (después del cliente previo), es ${movido.orden}`);

    const movidoASinCategoria = await actualizarCliente(cliente.id, { categoria_id: null });
    assert(movidoASinCategoria.categoria_id === null, 'categoria_id explícito null debería mandar a "sin categoría"');
  });

  // --- listarClientesAgrupados: Σ de grupo == suma manual, cruce con resumenMensual,
  //     "sin categoría" cae en su grupo, y el orden manual (actualizarOrdenClientes) se respeta ---
  await verificar(
    'listarClientesAgrupados: Σ de grupo coincide con la suma manual y con resumenMensual por cliente',
    async () => {
      const anioMes = hoy().slice(0, 7);
      const catAgrupado = await crearCategoria({ nombre: 'CategoriaSigma Verify', color: 'azul' });
      const clienteX = await crearCliente({ nombre: 'Cliente Sigma X Verify', categoria_id: catAgrupado.id });
      const clienteY = await crearCliente({ nombre: 'Cliente Sigma Y Verify', categoria_id: catAgrupado.id });

      await registrarCargo({ cliente_id: clienteX.id, monto_centavos: 5000, fecha: hoy(), concepto: 'Agua' });
      await registrarAbono({ cliente_id: clienteX.id, monto_centavos: 3000, fecha: hoy() });
      await registrarCargo({ cliente_id: clienteY.id, monto_centavos: 2000, fecha: hoy(), concepto: 'Luz' });
      await registrarAbono({ cliente_id: clienteY.id, monto_centavos: 7000, fecha: hoy() });

      const saldoX = await calcularSaldo(clienteX.id);
      const saldoY = await calcularSaldo(clienteY.id);
      const abonosManual = 3000 + 7000;
      const cargosManual = 5000 + 2000;
      const saldoManual = saldoX + saldoY;

      const { grupos } = await listarClientesAgrupados({ anioMes });
      const grupo = grupos.find((g) => g.categoria_id === catAgrupado.id);
      assert(grupo, 'el grupo recién creado debería aparecer en listarClientesAgrupados');
      assert(grupo.clientes.length === 2, `el grupo debería tener 2 clientes, tiene ${grupo.clientes.length}`);
      assert(
        grupo.totales.abonos_mes_centavos === abonosManual,
        `Σ abonos_mes: esperado ${abonosManual}, obtenido ${grupo.totales.abonos_mes_centavos}`
      );
      assert(
        grupo.totales.cargos_mes_centavos === cargosManual,
        `Σ cargos_mes: esperado ${cargosManual}, obtenido ${grupo.totales.cargos_mes_centavos}`
      );
      assert(grupo.totales.saldo_centavos === saldoManual, `Σ saldo: esperado ${saldoManual}, obtenido ${grupo.totales.saldo_centavos}`);

      // Cruce con resumenMensual: los abonos/cargos del mes de cada cliente deben coincidir.
      const resumenMes = await resumenMensual(anioMes);
      const filaX = resumenMes.porCliente.find((p) => p.cliente_id === clienteX.id);
      const filaY = resumenMes.porCliente.find((p) => p.cliente_id === clienteY.id);
      const clienteXAgg = grupo.clientes.find((c) => c.id === clienteX.id);
      const clienteYAgg = grupo.clientes.find((c) => c.id === clienteY.id);
      assert(filaX.cargos === clienteXAgg.cargos_mes_centavos, 'cargos_mes de X debería coincidir con resumenMensual');
      assert(filaX.abonos === clienteXAgg.abonos_mes_centavos, 'abonos_mes de X debería coincidir con resumenMensual');
      assert(filaY.cargos === clienteYAgg.cargos_mes_centavos, 'cargos_mes de Y debería coincidir con resumenMensual');
      assert(filaY.abonos === clienteYAgg.abonos_mes_centavos, 'abonos_mes de Y debería coincidir con resumenMensual');

      // Orden manual: invertir el orden dentro del grupo y confirmar que se refleja.
      await actualizarOrdenClientes([clienteY.id, clienteX.id]);
      const { grupos: gruposTrasReordenar } = await listarClientesAgrupados({ anioMes });
      const grupoTrasReordenar = gruposTrasReordenar.find((g) => g.categoria_id === catAgrupado.id);
      assert(
        grupoTrasReordenar.clientes[0].id === clienteY.id && grupoTrasReordenar.clientes[1].id === clienteX.id,
        'tras actualizarOrdenClientes([Y,X]), el grupo debería listar a Y antes que a X'
      );
    }
  );

  await verificar('listarClientesAgrupados: un cliente sin categoría cae en el grupo "Sin categoría"', async () => {
    const anioMes = hoy().slice(0, 7);
    const clienteSinCat = await crearCliente({ nombre: 'Cliente SinCategoria Verify' });
    const { grupos } = await listarClientesAgrupados({ anioMes });
    const grupoSinCategoria = grupos.find((g) => g.categoria_id === null);
    assert(grupoSinCategoria, 'debería existir el grupo "Sin categoría"');
    assert(grupoSinCategoria.categoria_nombre === 'Sin categoría', `el nombre del grupo debería ser "Sin categoría", es "${grupoSinCategoria.categoria_nombre}"`);
    assert(
      grupoSinCategoria.clientes.some((c) => c.id === clienteSinCat.id),
      'el cliente sin categoría debería aparecer en el grupo "Sin categoría"'
    );
  });

  // --- obtenerCalendarioMovimientos: saldoAcumulado por fecha == calcularSaldo(cliente, fecha) ---
  await verificar(
    'obtenerCalendarioMovimientos: saldoAcumuladoCentavos coincide con calcularSaldo para 3 fechas (blindado contra el borde de mes — bug reportado 1-sep-2026)',
    async () => {
      const d1 = sumarDias(hoy(), -3);
      const d2 = sumarDias(hoy(), -2);
      const d3 = hoy(); // registrarAjuste() SIEMPRE fecha con el hoy() real (no toma `fecha` como parámetro) — d3 no puede reemplazarse por un valor sintético.

      const cliente = await crearCliente({ nombre: 'Cliente CalendarioMovimientos Verify' });
      const cargo = await registrarCargo({ cliente_id: cliente.id, monto_centavos: 8000, fecha: d1, concepto: 'Internet' });
      await registrarAbono({ cliente_id: cliente.id, monto_centavos: 5000, fecha: d2 });
      await registrarAjuste({ movimiento_original_id: cargo.id, delta_centavos: -1000, nota: 'ajuste de prueba' }); // fecha = hoy() = d3

      // BLINDAJE (bug reportado 1-sep-2026, detectado por el otro builder): la
      // versión vieja de este test asumía que d1/d2 (hoy-3/hoy-2) caen SIEMPRE
      // en el mismo mes calendario que d3=hoy(), y consultaba un único
      // anioMes=hoy().slice(0,7). Eso es falso los primeros días de cualquier
      // mes (ej. hoy=1-sep-2026: d1=29-ago, d2=30-ago quedan en agosto,
      // d3=1-sep en septiembre) — dias.get(d1)/dias.get(d2) daban undefined y
      // saldoInicialCentavos ya no era 0. obtenerCalendarioMovimientos solo
      // cubre UN mes por llamada, así que acá se agrupan las 3 fechas por su
      // propio anioMes real (mes.slice(0,7)) y se llama una vez por cada mes
      // DISTINTO que realmente aparezca (1 llamada la mayoría de los días del
      // año, 2 llamadas en el borde) — determinista los 365/366 días del año,
      // sin asumir en qué mes cae nada.
      const mesesInvolucrados = [...new Set([d1, d2, d3].map((f) => f.slice(0, 7)))];

      const diasPorFecha = new Map();
      for (const anioMes of mesesInvolucrados) {
        const { saldoInicialCentavos, dias } = await obtenerCalendarioMovimientos(cliente.id, anioMes);
        const saldoManualInicial = await calcularSaldo(cliente.id, sumarDias(`${anioMes}-01`, -1));
        assert(
          saldoInicialCentavos === saldoManualInicial,
          `saldoInicialCentavos de ${anioMes} debería coincidir con calcularSaldo justo antes del mes (${saldoManualInicial}), es ${saldoInicialCentavos}`
        );
        for (const [fecha, agg] of dias) diasPorFecha.set(fecha, agg);
      }

      for (const fecha of [d1, d2, d3]) {
        const saldoManual = await calcularSaldo(cliente.id, fecha);
        const diaAgg = diasPorFecha.get(fecha);
        assert(diaAgg, `debería existir una entrada para el día ${fecha} (mes consultado: ${fecha.slice(0, 7)})`);
        assert(
          diaAgg.saldoAcumuladoCentavos === saldoManual,
          `día ${fecha}: saldoAcumuladoCentavos=${diaAgg.saldoAcumuladoCentavos}, calcularSaldo=${saldoManual}`
        );
      }

      assert(diasPorFecha.get(d1).cargosCentavos === 8000, 'cargosCentavos del día 1 debería ser 8000');
      assert(
        diasPorFecha.get(d1).movimientos.some((m) => m.tipo === 'CARGO' && m.concepto === 'Internet' && m.montoCentavos === 8000),
        'el día 1 debería listar el CARGO con su concepto'
      );
      assert(diasPorFecha.get(d2).abonosCentavos === 5000, 'abonosCentavos del día 2 debería ser 5000');
      assert(
        diasPorFecha.get(d3).movimientos.some((m) => m.tipo === 'AJUSTE' && m.montoCentavos === -1000),
        'el día 3 debería listar el AJUSTE'
      );
    }
  );

  // ============================================================
  // Sección 14 — §2.10 (ITERACIÓN V3 "EXCEL", gate del dueño 28-ago-2026):
  // restaurarCliente, listarClientesArchivados, obtenerCalendarioGlobalMovimientos,
  // recordatorio de respaldo (ultimo_respaldo), y confirmación explícita de
  // que listarClientesAgrupados excluye archivados.
  // ============================================================

  await verificar('§2.10: restaurarCliente — caso feliz, entra al final del orden de su grupo', async () => {
    const cat = await crearCategoria({ nombre: 'CategoriaRestaurar Verify', color: 'turquesa' });
    const otro = await crearCliente({ nombre: 'Cliente Restaurar Otro Verify', categoria_id: cat.id });
    const cliente = await crearCliente({ nombre: 'Cliente Restaurar Feliz Verify', categoria_id: cat.id });
    await borrarClienteLogico(cliente.id);

    const restaurado = await restaurarCliente(cliente.id);
    assert(restaurado.deleted_at === null, 'deleted_at debería quedar NULL tras restaurar');
    assert(restaurado.categoria_id === cat.id, 'debería conservar su categoría (sigue viva)');
    assert(restaurado.orden > otro.orden, `orden (${restaurado.orden}) debería quedar al final del grupo, después de otro.orden (${otro.orden})`);

    const { clientes } = await listarClientes({ busqueda: 'Cliente Restaurar Feliz Verify' });
    assert(clientes.length === 1, 'el cliente restaurado debería volver a aparecer como activo');
  });

  await verificar('§2.10: restaurarCliente rechaza con CONFLICT si su nombre fue tomado mientras estaba archivado', async () => {
    const original = await crearCliente({ nombre: 'Cliente A101 Restaurar Tomado Verify' });
    await borrarClienteLogico(original.id);
    await crearCliente({ nombre: 'Cliente A101 Restaurar Tomado Verify' }); // permitido: el original está archivado

    let lanzo = false;
    try {
      await restaurarCliente(original.id);
    } catch (e) {
      lanzo = true;
      assert(e.code === 'CONFLICT', `code esperado CONFLICT, recibido ${e.code}`);
    }
    assert(lanzo, 'debería rechazar la restauración si otro cliente activo ya tiene ese nombre');

    const archivados = await listarClientesArchivados();
    assert(archivados.some((a) => a.id === original.id), 'el original debería seguir archivado tras el intento fallido');
  });

  await verificar('§2.10: restaurarCliente lanza NOT_FOUND si no existe o no está archivado', async () => {
    let lanzoInexistente = false;
    try {
      await restaurarCliente('no-existe');
    } catch (e) {
      lanzoInexistente = true;
      assert(e.code === 'NOT_FOUND');
    }
    assert(lanzoInexistente, 'debería lanzar NOT_FOUND para un id inexistente');

    const clienteActivo = await crearCliente({ nombre: 'Cliente Activo NoArchivado Verify' });
    let lanzoActivo = false;
    try {
      await restaurarCliente(clienteActivo.id);
    } catch (e) {
      lanzoActivo = true;
      assert(e.code === 'NOT_FOUND', `code esperado NOT_FOUND, recibido ${e.code}`);
    }
    assert(lanzoActivo, 'debería lanzar NOT_FOUND si el cliente existe pero NO está archivado');
  });

  await verificar('§2.10: listarClientesArchivados trae categoria (id/nombre/color) y saldo; null si la categoría murió', async () => {
    const cat = await crearCategoria({ nombre: 'CategoriaArchivados Verify', color: 'rosa' });
    const conCategoria = await crearCliente({ nombre: 'Cliente Archivado ConCategoria Verify', categoria_id: cat.id });
    await registrarCargo({ cliente_id: conCategoria.id, monto_centavos: 4000, fecha: hoy(), concepto: 'Agua' });
    await borrarClienteLogico(conCategoria.id, { forzar: true });

    const catMuerta = await crearCategoria({ nombre: 'CategoriaMuereDespues Verify', color: 'amarillo' });
    const conCategoriaMuerta = await crearCliente({ nombre: 'Cliente Archivado CategoriaMuerta Verify', categoria_id: catMuerta.id });
    await borrarClienteLogico(conCategoriaMuerta.id);
    await borrarCategoriaLogica(catMuerta.id); // la cascada solo alcanza a clientes ACTIVOS: este ya estaba archivado

    const archivados = await listarClientesArchivados();

    const filaConCategoria = archivados.find((a) => a.id === conCategoria.id);
    assert(filaConCategoria, 'el cliente archivado con categoría debería listarse');
    assert(
      filaConCategoria.categoria && filaConCategoria.categoria.id === cat.id && filaConCategoria.categoria.color === 'rosa',
      'debería traer la categoría {id,nombre,color} completa'
    );
    assert(filaConCategoria.saldo_centavos === 4000, `saldo_centavos debería ser 4000, es ${filaConCategoria.saldo_centavos}`);

    const filaCategoriaMuerta = archivados.find((a) => a.id === conCategoriaMuerta.id);
    assert(filaCategoriaMuerta, 'el cliente con categoría muerta debería listarse igual');
    assert(filaCategoriaMuerta.categoria === null, 'categoria debería ser null si la categoría ya no está viva');
  });

  await verificar('§2.10: listarClientesAgrupados EXCLUYE clientes archivados de todos los grupos', async () => {
    const cliente = await crearCliente({ nombre: 'Cliente ExcluidoDeGrupos Verify' });
    await borrarClienteLogico(cliente.id);

    const { grupos } = await listarClientesAgrupados({});
    const apareceEnAlgunGrupo = grupos.some((g) => g.clientes.some((c) => c.id === cliente.id));
    assert(!apareceEnAlgunGrupo, 'un cliente archivado NO debería aparecer en ningún grupo de listarClientesAgrupados');
  });

  await verificar(
    'obtenerCalendarioGlobalMovimientos: totales del día == suma manual del desglose, incluye archivados',
    async () => {
      const anioMes = hoy().slice(0, 7);
      const clienteGlobalActivo = await crearCliente({ nombre: 'Cliente GlobalMov Activo Verify' });
      const clienteGlobalArchivado = await crearCliente({ nombre: 'Cliente GlobalMov Archivado Verify' });

      await registrarCargo({ cliente_id: clienteGlobalActivo.id, monto_centavos: 6000, fecha: hoy(), concepto: 'Luz' });
      await registrarAbono({ cliente_id: clienteGlobalActivo.id, monto_centavos: 2500, fecha: hoy() });
      await registrarAbono({ cliente_id: clienteGlobalArchivado.id, monto_centavos: 9000, fecha: hoy() });
      await borrarClienteLogico(clienteGlobalArchivado.id, { forzar: true });

      const { dias, totalesMes } = await obtenerCalendarioGlobalMovimientos(anioMes);
      const diaHoy = dias.get(hoy());
      assert(diaHoy, 'debería existir una entrada para hoy en el calendario global de movimientos');

      const abonosManual = diaHoy.movimientos.filter((m) => m.tipo === 'ABONO').reduce((acc, m) => acc + m.montoCentavos, 0);
      const cargosManual = diaHoy.movimientos.filter((m) => m.tipo === 'CARGO').reduce((acc, m) => acc + m.montoCentavos, 0);
      assert(diaHoy.abonosCentavos === abonosManual, `abonosCentavos (${diaHoy.abonosCentavos}) debería ser la suma manual del desglose (${abonosManual})`);
      assert(diaHoy.cargosCentavos === cargosManual, `cargosCentavos (${diaHoy.cargosCentavos}) debería ser la suma manual del desglose (${cargosManual})`);

      assert(
        diaHoy.movimientos.some((m) => m.cliente_id === clienteGlobalArchivado.id && m.tipo === 'ABONO' && m.montoCentavos === 9000),
        'el movimiento del cliente archivado debería seguir apareciendo (A-001: la historia por fecha no se falsea)'
      );

      const resumenCruzado = await resumenMensual(anioMes);
      assert(totalesMes.abonosCentavos === resumenCruzado.totalAbonosCentavos, 'totalesMes.abonosCentavos debería coincidir con resumenMensual');
      assert(totalesMes.cargosCentavos === resumenCruzado.totalCargosCentavos, 'totalesMes.cargosCentavos debería coincidir con resumenMensual');
      assert(
        totalesMes.carteraPendienteCentavos === resumenCruzado.carteraPendienteCentavos,
        'totalesMes.carteraPendienteCentavos debería coincidir con resumenMensual'
      );
    }
  );

  await verificar(
    '§2.12 (ROUND 5): obtenerCalendarioGlobalMovimientos — un mes futuro SIN movimientos registrados da dias vacío y abonos/cargos del mes en 0, pero carteraPendienteCentavos SIGUE siendo el saldo pendiente real (cambio de spec: antes esta función devolvía un shortcut hardcodeado a 0 para CUALQUIER mes futuro, sin llamar a resumenMensual)',
    async () => {
      const anioMes = hoy().slice(0, 7);
      const anio = Number(anioMes.slice(0, 4));
      const mes = Number(anioMes.slice(5, 7));
      const anioMesFuturo = mes === 12 ? `${anio + 1}-01` : `${anio}-${String(mes + 1).padStart(2, '0')}`;

      const { dias, totalesMes } = await obtenerCalendarioGlobalMovimientos(anioMesFuturo);
      assert(dias.size === 0, `sin movimientos registrados ese mes, el mapa de días debería quedar vacío, tiene ${dias.size} claves`);
      assert(totalesMes.abonosCentavos === 0, 'abonosCentavos de un mes futuro sin abonos registrados debería ser 0');
      assert(totalesMes.cargosCentavos === 0, 'cargosCentavos de un mes futuro sin cargos registrados debería ser 0');

      // carteraPendienteCentavos NO es "actividad de este mes": es el saldo pendiente
      // acumulado de TODA la historia hasta el fin de ese mes (calcularSaldoInterno,
      // sin corte de fecha) — con clientes de deuda franca en el seed, es real y
      // esperablemente > 0 incluso para un mes futuro sin movimientos propios.
      // Lo que hay que proteger acá es que siga coincidiendo con resumenMensual
      // (misma fuente de verdad), NO que sea cero por un atajo hardcodeado.
      const resumenCruzado = await resumenMensual(anioMesFuturo);
      assert(
        totalesMes.carteraPendienteCentavos === resumenCruzado.carteraPendienteCentavos,
        `carteraPendienteCentavos de un mes futuro debería coincidir con resumenMensual (${resumenCruzado.carteraPendienteCentavos}), obtuvo ${totalesMes.carteraPendienteCentavos}`
      );
    }
  );

  await verificar('§2.10: exportarRespaldo() registra ultimo_respaldo en meta', async () => {
    const antes = await obtenerUltimoRespaldo();
    await exportarRespaldo();
    const despues = await obtenerUltimoRespaldo();

    assert(typeof despues === 'string' && despues.length > 0, 'obtenerUltimoRespaldo debería devolver una fecha ISO tras exportar');
    const timestampDespues = new Date(despues).getTime();
    assert(!Number.isNaN(timestampDespues), `ultimo_respaldo debería ser una fecha ISO válida, es "${despues}"`);
    assert(Math.abs(Date.now() - timestampDespues) < 10000, 'ultimo_respaldo debería ser un instante muy reciente (< 10s)');
    assert(antes === null || despues !== antes, 'ultimo_respaldo debería actualizarse con cada export');
  });

  // ============================================================
  // Sección 15 — §2.11 (ROUND 4, gate del dueño 30-ago-2026): retro de
  // Agustín vía WhatsApp. Vista por día (listarClientesAgrupados({fecha})),
  // visitas_sin_abono (semáforo de 3 estados), borrado/restauración lógica de
  // movimientos con cascada de AJUSTEs, corregirMontoMovimiento y el nuevo
  // formato de dinero sin ".00".
  // ============================================================

  await verificar('money.js: formatearCentavos NUEVO — sin .00 en pesos exactos, conserva centavos si los hay', async () => {
    assert(formatearCentavos(125000) === '$1,250', `esperado "$1,250", obtenido "${formatearCentavos(125000)}"`);
    assert(formatearCentavos(125050) === '$1,250.50', `esperado "$1,250.50", obtenido "${formatearCentavos(125050)}"`);
    assert(formatearCentavos(0) === '$0', `esperado "$0", obtenido "${formatearCentavos(0)}"`);
    assert(formatearCentavos(100) === '$1', `esperado "$1", obtenido "${formatearCentavos(100)}"`);
    assert(formatearCentavos(150) === '$1.50', `esperado "$1.50", obtenido "${formatearCentavos(150)}"`);
  });

  await verificar('money.js: formatearCompacto ya cumplía "sin .00" antes de §2.11 (sin cambios de código)', async () => {
    const texto = formatearCompacto(150000000); // $1,500,000 -> "$1.5 M"
    assert(!/\.0\b/.test(texto) || /\.\d[1-9]/.test(texto), `no debería mostrar un ".0" espurio: "${texto}"`);
    const textoRedondo = formatearCompacto(100000000); // $1,000,000 exacto
    assert(!textoRedondo.includes('.0'), `formatearCompacto de un monto redondo no debería mostrar ".0": "${textoRedondo}"`);
  });

  const clienteDia = await crearCliente({ nombre: 'Cliente VistaPorDia Verify', telefono: '5215500000200' });
  const clienteDiaSinVisita = await crearCliente({ nombre: 'Cliente VistaPorDia SinVisita Verify', telefono: '5215500000201' });
  const clienteDiaCero = await crearCliente({ nombre: 'Cliente VistaPorDia DijoNo Verify', telefono: '5215500000202' });
  const fechaVista = hoy();

  await verificar('registrarVisitaSinAbono: caso feliz crea la visita', async () => {
    const visita = await registrarVisitaSinAbono({ cliente_id: clienteDiaCero.id, fecha: fechaVista });
    assert(visita && visita.id, 'debería devolver la visita creada');
    assert(visita.cliente_id === clienteDiaCero.id && visita.fecha === fechaVista, 'cliente_id/fecha deberían coincidir');
  });

  await verificar('registrarVisitaSinAbono: idempotente — misma cliente+fecha devuelve la existente, no duplica', async () => {
    const primera = await registrarVisitaSinAbono({ cliente_id: clienteDiaCero.id, fecha: fechaVista });
    const segunda = await registrarVisitaSinAbono({ cliente_id: clienteDiaCero.id, fecha: fechaVista });
    assert(primera.id === segunda.id, `debería devolver la MISMA visita (idempotente), obtuvo ids distintos: ${primera.id} / ${segunda.id}`);

    const dbInterna = _dbInternaParaVerificacion();
    const stmt = dbInterna.prepare(
      "SELECT COUNT(*) AS c FROM visitas_sin_abono WHERE cliente_id=? AND fecha=? AND deleted_at IS NULL"
    );
    stmt.bind([clienteDiaCero.id, fechaVista]);
    stmt.step();
    const cuenta = stmt.getAsObject().c;
    stmt.free();
    assert(cuenta === 1, `debería haber exactamente 1 visita viva para ese cliente+fecha, hay ${cuenta}`);
  });

  await verificar('registrarVisitaSinAbono: bloqueada con VALIDATION_ERROR si ese día ya tiene un ABONO vivo', async () => {
    await registrarAbono({ cliente_id: clienteDia.id, monto_centavos: 3000, fecha: fechaVista });
    let lanzo = false;
    try {
      await registrarVisitaSinAbono({ cliente_id: clienteDia.id, fecha: fechaVista });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'VALIDATION_ERROR', `code esperado VALIDATION_ERROR, recibido ${e.code}`);
    }
    assert(lanzo, 'debería rechazar registrar visita sin abono si ya abonó ese día');
  });

  await verificar('registrarVisitaSinAbono: fecha futura o inválida lanza VALIDATION_ERROR', async () => {
    for (const fechaMala of [sumarDias(hoy(), 1), 'no-es-fecha', '2026-13-40']) {
      let lanzo = false;
      try {
        await registrarVisitaSinAbono({ cliente_id: clienteDiaSinVisita.id, fecha: fechaMala });
      } catch (e) {
        lanzo = true;
        assert(e.code === 'VALIDATION_ERROR', `code esperado VALIDATION_ERROR para "${fechaMala}", recibido ${e.code}`);
      }
      assert(lanzo, `debería rechazar fecha "${fechaMala}"`);
    }
  });

  await verificar('eliminarVisitaSinAbono: borrado lógico (Deshacer) — deja de contar como visita viva', async () => {
    const clienteTemporal = await crearCliente({ nombre: 'Cliente VisitaDeshacer Verify' });
    const visita = await registrarVisitaSinAbono({ cliente_id: clienteTemporal.id, fecha: fechaVista });
    await eliminarVisitaSinAbono(visita.id);

    const dbInterna = _dbInternaParaVerificacion();
    const stmt = dbInterna.prepare('SELECT deleted_at FROM visitas_sin_abono WHERE id=?');
    stmt.bind([visita.id]);
    stmt.step();
    const deletedAt = stmt.getAsObject().deleted_at;
    stmt.free();
    assert(deletedAt !== null && deletedAt !== undefined, 'deleted_at debería quedar seteado tras eliminar');

    // Deshacer real: volver a registrar la misma visita después de "eliminar" NO debe chocar con la borrada
    const nuevaVisita = await registrarVisitaSinAbono({ cliente_id: clienteTemporal.id, fecha: fechaVista });
    assert(nuevaVisita.id !== visita.id, 'tras eliminar lógicamente, registrar de nuevo debería crear una fila nueva (la vieja sigue borrada)');
  });

  await verificar('listarClientesAgrupados({fecha}): estado_dia ABONO/CERO/SIN_VISITA + resumenDia cuadrado a mano', async () => {
    const { grupos, resumenDia: resumen } = await listarClientesAgrupados({ fecha: fechaVista, busqueda: 'Cliente VistaPorDia' });
    const todos = grupos.flatMap((g) => g.clientes);

    const filaAbono = todos.find((c) => c.id === clienteDia.id);
    const filaSinVisita = todos.find((c) => c.id === clienteDiaSinVisita.id);
    const filaCero = todos.find((c) => c.id === clienteDiaCero.id);

    assert(filaAbono, 'debería encontrar al cliente que abonó');
    assert(filaSinVisita, 'debería encontrar al cliente sin visitar');
    assert(filaCero, 'debería encontrar al cliente que dijo hoy no');

    assert(filaAbono.estado_dia === 'ABONO', `esperado ABONO, obtenido ${filaAbono.estado_dia}`);
    assert(filaSinVisita.estado_dia === 'SIN_VISITA', `esperado SIN_VISITA, obtenido ${filaSinVisita.estado_dia}`);
    assert(filaCero.estado_dia === 'CERO', `esperado CERO, obtenido ${filaCero.estado_dia}`);

    assert(filaAbono.abonos_mes_centavos === 3000, `abonos del día del cliente ABONO debería ser 3000, es ${filaAbono.abonos_mes_centavos}`);
    assert(filaCero.abonos_mes_centavos === 0, `abonos del día del cliente CERO debería ser 0, es ${filaCero.abonos_mes_centavos}`);
    assert(filaSinVisita.abonos_mes_centavos === 0, `abonos del día del cliente SIN_VISITA debería ser 0, es ${filaSinVisita.abonos_mes_centavos}`);

    // resumenDia cuadrado a mano SOLO sobre estos 3 clientes de prueba (busqueda los aísla del resto del seed)
    assert(resumen.cobradoCentavos === 3000, `resumenDia.cobradoCentavos debería ser 3000, es ${resumen.cobradoCentavos}`);
    assert(resumen.abonaron === 1, `resumenDia.abonaron debería ser 1, es ${resumen.abonaron}`);
    assert(resumen.dijeronNo === 1, `resumenDia.dijeronNo debería ser 1, es ${resumen.dijeronNo}`);
    assert(resumen.sinVisitar === 1, `resumenDia.sinVisitar debería ser 1, es ${resumen.sinVisitar}`);
  });

  await verificar('listarClientesAgrupados SIN fecha (modo mensual) no incluye estado_dia ni resumenDia — no rompe consumidores existentes', async () => {
    const resultado = await listarClientesAgrupados({});
    assert(resultado.resumenDia === undefined, 'modo mensual no debería traer resumenDia');
    const algunCliente = resultado.grupos.flatMap((g) => g.clientes)[0];
    assert(algunCliente && algunCliente.estado_dia === undefined, 'modo mensual no debería traer estado_dia por cliente');
  });

  await verificar('visitas_sin_abono NO afecta calcularSaldo, obtenerCalendarioMovimientos ni obtenerCalendarioGlobalMovimientos', async () => {
    const clienteAislado = await crearCliente({ nombre: 'Cliente VisitaNoAfectaSaldo Verify' });
    await registrarCargo({ cliente_id: clienteAislado.id, monto_centavos: 5000, fecha: fechaVista, concepto: 'Agua' });

    const saldoAntes = await calcularSaldo(clienteAislado.id, fechaVista);
    const anioMes = fechaVista.slice(0, 7);
    const calBefore = await obtenerCalendarioMovimientos(clienteAislado.id, anioMes);
    const globalAntes = await obtenerCalendarioGlobalMovimientos(anioMes);
    const diaGlobalAntes = globalAntes.dias.get(fechaVista);
    const abonosGlobalAntes = diaGlobalAntes ? diaGlobalAntes.abonosCentavos : 0;
    const cargosGlobalAntes = diaGlobalAntes ? diaGlobalAntes.cargosCentavos : 0;

    // el cliente ya tiene un CARGO hoy pero NINGÚN abono hoy -> la visita sin abono es válida
    await registrarVisitaSinAbono({ cliente_id: clienteAislado.id, fecha: fechaVista });

    const saldoDespues = await calcularSaldo(clienteAislado.id, fechaVista);
    const calDespues = await obtenerCalendarioMovimientos(clienteAislado.id, anioMes);
    const globalDespues = await obtenerCalendarioGlobalMovimientos(anioMes);
    const diaGlobalDespues = globalDespues.dias.get(fechaVista);
    const abonosGlobalDespues = diaGlobalDespues ? diaGlobalDespues.abonosCentavos : 0;
    const cargosGlobalDespues = diaGlobalDespues ? diaGlobalDespues.cargosCentavos : 0;

    assert(saldoAntes === saldoDespues, `calcularSaldo no debería cambiar por una visita_sin_abono: antes ${saldoAntes}, después ${saldoDespues}`);
    assert(
      JSON.stringify(calBefore.saldoAcumuladoCentavos) === JSON.stringify(calDespues.saldoAcumuladoCentavos),
      'obtenerCalendarioMovimientos no debería cambiar por una visita_sin_abono'
    );
    assert(abonosGlobalAntes === abonosGlobalDespues, 'obtenerCalendarioGlobalMovimientos.abonosCentavos no debería cambiar por una visita_sin_abono');
    assert(cargosGlobalAntes === cargosGlobalDespues, 'obtenerCalendarioGlobalMovimientos.cargosCentavos no debería cambiar por una visita_sin_abono');
  });

  const clienteMovLogico = await crearCliente({ nombre: 'Cliente BorrarRestaurarMovimiento Verify' });

  await verificar('borrarMovimientoLogico: rechaza borrar un AJUSTE directamente (VALIDATION_ERROR)', async () => {
    const cargo = await registrarCargo({ cliente_id: clienteMovLogico.id, monto_centavos: 10000, fecha: hoy(), concepto: 'Agua' });
    const ajuste = await registrarAjuste({ movimiento_original_id: cargo.id, delta_centavos: -500, nota: 'ajuste test' });
    let lanzo = false;
    try {
      await borrarMovimientoLogico(ajuste.id);
    } catch (e) {
      lanzo = true;
      assert(e.code === 'VALIDATION_ERROR', `code esperado VALIDATION_ERROR, recibido ${e.code}`);
    }
    assert(lanzo, 'debería rechazar borrar un AJUSTE directamente');
  });

  await verificar('borrarMovimientoLogico: cascada — borra en cascada los AJUSTEs vivos vinculados, mismo deleted_at', async () => {
    const cargo = await registrarCargo({ cliente_id: clienteMovLogico.id, monto_centavos: 20000, fecha: hoy(), concepto: 'Luz' });
    const ajuste1 = await registrarAjuste({ movimiento_original_id: cargo.id, delta_centavos: -1000, nota: 'a1' });
    const ajuste2 = await registrarAjuste({ movimiento_original_id: cargo.id, delta_centavos: 500, nota: 'a2' });

    const saldoAntes = await calcularSaldo(clienteMovLogico.id, hoy());
    await borrarMovimientoLogico(cargo.id);
    const saldoDespues = await calcularSaldo(clienteMovLogico.id, hoy());
    assert(
      saldoDespues === saldoAntes - (20000 - 1000 + 500),
      `saldo debería bajar exactamente el neto (19500): antes ${saldoAntes}, después ${saldoDespues}`
    );

    const dbInterna = _dbInternaParaVerificacion();
    for (const idRevisar of [cargo.id, ajuste1.id, ajuste2.id]) {
      const stmt = dbInterna.prepare('SELECT deleted_at FROM movimientos WHERE id=?');
      stmt.bind([idRevisar]);
      stmt.step();
      const d = stmt.getAsObject().deleted_at;
      stmt.free();
      assert(d !== null && d !== undefined, `${idRevisar} debería tener deleted_at seteado tras la cascada`);
    }

    const stmtA = dbInterna.prepare('SELECT deleted_at FROM movimientos WHERE id=?');
    stmtA.bind([cargo.id]);
    stmtA.step();
    const deletedAtCargo = stmtA.getAsObject().deleted_at;
    stmtA.free();
    for (const idAjuste of [ajuste1.id, ajuste2.id]) {
      const stmt = dbInterna.prepare('SELECT deleted_at FROM movimientos WHERE id=?');
      stmt.bind([idAjuste]);
      stmt.step();
      const d = stmt.getAsObject().deleted_at;
      stmt.free();
      assert(d === deletedAtCargo, `el AJUSTE ${idAjuste} debería tener EXACTAMENTE el mismo deleted_at que el cargo cascadeado`);
    }

    // guardar para el siguiente test (restaurar)
    clienteMovLogico._ultimoCargoBorradoId = cargo.id;
    clienteMovLogico._ajustesCascadeados = [ajuste1.id, ajuste2.id];
    clienteMovLogico._saldoAntesDeBorrar = saldoAntes;
  });

  await verificar('restaurarMovimiento: revierte exactamente — movimiento + sus AJUSTEs cascadeados, saldo vuelve al original', async () => {
    const cargoId = clienteMovLogico._ultimoCargoBorradoId;
    assert(cargoId, 'depende del test anterior (cascada de borrado)');

    const restaurado = await restaurarMovimiento(cargoId);
    assert(restaurado.deleted_at === null, 'el movimiento restaurado debería tener deleted_at NULL');

    const dbInterna = _dbInternaParaVerificacion();
    for (const idAjuste of clienteMovLogico._ajustesCascadeados) {
      const stmt = dbInterna.prepare('SELECT deleted_at FROM movimientos WHERE id=?');
      stmt.bind([idAjuste]);
      stmt.step();
      const d = stmt.getAsObject().deleted_at;
      stmt.free();
      assert(d === null, `el AJUSTE ${idAjuste} debería restaurarse (deleted_at NULL) en cascada`);
    }

    const saldoRestaurado = await calcularSaldo(clienteMovLogico.id, hoy());
    assert(
      saldoRestaurado === clienteMovLogico._saldoAntesDeBorrar,
      `el saldo debería volver exactamente al valor previo al borrado: esperado ${clienteMovLogico._saldoAntesDeBorrar}, obtenido ${saldoRestaurado}`
    );
  });

  await verificar('restaurarMovimiento: NOT_FOUND si el id no existe o no está borrado', async () => {
    let lanzoInexistente = false;
    try {
      await restaurarMovimiento('no-existe');
    } catch (e) {
      lanzoInexistente = true;
      assert(e.code === 'NOT_FOUND');
    }
    assert(lanzoInexistente, 'debería lanzar NOT_FOUND para un id inexistente');

    const cargoVivo = await registrarCargo({ cliente_id: clienteMovLogico.id, monto_centavos: 1000, fecha: hoy(), concepto: 'Agua' });
    let lanzoVivo = false;
    try {
      await restaurarMovimiento(cargoVivo.id);
    } catch (e) {
      lanzoVivo = true;
      assert(e.code === 'NOT_FOUND', `code esperado NOT_FOUND, recibido ${e.code}`);
    }
    assert(lanzoVivo, 'debería lanzar NOT_FOUND si el movimiento existe pero NO está borrado');
  });

  await verificar('corregirMontoMovimiento: reemplaza el monto preservando fecha/concepto/referencia/nota; saldo cambia exacto', async () => {
    const original = await registrarCargo({
      cliente_id: clienteMovLogico.id,
      monto_centavos: 7000,
      fecha: hoy(),
      concepto: 'Internet',
      referencia: 'REF-CORREGIR',
      nota: 'nota original',
    });

    const saldoAntes = await calcularSaldo(clienteMovLogico.id, hoy());
    const { nuevo, original_id } = await corregirMontoMovimiento(original.id, 9500);
    const saldoDespues = await calcularSaldo(clienteMovLogico.id, hoy());

    assert(original_id === original.id, 'original_id devuelto debería ser el id del movimiento original');
    assert(nuevo.monto_centavos === 9500, `el nuevo movimiento debería tener el monto corregido, tiene ${nuevo.monto_centavos}`);
    assert(nuevo.fecha === original.fecha, 'la fecha debería preservarse');
    assert(nuevo.tipo === original.tipo, 'el tipo debería preservarse');
    assert(nuevo.servicio === original.servicio, 'el concepto (servicio) debería preservarse');
    assert(nuevo.referencia === original.referencia, 'la referencia debería preservarse');
    assert(nuevo.nota === original.nota, 'la nota debería preservarse');
    assert(nuevo.id !== original.id, 'debería ser un movimiento NUEVO (id distinto), no un UPDATE del original');

    assert(
      saldoDespues === saldoAntes + (9500 - 7000),
      `el saldo debería cambiar exactamente por el delta (2500): antes ${saldoAntes}, después ${saldoDespues}`
    );

    const dbInterna = _dbInternaParaVerificacion();
    const stmt = dbInterna.prepare('SELECT deleted_at FROM movimientos WHERE id=?');
    stmt.bind([original.id]);
    stmt.step();
    const deletedAtOriginal = stmt.getAsObject().deleted_at;
    stmt.free();
    assert(deletedAtOriginal !== null && deletedAtOriginal !== undefined, 'el movimiento original debería quedar con deleted_at seteado (borrado lógico)');

    // Deshacer de corregirMontoMovimiento: borrar el nuevo + restaurar el original
    await borrarMovimientoLogico(nuevo.id);
    const restaurado = await restaurarMovimiento(original_id);
    assert(restaurado.monto_centavos === 7000, 'tras el Deshacer, el original restaurado debería volver a tener el monto viejo (7000)');
    const saldoTrasDeshacer = await calcularSaldo(clienteMovLogico.id, hoy());
    assert(saldoTrasDeshacer === saldoAntes, `el Deshacer debería devolver el saldo exacto al valor previo: esperado ${saldoAntes}, obtenido ${saldoTrasDeshacer}`);
  });

  await verificar('corregirMontoMovimiento: rechaza monto <= 0 o no entero, y rechaza operar sobre un AJUSTE', async () => {
    const cargo = await registrarCargo({ cliente_id: clienteMovLogico.id, monto_centavos: 3000, fecha: hoy(), concepto: 'Agua' });
    for (const montoMalo of [0, -100, 12.5]) {
      let lanzo = false;
      try {
        await corregirMontoMovimiento(cargo.id, montoMalo);
      } catch (e) {
        lanzo = true;
        assert(e.code === 'VALIDATION_ERROR', `code esperado VALIDATION_ERROR para monto ${montoMalo}, recibido ${e.code}`);
      }
      assert(lanzo, `debería rechazar corregir a un monto inválido: ${montoMalo}`);
    }

    const ajuste = await registrarAjuste({ movimiento_original_id: cargo.id, delta_centavos: -200, nota: 'a' });
    let lanzoAjuste = false;
    try {
      await corregirMontoMovimiento(ajuste.id, 500);
    } catch (e) {
      lanzoAjuste = true;
      assert(e.code === 'VALIDATION_ERROR', `code esperado VALIDATION_ERROR, recibido ${e.code}`);
    }
    assert(lanzoAjuste, 'debería rechazar corregir el monto de un AJUSTE directamente');
  });

  // ============================================================
  // LEGACY (retirado en v2, ver §2.9/STORY) — Sección 9: 6+ casos borde del
  // calendario (calendar.js puro, sección 4.2). calendar.js se mantiene SIN
  // CAMBIOS (decisión documentada en el reporte de este builder) porque
  // obtenerEstadoCalendario/obtenerCalendarioGlobal (deprecated pero
  // funcionales) siguen dependiendo de él. Fechas fijas y sintéticas (no
  // dependen de hoy()) para que el cálculo a mano sea reproducible.
  // ============================================================

  // Caso A — Adelanto puro: abona 5 cuotas de una vez, no abona los 4 días
  // siguientes → esos 4 días deben pintar GRACIA_ADELANTO, no DEUDA.
  await verificar('LEGACY: Calendario — Adelanto puro (4.2, caso 1)', async () => {
    const cuota = 10000;
    const acuerdos = [{ vigente_desde: '2026-01-01', vigente_hasta: null, monto_cuota_centavos: cuota, created_at: '2026-01-01T00:00:00.000Z' }];
    const movimientos = [{ tipo: 'ABONO', monto_centavos: cuota * 5, fecha: '2026-01-01' }];
    const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-01', '2026-01-10');
    compararMapaEstados(estados, {
      '2026-01-01': Estado.PAGADO,
      '2026-01-02': Estado.GRACIA_ADELANTO,
      '2026-01-03': Estado.GRACIA_ADELANTO,
      '2026-01-04': Estado.GRACIA_ADELANTO,
      '2026-01-05': Estado.GRACIA_ADELANTO,
      '2026-01-06': Estado.DEUDA,
    });
  });

  // Caso B — Pagos parciales acumulados: abona sistemáticamente el 60% de la
  // cuota → arrastre negativo crece monótonamente, todos los días PARCIAL.
  await verificar('LEGACY: Calendario — Pagos parciales acumulados (4.2, caso 2)', async () => {
    const cuota = 10000;
    const acuerdos = [{ vigente_desde: '2026-01-01', vigente_hasta: null, monto_cuota_centavos: cuota, created_at: '2026-01-01T00:00:00.000Z' }];
    const movimientos = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map(
      (fecha) => ({ tipo: 'ABONO', monto_centavos: 6000, fecha })
    );
    const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-01', '2026-01-08');
    compararMapaEstados(estados, {
      '2026-01-01': Estado.PARCIAL,
      '2026-01-02': Estado.PARCIAL,
      '2026-01-03': Estado.PARCIAL,
      '2026-01-04': Estado.PARCIAL,
      '2026-01-05': Estado.PARCIAL,
      '2026-01-06': Estado.PARCIAL,
      '2026-01-07': Estado.PARCIAL,
      '2026-01-08': Estado.PARCIAL,
    });
  });

  // Caso C — Cliente nuevo a mitad de rango: días previos a vigente_desde son
  // SIN_OBLIGACION y el arrastre NO hereda crédito de esos días (aunque haya
  // un ABONO fechado ahí, por error, en la lista de movimientos).
  await verificar('LEGACY: Calendario — Cliente nuevo a mitad de rango, sin herencia de arrastre (4.2, caso 3)', async () => {
    const cuota = 5000;
    const acuerdos = [{ vigente_desde: '2026-01-04', vigente_hasta: null, monto_cuota_centavos: cuota, created_at: '2026-01-04T00:00:00.000Z' }];
    const movimientos = [{ tipo: 'ABONO', monto_centavos: 6000, fecha: '2026-01-02' }]; // cae en día SIN_OBLIGACION
    const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-01', '2026-01-10');
    compararMapaEstados(estados, {
      '2026-01-01': Estado.SIN_OBLIGACION,
      '2026-01-02': Estado.SIN_OBLIGACION,
      '2026-01-03': Estado.SIN_OBLIGACION,
      '2026-01-04': Estado.DEUDA, // si el crédito del día 2 se hubiera heredado, no sería DEUDA
      '2026-01-05': Estado.DEUDA,
    });
  });

  // Caso D — Cambio de cuota: el día del cambio usa la cuota NUEVA, y el
  // arrastre acumulado con la cuota vieja sigue aplicando sin reiniciarse.
  await verificar('LEGACY: Calendario — Cambio de cuota, arrastre continuo (4.2, caso 4)', async () => {
    const acuerdos = [
      { vigente_desde: '2026-01-01', vigente_hasta: '2026-01-05', monto_cuota_centavos: 10000, created_at: '2026-01-01T00:00:00.000Z' },
      { vigente_desde: '2026-01-06', vigente_hasta: null, monto_cuota_centavos: 20000, created_at: '2026-01-06T00:00:00.000Z' },
    ];
    const movimientos = [{ tipo: 'ABONO', monto_centavos: 100000, fecha: '2026-01-01' }];
    const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-01', '2026-01-08');
    compararMapaEstados(estados, {
      '2026-01-01': Estado.PAGADO,
      '2026-01-05': Estado.GRACIA_ADELANTO,
      '2026-01-06': Estado.GRACIA_ADELANTO, // usa la cuota NUEVA (20000) y el arrastre viejo (50000), no se reinicia
      '2026-01-07': Estado.GRACIA_ADELANTO,
      '2026-01-08': Estado.DEUDA,
    });
  });

  // Caso E — Borde exacto disponible == cuota: debe clasificar GRACIA_ADELANTO, no DEUDA.
  await verificar('LEGACY: Calendario — Borde disponible == cuota clasifica GRACIA_ADELANTO (4.2, caso 5)', async () => {
    const cuota = 10000;
    const acuerdos = [{ vigente_desde: '2026-01-01', vigente_hasta: null, monto_cuota_centavos: cuota, created_at: '2026-01-01T00:00:00.000Z' }];
    const movimientos = [];
    const estados = calcularEstadosCalendario(acuerdos, movimientos, /* arrastreInicial */ cuota, '2026-01-01', '2026-01-02');
    compararMapaEstados(estados, {
      '2026-01-01': Estado.GRACIA_ADELANTO, // disponible = 10000 == cuota, no DEUDA
      '2026-01-02': Estado.DEUDA,
    });
  });

  // Caso F — AJUSTE positivo (aumenta deuda) sobre un ABONO del mismo día
  // reduce el crédito efectivo de ESE día en el calendario.
  await verificar('LEGACY: Calendario — AJUSTE reduce el crédito efectivo del día (4.2, caso 6)', async () => {
    const cuota = 10000;
    const acuerdos = [{ vigente_desde: '2026-01-01', vigente_hasta: null, monto_cuota_centavos: cuota, created_at: '2026-01-01T00:00:00.000Z' }];
    const movimientos = [
      { tipo: 'ABONO', monto_centavos: 10000, fecha: '2026-01-01' },
      { tipo: 'AJUSTE', monto_centavos: 4000, fecha: '2026-01-01' }, // firmado positivo = aumenta deuda
    ];
    const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-01', '2026-01-01');
    compararMapaEstados(estados, { '2026-01-01': Estado.PARCIAL }); // sin el ajuste hubiera sido PAGADO
  });

  // ============================================================
  // LEGACY (retirado en v2, ver §2.9/STORY) — Sección 11: la pestaña
  // "Calendario" global (Fase 12) se retiró de la UI. Se mantiene funcional
  // obtenerCalendarioGlobal(anioMes) y estos tests por las razones ya
  // explicadas (protege calendar.js, que se mantiene sin cambios).
  // ============================================================

  await verificar(
    'LEGACY: obtenerCalendarioGlobal — esperados/cumplieron coinciden con obtenerEstadoCalendario cliente por cliente para TODOS los días del mes actual',
    async () => {
      const anioMes = hoy().slice(0, 7);
      const primerDia = `${anioMes}-01`;
      const fechaHastaEfectiva = hoy(); // mes actual: el tope siempre es hoy

      const global = await obtenerCalendarioGlobal(anioMes);

      const { clientes } = await listarClientes({ tamanioPagina: 500 });
      const estadosPorCliente = new Map();
      for (const cliente of clientes) {
        estadosPorCliente.set(cliente.id, await obtenerEstadoCalendario(cliente.id, primerDia, fechaHastaEfectiva));
      }

      for (const fecha of rango(primerDia, fechaHastaEfectiva)) {
        let esperadosManual = 0;
        let cumplieronManual = 0;
        for (const cliente of clientes) {
          const estado = estadosPorCliente.get(cliente.id).get(fecha);
          if (estado === Estado.SIN_OBLIGACION) continue;
          esperadosManual += 1;
          if (estado === Estado.PAGADO || estado === Estado.GRACIA_ADELANTO) cumplieronManual += 1;
        }
        const agg = global.dias.get(fecha);
        assert(agg, `falta la clave ${fecha} en el mapa global`);
        assert(agg.esperados === esperadosManual, `día ${fecha}: esperados global=${agg.esperados}, manual=${esperadosManual}`);
        assert(agg.cumplieron === cumplieronManual, `día ${fecha}: cumplieron global=${agg.cumplieron}, manual=${cumplieronManual}`);
        assert(agg.detalle.length === esperadosManual, `día ${fecha}: detalle.length=${agg.detalle.length} debería ser ${esperadosManual}`);
      }
    }
  );

  await verificar('LEGACY: obtenerCalendarioGlobal — un cliente en GRACIA_ADELANTO hoy cuenta como cumplido', async () => {
    const anioMes = hoy().slice(0, 7);
    const ayer = sumarDias(hoy(), -1);
    const cuota = 10000;
    const { cliente } = await crearClienteConAcuerdo({
      nombre: 'Cliente CalendarioGlobal GraciaAdelanto Verify',
      monto_cuota_centavos: cuota,
      vigente_desde: ayer,
    });
    // Adelanta 2 cuotas ayer, no abona hoy: hoy debería quedar en GRACIA_ADELANTO
    // (disponible == cuota, borde que clasifica GRACIA_ADELANTO, no DEUDA).
    await registrarAbono({ cliente_id: cliente.id, monto_centavos: cuota * 2, fecha: ayer });

    const estadoDirecto = await obtenerEstadoCalendario(cliente.id, hoy(), hoy());
    assert(
      estadoDirecto.get(hoy()) === Estado.GRACIA_ADELANTO,
      `precondición: el cliente debería estar en GRACIA_ADELANTO hoy, está en ${estadoDirecto.get(hoy())}`
    );

    const global = await obtenerCalendarioGlobal(anioMes);
    const aggHoy = global.dias.get(hoy());
    assert(aggHoy, 'el día de hoy debería estar en el mapa global');

    const filaCliente = aggHoy.detalle.find((d) => d.cliente_id === cliente.id);
    assert(filaCliente, 'el cliente de prueba debería aparecer en el detalle de hoy');
    assert(filaCliente.estado === Estado.GRACIA_ADELANTO, `estado esperado GRACIA_ADELANTO, es ${filaCliente.estado}`);

    const cumplidosEsperados = aggHoy.detalle.filter((d) => d.estado === Estado.PAGADO || d.estado === Estado.GRACIA_ADELANTO).length;
    assert(aggHoy.cumplieron === cumplidosEsperados, 'GRACIA_ADELANTO debería contarse dentro de "cumplieron"');
  });

  await verificar('LEGACY: obtenerCalendarioGlobal — no incluye claves de días futuros', async () => {
    const anioMes = hoy().slice(0, 7);
    const global = await obtenerCalendarioGlobal(anioMes);
    for (const fecha of global.dias.keys()) {
      assert(fecha <= hoy(), `el mapa global no debería incluir el día futuro ${fecha}`);
    }

    // Un mes ÍNTEGRAMENTE futuro debe devolver un mapa vacío (sin ninguna clave).
    const anio = Number(anioMes.slice(0, 4));
    const mes = Number(anioMes.slice(5, 7));
    const anioMesSiguiente = mes === 12 ? `${anio + 1}-01` : `${anio}-${String(mes + 1).padStart(2, '0')}`;
    const globalFuturo = await obtenerCalendarioGlobal(anioMesSiguiente);
    assert(globalFuturo.dias.size === 0, `un mes íntegramente futuro debería dar un mapa vacío, tiene ${globalFuturo.dias.size} claves`);
    assert(
      globalFuturo.resumen.diasCompletos === 0 && globalFuturo.resumen.diasConFaltantes === 0 && globalFuturo.resumen.totalCobradoCentavos === 0,
      'el resumen de un mes íntegramente futuro debería ser todo 0'
    );
  });

  await verificar('LEGACY: obtenerCalendarioGlobal — un mes muy anterior al seed da esperados=0 en todos los días, sin errores', async () => {
    // El seed más antiguo arranca a hoy-60; hoy-400 cae muy por fuera de eso.
    const fechaVieja = sumarDias(hoy(), -400);
    const anioMesViejo = fechaVieja.slice(0, 7);
    const global = await obtenerCalendarioGlobal(anioMesViejo);

    assert(global.dias.size > 0, 'un mes íntegramente pasado (no futuro) debería tener clave para cada uno de sus días');
    for (const [fecha, agg] of global.dias) {
      assert(agg.esperados === 0, `día ${fecha} de un mes anterior al seed debería tener esperados=0, tiene ${agg.esperados}`);
      assert(agg.cumplieron === 0, `día ${fecha} debería tener cumplieron=0`);
      assert(agg.detalle.length === 0, `día ${fecha} debería tener detalle vacío`);
    }
    assert(
      global.resumen.diasCompletos === 0 && global.resumen.diasConFaltantes === 0 && global.resumen.totalCobradoCentavos === 0,
      'el resumen de un mes sin ningún cliente activo debería ser todo 0'
    );
  });

  // LEGACY (retirado en v2, ver §2.9/STORY) — Sección 12, items (1)-(4):
  // frecuencia de cobro configurable (§2.8, DIARIA/SEMANAL/MENSUAL). Protegen
  // calendar.js (sin cambios) contra regresiones en su lógica de "día
  // exigible", que sigue viva ahí aunque la UI ya no la use.
  // ============================================================

  // (1) MENSUAL día 31 en un mes de 30 días -> exigible el día 30 (clamp).
  await verificar('LEGACY: 2.8 (1) — MENSUAL día 31 en abril (30 días) es exigible el día 30', async () => {
    const cuota = 10000;
    const acuerdos = [
      { vigente_desde: '2026-04-01', vigente_hasta: null, monto_cuota_centavos: cuota, frecuencia: 'MENSUAL', dia_mes: 31, dia_semana: null },
    ];
    const movimientos = [{ tipo: 'ABONO', monto_centavos: cuota, fecha: '2026-04-30' }];
    const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-04-01', '2026-04-30');
    compararMapaEstados(estados, {
      '2026-04-01': Estado.SIN_OBLIGACION,
      '2026-04-15': Estado.SIN_OBLIGACION,
      '2026-04-29': Estado.SIN_OBLIGACION,
      '2026-04-30': Estado.PAGADO,
    });
  });

  // (2) SEMANAL que no paga 2 viernes seguidos -> deuda de 2 cuotas acumuladas.
  // Prueba numérica: tras los 2 viernes impagos (arrastre = -2*cuota), un
  // adelanto de 10 cuotas en el 3er viernes deja EXACTAMENTE 7 viernes en
  // GRACIA_ADELANTO antes de volver a DEUDA (si solo se hubiera debido 1
  // cuota en vez de 2, serían 8 — la cuenta exacta demuestra la magnitud).
  await verificar('LEGACY: 2.8 (2) — SEMANAL con 2 viernes impagos acumula deuda de exactamente 2 cuotas', async () => {
    const cuota = 10000;
    const acuerdos = [
      { vigente_desde: '2026-01-02', vigente_hasta: null, monto_cuota_centavos: cuota, frecuencia: 'SEMANAL', dia_semana: 5, dia_mes: null },
    ];
    const movimientos = [{ tipo: 'ABONO', monto_centavos: cuota * 10, fecha: '2026-01-16' }];
    const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-02', '2026-03-13');
    compararMapaEstados(estados, {
      '2026-01-02': Estado.DEUDA, // viernes 1, impago
      '2026-01-05': Estado.SIN_OBLIGACION, // lunes: no exigible
      '2026-01-09': Estado.DEUDA, // viernes 2, impago
      '2026-01-16': Estado.PAGADO, // viernes 3, adelanto de 10 cuotas
      '2026-01-23': Estado.GRACIA_ADELANTO, // viernes 4 (1er viernes de gracia)
      '2026-02-27': Estado.GRACIA_ADELANTO, // viernes 9 (7º y último viernes de gracia)
      '2026-03-06': Estado.GRACIA_ADELANTO, // viernes 10 (7º y último viernes de gracia, borde disponible==cuota)
      '2026-03-13': Estado.DEUDA, // viernes 11: la gracia ya se agotó
    });
  });

  // (3) SEMANAL con pago doble la semana previa -> viernes siguiente en GRACIA_ADELANTO.
  await verificar('LEGACY: 2.8 (3) — SEMANAL con pago doble deja el viernes siguiente en GRACIA_ADELANTO', async () => {
    const cuota = 10000;
    const acuerdos = [
      { vigente_desde: '2026-01-02', vigente_hasta: null, monto_cuota_centavos: cuota, frecuencia: 'SEMANAL', dia_semana: 5, dia_mes: null },
    ];
    const movimientos = [{ tipo: 'ABONO', monto_centavos: cuota * 2, fecha: '2026-01-02' }];
    const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-02', '2026-01-09');
    compararMapaEstados(estados, {
      '2026-01-02': Estado.PAGADO,
      '2026-01-09': Estado.GRACIA_ADELANTO,
    });
  });

  // (4) Cambio DIARIA -> SEMANAL a mitad de mes, arrastre continuo (no se reinicia).
  await verificar('LEGACY: 2.8 (4) — cambio DIARIA->SEMANAL a mitad de mes mantiene el arrastre continuo', async () => {
    const acuerdos = [
      { vigente_desde: '2026-01-01', vigente_hasta: '2026-01-15', monto_cuota_centavos: 10000, frecuencia: 'DIARIA', dia_semana: null, dia_mes: null },
      { vigente_desde: '2026-01-16', vigente_hasta: null, monto_cuota_centavos: 10000, frecuencia: 'SEMANAL', dia_semana: 5, dia_mes: null },
    ];
    const movimientos = rango('2026-01-01', '2026-01-14').map((fecha) => ({ tipo: 'ABONO', monto_centavos: 10000, fecha }));
    movimientos.push({ tipo: 'ABONO', monto_centavos: 30000, fecha: '2026-01-15' }); // último día DIARIA: adelanta 2 cuotas extra
    const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-01', '2026-01-23');
    compararMapaEstados(estados, {
      '2026-01-01': Estado.PAGADO,
      '2026-01-14': Estado.PAGADO,
      '2026-01-15': Estado.PAGADO, // último día de la fase DIARIA
      '2026-01-16': Estado.GRACIA_ADELANTO, // 1er viernes de la fase SEMANAL: usa el arrastre heredado (20000), no se reinicia
      '2026-01-17': Estado.SIN_OBLIGACION, // sábado: ya no exigible (SEMANAL)
      '2026-01-20': Estado.SIN_OBLIGACION, // martes: no exigible
      '2026-01-22': Estado.SIN_OBLIGACION, // jueves: no exigible
      '2026-01-23': Estado.GRACIA_ADELANTO, // 2do viernes: arrastre 20000 -> 10000 -> 0, todavía cubre
    });
  });

  // NOTA — item retirado del protocolo original: "2.8 (7) resumenDia solo
  // incluye clientes con cobro exigible hoy" se ELIMINÓ (no se movió a
  // LEGACY) al pivotar a §2.9: probaba un comportamiento de cara a la UI de
  // la pantalla "Hoy", que ya no existe y no tiene ningún consumidor —
  // mantenerlo no protege historia ni migración, solo prueba código muerto
  // por probarlo. resumenDia() sigue funcional y cubierto por la Sección 6b
  // (BUG arrastreInicial), que sí protege integridad histórica real.

  // ============================================================
  // Sección 17 — §2.12 (ROUND 5, gate del dueño 30-ago-2026): registros a
  // futuro (adelantos). Va DESPUÉS de las secciones LEGACY que iteran TODOS
  // los clientes activos (para no ensuciar sus conteos con clientes de
  // prueba) y ANTES de las migraciones/iniciarModoReal (destructivas, no debe
  // depender de nada de acá).
  // ============================================================

  const conceptoFuturo = await crearConcepto({ nombre: 'Agua' }); // idempotente
  const futuroCorto = sumarDias(hoy(), 3); // puede caer en el mes siguiente, a propósito
  const futuroLejano = sumarDias(hoy(), 10);

  await verificar('§2.12: registrarCargo y registrarAbono ACEPTAN fecha futura (adelantos)', async () => {
    const cliente = await crearCliente({ nombre: 'Cliente Futuro Acepta Verify' });
    const cargo = await registrarCargo({ cliente_id: cliente.id, monto_centavos: 4000, fecha: futuroCorto, concepto: conceptoFuturo.nombre });
    assert(cargo.fecha === futuroCorto, 'el CARGO a futuro debería guardarse con la fecha futura exacta, sin rechazo');

    const abono = await registrarAbono({ cliente_id: cliente.id, monto_centavos: 2500, fecha: futuroLejano });
    assert(abono.fecha === futuroLejano, 'el ABONO a futuro debería guardarse con la fecha futura exacta, sin rechazo');
  });

  await verificar('§2.12: registrarVisitaSinAbono SIGUE bloqueando fecha futura (guard sin cambios — no es dinero)', async () => {
    const cliente = await crearCliente({ nombre: 'Cliente Futuro VisitaBloqueada Verify' });
    let lanzo = false;
    try {
      await registrarVisitaSinAbono({ cliente_id: cliente.id, fecha: futuroCorto });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'VALIDATION_ERROR', `code esperado VALIDATION_ERROR, recibido ${e.code}`);
    }
    assert(lanzo, 'registrarVisitaSinAbono debería seguir rechazando fecha futura tras §2.12 (solo se desbloqueó dinero, no visitas)');
  });

  await verificar('§2.12: obtenerCalendarioMovimientos incluye el día futuro con movimientos, y saldoAcumuladoCentavos sigue acumulando a través de él', async () => {
    const cliente = await crearCliente({ nombre: 'Cliente Futuro Calendario Persona Verify' });
    await registrarCargo({ cliente_id: cliente.id, monto_centavos: 10000, fecha: hoy(), concepto: conceptoFuturo.nombre });
    const saldoAntesDelFuturo = await calcularSaldo(cliente.id, hoy());

    const anioMesFuturo = futuroLejano.slice(0, 7);
    await registrarAbono({ cliente_id: cliente.id, monto_centavos: 3000, fecha: futuroLejano });

    const { dias } = await obtenerCalendarioMovimientos(cliente.id, anioMesFuturo);
    const diaFuturo = dias.get(futuroLejano);
    assert(diaFuturo, `el día futuro ${futuroLejano} debería estar presente en el mapa (tiene un ABONO)`);
    assert(diaFuturo.abonosCentavos === 3000, `abonosCentavos del día futuro debería ser 3000, es ${diaFuturo.abonosCentavos}`);
    assert(
      diaFuturo.saldoAcumuladoCentavos === saldoAntesDelFuturo - 3000,
      `saldoAcumuladoCentavos del día futuro debería seguir la cronología (restar el abono futuro): esperado ${saldoAntesDelFuturo - 3000}, obtenido ${diaFuturo.saldoAcumuladoCentavos}`
    );
  });

  await verificar('§2.12: obtenerCalendarioGlobalMovimientos incluye días futuros CON movimientos en dias y en totalesMes; futuro vacío se omite del mapa', async () => {
    const cliente = await crearCliente({ nombre: 'Cliente Futuro Calendario Global Verify' });
    const anioMesFuturo = futuroLejano.slice(0, 7);
    await registrarAbono({ cliente_id: cliente.id, monto_centavos: 7500, fecha: futuroLejano });

    const { dias, totalesMes } = await obtenerCalendarioGlobalMovimientos(anioMesFuturo);
    const diaFuturo = dias.get(futuroLejano);
    assert(diaFuturo, `el día futuro ${futuroLejano} con movimientos debería estar en el mapa global`);
    assert(
      diaFuturo.movimientos.some((m) => m.cliente_id === cliente.id && m.tipo === 'ABONO' && m.montoCentavos === 7500),
      'el ABONO futuro del cliente de prueba debería aparecer en el desglose de ese día'
    );

    const resumenCruzado = await resumenMensual(anioMesFuturo);
    assert(
      totalesMes.abonosCentavos === resumenCruzado.totalAbonosCentavos,
      'totalesMes.abonosCentavos (con futuro incluido) debería seguir coincidiendo con resumenMensual'
    );

    // día futuro SIN movimientos: distinto día del mismo mes futuro, no debería ensuciar el mapa
    let otroDiaFuturoVacio = sumarDias(futuroLejano, -1);
    if (otroDiaFuturoVacio.slice(0, 7) !== anioMesFuturo) otroDiaFuturoVacio = sumarDias(futuroLejano, 1);
    if (otroDiaFuturoVacio.slice(0, 7) === anioMesFuturo && otroDiaFuturoVacio !== futuroLejano) {
      assert(!dias.has(otroDiaFuturoVacio), `un día futuro SIN movimientos (${otroDiaFuturoVacio}) no debería entrar al mapa`);
    }
  });

  await verificar(
    '§2.12: saldo_centavos es TOTAL (incluye futuro) en listarClientesAgrupados, listarClientes Y listarClientesArchivados — bug encontrado y corregido en las 3 (las 3 recortaban a "hoy", contradiciendo "saldo incluye TODOS los movimientos")',
    async () => {
      const cliente = await crearCliente({ nombre: 'Cliente Futuro SaldoTotal Verify' });
      await registrarCargo({ cliente_id: cliente.id, monto_centavos: 8800, fecha: futuroLejano, concepto: conceptoFuturo.nombre });

      const saldoHastaHoy = await calcularSaldo(cliente.id, hoy());
      assert(saldoHastaHoy === 0, 'calcularSaldo(hoy) NO debería contar un cargo fechado a futuro (respeta el corte que se le pide explícitamente)');

      const { grupos } = await listarClientesAgrupados({ busqueda: 'Cliente Futuro SaldoTotal Verify' });
      const filaAgrupados = grupos.flatMap((g) => g.clientes).find((c) => c.id === cliente.id);
      assert(filaAgrupados, 'debería encontrar al cliente de prueba en listarClientesAgrupados');
      assert(
        filaAgrupados.saldo_centavos === 8800,
        `saldo_centavos de listarClientesAgrupados debería ser el TOTAL incluyendo el cargo futuro (8800), es ${filaAgrupados.saldo_centavos}`
      );

      const { clientes: listaPlana } = await listarClientes({ busqueda: 'Cliente Futuro SaldoTotal Verify' });
      assert(listaPlana.length === 1, 'debería encontrar al cliente de prueba en listarClientes');
      assert(
        listaPlana[0].saldo_centavos === 8800,
        `saldo_centavos de listarClientes debería ser el TOTAL incluyendo el cargo futuro (8800), es ${listaPlana[0].saldo_centavos}`
      );

      await borrarClienteLogico(cliente.id, { forzar: true });
      const archivados = await listarClientesArchivados();
      const filaArchivada = archivados.find((a) => a.id === cliente.id);
      assert(filaArchivada, 'debería encontrar al cliente de prueba (ya archivado) en listarClientesArchivados');
      assert(
        filaArchivada.saldo_centavos === 8800,
        `saldo_centavos de listarClientesArchivados debería ser el TOTAL incluyendo el cargo futuro (8800), es ${filaArchivada.saldo_centavos}`
      );
    }
  );

  await verificar('§2.12: listarClientesAgrupados({fecha futura}) — estado_dia=FUTURO si no hay registro, ABONO si sí; resumenDia con conteos null + esFuturo:true', async () => {
    const clienteConAbono = await crearCliente({ nombre: 'Cliente FuturoDia ConAbono Verify' });
    const clienteSinNada = await crearCliente({ nombre: 'Cliente FuturoDia SinNada Verify' });
    await registrarAbono({ cliente_id: clienteConAbono.id, monto_centavos: 1500, fecha: futuroCorto });

    const { grupos, resumenDia } = await listarClientesAgrupados({ fecha: futuroCorto, busqueda: 'Cliente FuturoDia' });
    const todos = grupos.flatMap((g) => g.clientes);
    const filaConAbono = todos.find((c) => c.id === clienteConAbono.id);
    const filaSinNada = todos.find((c) => c.id === clienteSinNada.id);

    assert(filaConAbono, 'debería encontrar al cliente con abono futuro');
    assert(filaSinNada, 'debería encontrar al cliente sin nada ese día futuro');
    assert(filaConAbono.estado_dia === 'ABONO', `un abono futuro SÍ registrado debería dar estado_dia=ABONO, dio ${filaConAbono.estado_dia}`);
    assert(
      filaSinNada.estado_dia === 'FUTURO',
      `sin registro en un día futuro, estado_dia debería ser el valor neutro 'FUTURO' (NO 'SIN_VISITA' — ese semáforo no aplica a futuro), dio ${filaSinNada.estado_dia}`
    );

    assert(resumenDia.esFuturo === true, 'resumenDia.esFuturo debería ser true para una fecha futura');
    assert(resumenDia.abonaron === null, 'resumenDia.abonaron debería ser null (null honesto) para fecha futura');
    assert(resumenDia.dijeronNo === null, 'resumenDia.dijeronNo debería ser null para fecha futura');
    assert(resumenDia.sinVisitar === null, 'resumenDia.sinVisitar debería ser null para fecha futura');
    assert(
      resumenDia.cobradoCentavos === 1500,
      `resumenDia.cobradoCentavos SÍ debería reflejar lo registrado (1500) incluso a futuro, es ${resumenDia.cobradoCentavos}`
    );
  });

  await verificar('§2.12: listarClientesAgrupados({fecha: hoy}) conserva esFuturo:false y conteos numéricos reales (no rompe el contrato de Round 4)', async () => {
    const { resumenDia } = await listarClientesAgrupados({ fecha: hoy() });
    assert(resumenDia.esFuturo === false, 'resumenDia.esFuturo debería ser false para hoy');
    assert(typeof resumenDia.abonaron === 'number', 'resumenDia.abonaron debería seguir siendo un número para hoy (no null)');
    assert(typeof resumenDia.dijeronNo === 'number', 'resumenDia.dijeronNo debería seguir siendo un número para hoy');
    assert(typeof resumenDia.sinVisitar === 'number', 'resumenDia.sinVisitar debería seguir siendo un número para hoy');
  });

  // ============================================================
  // Migraciones de esquema (VIGENTES — no son legacy: siguen siendo la única
  // forma de que una base local vieja o un respaldo antiguo lleguen a v3).
  // Ambos tests son DESTRUCTIVOS (importarRespaldo reemplaza toda la DB
  // activa) y van al FINAL de la suite, antes solo de A-002.
  // ============================================================

  await verificar('Migración v2->v3: importarRespaldo() siembra conceptos desde servicio y backfillea orden', async () => {
    const clienteId = uuidV7();
    const acuerdoId = uuidV7();
    const movimientoId = uuidV7();
    const dbV2 = crearDbV2VaciaConDatos({ clienteId, acuerdoId, movimientoId, fechaAcuerdo: '2026-02-01' });
    const bytes = dbV2.export();
    dbV2.close();
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    await importarRespaldo(arrayBuffer);
    assert(esModoDemo() === false, 'URGENTE: importarRespaldo() debería seguir marcando modo_demo=0 (no reactiva D1)');

    const { clientes } = await listarClientes({ busqueda: 'Cliente Migracion V2 Verify', tamanioPagina: 5 });
    assert(clientes.length === 1, 'el cliente del respaldo v2 debería existir tras importar');
    const clienteMigrado = clientes[0];
    assert(clienteMigrado.id === clienteId, 'el id del cliente importado debería coincidir con el del archivo v2');
    assert(clienteMigrado.categoria_id === null, 'un cliente v2 migrado debería quedar sin categoría');
    assert(Number.isInteger(clienteMigrado.orden), `orden debería backfillearse como entero, es ${clienteMigrado.orden}`);

    const conceptos = await listarConceptos();
    assert(
      conceptos.some((c) => c.nombre === 'Renta'),
      'la migración debería sembrar el concepto "Renta" desde movimientos.servicio del respaldo v2'
    );

    const dbInterna = _dbInternaParaVerificacion();
    const filaVersion = dbInterna.exec("SELECT valor FROM meta WHERE clave='schema_version'");
    assert(filaVersion.length && filaVersion[0].values[0][0] === SCHEMA_VERSION, `schema_version tras importar debería ser ${SCHEMA_VERSION}`);

    const stmtMov = dbInterna.prepare('SELECT COUNT(*) AS c FROM movimientos WHERE id = ?');
    stmtMov.bind([movimientoId]);
    stmtMov.step();
    assert(stmtMov.getAsObject().c === 1, 'el movimiento original (CARGO "Renta") debería seguir intacto tras la migración');
    stmtMov.free();
  });

  await verificar('Migración v1->v3 (encadenada): importarRespaldo() acepta un archivo v1 y preserva todo', async () => {
    const clienteId = uuidV7();
    const acuerdoId = uuidV7();
    const movimientoId = uuidV7();
    const dbV1 = crearDbV1VaciaConDatos({ clienteId, acuerdoId, movimientoId, fechaAcuerdo: '2026-01-01' });
    const bytes = dbV1.export();
    dbV1.close();
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    await importarRespaldo(arrayBuffer);
    assert(esModoDemo() === false, 'URGENTE: importarRespaldo() debería seguir marcando modo_demo=0 (no reactiva D1)');

    const { clientes } = await listarClientes({ busqueda: 'Cliente Migracion V1 Verify', tamanioPagina: 5 });
    assert(clientes.length === 1, 'el cliente del respaldo v1 debería existir tras importar');
    assert(clientes[0].id === clienteId, 'el id del cliente importado debería coincidir con el del archivo v1');
    assert(clientes[0].categoria_id === null, 'un cliente v1 migrado debería quedar sin categoría');
    assert(Number.isInteger(clientes[0].orden), `orden debería backfillearse como entero, es ${clientes[0].orden}`);

    const acuerdosCliente = await listarAcuerdos(clienteId);
    assert(acuerdosCliente.length === 1, 'el acuerdo del respaldo v1 debería existir tras importar');
    assert(acuerdosCliente[0].frecuencia === 'DIARIA', `el acuerdo migrado debería tener frecuencia DIARIA, tiene ${acuerdosCliente[0].frecuencia}`);

    const dbInterna = _dbInternaParaVerificacion();
    const filaVersion = dbInterna.exec("SELECT valor FROM meta WHERE clave='schema_version'");
    assert(
      filaVersion.length && filaVersion[0].values[0][0] === SCHEMA_VERSION,
      `schema_version tras importar debería ser ${SCHEMA_VERSION}`
    );
  });

  await verificar('Migración v3->v4 (§2.11): importarRespaldo() crea visitas_sin_abono vacía y preserva todo lo demás', async () => {
    const clienteId = uuidV7();
    const categoriaId = uuidV7();
    const movimientoId = uuidV7();
    const dbV3 = crearDbV3VaciaConDatos({ clienteId, categoriaId, movimientoId, fecha: '2026-03-05' });
    const bytes = dbV3.export();
    dbV3.close();
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    await importarRespaldo(arrayBuffer);
    assert(esModoDemo() === false, 'URGENTE: importarRespaldo() debería seguir marcando modo_demo=0 (no reactiva D1)');

    const dbInterna = _dbInternaParaVerificacion();
    const filas = dbInterna.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;");
    const nombres = filas.length ? filas[0].values.map((v) => v[0]) : [];
    assert(nombres.includes('visitas_sin_abono'), 'tras migrar v3->v4 debería existir la tabla visitas_sin_abono');

    const stmtCount = dbInterna.prepare('SELECT COUNT(*) AS c FROM visitas_sin_abono');
    stmtCount.step();
    assert(stmtCount.getAsObject().c === 0, 'visitas_sin_abono debería nacer vacía tras la migración');
    stmtCount.free();

    const filaVersion = dbInterna.exec("SELECT valor FROM meta WHERE clave='schema_version'");
    assert(filaVersion.length && filaVersion[0].values[0][0] === SCHEMA_VERSION, `schema_version tras importar debería ser ${SCHEMA_VERSION}`);

    const { clientes } = await listarClientes({ busqueda: 'Cliente Migracion V3 Verify', tamanioPagina: 5 });
    assert(clientes.length === 1, 'el cliente del respaldo v3 debería existir tras importar');
    assert(clientes[0].id === clienteId, 'el id del cliente importado debería coincidir con el del archivo v3');
    assert(clientes[0].categoria_id === categoriaId, 'la categoría del cliente v3 debería preservarse (v3->v4 no la toca)');

    const stmtMov = dbInterna.prepare('SELECT COUNT(*) AS c FROM movimientos WHERE id = ?');
    stmtMov.bind([movimientoId]);
    stmtMov.step();
    assert(stmtMov.getAsObject().c === 1, 'el movimiento original debería seguir intacto tras migrar v3->v4');
    stmtMov.free();

    // la tabla nueva ya es funcional de punta a punta tras la migración
    const visita = await registrarVisitaSinAbono({ cliente_id: clienteId, fecha: hoy() });
    assert(visita && visita.id, 'registrarVisitaSinAbono debería funcionar sobre una DB recién migrada v3->v4');
  });

  // ============================================================
  // Sección 16 — URGENTE (bloqueante de producción, 30-ago-2026): iniciarModoReal.
  // DESTRUCTIVA (borra TODA la base activa) — va al final, después de las
  // migraciones, por la MISMA razón que ellas: nada después de este bloque
  // puede depender de que la base activa siga teniendo datos (excepto A-002,
  // que inspecciona la base de DEMO por separado, no la de este ?verify=1).
  // ============================================================

  await verificar(
    'iniciarModoReal: borra TODOS los datos, deja esquema v4 vacío, modo_demo=0, y persiste DE INMEDIATO (sin el debounce de 500ms)',
    async () => {
      // Precondición forzada explícitamente (NO se asume el estado dejado por tests
      // anteriores — este bloque corre después de las migraciones destructivas de
      // arriba, que ya dejan modo_demo=0 por su cuenta): se fuerza modo_demo=1 por SQL
      // directo para simular honestamente "la base demo real que el gestor viene usando".
      const dbSetup = _dbInternaParaVerificacion();
      dbSetup.run("UPDATE meta SET valor='1' WHERE clave='modo_demo'");
      assert(esModoDemo() === true, 'setup del test: se forzó modo_demo=1 y esModoDemo() debería reflejarlo');

      // crearConcepto es idempotente — necesario porque este bloque corre DESPUÉS de
      // las migraciones destructivas de arriba, cuyas bases candidatas hechas a mano
      // (DDL_V2/V3_LITERAL) no siembran el catálogo `conceptos` como sí lo hace generarSeed().
      const conceptoTemp = await crearConcepto({ nombre: 'Agua' });
      const catTemp = await crearCategoria({ nombre: 'CategoriaModoReal Verify', color: 'amarillo' });
      const clienteTemp = await crearCliente({ nombre: 'Cliente ModoReal Verify', categoria_id: catTemp.id });
      await registrarCargo({ cliente_id: clienteTemp.id, monto_centavos: 5000, fecha: hoy(), concepto: conceptoTemp.nombre });

      await iniciarModoReal();

      assert(esModoDemo() === false, 'tras iniciarModoReal, esModoDemo() debería ser false');

      const dbInterna = _dbInternaParaVerificacion();
      for (const tabla of ['clientes', 'acuerdos', 'movimientos', 'categorias', 'conceptos', 'visitas_sin_abono']) {
        const stmt = dbInterna.prepare(`SELECT COUNT(*) AS c FROM ${tabla}`);
        stmt.step();
        const c = stmt.getAsObject().c;
        stmt.free();
        assert(c === 0, `la tabla ${tabla} debería quedar completamente vacía tras iniciarModoReal, tiene ${c} filas`);
      }

      const filaVersion = dbInterna.exec("SELECT valor FROM meta WHERE clave='schema_version'");
      assert(
        filaVersion.length && filaVersion[0].values[0][0] === SCHEMA_VERSION,
        `schema_version NO debería tocarse por iniciarModoReal, debería seguir siendo ${SCHEMA_VERSION}`
      );

      const { clientes: clientesTrasBorrar } = await listarClientes({});
      assert(clientesTrasBorrar.length === 0, 'listarClientes() debería devolver vacío tras iniciarModoReal');
      const archivadosTrasBorrar = await listarClientesArchivados();
      assert(archivadosTrasBorrar.length === 0, 'listarClientesArchivados() también debería devolver vacío tras iniciarModoReal');

      // Persistencia INMEDIATA (persistirInmediato, sin debounce): leyendo directo de
      // IndexedDB justo después de que el await se resuelve, sin esperar nada más, ya
      // debería reflejar la base vacía — si esto usara el debounce de 500ms de
      // persistirEnIndexedDB(), este chequeo (sin ningún setTimeout de por medio)
      // fallaría de forma intermitente/real leyendo el snapshot viejo (con datos).
      const idb = await new Promise((resolve, reject) => {
        const req = indexedDB.open('agus-db-verify', 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const bytesPersistidos = await new Promise((resolve, reject) => {
        const tx = idb.transaction('archivos', 'readonly');
        const req = tx.objectStore('archivos').get('sqlite-principal');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      idb.close();
      assert(bytesPersistidos, 'debería haber bytes ya persistidos en IndexedDB (agus-db-verify) inmediatamente tras el await');

      const DatabaseCtor = dbInterna.constructor;
      const dbDesdeDisco = new DatabaseCtor(bytesPersistidos);
      try {
        const stmtDisco = dbDesdeDisco.prepare('SELECT COUNT(*) AS c FROM clientes');
        stmtDisco.step();
        const cDisco = stmtDisco.getAsObject().c;
        stmtDisco.free();
        assert(
          cDisco === 0,
          `la persistencia debería ser INMEDIATA (sin debounce): el archivo en IndexedDB ya debería reflejar 0 clientes justo después del await, tiene ${cDisco}`
        );
        const filaVersionDisco = dbDesdeDisco.exec("SELECT valor FROM meta WHERE clave='modo_demo'");
        assert(
          filaVersionDisco.length && filaVersionDisco[0].values[0][0] === '0',
          'el archivo persistido en IndexedDB también debería tener modo_demo=0 (no solo la copia en memoria)'
        );
      } finally {
        dbDesdeDisco.close();
      }
    }
  );

  await verificar(
    'URGENTE/D1: con modo_demo=0, el re-seed anti-congelamiento NO dispara — ni con la base vacía (iniciarModoReal) ni con movimientos viejos',
    async () => {
      assert(esModoDemo() === false, 'depende del test anterior: iniciarModoReal ya debería haber dejado modo_demo=0');

      // Caso A: base vacía (estado exacto que deja iniciarModoReal). Si el guard de
      // modo_demo se rompiera, esto la re-sembraría con los 12 clientes de generarSeed().
      await _revisarReSembradoAntiCongelamientoParaVerificacion();
      const { clientes: trasVacia } = await listarClientes({});
      assert(trasVacia.length === 0, 'con base vacía y modo_demo=0 NO debería re-sembrar (el heurístico D1 está condicionado a modo_demo=1)');

      // Caso B: movimientos VIEJOS (fecha muy vencida) — el heurístico D1 solo mira
      // MAX(fecha) < ayer, que acá SÍ se cumple; lo único que debe bloquearlo es modo_demo=0.
      // iniciarModoReal() (test anterior) también vació `conceptos` — hay que re-crearlo.
      const conceptoViejo = await crearConcepto({ nombre: 'Agua' });
      const clienteViejo = await crearCliente({ nombre: 'Cliente D1 MovimientoViejo Verify' });
      await registrarCargo({ cliente_id: clienteViejo.id, monto_centavos: 1000, fecha: '2020-01-01', concepto: conceptoViejo.nombre });
      assert(esModoDemo() === false, 'modo_demo debería seguir en 0 (nada en este flujo lo vuelve a setear en 1)');

      await _revisarReSembradoAntiCongelamientoParaVerificacion();

      const { clientes: trasViejo } = await listarClientes({ busqueda: 'Cliente D1 MovimientoViejo Verify' });
      assert(
        trasViejo.length === 1,
        'con modo_demo=0, un movimiento viejo NO debería disparar el re-seed (el cliente real de prueba debería seguir existiendo intacto)'
      );
    }
  );

  await verificar('exportarRespaldo() funciona sobre una base real recién vaciada por iniciarModoReal', async () => {
    const { blob, nombreArchivo } = await exportarRespaldo();
    assert(blob instanceof Blob, 'exportarRespaldo() debería devolver un Blob incluso con la base sin datos de negocio');
    assert(blob.size > 0, 'el blob exportado no debería estar vacío (sigue siendo un sqlite válido: esquema + meta)');
    assert(typeof nombreArchivo === 'string' && nombreArchivo.endsWith('.sqlite'), 'debería devolver un nombre de archivo .sqlite');
  });

  // ============================================================
  // Sección 10 — A-002 (auditoría independiente): ?verify=1 NO debe
  // contaminar la base de demo. Toda esta corrida escribió sobre una base de
  // IndexedDB aislada (NOMBRE_DB_INDEXEDDB_VERIFY); acá se confirma leyendo
  // la base de demo de forma independiente que sigue sin clientes "Verify".
  // ============================================================
  await verificar('A-002: la DB de demo no contiene ningún cliente "Verify" tras correr la suite', async () => {
    const contaminados = await _leerClientesVerifyEnDemo();
    assert(
      contaminados.length === 0,
      `la base de demo tiene ${contaminados.length} cliente(s) "Verify": ${contaminados.join(', ')}`
    );
  });

  console.groupEnd();

  const totalTests = resultados.length;
  const fallidos = resultados.filter((r) => !r.ok);
  const resumen = `${totalTests - fallidos.length}/${totalTests} PASS`;
  if (fallidos.length === 0) {
    console.log('%c' + resumen + ' — TODO OK', 'font-weight:bold;color:#1a7f37;font-size:13px');
  } else {
    console.error(`${resumen} — ${fallidos.length} FAIL: ${fallidos.map((f) => f.nombre).join(' | ')}`);
  }

  renderizarResultados(resultados, resumen);
  return resultados;
}

function renderizarResultados(resultados, resumen) {
  const appEl = document.getElementById('app') || document.body;
  const contenedor = document.createElement('div');
  contenedor.id = 'dev-verify-resultados';
  contenedor.style.cssText = 'font-family: monospace; font-size: 12px; padding: 12px; white-space: pre-wrap;';

  const lineas = resultados.map((r) => `[${r.ok ? 'PASS' : 'FAIL'}] ${r.nombre}${r.detalle ? ' — ' + r.detalle : ''}`);
  const encabezado = `=== Verificación dev-verify.js ===\n${resumen}\n\n`;
  contenedor.textContent = encabezado + lineas.join('\n');

  const previo = document.getElementById('dev-verify-resultados');
  if (previo) previo.remove();
  appEl.appendChild(contenedor);
}
