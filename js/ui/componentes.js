// Componentes de UI reutilizables — contrato vigente §2.9 (PLAN-MVP.md):
// rediseño "sencillo" sin cuotas/frecuencias/WhatsApp. Estilo Excel: mínimos
// clics, datos a la vista.
//
// Convención: los componentes "de layout" (microcopy, estado vacío, chip)
// devuelven HTML en string para insertarse con innerHTML; los que necesitan
// comportamiento (toast, paginador, sheet, panel rápido, arrastre) exponen
// una función que se llama después de insertar el HTML en el DOM, o que
// arma+monta todo de punta a punta (abrirSheet, abrirPanelRapido, etc.).

import { formatearCentavos } from '../utils/money.js';
import { parsearAPesos } from '../utils/money.js';
import { hoy, esFechaIsoValida, esFutura } from '../utils/date.js';
import {
  crearCategoria, actualizarCategoria, borrarCategoriaLogica, listarCategorias,
  listarConceptos, crearConcepto, borrarConceptoLogico, registrarCargo, registrarAbono,
  listarClientesAgrupados, registrarVisitaSinAbono, eliminarVisitaSinAbono,
  corregirMontoMovimiento, borrarMovimientoLogico, restaurarMovimiento,
  esModoDemo, iniciarModoReal,
} from '../db.js';

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
// Iconos SVG inline — set propio, sin dependencias externas: trazo simple de
// 2px, esquinas y remates redondeados, currentColor (heredan el color de su
// contenedor en ambos temas). Set reducido tras el rediseño §2.9 (se retiran
// los íconos de cuotas/frecuencia/WhatsApp/estado de calendario).
// ============================================================

function svgIcono(interior, { viewBox = '0 0 24 24', tamano = '1em' } = {}) {
  return `<svg class="icono-svg" viewBox="${viewBox}" width="${tamano}" height="${tamano}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${interior}</svg>`;
}

export const Iconos = {
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
  arrastre: (o) => svgIcono(
    '<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>', o),
  lapiz: (o) => svgIcono('<path d="M4 20l1-4L16 5l3 3L8 19l-4 1z"/><path d="M14 7l3 3"/>', o),
  papelera: (o) => svgIcono('<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/><path d="M10 11v6M14 11v6"/>', o),
  // §2.10 A-204: reemplazan los emoji de engrane/globo/caja-archivo/flecha-de-
  // restaurar/alerta usados antes en la UI — mismo estilo (trazo 2px,
  // currentColor) que el resto del set.
  // Feedback del dueño: la versión anterior (círculo + rayos finos) se leía
  // como un ícono de sol/modo claro-oscuro, no como un engrane. Rediseñado
  // como círculo + 8 dientes rectangulares perimetrales (silueta clásica de
  // engrane, inequívoca incluso chica).
  engrane: (o) => svgIcono(
    '<circle cx="12" cy="12" r="6.3"/><circle cx="12" cy="12" r="2.4"/>' +
    '<rect x="10.7" y="1.6" width="2.6" height="3.1" rx="0.6" fill="currentColor" stroke="none"/>' +
    '<rect x="10.7" y="1.6" width="2.6" height="3.1" rx="0.6" fill="currentColor" stroke="none" transform="rotate(45 12 12)"/>' +
    '<rect x="10.7" y="1.6" width="2.6" height="3.1" rx="0.6" fill="currentColor" stroke="none" transform="rotate(90 12 12)"/>' +
    '<rect x="10.7" y="1.6" width="2.6" height="3.1" rx="0.6" fill="currentColor" stroke="none" transform="rotate(135 12 12)"/>' +
    '<rect x="10.7" y="1.6" width="2.6" height="3.1" rx="0.6" fill="currentColor" stroke="none" transform="rotate(180 12 12)"/>' +
    '<rect x="10.7" y="1.6" width="2.6" height="3.1" rx="0.6" fill="currentColor" stroke="none" transform="rotate(225 12 12)"/>' +
    '<rect x="10.7" y="1.6" width="2.6" height="3.1" rx="0.6" fill="currentColor" stroke="none" transform="rotate(270 12 12)"/>' +
    '<rect x="10.7" y="1.6" width="2.6" height="3.1" rx="0.6" fill="currentColor" stroke="none" transform="rotate(315 12 12)"/>', o),
  globo: (o) => svgIcono('<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><line x1="3" y1="12" x2="21" y2="12"/>', o),
  cajaArchivo: (o) => svgIcono('<rect x="3" y="7" width="18" height="13" rx="1"/><path d="M3 7l2-4h14l2 4"/><line x1="9" y1="12" x2="15" y2="12"/>', o),
  restaurar: (o) => svgIcono('<path d="M9 14l-5-5 5-5"/><path d="M4 9h10a6 6 0 016 6v1"/>', o),
  alerta: (o) => svgIcono('<path d="M12 3l10 18H2z"/><line x1="12" y1="9" x2="12" y2="13.5"/><circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none"/>', o),
  // §2.14: toggle claro/oscuro junto al engrane de Clientes.
  sol: (o) => svgIcono(
    '<circle cx="12" cy="12" r="4.3"/>' +
    '<line x1="12" y1="2.3" x2="12" y2="4.8"/><line x1="12" y1="19.2" x2="12" y2="21.7"/>' +
    '<line x1="2.3" y1="12" x2="4.8" y2="12"/><line x1="19.2" y1="12" x2="21.7" y2="12"/>' +
    '<line x1="5.1" y1="5.1" x2="6.9" y2="6.9"/><line x1="17.1" y1="17.1" x2="18.9" y2="18.9"/>' +
    '<line x1="5.1" y1="18.9" x2="6.9" y2="17.1"/><line x1="17.1" y1="6.9" x2="18.9" y2="5.1"/>', o),
  luna: (o) => svgIcono('<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>', o),
  // §2.14: acceso directo de respaldo en Clientes (reemplaza la microcopy).
  respaldo: (o) => svgIcono('<path d="M4.5 4h13l3 3v13h-16z"/><path d="M8 4v5h7V4"/><rect x="8" y="13.5" width="8" height="6"/>', o),
};

// ============================================================
// §2.14 — Toggle claro/oscuro: elección manual persistente que le gana al
// sistema; sin elección guardada, sigue prefers-color-scheme como siempre.
// La CLAVE debe coincidir EXACTO con el script inline de index.html (aplica
// el atributo en <html> antes del primer render, para evitar flash) — no se
// puede compartir una constante JS entre un <script> plano y un módulo, así
// que el valor literal está documentado en los dos lugares.
// ============================================================

const CLAVE_TEMA = 'agus-tema'; // ver también el script inline en index.html

function temaGuardado() {
  try {
    const v = localStorage.getItem(CLAVE_TEMA);
    return v === 'light' || v === 'dark' ? v : null;
  } catch (e) {
    return null; // localStorage puede fallar (modo privado, cuota llena) — cae a sistema
  }
}

function guardarTema(tema) {
  try {
    localStorage.setItem(CLAVE_TEMA, tema);
  } catch (e) {
    // Sin persistencia disponible: el toggle sigue funcionando en memoria
    // para esta sesión (aplicarTema ya corrió), simplemente no sobrevive un F5.
  }
}

function temaSistema() {
  return (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    ? 'dark' : 'light';
}

/** Tema realmente activo ahora mismo: elección manual si existe, si no el del sistema. */
export function temaActivo() {
  return (typeof document !== 'undefined' && document.documentElement.dataset.theme) || temaSistema();
}

function aplicarTema(tema) {
  document.documentElement.dataset.theme = tema;
}

/** Invierte el tema activo, lo persiste y lo aplica. Devuelve el nuevo tema. */
export function alternarTema() {
  const nuevo = temaActivo() === 'dark' ? 'light' : 'dark';
  aplicarTema(nuevo);
  guardarTema(nuevo);
  return nuevo;
}

/** Icono que representa el tema ACTIVO ahora mismo (sol=claro, luna=oscuro). */
export function iconoTemaHtml() {
  return temaActivo() === 'dark' ? Iconos.luna() : Iconos.sol();
}

/** Se llama una vez desde donde viva el botón toggle (§2.14: junto al
 * engrane de Clientes) — vuelve a pintar el icono/aria-label cuando el
 * SISTEMA cambia de tema y el gestor NO tiene una elección manual guardada
 * (si ya eligió manualmente, el sistema deja de importar, por diseño). */
export function wireCambioTemaSistema(actualizarUi) {
  if (typeof window === 'undefined' || !window.matchMedia) return;
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => { if (!temaGuardado()) actualizarUi(); };
  mql.addEventListener ? mql.addEventListener('change', onChange) : mql.addListener(onChange);
}

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

/**
 * §2.14 (fix de unificación, hallazgo de Agustín): "Balance general" —
 * cartera total de TODA la cuenta, calculada UNA sola vez acá para que
 * Clientes y Global jamás vuelvan a divergir. Suma de `saldo_centavos` (ya
 * histórico total, incluye futuros, excluye archivados) de los grupos que
 * entrega `listarClientesAgrupados()` — mismo dato, misma fórmula, en
 * ambas pantallas. NO es `totalesMes.carteraPendienteCentavos` (que sale de
 * `resumenMensual`: solo saldos positivos, incluye clientes dados de baja,
 * acotado al mes) — esa es una métrica DISTINTA a propósito y no debe
 * confundirse con esta.
 * @param {Array<{totales:{saldo_centavos:number}}>} grupos
 * @returns {number}
 */
export function calcularBalanceGeneral(grupos) {
  return grupos.reduce((acc, g) => acc + g.totales.saldo_centavos, 0);
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
// Toast (confirmación visual / error), con aria-live para accesibilidad
// ============================================================

// §2.11 fix-pass round 4 (A-301/A-302): un solo toast de "Deshacer" vigente a
// la vez en toda la app. Abrir uno nuevo invalida DE VERDAD al anterior (no
// solo lo oculta) — así ni siquiera un click ya en curso sobre el toast viejo
// puede disparar su onAccion contra un estado que un Deshacer/acción más
// reciente ya dejó atrás (repro del auditor: corregir dos veces seguidas
// dentro de la ventana de 6s y tocar el toast viejo).
let deshacerVigente = null;

/**
 * @param {string} mensaje
 * @param {'info'|'exito'|'error'} [tipo]
 * @param {{accionTexto?:string, onAccion?:()=>void|Promise<void>, duracionMs?:number}} [opciones]
 *   §2.11: mecanismo compartido de "Deshacer" — un botón de acción opcional
 *   dentro del propio toast, con su propia duración (más larga que el toast
 *   normal, ~6s en vez de ~3.2s). Tocar la acción cancela el auto-cierre y
 *   ejecuta `onAccion` (blindado: guarda one-shot + try/catch — ver A-301/A-302).
 */
export function mostrarToast(mensaje, tipo = 'info', opciones = {}) {
  const { accionTexto, onAccion, duracionMs = 3200 } = opciones;
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
  const spanMensaje = document.createElement('span');
  spanMensaje.className = 'toast-mensaje';
  spanMensaje.textContent = mensaje;
  toast.appendChild(spanMensaje);

  let cerrado = false;
  let temporizador = null;
  function cerrar() {
    if (cerrado) return;
    cerrado = true;
    clearTimeout(temporizador);
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }

  if (accionTexto && onAccion) {
    // Regla "un solo Deshacer vigente": el anterior queda inerte de una — su
    // guarda one-shot pasa a true, así que ni un click que ya estaba en
    // vuelo sobre él puede disparar su onAccion.
    if (deshacerVigente) deshacerVigente.marcarDisparado();

    let disparado = false; // guarda one-shot (A-302): un solo disparo posible, sea por doble-tap o por invalidación
    const btnAccion = document.createElement('button');
    btnAccion.type = 'button';
    btnAccion.className = 'toast-accion';
    btnAccion.textContent = accionTexto;
    btnAccion.addEventListener('click', async () => {
      if (disparado) return;
      disparado = true;
      btnAccion.disabled = true;
      cerrar();
      try {
        await onAccion();
      } catch (err) {
        // A-301: antes onAccion() corría sin await/try-catch — si fallaba (ej.
        // Deshacer sobre un movimiento que una corrección posterior ya había
        // reemplazado) moría como unhandled rejection y el usuario creía que
        // había deshecho cuando en realidad no pasó nada.
        mostrarToast('No se pudo deshacer — la acción ya fue modificada por un cambio posterior.', 'error');
      }
    });
    toast.appendChild(btnAccion);

    deshacerVigente = {
      marcarDisparado() {
        disparado = true;
        cerrar();
      },
    };
  }

  contenedor.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  temporizador = setTimeout(cerrar, duracionMs);
}

/**
 * §2.11: atajo para el toast-con-Deshacer que sigue a capturar un abono/
 * cargo, una visita-$0, una corrección o una eliminación. ~6s (más que el
 * toast normal, para dar tiempo real a arrepentirse).
 * @param {string} mensaje
 * @param {() => void|Promise<void>} onDeshacer
 */
export function mostrarToastDeshacer(mensaje, onDeshacer) {
  mostrarToast(mensaje, 'exito', { accionTexto: 'Deshacer', onAccion: onDeshacer, duracionMs: 6000 });
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
// Mensajes de error inline
// ============================================================

export function errorGeneral(mensaje) {
  return mensaje ? `<p class="error-general" role="alert">${escapeHtml(mensaje)}</p>` : '';
}

export function errorCampo(mensaje) {
  return mensaje ? `<p class="error-campo" role="alert">${escapeHtml(mensaje)}</p>` : '';
}

// ============================================================
// Debounce genérico (buscador de Clientes)
// ============================================================

export function debounce(fn, esperaMs = 300) {
  let temporizador = null;
  return (...args) => {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => fn(...args), esperaMs);
  };
}

// ============================================================
// Long-press genérico: distingue "tap" de "mantener presionado", suprimiendo
// el click normal cuando hubo long-press (así un mismo elemento puede tener
// dos gestos: tocar = una acción, mantener presionado = otra).
// Usado por los chips de categoría (tap = filtrar, long-press = editar).
// ============================================================

/**
 * @param {HTMLElement} el
 * @param {() => void} onLongPress
 * @param {(e: Event) => void} [onTap]
 * @param {number} [duracionMs=500]
 */
export function activarLongPress(el, onLongPress, onTap, duracionMs = 500) {
  const UMBRAL_PX = 10;
  let temporizador = null;
  let origen = null;
  let disparado = false;

  const cancelar = () => { clearTimeout(temporizador); temporizador = null; };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    disparado = false;
    origen = { x: e.clientX, y: e.clientY };
    temporizador = setTimeout(() => { disparado = true; onLongPress(); }, duracionMs);
  });
  el.addEventListener('pointermove', (e) => {
    if (!origen || disparado) return;
    const dx = e.clientX - origen.x;
    const dy = e.clientY - origen.y;
    if (Math.sqrt(dx * dx + dy * dy) > UMBRAL_PX) cancelar();
  });
  el.addEventListener('pointerup', cancelar);
  el.addEventListener('pointercancel', cancelar);
  el.addEventListener('pointerleave', cancelar);
  el.addEventListener('click', (e) => {
    if (disparado) {
      e.preventDefault();
      e.stopPropagation();
      disparado = false;
      return;
    }
    if (onTap) onTap(e);
  });
}

// ============================================================
// Arrastre para reordenar manualmente dentro de UN grupo (§2.9): agarre
// (⋮⋮) con arrastre inmediato en mouse, y long-press (~350ms) antes de
// empezar en táctil (para no interferir con el scroll normal de la lista).
// Al soltar, llama onSoltar() con el nuevo orden completo de ids del grupo
// (la fila Σ, sin data-cliente-id, nunca participa ni se mueve).
// ============================================================

/**
 * @param {HTMLElement} listaEl - <ul> cuyos <li data-cliente-id> son ordenables
 * @param {(idsEnOrden: string[]) => void} onSoltar
 */
export function activarArrastreOrden(listaEl, onSoltar) {
  let filaArrastrada = null;
  let armado = false;
  let temporizadorArmado = null;
  let origenY = 0;

  function filasOrdenables() {
    return Array.from(listaEl.querySelectorAll(':scope > li[data-cliente-id]'));
  }

  function empezarArrastre(li) {
    armado = true;
    filaArrastrada = li;
    li.classList.add('fila-arrastrando');
  }

  function moverSegun(clientY) {
    if (!filaArrastrada) return;
    const filas = filasOrdenables().filter((f) => f !== filaArrastrada);
    let destino = null;
    for (const fila of filas) {
      const rect = fila.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) { destino = fila; break; }
    }
    if (destino) {
      if (filaArrastrada.nextElementSibling !== destino) listaEl.insertBefore(filaArrastrada, destino);
    } else {
      const filaSuma = listaEl.querySelector(':scope > li.fila-suma-grupo');
      if (filaSuma) {
        if (filaArrastrada.nextElementSibling !== filaSuma) listaEl.insertBefore(filaArrastrada, filaSuma);
      } else if (listaEl.lastElementChild !== filaArrastrada) {
        listaEl.appendChild(filaArrastrada);
      }
    }
  }

  function soltar() {
    clearTimeout(temporizadorArmado);
    if (filaArrastrada) {
      filaArrastrada.classList.remove('fila-arrastrando');
      const ids = filasOrdenables().map((li) => li.dataset.clienteId);
      onSoltar(ids);
    }
    filaArrastrada = null;
    armado = false;
  }

  listaEl.querySelectorAll(':scope > li[data-cliente-id] .asa-arrastre').forEach((asa) => {
    const li = asa.closest('li[data-cliente-id]');
    if (!li) return;
    asa.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      origenY = e.clientY;
      try { asa.setPointerCapture(e.pointerId); } catch { /* no soportado, seguimos igual */ }
      if (e.pointerType === 'touch' || e.pointerType === 'pen') {
        temporizadorArmado = setTimeout(() => empezarArrastre(li), 350);
      } else {
        empezarArrastre(li);
      }
    });
    asa.addEventListener('pointermove', (e) => {
      if (!armado) {
        if (Math.abs(e.clientY - origenY) > 10) clearTimeout(temporizadorArmado);
        return;
      }
      e.preventDefault();
      moverSegun(e.clientY);
    });
    asa.addEventListener('pointerup', soltar);
    asa.addEventListener('pointercancel', soltar);
  });
}

// ============================================================
// Bottom sheet genérico (modal deslizable desde abajo) — infraestructura
// compartida por el panel rápido (abono/cargo), nueva/editar categoría, y
// nuevo cliente. Un solo sheet activo a la vez.
// ============================================================

let elementoSheetActual = null;

function alTeclaEscSheet(e) {
  if (e.key === 'Escape') cerrarSheet();
}

export function cerrarSheet() {
  if (!elementoSheetActual) return;
  const el = elementoSheetActual;
  elementoSheetActual = null;
  document.removeEventListener('keydown', alTeclaEscSheet);
  el.classList.remove('sheet-overlay-visible');
  setTimeout(() => el.remove(), 200);
}

/**
 * @param {(host: HTMLElement) => void} armarContenido - arma y wire su propio
 *   contenido dentro de `host`; puede llamar cerrarSheet() cuando termine.
 * @param {{titulo: string}} opciones
 * @returns {HTMLElement} el host del contenido (por si el caller necesita re-render)
 */
export function abrirSheet(armarContenido, { titulo } = {}) {
  cerrarSheet();
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(titulo || '')}">
      <div class="sheet-agarre" aria-hidden="true"></div>
      <div class="sheet-header">
        <h2>${escapeHtml(titulo || '')}</h2>
        <button type="button" class="btn-icono sheet-cerrar" aria-label="Cerrar">${Iconos.cruz()}</button>
      </div>
      <div class="sheet-contenido"></div>
    </div>`;
  document.body.appendChild(overlay);
  elementoSheetActual = overlay;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrarSheet(); });
  overlay.querySelector('.sheet-cerrar').addEventListener('click', () => cerrarSheet());
  document.addEventListener('keydown', alTeclaEscSheet);
  requestAnimationFrame(() => overlay.classList.add('sheet-overlay-visible'));
  const host = overlay.querySelector('.sheet-contenido');
  armarContenido(host);
  return host;
}

// ============================================================
// Paleta fija de categorías (§2.9): 12 colores; se repiten si hay más de 12
// categorías — la bolita + el nombre desambiguan.
// ============================================================

export const PALETA_COLORES_CATEGORIA = [
  'hsl(0 70% 45%)', 'hsl(25 75% 48%)', 'hsl(45 80% 42%)', 'hsl(95 45% 38%)',
  'hsl(150 55% 34%)', 'hsl(175 55% 34%)', 'hsl(205 65% 45%)', 'hsl(225 60% 55%)',
  'hsl(265 55% 55%)', 'hsl(300 45% 45%)', 'hsl(335 60% 48%)', 'hsl(20 20% 40%)',
];

/** Bolita de color de categoría (o gris neutro si no hay categoría). */
export function bolitaHtml(color, extraClase = '') {
  const estilo = color ? `background:${escapeHtml(color)}` : '';
  return `<span class="bolita ${color ? '' : 'bolita-neutra'} ${extraClase}" style="${estilo}" aria-hidden="true"></span>`;
}

/**
 * Sheet para crear o editar una categoría (nombre + paleta de 12 colores).
 * @param {{categoria?: object|null, onGuardado?: (cat:object)=>void, onEliminada?: (id:string)=>void}} cfg
 */
export function abrirSheetCategoria({ categoria = null, onGuardado, onEliminada } = {}) {
  abrirSheet((host) => {
    let colorSeleccionado = categoria ? categoria.color : PALETA_COLORES_CATEGORIA[0];
    let error = {};
    // Lo ya tipeado en Nombre sobrevive a los re-render que dispara elegir un
    // color (si no se capturara acá, cada render() reconstruye el <form> desde
    // cero y el nombre ya tipeado se perdería silenciosamente — A-102).
    let valorNombre = categoria ? categoria.nombre : '';

    function capturarValoresActuales() {
      const nombreEl = host.querySelector('#cat-nombre');
      if (nombreEl) valorNombre = nombreEl.value;
    }

    function render() {
      capturarValoresActuales();
      host.innerHTML = `
        <form id="form-categoria" class="formulario" novalidate>
          <div class="campo">
            <label for="cat-nombre">Nombre</label>
            <input id="cat-nombre" name="nombre" type="text" value="${escapeHtml(valorNombre)}" required autofocus />
            ${errorCampo(error.nombre)}
          </div>
          <div class="campo">
            <label>Color</label>
            <div class="paleta-colores">
              ${PALETA_COLORES_CATEGORIA.map((c) => `
                <button type="button" class="bolita-color ${c === colorSeleccionado ? 'bolita-color-activa' : ''}" data-color="${escapeHtml(c)}" style="background:${escapeHtml(c)}" aria-label="Elegir este color">
                  ${c === colorSeleccionado ? `<span class="bolita-color-check">${Iconos.check()}</span>` : ''}
                </button>`).join('')}
            </div>
            ${errorCampo(error.color)}
          </div>
          ${errorGeneral(error.general)}
          <div class="acciones-formulario acciones-formulario-columna">
            <button type="submit" class="btn btn-primario btn-ancho">${categoria ? 'Guardar cambios' : 'Crear categoría'}</button>
            ${categoria ? `<button type="button" class="btn btn-peligro btn-ancho" id="btn-eliminar-categoria">Eliminar categoría</button>` : ''}
          </div>
        </form>`;

      host.querySelectorAll('.bolita-color').forEach((b) => {
        b.addEventListener('click', () => { colorSeleccionado = b.dataset.color; render(); });
      });
      const form = host.querySelector('#form-categoria');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const nombre = form.nombre.value.trim();
        error = {};
        if (nombre.length < 1) error.nombre = 'El nombre es obligatorio.';
        if (Object.keys(error).length > 0) { render(); return; }
        try {
          const resultado = categoria
            ? await actualizarCategoria(categoria.id, { nombre, color: colorSeleccionado })
            : await crearCategoria({ nombre, color: colorSeleccionado });
          cerrarSheet();
          mostrarToast(categoria ? 'Categoría actualizada.' : 'Categoría creada.', 'exito');
          if (onGuardado) onGuardado(resultado);
        } catch (err) {
          if (err.code === 'VALIDATION_ERROR' && err.detalle && err.detalle.campo) error[err.detalle.campo] = err.message;
          else if (err.code === 'CONFLICT') error.nombre = err.message;
          else error.general = err.message || 'No se pudo guardar la categoría.';
          render();
        }
      });
      const btnEliminar = host.querySelector('#btn-eliminar-categoria');
      if (btnEliminar) {
        btnEliminar.addEventListener('click', async () => {
          const ok = window.confirm(`¿Eliminar la categoría "${categoria.nombre}"? Sus clientes pasarán a "Sin categoría".`);
          if (!ok) return;
          try {
            await borrarCategoriaLogica(categoria.id);
            cerrarSheet();
            mostrarToast('Categoría eliminada.', 'exito');
            if (onEliminada) onEliminada(categoria.id);
          } catch (err) {
            error.general = err.message || 'No se pudo eliminar la categoría.';
            render();
          }
        });
      }
    }
    render();
  }, { titulo: categoria ? 'Editar categoría' : 'Nueva categoría' });
}

// ============================================================
// Panel rápido (bottom sheet): registrar abono o cargo en 3 toques.
// ============================================================

/**
 * @param {{tipo:'ABONO'|'CARGO', clienteId:string, clienteNombre:string, onGuardado?: ()=>void, fechaInicial?: string}} cfg
 *   §2.11: `fechaInicial` — la pantalla Clientes en vista-día lo pasa para
 *   precargar el DÍA VISTO (no necesariamente hoy); Persona/Global lo omiten
 *   y cae al default de siempre (hoy()).
 */
export function abrirPanelRapido({ tipo, clienteId, clienteNombre, onGuardado, fechaInicial }) {
  abrirSheet((host) => {
    renderPanelRapidoInterno(host, tipo, clienteId, onGuardado, fechaInicial);
  }, { titulo: `${tipo === 'ABONO' ? 'Abono' : 'Cargo'} — ${clienteNombre}` });
}

/**
 * Formatea el buffer crudo del keypad (solo dígitos + un punto opcional, sin
 * comas) a texto legible mientras se tipea, ej. "1234.5" -> "$1,234.5".
 * Puramente de presentación — el valor que se valida/parsea es el buffer
 * crudo (parsearAPesos ya acepta "1234.50" sin comas).
 * @param {string} buffer
 */
function formatearBufferMonto(buffer) {
  if (!buffer) return '$0';
  const [enteroCrudo, decimal] = buffer.split('.');
  const entero = enteroCrudo === '' ? '0' : enteroCrudo;
  const enteroConComas = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return buffer.includes('.') ? `$${enteroConComas}.${decimal ?? ''}` : `$${enteroConComas}`;
}

/** Markup del teclado numérico de 14 teclas — compartido entre el panel
 * rápido y el sheet de "Corregir monto" (§2.11). */
function keypadGridHtml() {
  return `
    <div class="keypad-grid">
      <button type="button" class="keypad-tecla" data-tecla="7" style="grid-column:1;grid-row:1;">7</button>
      <button type="button" class="keypad-tecla" data-tecla="8" style="grid-column:2;grid-row:1;">8</button>
      <button type="button" class="keypad-tecla" data-tecla="9" style="grid-column:3;grid-row:1;">9</button>
      <button type="button" class="keypad-tecla keypad-borrar" data-tecla="borrar" aria-label="Borrar" style="grid-column:4;grid-row:1;">⌫</button>
      <button type="button" class="keypad-tecla" data-tecla="4" style="grid-column:1;grid-row:2;">4</button>
      <button type="button" class="keypad-tecla" data-tecla="5" style="grid-column:2;grid-row:2;">5</button>
      <button type="button" class="keypad-tecla" data-tecla="6" style="grid-column:3;grid-row:2;">6</button>
      <button type="submit" class="keypad-tecla keypad-guardar" style="grid-column:4;grid-row:2 / span 2;">✓<br>Guardar</button>
      <button type="button" class="keypad-tecla" data-tecla="1" style="grid-column:1;grid-row:3;">1</button>
      <button type="button" class="keypad-tecla" data-tecla="2" style="grid-column:2;grid-row:3;">2</button>
      <button type="button" class="keypad-tecla" data-tecla="3" style="grid-column:3;grid-row:3;">3</button>
      <button type="button" class="keypad-tecla" data-tecla="0" style="grid-column:1;grid-row:4;">0</button>
      <button type="button" class="keypad-tecla" data-tecla="00" style="grid-column:2;grid-row:4;">00</button>
      <button type="button" class="keypad-tecla" data-tecla="." style="grid-column:3;grid-row:4;">.</button>
    </div>`;
}

/** Wire genérico de las 14 teclas del keypad — llama `onTecla(valor)` por cada click. */
function wireKeypadTeclas(host, onTecla) {
  host.querySelectorAll('.keypad-tecla[data-tecla]').forEach((btn) => {
    btn.addEventListener('click', () => onTecla(btn.dataset.tecla));
  });
}

async function renderPanelRapidoInterno(host, tipo, clienteId, onGuardado, fechaInicial) {
  let conceptos = tipo === 'CARGO' ? await listarConceptos() : [];
  let conceptoElegido = null;
  let mostrarNuevoConcepto = false;
  let error = {};
  // B-024 (§2.10): el monto se captura con keypad propio — vive como buffer
  // en JS (nunca en un <input> real), así que sobrevive a cualquier re-render
  // sin necesidad de "capturar antes de renderizar" (ya no aplica la técnica
  // usada para fecha/referencia, porque acá no hay foco de sistema que perder).
  let valorMonto = '';
  // Lo ya tipeado en fecha/referencia sobrevive a los re-render que disparan
  // elegir un concepto o crear uno al vuelo (mismo patrón que antes).
  let valorFecha = fechaInicial || hoy();
  let valorReferencia = '';
  let valorNuevoConcepto = '';

  function capturarValoresActuales() {
    const fechaEl = host.querySelector('#pr-fecha');
    if (fechaEl) valorFecha = fechaEl.value;
    const refEl = host.querySelector('#pr-referencia');
    if (refEl) valorReferencia = refEl.value;
    const nuevoConceptoEl = host.querySelector('#pr-nuevo-concepto-nombre');
    if (nuevoConceptoEl) valorNuevoConcepto = nuevoConceptoEl.value;
  }

  function agregarDigito(d) {
    const [, decimal] = valorMonto.split('.');
    if (decimal !== undefined && decimal.length >= 2) return; // ya completo a centavos
    valorMonto += d;
  }

  function manejarTeclaKeypad(tecla) {
    if (tecla === 'borrar') valorMonto = valorMonto.slice(0, -1);
    else if (tecla === '.') { if (!valorMonto.includes('.')) valorMonto = (valorMonto || '0') + '.'; }
    else if (tecla === '00') { agregarDigito('0'); agregarDigito('0'); }
    else agregarDigito(tecla);
    if (error.monto_centavos) error.monto_centavos = null;
    render();
  }

  function render() {
    capturarValoresActuales();
    // §2.12: registros a futuro (adelantos) — solo para ABONO/CARGO. La
    // fecha ya no tiene tope, así que "Hoy no abona" (marca de ruta del día,
    // no un movimiento de dinero) se oculta apenas la fecha elegida es
    // futura — registrarVisitaSinAbono sigue rechazándola del lado de datos.
    const fechaEsFutura = esFutura(valorFecha);
    host.innerHTML = `
      <form id="form-panel-rapido" class="formulario formulario-panel-rapido" novalidate>
        <div class="keypad-monto">
          <div class="keypad-display ${error.monto_centavos ? 'keypad-display-error' : ''}" id="pr-monto-display" role="text" aria-label="Monto">${escapeHtml(formatearBufferMonto(valorMonto))}</div>
          ${errorCampo(error.monto_centavos)}
        </div>
        ${tipo === 'CARGO' ? `
          <div class="campo">
            <label>Concepto</label>
            <div class="chips-fila">
              ${conceptos.map((c) => `<button type="button" class="chip chip-concepto ${conceptoElegido === c.nombre ? 'chip-activo' : ''}" data-concepto="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</button>`).join('')}
              <button type="button" class="chip chip-nuevo" id="pr-btn-nuevo-concepto">${Iconos.mas()} Nuevo</button>
            </div>
            ${mostrarNuevoConcepto ? `
              <div class="fila-nuevo-inline">
                <input id="pr-nuevo-concepto-nombre" type="text" placeholder="Nombre del concepto" value="${escapeHtml(valorNuevoConcepto)}" />
                <button type="button" class="btn btn-primario btn-pequeno" id="pr-confirmar-nuevo-concepto">Agregar</button>
              </div>` : ''}
            ${errorCampo(error.concepto)}
          </div>
          <div class="campo">
            <label for="pr-referencia">Referencia (opcional)</label>
            <input id="pr-referencia" name="referencia" type="text" value="${escapeHtml(valorReferencia)}" />
          </div>` : ''}

        ${keypadGridHtml()}

        <div class="campo">
          <label for="pr-fecha">Fecha ${fechaEsFutura ? '<span class="badge-futuro-chico">Adelanto</span>' : ''}</label>
          <input id="pr-fecha" name="fecha" type="date" value="${escapeHtml(valorFecha)}" />
          ${errorCampo(error.fecha)}
        </div>
        ${errorGeneral(error.general)}
        ${tipo === 'ABONO' && !fechaEsFutura ? `
          <button type="button" class="btn btn-secundario btn-ancho" id="pr-btn-hoy-no-abona">Hoy no abona ($0)</button>
        ` : ''}
      </form>`;

    wireKeypadTeclas(host, manejarTeclaKeypad);

    const campoFecha = host.querySelector('#pr-fecha');
    if (campoFecha) campoFecha.addEventListener('change', () => render());

    const btnHoyNoAbona = host.querySelector('#pr-btn-hoy-no-abona');
    if (btnHoyNoAbona) {
      btnHoyNoAbona.addEventListener('click', async () => {
        const fechaTexto = host.querySelector('#pr-fecha').value;
        if (!fechaTexto) { error.fecha = 'La fecha es obligatoria.'; render(); return; }
        try {
          const visita = await registrarVisitaSinAbono({ cliente_id: clienteId, fecha: fechaTexto });
          cerrarSheet();
          mostrarToastDeshacer('Visita registrada: hoy no abonó.', async () => {
            await eliminarVisitaSinAbono(visita.id);
            if (onGuardado) onGuardado();
          });
          if (onGuardado) onGuardado();
        } catch (err) {
          // §2.11: "Ya abonó ese día." se muestra como toast claro, no como
          // error inline — no es un problema del formulario, es un hecho ya
          // registrado que el gestor puede no saber.
          mostrarToast(err.message || 'No se pudo registrar la visita.', 'error');
        }
      });
    }

    if (tipo === 'CARGO') {
      host.querySelectorAll('.chip-concepto').forEach((chip) => {
        chip.addEventListener('click', () => {
          conceptoElegido = conceptoElegido === chip.dataset.concepto ? null : chip.dataset.concepto;
          mostrarNuevoConcepto = false;
          render();
        });
      });
      host.querySelector('#pr-btn-nuevo-concepto').addEventListener('click', () => {
        mostrarNuevoConcepto = !mostrarNuevoConcepto;
        render();
        const campoNuevo = host.querySelector('#pr-nuevo-concepto-nombre');
        if (campoNuevo) campoNuevo.focus();
      });
      const btnConfirmarNuevo = host.querySelector('#pr-confirmar-nuevo-concepto');
      if (btnConfirmarNuevo) {
        const confirmar = async () => {
          const campoNuevo = host.querySelector('#pr-nuevo-concepto-nombre');
          const nombre = campoNuevo.value.trim();
          if (nombre.length < 1) { campoNuevo.focus(); return; }
          try {
            const concepto = await crearConcepto({ nombre });
            conceptos = await listarConceptos();
            conceptoElegido = concepto.nombre;
            mostrarNuevoConcepto = false;
            valorNuevoConcepto = '';
            error = {};
            render();
          } catch (err) {
            error.concepto = err.message || 'No se pudo crear el concepto.';
            render();
          }
        };
        btnConfirmarNuevo.addEventListener('click', confirmar);
        host.querySelector('#pr-nuevo-concepto-nombre').addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); confirmar(); }
        });
      }
    }

    host.querySelector('#form-panel-rapido').addEventListener('submit', async (e) => {
      e.preventDefault();
      error = {};

      let montoCentavos = null;
      if (!valorMonto || valorMonto === '.') {
        error.monto_centavos = 'El monto es obligatorio.';
      } else {
        try {
          montoCentavos = parsearAPesos(valorMonto);
          if (montoCentavos <= 0) error.monto_centavos = 'El monto debe ser mayor a $0.';
        } catch (err) {
          error.monto_centavos = err.message;
        }
      }

      const fechaTexto = host.querySelector('#pr-fecha').value;
      if (!fechaTexto) error.fecha = 'La fecha es obligatoria.';
      else if (!esFechaIsoValida(fechaTexto)) error.fecha = 'La fecha no es válida.';
      // §2.12: sin tope de fecha futura para ABONO/CARGO (adelantos) — el
      // rechazo de futuro sigue vivo solo en registrarVisitaSinAbono.

      if (tipo === 'CARGO' && !conceptoElegido) error.concepto = 'Elegí (o creá) un concepto.';

      if (Object.keys(error).length > 0) { render(); return; }

      try {
        let movimientoCreado;
        if (tipo === 'ABONO') {
          movimientoCreado = await registrarAbono({ cliente_id: clienteId, monto_centavos: montoCentavos, fecha: fechaTexto });
        } else {
          const referencia = (host.querySelector('#pr-referencia').value || '').trim();
          movimientoCreado = await registrarCargo({
            cliente_id: clienteId, monto_centavos: montoCentavos, fecha: fechaTexto,
            concepto: conceptoElegido, referencia: referencia || undefined,
          });
        }
        cerrarSheet();
        mostrarToastDeshacer(tipo === 'ABONO' ? 'Abono registrado.' : 'Cargo registrado.', async () => {
          await borrarMovimientoLogico(movimientoCreado.id);
          if (onGuardado) onGuardado();
        });
        if (onGuardado) onGuardado();
      } catch (err) {
        if (err.code === 'VALIDATION_ERROR' && err.detalle && err.detalle.campo) {
          error[err.detalle.campo] = err.message;
        } else {
          error.general = err.message || 'No se pudo guardar el movimiento.';
        }
        render();
      }
    });
  }

  render();
}

// ============================================================
// §2.11 — "✎ Corregir monto" (keypad precargado) y "🗑 Eliminar" de un
// movimiento vivo (CARGO/ABONO — los AJUSTE históricos no tienen acciones,
// el mecanismo AJUSTE queda deprecated en UI). Ambos con Deshacer.
// ============================================================

/**
 * @param {{movimiento: object, onGuardado?: () => void}} cfg
 */
export function abrirSheetCorregirMonto({ movimiento, onGuardado }) {
  abrirSheet((host) => {
    let valorMonto = (movimiento.monto_centavos / 100).toFixed(2);
    let error = {};

    function agregarDigito(d) {
      const [, decimal] = valorMonto.split('.');
      if (decimal !== undefined && decimal.length >= 2) return;
      valorMonto += d;
    }

    function manejarTecla(tecla) {
      if (tecla === 'borrar') valorMonto = valorMonto.slice(0, -1);
      else if (tecla === '.') { if (!valorMonto.includes('.')) valorMonto = (valorMonto || '0') + '.'; }
      else if (tecla === '00') { agregarDigito('0'); agregarDigito('0'); }
      else agregarDigito(tecla);
      if (error.monto_centavos) error.monto_centavos = null;
      render();
    }

    function render() {
      host.innerHTML = `
        <form id="form-corregir-monto" class="formulario formulario-panel-rapido" novalidate>
          <div class="keypad-monto">
            <div class="keypad-display ${error.monto_centavos ? 'keypad-display-error' : ''}" role="text" aria-label="Monto">${escapeHtml(formatearBufferMonto(valorMonto))}</div>
            ${errorCampo(error.monto_centavos)}
          </div>
          ${keypadGridHtml()}
          ${errorGeneral(error.general)}
        </form>`;

      wireKeypadTeclas(host, manejarTecla);

      host.querySelector('#form-corregir-monto').addEventListener('submit', async (e) => {
        e.preventDefault();
        error = {};
        let nuevoMontoCentavos = null;
        if (!valorMonto || valorMonto === '.') {
          error.monto_centavos = 'El monto es obligatorio.';
        } else {
          try {
            nuevoMontoCentavos = parsearAPesos(valorMonto);
            if (nuevoMontoCentavos <= 0) error.monto_centavos = 'El monto debe ser mayor a $0.';
          } catch (err) {
            error.monto_centavos = err.message;
          }
        }
        if (Object.keys(error).length > 0) { render(); return; }

        try {
          const { nuevo, original_id } = await corregirMontoMovimiento(movimiento.id, nuevoMontoCentavos);
          cerrarSheet();
          mostrarToastDeshacer('Monto corregido.', async () => {
            await borrarMovimientoLogico(nuevo.id);
            await restaurarMovimiento(original_id);
            if (onGuardado) onGuardado();
          });
          if (onGuardado) onGuardado();
        } catch (err) {
          error.general = err.message || 'No se pudo corregir el monto.';
          render();
        }
      });
    }
    render();
  }, { titulo: `Corregir monto — ${movimiento.tipo === 'CARGO' ? 'Cargo' : 'Abono'}` });
}

/**
 * Confirmación + borrado lógico + Deshacer de un movimiento vivo (CARGO/
 * ABONO). Compartida entre Persona (lista de movimientos del mes) y Global
 * (desglose del día) — ambas arman el texto de confirmación con sus propios
 * datos ya formateados y solo llaman acá con el id y el callback de refresco.
 * @param {{id:string, mensajeConfirmacion:string, onGuardado?: () => void}} cfg
 */
export async function eliminarMovimientoConDeshacer({ id, mensajeConfirmacion, onGuardado }) {
  const ok = window.confirm(mensajeConfirmacion);
  if (!ok) return;
  try {
    await borrarMovimientoLogico(id);
    mostrarToastDeshacer('Movimiento eliminado.', async () => {
      await restaurarMovimiento(id);
      if (onGuardado) onGuardado();
    });
    if (onGuardado) onGuardado();
  } catch (err) {
    mostrarToast(err.message || 'No se pudo eliminar el movimiento.', 'error');
  }
}

/**
 * §2.11 (Global): selector de cliente compartido para "+ Agregar movimiento
 * en este día" — SIN opción "Todas" (siempre un cliente concreto). Filtra en
 * memoria sobre una única carga inicial (población chica, sin necesidad de
 * ida y vuelta por cada tecla). Elegido el cliente y el tipo (abono/cargo),
 * abre el panel rápido de siempre, con `fecha` precargada.
 * @param {{fecha: string, onGuardado?: () => void}} cfg
 */
export function abrirSheetSeleccionarCliente({ fecha, onGuardado }) {
  abrirSheet((host) => {
    let busqueda = '';
    let cargando = true;
    let gruposCompletos = [];

    function capturarBusqueda() {
      const input = host.querySelector('#sel-cliente-buscador');
      if (input) busqueda = input.value;
    }

    function gruposFiltrados() {
      const q = busqueda.trim().toLowerCase();
      if (!q) return gruposCompletos;
      return gruposCompletos
        .map((g) => ({ ...g, clientes: g.clientes.filter((c) => c.nombre.toLowerCase().includes(q) || (c.telefono || '').toLowerCase().includes(q)) }))
        .filter((g) => g.clientes.length > 0);
    }

    function render() {
      capturarBusqueda();
      const grupos = cargando ? [] : gruposFiltrados();
      host.innerHTML = `
        <div class="campo campo-compacto">
          <input id="sel-cliente-buscador" type="search" placeholder="Buscar por nombre o teléfono" value="${escapeHtml(busqueda)}" />
        </div>
        <div id="sel-cliente-lista">
          ${cargando ? '<p class="cargando">Cargando…</p>' : (grupos.length === 0
            ? estadoVacio('No se encontraron clientes.')
            : grupos.map((g) => `
              <section class="grupo-clientes">
                <h3 class="grupo-titulo">${bolitaHtml(g.categoria_color)} ${escapeHtml(g.categoria_nombre)}</h3>
                <ul class="lista lista-selector-cliente">
                  ${g.clientes.map((c) => `
                    <li class="lista-item fila-selector-cliente" data-cliente-id="${escapeHtml(c.id)}">
                      <span class="fila-selector-cliente-nombre">${escapeHtml(c.nombre)}</span>
                      <button type="button" class="btn btn-secundario btn-pequeno" data-tipo="ABONO">+Abono</button>
                      <button type="button" class="btn btn-secundario btn-pequeno" data-tipo="CARGO">+Cargo</button>
                    </li>`).join('')}
                </ul>
              </section>`).join(''))}
        </div>
      `;

      const inputBuscador = host.querySelector('#sel-cliente-buscador');
      inputBuscador.addEventListener('input', () => render());
      inputBuscador.focus();
      const largo = inputBuscador.value.length;
      inputBuscador.setSelectionRange(largo, largo);

      host.querySelectorAll('.fila-selector-cliente button[data-tipo]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const li = btn.closest('[data-cliente-id]');
          const nombre = li.querySelector('.fila-selector-cliente-nombre').textContent;
          cerrarSheet();
          abrirPanelRapido({
            tipo: btn.dataset.tipo,
            clienteId: li.dataset.clienteId,
            clienteNombre: nombre,
            fechaInicial: fecha,
            onGuardado,
          });
        });
      });
    }

    render();
    listarClientesAgrupados({}).then(({ grupos }) => {
      gruposCompletos = grupos;
      cargando = false;
      render();
    });
  }, { titulo: 'Elegir cliente' });
}

// ============================================================
// Bloqueante de producción: banner de modo demo + flujo "Empezar a trabajar
// con mis datos reales" (iniciarModoReal). Un solo lugar para no repetir la
// lógica en Clientes y Global.
// ============================================================

/**
 * Banner NO descartable, visible arriba de Clientes y Global mientras
 * `esModoDemo()` sea true. Devuelve '' en modo real (cero rastro).
 */
export function bannerModoDemoHtml() {
  if (!esModoDemo()) return '';
  return `
    <button type="button" class="banner-modo-demo" id="btn-banner-modo-demo">
      Estás viendo datos de EJEMPLO. Antes de registrar tus clientes reales, tocá acá para empezar de cero.
    </button>`;
}

/** Wire del click del banner — no-op si no está presente (modo real). */
export function wireBannerModoDemo(contenedor) {
  const btn = contenedor.querySelector('#btn-banner-modo-demo');
  if (btn) btn.addEventListener('click', () => abrirSheetIniciarModoReal());
}

/**
 * Confirmación fuerte de dos pasos para `iniciarModoReal()`: paso 1 explica
 * que es definitivo (sin Deshacer — a propósito, no es un error corregible);
 * paso 2 exige escribir "EMPEZAR" para habilitar el botón destructivo. Tras
 * confirmar, recarga la app entera en Clientes (más simple y confiable que
 * intentar re-renderizar todo el estado en memoria a mano tras borrar
 * absolutamente todo).
 */
export function abrirSheetIniciarModoReal() {
  abrirSheet((host) => {
    let paso = 1;
    let valorConfirmacion = '';
    let error = '';

    function capturarConfirmacion() {
      const input = host.querySelector('#confirmar-empezar');
      if (input) valorConfirmacion = input.value;
    }

    function render() {
      capturarConfirmacion();
      if (paso === 1) {
        host.innerHTML = `
          <div class="aviso-modo-real">
            <p><strong>Esto borra TODOS los clientes, movimientos, categorías y conceptos de EJEMPLO</strong>
              de esta base. Es definitivo — no hay Deshacer.</p>
            <p>Tus datos reales van a empezar desde una base completamente vacía.</p>
          </div>
          <div class="acciones-formulario acciones-formulario-columna">
            <button type="button" class="btn btn-peligro btn-ancho" id="btn-continuar-modo-real">Continuar</button>
            <button type="button" class="btn btn-secundario btn-ancho" id="btn-cancelar-modo-real">Cancelar</button>
          </div>`;
        host.querySelector('#btn-continuar-modo-real').addEventListener('click', () => { paso = 2; render(); });
        host.querySelector('#btn-cancelar-modo-real').addEventListener('click', () => cerrarSheet());
        return;
      }

      const coincide = valorConfirmacion.trim().toUpperCase() === 'EMPEZAR';
      host.innerHTML = `
        <div class="aviso-modo-real">
          <p>Para confirmar, escribí <strong>EMPEZAR</strong> abajo. Esta acción no se puede deshacer.</p>
        </div>
        <div class="campo">
          <label for="confirmar-empezar">Escribí "EMPEZAR"</label>
          <input id="confirmar-empezar" type="text" autocomplete="off" value="${escapeHtml(valorConfirmacion)}" autofocus />
        </div>
        ${errorGeneral(error)}
        <div class="acciones-formulario acciones-formulario-columna">
          <button type="button" class="btn btn-peligro btn-ancho" id="btn-confirmar-modo-real" ${coincide ? '' : 'disabled'}>Empezar de cero</button>
          <button type="button" class="btn btn-secundario btn-ancho" id="btn-cancelar-modo-real-2">Cancelar</button>
        </div>`;

      const input = host.querySelector('#confirmar-empezar');
      input.focus();
      const largo = input.value.length;
      input.setSelectionRange(largo, largo);
      input.addEventListener('input', () => render());

      host.querySelector('#btn-cancelar-modo-real-2').addEventListener('click', () => cerrarSheet());
      const btnConfirmar = host.querySelector('#btn-confirmar-modo-real');
      if (coincide) {
        btnConfirmar.addEventListener('click', async () => {
          btnConfirmar.disabled = true;
          try {
            await iniciarModoReal();
            cerrarSheet();
            mostrarToast('Listo, la app es tuya. Registrá tu primer cliente.', 'exito');
            window.location.hash = '#/clientes';
            // Pequeña espera antes de recargar (mismo patrón que importar
            // respaldo) para que el toast de bienvenida alcance a verse.
            setTimeout(() => window.location.reload(), 800);
          } catch (err) {
            error = err.message || 'No se pudo iniciar el modo real.';
            btnConfirmar.disabled = false;
            render();
          }
        });
      }
    }
    render();
  }, { titulo: 'Empezar a trabajar con mis datos reales' });
}

// ============================================================
// §2.10 — Sheet "Configuración" (engrane de la barra de Clientes):
// administra el catálogo de categorías y de conceptos desde un solo lugar.
// Editar/eliminar una categoría o un concepto reutiliza sus propios sheets
// (abrirSheetCategoria / abrirSheetConcepto); como la infraestructura de
// sheet es de-a-uno, guardar/eliminar ahí cierra momentáneamente
// Configuración y la vuelve a abrir al terminar (onGuardado/onEliminada),
// así el gestor no pierde el lugar.
// ============================================================

/**
 * Sheet para crear/editar/eliminar un concepto. No existe `actualizarConcepto`
 * en la capa de datos (solo crear/borrar-lógico) — "renombrar" se resuelve
 * borrando el concepto viejo y creando uno nuevo con el nombre nuevo; la
 * historia no se ve afectada porque `movimientos.servicio` ya guarda el
 * nombre como texto plano en cada cargo pasado (nunca por referencia).
 * @param {{concepto?: object|null, onGuardado?: (c:object)=>void, onEliminada?: (id:string)=>void}} cfg
 */
export function abrirSheetConcepto({ concepto = null, onGuardado, onEliminada } = {}) {
  abrirSheet((host) => {
    let error = {};
    let valorNombre = concepto ? concepto.nombre : '';

    function capturarValoresActuales() {
      const nombreEl = host.querySelector('#cpt-nombre');
      if (nombreEl) valorNombre = nombreEl.value;
    }

    function render() {
      capturarValoresActuales();
      host.innerHTML = `
        <form id="form-concepto" class="formulario" novalidate>
          <div class="campo">
            <label for="cpt-nombre">Nombre</label>
            <input id="cpt-nombre" name="nombre" type="text" value="${escapeHtml(valorNombre)}" required autofocus />
            ${errorCampo(error.nombre)}
          </div>
          ${concepto ? `<p class="texto-secundario">Los cargos ya registrados con este concepto conservan su texto tal cual, aunque lo renombres o lo elimines acá.</p>` : ''}
          ${errorGeneral(error.general)}
          <div class="acciones-formulario acciones-formulario-columna">
            <button type="submit" class="btn btn-primario btn-ancho">${concepto ? 'Guardar cambios' : 'Crear concepto'}</button>
            ${concepto ? `<button type="button" class="btn btn-peligro btn-ancho" id="btn-eliminar-concepto">Eliminar concepto</button>` : ''}
          </div>
        </form>`;

      const form = host.querySelector('#form-concepto');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const nombre = form.nombre.value.trim();
        error = {};
        if (nombre.length < 1) error.nombre = 'El nombre es obligatorio.';
        if (Object.keys(error).length > 0) { render(); return; }
        try {
          let resultado;
          if (concepto && nombre.toLowerCase() !== concepto.nombre.toLowerCase()) {
            // A-203: renombrar al nombre de OTRO concepto ya existente hace un
            // merge (crearConcepto es idempotente por nombre case-insensitive
            // y devolvería el existente) — eso es seguro para los datos, pero
            // NUNCA en silencio: se confirma antes de tocar nada.
            const existentes = await listarConceptos();
            const destino = existentes.find((c) => c.id !== concepto.id && c.nombre.toLowerCase() === nombre.toLowerCase());
            if (destino) {
              const ok = window.confirm(
                `Ya existe "${destino.nombre}". ¿Combinar? "${concepto.nombre}" se quitará del catálogo; los cargos anteriores conservan su texto.`
              );
              if (!ok) { render(); return; }
            }
            await borrarConceptoLogico(concepto.id);
            resultado = await crearConcepto({ nombre });
          } else if (!concepto) {
            resultado = await crearConcepto({ nombre });
          } else {
            resultado = concepto; // sin cambios de nombre
          }
          cerrarSheet();
          mostrarToast(concepto ? 'Concepto actualizado.' : 'Concepto creado.', 'exito');
          if (onGuardado) onGuardado(resultado);
        } catch (err) {
          if (err.code === 'VALIDATION_ERROR' && err.detalle && err.detalle.campo) error[err.detalle.campo] = err.message;
          else if (err.code === 'CONFLICT') error.nombre = err.message;
          else error.general = err.message || 'No se pudo guardar el concepto.';
          render();
        }
      });

      const btnEliminar = host.querySelector('#btn-eliminar-concepto');
      if (btnEliminar) {
        btnEliminar.addEventListener('click', async () => {
          const ok = window.confirm(`¿Eliminar el concepto "${concepto.nombre}"? Los cargos ya registrados con este concepto conservan su texto.`);
          if (!ok) return;
          try {
            await borrarConceptoLogico(concepto.id);
            cerrarSheet();
            mostrarToast('Concepto eliminado.', 'exito');
            if (onEliminada) onEliminada(concepto.id);
          } catch (err) {
            error.general = err.message || 'No se pudo eliminar el concepto.';
            render();
          }
        });
      }
    }
    render();
  }, { titulo: concepto ? 'Editar concepto' : 'Nuevo concepto' });
}

/**
 * Sheet "Configuración" (§2.10): lista de categorías (bolita, nombre, nº de
 * clientes del grupo, ✎ Editar) y de conceptos (nombre, ✎ Editar), con
 * "+ Nueva/Nuevo" en cada sección.
 * @param {{onCambios?: () => void}} cfg - se llama tras cualquier alta/edición/
 *   baja, para que la pantalla que abrió Configuración (Clientes) refresque.
 */
export function abrirSheetConfiguracion({ onCambios } = {}) {
  abrirSheet((host) => {
    let categorias = [];
    let conceptosList = [];
    let conteoPorCategoria = {};
    let cargando = true;

    function avisarCambio() { if (onCambios) onCambios(); }

    async function reabrir() {
      cerrarSheet();
      await avisarCambio();
      abrirSheetConfiguracion({ onCambios });
    }

    async function cargarDatos() {
      const [cats, concs, agrupados] = await Promise.all([
        listarCategorias(), listarConceptos(), listarClientesAgrupados({}),
      ]);
      categorias = cats;
      conceptosList = concs;
      conteoPorCategoria = {};
      agrupados.grupos.forEach((g) => { if (g.categoria_id) conteoPorCategoria[g.categoria_id] = g.clientes.length; });
      cargando = false;
    }

    function render() {
      if (cargando) { host.innerHTML = '<p class="cargando">Cargando…</p>'; return; }
      host.innerHTML = `
        <div class="config-seccion">
          <h3 class="config-seccion-titulo">Categorías</h3>
          ${categorias.length === 0 ? estadoVacio('Todavía no creaste ninguna categoría.') : `
            <ul class="lista lista-config">
              ${categorias.map((c) => `
                <li class="lista-item fila-config">
                  ${bolitaHtml(c.color)}
                  <span class="fila-config-nombre">${escapeHtml(c.nombre)}</span>
                  <span class="fila-config-conteo">${conteoPorCategoria[c.id] || 0} cliente(s)</span>
                  <button type="button" class="btn-icono" data-editar-categoria="${escapeHtml(c.id)}" aria-label="Editar categoría">${Iconos.lapiz()}</button>
                </li>`).join('')}
            </ul>`}
          <button type="button" class="btn btn-secundario btn-ancho" id="btn-config-nueva-categoria">${Iconos.mas()} Nueva categoría</button>
        </div>
        <div class="config-seccion">
          <h3 class="config-seccion-titulo">Conceptos</h3>
          ${conceptosList.length === 0 ? estadoVacio('Todavía no creaste ningún concepto.') : `
            <ul class="lista lista-config">
              ${conceptosList.map((c) => `
                <li class="lista-item fila-config">
                  <span class="fila-config-nombre">${escapeHtml(c.nombre)}</span>
                  <button type="button" class="btn-icono" data-editar-concepto="${escapeHtml(c.id)}" aria-label="Editar concepto">${Iconos.lapiz()}</button>
                </li>`).join('')}
            </ul>`}
          <button type="button" class="btn btn-secundario btn-ancho" id="btn-config-nuevo-concepto">${Iconos.mas()} Nuevo concepto</button>
        </div>
      `;

      host.querySelectorAll('[data-editar-categoria]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const cat = categorias.find((c) => c.id === btn.dataset.editarCategoria);
          abrirSheetCategoria({ categoria: cat, onGuardado: reabrir, onEliminada: reabrir });
        });
      });
      host.querySelectorAll('[data-editar-concepto]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const cpt = conceptosList.find((c) => c.id === btn.dataset.editarConcepto);
          abrirSheetConcepto({ concepto: cpt, onGuardado: reabrir, onEliminada: reabrir });
        });
      });
      host.querySelector('#btn-config-nueva-categoria').addEventListener('click', () => {
        abrirSheetCategoria({ onGuardado: reabrir });
      });
      host.querySelector('#btn-config-nuevo-concepto').addEventListener('click', () => {
        abrirSheetConcepto({ onGuardado: reabrir });
      });
    }

    render();
    cargarDatos().then(render);
  }, { titulo: 'Configuración' });
}
