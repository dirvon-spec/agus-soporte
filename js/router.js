// Router por hash — contrato vigente §2.10 (PLAN-MVP.md, iteración v3
// "Excel"): navegación en 2 pestañas (Clientes, Global). "Resumen" se
// retiró y renace como "Global" (mismos datos de fondo, propósito y UI
// nuevos — ver §2.10 y STORY.md); #/resumen redirige a #/global.
//
// Rutas: #/clientes (inicio y default), #/clientes/:id (pantalla Persona),
// #/clientes/:id/imprimir (estado de cuenta imprimible, sin botón visible en
// la UI pero conservado — es gratis mantenerlo), #/global, #/global/:anioMes.
//
// Error boundary global: el render de cada pantalla va envuelto en
// try/catch; una excepción no capturada muestra un estado de error
// recuperable ("Algo salió mal. [Volver a Clientes]") con el detalle técnico
// en un <details> colapsado — nunca una pantalla en blanco.

import { estaSoloLectura } from './db.js';
import { escapeHtml, cerrarSheet, Iconos } from './ui/componentes.js';
import { renderPantallaClientes, abrirSheetNuevoCliente } from './ui/pantalla-clientes.js';
import { renderPantallaClienteDetalle, renderEstadoCuentaImprimible } from './ui/pantalla-cliente-detalle.js';
import { renderPantallaGlobal } from './ui/pantalla-global.js';

const RUTA_POR_DEFECTO = '#/clientes';

const RUTAS = [
  { patron: /^#\/clientes\/([^/]+)\/imprimir$/, tab: 'clientes',
    render: (m, el) => renderEstadoCuentaImprimible(el, { id: decodeURIComponent(m[1]) }) },
  { patron: /^#\/clientes\/([^/]+)$/, tab: 'clientes',
    render: (m, el) => renderPantallaClienteDetalle(el, { id: decodeURIComponent(m[1]) }) },
  { patron: /^#\/clientes$/, tab: 'clientes',
    render: (m, el) => renderPantallaClientes(el, {}) },
  { patron: /^#\/global\/(\d{4}-\d{2})$/, tab: 'global',
    render: (m, el) => renderPantallaGlobal(el, { anioMes: m[1] }) },
  { patron: /^#\/global$/, tab: 'global',
    render: (m, el) => renderPantallaGlobal(el, {}) },
  // §2.10: "Resumen" renace como "Global" — redirección de compatibilidad
  // (enlaces viejos, historial del navegador, favoritos guardados).
  { patron: /^#\/resumen\/(\d{4}-\d{2})$/, tab: 'global',
    render: (m) => { window.location.replace(`#/global/${m[1]}`); } },
  { patron: /^#\/resumen$/, tab: 'global',
    render: () => { window.location.replace('#/global'); } },
];

let elApp = null;
let elContenido = null;
let generacionActual = 0; // evita que una respuesta async vieja pise una navegación más nueva

function iconoTab(tab) {
  if (tab === 'clientes') return Iconos.personas();
  if (tab === 'global') return Iconos.globo();
  return '';
}

function armarShell() {
  elApp.innerHTML = `
    <div id="aviso-solo-lectura" class="aviso-banner aviso-solo-lectura" hidden role="alert"></div>
    <div id="aviso-persist" class="aviso-banner aviso-discreto" hidden></div>
    <main id="pantalla-contenido" class="pantalla-contenido" aria-live="polite"></main>
    <nav id="nav-inferior" class="nav-inferior" aria-label="Navegación principal">
      <a href="#/clientes" data-tab="clientes" class="nav-item">
        <span class="nav-icono" aria-hidden="true">${iconoTab('clientes')}</span><span class="nav-texto">Clientes</span>
      </a>
      <button type="button" class="nav-item nav-item-central" id="btn-nav-nuevo-cliente" ${estaSoloLectura() ? 'disabled title="Modo solo lectura"' : ''}>
        <span class="nav-icono-central" aria-hidden="true">${Iconos.mas()}</span><span class="nav-texto">Nuevo cliente</span>
      </button>
      <a href="#/global" data-tab="global" class="nav-item">
        <span class="nav-icono" aria-hidden="true">${iconoTab('global')}</span><span class="nav-texto">Global</span>
      </a>
    </nav>
  `;
  elContenido = document.getElementById('pantalla-contenido');

  const btnNuevoCliente = document.getElementById('btn-nav-nuevo-cliente');
  if (btnNuevoCliente) {
    // §2.11: botón central de la barra inferior — abre la sheet de alta desde
    // CUALQUIER pantalla (es un overlay, no depende de la ruta actual). Si el
    // alta se confirma, refresca la lista si ya estamos en Clientes, o
    // navega ahí para que el gestor vea al cliente recién creado.
    btnNuevoCliente.addEventListener('click', () => {
      abrirSheetNuevoCliente({
        onCreado: () => {
          if (window.location.hash === RUTA_POR_DEFECTO) manejarCambioDeRuta();
          else window.location.hash = RUTA_POR_DEFECTO;
        },
      });
    });
  }

  if (estaSoloLectura()) {
    const aviso = document.getElementById('aviso-solo-lectura');
    aviso.hidden = false;
    aviso.textContent = 'La app ya está abierta en otra pestaña; cerrala para editar aquí. Esta pestaña quedó en modo solo lectura.';
  }

  actualizarAvisoPersistencia();
}

async function actualizarAvisoPersistencia() {
  const aviso = document.getElementById('aviso-persist');
  if (!aviso) return;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persisted) {
      const persistido = await navigator.storage.persisted();
      if (!persistido) {
        aviso.hidden = false;
        aviso.innerHTML =
          'El navegador podría liberar espacio si el dispositivo anda justo de memoria; ' +
          'te recomendamos exportar un respaldo seguido. ' +
          '<a href="#/global">Ir a Global y respaldos</a>' +
          ' <button type="button" class="btn-cerrar-aviso" aria-label="Cerrar aviso">×</button>';
        aviso.querySelector('.btn-cerrar-aviso').addEventListener('click', () => {
          aviso.hidden = true;
        });
      }
    }
  } catch (e) {
    // No bloqueante: si la API no está disponible, simplemente no se muestra el aviso.
    console.warn('[router] No se pudo consultar navigator.storage.persisted():', e);
  }
}

function actualizarNavActiva(tabActivo) {
  document.querySelectorAll('#nav-inferior .nav-item').forEach((a) => {
    const activo = a.dataset.tab === tabActivo;
    a.classList.toggle('nav-item-activo', activo);
    if (activo) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function renderErrorBoundary(error) {
  const detalle = (error && (error.stack || error.message)) || String(error);
  const code = (error && error.code) ? ` [${error.code}]` : '';
  return `
    <div class="error-boundary">
      <p class="error-boundary-titulo">Algo salió mal${escapeHtml(code)}.</p>
      <button type="button" class="btn btn-primario" data-accion="volver-a-clientes">Volver a Clientes</button>
      <details class="error-boundary-detalle">
        <summary>Detalle técnico</summary>
        <pre>${escapeHtml(detalle)}</pre>
      </details>
    </div>
  `;
}

async function manejarCambioDeRuta() {
  if (!window.location.hash) {
    window.location.replace(RUTA_POR_DEFECTO);
    return; // el reemplazo dispara un nuevo evento hashchange
  }

  cerrarSheet(); // navegar (incl. "atrás" del navegador) cierra cualquier sheet abierto

  const hash = window.location.hash;
  const miGeneracion = ++generacionActual;

  const coincidencia = RUTAS.reduce((acc, r) => {
    if (acc) return acc;
    const m = hash.match(r.patron);
    return m ? { ruta: r, match: m } : null;
  }, null);

  actualizarNavActiva(coincidencia ? coincidencia.ruta.tab : null);

  try {
    if (!coincidencia) {
      elContenido.innerHTML = `
        <div class="error-boundary">
          <p class="error-boundary-titulo">No se encontró esa pantalla.</p>
          <button type="button" class="btn btn-primario" data-accion="volver-a-clientes">Volver a Clientes</button>
        </div>`;
    } else {
      elContenido.innerHTML = '<p class="cargando">Cargando…</p>';
      await coincidencia.ruta.render(coincidencia.match, elContenido);
    }
  } catch (error) {
    console.error('[router] Error al renderizar la pantalla:', error);
    if (miGeneracion !== generacionActual) return; // navegación más nueva ya tomó el control
    elContenido.innerHTML = renderErrorBoundary(error);
  }

  if (miGeneracion !== generacionActual) return;
  const btnVolver = elContenido.querySelector('[data-accion="volver-a-clientes"]');
  if (btnVolver) {
    btnVolver.addEventListener('click', () => {
      // Si el error ocurrió en la propia pantalla Clientes, el hash ya es
      // "#/clientes" y asignarlo de nuevo NO dispara "hashchange"
      // (comportamiento estándar del navegador) — se fuerza el re-render.
      if (window.location.hash === RUTA_POR_DEFECTO) {
        manejarCambioDeRuta();
      } else {
        window.location.hash = RUTA_POR_DEFECTO;
      }
    });
  }

  window.scrollTo(0, 0);
}

/**
 * Inicializa el router: arma el shell fijo, registra el listener de
 * hashchange y renderiza la ruta actual (o #/clientes por defecto).
 * @param {HTMLElement} contenedorApp
 */
export function iniciarRouter(contenedorApp) {
  elApp = contenedorApp;
  armarShell();
  window.addEventListener('hashchange', () => { manejarCambioDeRuta(); });
  manejarCambioDeRuta();
}
