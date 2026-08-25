// Pantalla "Detalle de cliente" (2.4-3 del PLAN-MVP.md): saldo, calendario
// mensual, historial paginado, ajuste con selector aumenta/reduce +
// previsualización, renegociar cuota, WhatsApp, estado de cuenta imprimible.

import {
  obtenerCliente, calcularSaldo, listarAcuerdos, crearAcuerdo,
  listarMovimientos, registrarAjuste, obtenerEstadoCalendario,
  generarEnlaceWhatsApp, estaSoloLectura,
} from '../db.js';
import { hoy, sumarDias } from '../utils/date.js';
import { parsearAPesos, formatearCentavos } from '../utils/money.js';
import {
  microcopy, estadoVacio, badgeEstado, leyendaEstados, montoOGuion, claseSaldo,
  formatearFechaCorta, formatearMesAnio, escapeHtml, paginadorHtml,
  activarPaginador, mostrarToast, errorCampo, errorGeneral,
} from './componentes.js';

const MICROCOPY_DETALLE = `
  <p>Acá ves todo sobre este cliente: su saldo actual, su calendario de
  cumplimiento de cuota, y el historial completo de cargos, abonos y ajustes.</p>
  <p>Tocá un día del calendario para ver qué pasó ese día. Si un movimiento
  quedó mal cargado, no se edita ni se borra: se corrige con un "ajuste"
  desde el historial, que queda registrado junto al original.</p>
`;

const AVISO_ALCANCE_CALENDARIO =
  'El calendario mide el cumplimiento de la cuota diaria. El saldo de arriba ' +
  'incluye además los servicios pagados (cargos).';

const SERVICIO_LABEL = { AGUA: 'Agua', LUZ: 'Luz', INTERNET: 'Internet', GAS: 'Gas', CABLE: 'Cable', OTRO: 'Otro' };
const DIAS_SEMANA = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const TAMANIO_PAGINA_HISTORIAL = 20;

function textoMontoMovimiento(m) {
  if (m.tipo === 'CARGO') return { texto: `+ ${formatearCentavos(m.monto_centavos)}`, clase: 'monto-negativo' };
  if (m.tipo === 'ABONO') return { texto: `− ${formatearCentavos(m.monto_centavos)}`, clase: 'monto-positivo' };
  const signo = m.monto_centavos > 0 ? '+' : '−';
  return { texto: `${signo} ${formatearCentavos(Math.abs(m.monto_centavos))}`, clase: m.monto_centavos > 0 ? 'monto-negativo' : 'monto-positivo' };
}

function primerYUltimoDiaDeMes(anioMes) {
  const [anio, mes] = anioMes.split('-').map(Number);
  const primerDia = `${anioMes}-01`;
  const ultimoDiaNum = new Date(anio, mes, 0).getDate();
  const ultimoDia = `${anioMes}-${String(ultimoDiaNum).padStart(2, '0')}`;
  return { primerDia, ultimoDia, ultimoDiaNum, anio, mes };
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

/**
 * @param {HTMLElement} contenedor
 * @param {{id: string}} opciones
 */
export async function renderPantallaClienteDetalle(contenedor, { id }) {
  let mesCalendario = hoy().slice(0, 7);
  let diaSeleccionado = null;
  let filtroTipo = '';
  let paginaHistorial = 1;
  let renegociarAbierto = false;
  let erroresRenegociar = {};
  let valoresRenegociar = {};
  let ajusteMovimientoId = null;
  let erroresAjuste = {};

  const soloLectura = estaSoloLectura();

  async function renderTodo() {
    const cliente = await obtenerCliente(id);
    if (!cliente || cliente.deleted_at) {
      contenedor.innerHTML = `
        <section class="pantalla">
          <p class="error-general" role="alert">No se encontró este cliente.</p>
          <a href="#/clientes" class="btn btn-secundario">Volver a Clientes</a>
        </section>`;
      return;
    }

    const todosLosMovimientos = (await listarMovimientos({ cliente_id: id, tamanioPagina: 5000 })).movimientos;
    const sinMovimientos = todosLosMovimientos.length === 0;
    const saldoActual = await calcularSaldo(id);
    const saldoParaMostrar = sinMovimientos ? null : saldoActual;

    const acuerdos = await listarAcuerdos(id); // asc, incluye cerrados
    const acuerdoVigenteHoy = acuerdos.find((a) => a.vigente_desde <= hoy() && (!a.vigente_hasta || a.vigente_hasta >= hoy())) || null;

    let enlaceWhatsApp = null;
    let motivoSinWhatsApp = null;
    try {
      enlaceWhatsApp = await generarEnlaceWhatsApp(id);
    } catch (e) {
      motivoSinWhatsApp = e.message;
    }

    const { primerDia, ultimoDia, ultimoDiaNum } = primerYUltimoDiaDeMes(mesCalendario);
    const estadosCalendario = await obtenerEstadoCalendario(id, primerDia, ultimoDia);
    const cambiosDeCuotaEnMes = new Map(
      acuerdos.filter((a) => a.vigente_desde >= primerDia && a.vigente_desde <= ultimoDia)
        .map((a) => [a.vigente_desde, a.monto_cuota_centavos])
    );
    const primerDiaSemana = new Date(primerDia + 'T12:00:00').getDay();
    const movimientosDelDia = diaSeleccionado ? todosLosMovimientos.filter((m) => m.fecha === diaSeleccionado) : [];

    const { movimientos: movimientosPagina, total: totalHistorial } = await listarMovimientos({
      cliente_id: id, tipo: filtroTipo || undefined, pagina: paginaHistorial, tamanioPagina: TAMANIO_PAGINA_HISTORIAL,
    });
    const fechaPorId = new Map(todosLosMovimientos.map((m) => [m.id, m.fecha]));

    contenedor.innerHTML = `
      <section class="pantalla" data-pantalla="cliente-detalle">
        ${microcopy('¿Para qué sirve esta pantalla?', MICROCOPY_DETALLE)}

        <header class="encabezado-cliente">
          <h1>${escapeHtml(cliente.nombre)}</h1>
          <p class="encabezado-cliente-telefono">${cliente.telefono ? escapeHtml(cliente.telefono) : '—'}</p>
          <div class="encabezado-cliente-saldo">
            <span class="etiqueta-saldo">Saldo actual</span>
            <span class="monto-grande ${sinMovimientos ? '' : claseSaldo(saldoActual)}">${montoOGuion(saldoParaMostrar)}</span>
          </div>
          <p class="encabezado-cliente-cuota">Cuota vigente: ${acuerdoVigenteHoy ? montoOGuion(acuerdoVigenteHoy.monto_cuota_centavos) : '—'}</p>
          ${cliente.notas ? `
            <div class="encabezado-cliente-notas">
              <span class="etiqueta-saldo">Nota</span>
              <p class="texto-nota-cliente">${escapeHtml(cliente.notas)}</p>
            </div>` : ''}
        </header>

        <div class="acciones-cliente">
          ${enlaceWhatsApp
            ? `<a class="btn btn-secundario" href="${escapeHtml(enlaceWhatsApp)}" target="_blank" rel="noopener">Recordatorio WhatsApp</a>`
            : `<button type="button" class="btn btn-secundario" disabled title="${escapeHtml(motivoSinWhatsApp || 'Sin teléfono')}">Recordatorio WhatsApp</button>`
          }
          <a class="btn btn-secundario" href="#/clientes/${encodeURIComponent(id)}/imprimir" target="_blank" rel="noopener">Estado de cuenta</a>
          <button type="button" class="btn btn-secundario" id="btn-toggle-renegociar" ${soloLectura ? 'disabled title="Modo solo lectura"' : ''}>
            ${renegociarAbierto ? 'Cancelar renegociación' : 'Renegociar cuota'}
          </button>
          <a class="btn btn-primario" href="#/nuevo-movimiento/${encodeURIComponent(id)}">Registrar movimiento</a>
        </div>

        <div id="panel-renegociar">${renegociarAbierto ? renderFormularioRenegociar() : ''}</div>

        <h2 class="titulo-seccion">Calendario</h2>
        <div class="calendario-wrap">
          <div class="calendario-nav">
            <button type="button" class="btn-icono" id="btn-mes-anterior" aria-label="Mes anterior">&larr;</button>
            <span class="calendario-mes-titulo">${escapeHtml(formatearMesAnio(mesCalendario))}</span>
            <button type="button" class="btn-icono" id="btn-mes-siguiente" aria-label="Mes siguiente">&rarr;</button>
          </div>
          <div class="calendario-grilla" role="grid">
            ${DIAS_SEMANA.map((d) => `<div class="calendario-encabezado-dia">${d}</div>`).join('')}
            ${Array.from({ length: primerDiaSemana }, () => '<div class="calendario-celda calendario-celda-vacia"></div>').join('')}
            ${Array.from({ length: ultimoDiaNum }, (_, i) => {
              const numeroDia = i + 1;
              const fechaDia = `${mesCalendario}-${String(numeroDia).padStart(2, '0')}`;
              const estadoDia = estadosCalendario.get(fechaDia) || 'SIN_OBLIGACION';
              const cambioCuota = cambiosDeCuotaEnMes.get(fechaDia);
              return `<button type="button" class="calendario-celda calendario-dia estado-fondo-${estadoDia.toLowerCase().replace(/_/g, '-')} ${diaSeleccionado === fechaDia ? 'calendario-dia-seleccionado' : ''}"
                data-fecha="${fechaDia}" aria-label="${fechaDia}: ${escapeHtml(estadoDia)}">
                <span class="calendario-dia-numero">${numeroDia}</span>
                ${cambioCuota !== undefined ? `<span class="marcador-cambio-cuota" title="Nueva cuota desde este día: ${escapeHtml(formatearCentavos(cambioCuota))}">●</span>` : ''}
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
        </div>

        <h2 class="titulo-seccion">Historial de movimientos</h2>
        <div class="campo campo-filtro-historial">
          <label for="filtro-tipo-historial">Filtrar por tipo</label>
          <select id="filtro-tipo-historial">
            <option value="" ${filtroTipo === '' ? 'selected' : ''}>Todos</option>
            <option value="CARGO" ${filtroTipo === 'CARGO' ? 'selected' : ''}>Cargos</option>
            <option value="ABONO" ${filtroTipo === 'ABONO' ? 'selected' : ''}>Abonos</option>
            <option value="AJUSTE" ${filtroTipo === 'AJUSTE' ? 'selected' : ''}>Ajustes</option>
          </select>
        </div>
        ${sinMovimientos
          ? estadoVacio('Este cliente todavía no tiene movimientos registrados.')
          : (movimientosPagina.length === 0
              ? estadoVacio('No hay movimientos de ese tipo.')
              : `<ul class="lista lista-historial">
                  ${movimientosPagina.map((m) => {
                    const montoInfo = textoMontoMovimiento(m);
                    const esCorregible = m.tipo === 'CARGO' || m.tipo === 'ABONO';
                    return `
                    <li class="lista-item lista-item-historial" data-movimiento-id="${escapeHtml(m.id)}">
                      <div class="lista-item-principal">
                        <span>${escapeHtml(formatearFechaCorta(m.fecha))} — ${escapeHtml(m.tipo)}${m.servicio ? ' · ' + escapeHtml(SERVICIO_LABEL[m.servicio] || m.servicio) : ''}</span>
                        <span class="${montoInfo.clase}">${montoInfo.texto}</span>
                      </div>
                      <div class="lista-item-secundaria">
                        ${m.nota ? `<span>${escapeHtml(m.nota)}</span>` : ''}
                        ${m.referencia ? `<span>Ref: ${escapeHtml(m.referencia)}</span>` : ''}
                        ${m.tipo === 'AJUSTE' ? `<span class="etiqueta-ajusta">Ajusta movimiento del ${escapeHtml(formatearFechaCorta(fechaPorId.get(m.movimiento_original_id) || m.fecha))}</span>` : ''}
                      </div>
                      ${esCorregible ? `<button type="button" class="btn btn-secundario btn-pequeno" data-accion="abrir-ajuste" data-id="${escapeHtml(m.id)}" ${soloLectura ? 'disabled title="Modo solo lectura"' : ''}>
                        ${ajusteMovimientoId === m.id ? 'Cancelar corrección' : 'Corregir con ajuste'}
                      </button>` : ''}
                      ${ajusteMovimientoId === m.id ? renderFormularioAjuste(m, saldoActual) : ''}
                    </li>`;
                  }).join('')}
                </ul>`)
        }
        <div id="paginador-historial">${paginadorHtml({ pagina: paginaHistorial, tamanioPagina: TAMANIO_PAGINA_HISTORIAL, total: totalHistorial })}</div>

        <details class="panel-colapsable">
          <summary>Historial de acuerdos (cuotas históricas)</summary>
          ${acuerdos.length === 0 ? estadoVacio('Sin acuerdos registrados.') : `
            <table class="tabla">
              <thead><tr><th>Vigente desde</th><th>Vigente hasta</th><th>Cuota diaria</th></tr></thead>
              <tbody>
                ${acuerdos.map((a) => `<tr>
                  <td>${escapeHtml(formatearFechaCorta(a.vigente_desde))}</td>
                  <td>${a.vigente_hasta ? escapeHtml(formatearFechaCorta(a.vigente_hasta)) : 'Actual'}</td>
                  <td>${montoOGuion(a.monto_cuota_centavos)}</td>
                </tr>`).join('')}
              </tbody>
            </table>`}
        </details>
      </section>
    `;

    wireEvents();
  }

  function renderFormularioRenegociar() {
    return `
      <div class="panel-formulario">
        <h3>Renegociar cuota</h3>
        <form id="form-renegociar" class="formulario" novalidate>
          <div class="campo">
            <label for="campo-nueva-cuota">Nueva cuota diaria</label>
            <input id="campo-nueva-cuota" name="cuota" type="text" inputmode="decimal" value="${escapeHtml(valoresRenegociar.cuota || '')}" required />
            ${errorCampo(erroresRenegociar.monto_cuota_centavos)}
          </div>
          <div class="campo">
            <label for="campo-vigencia-nueva">Vigente desde</label>
            <input id="campo-vigencia-nueva" name="vigente_desde" type="date" max="${hoy()}" value="${escapeHtml(valoresRenegociar.vigente_desde || hoy())}" required />
            ${errorCampo(erroresRenegociar.vigente_desde)}
          </div>
          ${errorGeneral(erroresRenegociar.general || '')}
          <div class="acciones-formulario">
            <button type="submit" class="btn btn-primario">Confirmar</button>
          </div>
        </form>
      </div>
    `;
  }

  function renderFormularioAjuste(movimientoOriginal, saldoActual) {
    return `
      <div class="panel-formulario panel-ajuste">
        <form class="formulario formulario-ajuste" data-form-ajuste="${escapeHtml(movimientoOriginal.id)}" novalidate>
          <fieldset class="campo">
            <legend>¿La corrección aumenta o reduce la deuda del cliente?</legend>
            <label class="opcion-radio"><input type="radio" name="signo" value="aumenta" /> Aumenta la deuda</label>
            <label class="opcion-radio"><input type="radio" name="signo" value="reduce" checked /> Reduce la deuda</label>
          </fieldset>
          <div class="campo">
            <label>Monto de la corrección</label>
            <input name="monto" type="text" inputmode="decimal" placeholder="Ej. 50.00" />
            ${errorCampo(erroresAjuste.monto)}
          </div>
          <div class="campo">
            <label>Nota (opcional)</label>
            <input name="nota" type="text" maxlength="280" />
          </div>
          <p class="previsualizacion-ajuste">Ingresá un monto para ver la previsualización.</p>
          ${errorGeneral(erroresAjuste.general || '')}
          <div class="acciones-formulario">
            <button type="submit" class="btn btn-primario">Confirmar ajuste</button>
          </div>
        </form>
      </div>
    `;
  }

  function actualizarPreviewAjuste(form, saldoActual) {
    const previewEl = form.querySelector('.previsualizacion-ajuste');
    const montoTexto = form.querySelector('[name="monto"]').value.trim();
    const signo = form.querySelector('[name="signo"]:checked').value;
    if (!montoTexto) {
      previewEl.textContent = 'Ingresá un monto para ver la previsualización.';
      previewEl.classList.remove('previsualizacion-invalida');
      return;
    }
    try {
      const centavos = parsearAPesos(montoTexto);
      const delta = signo === 'aumenta' ? centavos : -centavos;
      const nuevoSaldo = saldoActual + delta;
      previewEl.textContent = `El saldo pasará de ${formatearCentavos(saldoActual)} a ${formatearCentavos(nuevoSaldo)}.`;
      previewEl.classList.remove('previsualizacion-invalida');
    } catch (e) {
      previewEl.textContent = 'Ese monto no es válido.';
      previewEl.classList.add('previsualizacion-invalida');
    }
  }

  function wireEvents() {
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
        diaSeleccionado = diaSeleccionado === btn.dataset.fecha ? null : btn.dataset.fecha;
        renderTodo();
      });
    });
    const btnCerrarDia = contenedor.querySelector('#btn-cerrar-dia');
    if (btnCerrarDia) btnCerrarDia.addEventListener('click', () => { diaSeleccionado = null; renderTodo(); });

    contenedor.querySelector('#btn-toggle-renegociar').addEventListener('click', () => {
      renegociarAbierto = !renegociarAbierto;
      erroresRenegociar = {};
      valoresRenegociar = {};
      renderTodo();
    });

    const formRenegociar = contenedor.querySelector('#form-renegociar');
    if (formRenegociar) {
      formRenegociar.addEventListener('submit', async (e) => {
        e.preventDefault();
        const datos = new FormData(formRenegociar);
        valoresRenegociar = { cuota: datos.get('cuota') || '', vigente_desde: datos.get('vigente_desde') || hoy() };
        erroresRenegociar = {};
        let montoCuotaCentavos = null;
        try {
          montoCuotaCentavos = parsearAPesos(valoresRenegociar.cuota.trim());
          if (montoCuotaCentavos <= 0) erroresRenegociar.monto_cuota_centavos = 'La cuota diaria debe ser mayor a $0.00.';
        } catch (err) {
          erroresRenegociar.monto_cuota_centavos = err.message;
        }
        if (Object.keys(erroresRenegociar).length > 0) { renderTodo(); return; }
        try {
          await crearAcuerdo({ cliente_id: id, monto_cuota_centavos: montoCuotaCentavos, vigente_desde: valoresRenegociar.vigente_desde });
          renegociarAbierto = false;
          erroresRenegociar = {};
          valoresRenegociar = {};
          mostrarToast('Cuota renegociada correctamente.', 'exito');
          await renderTodo();
        } catch (err) {
          if (err.code === 'VALIDATION_ERROR' && err.detalle && err.detalle.campo) {
            erroresRenegociar[err.detalle.campo] = err.message;
          } else {
            erroresRenegociar.general = err.message || 'No se pudo renegociar la cuota.';
          }
          renderTodo();
        }
      });
    }

    contenedor.querySelectorAll('[data-accion="abrir-ajuste"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        ajusteMovimientoId = ajusteMovimientoId === btn.dataset.id ? null : btn.dataset.id;
        erroresAjuste = {};
        renderTodo();
      });
    });

    const formAjuste = contenedor.querySelector('[data-form-ajuste]');
    if (formAjuste) {
      calcularSaldo(id).then((saldoActual) => {
        actualizarPreviewAjuste(formAjuste, saldoActual);
        formAjuste.querySelector('[name="monto"]').addEventListener('input', () => actualizarPreviewAjuste(formAjuste, saldoActual));
        formAjuste.querySelectorAll('[name="signo"]').forEach((r) => r.addEventListener('change', () => actualizarPreviewAjuste(formAjuste, saldoActual)));
      });
      formAjuste.addEventListener('submit', async (e) => {
        e.preventDefault();
        const datos = new FormData(formAjuste);
        const montoTexto = (datos.get('monto') || '').trim();
        const signo = datos.get('signo');
        const nota = (datos.get('nota') || '').trim();
        erroresAjuste = {};
        let montoCentavos = null;
        try {
          montoCentavos = parsearAPesos(montoTexto);
          if (montoCentavos <= 0) erroresAjuste.monto = 'El monto debe ser mayor a $0.00.';
        } catch (err) {
          erroresAjuste.monto = err.message;
        }
        if (Object.keys(erroresAjuste).length > 0) { renderTodo(); return; }
        const deltaCentavos = signo === 'aumenta' ? montoCentavos : -montoCentavos;
        try {
          await registrarAjuste({ movimiento_original_id: formAjuste.dataset.formAjuste, delta_centavos: deltaCentavos, nota: nota || undefined });
          ajusteMovimientoId = null;
          erroresAjuste = {};
          mostrarToast('Ajuste registrado correctamente.', 'exito');
          await renderTodo();
        } catch (err) {
          erroresAjuste.general = err.message || 'No se pudo registrar el ajuste.';
          renderTodo();
        }
      });
    }

    const selectFiltro = contenedor.querySelector('#filtro-tipo-historial');
    selectFiltro.addEventListener('change', () => {
      filtroTipo = selectFiltro.value;
      paginaHistorial = 1;
      ajusteMovimientoId = null;
      renderTodo();
    });

    activarPaginador(contenedor.querySelector('#paginador-historial'), (nuevaPagina) => {
      paginaHistorial = nuevaPagina;
      ajusteMovimientoId = null;
      renderTodo();
    });
  }

  await renderTodo();
}

/**
 * Vista imprimible del estado de cuenta (window.print()). El CSS de impresión
 * (@media print) oculta la barra de navegación, el FAB y los botones no
 * imprimibles, dejando solo esta sección limpia.
 * @param {HTMLElement} contenedor
 * @param {{id: string}} opciones
 */
export async function renderEstadoCuentaImprimible(contenedor, { id }) {
  const cliente = await obtenerCliente(id);
  if (!cliente) {
    contenedor.innerHTML = `<section class="pantalla"><p>Cliente no encontrado.</p><a href="#/clientes">Volver</a></section>`;
    return;
  }
  const { movimientos } = await listarMovimientos({ cliente_id: id, tamanioPagina: 5000 });
  const movimientosAsc = [...movimientos].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  const saldoFinal = await calcularSaldo(id);
  const periodo = movimientosAsc.length
    ? `${formatearFechaCorta(movimientosAsc[0].fecha)} — ${formatearFechaCorta(movimientosAsc[movimientosAsc.length - 1].fecha)}`
    : 'Sin movimientos';

  contenedor.innerHTML = `
    <section class="pantalla hoja-imprimible">
      <div class="no-imprimir acciones-impresion">
        <a href="#/clientes/${encodeURIComponent(id)}" class="btn btn-secundario">Volver al detalle</a>
        <button type="button" class="btn btn-primario" id="btn-imprimir">Imprimir</button>
      </div>
      <h1>Estado de cuenta</h1>
      <p><strong>${escapeHtml(cliente.nombre)}</strong></p>
      <p>Teléfono: ${cliente.telefono ? escapeHtml(cliente.telefono) : '—'}</p>
      <p>Período: ${escapeHtml(periodo)}</p>
      ${movimientosAsc.length === 0 ? estadoVacio('Este cliente todavía no tiene movimientos registrados.') : `
        <table class="tabla tabla-imprimible">
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th>Monto</th></tr></thead>
          <tbody>
            ${movimientosAsc.map((m) => {
              const info = textoMontoMovimiento(m);
              const detalle = m.tipo === 'CARGO' ? (SERVICIO_LABEL[m.servicio] || m.servicio || '') : (m.nota || '');
              return `<tr>
                <td>${escapeHtml(formatearFechaCorta(m.fecha))}</td>
                <td>${escapeHtml(m.tipo)}</td>
                <td>${escapeHtml(detalle)}</td>
                <td>${info.texto}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      `}
      <p class="monto-grande">Saldo final: ${montoOGuion(movimientosAsc.length ? saldoFinal : null)}</p>
    </section>
  `;

  const btnImprimir = contenedor.querySelector('#btn-imprimir');
  if (btnImprimir) btnImprimir.addEventListener('click', () => window.print());
}
