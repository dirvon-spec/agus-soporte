// Formateo/parseo de dinero. Contrato firme (R-006): locale es-MX explícito vía
// Intl.NumberFormat. "$1,234.50" <-> 123450 (centavos enteros).
// El parseo acepta "1234.50", "1,234.50" y "$1,234.50" y rechaza todo lo demás
// con VALIDATION_ERROR.

import { crearError } from './errors.js';

const LOCALE = 'es-MX';
const MONEDA = 'MXN';

const formateadorConCentavos = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: MONEDA,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// §2.11 (ROUND 4, gate del dueño 30-ago-2026): "sin .00 en TODO el programa"
// — los centavos se muestran SOLO cuando son distintos de cero ($1,250 en vez
// de $1,250.00; $1,250.50 se conserva tal cual). No se puede lograr con un
// solo Intl.NumberFormat (minimumFractionDigits:0 + maximumFractionDigits:2
// trunca colas como "50" -> "5" en vez de mantener "50"); por eso son DOS
// formateadores fijos y formatearCentavos elige entre ambos según si el
// monto es un peso exacto.
const formateadorSinCentavos = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: MONEDA,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

// §2.10 A-201: notación compacta es-MX (ej. "$150 k", "$1.2 M") para espacios
// angostos donde el monto completo no entra — hoy solo la fila "Excel" de la
// pantalla Clientes. NUNCA usar donde el monto completo deba ser confiable
// (Persona, panel rápido, impresión): ahí siempre formatearCentavos().
const formateadorCompacto = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: MONEDA,
  notation: 'compact',
  maximumFractionDigits: 1,
});

// Acepta: dígitos sin separador de miles ("1234.50"), o agrupados correctamente
// de a 3 con coma ("1,234.50"); "$" inicial opcional; parte decimal opcional de
// 1 o 2 dígitos.
const PATRON_MONTO = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?$/;

/**
 * Formatea un monto en centavos (entero) a texto con formato es-MX. §2.11:
 * los centavos se muestran SOLO cuando son ≠ 0 — ej. formatearCentavos(125000)
 * da "$1,250" (no "$1,250.00"), formatearCentavos(125050) da "$1,250.50".
 * @param {number} centavos
 * @returns {string}
 */
export function formatearCentavos(centavos) {
  if (!Number.isInteger(centavos)) {
    throw crearError('VALIDATION_ERROR', 'El monto debe ser un entero de centavos.', { centavos });
  }
  const pesos = centavos / 100;
  const tieneCentavos = centavos % 100 !== 0;
  return (tieneCentavos ? formateadorConCentavos : formateadorSinCentavos).format(pesos);
}

/**
 * §2.10 A-201: variante compacta de formatearCentavos (ej. "$150 k", "$1.2 M"),
 * para vistas de lista angostas donde el monto completo no entra. El monto
 * completo con centavos SIEMPRE debe seguir disponible en algún otro lugar
 * (Persona, panel rápido) — este helper es solo de presentación abreviada.
 * @param {number} centavos
 * @returns {string}
 */
export function formatearCompacto(centavos) {
  if (!Number.isInteger(centavos)) {
    throw crearError('VALIDATION_ERROR', 'El monto debe ser un entero de centavos.', { centavos });
  }
  return formateadorCompacto.format(centavos / 100);
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
