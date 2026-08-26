// Componentes de UI reutilizables (contrato 2.4/2.7 del PLAN-MVP.md):
// microcopy didáctica colapsable, toast, paginador, estado vacío, badge de
// estado con color semántico + texto/ícono (accesibilidad: nunca solo color).
//
// Convención de este módulo: los componentes "de layout" (microcopy, estado
// vacío, badge) devuelven HTML en string para insertarse con innerHTML; los
// que necesitan comportamiento (toast, paginador) exponen una función
// "activar*" que se llama después de insertar el HTML en el DOM.

import { formatearCentavos } from '../utils/money.js';
import { listarClientes } from '../db.js';

// ============================================================
// Escape de HTML (toda interpolación de datos del usuario pasa por acá)
// ============================================================

export function escapeHtml(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// Iconos SVG inline (pase visual, gate del dueño 25-ago-2026)
//
// Set propio, sin dependencias externas: trazo simple de 2px, esquinas y
// remates redondeados, currentColor (heredan el color de su contenedor en
// ambos temas). Relleno (fill) solo en los pocos puntos que representan un
// "estado" (el punto del día en el ícono de Hoy, la media luna de PARCIAL,
// los puntos de exclamación/alerta) — nunca como estilo decorativo general.
// Reemplazan los emoji/caracteres usados antes en la barra de navegación,
// los badges de estado del calendario, el botón flotante, las acciones del
// Detalle y el selector de persona.
// ============================================================

function svgIcono(interior, { viewBox = '0 0 24 24', tamano = '1em' } = {}) {
  return `<svg class="icono-svg" viewBox="${viewBox}" width="${tamano}" height="${tamano}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${interior}</svg>`;
}

export const Iconos = {
  hoy: (o) => svgIcono(
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>' +
    '<rect x="7" y="13" width="4" height="4" rx="1" fill="currentColor" stroke="none"/>', o),
  calendario: (o) => svgIcono(
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>' +
    '<circle cx="8" cy="14.5" r="1" fill="currentColor" stroke="none"/>' +
    '<circle cx="12" cy="14.5" r="1" fill="currentColor" stroke="none"/>' +
    '<circle cx="16" cy="14.5" r="1" fill="currentColor" stroke="none"/>' +
    '<circle cx="8" cy="18" r="1" fill="currentColor" stroke="none"/>' +
    '<circle cx="12" cy="18" r="1" fill="currentColor" stroke="none"/>', o),
  personas: (o) => svgIcono(
    '<circle cx="9" cy="8" r="3"/><path d="M4 20c0-3 2.2-5.5 5-5.5s5 2.5 5 5.5"/>' +
    '<circle cx="17" cy="9" r="2.3"/><path d="M15.3 14.7c2.2.5 3.9 2.6 3.9 5.3"/>', o),
  resumen: (o) => svgIcono(
    '<line x1="3" y1="20" x2="21" y2="20"/><line x1="6" y1="20" x2="6" y2="12"/>' +
    '<line x1="12" y1="20" x2="12" y2="6"/><line x1="18" y1="20" x2="18" y2="15"/>', o),
  mas: (o) => svgIcono('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', o),
  chevronIzquierda: (o) => svgIcono('<polyline points="15,5 8,12 15,19"/>', o),
  chevronDerecha: (o) => svgIcono('<polyline points="9,5 16,12 9,19"/>', o),
  check: (o) => svgIcono('<polyline points="5,13 10,18 19,7"/>', o),
  cruz: (o) => svgIcono('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>', o),
  flechaArriba: (o) => svgIcono('<line x1="12" y1="19" x2="12" y2="6"/><polyline points="6,12 12,6 18,12"/>', o),
  medio: (o) => svgIcono('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>', o),
  alerta: (o) => svgIcono('<circle cx="12" cy="12" r="9"/><line x1="12" y1="7.5" x2="12" y2="13"/><circle cx="12" cy="16.4" r="1" fill="currentColor" stroke="none"/>', o),
  guion: (o) => svgIcono('<line x1="6" y1="12" x2="18" y2="12"/>', o),
  punto: (o) => svgIcono('<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>', o),
  mensaje: (o) => svgIcono('<path d="M4 5h16v11H8l-4 4z"/>', o),
  documento: (o) => svgIcono(
    '<path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/>' +
    '<line x1="9.5" y1="11" x2="14.5" y2="11"/><line x1="9.5" y1="14" x2="14.5" y2="14"/><line x1="9.5" y1="17" x2="12.5" y2="17"/>', o),
  renegociar: (o) => svgIcono(
    '<path d="M4 12a8 8 0 0 1 14-5.3"/><path d="M20 4v4h-4"/>' +
    '<path d="M20 12a8 8 0 0 1-14 5.3"/><path d="M6 20v-4h4"/>', o),
};

// ============================================================
// Dinero: null honesto (sin dato = "—", jamás $0.00 inventado)
// ============================================================

/**
 * @param {number|null|undefined} centavos
 * @returns {string}
 */
export function montoOGuion(centavos) {
  if (centavos === null || centavos === undefined) return '—';
  return formatearCentavos(centavos);
}

/** Clase CSS semántica para un saldo: rojo si debe, verde/gris si está al día. */
export function claseSaldo(centavos) {
  if (centavos === null || centavos === undefined) return 'monto-neutro';
  if (centavos > 0) return 'monto-negativo';
  return 'monto-positivo';
}

const formateadorCorto = new Intl.NumberFormat('es-MX', {
  style: 'currency', currency: 'MXN', minimumFractionDigits: 0, maximumFractionDigits: 0,
});

/**
 * Monto en centavos formateado sin decimales (ej. "$50"), para espacios muy
 * chicos como las casillas del calendario. Null honesto: "—" si no hay dato.
 * @param {number|null|undefined} centavos
 * @returns {string}
 */
export function montoCortoOGuion(centavos) {
  if (centavos === null || centavos === undefined) return '—';
  return formateadorCorto.format(Math.round(centavos) / 100);
}

// ============================================================
// Frecuencia de cobro (§2.8): un único helper de formateo, usado en los 4
// lugares donde se muestra la cuota (Detalle, historial de acuerdos,
// selector de persona del Calendario, lista de Clientes) — no duplicar.
// ============================================================

export const DIAS_SEMANA_OPCIONES = [
  { valor: 0, etiqueta: 'Domingo' },
  { valor: 1, etiqueta: 'Lunes' },
  { valor: 2, etiqueta: 'Martes' },
  { valor: 3, etiqueta: 'Miércoles' },
  { valor: 4, etiqueta: 'Jueves' },
  { valor: 5, etiqueta: 'Viernes' },
  { valor: 6, etiqueta: 'Sábado' },
];

const DIAS_SEMANA_LARGO = DIAS_SEMANA_OPCIONES.map((d) => d.etiqueta.toLowerCase());

/**
 * Descriptor corto de la frecuencia de un acuerdo, para componer junto al
 * monto ("$200.00 " + textoFrecuencia(a) = "$200.00 cada viernes") o solo
 * ("diaria", "cada día 15"). Null honesto: "—" si no hay acuerdo.
 * @param {{frecuencia?:string, dia_semana?:?number, dia_mes?:?number}|null} acuerdo
 * @returns {string}
 */
export function textoFrecuencia(acuerdo) {
  if (!acuerdo) return '—';
  const frecuencia = acuerdo.frecuencia || 'DIARIA';
  if (frecuencia === 'DIARIA') return 'diaria';
  if (frecuencia === 'SEMANAL') {
    const nombreDia = DIAS_SEMANA_LARGO[acuerdo.dia_semana];
    return nombreDia ? `cada ${nombreDia}` : 'semanal';
  }
  if (frecuencia === 'MENSUAL') {
    return Number.isInteger(acuerdo.dia_mes) ? `cada día ${acuerdo.dia_mes}` : 'mensual';
  }
  return frecuencia.toLowerCase();
}

// ============================================================
// Fechas legibles en español (solo para mostrar en UI; date.js sigue siendo
// la única fuente de verdad para lógica de negocio)
// ============================================================

function parsearFechaLocal(fechaIso) {
  const [anio, mes, dia] = fechaIso.split('-').map(Number);
  return new Date(anio, mes - 1, dia, 12, 0, 0, 0);
}

/** Ej: "Martes 25 de agosto". */
export function formatearFechaLegible(fechaIso) {
  const d = parsearFechaLocal(fechaIso);
  const texto = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** Ej: "25/08/2026", para filas de tabla/historial. */
export function formatearFechaCorta(fechaIso) {
  const d = parsearFechaLocal(fechaIso);
  return new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

/** Nombre de mes + año, ej. "Agosto 2026", para encabezados de calendario/resumen. */
export function formatearMesAnio(anioMes) {
  const [anio, mes] = anioMes.split('-').map(Number);
  const d = new Date(anio, mes - 1, 1, 12, 0, 0);
  const texto = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric' }).format(d);
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

// ============================================================
// Microcopy didáctica colapsable
// ============================================================

/**
 * @param {string} titulo - texto corto siempre visible, ej. "¿Para qué sirve esta pantalla?"
 * @param {string} htmlInterno - HTML ya armado (puede incluir <p>, <ul>, etc.)
 */
export function microcopy(titulo, htmlInterno) {
  return `<details class="microcopy">
    <summary>${escapeHtml(titulo)}</summary>
    <div class="microcopy-contenido">${htmlInterno}</div>
  </details>`;
}

// ============================================================
// Estado vacío
// ============================================================

export function estadoVacio(mensaje, subtexto = '') {
  return `<div class="estado-vacio">
    <p class="estado-vacio-mensaje">${escapeHtml(mensaje)}</p>
    ${subtexto ? `<p class="estado-vacio-subtexto">${escapeHtml(subtexto)}</p>` : ''}
  </div>`;
}

// ============================================================
// Badge de estado (calendario): color + texto + ícono, nunca solo color
// ============================================================

export const INFO_ESTADO = {
  PAGADO: { texto: 'Pagado', icono: Iconos.check(), clase: 'estado-pagado' },
  GRACIA_ADELANTO: { texto: 'Gracia/Adelanto', icono: Iconos.flechaArriba(), clase: 'estado-gracia-adelanto' },
  PARCIAL: { texto: 'Parcial', icono: Iconos.medio(), clase: 'estado-parcial' },
  DEUDA: { texto: 'Deuda', icono: Iconos.alerta(), clase: 'estado-deuda' },
  SIN_OBLIGACION: { texto: 'Sin obligación', icono: Iconos.guion(), clase: 'estado-sin-obligacion' },
};

export function badgeEstado(estado) {
  const info = INFO_ESTADO[estado] || { texto: estado || '—', icono: Iconos.guion(), clase: '' };
  return `<span class="badge-estado ${info.clase}"><span class="badge-estado-icono" aria-hidden="true">${info.icono}</span> ${escapeHtml(info.texto)}</span>`;
}

/** Leyenda completa de los 5 estados, para el calendario del detalle de cliente. */
export function leyendaEstados() {
  const items = Object.keys(INFO_ESTADO)
    .map((clave) => `<li>${badgeEstado(clave)}</li>`)
    .join('');
  return `<ul class="leyenda-estados">${items}</ul>`;
}

// ============================================================
// Toast (confirmación visual / error), con aria-live para accesibilidad
// ============================================================

export function mostrarToast(mensaje, tipo = 'info') {
  let contenedor = document.getElementById('toast-contenedor');
  if (!contenedor) {
    contenedor = document.createElement('div');
    contenedor.id = 'toast-contenedor';
    contenedor.className = 'toast-contenedor';
    contenedor.setAttribute('aria-live', 'polite');
    contenedor.setAttribute('role', 'status');
    document.body.appendChild(contenedor);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${tipo}`;
  toast.textContent = mensaje;
  contenedor.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

// ============================================================
// Paginador
// ============================================================

export function paginadorHtml({ pagina, tamanioPagina, total }) {
  const totalPaginas = Math.max(1, Math.ceil(total / tamanioPagina));
  if (totalPaginas <= 1) return '';
  return `<div class="paginador" data-pagina="${pagina}" data-total-paginas="${totalPaginas}">
    <button type="button" class="btn btn-secundario" data-accion="pagina-anterior" ${pagina <= 1 ? 'disabled' : ''}>${Iconos.chevronIzquierda()} Anterior</button>
    <span class="paginador-info">Página ${pagina} de ${totalPaginas}</span>
    <button type="button" class="btn btn-secundario" data-accion="pagina-siguiente" ${pagina >= totalPaginas ? 'disabled' : ''}>Siguiente ${Iconos.chevronDerecha()}</button>
  </div>`;
}

/**
 * @param {HTMLElement} contenedor - elemento que contiene el .paginador insertado
 * @param {(nuevaPagina:number)=>void} onCambiarPagina
 */
export function activarPaginador(contenedor, onCambiarPagina) {
  const nodo = contenedor.querySelector('.paginador');
  if (!nodo) return;
  nodo.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-accion]');
    if (!btn || btn.disabled) return;
    const pagina = parseInt(nodo.dataset.pagina, 10);
    const totalPaginas = parseInt(nodo.dataset.totalPaginas, 10);
    if (btn.dataset.accion === 'pagina-anterior' && pagina > 1) onCambiarPagina(pagina - 1);
    if (btn.dataset.accion === 'pagina-siguiente' && pagina < totalPaginas) onCambiarPagina(pagina + 1);
  });
}

// ============================================================
// Mensaje de error inline genérico (para fallos de guardado no asociados a un campo)
// ============================================================

export function errorGeneral(mensaje) {
  return `<p class="error-general" role="alert">${escapeHtml(mensaje)}</p>`;
}

export function errorCampo(mensaje) {
  return mensaje ? `<p class="error-campo" role="alert">${escapeHtml(mensaje)}</p>` : '';
}

// ============================================================
// Bloque de campos "Frecuencia de cobro" (§2.8): compartido por el alta de
// cliente (pantalla-clientes.js) y la renegociación de cuota
// (pantalla-cliente-detalle.js) — un solo lugar para el marcado y el toggle
// Semanal/Mensual, evita duplicar las dos pantallas.
// ============================================================

/**
 * @param {string} idBase - prefijo único de ids (dos formularios en la misma
 *   pantalla no deberían coexistir, pero por las dudas)
 * @param {{frecuencia?:string, dia_semana?:number, dia_mes?:number}} [valores]
 * @param {{frecuencia?:string, dia_semana?:string, dia_mes?:string}} [errores] - ya vienen por campo desde db.js
 * @returns {string}
 */
export function campoFrecuenciaHtml(idBase, valores = {}, errores = {}) {
  const frecuencia = valores.frecuencia || 'DIARIA';
  return `
    <div class="campo">
      <label for="${idBase}-frecuencia">Frecuencia de cobro</label>
      <select id="${idBase}-frecuencia" name="frecuencia">
        <option value="DIARIA" ${frecuencia === 'DIARIA' ? 'selected' : ''}>Diaria</option>
        <option value="SEMANAL" ${frecuencia === 'SEMANAL' ? 'selected' : ''}>Semanal</option>
        <option value="MENSUAL" ${frecuencia === 'MENSUAL' ? 'selected' : ''}>Mensual</option>
      </select>
      ${errorCampo(errores.frecuencia)}
    </div>
    <div class="campo" id="${idBase}-wrap-dia-semana" ${frecuencia !== 'SEMANAL' ? 'hidden' : ''}>
      <label for="${idBase}-dia-semana">Día de la semana</label>
      <select id="${idBase}-dia-semana" name="dia_semana">
        <option value="" ${valores.dia_semana === undefined || valores.dia_semana === null ? 'selected' : ''}>Elegí un día…</option>
        ${DIAS_SEMANA_OPCIONES.map((d) => `<option value="${d.valor}" ${valores.dia_semana === d.valor ? 'selected' : ''}>${d.etiqueta}</option>`).join('')}
      </select>
      ${errorCampo(errores.dia_semana)}
    </div>
    <div class="campo" id="${idBase}-wrap-dia-mes" ${frecuencia !== 'MENSUAL' ? 'hidden' : ''}>
      <label for="${idBase}-dia-mes">Día del mes</label>
      <input id="${idBase}-dia-mes" name="dia_mes" type="number" inputmode="numeric" min="1" max="31"
        value="${valores.dia_mes !== undefined && valores.dia_mes !== null ? valores.dia_mes : ''}" />
      <p class="texto-secundario">Si el mes no tiene ese día, se cobra el último día del mes.</p>
      ${errorCampo(errores.dia_mes)}
    </div>
  `;
}

/**
 * Activa el toggle de visibilidad Semanal/Mensual del bloque anterior.
 * Llamar una vez, después de insertar campoFrecuenciaHtml() en el DOM.
 * @param {HTMLElement} contenedor - elemento que contiene el bloque (o el formulario entero)
 * @param {string} idBase - el mismo prefijo pasado a campoFrecuenciaHtml()
 */
export function activarCampoFrecuencia(contenedor, idBase) {
  const selectFrecuencia = contenedor.querySelector(`#${idBase}-frecuencia`);
  const wrapSemana = contenedor.querySelector(`#${idBase}-wrap-dia-semana`);
  const wrapMes = contenedor.querySelector(`#${idBase}-wrap-dia-mes`);
  if (!selectFrecuencia || !wrapSemana || !wrapMes) return;
  selectFrecuencia.addEventListener('change', () => {
    const valor = selectFrecuencia.value;
    wrapSemana.hidden = valor !== 'SEMANAL';
    wrapMes.hidden = valor !== 'MENSUAL';
  });
}

/**
 * Lee {frecuencia, dia_semana?, dia_mes?} de un FormData que incluye el
 * bloque de campoFrecuenciaHtml(), omitiendo el campo que no corresponde a
 * la frecuencia elegida (aunque su <input>/<select> siga en el DOM oculto
 * con un valor viejo — "hidden" no lo saca de FormData).
 * @param {FormData} datos
 * @returns {{frecuencia:string, dia_semana?:number, dia_mes?:number}}
 */
export function leerCampoFrecuencia(datos) {
  const frecuencia = datos.get('frecuencia') || 'DIARIA';
  const resultado = { frecuencia };
  if (frecuencia === 'SEMANAL') {
    const valor = datos.get('dia_semana');
    resultado.dia_semana = valor === null || valor === '' ? undefined : Number(valor);
  } else if (frecuencia === 'MENSUAL') {
    const valor = datos.get('dia_mes');
    resultado.dia_mes = valor === null || valor === '' ? undefined : Number(valor);
  }
  return resultado;
}

// ============================================================
// Debounce genérico (buscador de Clientes, selector de cliente del form)
// ============================================================

export function debounce(fn, esperaMs = 300) {
  let temporizador = null;
  return (...args) => {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => fn(...args), esperaMs);
  };
}

// ============================================================
// Selector de cliente con buscador (escala a 100+ clientes)
//
// Componente compartido: extraído del patrón original de
// pantalla-movimiento-form.js. Muestra un "chip" con la selección actual;
// al tocarlo abre un buscador con debounce ~300ms sobre listarClientes()
// (que ya pagina y filtra en SQL), con "Mostrar más" si hay más de una
// página de resultados. Usado por pantalla-movimiento-form.js (sin
// opcionEspecial: siempre hay que elegir un cliente real) y por
// pantalla-calendario.js (con opcionEspecial "Todas las personas", fija
// siempre como primera fila, sin filtrar por el texto de búsqueda).
// ============================================================

/**
 * @param {HTMLElement} host - elemento donde se monta (su innerHTML se reemplaza por completo)
 * @param {object} cfg
 * @param {string} cfg.idBase - prefijo único para los ids internos (evita colisiones si hay más de uno en la pantalla)
 * @param {string} [cfg.etiquetaCampo] - texto del <label>, ej. "Cliente" o "Persona"
 * @param {{id:string, etiqueta:string, sublabel?:string, icono?:string}} [cfg.opcionEspecial] - opción fija, siempre primera en el buscador, nunca filtrada por el texto
 * @param {{id:string, etiqueta:string, sublabel?:string, icono?:string}|null} [cfg.seleccionInicial] - qué mostrar como chip al montar
 * @param {boolean} [cfg.iniciarAbierto] - arranca mostrando el buscador en vez del chip (default: true si no hay seleccionInicial)
 * @param {number} [cfg.tamanioPagina=20]
 * @param {(seleccion: {id:string, etiqueta:string, sublabel?:string, icono?:string}|null) => void} cfg.onCambio - se llama con la nueva selección; recibe `null` cuando el usuario reabre el buscador sin haber elegido todavía (para que la pantalla que lo usa sepa que la selección quedó pendiente)
 */
export function montarSelectorCliente(host, cfg) {
  const {
    idBase,
    etiquetaCampo = 'Cliente',
    opcionEspecial = null,
    seleccionInicial = null,
    tamanioPagina = 20,
    onCambio,
  } = cfg;

  let seleccionActual = seleccionInicial;
  let abierto = cfg.iniciarAbierto !== undefined ? cfg.iniciarAbierto : !seleccionInicial;
  let busqueda = '';
  let pagina = 1;
  let resultados = [];
  let totalResultados = 0;

  function render() {
    if (abierto) renderBuscador();
    else renderChip();
  }

  function renderChip() {
    const seleccion = seleccionActual || opcionEspecial;
    const icono = seleccion && seleccion.icono ? `${seleccion.icono} ` : '';
    const texto = seleccion ? seleccion.etiqueta : 'Elegí una opción…';
    const sub = seleccion && seleccion.sublabel ? ` — ${seleccion.sublabel}` : '';
    host.innerHTML = `
      <div class="campo">
        ${etiquetaCampo ? `<label>${escapeHtml(etiquetaCampo)}</label>` : ''}
        <button type="button" class="chip-cliente-seleccionado" id="${idBase}-chip">
          <span>${icono}${escapeHtml(texto)}${escapeHtml(sub)}</span>
          <span class="btn-link" aria-hidden="true">Cambiar</span>
        </button>
      </div>`;
    host.querySelector(`#${idBase}-chip`).addEventListener('click', () => {
      abierto = true;
      busqueda = '';
      pagina = 1;
      resultados = [];
      totalResultados = 0;
      render();
      if (onCambio) onCambio(null); // selección pendiente: se reabrió el buscador sin elegir aún
    });
  }

  async function cargarResultados(reset) {
    if (reset) { pagina = 1; resultados = []; } else { pagina += 1; }
    const { clientes, total } = await listarClientes({ busqueda, pagina, tamanioPagina });
    const filaCliente = (c) => ({
      id: c.id,
      etiqueta: c.nombre,
      sublabel: [c.telefono || null, c.cuota_vigente_centavos != null ? montoOGuion(c.cuota_vigente_centavos) : null]
        .filter(Boolean).join(' — '),
    });
    resultados = reset ? clientes.map(filaCliente) : resultados.concat(clientes.map(filaCliente));
    totalResultados = total;
    renderListaResultados();
  }

  function renderBuscador() {
    host.innerHTML = `
      <div class="campo">
        ${etiquetaCampo ? `<label for="${idBase}-input">${escapeHtml(etiquetaCampo)}</label>` : ''}
        <input id="${idBase}-input" type="search" placeholder="Buscá por nombre o teléfono…" autocomplete="off" value="${escapeHtml(busqueda)}" />
        <div id="${idBase}-resultados" class="resultados-busqueda" aria-live="polite"></div>
      </div>`;
    const input = host.querySelector(`#${idBase}-input`);
    const buscar = debounce((texto) => {
      busqueda = texto.trim();
      cargarResultados(true);
    }, 300);
    input.addEventListener('input', (e) => buscar(e.target.value));
    cargarResultados(true);
  }

  function renderListaResultados() {
    const contenedorResultados = host.querySelector(`#${idBase}-resultados`);
    if (!contenedorResultados) return; // el usuario ya cambió de vista (chip) antes de que resolviera la consulta

    const filas = opcionEspecial ? [opcionEspecial, ...resultados] : resultados;
    // Null honesto: "resultados" (los clientes reales) puede quedar en cero
    // aunque "filas" no lo esté, cuando hay opcionEspecial (esa opción fija
    // siempre se muestra) — el mensaje de "sin resultados" se calcula sobre
    // los clientes, no sobre la lista final que ve el usuario.
    const sinResultadosDeClientes = resultados.length === 0;
    const mensajeVacio = busqueda
      ? estadoVacio(`No se encontraron clientes para "${busqueda}".`)
      : estadoVacio('Todavía no hay clientes.');

    if (filas.length === 0) {
      contenedorResultados.innerHTML = mensajeVacio;
      return;
    }

    const hayMas = resultados.length < totalResultados;
    contenedorResultados.innerHTML = `
      <ul class="lista lista-resultados-busqueda">
        ${filas.map((f) => `
          <li class="lista-item lista-item-clickeable selector-cliente-opcion" data-id="${escapeHtml(f.id)}" tabindex="0" role="button">
            <div class="lista-item-principal">
              <span class="lista-item-nombre">${f.icono ? f.icono + ' ' : ''}${escapeHtml(f.etiqueta)}</span>
            </div>
            ${f.sublabel ? `<div class="lista-item-secundaria"><span>${escapeHtml(f.sublabel)}</span></div>` : ''}
          </li>`).join('')}
      </ul>
      ${sinResultadosDeClientes && opcionEspecial ? mensajeVacio : ''}
      ${hayMas ? `<button type="button" class="btn btn-secundario btn-mostrar-mas" id="${idBase}-mostrar-mas">Mostrar más</button>` : ''}
    `;

    contenedorResultados.querySelectorAll('.selector-cliente-opcion').forEach((li) => {
      li.addEventListener('click', () => elegir(li.dataset.id));
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); elegir(li.dataset.id); } });
    });
    const btnMas = contenedorResultados.querySelector(`#${idBase}-mostrar-mas`);
    if (btnMas) btnMas.addEventListener('click', () => cargarResultados(false));

    function elegir(id) {
      const elegida = filas.find((f) => f.id === id);
      if (!elegida) return;
      seleccionActual = elegida;
      abierto = false;
      render();
      if (onCambio) onCambio(elegida);
    }
  }

  render();
}
