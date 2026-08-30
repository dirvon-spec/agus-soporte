// Pantalla "Persona" (antes "Detalle de cliente") — contrato vigente §2.9
// (PLAN-MVP.md): encabezado compacto, tarjeta +Abonos/+Cargos/Saldo, y un
// calendario mensual completo (semana-lunes) como protagonista — esta
// pantalla ES el reporte que el gestor manda por pantallazo. Debe caber
// completa (tarjeta + mes entero) en un viewport de teléfono, sin scroll.
//
// SIN lista de movimientos permanente, SIN WhatsApp, SIN cuotas/frecuencia.
// El estado de cuenta imprimible se conserva (es gratis mantenerlo) pero sin
// botón visible en esta pantalla — se llega solo por URL directa.

import { obtenerCliente, calcularSaldo, listarCategorias, listarMovimientos, obtenerCalendarioMovimientos } from '../db.js';
import { hoy } from '../utils/date.js';
import {
  microcopy, estadoVacio, montoOGuion, montoCortoOGuion, claseSaldo,
  formatearFechaCorta, formatearMesAnio, escapeHtml, bolitaHtml, abrirPanelRapido, Iconos,
} from './componentes.js';

const MICROCOPY_PERSONA = `
  <p>Este calendario es el reporte que le podés mandar a tu cliente por
  pantallazo: muestra, día por día, lo que abonó (verde) y lo que le
  cargaste (rojo), con el concepto. Los cobros son como los acuerdes con
  cada quien — no hay cuotas fijas.</p>
  <p>Tocá <strong>+Abonos</strong> o <strong>+Cargos</strong> para registrar
  un movimiento. Tocá cualquier día del calendario para ver el detalle
  completo de ese día.</p>
`;

const DIAS_SEMANA_LUNES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const CLAVE_PREF_SALDO_DIARIO = 'agus-mostrar-saldo-diario';

function leerPreferenciaSaldoDiario() {
  try {
    const v = localStorage.getItem(CLAVE_PREF_SALDO_DIARIO);
    return v === null ? true : v === '1';
  } catch (e) {
    return true;
  }
}

function guardarPreferenciaSaldoDiario(valor) {
  try {
    localStorage.setItem(CLAVE_PREF_SALDO_DIARIO, valor ? '1' : '0');
  } catch (e) {
    // localStorage puede fallar (modo privado, cuota llena, etc.) — es solo
    // una preferencia de dispositivo, no rompe la pantalla si no se guarda.
  }
}

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

/** 0=lunes..6=domingo, a partir de 'YYYY-MM-DD' (Date.getDay() es 0=domingo). */
function diaSemanaLunes(fechaIso) {
  const [anio, mes, dia] = fechaIso.split('-').map(Number);
  const d = new Date(anio, mes - 1, dia, 12, 0, 0);
  return (d.getDay() + 6) % 7;
}

function claseColorCelda(diaInfo) {
  const hayAbono = diaInfo.abonosCentavos > 0;
  const hayCargo = diaInfo.cargosCentavos > 0;
  if (hayAbono && hayCargo) return 'mes-celda-mixto';
  if (hayAbono) return 'mes-celda-verde';
  if (hayCargo) return 'mes-celda-rojo';
  return 'mes-celda-neutro';
}

function lineasCelda(diaInfo) {
  const lineas = [];
  if (diaInfo.abonosCentavos > 0) lineas.push(`<span class="mes-dato-abono">+${montoCortoOGuion(diaInfo.abonosCentavos)}</span>`);
  if (diaInfo.cargosCentavos > 0) {
    const cargos = diaInfo.movimientos.filter((m) => m.tipo === 'CARGO');
    const etiqueta = cargos.length === 1 ? cargos[0].concepto : `${cargos.length} cargos`;
    lineas.push(`<span class="mes-dato-cargo">${escapeHtml(etiqueta)} ${montoCortoOGuion(diaInfo.cargosCentavos)}</span>`);
  }
  return lineas.join('');
}

/**
 * @param {HTMLElement} contenedor
 * @param {{id: string}} opciones
 */
export async function renderPantallaClienteDetalle(contenedor, { id }) {
  let mesVisible = hoy().slice(0, 7);
  let fechaSeleccionada = null;
  let mostrarSaldoDiario = leerPreferenciaSaldoDiario();

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

    const categorias = await listarCategorias();
    const categoria = cliente.categoria_id ? categorias.find((c) => c.id === cliente.categoria_id) : null;

    const saldoTotal = await calcularSaldo(id);
    const { total: totalMovimientos } = await listarMovimientos({ cliente_id: id, pagina: 1, tamanioPagina: 1 });
    const sinMovimientos = totalMovimientos === 0;

    const { primerDia, ultimoDiaNum } = primerYUltimoDiaDeMes(mesVisible);
    const { dias } = await obtenerCalendarioMovimientos(id, mesVisible);

    let abonosMesCentavos = 0;
    let cargosMesCentavos = 0;
    for (const diaInfo of dias.values()) {
      abonosMesCentavos += diaInfo.abonosCentavos;
      cargosMesCentavos += diaInfo.cargosCentavos;
    }

    const primerDiaSemana = diaSemanaLunes(primerDia);
    const totalCeldas = primerDiaSemana + ultimoDiaNum;
    const celdasFinales = Math.ceil(totalCeldas / 7) * 7;

    const infoDiaSeleccionado = fechaSeleccionada ? dias.get(fechaSeleccionada) : null;

    contenedor.innerHTML = `
      <section class="pantalla pantalla-persona" data-pantalla="persona">
        ${microcopy('¿Para qué sirve esta pantalla?', MICROCOPY_PERSONA)}

        <header class="encabezado-persona">
          <a href="#/clientes" class="btn-icono" aria-label="Volver a Clientes">${Iconos.chevronIzquierda()}</a>
          ${bolitaHtml(categoria ? categoria.color : null, 'bolita-grande')}
          <h1 class="encabezado-persona-nombre">${escapeHtml(cliente.nombre)}</h1>
        </header>

        <div class="tarjeta-persona">
          <div class="tarjeta-persona-botones">
            <button type="button" class="btn-dato-grande" id="btn-tarjeta-abono">
              <span>+Abonos</span><strong>${montoOGuion(abonosMesCentavos)}</strong>
            </button>
            <button type="button" class="btn-dato-grande" id="btn-tarjeta-cargo">
              <span>+Cargos</span><strong>${montoOGuion(cargosMesCentavos)}</strong>
            </button>
          </div>
          <div class="tarjeta-persona-saldo">
            <span class="etiqueta-saldo">Saldo total</span>
            <span class="monto-grande ${sinMovimientos ? '' : claseSaldo(saldoTotal)}">${montoOGuion(sinMovimientos ? null : saldoTotal)}</span>
          </div>
        </div>

        <div class="calendario-mensual-wrap">
          <div class="calendario-nav">
            <button type="button" class="btn-icono" id="btn-mes-anterior" aria-label="Mes anterior">${Iconos.chevronIzquierda()}</button>
            <span class="calendario-mes-titulo">${escapeHtml(formatearMesAnio(mesVisible))}</span>
            <button type="button" class="btn-icono" id="btn-mes-siguiente" aria-label="Mes siguiente">${Iconos.chevronDerecha()}</button>
          </div>

          <div class="mes-grilla-wrap">
            <div class="mes-grilla mes-grilla-encabezado">
              ${DIAS_SEMANA_LUNES.map((d) => `<div class="mes-encabezado-dia">${d}</div>`).join('')}
            </div>
            <div class="mes-grilla">
              ${Array.from({ length: primerDiaSemana }, () => '<div class="mes-celda mes-celda-vacia"></div>').join('')}
              ${Array.from({ length: ultimoDiaNum }, (_, i) => {
                const numeroDia = i + 1;
                const fechaDia = `${mesVisible}-${String(numeroDia).padStart(2, '0')}`;
                const diaInfo = dias.get(fechaDia);
                return `<button type="button" class="mes-celda ${claseColorCelda(diaInfo)}" data-fecha="${fechaDia}">
                  <span class="mes-celda-numero">${numeroDia}</span>
                  <span class="mes-celda-datos">${lineasCelda(diaInfo)}</span>
                  ${mostrarSaldoDiario ? `<span class="mes-celda-saldo">= ${montoCortoOGuion(diaInfo.saldoAcumuladoCentavos)}</span>` : ''}
                </button>`;
              }).join('')}
              ${Array.from({ length: celdasFinales - totalCeldas }, () => '<div class="mes-celda mes-celda-vacia"></div>').join('')}
            </div>
          </div>

          <label class="switch-fila">
            <span>Saldo diario en el calendario</span>
            <span class="switch">
              <input type="checkbox" id="switch-saldo-diario" ${mostrarSaldoDiario ? 'checked' : ''} />
              <span class="switch-riel"></span>
            </span>
          </label>
        </div>

        ${fechaSeleccionada ? `
          <div class="popover-overlay" id="popover-dia-overlay">
            <div class="popover-dia" role="dialog" aria-modal="true">
              <div class="popover-dia-header">
                <strong>${escapeHtml(formatearFechaCorta(fechaSeleccionada))}</strong>
                <button type="button" class="btn-icono" id="btn-cerrar-popover" aria-label="Cerrar">${Iconos.cruz()}</button>
              </div>
              ${!infoDiaSeleccionado || infoDiaSeleccionado.movimientos.length === 0
                ? estadoVacio('Sin movimientos ese día.')
                : `<ul class="lista lista-compacta">${infoDiaSeleccionado.movimientos.map((m) => `
                    <li class="lista-item">
                      <span>${m.tipo === 'CARGO' ? escapeHtml(m.concepto || 'Cargo') : 'Abono'}${m.referencia ? ` · ${escapeHtml(m.referencia)}` : ''}</span>
                      <span class="${m.tipo === 'CARGO' ? 'monto-negativo' : 'monto-positivo'}">${m.tipo === 'CARGO' ? '+' : '−'} ${montoOGuion(m.montoCentavos)}</span>
                    </li>`).join('')}</ul>`
              }
              <p class="popover-dia-saldo">Saldo a esa fecha: <strong>${montoOGuion(infoDiaSeleccionado ? infoDiaSeleccionado.saldoAcumuladoCentavos : null)}</strong></p>
            </div>
          </div>` : ''}
      </section>
    `;

    wireEvents(cliente);
  }

  function wireEvents(cliente) {
    contenedor.querySelector('#btn-tarjeta-abono').addEventListener('click', () => {
      abrirPanelRapido({ tipo: 'ABONO', clienteId: id, clienteNombre: cliente.nombre, onGuardado: renderTodo });
    });
    contenedor.querySelector('#btn-tarjeta-cargo').addEventListener('click', () => {
      abrirPanelRapido({ tipo: 'CARGO', clienteId: id, clienteNombre: cliente.nombre, onGuardado: renderTodo });
    });

    contenedor.querySelector('#btn-mes-anterior').addEventListener('click', () => {
      mesVisible = mesAnterior(mesVisible);
      fechaSeleccionada = null;
      renderTodo();
    });
    contenedor.querySelector('#btn-mes-siguiente').addEventListener('click', () => {
      mesVisible = mesSiguiente(mesVisible);
      fechaSeleccionada = null;
      renderTodo();
    });

    contenedor.querySelectorAll('.mes-celda[data-fecha]').forEach((btn) => {
      btn.addEventListener('click', () => {
        fechaSeleccionada = fechaSeleccionada === btn.dataset.fecha ? null : btn.dataset.fecha;
        renderTodo();
      });
    });

    const overlay = contenedor.querySelector('#popover-dia-overlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { fechaSeleccionada = null; renderTodo(); } });
      contenedor.querySelector('#btn-cerrar-popover').addEventListener('click', () => { fechaSeleccionada = null; renderTodo(); });
    }

    contenedor.querySelector('#switch-saldo-diario').addEventListener('change', (e) => {
      mostrarSaldoDiario = e.target.checked;
      guardarPreferenciaSaldoDiario(mostrarSaldoDiario);
      renderTodo();
    });
  }

  await renderTodo();
}

/**
 * Vista imprimible del estado de cuenta (window.print()). Sin botón visible
 * en la pantalla Persona (§2.9 la retira de la UI principal) pero conservada
 * — es gratis mantenerla — y accesible por URL directa
 * (#/clientes/:id/imprimir). El CSS de impresión (@media print) oculta la
 * barra de navegación y los botones no imprimibles.
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
        <a href="#/clientes/${encodeURIComponent(id)}" class="btn btn-secundario">Volver</a>
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
              const detalle = m.tipo === 'CARGO' ? (m.servicio || '') : (m.nota || '');
              const signo = m.tipo === 'CARGO' ? '+' : m.tipo === 'ABONO' ? '−' : (m.monto_centavos >= 0 ? '+' : '−');
              return `<tr>
                <td>${escapeHtml(formatearFechaCorta(m.fecha))}</td>
                <td>${escapeHtml(m.tipo)}</td>
                <td>${escapeHtml(detalle)}</td>
                <td>${signo} ${montoOGuion(Math.abs(m.monto_centavos))}</td>
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
