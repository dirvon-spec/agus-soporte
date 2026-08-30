// Pantalla "Global" (reemplaza "Resumen") — contrato vigente §2.10
// (PLAN-MVP.md, iteración v3 "Excel"): el mes del negocio POR FECHA
// (complemento de Clientes, que es por persona). Navegación de mes + 3
// totales a color + calendario compacto con SOLO totales por día (verde
// arriba/rojo abajo, sin conceptos) + desglose del día tocado (cada
// movimiento con cliente, concepto si es cargo, y monto — navega al
// cliente) + recordatorio de respaldo + Ajustes/Respaldo (igual que antes) +
// Historia de archivados. SIN tabla por cliente (esa vive en Clientes).

import {
  obtenerCalendarioGlobalMovimientos, obtenerUltimoRespaldo, listarClientesArchivados,
  exportarRespaldo, importarRespaldo, estaSoloLectura,
} from '../db.js';
import { hoy } from '../utils/date.js';
import {
  microcopy, estadoVacio, montoOGuion, claseSaldo, formatearMesAnio, formatearFechaLegible,
  escapeHtml, mostrarToast, errorGeneral, bolitaHtml, Iconos,
} from './componentes.js';

const MICROCOPY = `
  <p>Acá ves el mes de tu negocio <strong>por fecha</strong>: cuánto se
  cargó y cuánto se cobró cada día, sumando a todos tus clientes. Para ver
  el detalle de un cliente en particular, andá a la pantalla Clientes (ahí
  vive la suma por categoría).</p>
  <p>Tocá un día del calendario para ver el desglose completo de esa fecha,
  con cada movimiento y a qué cliente pertenece — tocando una fila del
  desglose vas directo a ese cliente.</p>
`;

const DIAS_SEMANA_LUNES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

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
function diaSemanaLunes(fechaIso) {
  const [anio, mes, dia] = fechaIso.split('-').map(Number);
  const d = new Date(anio, mes - 1, dia, 12, 0, 0);
  return (d.getDay() + 6) % 7;
}
function diasEntre(fechaIsoDesde, fechaIsoHasta) {
  const [a1, m1, d1] = fechaIsoDesde.split('-').map(Number);
  const [a2, m2, d2] = fechaIsoHasta.split('-').map(Number);
  const ms = new Date(a2, m2 - 1, d2).getTime() - new Date(a1, m1 - 1, d1).getTime();
  return Math.round(ms / 86400000);
}

/**
 * @param {HTMLElement} contenedor
 * @param {{anioMes?: string}} opciones
 */
export async function renderPantallaGlobal(contenedor, { anioMes } = {}) {
  let mesVisible = anioMes || hoy().slice(0, 7);
  let diaSeleccionado = null;
  const soloLectura = estaSoloLectura();

  async function realizarExportar() {
    try {
      const { blob, nombreArchivo } = await exportarRespaldo();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = nombreArchivo;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      mostrarToast('Respaldo exportado.', 'exito');
      await renderTodo();
    } catch (e) {
      mostrarToast(e.message || 'No se pudo exportar el respaldo.', 'error');
    }
  }

  function claseCeldaGlobal(fecha, diaInfo, hoyStr) {
    if (fecha > hoyStr) return 'global-celda-futura';
    if (!diaInfo || (diaInfo.abonosCentavos === 0 && diaInfo.cargosCentavos === 0)) return 'global-celda-limpia';
    return 'global-celda-con-movimientos';
  }

  async function renderTodo() {
    const hoyStr = hoy();
    const { primerDia, ultimoDiaNum } = primerYUltimoDiaDeMes(mesVisible);
    const [{ dias, totalesMes }, ultimoRespaldoIso, archivados] = await Promise.all([
      obtenerCalendarioGlobalMovimientos(mesVisible),
      obtenerUltimoRespaldo(),
      listarClientesArchivados(),
    ]);

    const diasDesdeRespaldo = ultimoRespaldoIso ? diasEntre(ultimoRespaldoIso.slice(0, 10), hoyStr) : null;
    const mostrarRecordatorio = diasDesdeRespaldo === null || diasDesdeRespaldo > 7;

    const primerDiaSemana = diaSemanaLunes(primerDia);
    const totalCeldas = primerDiaSemana + ultimoDiaNum;
    const celdasFinales = Math.ceil(totalCeldas / 7) * 7;

    const infoDiaSel = diaSeleccionado ? dias.get(diaSeleccionado) : null;

    contenedor.innerHTML = `
      <section class="pantalla pantalla-global" data-pantalla="global">
        ${microcopy('¿Para qué sirve esta pantalla?', MICROCOPY)}
        <h1>${Iconos.globo()} Global</h1>

        ${mostrarRecordatorio ? `
          <div class="aviso-banner aviso-recordatorio-respaldo" role="alert">
            <span>${Iconos.alerta()} ${ultimoRespaldoIso === null ? 'Nunca has exportado un respaldo.' : `Tu último respaldo fue hace ${diasDesdeRespaldo} día(s).`}</span>
            <button type="button" class="btn btn-secundario btn-pequeno" id="btn-exportar-ahora" ${soloLectura ? 'disabled' : ''}>Exportar ahora</button>
          </div>` : ''}

        <div class="campo">
          <label for="selector-mes-global">Mes</label>
          <input id="selector-mes-global" type="month" value="${mesVisible}" max="${hoy().slice(0, 7)}" />
        </div>

        <div class="tarjetas-resumen">
          <div class="tarjeta-resumen">
            <span class="tarjeta-resumen-etiqueta">Abonos</span>
            <span class="tarjeta-resumen-monto monto-positivo">${montoOGuion(totalesMes.abonosCentavos)}</span>
          </div>
          <div class="tarjeta-resumen">
            <span class="tarjeta-resumen-etiqueta">Cargos</span>
            <span class="tarjeta-resumen-monto monto-negativo">${montoOGuion(totalesMes.cargosCentavos)}</span>
          </div>
          <div class="tarjeta-resumen">
            <span class="tarjeta-resumen-etiqueta">Cartera pendiente</span>
            <span class="tarjeta-resumen-monto ${claseSaldo(totalesMes.carteraPendienteCentavos)}">${montoOGuion(totalesMes.carteraPendienteCentavos)}</span>
          </div>
        </div>

        <div class="calendario-mensual-wrap calendario-global-wrap">
          <div class="calendario-nav">
            <button type="button" class="btn-icono" id="btn-mes-anterior-global" aria-label="Mes anterior">${Iconos.chevronIzquierda()}</button>
            <span class="calendario-mes-titulo">${escapeHtml(formatearMesAnio(mesVisible))}</span>
            <button type="button" class="btn-icono" id="btn-mes-siguiente-global" aria-label="Mes siguiente">${Iconos.chevronDerecha()}</button>
          </div>
          <div class="mes-grilla-wrap">
            <div class="mes-grilla mes-grilla-encabezado">
              ${DIAS_SEMANA_LUNES.map((d) => `<div class="mes-encabezado-dia">${d}</div>`).join('')}
            </div>
            <div class="mes-grilla mes-grilla-global">
              ${Array.from({ length: primerDiaSemana }, () => '<div class="mes-celda mes-celda-vacia"></div>').join('')}
              ${Array.from({ length: ultimoDiaNum }, (_, i) => {
                const numeroDia = i + 1;
                const fechaDia = `${mesVisible}-${String(numeroDia).padStart(2, '0')}`;
                const diaInfo = dias.get(fechaDia);
                const esFutura = fechaDia > hoyStr;
                const clase = claseCeldaGlobal(fechaDia, diaInfo, hoyStr);
                return `<button type="button" class="mes-celda global-celda ${clase} ${diaSeleccionado === fechaDia ? 'global-celda-seleccionada' : ''}" data-fecha="${fechaDia}" ${esFutura ? 'disabled' : ''}>
                  <span class="mes-celda-numero">${numeroDia}</span>
                  ${!esFutura && diaInfo && diaInfo.abonosCentavos > 0 ? `<span class="global-dato-abono">+${montoOGuion(diaInfo.abonosCentavos)}</span>` : ''}
                  ${!esFutura && diaInfo && diaInfo.cargosCentavos > 0 ? `<span class="global-dato-cargo">+${montoOGuion(diaInfo.cargosCentavos)}</span>` : ''}
                </button>`;
              }).join('')}
              ${Array.from({ length: celdasFinales - totalCeldas }, () => '<div class="mes-celda mes-celda-vacia"></div>').join('')}
            </div>
          </div>
        </div>

        ${diaSeleccionado ? `
          <h2 class="titulo-seccion">Desglose del ${escapeHtml(formatearFechaLegible(diaSeleccionado))}</h2>
          <div id="desglose-dia">
            ${!infoDiaSel || infoDiaSel.movimientos.length === 0
              ? estadoVacio('Sin movimientos ese día.')
              : `<ul class="lista lista-desglose-dia">${infoDiaSel.movimientos.map((m) => {
                  const signo = m.tipo === 'CARGO' ? '+' : m.tipo === 'ABONO' ? '−' : (m.montoCentavos >= 0 ? '+' : '−');
                  const clase = m.tipo === 'CARGO' ? 'monto-negativo' : m.tipo === 'ABONO' ? 'monto-positivo' : '';
                  return `
                  <li class="lista-item fila-desglose-dia" data-cliente-id="${escapeHtml(m.cliente_id)}">
                    <span class="fila-desglose-cliente">${escapeHtml(m.cliente_nombre)}</span>
                    <span class="fila-desglose-detalle">${m.tipo === 'CARGO' ? escapeHtml(m.concepto || 'Cargo') : m.tipo === 'AJUSTE' ? 'Ajuste' : 'Abono'}</span>
                    <span class="${clase}">${signo} ${montoOGuion(Math.abs(m.montoCentavos))}</span>
                  </li>`;
                }).join('')}</ul>`
            }
          </div>` : ''}

        <details class="panel-colapsable panel-ajustes" open>
          <summary>Ajustes / Respaldo</summary>
          <p id="estado-persistencia" class="estado-persistencia"></p>
          <p class="texto-secundario">Exportar/importar un archivo .sqlite es, en esta demo, la única forma de
            mover tus datos entre dispositivos o de tener un respaldo fuera del navegador.</p>
          <div class="acciones-respaldo">
            <button type="button" class="btn btn-secundario" id="btn-exportar-respaldo">Exportar respaldo</button>
            <label class="btn btn-secundario btn-archivo" ${soloLectura ? 'aria-disabled="true"' : ''}>
              Importar respaldo
              <input type="file" id="input-importar-respaldo" accept=".sqlite,application/x-sqlite3" hidden ${soloLectura ? 'disabled' : ''} />
            </label>
          </div>
          <div id="slot-error-importar"></div>
        </details>

        <details class="panel-colapsable panel-archivados-historia">
          <summary>${Iconos.cajaArchivo()} Historia de archivados (${archivados.length})</summary>
          ${archivados.length === 0 ? estadoVacio('No hay clientes archivados.') : `
            <ul class="lista lista-archivados">
              ${archivados.map((c) => `
                <li class="lista-item fila-archivado">
                  ${bolitaHtml(c.categoria ? c.categoria.color : null)}
                  <span class="fila-archivado-nombre">${escapeHtml(c.nombre)}</span>
                  <span class="fila-excel-monto ${claseSaldo(c.saldo_centavos)}">${montoOGuion(c.saldo_centavos)}</span>
                </li>`).join('')}
            </ul>`}
        </details>
      </section>
    `;

    wireEvents();
    renderAvisoPersistencia();
  }

  async function renderAvisoPersistencia() {
    const el = contenedor.querySelector('#estado-persistencia');
    if (!el) return;
    try {
      if (navigator.storage && navigator.storage.persisted) {
        const persistido = await navigator.storage.persisted();
        el.textContent = persistido
          ? 'Almacenamiento persistente: concedido.'
          : 'Almacenamiento persistente: denegado. El navegador podría liberar espacio si el dispositivo anda justo de memoria; te recomendamos exportar un respaldo seguido.';
        el.classList.toggle('aviso-persistencia-denegada', !persistido);
      } else {
        el.textContent = 'No se pudo determinar el estado de almacenamiento persistente en este navegador.';
      }
    } catch (e) {
      el.textContent = 'No se pudo determinar el estado de almacenamiento persistente en este navegador.';
    }
  }

  function wireEvents() {
    const btnExportarAhora = contenedor.querySelector('#btn-exportar-ahora');
    if (btnExportarAhora) btnExportarAhora.addEventListener('click', realizarExportar);

    contenedor.querySelector('#selector-mes-global').addEventListener('change', (e) => {
      if (e.target.value) window.location.hash = `#/global/${e.target.value}`;
    });

    contenedor.querySelector('#btn-mes-anterior-global').addEventListener('click', () => {
      mesVisible = mesAnterior(mesVisible);
      diaSeleccionado = null;
      renderTodo();
    });
    contenedor.querySelector('#btn-mes-siguiente-global').addEventListener('click', () => {
      mesVisible = mesSiguiente(mesVisible);
      diaSeleccionado = null;
      renderTodo();
    });

    contenedor.querySelectorAll('.global-celda[data-fecha]:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', () => {
        diaSeleccionado = diaSeleccionado === btn.dataset.fecha ? null : btn.dataset.fecha;
        renderTodo();
      });
    });

    contenedor.querySelectorAll('.fila-desglose-dia[data-cliente-id]').forEach((li) => {
      li.addEventListener('click', () => {
        window.location.hash = `#/clientes/${encodeURIComponent(li.dataset.clienteId)}`;
      });
    });

    contenedor.querySelector('#btn-exportar-respaldo').addEventListener('click', realizarExportar);

    const inputImportar = contenedor.querySelector('#input-importar-respaldo');
    inputImportar.addEventListener('change', async () => {
      const slot = contenedor.querySelector('#slot-error-importar');
      slot.innerHTML = '';
      const archivo = inputImportar.files && inputImportar.files[0];
      if (!archivo) return;

      const confirmado = window.confirm('Esto reemplaza todos los datos actuales por los del archivo. ¿Continuar?');
      if (!confirmado) {
        inputImportar.value = '';
        return;
      }

      try {
        const arrayBuffer = await archivo.arrayBuffer();
        await importarRespaldo(arrayBuffer);
        mostrarToast('Respaldo importado. Recargando…', 'exito');
        setTimeout(() => window.location.reload(), 800);
      } catch (e) {
        slot.innerHTML = errorGeneral(e.message || 'El archivo no es un respaldo válido de esta app.');
        inputImportar.value = '';
      }
    });
  }

  await renderTodo();
}
