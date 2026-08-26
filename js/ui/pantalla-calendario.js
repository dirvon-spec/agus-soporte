// Pantalla "Calendario" (2.4-6 del PLAN-MVP.md, gate del dueño 25-ago-2026):
// cuarta pestaña con dos modos — una persona (misma grilla del Detalle, con
// monto abonado por casilla y resumen del mes) y todas las personas (grilla
// agregada cumplieron/esperados con semáforo verde/amarillo/rojo/neutro).
//
// La agregación del modo global vive en db.js (obtenerCalendarioGlobal); esta
// pantalla solo consulta y renderiza — no se toca db.js/calendar.js.

import {
  listarClientes, listarAcuerdos, listarMovimientos,
  obtenerEstadoCalendario, obtenerCalendarioGlobal,
} from '../db.js';
import { hoy } from '../utils/date.js';
import {
  microcopy, estadoVacio, badgeEstado, leyendaEstados, montoOGuion, montoCortoOGuion,
  formatearFechaCorta, formatearMesAnio, escapeHtml, errorGeneral,
} from './componentes.js';

const MICROCOPY = `
  <p>Esta pantalla tiene dos formas de mirar el cumplimiento de la cuota diaria:
  elegí <strong>"Todas las personas"</strong> para ver, día por día, cuántos
  clientes cumplieron su cuota ese día; o elegí un cliente puntual para ver su
  calendario individual (el mismo que aparece en su Detalle), con el monto que
  abonó cada día.</p>
  <p>Tocá cualquier día para ver el detalle. En el modo "Todas las personas",
  cada fila de la lista te lleva al detalle de ese cliente.</p>
`;

const AVISO_ALCANCE_CALENDARIO =
  'El calendario mide el cumplimiento de la cuota diaria. El saldo de cada cliente ' +
  'incluye además los servicios pagados (cargos).';

const SERVICIO_LABEL = { AGUA: 'Agua', LUZ: 'Luz', INTERNET: 'Internet', GAS: 'Gas', CABLE: 'Cable', OTRO: 'Otro' };
const DIAS_SEMANA = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

// ============================================================
// Helpers puros (fecha / formato)
// ============================================================

function primerYUltimoDiaDeMes(anioMes) {
  const [anio, mes] = anioMes.split('-').map(Number);
  const primerDia = `${anioMes}-01`;
  const ultimoDiaNum = new Date(anio, mes, 0).getDate();
  const ultimoDia = `${anioMes}-${String(ultimoDiaNum).padStart(2, '0')}`;
  return { primerDia, ultimoDia, ultimoDiaNum };
}

function mesAnterior(anioMes) {
  const [anio, mes] = anioMes.split('-').map(Number);
  const d = new Date(anio, mes - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function mesSiguiente(anioMes) {
  const [anio, mes] = anioMes.split('-').map(Number);
  const d = new Date(anio, mes, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Crédito que aporta un movimiento a la cuota del día (misma convención que calendar.js, 2.5). */
function creditoDeMovimiento(m) {
  if (m.tipo === 'ABONO') return m.monto_centavos;
  if (m.tipo === 'AJUSTE') return -m.monto_centavos;
  return 0;
}

function textoMontoMovimiento(m) {
  if (m.tipo === 'CARGO') return { texto: `+ ${montoOGuion(m.monto_centavos)}`, clase: 'monto-negativo' };
  if (m.tipo === 'ABONO') return { texto: `− ${montoOGuion(m.monto_centavos)}`, clase: 'monto-positivo' };
  const signo = m.monto_centavos > 0 ? '+' : '−';
  return { texto: `${signo} ${montoOGuion(Math.abs(m.monto_centavos))}`, clase: m.monto_centavos > 0 ? 'monto-negativo' : 'monto-positivo' };
}

/** Clase de color del semáforo global: verde/amarillo/rojo/neutro (umbral aprobado por el dueño). */
function claseSemaforoGlobal(esperados, cumplieron) {
  if (esperados === 0) return 'estado-fondo-sin-obligacion';
  if (cumplieron === esperados) return 'estado-fondo-pagado'; // verde: todos cumplieron
  if (cumplieron * 2 <= esperados) return 'estado-fondo-deuda'; // rojo: faltó la mitad o más
  return 'estado-fondo-parcial'; // amarillo: faltaron algunos
}

// ============================================================
// Pantalla
// ============================================================

/**
 * @param {HTMLElement} contenedor
 * @param {{clienteId?: string}} opciones
 */
export async function renderPantallaCalendario(contenedor, { clienteId } = {}) {
  let mesCalendario = hoy().slice(0, 7);
  let diaSeleccionado = null;

  async function renderTodo() {
    const { clientes: clientesActivos } = await listarClientes({ tamanioPagina: 500 });
    const clienteActual = clienteId ? clientesActivos.find((c) => c.id === clienteId) : null;
    const clienteNoEncontrado = !!clienteId && !clienteActual;

    const { primerDia, ultimoDia, ultimoDiaNum } = primerYUltimoDiaDeMes(mesCalendario);
    const primerDiaSemana = new Date(primerDia + 'T12:00:00').getDay();

    // Datos que necesita wireEvents() según el modo, calculados acá para no
    // repetir el fetch dentro de los handlers de click.
    let acuerdos = [];
    let movimientosDelMes = [];
    let estadosCalendario = new Map();
    let calendarioGlobal = null;

    let cuerpoHtml;

    if (clienteNoEncontrado) {
      cuerpoHtml = errorGeneral('No se encontró este cliente. Elegí otra opción en el selector de arriba.');
    } else if (clienteActual) {
      acuerdos = await listarAcuerdos(clienteActual.id); // asc, incluye cerrados
      estadosCalendario = await obtenerEstadoCalendario(clienteActual.id, primerDia, ultimoDia);
      movimientosDelMes = (await listarMovimientos({
        cliente_id: clienteActual.id, desde: primerDia, hasta: ultimoDia, tamanioPagina: 2000,
      })).movimientos;

      const creditoPorFecha = new Map();
      for (const m of movimientosDelMes) {
        if (m.tipo !== 'ABONO' && m.tipo !== 'AJUSTE') continue;
        creditoPorFecha.set(m.fecha, (creditoPorFecha.get(m.fecha) || 0) + creditoDeMovimiento(m));
      }
      const cambiosDeCuotaEnMes = new Map(
        acuerdos.filter((a) => a.vigente_desde >= primerDia && a.vigente_desde <= ultimoDia)
          .map((a) => [a.vigente_desde, a.monto_cuota_centavos])
      );

      let diasPagados = 0;
      let diasEnDeuda = 0;
      let totalAbonadoMes = 0;
      for (const credito of creditoPorFecha.values()) totalAbonadoMes += credito;
      for (const estado of estadosCalendario.values()) {
        if (estado === 'PAGADO' || estado === 'GRACIA_ADELANTO') diasPagados++;
        if (estado === 'DEUDA') diasEnDeuda++;
      }

      const movimientosDelDia = diaSeleccionado ? movimientosDelMes.filter((m) => m.fecha === diaSeleccionado) : [];

      cuerpoHtml = `
        <p class="encabezado-cliente-cuota">Cuota vigente: ${montoOGuion(clienteActual.cuota_vigente_centavos)}</p>

        <div class="tarjetas-resumen">
          <div class="tarjeta-resumen">
            <span class="tarjeta-resumen-etiqueta">Días pagados (incl. gracia)</span>
            <span class="tarjeta-resumen-monto">${diasPagados}</span>
          </div>
          <div class="tarjeta-resumen">
            <span class="tarjeta-resumen-etiqueta">Días en deuda</span>
            <span class="tarjeta-resumen-monto">${diasEnDeuda}</span>
          </div>
          <div class="tarjeta-resumen">
            <span class="tarjeta-resumen-etiqueta">Total abonado del mes</span>
            <span class="tarjeta-resumen-monto">${montoOGuion(totalAbonadoMes)}</span>
          </div>
        </div>

        <div class="calendario-grilla" role="grid">
          ${DIAS_SEMANA.map((d) => `<div class="calendario-encabezado-dia">${d}</div>`).join('')}
          ${Array.from({ length: primerDiaSemana }, () => '<div class="calendario-celda calendario-celda-vacia"></div>').join('')}
          ${Array.from({ length: ultimoDiaNum }, (_, i) => {
            const numeroDia = i + 1;
            const fechaDia = `${mesCalendario}-${String(numeroDia).padStart(2, '0')}`;
            const estadoDia = estadosCalendario.get(fechaDia) || 'SIN_OBLIGACION';
            const cambioCuota = cambiosDeCuotaEnMes.get(fechaDia);
            const creditoDia = estadoDia === 'SIN_OBLIGACION' ? null : (creditoPorFecha.get(fechaDia) || 0);
            return `<button type="button" class="calendario-celda calendario-dia estado-fondo-${estadoDia.toLowerCase().replace(/_/g, '-')} ${diaSeleccionado === fechaDia ? 'calendario-dia-seleccionado' : ''}"
              data-fecha="${fechaDia}" data-modo="persona" aria-label="${fechaDia}: ${escapeHtml(estadoDia)}, abonado ${montoCortoOGuion(creditoDia)}">
              <span class="calendario-dia-numero">${numeroDia}</span>
              <span class="calendario-dia-dato">${montoCortoOGuion(creditoDia)}</span>
              ${cambioCuota !== undefined ? `<span class="marcador-cambio-cuota" title="Nueva cuota desde este día: ${escapeHtml(montoOGuion(cambioCuota))}">●</span>` : ''}
            </button>`;
          }).join('')}
        </div>
        <div class="calendario-leyenda">
          ${leyendaEstados()}
          <p class="calendario-aviso-alcance">${escapeHtml(AVISO_ALCANCE_CALENDARIO)}</p>
        </div>
        ${diaSeleccionado ? `
          <div class="panel-dia-seleccionado">
            <div class="panel-dia-seleccionado-header">
              <strong>${escapeHtml(formatearFechaCorta(diaSeleccionado))}</strong>
              <button type="button" class="btn-link" id="btn-cerrar-dia">Cerrar</button>
            </div>
            ${movimientosDelDia.length === 0
              ? estadoVacio('Sin movimientos ese día.')
              : `<ul class="lista lista-compacta">${movimientosDelDia.map((m) => `
                  <li class="lista-item">
                    <span>${escapeHtml(m.tipo)}${m.servicio ? ' · ' + escapeHtml(SERVICIO_LABEL[m.servicio] || m.servicio) : ''}</span>
                    <span class="${textoMontoMovimiento(m).clase}">${textoMontoMovimiento(m).texto}</span>
                  </li>`).join('')}</ul>`
            }
          </div>` : ''}
      `;
    } else {
      calendarioGlobal = await obtenerCalendarioGlobal(mesCalendario);
      const { dias, resumen } = calendarioGlobal;

      const aggDia = diaSeleccionado ? dias.get(diaSeleccionado) : null;

      cuerpoHtml = `
        <div class="tarjetas-resumen">
          <div class="tarjeta-resumen">
            <span class="tarjeta-resumen-etiqueta">Días con cobro completo</span>
            <span class="tarjeta-resumen-monto">${resumen.diasCompletos}</span>
          </div>
          <div class="tarjeta-resumen">
            <span class="tarjeta-resumen-etiqueta">Días con faltantes</span>
            <span class="tarjeta-resumen-monto">${resumen.diasConFaltantes}</span>
          </div>
          <div class="tarjeta-resumen">
            <span class="tarjeta-resumen-etiqueta">Total cobrado del mes</span>
            <span class="tarjeta-resumen-monto">${montoOGuion(resumen.totalCobradoCentavos)}</span>
          </div>
        </div>

        <div class="calendario-grilla" role="grid">
          ${DIAS_SEMANA.map((d) => `<div class="calendario-encabezado-dia">${d}</div>`).join('')}
          ${Array.from({ length: primerDiaSemana }, () => '<div class="calendario-celda calendario-celda-vacia"></div>').join('')}
          ${Array.from({ length: ultimoDiaNum }, (_, i) => {
            const numeroDia = i + 1;
            const fechaDia = `${mesCalendario}-${String(numeroDia).padStart(2, '0')}`;
            const agg = dias.get(fechaDia); // undefined = día futuro, excluido por completo (null honesto)
            const esFuturo = agg === undefined;
            const esNeutro = !esFuturo && agg.esperados === 0;
            const noInteractivo = esFuturo || esNeutro;
            const claseColor = esFuturo ? 'estado-fondo-sin-obligacion' : claseSemaforoGlobal(agg.esperados, agg.cumplieron);
            const dato = noInteractivo ? '—' : `${agg.cumplieron}/${agg.esperados}`;
            return `<button type="button" class="calendario-celda calendario-dia ${claseColor} ${diaSeleccionado === fechaDia ? 'calendario-dia-seleccionado' : ''}"
              data-fecha="${fechaDia}" data-modo="global" ${noInteractivo ? 'disabled' : ''}
              aria-label="${fechaDia}: ${esFuturo ? 'día futuro, sin datos' : esNeutro ? 'nadie tenía cuota vigente' : `${agg.cumplieron} de ${agg.esperados} cumplieron`}">
              <span class="calendario-dia-numero">${numeroDia}</span>
              <span class="calendario-dia-dato">${dato}</span>
            </button>`;
          }).join('')}
        </div>
        <div class="calendario-leyenda">
          <ul class="leyenda-estados">
            <li><span class="badge-estado estado-pagado"><span aria-hidden="true">✓</span> Todos cumplieron</span></li>
            <li><span class="badge-estado estado-parcial"><span aria-hidden="true">½</span> Faltaron algunos</span></li>
            <li><span class="badge-estado estado-deuda"><span aria-hidden="true">!</span> Faltó la mitad o más</span></li>
          </ul>
          <p class="calendario-aviso-alcance">Los días en gris son días futuros o sin ningún cliente con cuota vigente ese día.</p>
        </div>
        ${diaSeleccionado ? `
          <div class="panel-dia-seleccionado">
            <div class="panel-dia-seleccionado-header">
              <strong>${escapeHtml(formatearFechaCorta(diaSeleccionado))}</strong>
              <button type="button" class="btn-link" id="btn-cerrar-dia">Cerrar</button>
            </div>
            ${!aggDia || aggDia.detalle.length === 0
              ? estadoVacio('Ningún cliente tenía cuota vigente ese día.')
              : `<ul class="lista">${aggDia.detalle.map((f) => {
                  const cumplio = f.estado === 'PAGADO' || f.estado === 'GRACIA_ADELANTO';
                  return `<li class="lista-item lista-item-clickeable" data-cliente-id="${escapeHtml(f.cliente_id)}" tabindex="0" role="button">
                    <div class="lista-item-principal">
                      <span class="lista-item-nombre">${escapeHtml(f.nombre)}</span>
                      <span class="${cumplio ? 'monto-positivo' : 'monto-negativo'}"><span aria-hidden="true">${cumplio ? '✓' : '✗'}</span> ${badgeEstado(f.estado)}</span>
                    </div>
                    <div class="lista-item-secundaria">
                      <span>Abonado: ${montoOGuion(f.abonadoCentavos)}</span>
                      <span>Cuota: ${montoOGuion(f.cuotaCentavos)}</span>
                    </div>
                  </li>`;
                }).join('')}</ul>`
            }
          </div>` : ''}
      `;
    }

    contenedor.innerHTML = `
      <section class="pantalla" data-pantalla="calendario">
        ${microcopy('¿Para qué sirve esta pantalla?', MICROCOPY)}
        <h1>Calendario</h1>

        <div class="campo">
          <label for="selector-persona-calendario">Persona</label>
          <select id="selector-persona-calendario">
            <option value="" ${!clienteId ? 'selected' : ''}>Todas las personas</option>
            ${clientesActivos.map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === clienteId ? 'selected' : ''}>${escapeHtml(c.nombre)} — ${montoOGuion(c.cuota_vigente_centavos)}</option>`).join('')}
          </select>
        </div>

        <div class="calendario-wrap">
          <div class="calendario-nav">
            <button type="button" class="btn-icono" id="btn-mes-anterior" aria-label="Mes anterior">&larr;</button>
            <span class="calendario-mes-titulo">${escapeHtml(formatearMesAnio(mesCalendario))}</span>
            <button type="button" class="btn-icono" id="btn-mes-siguiente" aria-label="Mes siguiente">&rarr;</button>
          </div>
          ${cuerpoHtml}
        </div>
      </section>
    `;

    wireEvents();
  }

  function wireEvents() {
    contenedor.querySelector('#selector-persona-calendario').addEventListener('change', (e) => {
      const valor = e.target.value;
      window.location.hash = valor ? `#/calendario/${encodeURIComponent(valor)}` : '#/calendario';
    });

    contenedor.querySelector('#btn-mes-anterior').addEventListener('click', () => {
      mesCalendario = mesAnterior(mesCalendario);
      diaSeleccionado = null;
      renderTodo();
    });
    contenedor.querySelector('#btn-mes-siguiente').addEventListener('click', () => {
      mesCalendario = mesSiguiente(mesCalendario);
      diaSeleccionado = null;
      renderTodo();
    });

    contenedor.querySelectorAll('.calendario-dia').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        diaSeleccionado = diaSeleccionado === btn.dataset.fecha ? null : btn.dataset.fecha;
        renderTodo();
      });
    });

    const btnCerrarDia = contenedor.querySelector('#btn-cerrar-dia');
    if (btnCerrarDia) btnCerrarDia.addEventListener('click', () => { diaSeleccionado = null; renderTodo(); });

    contenedor.querySelectorAll('[data-cliente-id]').forEach((li) => {
      const ir = () => { window.location.hash = `#/clientes/${encodeURIComponent(li.dataset.clienteId)}`; };
      li.addEventListener('click', ir);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ir(); } });
    });
  }

  await renderTodo();
}
