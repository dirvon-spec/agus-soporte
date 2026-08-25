// Router por hash (contrato 2.4 del PLAN-MVP.md): #/hoy, #/clientes,
// #/clientes/:id, #/nuevo-movimiento, #/resumen. Además arma el "shell" fijo
// de la app: barra inferior (Hoy/Clientes/Resumen), botón flotante "+"
// (visible en Hoy y Clientes), aviso de instancia única (modo solo-lectura)
// y aviso discreto de almacenamiento persistente denegado.
//
// Error boundary global (mitigación F2): el render de cada pantalla va
// envuelto en try/catch; una excepción no capturada muestra un estado de
// error recuperable ("Algo salió mal. [Volver a Hoy]") con el detalle
// técnico en un <details> colapsado — nunca una pantalla en blanco.

import { estaSoloLectura } from './db.js';
import { escapeHtml } from './ui/componentes.js';
import { renderPantallaHoy } from './ui/pantalla-hoy.js';
import { renderPantallaClientes } from './ui/pantalla-clientes.js';
import { renderPantallaClienteDetalle, renderEstadoCuentaImprimible } from './ui/pantalla-cliente-detalle.js';
import { renderPantallaMovimientoForm } from './ui/pantalla-movimiento-form.js';
import { renderPantallaResumen } from './ui/pantalla-resumen.js';

const RUTAS = [
  { patron: /^#\/hoy\/(\d{4}-\d{2}-\d{2})$/, tab: 'hoy', fab: true,
    render: (m, el) => renderPantallaHoy(el, { fecha: m[1] }) },
  { patron: /^#\/hoy$/, tab: 'hoy', fab: true,
    render: (m, el) => renderPantallaHoy(el, {}) },
  { patron: /^#\/clientes\/([^/]+)\/imprimir$/, tab: 'clientes', fab: false,
    render: (m, el) => renderEstadoCuentaImprimible(el, { id: decodeURIComponent(m[1]) }) },
  { patron: /^#\/clientes\/([^/]+)$/, tab: 'clientes', fab: false,
    render: (m, el) => renderPantallaClienteDetalle(el, { id: decodeURIComponent(m[1]) }) },
  { patron: /^#\/clientes$/, tab: 'clientes', fab: true,
    render: (m, el) => renderPantallaClientes(el, {}) },
  { patron: /^#\/nuevo-movimiento\/([^/]+)$/, tab: null, fab: false,
    render: (m, el) => renderPantallaMovimientoForm(el, { clienteId: decodeURIComponent(m[1]) }) },
  { patron: /^#\/nuevo-movimiento$/, tab: null, fab: false,
    render: (m, el) => renderPantallaMovimientoForm(el, {}) },
  { patron: /^#\/resumen\/(\d{4}-\d{2})$/, tab: 'resumen', fab: false,
    render: (m, el) => renderPantallaResumen(el, { anioMes: m[1] }) },
  { patron: /^#\/resumen$/, tab: 'resumen', fab: false,
    render: (m, el) => renderPantallaResumen(el, {}) },
];

const RUTA_POR_DEFECTO = '#/hoy';

let elApp = null;
let elContenido = null;
let generacionActual = 0; // evita que una respuesta async vieja pise una navegación más nueva

function iconoTab(tab) {
  if (tab === 'hoy') return '📅';
  if (tab === 'clientes') return '👥';
  if (tab === 'resumen') return '📊';
  return '•';
}

function armarShell() {
  elApp.innerHTML = `
    <div id="aviso-solo-lectura" class="aviso-banner aviso-solo-lectura" hidden role="alert"></div>
    <div id="aviso-persist" class="aviso-banner aviso-discreto" hidden></div>
    <main id="pantalla-contenido" class="pantalla-contenido" aria-live="polite"></main>
    <button type="button" id="fab-nuevo-movimiento" class="fab" hidden aria-label="Registrar movimiento">+</button>
    <nav id="nav-inferior" class="nav-inferior" aria-label="Navegación principal">
      <a href="#/hoy" data-tab="hoy" class="nav-item">
        <span class="nav-icono" aria-hidden="true">${iconoTab('hoy')}</span><span class="nav-texto">Hoy</span>
      </a>
      <a href="#/clientes" data-tab="clientes" class="nav-item">
        <span class="nav-icono" aria-hidden="true">${iconoTab('clientes')}</span><span class="nav-texto">Clientes</span>
      </a>
      <a href="#/resumen" data-tab="resumen" class="nav-item">
        <span class="nav-icono" aria-hidden="true">${iconoTab('resumen')}</span><span class="nav-texto">Resumen</span>
      </a>
    </nav>
  `;
  elContenido = document.getElementById('pantalla-contenido');

  document.getElementById('fab-nuevo-movimiento').addEventListener('click', () => {
    window.location.hash = '#/nuevo-movimiento';
  });

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
          '<a href="#/resumen">Ir a Resumen y respaldos</a>' +
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

function actualizarFab(mostrar) {
  const fab = document.getElementById('fab-nuevo-movimiento');
  if (fab) fab.hidden = !mostrar;
}

function renderErrorBoundary(error) {
  const detalle = (error && (error.stack || error.message)) || String(error);
  const code = (error && error.code) ? ` [${error.code}]` : '';
  return `
    <div class="error-boundary">
      <p class="error-boundary-titulo">Algo salió mal${escapeHtml(code)}.</p>
      <button type="button" class="btn btn-primario" data-accion="volver-a-hoy">Volver a Hoy</button>
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

  const hash = window.location.hash;
  const miGeneracion = ++generacionActual;

  const coincidencia = RUTAS.reduce((acc, r) => {
    if (acc) return acc;
    const m = hash.match(r.patron);
    return m ? { ruta: r, match: m } : null;
  }, null);

  actualizarNavActiva(coincidencia ? coincidencia.ruta.tab : null);
  actualizarFab(coincidencia ? coincidencia.ruta.fab : false);

  try {
    if (!coincidencia) {
      elContenido.innerHTML = `
        <div class="error-boundary">
          <p class="error-boundary-titulo">No se encontró esa pantalla.</p>
          <button type="button" class="btn btn-primario" data-accion="volver-a-hoy">Volver a Hoy</button>
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
  const btnVolver = elContenido.querySelector('[data-accion="volver-a-hoy"]');
  if (btnVolver) {
    btnVolver.addEventListener('click', () => {
      // Si el error ocurrió en la propia pantalla Hoy, el hash ya es "#/hoy" y
      // asignarlo de nuevo NO dispara "hashchange" (comportamiento estándar del
      // navegador) — el router quedaría trabado en la pantalla de error. Se
      // fuerza el re-render directamente en ese caso.
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
 * hashchange y renderiza la ruta actual (o #/hoy por defecto).
 * @param {HTMLElement} contenedorApp
 */
export function iniciarRouter(contenedorApp) {
  elApp = contenedorApp;
  armarShell();
  window.addEventListener('hashchange', () => { manejarCambioDeRuta(); });
  manejarCambioDeRuta();
}
