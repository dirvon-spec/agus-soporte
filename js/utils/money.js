// Formateo/parseo de dinero. Contrato firme (R-006): locale es-MX explícito vía
// Intl.NumberFormat. "$1,234.50" <-> 123450 (centavos enteros).
// El parseo acepta "1234.50", "1,234.50" y "$1,234.50" y rechaza todo lo demás
// con VALIDATION_ERROR.

import { crearError } from './errors.js';

const LOCALE = 'es-MX';
const MONEDA = 'MXN';

const formateador = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: MONEDA,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Acepta: dígitos sin separador de miles ("1234.50"), o agrupados correctamente
// de a 3 con coma ("1,234.50"); "$" inicial opcional; parte decimal opcional de
// 1 o 2 dígitos.
const PATRON_MONTO = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?$/;

/**
 * Formatea un monto en centavos (entero) a texto con formato es-MX, ej. "$1,234.50".
 * @param {number} centavos
 * @returns {string}
 */
export function formatearCentavos(centavos) {
  if (!Number.isInteger(centavos)) {
    throw crearError('VALIDATION_ERROR', 'El monto debe ser un entero de centavos.', { centavos });
  }
  return formateador.format(centavos / 100);
}

/**
 * Parsea un texto ingresado por el usuario a centavos (entero), validando
 * estrictamente el formato es-MX. Rechaza cualquier formato ambiguo o inválido.
 * @param {string} texto
 * @returns {number} centavos, entero
 */
export function parsearAPesos(texto) {
  if (typeof texto !== 'string') {
    throw crearError('VALIDATION_ERROR', 'El monto debe ingresarse como texto.', { texto });
  }
  const limpio = texto.trim();
  const coincidencia = PATRON_MONTO.exec(limpio);
  if (!coincidencia) {
    throw crearError(
      'VALIDATION_ERROR',
      `"${texto}" no es un monto válido. Usá el formato "1234.50", "1,234.50" o "$1,234.50".`,
      { texto }
    );
  }

  const sinSigno = limpio.replace(/^\$/, '').replace(/,/g, '');
  const [enteroStr, decimalStr] = sinSigno.split('.');
  const decimalPad = ((decimalStr || '') + '00').slice(0, 2);

  const centavos = parseInt(enteroStr, 10) * 100 + parseInt(decimalPad, 10);

  if (!Number.isFinite(centavos)) {
    throw crearError('VALIDATION_ERROR', `"${texto}" no es un monto válido.`, { texto });
  }

  return centavos;
}
