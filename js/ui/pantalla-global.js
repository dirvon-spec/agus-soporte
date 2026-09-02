// Pantalla "Global" (reemplaza "Resumen") — contrato vigente §2.10/§2.14
// (PLAN-MVP.md): el mes del negocio POR FECHA (complemento de Clientes, que
// es por persona). Navegación de mes + 3 totales a color + calendario
// compacto con SOLO totales por día (verde arriba/rojo abajo, sin conceptos)
// + desglose del día tocado (cada movimiento con cliente, concepto si es
// cargo, y monto — navega al cliente) + Ajustes/Respaldo (import vive acá) +
// Historia de archivados. SIN tabla por cliente (esa vive en Clientes). §2.14
// retira el banner/aviso ámbar de recordatorio de respaldo (sustituido por
// el acceso directo de Clientes) — el import de respaldo se mantiene igual.

import {
  obtenerCalendarioGlobalMovimientos, listarClientesArchivados, listarClientesAgrupados,
  exportarRespaldo, importarRespaldo, estaSoloLectura, listarMovimientos, esModoDemo,
} from '../db.js';
import { hoy } from '../utils/date.js';
import {
  microcopy, estadoVacio, montoOGuion, claseSaldo, formatearMesAnio, formatearFechaLegible, formatearFechaCorta,
  escapeHtml, mostrarToast, errorGeneral, bolitaHtml, Iconos,
  abrirSheetCorregirMonto, eliminarMovimientoConDeshacer, abrirSheetSeleccionarCliente,
  bannerModoDemoHtml, wireBannerModoDemo, abrirSheetIniciarModoReal,
  calcularBalanceGeneral,
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

// Bloqueante de producción: el respaldo es responsabilidad del gestor —
// nada se sube a ningún servidor. Con datos reales (no de ejemplo) esto
// importa más que nunca: si se pierde el dispositivo sin haber exportado,
// se pierde la única copia del negocio.
const MICROCOPY_AJUSTES_RESPALDO = `Exportar/importar un archivo .sqlite es la única forma de mover tus datos
  entre dispositivos o de tener un respaldo fuera del navegador — <strong>es tu responsabilidad
  hacerlo seguido</strong>, nada se guarda en ningún servidor. Con clientes y movimientos reales
  (no de ejemplo), esto importa más que nunca: si perdés el dispositivo sin haber exportado, no hay
  forma de recuperar esa información.`;

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

/**
 * §2.11: `obtenerCalendarioGlobalMovimientos` (agregado entre TODOS los
 * clientes) no trae el `id` de cada movimiento — hace falta para ✎/🗑. Se
 * completa acá, del lado de la UI, cruzando contra `listarMovimientos` (que
 * sí trae `id`) UNA vez por cada cliente distinto que aparece en el desglose
 * del día (nunca más de un puñado de clientes por día) — no es un N+1 sobre
 * toda la base, solo sobre la población ya angosta de ese día puntual.
 */
async function enriquecerMovimientosConId(fecha, movimientos) {
  const porCliente = new Map();
  movimientos.forEach((m) => {
    if (!porCliente.has(m.cliente_id)) porCliente.set(m.cliente_id, []);
    porCliente.get(m.cliente_id).push(m);
  });
  const resultado = [];
  for (const [clienteId, lista] of porCliente.entries()) {
    const { movimientos: filasReales } = await listarMovimientos({ cliente_id: clienteId, desde: fecha, hasta: fecha, tamanioPagina: 50 });
    const disponibles = [...filasReales];
    for (const m of lista) {
      const idx = disponibles.findIndex((fila) =>
        fila.tipo === m.tipo && fila.monto_centavos === m.montoCentavos &&
        (fila.servicio || null) === (m.concepto || null) && (fila.referencia || null) === (m.referencia || null)
      );
      if (idx >= 0) {
        resultado.push({ ...m, id: disponibles[idx].id });
        disponibles.splice(idx, 1);
      } else {
        resultado.push({ ...m, id: null });
      }
    }
  }
  return resultado;
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

  // §2.12: registros a futuro (adelantos) — un día futuro sin movimientos
  // queda "limpio" igual que siempre (ahora tocable, para capturar); un día
  // futuro CON movimientos (adelanto ya asentado) suma la clase compartida
  // .celda-futura (mismo color semántico, atenuado + borde punteado —
  // "pactado, aún no ocurre").
  function claseCeldaGlobal(diaInfo) {
    if (!diaInfo || (diaInfo.abonosCentavos === 0 && diaInfo.cargosCentavos === 0)) return 'global-celda-limpia';
    return 'global-celda-con-movimientos';
  }

  async function renderTodo() {
    const hoyStr = hoy();
    const { primerDia, ultimoDiaNum } = primerYUltimoDiaDeMes(mesVisible);
    // §2.14 (fix de unificación): "Balance general" se calcula EXACTO igual
    // que en Clientes — mismo helper compartido sobre los mismos grupos de
    // listarClientesAgrupados() SIN fecha (una llamada extra, aceptable) —
    // para que las dos pantallas nunca vuelvan a divergir (hallazgo de
    // Agustín: "el Global no me da"). Ya NO se usa
    // totalesMes.carteraPendienteCentavos para esta tarjeta (esa es la
    // fórmula vieja de resumenMensual: solo saldos positivos, incluye
    // dados de baja, acotada al mes — una métrica distinta a propósito,
    // que ahora sabemos confundía al gestor).
    const [{ dias, totalesMes }, archivados, { grupos: gruposBalance }] = await Promise.all([
      obtenerCalendarioGlobalMovimientos(mesVisible),
      listarClientesArchivados(),
      listarClientesAgrupados({}),
    ]);
    const balanceGeneralCentavos = calcularBalanceGeneral(gruposBalance);

    const primerDiaSemana = diaSemanaLunes(primerDia);
    const totalCeldas = primerDiaSemana + ultimoDiaNum;
    const celdasFinales = Math.ceil(totalCeldas / 7) * 7;

    let infoDiaSel = diaSeleccionado ? dias.get(diaSeleccionado) : null;
    if (infoDiaSel && infoDiaSel.movimientos.length > 0) {
      infoDiaSel = { ...infoDiaSel, movimientos: await enriquecerMovimientosConId(diaSeleccionado, infoDiaSel.movimientos) };
    }

    contenedor.innerHTML = `
      <section class="pantalla pantalla-global" data-pantalla="global">
        ${bannerModoDemoHtml()}
        ${microcopy('¿Para qué sirve esta pantalla?', MICROCOPY)}
        <h1>${Iconos.globo()} Global</h1>

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
            <span class="tarjeta-resumen-etiqueta">Balance general</span>
            <span class="tarjeta-resumen-monto ${claseSaldo(balanceGeneralCentavos)}">${montoOGuion(balanceGeneralCentavos)}</span>
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
                const tieneMovimientos = !!(diaInfo && (diaInfo.abonosCentavos > 0 || diaInfo.cargosCentavos > 0));
                const clase = `${claseCeldaGlobal(diaInfo)} ${esFutura && tieneMovimientos ? 'celda-futura' : ''}`;
                return `<button type="button" class="mes-celda global-celda ${clase} ${diaSeleccionado === fechaDia ? 'global-celda-seleccionada' : ''}" data-fecha="${fechaDia}">
                  <span class="mes-celda-numero">${numeroDia}</span>
                  ${diaInfo && diaInfo.abonosCentavos > 0 ? `<span class="global-dato-abono">+${montoOGuion(diaInfo.abonosCentavos)}</span>` : ''}
                  ${diaInfo && diaInfo.cargosCentavos > 0 ? `<span class="global-dato-cargo">+${montoOGuion(diaInfo.cargosCentavos)}</span>` : ''}
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
                  const esAjuste = m.tipo === 'AJUSTE';
                  return `
                  <li class="lista-item fila-desglose-dia" data-cliente-id="${escapeHtml(m.cliente_id)}" ${m.id ? `data-movimiento-id="${escapeHtml(m.id)}" data-tipo="${escapeHtml(m.tipo)}" data-monto-centavos="${Math.abs(m.montoCentavos)}"` : ''}>
                    <span class="fila-desglose-cliente">${escapeHtml(m.cliente_nombre)}</span>
                    <span class="fila-desglose-detalle">${m.tipo === 'CARGO' ? escapeHtml(m.concepto || 'Cargo') : m.tipo === 'AJUSTE' ? 'Ajuste' : 'Abono'}</span>
                    <span class="${clase}">${signo} ${montoOGuion(Math.abs(m.montoCentavos))}</span>
                    ${!esAjuste && m.id ? `
                      <span class="fila-movimiento-acciones">
                        <button type="button" class="btn-icono btn-icono-chico" data-accion="corregir-movimiento" aria-label="Corregir monto">${Iconos.lapiz()}</button>
                        <button type="button" class="btn-icono btn-icono-chico" data-accion="eliminar-movimiento" aria-label="Eliminar movimiento">${Iconos.papelera()}</button>
                      </span>` : ''}
                  </li>`;
                }).join('')}</ul>`
            }
            <button type="button" class="btn btn-secundario btn-ancho" id="btn-agregar-movimiento-dia" ${soloLectura ? 'disabled title="Modo solo lectura"' : ''}>${Iconos.mas()} Agregar movimiento en este día</button>
          </div>` : ''}

        <details class="panel-colapsable panel-ajustes" open>
          <summary>Ajustes / Respaldo</summary>
          ${esModoDemo() ? `
            <div class="zona-modo-real">
              <button type="button" class="btn btn-peligro btn-ancho" id="btn-empezar-modo-real" ${soloLectura ? 'disabled title="Modo solo lectura"' : ''}>Empezar a trabajar con mis datos reales</button>
              <p class="texto-secundario">Borra los clientes y movimientos de EJEMPLO y deja la app lista para tus datos reales. Es definitivo.</p>
            </div>` : ''}
          <p id="estado-persistencia" class="estado-persistencia"></p>
          <p class="texto-secundario">${MICROCOPY_AJUSTES_RESPALDO}</p>
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
    wireBannerModoDemo(contenedor);

    const btnEmpezarModoReal = contenedor.querySelector('#btn-empezar-modo-real');
    if (btnEmpezarModoReal) btnEmpezarModoReal.addEventListener('click', () => abrirSheetIniciarModoReal());

    const btnAgregarMovimiento = contenedor.querySelector('#btn-agregar-movimiento-dia');
    if (btnAgregarMovimiento) {
      btnAgregarMovimiento.addEventListener('click', () => {
        abrirSheetSeleccionarCliente({ fecha: diaSeleccionado, onGuardado: renderTodo });
      });
    }

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

    contenedor.querySelectorAll('.global-celda[data-fecha]').forEach((btn) => {
      btn.addEventListener('click', () => {
        diaSeleccionado = diaSeleccionado === btn.dataset.fecha ? null : btn.dataset.fecha;
        renderTodo();
      });
    });

    contenedor.querySelectorAll('.fila-desglose-dia[data-cliente-id]').forEach((li) => {
      li.addEventListener('click', (e) => {
        if (e.target.closest('[data-accion]')) return; // ✎/🗑 no navegan al cliente
        window.location.hash = `#/clientes/${encodeURIComponent(li.dataset.clienteId)}`;
      });
      const idMovimiento = li.dataset.movimientoId;
      if (!idMovimiento) return;
      const btnCorregir = li.querySelector('[data-accion="corregir-movimiento"]');
      if (btnCorregir) {
        btnCorregir.addEventListener('click', (e) => {
          e.stopPropagation();
          abrirSheetCorregirMonto({
            movimiento: { id: idMovimiento, tipo: li.dataset.tipo, monto_centavos: Number(li.dataset.montoCentavos) },
            onGuardado: renderTodo,
          });
        });
      }
      const btnEliminar = li.querySelector('[data-accion="eliminar-movimiento"]');
      if (btnEliminar) {
        btnEliminar.addEventListener('click', async (e) => {
          e.stopPropagation();
          const tipoTexto = li.dataset.tipo === 'CARGO' ? 'cargo' : 'abono';
          const montoTexto = montoOGuion(Number(li.dataset.montoCentavos));
          const fechaTexto = formatearFechaCorta(diaSeleccionado);
          await eliminarMovimientoConDeshacer({
            id: idMovimiento,
            mensajeConfirmacion: `¿Eliminar el ${tipoTexto} de ${montoTexto} del ${fechaTexto}?`,
            onGuardado: renderTodo,
          });
        });
      }
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
