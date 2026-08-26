// Algoritmo de estados de calendario (contrato 2.5 del PLAN-MVP.md).
// Función PURA: sin acceso a DOM ni a la DB directamente. Recibe los datos ya
// consultados por db.js, para poder testearla en aislamiento (Fase 4).
//
// Decisión de alcance (R-001, gate del dueño 25-ago-2026): el calendario mide
// CUMPLIMIENTO DE LA CUOTA DIARIA, no saldo total. Los CARGO dentro del rango
// consultado deliberadamente NO descuentan del arrastre corriente.

import { rango, diaDeSemana, diaDelMes, ultimoDiaDelMes } from './utils/date.js';

export const Estado = Object.freeze({
  SIN_OBLIGACION: 'SIN_OBLIGACION',
  PAGADO: 'PAGADO',
  GRACIA_ADELANTO: 'GRACIA_ADELANTO',
  PARCIAL: 'PARCIAL',
  DEUDA: 'DEUDA',
});

/**
 * Efecto sobre el saldo de un movimiento, misma convención de signo que 2.2.
 * Solo se invoca aquí sobre movimientos ABONO/AJUSTE (los CARGO no participan
 * del cálculo de estado del día, por diseño).
 * @param {{tipo: string, monto_centavos: number}} mov
 * @returns {number}
 */
function efectoSaldo(mov) {
  if (mov.tipo === 'ABONO') return -mov.monto_centavos;
  if (mov.tipo === 'AJUSTE') return mov.monto_centavos; // ya viene firmado
  if (mov.tipo === 'CARGO') return mov.monto_centavos;
  return 0;
}

/**
 * Agrupa movimientos por fecha, sumando el crédito que aportan
 * ( = -efectoSaldo(movimiento) ): ABONO aporta +monto de crédito, AJUSTE
 * aporta -monto de crédito (porque ya viene firmado con la convención de efectoSaldo).
 * @param {Array<{tipo:string, monto_centavos:number, fecha:string}>} movimientos
 * @returns {Map<string, number>}
 */
function creditoPorFechaDe(movimientos) {
  const mapa = new Map();
  for (const mov of movimientos) {
    const credito = -efectoSaldo(mov);
    mapa.set(mov.fecha, (mapa.get(mov.fecha) || 0) + credito);
  }
  return mapa;
}

/**
 * Busca el acuerdo vigente en una fecha dada. Regla de desempate (mitigación
 * B1): si hay más de un acuerdo aplicable a la misma fecha (datos corruptos /
 * importados), se toma el de vigente_desde más reciente, y entre iguales el
 * de created_at más reciente.
 * @param {Array<object>} acuerdos
 * @param {string} fecha
 * @returns {object|null}
 */
function buscarAcuerdoVigente(acuerdos, fecha) {
  const candidatos = acuerdos.filter(
    (a) => a.vigente_desde <= fecha && (a.vigente_hasta == null || a.vigente_hasta >= fecha)
  );
  if (candidatos.length === 0) return null;
  if (candidatos.length === 1) return candidatos[0];

  candidatos.sort((a, b) => {
    if (a.vigente_desde !== b.vigente_desde) {
      return a.vigente_desde < b.vigente_desde ? 1 : -1;
    }
    const ca = a.created_at || '';
    const cb = b.created_at || '';
    if (ca === cb) return 0;
    return ca < cb ? 1 : -1;
  });
  return candidatos[0];
}

/**
 * §2.8 (gate del dueño 25-ago-2026): un acuerdo con frecuencia SEMANAL o
 * MENSUAL solo exige cuota en su "día exigible"; el resto de los días bajo
 * ese acuerdo son neutros (SIN_OBLIGACION), aunque el acuerdo esté vigente.
 * DIARIA (y cualquier acuerdo sin `frecuencia`, por compatibilidad con
 * fixtures/datos previos a 2.8) exige todos los días — comportamiento
 * idéntico al de antes de esta feature, cero regresión.
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
  return true; // frecuencia desconocida: conservador, no debería ocurrir (validado en db.js)
}

/**
 * Calcula el estado de calendario día por día para un cliente.
 * @param {Array<{vigente_desde:string, vigente_hasta:?string, monto_cuota_centavos:number, created_at?:string, frecuencia?:string, dia_semana?:?number, dia_mes?:?number}>} acuerdos
 * @param {Array<{tipo:string, monto_centavos:number, fecha:string}>} movimientos - solo ABONO/AJUSTE, ya filtrados a [fechaDesde, fechaHasta]
 * @param {number} arrastreInicial - crédito acumulado justo ANTES de fechaDesde (positivo = crédito, negativo = deuda)
 * @param {string} fechaDesde - 'YYYY-MM-DD'
 * @param {string} fechaHasta - 'YYYY-MM-DD'
 * @returns {Map<string, string>} fecha -> Estado
 */
export function calcularEstadosCalendario(acuerdos, movimientos, arrastreInicial, fechaDesde, fechaHasta) {
  const creditoPorFecha = creditoPorFechaDe(movimientos);

  let arrastre = arrastreInicial;
  const estados = new Map();

  for (const fecha of rango(fechaDesde, fechaHasta)) {
    const acuerdoVigente = buscarAcuerdoVigente(acuerdos, fecha);

    if (acuerdoVigente === null) {
      estados.set(fecha, Estado.SIN_OBLIGACION);
      // el arrastre NO se modifica: un día sin acuerdo vigente no genera ni consume obligación
      continue;
    }

    const creditoDelDia = creditoPorFecha.get(fecha) || 0;

    if (!esDiaExigible(acuerdoVigente, fecha)) {
      // §2.8: día no exigible por la frecuencia (SEMANAL/MENSUAL) — no hay
      // cuota que cumplir hoy, se pinta neutro (SIN_OBLIGACION). El crédito
      // de hoy SÍ se banca en el arrastre (los abonos de cualquier día suman
      // crédito), sin restar ninguna cuota, para el próximo día exigible —
      // equivalente matemático a "diferir" el pago hasta ese día.
      arrastre += creditoDelDia;
      estados.set(fecha, Estado.SIN_OBLIGACION);
      continue;
    }

    const cuota = acuerdoVigente.monto_cuota_centavos;
    const disponible = arrastre + creditoDelDia;
    arrastre = disponible - cuota;

    if (creditoDelDia >= cuota) {
      estados.set(fecha, Estado.PAGADO);
    } else if (disponible >= cuota) {
      estados.set(fecha, Estado.GRACIA_ADELANTO);
    } else if (creditoDelDia > 0) {
      estados.set(fecha, Estado.PARCIAL);
    } else {
      estados.set(fecha, Estado.DEUDA);
    }
  }

  return estados;
}
