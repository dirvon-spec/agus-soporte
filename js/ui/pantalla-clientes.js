// Pantalla "Clientes" (inicio) — contrato vigente §2.11 (PLAN-MVP.md, ROUND
// 4): Clientes es el trabajo del DÍA — navegador de fecha arriba, columnas
// ABONOS/CARGOS del día visto, semáforo de 3 estados por cliente-día, franja
// resumen del día. SALDO sigue siendo histórico total. Filas de una sola
// línea (monto-es-botón), chips de filtro por categoría, buscador, orden
// manual por arrastre, fila Σ por grupo, engrane de Configuración, columna
// CARGOS colapsable, y sección colapsable de clientes archivados.

import {
  listarClientesAgrupados, listarClientesArchivados, restaurarCliente,
  listarCategorias, crearCliente, crearCategoria, actualizarOrdenClientes, estaSoloLectura,
} from '../db.js';
import { formatearCompacto, formatearCentavos } from '../utils/money.js';
import { hoy, sumarDias, esFutura, esFechaIsoValida } from '../utils/date.js';
import {
  microcopy, estadoVacio, montoOGuion, claseSaldo, escapeHtml, debounce,
  mostrarToast, errorCampo, errorGeneral, Iconos, bolitaHtml,
  abrirSheet, cerrarSheet, abrirSheetCategoria, abrirSheetConfiguracion, abrirPanelRapido,
  activarLongPress, activarArrastreOrden, PALETA_COLORES_CATEGORIA,
  bannerModoDemoHtml, wireBannerModoDemo,
} from './componentes.js';

const MICROCOPY = `
  <p>Acá ves el trabajo de HOY (o del día que elijas con ▾): quién abonó, quién
  te dijo que hoy no, y a quién todavía no visitaste. Los cobros son como tú
  los acuerdes con cada quien — no hay cuotas fijas.</p>
  <p><strong>El monto ES el botón:</strong> tocá el verde para registrar un
  abono, el rojo para un cargo (ambos quedan en el día que estás viendo), o el
  nombre para ver el calendario completo de ese cliente. Los chips de arriba
  (deslizables si no entran todos) filtran por categoría; mantené presionado
  uno para editarla o eliminarla. Mantené presionado el agarre ⋮⋮ para
  reordenar dentro de un grupo. Tocá el encabezado "Cargos" para ocultar esa
  columna si no la necesitás.</p>
`;

// §2.10 A-201: a partir de $100,000 el monto se muestra en notación
// compacta ("$150 k", "$1.2 M") SOLO en esta vista de lista — el monto
// completo sigue disponible siempre en Persona y en el panel rápido.
const UMBRAL_COMPACTO_CENTAVOS = 100000 * 100; // $100,000

function montoListaOGuion(centavos) {
  if (centavos === null || centavos === undefined) return '—';
  return Math.abs(centavos) >= UMBRAL_COMPACTO_CENTAVOS ? formatearCompacto(centavos) : montoOGuion(centavos);
}

/** Envuelve el texto del monto en un <span> de bloque — necesario para que la
 * elipsis por overflow funcione bien dentro de un contenedor flex alineado a
 * la derecha (ver comentario de .fila-excel-monto-texto en styles.css). */
function montoSpan(texto) {
  return `<span class="fila-excel-monto-texto">${texto}</span>`;
}

/** Sentinel de estado local: "Todos" no es una categoría real. */
const FILTRO_TODOS = Symbol('todos');
const FILTRO_SIN_CATEGORIA = null;

const CLAVE_PREF_CARGOS_OCULTOS = 'agus-cargos-ocultos';

function leerPreferenciaCargosOcultos() {
  try {
    return localStorage.getItem(CLAVE_PREF_CARGOS_OCULTOS) === '1';
  } catch (e) {
    return false;
  }
}

function guardarPreferenciaCargosOcultos(valor) {
  try {
    localStorage.setItem(CLAVE_PREF_CARGOS_OCULTOS, valor ? '1' : '0');
  } catch (e) {
    // localStorage puede fallar (modo privado, cuota llena) — es solo una
    // preferencia de dispositivo, no rompe la pantalla si no se guarda.
  }
}

/** "sáb 30 ago" (sin punto final, sin mayúscula inicial forzada). */
function formatearFechaNav(fechaIso) {
  const [anio, mes, dia] = fechaIso.split('-').map(Number);
  const d = new Date(anio, mes - 1, dia, 12, 0, 0);
  return new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short' })
    .format(d)
    .replace(/\./g, '')
    .replace(/,/g, '')
    .replace(/\s+de\s+/g, ' ');
}

function tituloNav(fechaVista) {
  const fechaFormateada = formatearFechaNav(fechaVista);
  return fechaVista === hoy() ? `Hoy · ${fechaFormateada}` : fechaFormateada;
}

/** Celda de la columna ABONOS en modo-día: semáforo de 3 estados (§2.11). */
function celdaAbonoDiaHtml(c) {
  if (c.estado_dia === 'ABONO') {
    return `<button type="button" class="fila-excel-monto monto-positivo" data-accion="abono" title="${escapeHtml(montoOGuion(c.abonos_mes_centavos))}">${montoSpan(montoListaOGuion(c.abonos_mes_centavos))}</button>`;
  }
  if (c.estado_dia === 'CERO') {
    return `<button type="button" class="fila-excel-monto monto-neutro" data-accion="abono" title="Dijo que hoy no abona">${montoSpan('$0')}</button>`;
  }
  return `<button type="button" class="fila-excel-monto monto-neutro" data-accion="abono" title="Todavía sin visitar">${montoSpan('—')}</button>`;
}

function filaClienteHtml(c, categoriaColor) {
  const sinMovimientos = !c.tiene_movimientos;
  const saldoParaMostrar = sinMovimientos ? null : c.saldo_centavos;
  return `
    <li class="lista-item fila-cliente fila-excel" data-cliente-id="${escapeHtml(c.id)}">
      <span class="asa-arrastre" aria-hidden="true" title="Mantené presionado para reordenar">${Iconos.arrastre()}</span>
      ${bolitaHtml(categoriaColor)}
      <button type="button" class="fila-excel-nombre" data-accion="ver-persona" title="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</button>
      ${celdaAbonoDiaHtml(c)}
      <button type="button" class="fila-excel-monto monto-negativo col-cargo" data-accion="cargo" title="${escapeHtml(montoOGuion(c.cargos_mes_centavos))}">${montoSpan(montoListaOGuion(c.cargos_mes_centavos))}</button>
      <span class="fila-excel-monto ${claseSaldo(saldoParaMostrar)}" title="${escapeHtml(montoOGuion(saldoParaMostrar))}">${montoSpan(montoListaOGuion(saldoParaMostrar))}</span>
    </li>`;
}

function filaSumaHtml(grupo) {
  const colorEstilo = grupo.categoria_color ? `color:${escapeHtml(grupo.categoria_color)}` : '';
  return `
    <li class="lista-item fila-suma-grupo fila-excel" style="${colorEstilo}">
      <span class="asa-arrastre-vacia" aria-hidden="true"></span>
      <span class="fila-suma-etiqueta">Σ ${escapeHtml(grupo.categoria_nombre)}</span>
      <span class="fila-excel-monto monto-positivo" title="${escapeHtml(montoOGuion(grupo.totales.abonos_mes_centavos))}">${montoSpan(montoListaOGuion(grupo.totales.abonos_mes_centavos))}</span>
      <span class="fila-excel-monto monto-negativo col-cargo" title="${escapeHtml(montoOGuion(grupo.totales.cargos_mes_centavos))}">${montoSpan(montoListaOGuion(grupo.totales.cargos_mes_centavos))}</span>
      <span class="fila-excel-monto ${claseSaldo(grupo.totales.saldo_centavos)}" title="${escapeHtml(montoOGuion(grupo.totales.saldo_centavos))}">${montoSpan(montoListaOGuion(grupo.totales.saldo_centavos))}</span>
    </li>`;
}

function filaArchivadoHtml(c) {
  return `
    <li class="lista-item fila-archivado" data-cliente-archivado-id="${escapeHtml(c.id)}">
      ${bolitaHtml(c.categoria ? c.categoria.color : null)}
      <span class="fila-archivado-nombre">${escapeHtml(c.nombre)}</span>
      <span class="fila-excel-monto ${claseSaldo(c.saldo_centavos)}" title="${escapeHtml(montoOGuion(c.saldo_centavos))}">${montoSpan(montoListaOGuion(c.saldo_centavos))}</span>
      <button type="button" class="btn btn-secundario btn-pequeno" data-accion="restaurar">${Iconos.restaurar()} Restaurar</button>
    </li>`;
}

function chipCategoriaHtml(id, nombre, color, activo) {
  return `<button type="button" class="chip chip-categoria ${activo ? 'chip-activo' : ''}" data-categoria-id="${id === FILTRO_SIN_CATEGORIA ? '' : escapeHtml(id)}">
    ${bolitaHtml(color, 'bolita-chip')}${escapeHtml(nombre)}
  </button>`;
}

/**
 * Sheet de alta de cliente — independiente (fetch propio de categorías) para
 * poder abrirse tanto desde esta pantalla como desde el botón central de la
 * barra inferior (§2.11), sin depender del estado de `renderPantallaClientes`.
 * @param {{onCreado?: () => void}} [cfg]
 */
export function abrirSheetNuevoCliente({ onCreado } = {}) {
  abrirSheet((host) => {
    let categorias = [];
    let categoriaSeleccionada = null;
    let mostrarNuevaCategoria = false;
    let colorNuevaCategoria = PALETA_COLORES_CATEGORIA[0];
    let error = {};
    let cargando = true;
    // Lo ya tipeado sobrevive a los re-render que disparan elegir/crear una
    // categoría (si no se capturara acá, cada render() reconstruye el <form>
    // desde cero y nombre/teléfono/notas ya tipeados se perderían — A-102).
    let valorNombre = '';
    let valorTelefono = '';
    let valorNotas = '';
    let valorNuevaCategoriaNombre = '';

    function capturarValoresActuales() {
      const nombreEl = host.querySelector('#nc-nombre');
      if (nombreEl) valorNombre = nombreEl.value;
      const telefonoEl = host.querySelector('#nc-telefono');
      if (telefonoEl) valorTelefono = telefonoEl.value;
      const notasEl = host.querySelector('#nc-notas');
      if (notasEl) valorNotas = notasEl.value;
      const nuevaCatEl = host.querySelector('#nc-nueva-categoria-nombre');
      if (nuevaCatEl) valorNuevaCategoriaNombre = nuevaCatEl.value;
    }

    async function refrescarCategorias() {
      categorias = await listarCategorias();
    }

    function render() {
      if (cargando) { host.innerHTML = '<p class="cargando">Cargando…</p>'; return; }
      capturarValoresActuales();
      host.innerHTML = `
        <form id="form-nuevo-cliente" class="formulario" novalidate>
          <div class="campo">
            <label for="nc-nombre">Nombre</label>
            <input id="nc-nombre" name="nombre" type="text" value="${escapeHtml(valorNombre)}" required autofocus />
            ${errorCampo(error.nombre)}
          </div>
          <div class="campo">
            <label for="nc-telefono">Teléfono (opcional)</label>
            <input id="nc-telefono" name="telefono" type="text" value="${escapeHtml(valorTelefono)}" placeholder="Ej. 5215512340000" />
            ${errorCampo(error.telefono)}
          </div>
          <div class="campo">
            <label>Categoría (opcional)</label>
            <div class="chips-fila">
              <button type="button" class="chip ${categoriaSeleccionada === null ? 'chip-activo' : ''}" data-cat="">Sin categoría</button>
              ${categorias.map((c) => `<button type="button" class="chip ${categoriaSeleccionada === c.id ? 'chip-activo' : ''}" data-cat="${escapeHtml(c.id)}">${bolitaHtml(c.color, 'bolita-chip')}${escapeHtml(c.nombre)}</button>`).join('')}
              <button type="button" class="chip chip-nuevo" id="nc-btn-nueva-categoria">${Iconos.mas()} Nueva</button>
            </div>
            ${mostrarNuevaCategoria ? `
              <div class="fila-nuevo-inline fila-nueva-categoria-inline">
                <input id="nc-nueva-categoria-nombre" type="text" value="${escapeHtml(valorNuevaCategoriaNombre)}" placeholder="Nombre de la categoría" />
                <div class="paleta-colores paleta-colores-chica">
                  ${PALETA_COLORES_CATEGORIA.map((col) => `<button type="button" class="bolita-color ${col === colorNuevaCategoria ? 'bolita-color-activa' : ''}" data-color="${col}" style="background:${col}">${col === colorNuevaCategoria ? Iconos.check() : ''}</button>`).join('')}
                </div>
                <button type="button" class="btn btn-primario btn-pequeno" id="nc-confirmar-nueva-categoria">Agregar categoría</button>
              </div>` : ''}
          </div>
          <div class="campo">
            <label for="nc-notas">Notas (opcional)</label>
            <textarea id="nc-notas" name="notas" rows="2">${escapeHtml(valorNotas)}</textarea>
          </div>
          ${errorGeneral(error.general)}
          <div class="acciones-formulario">
            <button type="submit" class="btn btn-primario btn-ancho">Crear cliente</button>
          </div>
        </form>`;

      host.querySelectorAll('.chip[data-cat]').forEach((chip) => {
        chip.addEventListener('click', () => {
          categoriaSeleccionada = chip.dataset.cat || null;
          mostrarNuevaCategoria = false;
          render();
        });
      });
      host.querySelector('#nc-btn-nueva-categoria').addEventListener('click', () => {
        mostrarNuevaCategoria = !mostrarNuevaCategoria;
        render();
        const campo = host.querySelector('#nc-nueva-categoria-nombre');
        if (campo) campo.focus();
      });
      if (mostrarNuevaCategoria) {
        host.querySelectorAll('.paleta-colores-chica .bolita-color').forEach((b) => {
          b.addEventListener('click', () => { colorNuevaCategoria = b.dataset.color; render(); });
        });
        host.querySelector('#nc-confirmar-nueva-categoria').addEventListener('click', async () => {
          const nombre = host.querySelector('#nc-nueva-categoria-nombre').value.trim();
          if (nombre.length < 1) { host.querySelector('#nc-nueva-categoria-nombre').focus(); return; }
          try {
            const cat = await crearCategoria({ nombre, color: colorNuevaCategoria });
            await refrescarCategorias();
            categoriaSeleccionada = cat.id;
            mostrarNuevaCategoria = false;
            render();
          } catch (err) {
            error.general = err.message || 'No se pudo crear la categoría.';
            render();
          }
        });
      }

      host.querySelector('#form-nuevo-cliente').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        const nombreLimpio = form.nombre.value.trim();
        const telefonoLimpio = form.telefono.value.trim();
        error = {};
        if (nombreLimpio.length < 2) error.nombre = 'El nombre debe tener al menos 2 caracteres.';
        if (telefonoLimpio && !/^[\d\s+\-]{7,20}$/.test(telefonoLimpio)) {
          error.telefono = 'Ingresá solo dígitos, espacios, "+" y "-", entre 7 y 20 caracteres.';
        }
        if (Object.keys(error).length > 0) { render(); return; }
        try {
          await crearCliente({
            nombre: nombreLimpio,
            telefono: telefonoLimpio || undefined,
            categoria_id: categoriaSeleccionada || undefined,
            notas: form.notas.value.trim() || undefined,
          });
          cerrarSheet();
          mostrarToast('Cliente creado.', 'exito');
          if (onCreado) onCreado();
        } catch (err) {
          if (err.code === 'VALIDATION_ERROR' && err.detalle && err.detalle.campo) error[err.detalle.campo] = err.message;
          else if (err.code === 'CONFLICT') error.nombre = err.message;
          else error.general = err.message || 'No se pudo crear el cliente.';
          render();
        }
      });
    }

    render();
    refrescarCategorias().then(() => { cargando = false; render(); });
  }, { titulo: 'Nuevo cliente' });
}

/**
 * @param {HTMLElement} contenedor
 */
export async function renderPantallaClientes(contenedor) {
  let busqueda = '';
  let categoriaFiltro = FILTRO_TODOS; // FILTRO_TODOS | FILTRO_SIN_CATEGORIA (null) | id de categoría
  let categorias = [];
  let fechaVista = hoy();
  let cargosOcultos = leerPreferenciaCargosOcultos();

  async function refrescarCategorias() {
    categorias = await listarCategorias();
  }

  function renderChipsCategoria() {
    const wrap = contenedor.querySelector('#wrap-chips-categoria');
    const chips = [
      `<button type="button" class="chip ${categoriaFiltro === FILTRO_TODOS ? 'chip-activo' : ''}" data-categoria-id="__todos__">Todos</button>`,
      ...categorias.map((cat) => chipCategoriaHtml(cat.id, cat.nombre, cat.color, categoriaFiltro === cat.id)),
      chipCategoriaHtml(FILTRO_SIN_CATEGORIA, 'Sin categoría', null, categoriaFiltro === FILTRO_SIN_CATEGORIA),
      `<button type="button" class="chip chip-nuevo" id="btn-nueva-categoria">${Iconos.mas()} Nueva</button>`,
    ].join('');
    wrap.innerHTML = chips;

    wrap.querySelectorAll('.chip-categoria').forEach((chip) => {
      const idCategoria = chip.dataset.categoriaId || FILTRO_SIN_CATEGORIA;
      const categoriaReal = categorias.find((c) => c.id === idCategoria);
      activarLongPress(
        chip,
        () => { if (categoriaReal) abrirSheetCategoria({ categoria: categoriaReal, onGuardado: refrescarTodo, onEliminada: refrescarTodo }); },
        () => { categoriaFiltro = idCategoria; renderChipsCategoria(); refrescarLista(); }
      );
    });
    wrap.querySelector('[data-categoria-id="__todos__"]').addEventListener('click', () => {
      categoriaFiltro = FILTRO_TODOS;
      renderChipsCategoria();
      refrescarLista();
    });
    wrap.querySelector('#btn-nueva-categoria').addEventListener('click', () => {
      abrirSheetCategoria({ onGuardado: refrescarTodo });
    });
  }

  function renderNav() {
    const elTitulo = contenedor.querySelector('#nav-fecha-titulo');
    const elSiguiente = contenedor.querySelector('#btn-dia-siguiente');
    if (elTitulo) elTitulo.textContent = tituloNav(fechaVista);
    if (elSiguiente) elSiguiente.disabled = fechaVista === hoy();
    const inputFecha = contenedor.querySelector('#input-fecha-vista');
    if (inputFecha) inputFecha.value = fechaVista;
  }

  function renderFranja(resumenDia) {
    const el = contenedor.querySelector('#franja-resumen-dia');
    if (!el || !resumenDia) return;
    const etiquetaDia = fechaVista === hoy() ? 'hoy' : formatearFechaNav(fechaVista);
    el.innerHTML = `
      <span class="franja-dato-cobrado">Cobrado ${escapeHtml(etiquetaDia)}: <strong>${formatearCentavos(resumenDia.cobradoCentavos)}</strong></span>
      <span class="franja-dato-abonaron">${resumenDia.abonaron} abonaron</span>
      <span class="franja-dato-no">${resumenDia.dijeronNo} dijeron hoy no</span>
      <span class="franja-dato-sin-visitar">${resumenDia.sinVisitar} sin visitar</span>
    `;
  }

  function renderCabeceraColumnas() {
    const el = contenedor.querySelector('#cabecera-columnas-clientes');
    if (!el) return;
    el.className = `cabecera-columnas cabecera-columnas-excel ${cargosOcultos ? 'cargos-ocultos' : ''}`;
    // Bug del dueño: la cabecera debe compartir EXACTAMENTE el mismo grid que
    // .fila-excel en ambos estados. Antes, al ocultar, se SUSTITUÍA la celda
    // "Cargos" por "‹C" (ambas ocupando el mismo slot de grid) — eso deja 6
    // ítems visibles en la cabecera contra el grid de 5 columnas de las filas
    // de datos, y el 6to (Saldo) se desborda a un renglón aparte. Ahora la
    // celda "Cargos" SIEMPRE existe con la clase .col-cargo (se oculta con la
    // misma regla CSS que las filas) y "‹C" vive ANIDADA dentro de la celda
    // "Abonos" (hijo de un ítem de grid, no un ítem de grid en sí mismo) para
    // no alterar el conteo de columnas.
    el.innerHTML = `
      <span></span><span></span><span class="cabecera-columnas-nombre">Cliente</span>
      <span class="cabecera-columnas-monto">Abonos${cargosOcultos ? ` <button type="button" class="btn-pestania-cargos" id="btn-mostrar-cargos" aria-label="Mostrar columna Cargos">‹C</button>` : ''}</span>
      <button type="button" class="cabecera-columnas-monto btn-ocultar-cargos col-cargo" id="btn-ocultar-cargos">Cargos</button>
      <span class="cabecera-columnas-monto">Saldo</span>
    `;
    const btnOcultar = el.querySelector('#btn-ocultar-cargos');
    if (btnOcultar) btnOcultar.addEventListener('click', () => alternarCargosOcultos(true));
    const btnMostrar = el.querySelector('#btn-mostrar-cargos');
    if (btnMostrar) btnMostrar.addEventListener('click', () => alternarCargosOcultos(false));
  }

  function alternarCargosOcultos(ocultar) {
    cargosOcultos = ocultar;
    guardarPreferenciaCargosOcultos(cargosOcultos);
    renderCabeceraColumnas();
    const elLista = contenedor.querySelector('#lista-clientes-agrupados');
    if (elLista) elLista.classList.toggle('cargos-ocultos', cargosOcultos);
  }

  async function refrescarTodo() {
    await refrescarCategorias();
    renderChipsCategoria();
    await refrescarLista();
    await refrescarArchivados();
  }

  async function refrescarLista() {
    const { grupos, resumenDia } = await listarClientesAgrupados({ fecha: fechaVista, busqueda });
    const elLista = contenedor.querySelector('#lista-clientes-agrupados');
    if (!elLista) return;

    renderNav();
    renderFranja(resumenDia);

    const gruposFiltrados = categoriaFiltro === FILTRO_TODOS
      ? grupos
      : grupos.filter((g) => g.categoria_id === categoriaFiltro);

    elLista.className = `${cargosOcultos ? 'cargos-ocultos' : ''}`;

    if (gruposFiltrados.length === 0) {
      elLista.innerHTML = busqueda
        ? estadoVacio(`No se encontraron clientes para "${busqueda}".`)
        : categoriaFiltro === FILTRO_TODOS
          ? estadoVacio('Todavía no hay clientes.', 'Creá el primero con el botón "+ Nuevo cliente" de abajo.')
          : estadoVacio('No hay clientes en esta categoría.');
      return;
    }

    elLista.innerHTML = gruposFiltrados.map((grupo) => `
      <section class="grupo-clientes">
        <h3 class="grupo-titulo">${bolitaHtml(grupo.categoria_color)} ${escapeHtml(grupo.categoria_nombre)}</h3>
        <ul class="lista lista-grupo" data-categoria-id="${grupo.categoria_id ?? ''}">
          ${grupo.clientes.map((c) => filaClienteHtml(c, grupo.categoria_color)).join('')}
          ${filaSumaHtml(grupo)}
        </ul>
      </section>
    `).join('');

    elLista.querySelectorAll('.lista-grupo').forEach((ul) => {
      ul.querySelectorAll('[data-accion="ver-persona"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const li = btn.closest('[data-cliente-id]');
          window.location.hash = `#/clientes/${encodeURIComponent(li.dataset.clienteId)}`;
        });
      });
      ul.querySelectorAll('[data-accion="abono"], [data-accion="cargo"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const li = btn.closest('[data-cliente-id]');
          const nombre = li.querySelector('.fila-excel-nombre').textContent;
          abrirPanelRapido({
            tipo: btn.dataset.accion === 'abono' ? 'ABONO' : 'CARGO',
            clienteId: li.dataset.clienteId,
            clienteNombre: nombre,
            fechaInicial: fechaVista,
            onGuardado: refrescarLista,
          });
        });
      });
      activarArrastreOrden(ul, async (idsEnOrden) => {
        try {
          await actualizarOrdenClientes(idsEnOrden);
        } catch (e) {
          mostrarToast(e.message || 'No se pudo guardar el nuevo orden.', 'error');
        }
        await refrescarLista();
      });
    });
  }

  async function refrescarArchivados() {
    const elDetalles = contenedor.querySelector('#seccion-archivados');
    const elLista = contenedor.querySelector('#lista-archivados');
    if (!elDetalles || !elLista) return;
    const archivados = await listarClientesArchivados();
    const elResumen = contenedor.querySelector('#resumen-archivados');
    if (elResumen) elResumen.innerHTML = `${Iconos.cajaArchivo()} Archivados (${archivados.length})`;
    if (archivados.length === 0) {
      elLista.innerHTML = estadoVacio('No hay clientes archivados.');
      return;
    }
    elLista.innerHTML = `<ul class="lista lista-archivados">${archivados.map(filaArchivadoHtml).join('')}</ul>`;
    elLista.querySelectorAll('[data-accion="restaurar"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const li = btn.closest('[data-cliente-archivado-id]');
        const idCliente = li.dataset.clienteArchivadoId;
        try {
          await restaurarCliente(idCliente);
          mostrarToast('Cliente restaurado.', 'exito');
          await refrescarArchivados();
          await refrescarLista();
        } catch (e) {
          mostrarToast(e.message || 'No se pudo restaurar el cliente.', 'error');
        }
      });
    });
  }

  contenedor.innerHTML = `
    <section class="pantalla" data-pantalla="clientes">
      ${bannerModoDemoHtml()}
      ${microcopy('¿Para qué sirve esta pantalla?', MICROCOPY)}
      <div class="encabezado-clientes">
        <h1>Clientes</h1>
        <button type="button" class="btn-icono" id="btn-config" aria-label="Configuración de categorías y conceptos">${Iconos.engrane()}</button>
      </div>

      <div class="nav-fecha-clientes">
        <button type="button" class="btn-icono" id="btn-dia-anterior" aria-label="Día anterior">${Iconos.chevronIzquierda()}</button>
        <button type="button" class="nav-fecha-titulo-btn" id="btn-elegir-fecha" aria-label="Elegir fecha">
          <span id="nav-fecha-titulo"></span> ▾
        </button>
        <input type="date" id="input-fecha-vista" class="input-fecha-oculto" max="${hoy()}" aria-hidden="true" tabindex="-1" />
        <button type="button" class="btn-icono" id="btn-dia-siguiente" aria-label="Día siguiente">${Iconos.chevronDerecha()}</button>
      </div>

      <div id="franja-resumen-dia" class="franja-resumen-dia" aria-live="polite"></div>

      <div class="campo campo-compacto">
        <div class="chips-fila chips-scroll" id="wrap-chips-categoria" aria-label="Filtrar por categoría"></div>
      </div>
      <div class="campo campo-compacto campo-buscador">
        <input id="buscador-clientes" type="search" placeholder="Buscar por nombre o teléfono" aria-label="Buscar por nombre o teléfono" />
      </div>
      <div class="cabecera-columnas cabecera-columnas-excel" id="cabecera-columnas-clientes"></div>
      <div id="lista-clientes-agrupados" aria-live="polite"></div>

      <details class="panel-colapsable panel-archivados" id="seccion-archivados">
        <summary id="resumen-archivados">${Iconos.cajaArchivo()} Archivados (0)</summary>
        <div id="lista-archivados" aria-live="polite"></div>
      </details>
    </section>
  `;

  renderCabeceraColumnas();
  await refrescarTodo();

  contenedor.querySelector('#btn-config').addEventListener('click', () => {
    abrirSheetConfiguracion({ onCambios: refrescarTodo });
  });
  wireBannerModoDemo(contenedor);

  contenedor.querySelector('#btn-dia-anterior').addEventListener('click', () => {
    fechaVista = sumarDias(fechaVista, -1);
    refrescarLista();
  });
  contenedor.querySelector('#btn-dia-siguiente').addEventListener('click', () => {
    if (fechaVista === hoy()) return;
    fechaVista = sumarDias(fechaVista, 1);
    refrescarLista();
  });
  const inputFecha = contenedor.querySelector('#input-fecha-vista');
  contenedor.querySelector('#btn-elegir-fecha').addEventListener('click', () => {
    if (inputFecha.showPicker) inputFecha.showPicker();
    else inputFecha.focus();
  });
  inputFecha.addEventListener('change', () => {
    const valor = inputFecha.value;
    if (!valor || !esFechaIsoValida(valor) || esFutura(valor)) return;
    fechaVista = valor;
    refrescarLista();
  });

  const buscador = contenedor.querySelector('#buscador-clientes');
  const onBuscar = debounce(async (valor) => {
    busqueda = valor;
    await refrescarLista();
  }, 300);
  buscador.addEventListener('input', (e) => onBuscar(e.target.value));
}
