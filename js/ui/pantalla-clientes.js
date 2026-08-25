// Pantalla "Clientes" (2.4-2 del PLAN-MVP.md): buscador con debounce, lista
// paginada, alta de cliente con validación inline.

import { listarClientes, crearClienteConAcuerdo, estaSoloLectura } from '../db.js';
import { hoy } from '../utils/date.js';
import { parsearAPesos } from '../utils/money.js';
import {
  microcopy, estadoVacio, montoOGuion, claseSaldo, escapeHtml,
  paginadorHtml, activarPaginador, mostrarToast, errorCampo, errorGeneral, debounce,
} from './componentes.js';

const TAMANIO_PAGINA = 20;
const MICROCOPY = `
  <p>Acá están todos tus clientes activos. Buscá por nombre o teléfono, o dales
  de alta uno nuevo con el botón "Nuevo cliente".</p>
  <p>El saldo se muestra en rojo si el cliente debe, y en verde si está al día.
  Tocá un cliente para ver su historial completo y su calendario de pagos.</p>
`;

// Estado local del formulario de alta, para no perder lo tipeado si falla la validación.
let formularioAbierto = false;

function filaCliente(c) {
  // Null honesto: listarClientes() ahora expone tiene_movimientos (boolean)
  // para distinguir "sin movimientos todavía" de "saldo neto exactamente en
  // cero", sin necesidad de una consulta extra por fila (A-005).
  const sinMovimientos = !c.tiene_movimientos;
  const saldoParaMostrar = sinMovimientos ? null : c.saldo_centavos;
  return `
    <li class="lista-item lista-item-clickeable" data-cliente-id="${escapeHtml(c.id)}" tabindex="0" role="button">
      <div class="lista-item-principal">
        <span class="lista-item-nombre">${escapeHtml(c.nombre)}</span>
        <span class="lista-item-monto ${sinMovimientos ? '' : claseSaldo(c.saldo_centavos)}">${montoOGuion(saldoParaMostrar)}</span>
      </div>
      <div class="lista-item-secundaria">
        <span>${c.telefono ? escapeHtml(c.telefono) : '—'}</span>
        <span>Cuota: ${montoOGuion(c.cuota_vigente_centavos)}</span>
      </div>
    </li>`;
}

function formularioAltaHtml(errores = {}, valores = {}) {
  return `
    <form id="form-alta-cliente" class="formulario" novalidate>
      <div class="campo">
        <label for="campo-nombre">Nombre</label>
        <input id="campo-nombre" name="nombre" type="text" value="${escapeHtml(valores.nombre || '')}" required minlength="2" />
        ${errorCampo(errores.nombre)}
      </div>
      <div class="campo">
        <label for="campo-telefono">Teléfono (opcional)</label>
        <input id="campo-telefono" name="telefono" type="text" value="${escapeHtml(valores.telefono || '')}" placeholder="Ej. 5215512340000" />
        ${errorCampo(errores.telefono)}
      </div>
      <div class="campo">
        <label for="campo-notas">Notas (opcional)</label>
        <textarea id="campo-notas" name="notas" rows="2">${escapeHtml(valores.notas || '')}</textarea>
      </div>
      <div class="campo">
        <label for="campo-cuota">Cuota diaria</label>
        <input id="campo-cuota" name="cuota" type="text" inputmode="decimal" placeholder="Ej. 50.00" value="${escapeHtml(valores.cuota || '')}" required />
        ${errorCampo(errores.cuota)}
      </div>
      <div class="campo">
        <label for="campo-vigente-desde">Vigente desde</label>
        <input id="campo-vigente-desde" name="vigente_desde" type="date" max="${hoy()}" value="${escapeHtml(valores.vigente_desde || hoy())}" required />
        ${errorCampo(errores.vigente_desde)}
      </div>
      ${errorGeneral(errores.general || '')}
      <div class="acciones-formulario">
        <button type="submit" class="btn btn-primario">Guardar cliente</button>
        <button type="button" class="btn btn-secundario" data-accion="cancelar-alta">Cancelar</button>
      </div>
    </form>
  `;
}

/**
 * @param {HTMLElement} contenedor
 */
export async function renderPantallaClientes(contenedor) {
  let busqueda = '';
  let pagina = 1;
  let erroresForm = {};
  let valoresForm = {};

  async function refrescarLista() {
    const { clientes, total } = await listarClientes({ busqueda, pagina, tamanioPagina: TAMANIO_PAGINA });
    const elLista = contenedor.querySelector('#lista-clientes');
    if (!elLista) return;

    if (clientes.length === 0) {
      elLista.innerHTML = busqueda
        ? estadoVacio(`No se encontraron clientes para "${busqueda}".`)
        : estadoVacio('Todavía no hay clientes.', 'Creá el primero con el botón "Nuevo cliente".');
    } else {
      elLista.innerHTML = `<ul class="lista">${clientes.map(filaCliente).join('')}</ul>`;
      elLista.querySelectorAll('[data-cliente-id]').forEach((li) => {
        const ir = () => { window.location.hash = `#/clientes/${encodeURIComponent(li.dataset.clienteId)}`; };
        li.addEventListener('click', ir);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ir(); } });
      });
    }

    const elPaginador = contenedor.querySelector('#paginador-clientes');
    elPaginador.innerHTML = paginadorHtml({ pagina, tamanioPagina: TAMANIO_PAGINA, total });
    activarPaginador(elPaginador, (nuevaPagina) => {
      pagina = nuevaPagina;
      refrescarLista();
    });
  }

  function renderFormulario() {
    const wrap = contenedor.querySelector('#wrap-alta-cliente');
    if (!formularioAbierto) {
      wrap.innerHTML = `<button type="button" class="btn btn-primario" id="btn-abrir-alta" ${estaSoloLectura() ? 'disabled title="Modo solo lectura"' : ''}>+ Nuevo cliente</button>`;
      wrap.querySelector('#btn-abrir-alta').addEventListener('click', () => {
        formularioAbierto = true;
        erroresForm = {};
        valoresForm = {};
        renderFormulario();
      });
      return;
    }
    wrap.innerHTML = `<div class="panel-formulario"><h2 class="titulo-seccion">Nuevo cliente</h2>${formularioAltaHtml(erroresForm, valoresForm)}</div>`;
    const form = wrap.querySelector('#form-alta-cliente');
    wrap.querySelector('[data-accion="cancelar-alta"]').addEventListener('click', () => {
      formularioAbierto = false;
      erroresForm = {};
      valoresForm = {};
      renderFormulario();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const datos = new FormData(form);
      valoresForm = {
        nombre: datos.get('nombre') || '',
        telefono: datos.get('telefono') || '',
        notas: datos.get('notas') || '',
        cuota: datos.get('cuota') || '',
        vigente_desde: datos.get('vigente_desde') || hoy(),
      };
      erroresForm = {};

      const nombreLimpio = valoresForm.nombre.trim();
      if (nombreLimpio.length < 2) erroresForm.nombre = 'El nombre debe tener al menos 2 caracteres.';

      const telefonoLimpio = valoresForm.telefono.trim();
      if (telefonoLimpio && !/^[\d\s+\-]{7,20}$/.test(telefonoLimpio)) {
        erroresForm.telefono = 'Ingresá solo dígitos, espacios, "+" y "-", entre 7 y 20 caracteres.';
      }

      let montoCuotaCentavos = null;
      try {
        montoCuotaCentavos = parsearAPesos(valoresForm.cuota.trim());
        if (montoCuotaCentavos <= 0) erroresForm.cuota = 'La cuota diaria debe ser mayor a $0.00.';
      } catch (err) {
        erroresForm.cuota = err.message;
      }

      if (Object.keys(erroresForm).length > 0) {
        renderFormulario();
        return;
      }

      try {
        await crearClienteConAcuerdo({
          nombre: nombreLimpio,
          telefono: telefonoLimpio || undefined,
          notas: valoresForm.notas.trim() || undefined,
          monto_cuota_centavos: montoCuotaCentavos,
          vigente_desde: valoresForm.vigente_desde,
        });
        formularioAbierto = false;
        erroresForm = {};
        valoresForm = {};
        mostrarToast('Cliente creado correctamente.', 'exito');
        renderFormulario();
        pagina = 1;
        await refrescarLista();
      } catch (err) {
        if (err.code === 'VALIDATION_ERROR' && err.detalle && err.detalle.campo) {
          erroresForm[err.detalle.campo] = err.message;
        } else {
          erroresForm.general = err.message || 'No se pudo guardar el cliente.';
        }
        renderFormulario();
      }
    });
  }

  contenedor.innerHTML = `
    <section class="pantalla" data-pantalla="clientes">
      ${microcopy('¿Para qué sirve esta pantalla?', MICROCOPY)}
      <h1>Clientes</h1>
      <div class="campo campo-buscador">
        <label for="buscador-clientes">Buscar por nombre o teléfono</label>
        <input id="buscador-clientes" type="search" placeholder="Ej. Rosa, 5215..." />
      </div>
      <div id="wrap-alta-cliente"></div>
      <div id="lista-clientes" aria-live="polite"></div>
      <div id="paginador-clientes-wrap"><div id="paginador-clientes"></div></div>
    </section>
  `;

  renderFormulario();
  await refrescarLista();

  const buscador = contenedor.querySelector('#buscador-clientes');
  const onBuscar = debounce(async (valor) => {
    busqueda = valor;
    pagina = 1;
    await refrescarLista();
  }, 300);
  buscador.addEventListener('input', (e) => onBuscar(e.target.value));
}
