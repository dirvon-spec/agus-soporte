// Utilidades de fecha ISO (YYYY-MM-DD) para fechas de NEGOCIO.
// Contrato firme (R-005): toda fecha de negocio se construye con componentes de
// fecha LOCAL del dispositivo (getFullYear/getMonth/getDate). JAMÁS
// toISOString().slice(0,10), porque eso da la fecha en UTC y el negocio opera
// por día calendario local del gestor.

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Formatea un objeto Date a 'YYYY-MM-DD' usando sus componentes LOCALES.
 * @param {Date} d
 * @returns {string}
 */
export function formatearFechaLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Fecha de hoy (día calendario local del dispositivo), formato 'YYYY-MM-DD'.
 * @returns {string}
 */
export function hoy() {
  return formatearFechaLocal(new Date());
}

/**
 * Parsea 'YYYY-MM-DD' a un objeto Date a mediodía LOCAL (evita corrimientos
 * de día por DST al sumar/restar días).
 * @param {string} fechaIso
 * @returns {Date}
 */
function parsearFechaLocal(fechaIso) {
  const partes = fechaIso.split('-').map(Number);
  const [anio, mes, dia] = partes;
  return new Date(anio, mes - 1, dia, 12, 0, 0, 0);
}

/**
 * Valida que un string tenga forma 'YYYY-MM-DD' y represente una fecha real.
 * @param {string} fechaIso
 * @returns {boolean}
 */
export function esFechaIsoValida(fechaIso) {
  if (typeof fechaIso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fechaIso)) return false;
  const d = parsearFechaLocal(fechaIso);
  return formatearFechaLocal(d) === fechaIso;
}

/**
 * Suma (o resta, con n negativo) días a una fecha ISO 'YYYY-MM-DD'.
 * @param {string} fechaIso
 * @param {number} n
 * @returns {string}
 */
export function sumarDias(fechaIso, n) {
  const d = parsearFechaLocal(fechaIso);
  d.setDate(d.getDate() + n);
  return formatearFechaLocal(d);
}

/**
 * Devuelve un array de fechas ISO 'YYYY-MM-DD', inclusive en ambos extremos.
 * @param {string} desde
 * @param {string} hasta
 * @returns {string[]}
 */
export function rango(desde, hasta) {
  const resultado = [];
  let actual = desde;
  // Comparación lexicográfica es válida porque el formato es YYYY-MM-DD.
  while (actual <= hasta) {
    resultado.push(actual);
    actual = sumarDias(actual, 1);
  }
  return resultado;
}

/**
 * True si fechaIso es posterior al día de hoy (local).
 * @param {string} fechaIso
 * @returns {boolean}
 */
export function esFutura(fechaIso) {
  return fechaIso > hoy();
}

/**
 * Compara dos fechas ISO 'YYYY-MM-DD'. Devuelve -1, 0 o 1.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compararFechas(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Timestamp ISO 8601 UTC con milisegundos, ej. '2026-08-25T14:30:00.000Z',
 * para columnas created_at/updated_at (instantes, no fechas de negocio).
 * @returns {string}
 */
export function ahoraIso() {
  return new Date().toISOString();
}
