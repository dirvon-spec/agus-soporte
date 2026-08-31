// Pantalla "Persona" (antes "Detalle de cliente") — contrato vigente §2.10
// (PLAN-MVP.md, iteración v3 "Excel"): encabezado compacto con ✎ Editar,
// tarjeta +Abonos/+Cargos/Saldo, calendario mensual completo (semana-lunes,
// celdas más altas con concepto y monto en líneas separadas) — esta pantalla
// ES el reporte que el gestor manda por pantallazo (tarjeta + mes). Debajo
// del calendario: lista completa de movimientos del mes visible. Ya no se
// exige que quepa sin scroll — el pantallazo sigue siendo tarjeta+calendario,
// el resto se accede con scroll natural.
//
// SIN WhatsApp, SIN cuotas/frecuencia. El estado de cuenta imprimible se
// conserva (es gratis mantenerlo) pero sin botón visible en esta pantalla —
// se llega solo por URL directa.

import { obtenerCliente, calcularSaldo, listarCategorias, listarMovimientos, obtenerCalendarioMovimientos, actualizarCliente, borrarClienteLogico } from '../db.js';
import { hoy, esFutura } from '../utils/date.js';
import {
  microcopy, estadoVacio, montoOGuion, montoCortoOGuion, claseSaldo,
  formatearFechaCorta, formatearMesAnio, escapeHtml, bolitaHtml, abrirPanelRapido, Iconos,
  abrirSheet, cerrarSheet, mostrarToast, errorCampo, errorGeneral,
  abrirSheetCorregirMonto, eliminarMovimientoConDeshacer,
} from './componentes.js';

const MICROCOPY_PERSONA = `
  <p>Este calendario es el reporte que le podés mandar a tu cliente por
  pantallazo: muestra, día por día, lo que abonó (verde) y lo que le
  cargaste (rojo), con el concepto. Los cobros son como los acuerdes con
  cada quien — no hay cuotas fijas.</p>
  <p>Tocá <strong>+Abonos</strong> o <strong>+Cargos</strong> para registrar
  un movimiento, o <strong>✎ Editar</strong> para cambiar sus datos o
  archivarlo. Tocá cualquier día del calendario para ver el detalle completo
  de ese día; debajo tenés la lista completa de movimientos del mes.</p>
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
    // §2.10: celdas más altas — concepto en su PROPIA línea, monto en otra.
    const cargos = diaInfo.movimientos.filter((m) => m.tipo === 'CARGO');
    const etiqueta = cargos.length === 1 ? cargos[0].concepto : `${cargos.length} cargos`;
    lineas.push(`<span class="mes-dato-cargo-concepto">${escapeHtml(etiqueta)}</span>`);
    lineas.push(`<span class="mes-dato-cargo-monto">${montoCortoOGuion(diaInfo.cargosCentavos)}</span>`);
  }
  return lineas.join('');
}

/**
 * Lista completa de movimientos del mes visible, para debajo del calendario
 * (§2.10/§2.11): fecha corta, tipo/concepto, monto a color, y — para
 * CARGO/ABONO vivos — ✎ Corregir / 🗑 Eliminar. Se arma a partir de
 * `listarMovimientos` (filas crudas CON id, a diferencia del Map de
 * `obtenerCalendarioMovimientos` que usa el calendario, que no trae id). Los
 * AJUSTE históricos se muestran sin acciones (§2.11: el mecanismo AJUSTE
 * queda deprecated en la UI, pero el dato histórico se sigue mostrando bien).
 * Ya vienen ordenados DESC por fecha/created_at desde la propia query.
 */
function listaMovimientosMesHtml(movimientos) {
  if (movimientos.length === 0) return estadoVacio('Sin movimientos este mes.');
  return `<ul class="lista lista-movimientos-mes">
    ${movimientos.map((m) => {
      const esAjuste = m.tipo === 'AJUSTE';
      const signo = m.tipo === 'CARGO' ? '+' : m.tipo === 'ABONO' ? '−' : (m.monto_centavos >= 0 ? '+' : '−');
      const clase = m.tipo === 'CARGO' ? 'monto-negativo' : m.tipo === 'ABONO' ? 'monto-positivo' : '';
      const detalle = m.tipo === 'CARGO' ? (m.servicio || 'Cargo') : m.tipo === 'ABONO' ? 'Abono' : 'Ajuste';
      return `
      <li class="lista-item fila-movimiento-mes" data-movimiento-id="${escapeHtml(m.id)}" data-tipo="${escapeHtml(m.tipo)}" data-fecha="${escapeHtml(m.fecha)}" data-monto-centavos="${Math.abs(m.monto_centavos)}">
        <span class="fila-movimiento-fecha">${escapeHtml(formatearFechaCorta(m.fecha))}</span>
        <span class="fila-movimiento-detalle">${escapeHtml(detalle)}${m.referencia ? ` · ${escapeHtml(m.referencia)}` : ''}</span>
        <span class="${clase}">${signo} ${montoOGuion(Math.abs(m.monto_centavos))}</span>
        ${esAjuste ? '' : `
          <span class="fila-movimiento-acciones">
            <button type="button" class="btn-icono btn-icono-chico" data-accion="corregir-movimiento" aria-label="Corregir monto">${Iconos.lapiz()}</button>
            <button type="button" class="btn-icono btn-icono-chico" data-accion="eliminar-movimiento" aria-label="Eliminar movimiento">${Iconos.papelera()}</button>
          </span>`}
      </li>`;
    }).join('')}
  </ul>`;
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

    const { primerDia, ultimoDia, ultimoDiaNum } = primerYUltimoDiaDeMes(mesVisible);
    const { dias } = await obtenerCalendarioMovimientos(id, mesVisible);
    // §2.11: la lista de movimientos (con ✎/🗑) necesita el `id` de cada fila,
    // que el Map de obtenerCalendarioMovimientos no trae — se arma aparte con
    // listarMovimientos (mismo rango de fechas, sin queries redundantes de más).
    const { movimientos: movimientosDelMes } = await listarMovimientos({ cliente_id: id, desde: primerDia, hasta: ultimoDia, tamanioPagina: 5000 });

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
          <button type="button" class="btn-icono" id="btn-editar-persona" aria-label="Editar cliente">${Iconos.lapiz()} Editar</button>
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
                const futura = esFutura(fechaDia);
                return `<button type="button" class="mes-celda ${claseColorCelda(diaInfo)}" data-fecha="${fechaDia}" ${futura ? 'disabled' : ''}>
                  <span class="mes-celda-numero">${numeroDia}</span>
                  <span class="mes-celda-datos">${futura ? '' : lineasCelda(diaInfo)}</span>
                  ${mostrarSaldoDiario && !futura ? `<span class="mes-celda-saldo">= ${montoCortoOGuion(diaInfo.saldoAcumuladoCentavos)}</span>` : ''}
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

        <h2 class="titulo-seccion">Movimientos de ${escapeHtml(formatearMesAnio(mesVisible))}</h2>
        <div id="lista-movimientos-mes">${listaMovimientosMesHtml(movimientosDelMes)}</div>

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
              <div class="popover-dia-acciones">
                <button type="button" class="btn btn-secundario" id="btn-popover-abono">+ Abono</button>
                <button type="button" class="btn btn-secundario" id="btn-popover-cargo">+ Cargo</button>
              </div>
            </div>
          </div>` : ''}
      </section>
    `;

    wireEvents(cliente, categorias, movimientosDelMes);
  }

  function abrirSheetEditarCliente(cliente, categorias) {
    abrirSheet((host) => {
      let categoriaSeleccionada = cliente.categoria_id || null;
      let error = {};
      let valorNombre = cliente.nombre;
      let valorTelefono = cliente.telefono || '';
      let valorNotas = cliente.notas || '';

      function capturarValoresActuales() {
        const nombreEl = host.querySelector('#ec-nombre');
        if (nombreEl) valorNombre = nombreEl.value;
        const telefonoEl = host.querySelector('#ec-telefono');
        if (telefonoEl) valorTelefono = telefonoEl.value;
        const notasEl = host.querySelector('#ec-notas');
        if (notasEl) valorNotas = notasEl.value;
      }

      function render() {
        capturarValoresActuales();
        host.innerHTML = `
          <form id="form-editar-cliente" class="formulario" novalidate>
            <div class="campo">
              <label for="ec-nombre">Nombre</label>
              <input id="ec-nombre" name="nombre" type="text" value="${escapeHtml(valorNombre)}" required autofocus />
              ${errorCampo(error.nombre)}
            </div>
            <div class="campo">
              <label for="ec-telefono">Teléfono (opcional)</label>
              <input id="ec-telefono" name="telefono" type="text" value="${escapeHtml(valorTelefono)}" placeholder="Ej. 5215512340000" />
              ${errorCampo(error.telefono)}
            </div>
            <div class="campo">
              <label>Categoría (opcional)</label>
              <div class="chips-fila">
                <button type="button" class="chip ${categoriaSeleccionada === null ? 'chip-activo' : ''}" data-cat="">Sin categoría</button>
                ${categorias.map((c) => `<button type="button" class="chip ${categoriaSeleccionada === c.id ? 'chip-activo' : ''}" data-cat="${escapeHtml(c.id)}">${bolitaHtml(c.color, 'bolita-chip')}${escapeHtml(c.nombre)}</button>`).join('')}
              </div>
            </div>
            <div class="campo">
              <label for="ec-notas">Notas (opcional)</label>
              <textarea id="ec-notas" name="notas" rows="2">${escapeHtml(valorNotas)}</textarea>
            </div>
            ${errorGeneral(error.general)}
            <div class="acciones-formulario">
              <button type="submit" class="btn btn-primario btn-ancho">Guardar cambios</button>
            </div>
          </form>
          <div class="zona-archivar">
            <h3 class="zona-archivar-titulo">${Iconos.cajaArchivo()} Archivar cliente</h3>
            <p class="texto-secundario">Archivar saca a ${escapeHtml(cliente.nombre)} de la lista de Clientes y de las Σ, pero conserva toda su historia (podés restaurarlo después desde "Archivados", y su historia sigue apareciendo en los meses pasados de Global).</p>
            <button type="button" class="btn btn-peligro btn-ancho" id="btn-archivar-cliente">${Iconos.cajaArchivo()} Archivar cliente</button>
          </div>`;

        host.querySelectorAll('.chip[data-cat]').forEach((chip) => {
          chip.addEventListener('click', () => {
            categoriaSeleccionada = chip.dataset.cat || null;
            render();
          });
        });

        host.querySelector('#form-editar-cliente').addEventListener('submit', async (e) => {
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
            await actualizarCliente(id, {
              nombre: nombreLimpio,
              telefono: telefonoLimpio || null,
              categoria_id: categoriaSeleccionada,
              notas: form.notas.value.trim() || null,
            });
            cerrarSheet();
            mostrarToast('Cliente actualizado.', 'exito');
            await renderTodo();
          } catch (err) {
            if (err.code === 'VALIDATION_ERROR' && err.detalle && err.detalle.campo) error[err.detalle.campo] = err.message;
            else if (err.code === 'CONFLICT') error.nombre = err.message;
            else error.general = err.message || 'No se pudo actualizar el cliente.';
            render();
          }
        });

        host.querySelector('#btn-archivar-cliente').addEventListener('click', async () => {
          const saldoActual = await calcularSaldo(id);
          const mensaje = saldoActual !== 0
            ? `${cliente.nombre} tiene un saldo de ${montoOGuion(saldoActual)}. ¿Archivar de todas formas? Vas a poder restaurarlo después desde "Archivados", con su historia intacta.`
            : `¿Archivar a ${cliente.nombre}? Vas a poder restaurarlo después desde "Archivados".`;
          const ok = window.confirm(mensaje);
          if (!ok) return;
          try {
            await borrarClienteLogico(id, { forzar: true });
            cerrarSheet();
            mostrarToast('Cliente archivado.', 'exito');
            window.location.hash = '#/clientes';
          } catch (err) {
            error.general = err.message || 'No se pudo archivar el cliente.';
            render();
          }
        });
      }
      render();
    }, { titulo: 'Editar cliente' });
  }

  function wireEvents(cliente, categorias, movimientosDelMes) {
    contenedor.querySelector('#btn-editar-persona').addEventListener('click', () => {
      abrirSheetEditarCliente(cliente, categorias);
    });
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

    contenedor.querySelectorAll('.mes-celda[data-fecha]:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', () => {
        fechaSeleccionada = fechaSeleccionada === btn.dataset.fecha ? null : btn.dataset.fecha;
        renderTodo();
      });
    });

    const overlay = contenedor.querySelector('#popover-dia-overlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { fechaSeleccionada = null; renderTodo(); } });
      contenedor.querySelector('#btn-cerrar-popover').addEventListener('click', () => { fechaSeleccionada = null; renderTodo(); });

      // Ajuste aprobado por el dueño: +Abono/+Cargo al pie del popover del
      // día — cierran el popover y abren el panel rápido con el CLIENTE y la
      // FECHA (el día tocado) ya puestos, sin selector de fecha visible.
      const fechaPopover = fechaSeleccionada;
      function cerrarPopoverYAbrirPanel(tipo) {
        // El popover vive en `contenedor` (no en el mecanismo de sheet), así
        // que se saca del DOM al toque para que no quede "stale" debajo del
        // panel rápido si el gestor cancela sin guardar.
        fechaSeleccionada = null;
        overlay.remove();
        abrirPanelRapido({ tipo, clienteId: id, clienteNombre: cliente.nombre, fechaInicial: fechaPopover, onGuardado: renderTodo });
      }
      const btnPopoverAbono = contenedor.querySelector('#btn-popover-abono');
      if (btnPopoverAbono) {
        btnPopoverAbono.addEventListener('click', () => cerrarPopoverYAbrirPanel('ABONO'));
      }
      const btnPopoverCargo = contenedor.querySelector('#btn-popover-cargo');
      if (btnPopoverCargo) {
        btnPopoverCargo.addEventListener('click', () => cerrarPopoverYAbrirPanel('CARGO'));
      }
    }

    contenedor.querySelector('#switch-saldo-diario').addEventListener('change', (e) => {
      mostrarSaldoDiario = e.target.checked;
      guardarPreferenciaSaldoDiario(mostrarSaldoDiario);
      renderTodo();
    });

    // §2.11: ✎ Corregir / 🗑 Eliminar de un movimiento vivo (CARGO/ABONO).
    contenedor.querySelectorAll('[data-movimiento-id]').forEach((li) => {
      const idMovimiento = li.dataset.movimientoId;
      const btnCorregir = li.querySelector('[data-accion="corregir-movimiento"]');
      if (btnCorregir) {
        btnCorregir.addEventListener('click', () => {
          const movimiento = movimientosDelMes.find((m) => m.id === idMovimiento);
          if (!movimiento) return;
          abrirSheetCorregirMonto({ movimiento, onGuardado: renderTodo });
        });
      }
      const btnEliminar = li.querySelector('[data-accion="eliminar-movimiento"]');
      if (btnEliminar) {
        btnEliminar.addEventListener('click', async () => {
          const tipoTexto = li.dataset.tipo === 'CARGO' ? 'cargo' : 'abono';
          const fechaTexto = formatearFechaCorta(li.dataset.fecha);
          const montoTexto = montoOGuion(Number(li.dataset.montoCentavos));
          await eliminarMovimientoConDeshacer({
            id: idMovimiento,
            mensajeConfirmacion: `¿Eliminar el ${tipoTexto} de ${montoTexto} del ${fechaTexto}?`,
            onGuardado: renderTodo,
          });
        });
      }
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
