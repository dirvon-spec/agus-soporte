// Algoritmo de estados de calendario (contrato 2.5 del PLAN-MVP.md).
// Función PURA: sin acceso a DOM ni a la DB directamente. Recibe los datos ya
// consultados por db.js, para poder testearla en aislamiento (Fase 4).
//
// Decisión de alcance (R-001, gate del dueño 25-ago-2026): el calendario mide
// CUMPLIMIENTO DE LA CUOTA DIARIA, no saldo total. Los CARGO dentro del rango
// consultado deliberadamente NO descuentan del arrastre corriente.

import { rango } from './utils/date.js';

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
 * Calcula el estado de calendario día por día para un cliente.
 * @param {Array<{vigente_desde:string, vigente_hasta:?string, monto_cuota_centavos:number, created_at?:string}>} acuerdos
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
      // el arrastre NO se modifica: un día sin cuota no genera ni consume obligación
      continue;
    }

    const cuota = acuerdoVigente.monto_cuota_centavos;
    const creditoDelDia = creditoPorFecha.get(fecha) || 0;
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
