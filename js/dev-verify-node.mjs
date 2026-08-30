// Runner de verificación en Node para los módulos PUROS (sin DOM/IndexedDB/sql.js):
// calendar.js, seed.js, utils/date.js, utils/money.js, utils/uuid.js.
//
// La suite completa contra la DB real (schema+FK, crearClienteConAcuerdo,
// registrarCargo/Abono/Ajuste, resumenMensual, etc.) vive en dev-verify.js y
// SOLO corre en el navegador (?verify=1), porque depende de sql.js+IndexedDB.
// Este runner cubre la mitad que sí puede correr sin navegador, para poder
// ejecutarla en CI / línea de comandos sin levantar un server ni un browser.
//
// Uso: `node js/dev-verify-node.mjs` (o `npm run verify:node`) desde la raíz
// del proyecto. Sale con código 0 si todo pasó, 1 si algo falló.

import { calcularEstadosCalendario, Estado } from './calendar.js';
import { generarSeed } from './seed.js';
import { hoy, sumarDias, rango, esFechaIsoValida, esFutura } from './utils/date.js';
import { parsearAPesos, formatearCentavos } from './utils/money.js';
import { uuidV7 } from './utils/uuid.js';

let pass = 0;
let fail = 0;
const fallidos = [];

function assert(cond, mensaje) {
  if (!cond) throw new Error(mensaje || 'Aserción falló');
}

function verificar(nombre, fn) {
  try {
    fn();
    pass++;
    console.log(`[PASS] ${nombre}`);
  } catch (e) {
    fail++;
    fallidos.push(nombre);
    console.error(`[FAIL] ${nombre} — ${e.message}`);
  }
}

/** Compara un Map<string,string> de calendar.js contra un objeto {fecha: estadoEsperado}. */
function compararMapaEstados(actual, esperado) {
  for (const [fecha, estadoEsperado] of Object.entries(esperado)) {
    const obtenido = actual.get(fecha);
    assert(obtenido === estadoEsperado, `día ${fecha}: esperado ${estadoEsperado}, obtenido ${obtenido}`);
  }
}

console.log('=== dev-verify-node.mjs — módulos puros (sin DOM/DB) ===\n');

// ============================================================
// date.js (R-005: fecha LOCAL, no UTC)
// ============================================================
verificar('date.js: hoy() devuelve YYYY-MM-DD', () => {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(hoy()));
});
verificar('date.js: sumarDias +1 / -1 (incluyendo cruce de año)', () => {
  assert(sumarDias('2026-01-01', 1) === '2026-01-02');
  assert(sumarDias('2026-01-01', -1) === '2025-12-31');
});
verificar('date.js: rango es inclusive en ambos extremos', () => {
  assert(rango('2026-01-01', '2026-01-03').join(',') === '2026-01-01,2026-01-02,2026-01-03');
});
verificar('date.js: esFechaIsoValida rechaza 30 de febrero', () => {
  assert(esFechaIsoValida('2026-02-30') === false);
  assert(esFechaIsoValida('2026-02-28') === true);
});
verificar('date.js: esFutura(mañana)=true, esFutura(hoy)=false', () => {
  assert(esFutura(sumarDias(hoy(), 1)) === true);
  assert(esFutura(hoy()) === false);
});

// ============================================================
// money.js (R-006/A4: locale es-MX, parseo estricto)
// ============================================================
verificar('money.js: parsearAPesos acepta "1234.50", "1,234.50", "$1,234.50"', () => {
  assert(parsearAPesos('1234.50') === 123450);
  assert(parsearAPesos('1,234.50') === 123450);
  assert(parsearAPesos('$1,234.50') === 123450);
});
verificar('money.js: parsearAPesos rechaza formatos inválidos con VALIDATION_ERROR', () => {
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
verificar('money.js: formatearCentavos(123450) da formato es-MX con signo $', () => {
  assert(/\$1,234\.50/.test(formatearCentavos(123450)));
});

// ============================================================
// uuid.js
// ============================================================
verificar('uuid.js: uuidV7 genera valores distintos con formato v7 válido', () => {
  const id1 = uuidV7();
  const id2 = uuidV7();
  assert(id1 !== id2);
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id1));
});

// ============================================================
// calendar.js — los mismos 6 casos borde de 4.2 que corren en el navegador
// (calcularEstadosCalendario es pura: no necesita DOM/DB para testearse)
// ============================================================
verificar('calendar.js — Adelanto puro (4.2, caso 1)', () => {
  const cuota = 10000;
  const acuerdos = [{ vigente_desde: '2026-01-01', vigente_hasta: null, monto_cuota_centavos: cuota }];
  const movimientos = [{ tipo: 'ABONO', monto_centavos: cuota * 5, fecha: '2026-01-01' }];
  const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-01', '2026-01-10');
  compararMapaEstados(estados, {
    '2026-01-01': Estado.PAGADO,
    '2026-01-02': Estado.GRACIA_ADELANTO,
    '2026-01-05': Estado.GRACIA_ADELANTO,
    '2026-01-06': Estado.DEUDA,
  });
});

verificar('calendar.js — Pagos parciales acumulados (4.2, caso 2)', () => {
  const cuota = 10000;
  const acuerdos = [{ vigente_desde: '2026-01-01', vigente_hasta: null, monto_cuota_centavos: cuota }];
  const movimientos = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map(
    (fecha) => ({ tipo: 'ABONO', monto_centavos: 6000, fecha })
  );
  const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-01', '2026-01-08');
  for (const m of movimientos) {
    assert(estados.get(m.fecha) === Estado.PARCIAL, `día ${m.fecha} debería ser PARCIAL`);
  }
});

verificar('calendar.js — Cliente nuevo a mitad de rango, sin herencia de arrastre (4.2, caso 3)', () => {
  const cuota = 5000;
  const acuerdos = [{ vigente_desde: '2026-01-04', vigente_hasta: null, monto_cuota_centavos: cuota }];
  const movimientos = [{ tipo: 'ABONO', monto_centavos: 6000, fecha: '2026-01-02' }]; // cae en día SIN_OBLIGACION
  const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-01', '2026-01-05');
  compararMapaEstados(estados, {
    '2026-01-01': Estado.SIN_OBLIGACION,
    '2026-01-02': Estado.SIN_OBLIGACION,
    '2026-01-03': Estado.SIN_OBLIGACION,
    '2026-01-04': Estado.DEUDA, // si el crédito del día 2 se hubiera heredado, no sería DEUDA
    '2026-01-05': Estado.DEUDA,
  });
});

verificar('calendar.js — Cambio de cuota, arrastre continuo (4.2, caso 4)', () => {
  const acuerdos = [
    { vigente_desde: '2026-01-01', vigente_hasta: '2026-01-05', monto_cuota_centavos: 10000 },
    { vigente_desde: '2026-01-06', vigente_hasta: null, monto_cuota_centavos: 20000 },
  ];
  const movimientos = [{ tipo: 'ABONO', monto_centavos: 100000, fecha: '2026-01-01' }];
  const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-01', '2026-01-08');
  compararMapaEstados(estados, {
    '2026-01-01': Estado.PAGADO,
    '2026-01-05': Estado.GRACIA_ADELANTO,
    '2026-01-06': Estado.GRACIA_ADELANTO, // usa la cuota NUEVA y el arrastre viejo, sin reiniciarse
    '2026-01-08': Estado.DEUDA,
  });
});

verificar('calendar.js — Borde disponible == cuota clasifica GRACIA_ADELANTO (4.2, caso 5)', () => {
  const cuota = 10000;
  const acuerdos = [{ vigente_desde: '2026-01-01', vigente_hasta: null, monto_cuota_centavos: cuota }];
  const estados = calcularEstadosCalendario(acuerdos, [], cuota, '2026-01-01', '2026-01-02');
  compararMapaEstados(estados, { '2026-01-01': Estado.GRACIA_ADELANTO, '2026-01-02': Estado.DEUDA });
});

verificar('calendar.js — AJUSTE reduce el crédito efectivo del día (4.2, caso 6)', () => {
  const cuota = 10000;
  const acuerdos = [{ vigente_desde: '2026-01-01', vigente_hasta: null, monto_cuota_centavos: cuota }];
  const movimientos = [
    { tipo: 'ABONO', monto_centavos: 10000, fecha: '2026-01-01' },
    { tipo: 'AJUSTE', monto_centavos: 4000, fecha: '2026-01-01' },
  ];
  const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-01', '2026-01-01');
  compararMapaEstados(estados, { '2026-01-01': Estado.PARCIAL }); // sin el ajuste hubiera sido PAGADO
});

// ============================================================
// seed.js — generarSeed() es pura, no toca DB
// ============================================================
verificar('seed.js: generarSeed() produce entre 10 y 12 clientes', () => {
  const datos = generarSeed();
  assert(datos.clientes.length >= 10 && datos.clientes.length <= 12, `clientes=${datos.clientes.length}`);
});
verificar('seed.js: generarSeed() incluye al menos un AJUSTE', () => {
  const datos = generarSeed();
  assert(datos.movimientos.some((m) => m.tipo === 'AJUSTE'));
});
verificar('seed.js: generarSeed() incluye un cliente sin teléfono', () => {
  const datos = generarSeed();
  assert(datos.clientes.some((c) => !c.telefono));
});
verificar('seed.js: generarSeed() incluye un cliente con cambio de cuota (2 acuerdos)', () => {
  const datos = generarSeed();
  const conDosAcuerdos = datos.clientes.find((c) => datos.acuerdos.filter((a) => a.cliente_id === c.id).length === 2);
  assert(!!conDosAcuerdos);
});

verificar('§2.9: generarSeed() siembra 3-4 categorías, catálogo de 4 conceptos y orden manual variado', () => {
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
});

// ============================================================
// calendar.js — §2.8 (gate del dueño 25-ago-2026): frecuencia de cobro
// configurable (DIARIA/SEMANAL/MENSUAL). Mismos 4 casos puros que corren
// también en el navegador (dev-verify.js); los que dependen de sql.js/DB
// (migración, importarRespaldo, resumenDia) solo corren ahí.
// ============================================================

verificar('2.8 (1): MENSUAL día 31 en abril (30 días) es exigible el día 30', () => {
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

verificar('2.8 (2): SEMANAL con 2 viernes impagos acumula deuda de exactamente 2 cuotas', () => {
  const cuota = 10000;
  const acuerdos = [
    { vigente_desde: '2026-01-02', vigente_hasta: null, monto_cuota_centavos: cuota, frecuencia: 'SEMANAL', dia_semana: 5, dia_mes: null },
  ];
  const movimientos = [{ tipo: 'ABONO', monto_centavos: cuota * 10, fecha: '2026-01-16' }];
  const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-02', '2026-03-13');
  compararMapaEstados(estados, {
    '2026-01-02': Estado.DEUDA,
    '2026-01-05': Estado.SIN_OBLIGACION,
    '2026-01-09': Estado.DEUDA,
    '2026-01-16': Estado.PAGADO,
    '2026-01-23': Estado.GRACIA_ADELANTO,
    '2026-02-27': Estado.GRACIA_ADELANTO,
    '2026-03-06': Estado.GRACIA_ADELANTO,
    '2026-03-13': Estado.DEUDA,
  });
});

verificar('2.8 (3): SEMANAL con pago doble deja el viernes siguiente en GRACIA_ADELANTO', () => {
  const cuota = 10000;
  const acuerdos = [
    { vigente_desde: '2026-01-02', vigente_hasta: null, monto_cuota_centavos: cuota, frecuencia: 'SEMANAL', dia_semana: 5, dia_mes: null },
  ];
  const movimientos = [{ tipo: 'ABONO', monto_centavos: cuota * 2, fecha: '2026-01-02' }];
  const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-02', '2026-01-09');
  compararMapaEstados(estados, { '2026-01-02': Estado.PAGADO, '2026-01-09': Estado.GRACIA_ADELANTO });
});

verificar('2.8 (4): cambio DIARIA->SEMANAL a mitad de mes mantiene el arrastre continuo', () => {
  const acuerdos = [
    { vigente_desde: '2026-01-01', vigente_hasta: '2026-01-15', monto_cuota_centavos: 10000, frecuencia: 'DIARIA', dia_semana: null, dia_mes: null },
    { vigente_desde: '2026-01-16', vigente_hasta: null, monto_cuota_centavos: 10000, frecuencia: 'SEMANAL', dia_semana: 5, dia_mes: null },
  ];
  const movimientos = rango('2026-01-01', '2026-01-14').map((fecha) => ({ tipo: 'ABONO', monto_centavos: 10000, fecha }));
  movimientos.push({ tipo: 'ABONO', monto_centavos: 30000, fecha: '2026-01-15' });
  const estados = calcularEstadosCalendario(acuerdos, movimientos, 0, '2026-01-01', '2026-01-23');
  compararMapaEstados(estados, {
    '2026-01-01': Estado.PAGADO,
    '2026-01-14': Estado.PAGADO,
    '2026-01-15': Estado.PAGADO,
    '2026-01-16': Estado.GRACIA_ADELANTO,
    '2026-01-17': Estado.SIN_OBLIGACION,
    '2026-01-20': Estado.SIN_OBLIGACION,
    '2026-01-22': Estado.SIN_OBLIGACION,
    '2026-01-23': Estado.GRACIA_ADELANTO,
  });
});

// ============================================================
console.log(`\n${pass}/${pass + fail} PASS (Node, módulos puros)`);
if (fail > 0) {
  console.error(`${fail} FAIL: ${fallidos.join(' | ')}`);
  process.exit(1);
}
