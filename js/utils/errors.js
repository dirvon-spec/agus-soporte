// Utilidad compartida para construir errores con {code, message} legibles.
// Usado en toda la capa de datos y utilidades: ningún error se traga silenciosamente.

/**
 * @param {'VALIDATION_ERROR'|'NOT_FOUND'|'CONFLICT'|'DB_ERROR'} code
 * @param {string} message
 * @param {object} [detalle] datos adicionales opcionales (ej. campo que falló)
 * @returns {Error & {code: string, detalle?: object}}
 */
export function crearError(code, message, detalle) {
  const err = new Error(message);
  err.code = code;
  if (detalle !== undefined) err.detalle = detalle;
  return err;
}
