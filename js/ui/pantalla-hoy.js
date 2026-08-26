// Pantalla "Hoy" (2.4-1 del PLAN-MVP.md): resumen del día con navegación de
// día atrás/adelante. Pantalla de solo lectura + navegación, sin formularios.

import { resumenDia } from '../db.js';
import { hoy, sumarDias } from '../utils/date.js';
import {
  microcopy, estadoVacio, badgeEstado, montoOGuion, claseSaldo,
  formatearFechaLegible, escapeHtml, Iconos,
} from './componentes.js';

const MICROCOPY = `
  <p>Esta pantalla muestra, para el día que estés viendo, quién tiene una cuota
  vigente, cuánto se esperaba cobrar y cuánto se cobró realmente.</p>
  <p>Usá las flechas junto a la fecha para revisar días pasados. Tocá un
  cliente de la lista para ver su detalle completo.</p>
`;

function filaCliente(c) {
  return `
    <li class="lista-item lista-item-clickeable" data-cliente-id="${escapeHtml(c.cliente_id)}" tabindex="0" role="button">
      <div class="lista-item-principal">
        <span class="lista-item-nombre">${escapeHtml(c.nombre)}</span>
        ${badgeEstado(c.estado)}
      </div>
      <div class="lista-item-secundaria">
        <span>Cuota: ${montoOGuion(c.cuotaCentavos)}</span>
        <span>Abonado hoy: ${montoOGuion(c.abonadoHoyCentavos)}</span>
      </div>
    </li>`;
}

/**
 * @param {HTMLElement} contenedor
 * @param {{fecha?: string}} opciones
 */
export async function renderPantallaHoy(contenedor, { fecha } = {}) {
  const fechaObjetivo = fecha || hoy();
  const esHoy = fechaObjetivo === hoy();

  const resumen = await resumenDia(fechaObjetivo);
  const hayClientes = resumen.clientes.length > 0;
  const diferencia = hayClientes ? resumen.totalEsperadoCentavos - resumen.totalCobradoCentavos : null;

  contenedor.innerHTML = `
    <section class="pantalla" data-pantalla="hoy">
      ${microcopy('¿Para qué sirve esta pantalla?', MICROCOPY)}

      <header class="encabezado-hoy">
        <button type="button" class="btn-icono" data-accion="dia-anterior" aria-label="Día anterior">${Iconos.chevronIzquierda()}</button>
        <div class="encabezado-hoy-titulo">
          <h1>${esHoy ? 'Hoy' : 'Viendo'}</h1>
          <p class="encabezado-hoy-fecha">${escapeHtml(formatearFechaLegible(fechaObjetivo))}</p>
          ${!esHoy ? '<button type="button" class="btn-link" data-accion="volver-hoy">Volver a hoy</button>' : ''}
        </div>
        <button type="button" class="btn-icono" data-accion="dia-siguiente" aria-label="Día siguiente"
          ${esHoy ? 'disabled title="Ya estás viendo hoy: esta pantalla es para revisar días pasados."' : ''}>${Iconos.chevronDerecha()}</button>
      </header>

      <div class="tarjetas-resumen">
        <div class="tarjeta-resumen">
          <span class="tarjeta-resumen-etiqueta">Total esperado hoy</span>
          <span class="tarjeta-resumen-monto">${hayClientes ? montoOGuion(resumen.totalEsperadoCentavos) : '—'}</span>
        </div>
        <div class="tarjeta-resumen">
          <span class="tarjeta-resumen-etiqueta">Total cobrado hoy</span>
          <span class="tarjeta-resumen-monto">${hayClientes ? montoOGuion(resumen.totalCobradoCentavos) : '—'}</span>
        </div>
        <div class="tarjeta-resumen">
          <span class="tarjeta-resumen-etiqueta">Diferencia (falta cobrar)</span>
          <span class="tarjeta-resumen-monto ${diferencia !== null ? claseSaldo(diferencia) : ''}">${diferencia !== null ? montoOGuion(diferencia) : '—'}</span>
        </div>
      </div>

      <h2 class="titulo-seccion">Clientes con cuota vigente</h2>
      ${hayClientes
        ? `<ul class="lista">${resumen.clientes.map(filaCliente).join('')}</ul>`
        : estadoVacio('No hay cobros programados para hoy.')}
    </section>
  `;

  contenedor.querySelector('[data-accion="dia-anterior"]').addEventListener('click', () => {
    window.location.hash = `#/hoy/${sumarDias(fechaObjetivo, -1)}`;
  });
  contenedor.querySelector('[data-accion="dia-siguiente"]').addEventListener('click', () => {
    if (esHoy) return; // A-007: no se permite avanzar más allá de hoy.
    window.location.hash = `#/hoy/${sumarDias(fechaObjetivo, 1)}`;
  });
  const btnVolverHoy = contenedor.querySelector('[data-accion="volver-hoy"]');
  if (btnVolverHoy) btnVolverHoy.addEventListener('click', () => { window.location.hash = '#/hoy'; });

  contenedor.querySelectorAll('[data-cliente-id]').forEach((li) => {
    const ir = () => { window.location.hash = `#/clientes/${encodeURIComponent(li.dataset.clienteId)}`; };
    li.addEventListener('click', ir);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ir(); } });
  });
}
