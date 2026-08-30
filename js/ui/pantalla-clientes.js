// Pantalla "Clientes" (inicio) — contrato vigente §2.10 (PLAN-MVP.md, itera-
// ción v3 "Excel"): filas de una sola línea (monto-es-botón), chips de filtro
// por categoría, buscador, orden manual por arrastre, fila Σ por grupo,
// engrane de Configuración (categorías/conceptos), y sección colapsable de
// clientes archivados con restauración.

import {
  listarClientesAgrupados, listarClientesArchivados, restaurarCliente,
  listarCategorias, crearCliente, crearCategoria, actualizarOrdenClientes, estaSoloLectura,
} from '../db.js';
import { formatearCompacto } from '../utils/money.js';
import {
  microcopy, estadoVacio, montoOGuion, claseSaldo, escapeHtml, debounce,
  mostrarToast, errorCampo, errorGeneral, Iconos, bolitaHtml,
  abrirSheet, cerrarSheet, abrirSheetCategoria, abrirSheetConfiguracion, abrirPanelRapido,
  activarLongPress, activarArrastreOrden, PALETA_COLORES_CATEGORIA,
} from './componentes.js';

const MICROCOPY = `
  <p>Acá están todos tus clientes activos, agrupados como vos quieras
  (categorías con color, o sin categoría). Los cobros son como tú los
  acuerdes con cada quien: no hay cuotas fijas — vos registrás cada abono y
  cada cargo cuando pasa.</p>
  <p><strong>El monto ES el botón:</strong> tocá el verde para registrar un
  abono, el rojo para un cargo, o el nombre para ver el calendario completo
  de ese cliente. Mantené presionado el agarre ⋮⋮ para reordenar dentro de un
  grupo, o un chip de categoría para editarla o eliminarla. El engrane
  abre la Configuración de categorías y conceptos.</p>
`;

// §2.10 A-201: a partir de $100,000.00 el monto se muestra en notación
// compacta ("$150 k", "$1.2 M") SOLO en esta vista de lista — el monto
// completo con centavos sigue disponible siempre en Persona y en el panel
// rápido. Evita que columnas angostas fuercen el nombre a colapsar.
const UMBRAL_COMPACTO_CENTAVOS = 100000 * 100; // $100,000.00

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

function filaClienteHtml(c, categoriaColor) {
  const sinMovimientos = !c.tiene_movimientos;
  const saldoParaMostrar = sinMovimientos ? null : c.saldo_centavos;
  return `
    <li class="lista-item fila-cliente fila-excel" data-cliente-id="${escapeHtml(c.id)}">
      <span class="asa-arrastre" aria-hidden="true" title="Mantené presionado para reordenar">${Iconos.arrastre()}</span>
      ${bolitaHtml(categoriaColor)}
      <button type="button" class="fila-excel-nombre" data-accion="ver-persona" title="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</button>
      <button type="button" class="fila-excel-monto monto-positivo" data-accion="abono" title="${escapeHtml(montoOGuion(c.abonos_mes_centavos))}">${montoSpan(montoListaOGuion(c.abonos_mes_centavos))}</button>
      <button type="button" class="fila-excel-monto monto-negativo" data-accion="cargo" title="${escapeHtml(montoOGuion(c.cargos_mes_centavos))}">${montoSpan(montoListaOGuion(c.cargos_mes_centavos))}</button>
      <span class="fila-excel-monto ${sinMovimientos ? '' : claseSaldo(c.saldo_centavos)}" title="${escapeHtml(montoOGuion(saldoParaMostrar))}">${montoSpan(montoListaOGuion(saldoParaMostrar))}</span>
    </li>`;
}

function filaSumaHtml(grupo) {
  const colorEstilo = grupo.categoria_color ? `color:${escapeHtml(grupo.categoria_color)}` : '';
  return `
    <li class="lista-item fila-suma-grupo fila-excel" style="${colorEstilo}">
      <span class="asa-arrastre-vacia" aria-hidden="true"></span>
      <span class="fila-suma-etiqueta">Σ ${escapeHtml(grupo.categoria_nombre)}</span>
      <span class="fila-excel-monto monto-positivo" title="${escapeHtml(montoOGuion(grupo.totales.abonos_mes_centavos))}">${montoSpan(montoListaOGuion(grupo.totales.abonos_mes_centavos))}</span>
      <span class="fila-excel-monto monto-negativo" title="${escapeHtml(montoOGuion(grupo.totales.cargos_mes_centavos))}">${montoSpan(montoListaOGuion(grupo.totales.cargos_mes_centavos))}</span>
      <span class="fila-excel-monto" title="${escapeHtml(montoOGuion(grupo.totales.saldo_centavos))}">${montoSpan(montoListaOGuion(grupo.totales.saldo_centavos))}</span>
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
 * @param {HTMLElement} contenedor
 */
export async function renderPantallaClientes(contenedor) {
  let busqueda = '';
  let categoriaFiltro = FILTRO_TODOS; // FILTRO_TODOS | FILTRO_SIN_CATEGORIA (null) | id de categoría
  let categorias = [];

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

  async function refrescarTodo() {
    await refrescarCategorias();
    renderChipsCategoria();
    await refrescarLista();
    await refrescarArchivados();
  }

  async function refrescarLista() {
    const { grupos } = await listarClientesAgrupados({ busqueda });
    const elLista = contenedor.querySelector('#lista-clientes-agrupados');
    if (!elLista) return;

    const gruposFiltrados = categoriaFiltro === FILTRO_TODOS
      ? grupos
      : grupos.filter((g) => g.categoria_id === categoriaFiltro);

    if (gruposFiltrados.length === 0) {
      elLista.innerHTML = busqueda
        ? estadoVacio(`No se encontraron clientes para "${busqueda}".`)
        : categoriaFiltro === FILTRO_TODOS
          ? estadoVacio('Todavía no hay clientes.', 'Creá el primero con el botón "+ Nuevo cliente".')
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

  function abrirSheetNuevoCliente() {
    abrirSheet((host) => {
      let categoriaSeleccionada = null;
      let mostrarNuevaCategoria = false;
      let colorNuevaCategoria = PALETA_COLORES_CATEGORIA[0];
      let error = {};
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

      function render() {
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
            await refrescarLista();
          } catch (err) {
            if (err.code === 'VALIDATION_ERROR' && err.detalle && err.detalle.campo) error[err.detalle.campo] = err.message;
            else if (err.code === 'CONFLICT') error.nombre = err.message;
            else error.general = err.message || 'No se pudo crear el cliente.';
            render();
          }
        });
      }
      render();
    }, { titulo: 'Nuevo cliente' });
  }

  contenedor.innerHTML = `
    <section class="pantalla" data-pantalla="clientes">
      ${microcopy('¿Para qué sirve esta pantalla?', MICROCOPY)}
      <div class="encabezado-clientes">
        <h1>Clientes</h1>
        <button type="button" class="btn-icono" id="btn-config" aria-label="Configuración de categorías y conceptos">${Iconos.engrane()}</button>
      </div>
      <div class="campo">
        <label id="etiqueta-filtro-categoria">Filtrar por categoría</label>
        <div class="chips-fila" id="wrap-chips-categoria" aria-labelledby="etiqueta-filtro-categoria"></div>
      </div>
      <div class="campo campo-buscador">
        <label for="buscador-clientes">Buscar por nombre o teléfono</label>
        <input id="buscador-clientes" type="search" placeholder="Ej. Rosa, 5215..." />
      </div>
      <button type="button" class="btn btn-primario" id="btn-nuevo-cliente" ${estaSoloLectura() ? 'disabled title="Modo solo lectura"' : ''}>${Iconos.mas()} Nuevo cliente</button>
      <div class="cabecera-columnas cabecera-columnas-excel">
        <span></span><span></span><span class="cabecera-columnas-nombre">Cliente</span>
        <span class="cabecera-columnas-monto">Abonos</span><span class="cabecera-columnas-monto">Cargos</span><span class="cabecera-columnas-monto">Saldo</span>
      </div>
      <div id="lista-clientes-agrupados" aria-live="polite"></div>

      <details class="panel-colapsable panel-archivados" id="seccion-archivados">
        <summary id="resumen-archivados">${Iconos.cajaArchivo()} Archivados (0)</summary>
        <div id="lista-archivados" aria-live="polite"></div>
      </details>
    </section>
  `;

  await refrescarTodo();

  contenedor.querySelector('#btn-nuevo-cliente').addEventListener('click', abrirSheetNuevoCliente);
  contenedor.querySelector('#btn-config').addEventListener('click', () => {
    abrirSheetConfiguracion({ onCambios: refrescarTodo });
  });

  const buscador = contenedor.querySelector('#buscador-clientes');
  const onBuscar = debounce(async (valor) => {
    busqueda = valor;
    await refrescarLista();
  }, 300);
  buscador.addEventListener('input', (e) => onBuscar(e.target.value));
}
