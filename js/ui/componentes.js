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
// Badge de estado (calendario): color + texto + ícono, nunca solo color
// ============================================================

export const INFO_ESTADO = {
  PAGADO: { texto: 'Pagado', icono: '✓', clase: 'estado-pagado' },
  GRACIA_ADELANTO: { texto: 'Gracia/Adelanto', icono: '↑', clase: 'estado-gracia-adelanto' },
  PARCIAL: { texto: 'Parcial', icono: '½', clase: 'estado-parcial' },
  DEUDA: { texto: 'Deuda', icono: '!', clase: 'estado-deuda' },
  SIN_OBLIGACION: { texto: 'Sin obligación', icono: '—', clase: 'estado-sin-obligacion' },
};

export function badgeEstado(estado) {
  const info = INFO_ESTADO[estado] || { texto: estado || '—', icono: '?', clase: '' };
  return `<span class="badge-estado ${info.clase}"><span aria-hidden="true">${info.icono}</span> ${escapeHtml(info.texto)}</span>`;
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
    <button type="button" class="btn btn-secundario" data-accion="pagina-anterior" ${pagina <= 1 ? 'disabled' : ''}>&larr; Anterior</button>
    <span class="paginador-info">Página ${pagina} de ${totalPaginas}</span>
    <button type="button" class="btn btn-secundario" data-accion="pagina-siguiente" ${pagina >= totalPaginas ? 'disabled' : ''}>Siguiente &rarr;</button>
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
