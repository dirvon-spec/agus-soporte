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
  crearCategoria, actualizarCategoria, borrarCategoriaLogica,
  listarConceptos, crearConcepto, registrarCargo, registrarAbono,
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
 * @param {{tipo:'ABONO'|'CARGO', clienteId:string, clienteNombre:string, onGuardado?: ()=>void}} cfg
 */
export function abrirPanelRapido({ tipo, clienteId, clienteNombre, onGuardado }) {
  abrirSheet((host) => {
    renderPanelRapidoInterno(host, tipo, clienteId, onGuardado);
  }, { titulo: `${tipo === 'ABONO' ? 'Abono' : 'Cargo'} — ${clienteNombre}` });
}

async function renderPanelRapidoInterno(host, tipo, clienteId, onGuardado) {
  let conceptos = tipo === 'CARGO' ? await listarConceptos() : [];
  let conceptoElegido = null;
  let mostrarNuevoConcepto = false;
  let error = {};
  // Lo que el usuario ya tipeó sobrevive a los re-render que disparan elegir
  // un concepto o crear uno al vuelo (si no se capturara acá, cada render()
  // reconstruye el <form> desde cero y el monto/fecha/referencia ya tipeados
  // se perderían silenciosamente).
  let valorMonto = '';
  let valorFecha = hoy();
  let valorReferencia = '';

  function capturarValoresActuales() {
    const montoEl = host.querySelector('#pr-monto');
    if (montoEl) valorMonto = montoEl.value;
    const fechaEl = host.querySelector('#pr-fecha');
    if (fechaEl) valorFecha = fechaEl.value;
    const refEl = host.querySelector('#pr-referencia');
    if (refEl) valorReferencia = refEl.value;
  }

  function render() {
    capturarValoresActuales();
    host.innerHTML = `
      <form id="form-panel-rapido" class="formulario" novalidate>
        <div class="campo campo-monto-grande">
          <input id="pr-monto" name="monto" type="text" inputmode="decimal" placeholder="$0.00" class="input-monto-grande" autocomplete="off" value="${escapeHtml(valorMonto)}" />
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
                <input id="pr-nuevo-concepto-nombre" type="text" placeholder="Nombre del concepto" />
                <button type="button" class="btn btn-primario btn-pequeno" id="pr-confirmar-nuevo-concepto">Agregar</button>
              </div>` : ''}
            ${errorCampo(error.concepto)}
          </div>
          <div class="campo">
            <label for="pr-referencia">Referencia (opcional)</label>
            <input id="pr-referencia" name="referencia" type="text" value="${escapeHtml(valorReferencia)}" />
          </div>` : ''}
        <div class="campo">
          <label for="pr-fecha">Fecha</label>
          <input id="pr-fecha" name="fecha" type="date" max="${hoy()}" value="${escapeHtml(valorFecha)}" />
          ${errorCampo(error.fecha)}
        </div>
        ${errorGeneral(error.general)}
        <div class="acciones-formulario">
          <button type="submit" class="btn btn-primario btn-ancho">Guardar</button>
        </div>
      </form>`;

    const montoInput = host.querySelector('#pr-monto');
    montoInput.focus();

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

      const montoTexto = montoInput.value.trim();
      let montoCentavos = null;
      if (!montoTexto) {
        error.monto_centavos = 'El monto es obligatorio.';
      } else {
        try {
          montoCentavos = parsearAPesos(montoTexto);
          if (montoCentavos <= 0) error.monto_centavos = 'El monto debe ser mayor a $0.00.';
        } catch (err) {
          error.monto_centavos = err.message;
        }
      }

      const fechaTexto = host.querySelector('#pr-fecha').value;
      if (!fechaTexto) error.fecha = 'La fecha es obligatoria.';
      else if (!esFechaIsoValida(fechaTexto)) error.fecha = 'La fecha no es válida.';
      else if (esFutura(fechaTexto)) error.fecha = 'La fecha no puede ser futura.';

      if (tipo === 'CARGO' && !conceptoElegido) error.concepto = 'Elegí (o creá) un concepto.';

      if (Object.keys(error).length > 0) { render(); return; }

      try {
        if (tipo === 'ABONO') {
          await registrarAbono({ cliente_id: clienteId, monto_centavos: montoCentavos, fecha: fechaTexto });
        } else {
          const referencia = (host.querySelector('#pr-referencia').value || '').trim();
          await registrarCargo({
            cliente_id: clienteId, monto_centavos: montoCentavos, fecha: fechaTexto,
            concepto: conceptoElegido, referencia: referencia || undefined,
          });
        }
        cerrarSheet();
        mostrarToast(tipo === 'ABONO' ? 'Abono registrado.' : 'Cargo registrado.', 'exito');
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
