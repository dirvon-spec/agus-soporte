// Normalización de teléfono + construcción de enlace wa.me.

/**
 * Normaliza un teléfono a solo dígitos (formato que espera wa.me).
 * @param {string} telefono
 * @returns {string}
 */
export function normalizarTelefono(telefono) {
  return String(telefono || '').replace(/\D/g, '');
}

/**
 * Construye un enlace https://wa.me/{telefono}?text={texto} con el texto codificado.
 * @param {string} telefono - teléfono crudo (con o sin formato).
 * @param {string} texto - mensaje a precargar.
 * @returns {string}
 */
export function construirEnlaceWhatsApp(telefono, texto) {
  const normalizado = normalizarTelefono(telefono);
  return `https://wa.me/${normalizado}?text=${encodeURIComponent(texto)}`;
}
