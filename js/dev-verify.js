// Script de verificación en vivo (?verify=1). Corre en el navegador contra la
// DB real (sql.js + IndexedDB) y reporta PASS/FAIL en consola y en el DOM.
// Filosofía del plan: "lo que no se verificó ejecutando, no está hecho."

import {
  initDb,
  crearClienteConAcuerdo,
  registrarCargo,
  registrarAbono,
  registrarAjuste,
  calcularSaldo,
  crearAcuerdo,
  listarAcuerdos,
  obtenerAcuerdoVigente,
  listarClientes,
  obtenerEstadoCalendario,
  resumenDia,
  resumenMensual,
  borrarClienteLogico,
  obtenerCalendarioGlobal,
  importarRespaldo,
  _dbInternaParaVerificacion,
  _leerClientesVerifyEnDemo,
} from './db.js';
import { calcularEstadosCalendario, Estado } from './calendar.js';
import { generarSeed } from './seed.js';
import { SCHEMA_VERSION, MIGRACION_V1_A_V2 } from './schema.js';
import { hoy, sumarDias, rango, diaDeSemana } from './utils/date.js';
import { uuidV7 } from './utils/uuid.js';
import { parsearAPesos, formatearCentavos } from './utils/money.js';

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
  // Sección 2 — crearClienteConAcuerdo válido/inválido
  // ============================================================
  let clienteTestId = null;

  await verificar('crearClienteConAcuerdo con datos válidos crea cliente + acuerdo', async () => {
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
    clienteTestId = r.cliente.id;
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
    const { cliente } = await crearClienteConAcuerdo({
      nombre: 'Cliente A005 TieneMovimientos Verify',
      monto_cuota_centavos: 1000,
      vigente_desde: hoy(),
    });

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
  // Sección 3 — registrarCargo / registrarAbono / registrarAjuste
  // ============================================================
  await verificar('registrarCargo válido se guarda con tipo CARGO', async () => {
    const mov = await registrarCargo({
      cliente_id: clienteTestId,
      monto_centavos: 5000,
      fecha: hoy(),
      servicio: 'AGUA',
      referencia: 'X-1',
      nota: 'test',
    });
    assert(mov.tipo === 'CARGO' && mov.monto_centavos === 5000, 'cargo no se guardó como se esperaba');
  });

  await verificar('registrarCargo con servicio inválido lanza VALIDATION_ERROR', async () => {
    let lanzo = false;
    try {
      await registrarCargo({ cliente_id: clienteTestId, monto_centavos: 5000, fecha: hoy(), servicio: 'NO_EXISTE' });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'VALIDATION_ERROR');
    }
    assert(lanzo);
  });

  await verificar('registrarCargo con fecha futura lanza VALIDATION_ERROR', async () => {
    let lanzo = false;
    try {
      await registrarCargo({ cliente_id: clienteTestId, monto_centavos: 5000, fecha: sumarDias(hoy(), 1), servicio: 'AGUA' });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'VALIDATION_ERROR');
    }
    assert(lanzo);
  });

  await verificar('registrarCargo con cliente inexistente lanza NOT_FOUND', async () => {
    let lanzo = false;
    try {
      await registrarCargo({ cliente_id: 'no-existe', monto_centavos: 5000, fecha: hoy(), servicio: 'AGUA' });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'NOT_FOUND');
    }
    assert(lanzo);
  });

  let abonoTestId = null;
  await verificar('registrarAbono válido se guarda con tipo ABONO', async () => {
    const mov = await registrarAbono({ cliente_id: clienteTestId, monto_centavos: 3000, fecha: hoy(), nota: 'abono test' });
    assert(mov.tipo === 'ABONO' && mov.monto_centavos === 3000, 'abono no se guardó como se esperaba');
    abonoTestId = mov.id;
  });

  await verificar('registrarAbono con monto negativo lanza VALIDATION_ERROR', async () => {
    let lanzo = false;
    try {
      await registrarAbono({ cliente_id: clienteTestId, monto_centavos: -100, fecha: hoy() });
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
  // Sección 4 — calcularSaldo contra un caso calculado a mano
  //   CARGO 5000 - ABONO 3000 + AJUSTE(-500) + AJUSTE(+100) = 5000-3000-500+100 = 1600
  // ============================================================
  await verificar('calcularSaldo coincide con el cálculo manual (1600 centavos)', async () => {
    const saldo = await calcularSaldo(clienteTestId);
    assert(saldo === 1600, `saldo esperado 1600, obtenido ${saldo}`);
  });

  // ============================================================
  // Sección 5 — regla mismo-día de crearAcuerdo (R-004)
  // ============================================================
  await verificar('crearAcuerdo el mismo día reemplaza al abierto (sin violar CHECK)', async () => {
    const hoyStr = hoy();
    const primero = await crearAcuerdo({ cliente_id: clienteTestId, monto_cuota_centavos: 2000, vigente_desde: hoyStr });
    const segundo = await crearAcuerdo({ cliente_id: clienteTestId, monto_cuota_centavos: 2500, vigente_desde: hoyStr });
    const vigente = await obtenerAcuerdoVigente(clienteTestId, hoyStr);
    assert(vigente.id === segundo.id, 'el acuerdo vigente debería ser el segundo (el que reemplaza)');
    assert(vigente.monto_cuota_centavos === 2500, 'la cuota vigente no es la del segundo acuerdo');
    const historial = await listarAcuerdos(clienteTestId);
    assert(!historial.some((a) => a.id === primero.id), 'el primer acuerdo mismo-día debería quedar excluido del historial (deleted_at)');
  });

  await verificar('crearAcuerdo con vigente_desde anterior al acuerdo abierto lanza VALIDATION_ERROR', async () => {
    let lanzo = false;
    try {
      await crearAcuerdo({ cliente_id: clienteTestId, monto_cuota_centavos: 1000, vigente_desde: sumarDias(hoy(), -100) });
    } catch (e) {
      lanzo = true;
      assert(e.code === 'VALIDATION_ERROR');
    }
    assert(lanzo, 'no lanzó error con vigencia anterior al acuerdo actual');
  });

  // ============================================================
  // Sección 6 — R-001: un CARGO intermedio NO cambia los estados de calendario,
  //   pero SÍ sube calcularSaldo de inmediato.
  // ============================================================
  await verificar('R-001: CARGO intermedio no afecta calendario pero sí el saldo', async () => {
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

    await registrarCargo({ cliente_id: cliente.id, monto_centavos: 20000, fecha: sumarDias(hoy(), -1), servicio: 'LUZ' });

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

  // ============================================================
  // Sección 6b — BUG (Builder B, verificación en vivo): arrastreInicial de
  // obtenerEstadoCalendario()/resumenDia() usaba -calcularSaldo(), que es la
  // fórmula de SALDO del ledger (2.2, incluye CARGO), no la de CUMPLIMIENTO
  // DE CUOTA (2.5, solo ABONO/AJUSTE vs. cuotas exigidas). Un cliente con un
  // tramo histórico bien pagado seguido de un tramo de incumplimiento parecía
  // "a favor" (arrastreInicial gigante y positivo) en vez de en DEUDA, porque
  // el saldo del ledger no resta las cuotas no cobradas de los días sin CARGO.
  // Corregido en PLAN-MVP.md §2.5 (nota del gate 25-ago-2026).
  // ============================================================
  await verificar(
    'BUG arrastreInicial: ventana de calendario a mitad de un tramo de incumplimiento debe salir DEUDA (no GRACIA_ADELANTO)',
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

  await verificar('BUG arrastreInicial: Manuel Torres (caso 4 del seed, DEUDA franca) debe estar en DEUDA hoy', async () => {
    const { clientes } = await listarClientes({ busqueda: 'Manuel Torres', tamanioPagina: 5 });
    assert(clientes.length >= 1, 'no se encontró a "Manuel Torres" en la DB sembrada');
    const manuel = clientes[0];
    const estados = await obtenerEstadoCalendario(manuel.id, hoy(), hoy());
    assert(estados.get(hoy()) === 'DEUDA', `Manuel Torres (DEUDA franca) debería estar en DEUDA hoy, está en ${estados.get(hoy())}`);
  });

  await verificar('BUG arrastreInicial: resumenDia(hoy) también debe marcar a Manuel Torres en DEUDA', async () => {
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

      const { cliente } = await crearClienteConAcuerdo({
        nombre: 'Cliente A001 Dado De Baja Verify',
        monto_cuota_centavos: 1000,
        vigente_desde: hoy(),
      });
      const montoCargo = 12345;
      await registrarCargo({ cliente_id: cliente.id, monto_centavos: montoCargo, fecha: hoy(), servicio: 'AGUA' });

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

  // ============================================================
  // Sección 9 — 6+ casos borde del calendario (calendar.js puro, sección 4.2)
  //   Fechas fijas y sintéticas (no dependen de hoy()) para que el cálculo a
  //   mano sea reproducible.
  // ============================================================

  // Caso A — Adelanto puro: abona 5 cuotas de una vez, no abona los 4 días
  // siguientes → esos 4 días deben pintar GRACIA_ADELANTO, no DEUDA.
  await verificar('Calendario — Adelanto puro (4.2, caso 1)', async () => {
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
  await verificar('Calendario — Pagos parciales acumulados (4.2, caso 2)', async () => {
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
  await verificar('Calendario — Cliente nuevo a mitad de rango, sin herencia de arrastre (4.2, caso 3)', async () => {
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
  await verificar('Calendario — Cambio de cuota, arrastre continuo (4.2, caso 4)', async () => {
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
  await verificar('Calendario — Borde disponible == cuota clasifica GRACIA_ADELANTO (4.2, caso 5)', async () => {
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
  await verificar('Calendario — AJUSTE reduce el crédito efectivo del día (4.2, caso 6)', async () => {
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
  // Sección 11 — Fase 12 (gate del dueño 25-ago-2026, mockup aprobado):
  // obtenerCalendarioGlobal(anioMes) — modo "Todas las personas" de la
  // pestaña Calendario. Reutiliza calcularEstadosCalendario por cliente (vía
  // obtenerEstadoCalendario), no duplica el algoritmo de estados.
  // ============================================================

  await verificar(
    'obtenerCalendarioGlobal: esperados/cumplieron coinciden con obtenerEstadoCalendario cliente por cliente para TODOS los días del mes actual',
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

  await verificar('obtenerCalendarioGlobal: un cliente en GRACIA_ADELANTO hoy cuenta como cumplido', async () => {
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

  await verificar('obtenerCalendarioGlobal: no incluye claves de días futuros', async () => {
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

  await verificar('obtenerCalendarioGlobal: un mes muy anterior al seed da esperados=0 en todos los días, sin errores', async () => {
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

  // ============================================================
  // Sección 12 — §2.8 (gate del dueño 25-ago-2026): frecuencia de cobro
  // configurable (DIARIA/SEMANAL/MENSUAL). Los 7 casos exigidos por el
  // protocolo de mutation-check, en el orden del encargo salvo el test de
  // importarRespaldo (6), que se deja AL FINAL de esta sección porque
  // reemplaza toda la DB activa de verificación y rompería los tests
  // siguientes si corriera antes.
  // ============================================================

  // (1) MENSUAL día 31 en un mes de 30 días -> exigible el día 30 (clamp).
  await verificar('2.8 (1): MENSUAL día 31 en abril (30 días) es exigible el día 30', async () => {
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
  await verificar('2.8 (2): SEMANAL con 2 viernes impagos acumula deuda de exactamente 2 cuotas', async () => {
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
  await verificar('2.8 (3): SEMANAL con pago doble deja el viernes siguiente en GRACIA_ADELANTO', async () => {
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
  await verificar('2.8 (4): cambio DIARIA->SEMANAL a mitad de mes mantiene el arrastre continuo', async () => {
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

  // (5) Migración v1->v2 (vía initDb): las mismas sentencias que usa initDb()
  // preservan los datos existentes y dejan frecuencia='DIARIA' en acuerdos viejos.
  await verificar('2.8 (5): MIGRACION_V1_A_V2 preserva datos y deja frecuencia=DIARIA', async () => {
    const clienteId = uuidV7();
    const acuerdoId = uuidV7();
    const movimientoId = uuidV7();
    const dbV1 = crearDbV1VaciaConDatos({ clienteId, acuerdoId, movimientoId, fechaAcuerdo: '2026-01-01' });
    try {
      dbV1.run('BEGIN;');
      for (const sql of MIGRACION_V1_A_V2) dbV1.run(sql);
      dbV1.run("UPDATE meta SET valor = '2' WHERE clave = 'schema_version'");
      dbV1.run('COMMIT;');

      const stmtMeta = dbV1.prepare("SELECT valor FROM meta WHERE clave='schema_version'");
      stmtMeta.step();
      const versionFinal = stmtMeta.getAsObject().valor;
      stmtMeta.free();
      assert(versionFinal === SCHEMA_VERSION, `schema_version tras migrar debería ser ${SCHEMA_VERSION}, es ${versionFinal}`);

      const stmtAcuerdo = dbV1.prepare('SELECT * FROM acuerdos WHERE id = ?');
      stmtAcuerdo.bind([acuerdoId]);
      stmtAcuerdo.step();
      const acuerdoMigrado = stmtAcuerdo.getAsObject();
      stmtAcuerdo.free();
      assert(acuerdoMigrado.frecuencia === 'DIARIA', `frecuencia debería quedar DIARIA, es ${acuerdoMigrado.frecuencia}`);
      assert(acuerdoMigrado.dia_semana === null, `dia_semana debería quedar NULL, es ${acuerdoMigrado.dia_semana}`);
      assert(acuerdoMigrado.dia_mes === null, `dia_mes debería quedar NULL, es ${acuerdoMigrado.dia_mes}`);
      assert(acuerdoMigrado.monto_cuota_centavos === 7500, 'el monto de la cuota no debería haber cambiado con la migración');

      const stmtMov = dbV1.prepare('SELECT COUNT(*) AS c FROM movimientos WHERE id = ?');
      stmtMov.bind([movimientoId]);
      stmtMov.step();
      assert(stmtMov.getAsObject().c === 1, 'el movimiento original debería seguir intacto tras la migración');
      stmtMov.free();
    } finally {
      dbV1.close();
    }
  });

  // (7) Hoy (resumenDia) solo lista clientes con cobro EXIGIBLE ese día.
  await verificar('2.8 (7): resumenDia solo incluye clientes con cobro exigible hoy', async () => {
    const hoyDow = diaDeSemana(hoy());
    const dowDistinto = (hoyDow + 1) % 7;

    const { cliente: clienteDiaria } = await crearClienteConAcuerdo({
      nombre: 'Cliente Frecuencia Diaria Hoy Verify',
      monto_cuota_centavos: 1000,
      vigente_desde: hoy(),
      frecuencia: 'DIARIA',
    });
    const { cliente: clienteSemanalHoy } = await crearClienteConAcuerdo({
      nombre: 'Cliente Frecuencia Semanal Hoy Verify',
      monto_cuota_centavos: 2000,
      vigente_desde: hoy(),
      frecuencia: 'SEMANAL',
      dia_semana: hoyDow,
    });
    const { cliente: clienteSemanalNoHoy } = await crearClienteConAcuerdo({
      nombre: 'Cliente Frecuencia Semanal NoHoy Verify',
      monto_cuota_centavos: 3000,
      vigente_desde: hoy(),
      frecuencia: 'SEMANAL',
      dia_semana: dowDistinto,
    });

    const resumen = await resumenDia(hoy());
    const idsEnResumen = new Set(resumen.clientes.map((c) => c.cliente_id));

    assert(idsEnResumen.has(clienteDiaria.id), 'DIARIA siempre es exigible: debería estar en resumenDia de hoy');
    assert(idsEnResumen.has(clienteSemanalHoy.id), 'SEMANAL cuyo día coincide con hoy debería estar en resumenDia');
    assert(!idsEnResumen.has(clienteSemanalNoHoy.id), 'SEMANAL cuyo día NO es hoy no debería aparecer en resumenDia');
  });

  // (6) Import de respaldo v1 funciona — DEBE IR AL FINAL: importarRespaldo
  // reemplaza toda la DB activa, así que cualquier test posterior que
  // dependa del seed/los clientes ya creados en esta corrida se rompería.
  await verificar('2.8 (6): importarRespaldo() acepta un archivo v1 y lo migra en memoria', async () => {
    const clienteId = uuidV7();
    const acuerdoId = uuidV7();
    const movimientoId = uuidV7();
    const dbV1 = crearDbV1VaciaConDatos({ clienteId, acuerdoId, movimientoId, fechaAcuerdo: '2026-01-01' });
    const bytes = dbV1.export();
    dbV1.close();
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    await importarRespaldo(arrayBuffer);

    const { clientes } = await listarClientes({ busqueda: 'Cliente Migracion V1 Verify', tamanioPagina: 5 });
    assert(clientes.length === 1, 'el cliente del respaldo v1 debería existir tras importar');
    assert(clientes[0].id === clienteId, 'el id del cliente importado debería coincidir con el del archivo v1');

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
