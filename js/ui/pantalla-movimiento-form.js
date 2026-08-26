// Pantalla "Registrar movimiento" (2.4-4 del PLAN-MVP.md): selector de
// cliente con buscador, tipo Cargo/Abono, validación en tiempo real (blur) y
// al enviar, confirmación visual y regreso al detalle del cliente.

import { obtenerCliente, registrarCargo, registrarAbono, estaSoloLectura } from '../db.js';
import { hoy, esFechaIsoValida, esFutura } from '../utils/date.js';
import { parsearAPesos } from '../utils/money.js';
import { microcopy, mostrarToast, errorCampo, errorGeneral, montarSelectorCliente } from './componentes.js';

const MICROCOPY = `
  <p>Usá esta pantalla para registrar un <strong>Cargo</strong> (le pagaste un
  servicio al cliente, aumenta lo que te debe) o un <strong>Abono</strong>
  (el cliente te entregó dinero, reduce lo que te debe).</p>
  <p>No hay forma de editar o borrar un movimiento ya guardado: si te
  equivocaste, corregilo desde el historial del cliente con un "ajuste".</p>
`;

const SERVICIOS = [
  { valor: 'AGUA', etiqueta: 'Agua' },
  { valor: 'LUZ', etiqueta: 'Luz' },
  { valor: 'INTERNET', etiqueta: 'Internet' },
  { valor: 'GAS', etiqueta: 'Gas' },
  { valor: 'CABLE', etiqueta: 'Cable' },
  { valor: 'OTRO', etiqueta: 'Otro' },
];

function pintarErrorEnCampo(contenedor, campo, mensaje) {
  const slot = contenedor.querySelector(`[data-error-para="${campo}"]`);
  if (slot) slot.innerHTML = mensaje ? errorCampo(mensaje) : '';
}

function pintarErrorGeneral(contenedor, mensaje) {
  const slot = contenedor.querySelector('[data-error-general]');
  if (slot) slot.innerHTML = mensaje ? errorGeneral(mensaje) : '';
}

function validarMonto(texto) {
  const limpio = (texto || '').trim();
  if (!limpio) return 'El monto es obligatorio.';
  try {
    const centavos = parsearAPesos(limpio);
    if (centavos <= 0) return 'El monto debe ser mayor a $0.00.';
    return null;
  } catch (e) {
    return e.message;
  }
}

function validarFecha(texto) {
  if (!texto) return 'La fecha es obligatoria.';
  if (!esFechaIsoValida(texto)) return 'La fecha no es válida.';
  if (esFutura(texto)) return 'La fecha no puede ser futura.';
  return null;
}

function validarServicio(valor) {
  if (!valor) return 'Elegí un servicio.';
  return null;
}

function validarNota(texto) {
  if (texto && texto.length > 280) return 'La nota no puede superar los 280 caracteres.';
  return null;
}

/**
 * @param {HTMLElement} contenedor
 * @param {{clienteId?: string}} opciones
 */
export async function renderPantallaMovimientoForm(contenedor, { clienteId } = {}) {
  let clienteSeleccionado = null;
  let tipo = 'CARGO';
  const soloLectura = estaSoloLectura();

  if (clienteId) {
    const c = await obtenerCliente(clienteId);
    if (c && !c.deleted_at) {
      clienteSeleccionado = { id: c.id, nombre: c.nombre };
    }
  }

  // Selector de cliente compartido (componentes.js): mismo componente que usa
  // pantalla-calendario.js, sin opción especial acá (siempre hay que elegir
  // un cliente real). Arranca en modo chip si viene preseleccionado desde el
  // detalle de un cliente, o con el buscador abierto si no.
  function renderSelectorCliente() {
    const wrap = contenedor.querySelector('#wrap-selector-cliente');
    wrap.innerHTML = '<div data-error-para="cliente_id"></div>';
    const host = document.createElement('div');
    wrap.prepend(host);
    montarSelectorCliente(host, {
      idBase: 'selector-cliente-movimiento',
      etiquetaCampo: 'Cliente',
      seleccionInicial: clienteSeleccionado ? { id: clienteSeleccionado.id, etiqueta: clienteSeleccionado.nombre } : null,
      onCambio: (seleccion) => {
        if (seleccion) {
          clienteSeleccionado = { id: seleccion.id, nombre: seleccion.etiqueta };
          pintarErrorEnCampo(contenedor, 'cliente_id', '');
        } else {
          clienteSeleccionado = null;
        }
      },
    });
  }

  function renderCamposPorTipo() {
    const wrap = contenedor.querySelector('#wrap-campos-tipo');
    if (tipo === 'CARGO') {
      wrap.innerHTML = `
        <div class="campo">
          <label for="campo-monto">Monto</label>
          <input id="campo-monto" name="monto" type="text" inputmode="decimal" placeholder="Ej. 120.00" required />
          <div data-error-para="monto_centavos"></div>
        </div>
        <div class="campo">
          <label for="campo-servicio">Servicio</label>
          <select id="campo-servicio" name="servicio" required>
            <option value="">Elegí un servicio…</option>
            ${SERVICIOS.map((s) => `<option value="${s.valor}">${s.etiqueta}</option>`).join('')}
          </select>
          <div data-error-para="servicio"></div>
        </div>
        <div class="campo">
          <label for="campo-referencia">Referencia (opcional)</label>
          <input id="campo-referencia" name="referencia" type="text" placeholder="Nº de factura/comprobante" />
        </div>
        <div class="campo">
          <label for="campo-fecha">Fecha</label>
          <input id="campo-fecha" name="fecha" type="date" max="${hoy()}" value="${hoy()}" required />
          <div data-error-para="fecha"></div>
        </div>
        <div class="campo">
          <label for="campo-nota">Nota (opcional, máx. 280 caracteres)</label>
          <textarea id="campo-nota" name="nota" rows="2" maxlength="280"></textarea>
          <div data-error-para="nota"></div>
        </div>
      `;
    } else {
      wrap.innerHTML = `
        <div class="campo">
          <label for="campo-monto">Monto</label>
          <input id="campo-monto" name="monto" type="text" inputmode="decimal" placeholder="Ej. 50.00" required />
          <div data-error-para="monto_centavos"></div>
        </div>
        <div class="campo">
          <label for="campo-fecha">Fecha</label>
          <input id="campo-fecha" name="fecha" type="date" max="${hoy()}" value="${hoy()}" required />
          <div data-error-para="fecha"></div>
        </div>
        <div class="campo">
          <label for="campo-nota">Nota (opcional, máx. 280 caracteres)</label>
          <textarea id="campo-nota" name="nota" rows="2" maxlength="280"></textarea>
          <div data-error-para="nota"></div>
        </div>
      `;
    }

    wrap.querySelector('#campo-monto').addEventListener('blur', (e) => pintarErrorEnCampo(contenedor, 'monto_centavos', validarMonto(e.target.value)));
    wrap.querySelector('#campo-fecha').addEventListener('blur', (e) => pintarErrorEnCampo(contenedor, 'fecha', validarFecha(e.target.value)));
    wrap.querySelector('#campo-nota').addEventListener('blur', (e) => pintarErrorEnCampo(contenedor, 'nota', validarNota(e.target.value)));
    const campoServicio = wrap.querySelector('#campo-servicio');
    if (campoServicio) campoServicio.addEventListener('blur', (e) => pintarErrorEnCampo(contenedor, 'servicio', validarServicio(e.target.value)));
  }

  contenedor.innerHTML = `
    <section class="pantalla" data-pantalla="nuevo-movimiento">
      ${microcopy('¿Para qué sirve esta pantalla?', MICROCOPY)}
      <h1>Registrar movimiento</h1>
      ${soloLectura ? '<p class="aviso-banner aviso-solo-lectura">Modo solo lectura: esta pestaña no puede guardar cambios.</p>' : ''}
      <form id="form-movimiento" class="formulario" novalidate>
        <div id="wrap-selector-cliente"></div>
        <fieldset class="campo">
          <legend>Tipo de movimiento</legend>
          <label class="opcion-radio"><input type="radio" name="tipo" value="CARGO" checked /> Cargo (le pagué un servicio)</label>
          <label class="opcion-radio"><input type="radio" name="tipo" value="ABONO" /> Abono (me entregó dinero)</label>
        </fieldset>
        <div id="wrap-campos-tipo"></div>
        <div data-error-general></div>
        <div class="acciones-formulario">
          <button type="submit" class="btn btn-primario" ${soloLectura ? 'disabled' : ''}>Guardar movimiento</button>
        </div>
      </form>
    </section>
  `;

  renderSelectorCliente();
  renderCamposPorTipo();

  const form = contenedor.querySelector('#form-movimiento');
  form.querySelectorAll('input[name="tipo"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      tipo = e.target.value;
      renderCamposPorTipo();
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (soloLectura) return;

    const datos = new FormData(form);
    const errores = {};

    if (!clienteSeleccionado) errores.cliente_id = 'Elegí un cliente de la lista.';

    const montoTexto = (datos.get('monto') || '').trim();
    const errMonto = validarMonto(montoTexto);
    if (errMonto) errores.monto_centavos = errMonto;

    const fechaTexto = datos.get('fecha') || '';
    const errFecha = validarFecha(fechaTexto);
    if (errFecha) errores.fecha = errFecha;

    const notaTexto = (datos.get('nota') || '').trim();
    const errNota = validarNota(notaTexto);
    if (errNota) errores.nota = errNota;

    let servicioValor = null;
    if (tipo === 'CARGO') {
      servicioValor = datos.get('servicio') || '';
      const errServicio = validarServicio(servicioValor);
      if (errServicio) errores.servicio = errServicio;
    }

    ['cliente_id', 'monto_centavos', 'fecha', 'nota', 'servicio'].forEach((campo) => pintarErrorEnCampo(contenedor, campo, errores[campo] || ''));
    pintarErrorGeneral(contenedor, '');

    if (Object.keys(errores).length > 0) return;

    const montoCentavos = parsearAPesos(montoTexto);

    try {
      if (tipo === 'CARGO') {
        await registrarCargo({
          cliente_id: clienteSeleccionado.id,
          monto_centavos: montoCentavos,
          fecha: fechaTexto,
          servicio: servicioValor,
          referencia: (datos.get('referencia') || '').trim() || undefined,
          nota: notaTexto || undefined,
        });
      } else {
        await registrarAbono({
          cliente_id: clienteSeleccionado.id,
          monto_centavos: montoCentavos,
          fecha: fechaTexto,
          nota: notaTexto || undefined,
        });
      }
      mostrarToast('Movimiento registrado.', 'exito');
      window.location.hash = `#/clientes/${encodeURIComponent(clienteSeleccionado.id)}`;
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR' && err.detalle && err.detalle.campo) {
        pintarErrorEnCampo(contenedor, err.detalle.campo, err.message);
      } else {
        pintarErrorGeneral(contenedor, err.message || 'No se pudo guardar el movimiento.');
      }
    }
  });
}
