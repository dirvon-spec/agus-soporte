// Datos de ejemplo (contrato 2.6 del PLAN-MVP.md).
// generarSeed() es una función de generación PURA (sin acceso a DB): devuelve
// arrays de filas ya formadas (con id vía uuid.js), listas para insertar.
// db.js es quien las inserta dentro de una transacción y marca modo_demo=1
// (así seed.js queda desacoplado y testeable en aislamiento, igual que calendar.js).
//
// Genera todo dinámicamente relativo a hoy() en el momento de llamarla — nunca
// fechas absolutas hardcodeadas (así el re-sembrado anti-congelamiento de D1
// siempre produce una demo "viva").

import { uuidV7 } from './utils/uuid.js';
import { hoy, sumarDias, rango, diaDeSemana } from './utils/date.js';

function ts(fechaIso, hhmmss = '09:00:00') {
  return `${fechaIso}T${hhmmss}.000Z`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function nuevoCliente({ nombre, telefono, notas, fechaAlta, categoriaId = null, orden = null }) {
  return {
    id: uuidV7(),
    nombre,
    telefono: telefono || null,
    categoria_id: categoriaId,
    orden,
    notas: notas || null,
    created_at: ts(fechaAlta),
    updated_at: ts(fechaAlta),
  };
}

/** §2.9: categoría del seed (paleta definida en la UI; acá solo se usa un nombre de color plausible). */
function nuevaCategoria({ nombre, color, fechaAlta }) {
  return { id: uuidV7(), nombre, color, created_at: ts(fechaAlta), updated_at: ts(fechaAlta) };
}

/** §2.9: concepto del catálogo (reemplaza el enum fijo de `servicio`). */
function nuevoConcepto({ nombre, fechaAlta }) {
  return { id: uuidV7(), nombre, created_at: ts(fechaAlta), updated_at: ts(fechaAlta) };
}

function nuevoAcuerdo({
  clienteId,
  montoCuotaCentavos,
  vigenteDesde,
  vigenteHasta = null,
  fechaCreacion,
  frecuencia = 'DIARIA',
  diaSemana = null,
  diaMes = null,
}) {
  const fc = fechaCreacion || vigenteDesde;
  return {
    id: uuidV7(),
    cliente_id: clienteId,
    monto_cuota_centavos: montoCuotaCentavos,
    frecuencia,
    dia_semana: diaSemana,
    dia_mes: diaMes,
    vigente_desde: vigenteDesde,
    vigente_hasta: vigenteHasta,
    created_at: ts(fc, '09:05:00'),
    updated_at: ts(fc, '09:05:00'),
  };
}

/** Primer viernes (u otro día de semana) en/después de una fecha 'YYYY-MM-DD'. */
function primerDiaSemanaDesde(fechaIso, diaSemanaObjetivo) {
  let f = fechaIso;
  while (diaDeSemana(f) !== diaSemanaObjetivo) f = sumarDias(f, 1);
  return f;
}

/**
 * Fechas exigibles de un acuerdo MENSUAL (con clamp a fin de mes) dentro de
 * [desde, hasta] — para poder sembrar abonos exactamente en esos días.
 */
function fechasExigiblesMensuales(desde, hasta, diaMes) {
  const fechas = [];
  let cursorMes = `${desde.slice(0, 7)}-01`;
  while (cursorMes <= hasta) {
    const anio = Number(cursorMes.slice(0, 4));
    const mes = Number(cursorMes.slice(5, 7));
    const ultimoDiaDelMes = new Date(anio, mes, 0).getDate();
    const diaClamp = Math.min(diaMes, ultimoDiaDelMes);
    const fechaExigible = `${cursorMes.slice(0, 7)}-${pad2(diaClamp)}`;
    if (fechaExigible >= desde && fechaExigible <= hasta) fechas.push(fechaExigible);
    cursorMes = mes === 12 ? `${anio + 1}-01-01` : `${anio}-${pad2(mes + 1)}-01`;
  }
  return fechas;
}

function nuevoMovimiento({ clienteId, tipo, montoCentavos, fecha, servicio = null, referencia = null, nota = null, movimientoOriginalId = null }) {
  return {
    id: uuidV7(),
    cliente_id: clienteId,
    tipo,
    monto_centavos: montoCentavos,
    fecha,
    servicio,
    referencia,
    nota,
    movimiento_original_id: movimientoOriginalId,
    created_at: ts(fecha, '18:00:00'),
    updated_at: ts(fecha, '18:00:00'),
  };
}

/** §2.11: "visita sin abono" — semáforo de 3 estados por cliente-día. */
function nuevaVisitaSinAbono({ clienteId, fecha }) {
  return {
    id: uuidV7(),
    cliente_id: clienteId,
    fecha,
    created_at: ts(fecha, '18:00:00'),
    updated_at: ts(fecha, '18:00:00'),
  };
}

/**
 * Genera el set completo de datos de ejemplo, cubriendo los 9 casos
 * obligatorios de 2.6 entre 10 clientes con ~2 meses de movimientos, más 2
 * clientes adicionales de §2.8 (frecuencia SEMANAL y MENSUAL) — 12 en total.
 * §2.9: además siembra 3-4 categorías (con color de paleta), orden manual
 * variado (deliberadamente NO alfabético, para probar que el orden es
 * genuinamente manual) y un catálogo de 4 conceptos (Luz/Agua/Internet/
 * Préstamo). NO crea acuerdos nuevos — los 12 clientes conservan los mismos
 * acuerdos de siempre (histórico, append-only, ya no se usa para altas).
 * §2.11: además siembra 1 `visita_sin_abono` de ejemplo (Manuel Torres, hoy)
 * para demostrar el semáforo $0 gris ("visitado, dijo hoy no") sin tocar
 * saldos ni movimientos.
 * @returns {{clientes: object[], acuerdos: object[], movimientos: object[], categorias: object[], conceptos: object[], visitasSinAbono: object[]}}
 */
export function generarSeed() {
  const clientes = [];
  const acuerdos = [];
  const movimientos = [];
  const visitasSinAbono = [];

  const hoyStr = hoy();
  const inicioRango = sumarDias(hoyStr, -60);

  // ---- §2.9: categorías y catálogo de conceptos ----
  const categorias = [
    nuevaCategoria({ nombre: 'Confiables', color: 'verde', fechaAlta: inicioRango }),
    nuevaCategoria({ nombre: 'Regulares', color: 'azul', fechaAlta: inicioRango }),
    nuevaCategoria({ nombre: 'Riesgo', color: 'rojo', fechaAlta: inicioRango }),
    nuevaCategoria({ nombre: 'Nuevos', color: 'amarillo', fechaAlta: inicioRango }),
  ];
  const [catConfiables, catRegulares, catRiesgo, catNuevos] = categorias;

  const conceptos = [
    nuevoConcepto({ nombre: 'Luz', fechaAlta: inicioRango }),
    nuevoConcepto({ nombre: 'Agua', fechaAlta: inicioRango }),
    nuevoConcepto({ nombre: 'Internet', fechaAlta: inicioRango }),
    nuevoConcepto({ nombre: 'Préstamo', fechaAlta: inicioRango }),
  ];

  // ---- Caso 1: cliente siempre PAGADO (abona su cuota todos los días) ----
  const cliente1 = nuevoCliente({
    nombre: 'Rosa Martínez',
    telefono: '5215512340001',
    notas: 'Cliente puntual, paga todos los días.',
    fechaAlta: inicioRango,
    categoriaId: catConfiables.id,
    orden: 1,
  });
  clientes.push(cliente1);
  const cuota1 = 5000; // $50.00
  acuerdos.push(nuevoAcuerdo({ clienteId: cliente1.id, montoCuotaCentavos: cuota1, vigenteDesde: inicioRango }));
  for (const fecha of rango(inicioRango, hoyStr)) {
    movimientos.push(nuevoMovimiento({ clienteId: cliente1.id, tipo: 'ABONO', montoCentavos: cuota1, fecha, nota: 'Cuota diaria' }));
  }

  // ---- Caso 2: cliente con GRACIA-ADELANTO (adelanta varios días y luego no abona) ----
  const inicio2 = sumarDias(hoyStr, -14);
  const cliente2 = nuevoCliente({
    nombre: 'Jorge Delgado',
    telefono: '5215512340002',
    notas: 'Adelantó varios días de golpe.',
    fechaAlta: inicio2,
    categoriaId: catRiesgo.id,
    orden: 2,
  });
  clientes.push(cliente2);
  const cuota2 = 4000; // $40.00
  acuerdos.push(nuevoAcuerdo({ clienteId: cliente2.id, montoCuotaCentavos: cuota2, vigenteDesde: inicio2 }));
  movimientos.push(
    nuevoMovimiento({ clienteId: cliente2.id, tipo: 'ABONO', montoCentavos: cuota2 * 10, fecha: inicio2, nota: 'Adelanto de 10 cuotas' })
  );
  // sin más abonos después: el arrastre cubre varios días y luego cae en deuda.

  // ---- Caso 3: cliente con PARCIAL recurrente (abona menos que la cuota casi todos los días) ----
  const inicio3 = sumarDias(hoyStr, -30);
  const cliente3 = nuevoCliente({
    nombre: 'Lucía Fernández',
    telefono: '5215512340003',
    notas: 'Abona menos que la cuota casi todos los días.',
    fechaAlta: inicio3,
    categoriaId: catRiesgo.id,
    orden: 0,
  });
  clientes.push(cliente3);
  const cuota3 = 6000; // $60.00
  acuerdos.push(nuevoAcuerdo({ clienteId: cliente3.id, montoCuotaCentavos: cuota3, vigenteDesde: inicio3 }));
  for (const fecha of rango(inicio3, hoyStr)) {
    movimientos.push(
      nuevoMovimiento({ clienteId: cliente3.id, tipo: 'ABONO', montoCentavos: Math.round(cuota3 * 0.6), fecha, nota: 'Pago parcial' })
    );
  }

  // ---- Caso 4: cliente en DEUDA franca (dejó de abonar hace semanas) ----
  const inicio4 = sumarDias(hoyStr, -45);
  const finAbonos4 = sumarDias(hoyStr, -20);
  const cliente4 = nuevoCliente({
    nombre: 'Manuel Torres',
    telefono: '5215512340004',
    notas: 'Dejó de abonar hace varias semanas.',
    fechaAlta: inicio4,
    categoriaId: catRiesgo.id,
    orden: 1,
  });
  clientes.push(cliente4);
  const cuota4 = 3000; // $30.00
  acuerdos.push(nuevoAcuerdo({ clienteId: cliente4.id, montoCuotaCentavos: cuota4, vigenteDesde: inicio4 }));
  for (const fecha of rango(inicio4, finAbonos4)) {
    movimientos.push(nuevoMovimiento({ clienteId: cliente4.id, tipo: 'ABONO', montoCentavos: cuota4, fecha, nota: 'Cuota diaria' }));
  }
  // sin abonos desde finAbonos4 hasta hoy.
  // §2.11: hoy lo visitaron y dijo "hoy no" — demuestra el semáforo $0 gris.
  visitasSinAbono.push(nuevaVisitaSinAbono({ clienteId: cliente4.id, fecha: hoyStr }));

  // ---- Caso 5: cliente nuevo a mitad del rango (SIN_OBLIGACION antes de vigente_desde) ----
  const inicio5 = sumarDias(hoyStr, -10);
  const cliente5 = nuevoCliente({
    nombre: 'Karla Núñez',
    telefono: '5215512340005',
    notas: 'Cliente nueva, alta reciente.',
    fechaAlta: inicio5,
    categoriaId: catConfiables.id,
    orden: 2,
  });
  clientes.push(cliente5);
  const cuota5 = 4500; // $45.00
  acuerdos.push(nuevoAcuerdo({ clienteId: cliente5.id, montoCuotaCentavos: cuota5, vigenteDesde: inicio5 }));
  for (const fecha of rango(inicio5, hoyStr)) {
    movimientos.push(nuevoMovimiento({ clienteId: cliente5.id, tipo: 'ABONO', montoCentavos: cuota5, fecha, nota: 'Cuota diaria' }));
  }

  // ---- Caso 6: cliente con cambio de cuota (dos acuerdos consecutivos) ----
  const inicio6 = sumarDias(hoyStr, -40);
  const cambio6 = sumarDias(hoyStr, -12);
  const cliente6 = nuevoCliente({
    nombre: 'Andrés Ibarra',
    telefono: '5215512340006',
    notas: 'Renegoció su cuota diaria.',
    fechaAlta: inicio6,
    categoriaId: catRegulares.id,
    orden: 1,
  });
  clientes.push(cliente6);
  const cuota6a = 3500; // $35.00
  const cuota6b = 5500; // $55.00
  acuerdos.push(
    nuevoAcuerdo({ clienteId: cliente6.id, montoCuotaCentavos: cuota6a, vigenteDesde: inicio6, vigenteHasta: sumarDias(cambio6, -1) })
  );
  acuerdos.push(nuevoAcuerdo({ clienteId: cliente6.id, montoCuotaCentavos: cuota6b, vigenteDesde: cambio6 }));
  for (const fecha of rango(inicio6, hoyStr)) {
    const cuotaVigente = fecha < cambio6 ? cuota6a : cuota6b;
    movimientos.push(nuevoMovimiento({ clienteId: cliente6.id, tipo: 'ABONO', montoCentavos: cuotaVigente, fecha, nota: 'Cuota diaria' }));
  }

  // ---- Caso 7: cliente con al menos un AJUSTE en su historial ----
  const inicio7 = sumarDias(hoyStr, -25);
  const cliente7 = nuevoCliente({
    nombre: 'Patricia Gómez',
    telefono: '5215512340007',
    notas: 'Se le cargó un servicio de más y se corrigió con un ajuste.',
    fechaAlta: inicio7,
    categoriaId: catRegulares.id,
    orden: 3,
  });
  clientes.push(cliente7);
  const cuota7 = 5000; // $50.00
  acuerdos.push(nuevoAcuerdo({ clienteId: cliente7.id, montoCuotaCentavos: cuota7, vigenteDesde: inicio7 }));
  for (const fecha of rango(inicio7, hoyStr)) {
    movimientos.push(nuevoMovimiento({ clienteId: cliente7.id, tipo: 'ABONO', montoCentavos: cuota7, fecha, nota: 'Cuota diaria' }));
  }
  const fechaCargo7 = sumarDias(hoyStr, -8);
  const cargoMalCargado = nuevoMovimiento({
    clienteId: cliente7.id,
    tipo: 'CARGO',
    montoCentavos: 12000,
    fecha: fechaCargo7,
    servicio: 'Luz', // coincide con el concepto sembrado en el catálogo (§2.9)
    referencia: 'F-00123',
    nota: 'Pago de luz',
  });
  movimientos.push(cargoMalCargado);
  movimientos.push(
    nuevoMovimiento({
      clienteId: cliente7.id,
      tipo: 'AJUSTE',
      montoCentavos: -3000,
      fecha: sumarDias(hoyStr, -7),
      nota: 'Se cargó de más por error de tipeo; se corrige.',
      movimientoOriginalId: cargoMalCargado.id,
    })
  );

  // ---- Caso 8: cliente sin teléfono cargado ----
  const inicio8 = sumarDias(hoyStr, -20);
  const cliente8 = nuevoCliente({
    nombre: 'Ricardo Peña',
    telefono: null,
    notas: 'Todavía no dejó su número de teléfono.',
    fechaAlta: inicio8,
    categoriaId: catRegulares.id,
    orden: 0,
  });
  clientes.push(cliente8);
  const cuota8 = 2500; // $25.00
  acuerdos.push(nuevoAcuerdo({ clienteId: cliente8.id, montoCuotaCentavos: cuota8, vigenteDesde: inicio8 }));
  for (const fecha of rango(inicio8, hoyStr)) {
    movimientos.push(nuevoMovimiento({ clienteId: cliente8.id, tipo: 'ABONO', montoCentavos: cuota8, fecha, nota: 'Cuota diaria' }));
  }

  // ---- Caso 9: clientes de relleno (para probar listas/paginación) ----
  const inicio9 = sumarDias(hoyStr, -5);
  const cliente9 = nuevoCliente({
    nombre: 'Sofía Ramírez',
    telefono: '5215512340009',
    notas: null,
    fechaAlta: inicio9,
    categoriaId: catConfiables.id,
    orden: 0,
  });
  clientes.push(cliente9);
  const cuota9 = 2000; // $20.00
  acuerdos.push(nuevoAcuerdo({ clienteId: cliente9.id, montoCuotaCentavos: cuota9, vigenteDesde: inicio9 }));
  for (const fecha of rango(inicio9, hoyStr)) {
    movimientos.push(nuevoMovimiento({ clienteId: cliente9.id, tipo: 'ABONO', montoCentavos: cuota9, fecha, nota: 'Cuota diaria' }));
  }

  const inicio10 = sumarDias(hoyStr, -3);
  // Deliberadamente SIN categoría (categoriaId por defecto null): prueba el
  // grupo "Sin categoría" del rediseño de §2.9.
  const cliente10 = nuevoCliente({ nombre: 'Tomás Vega', telefono: '5215512340010', notas: null, fechaAlta: inicio10, orden: 0 });
  clientes.push(cliente10);
  const cuota10 = 15000; // $150.00, tope superior del rango de cuotas
  acuerdos.push(nuevoAcuerdo({ clienteId: cliente10.id, montoCuotaCentavos: cuota10, vigenteDesde: inicio10 }));
  movimientos.push(nuevoMovimiento({ clienteId: cliente10.id, tipo: 'ABONO', montoCentavos: cuota10, fecha: inicio10, nota: 'Cuota diaria' }));
  // sin abonar los últimos días: aporta variedad reciente (PARCIAL/DEUDA).

  // ---- Caso 10 (§2.8): SEMANAL (viernes) con una semana pagada por adelantado ----
  const primerViernes = primerDiaSemanaDesde(sumarDias(hoyStr, -14), 5);
  const cliente11 = nuevoCliente({
    nombre: 'Valentina Cruz',
    telefono: '5215512340011',
    notas: 'Cobro semanal, todos los viernes.',
    fechaAlta: primerViernes,
    categoriaId: catRegulares.id,
    orden: 2,
  });
  clientes.push(cliente11);
  const cuotaSemanal = 20000; // $200.00 por semana
  acuerdos.push(
    nuevoAcuerdo({ clienteId: cliente11.id, montoCuotaCentavos: cuotaSemanal, vigenteDesde: primerViernes, frecuencia: 'SEMANAL', diaSemana: 5 })
  );
  movimientos.push(
    nuevoMovimiento({ clienteId: cliente11.id, tipo: 'ABONO', montoCentavos: cuotaSemanal * 2, fecha: primerViernes, nota: 'Adelanta una semana' })
  );
  // sin más abonos: el viernes siguiente queda en GRACIA_ADELANTO.

  // ---- Caso 11 (§2.8): MENSUAL, día 31 (clamp visible en meses de menos de 31 días) ----
  const inicioMensual = sumarDias(hoyStr, -60);
  const cliente12 = nuevoCliente({
    nombre: 'Emilio Cárdenas',
    telefono: '5215512340012',
    notas: 'Cobro mensual, día 31 (se ajusta al último día en meses cortos).',
    fechaAlta: inicioMensual,
    categoriaId: catNuevos.id,
    orden: 0,
  });
  clientes.push(cliente12);
  const cuotaMensual = 80000; // $800.00 por mes
  acuerdos.push(
    nuevoAcuerdo({ clienteId: cliente12.id, montoCuotaCentavos: cuotaMensual, vigenteDesde: inicioMensual, frecuencia: 'MENSUAL', diaMes: 31 })
  );
  for (const fecha of fechasExigiblesMensuales(inicioMensual, hoyStr, 31)) {
    movimientos.push(nuevoMovimiento({ clienteId: cliente12.id, tipo: 'ABONO', montoCentavos: cuotaMensual, fecha, nota: 'Cuota mensual' }));
  }

  return { clientes, acuerdos, movimientos, categorias, conceptos, visitasSinAbono };
}
