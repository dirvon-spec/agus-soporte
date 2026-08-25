// Pantalla "Resumen mensual" (2.4-5 del PLAN-MVP.md): totales del mes, tabla
// por cliente ordenable, y sección de Ajustes/Respaldo (export/import con
// confirmación destructiva, aviso de persist() denegado).

import { resumenMensual, exportarRespaldo, importarRespaldo, estaSoloLectura } from '../db.js';
import { hoy } from '../utils/date.js';
import {
  microcopy, estadoVacio, montoOGuion, claseSaldo, formatearMesAnio,
  escapeHtml, mostrarToast, errorGeneral,
} from './componentes.js';

const MICROCOPY = `
  <p>Elegí un mes para ver cuánto se cargó (servicios pagados a nombre de tus
  clientes), cuánto se cobró, y cuánta cartera quedó pendiente a fin de ese
  mes.</p>
  <p>Al final de esta pantalla encontrás la sección de Ajustes, donde podés
  exportar un respaldo de todos tus datos o importar uno anterior.</p>
`;

function claveOrdenValor(fila, columna) {
  if (columna === 'nombre') return fila.nombre.toLowerCase();
  if (columna === 'cargos') return fila.cargos;
  if (columna === 'abonos') return fila.abonos;
  return fila.saldoFinMes;
}

/**
 * @param {HTMLElement} contenedor
 * @param {{anioMes?: string}} opciones
 */
export async function renderPantallaResumen(contenedor, { anioMes } = {}) {
  const mesActual = anioMes || hoy().slice(0, 7);
  let columnaOrden = 'saldoFinMes';
  let direccionOrden = 'desc';
  let errorImport = '';
  const soloLectura = estaSoloLectura();

  const resumen = await resumenMensual(mesActual);
  const hayDatos = resumen.porCliente.some((c) => c.cargos !== 0 || c.abonos !== 0 || c.saldoFinMes !== 0);

  function filasOrdenadas() {
    const filas = [...resumen.porCliente];
    filas.sort((a, b) => {
      const va = claveOrdenValor(a, columnaOrden);
      const vb = claveOrdenValor(b, columnaOrden);
      if (va < vb) return direccionOrden === 'asc' ? -1 : 1;
      if (va > vb) return direccionOrden === 'asc' ? 1 : -1;
      return 0;
    });
    return filas;
  }

  function iconoOrden(columna) {
    if (columnaOrden !== columna) return '';
    return direccionOrden === 'asc' ? ' ▲' : ' ▼';
  }

  function renderTabla() {
    const wrap = contenedor.querySelector('#wrap-tabla-resumen');
    if (!hayDatos) {
      wrap.innerHTML = estadoVacio(`No hay movimientos registrados en ${formatearMesAnio(mesActual)}.`);
      return;
    }
    wrap.innerHTML = `
      <div class="tabla-scroll">
        <table class="tabla">
          <thead>
            <tr>
              <th><button type="button" class="btn-ordenar-columna" data-columna="nombre">Cliente${iconoOrden('nombre')}</button></th>
              <th><button type="button" class="btn-ordenar-columna" data-columna="cargos">Cargos${iconoOrden('cargos')}</button></th>
              <th><button type="button" class="btn-ordenar-columna" data-columna="abonos">Abonos${iconoOrden('abonos')}</button></th>
              <th><button type="button" class="btn-ordenar-columna" data-columna="saldoFinMes">Saldo a fin de mes${iconoOrden('saldoFinMes')}</button></th>
            </tr>
          </thead>
          <tbody>
            ${filasOrdenadas().map((f) => `
              <tr class="${f.dado_de_baja ? 'fila-cliente-baja' : ''}">
                <td><a href="#/clientes/${encodeURIComponent(f.cliente_id)}">${escapeHtml(f.nombre)}</a>${f.dado_de_baja ? ' <span class="texto-cliente-baja">(baja)</span>' : ''}</td>
                <td>${montoOGuion(f.cargos)}</td>
                <td>${montoOGuion(f.abonos)}</td>
                <td class="${claseSaldo(f.saldoFinMes)}">${montoOGuion(f.saldoFinMes)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
    wrap.querySelectorAll('.btn-ordenar-columna').forEach((btn) => {
      btn.addEventListener('click', () => {
        const columna = btn.dataset.columna;
        if (columnaOrden === columna) {
          direccionOrden = direccionOrden === 'asc' ? 'desc' : 'asc';
        } else {
          columnaOrden = columna;
          direccionOrden = columna === 'nombre' ? 'asc' : 'desc';
        }
        renderTabla();
      });
    });
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

  contenedor.innerHTML = `
    <section class="pantalla" data-pantalla="resumen">
      ${microcopy('¿Para qué sirve esta pantalla?', MICROCOPY)}
      <h1>Resumen mensual</h1>
      <div class="campo">
        <label for="selector-mes">Mes</label>
        <input id="selector-mes" type="month" value="${mesActual}" max="${hoy().slice(0, 7)}" />
      </div>

      <div class="tarjetas-resumen">
        <div class="tarjeta-resumen">
          <span class="tarjeta-resumen-etiqueta">Cargos totales</span>
          <span class="tarjeta-resumen-monto">${hayDatos ? montoOGuion(resumen.totalCargosCentavos) : '—'}</span>
        </div>
        <div class="tarjeta-resumen">
          <span class="tarjeta-resumen-etiqueta">Abonos totales</span>
          <span class="tarjeta-resumen-monto">${hayDatos ? montoOGuion(resumen.totalAbonosCentavos) : '—'}</span>
        </div>
        <div class="tarjeta-resumen">
          <span class="tarjeta-resumen-etiqueta">Cartera pendiente</span>
          <span class="tarjeta-resumen-monto">${hayDatos ? montoOGuion(resumen.carteraPendienteCentavos) : '—'}</span>
        </div>
      </div>

      <h2 class="titulo-seccion">Por cliente</h2>
      <div id="wrap-tabla-resumen"></div>

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
    </section>
  `;

  renderTabla();
  renderAvisoPersistencia();

  contenedor.querySelector('#selector-mes').addEventListener('change', (e) => {
    if (e.target.value) window.location.hash = `#/resumen/${e.target.value}`;
  });

  contenedor.querySelector('#btn-exportar-respaldo').addEventListener('click', async () => {
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
    } catch (e) {
      mostrarToast(e.message || 'No se pudo exportar el respaldo.', 'error');
    }
  });

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
