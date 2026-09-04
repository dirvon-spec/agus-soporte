// Pantalla "Clientes" (inicio) — contrato vigente §2.14 (PLAN-MVP.md, ROUND
// 6, retro de Agustín): Clientes es el trabajo del DÍA — encabezado FIJO
// (título+toggle claro/oscuro+engrane, navegador de día, 3 tarjetas de
// resumen —Abonos del día / Cargos del día / Balance general de TODA la
// cartera, este último NO cambia al navegar de día—, sublínea de conteos,
// cabecera de columnas, acceso directo de respaldo) — solo la lista de
// clientes corre debajo. SALDO de cada fila sigue siendo histórico total,
// SIEMPRE en números completos (sin notación compacta — §2.13). Sin buscador
// ni chips de filtro por categoría (B-027/B-028, reversibles); los grupos,
// bolitas, Σ y la gestión de categorías en ⚙ Configuración se mantienen
// intactos. Filas de una sola línea (monto-es-botón), orden manual por
// arrastre, fila Σ por grupo, columna CARGOS colapsable, y sección
// colapsable de clientes archivados.

import {
  listarClientesAgrupados, listarClientesArchivados, restaurarCliente,
  listarCategorias, crearCliente, crearCategoria, actualizarOrdenClientes, estaSoloLectura,
  obtenerUltimoRespaldo,
} from '../db.js';
import { formatearCentavos } from '../utils/money.js';
import { hoy, sumarDias, esFechaIsoValida } from '../utils/date.js';
import {
  estadoVacio, montoOGuion, claseSaldo, escapeHtml,
  mostrarToast, errorCampo, errorGeneral, Iconos, bolitaHtml,
  abrirSheet, cerrarSheet, abrirSheetConfiguracion, abrirPanelRapido,
  activarArrastreOrden, PALETA_COLORES_CATEGORIA,
  bannerModoDemoHtml, wireBannerModoDemo, dispararImportarRespaldo,
  iconoTemaHtml, alternarTema, temaActivo, wireCambioTemaSistema,
  calcularBalanceGeneral, almacenamientoPersistenteDenegado,
  edicionBloqueada, motivoEdicionBloqueada,
  estadoRespaldoUi, ejecutarExportarRespaldoConConfirmacion, suscribirseACambioRespaldo,
} from './componentes.js';

// §2.13: se retira la notación compacta (A-201 queda resuelto de otra forma)
// — SIEMPRE número completo. Red de seguridad anti-A-201: si el texto
// formateado es largo, baja un paso de tamaño (clase .v-chico, ver
// styles.css) ANTES de invadir la columna del nombre, que conserva su
// min-width + elipsis propios.
// R-003 (auditoría): des-suscripción de la ronda anterior de esta pantalla —
// no hay hook de "desmontar pantalla" en este router (ver router.js), así
// que cada renderPantallaClientes() reemplaza la suscripción viva en vez de
// apilar una nueva cada vez que el gestor vuelve a la pestaña Clientes.
let desuscribirCambioRespaldo = null;

const UMBRAL_LARGO_MONTO = 8; // caracteres — ej. "$1,834,560" (10) dispara .v-chico

function claseLongitudMonto(texto) {
  return texto.length > UMBRAL_LARGO_MONTO ? 'v-chico' : '';
}

/** Envuelve el texto del monto en un <span> de bloque — necesario para que la
 * elipsis por overflow funcione bien dentro de un contenedor flex alineado a
 * la derecha (ver comentario de .fila-excel-monto-texto en styles.css), y
 * aplica la reducción de fuente por longitud (§2.13, red anti-A-201). */
function montoSpan(texto) {
  return `<span class="fila-excel-monto-texto ${claseLongitudMonto(texto)}">${texto}</span>`;
}

const CLAVE_PREF_CARGOS_OCULTOS = 'agus-cargos-ocultos';

function leerPreferenciaCargosOcultos() {
  try {
    return localStorage.getItem(CLAVE_PREF_CARGOS_OCULTOS) === '1';
  } catch (e) {
    return false;
  }
}

function guardarPreferenciaCargosOcultos(valor) {
  try {
    localStorage.setItem(CLAVE_PREF_CARGOS_OCULTOS, valor ? '1' : '0');
  } catch (e) {
    // localStorage puede fallar (modo privado, cuota llena) — es solo una
    // preferencia de dispositivo, no rompe la pantalla si no se guarda.
  }
}

/** "sáb 30 ago" (sin punto final, sin mayúscula inicial forzada). */
function formatearFechaNav(fechaIso) {
  const [anio, mes, dia] = fechaIso.split('-').map(Number);
  const d = new Date(anio, mes - 1, dia, 12, 0, 0);
  return new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short' })
    .format(d)
    .replace(/\./g, '')
    .replace(/,/g, '')
    .replace(/\s+de\s+/g, ' ');
}

function tituloNav(fechaVista) {
  const fechaFormateada = formatearFechaNav(fechaVista);
  return fechaVista === hoy() ? `Hoy · ${fechaFormateada}` : fechaFormateada;
}

/** §2.14: días transcurridos entre dos fechas ISO — mismo cálculo que usaba
 * el aviso de respaldo de Global (retirado ahí, ver punto 5), ahora vive acá
 * para el acceso directo de respaldo de Clientes. */
function diasEntre(fechaIsoDesde, fechaIsoHasta) {
  const [a1, m1, d1] = fechaIsoDesde.split('-').map(Number);
  const [a2, m2, d2] = fechaIsoHasta.split('-').map(Number);
  const ms = new Date(a2, m2 - 1, d2).getTime() - new Date(a1, m1 - 1, d1).getTime();
  return Math.round(ms / 86400000);
}

/** R-005 aplicado acá: `ultimo_respaldo` se guarda como timestamp UTC
 * (`ahoraIso()` en db.js), pero `hoy()` es fecha LOCAL — comparar el slice(0,10)
 * del ISO crudo contra hoy() puede dar "hace -1 día(s)" apenas después de un
 * respaldo, en cualquier huso horario detrás de UTC (la fecha UTC ya rodó al
 * día siguiente aunque localmente todavía sea "hoy"). Se convierte primero a
 * fecha LOCAL antes de diffear. */
function fechaLocalDeIso(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Celda de la columna ABONOS en modo-día: semáforo de 3 estados (§2.11),
 * más el estado neutro 'FUTURO' (§2.12: día que todavía no llega — no hay
 * semáforo posible porque nadie "visitó" un día que no pasó; si YA hay un
 * abono registrado a esa fecha futura — un adelanto — el estado real es
 * 'ABONO', no 'FUTURO', así que ese caso se pinta normal más arriba). */
/** W-13: en modo seguro (o solo-lectura de otra pestaña) ninguna captura
 * normal funciona — las celdas de captura rápida se deshabilitan de forma
 * evidente (mismo patrón `disabled title="…"` que el resto de la app) en vez
 * de dejar que el gestor toque, escriba un monto, y recién ahí se entere. */
function celdaAbonoDiaHtml(c, bloqueada, tituloBloqueo) {
  const disabledAttr = bloqueada ? `disabled title="${tituloBloqueo}"` : '';
  if (c.estado_dia === 'ABONO') {
    const texto = montoOGuion(c.abonos_mes_centavos);
    return `<button type="button" class="fila-excel-monto monto-positivo" data-accion="abono" ${bloqueada ? disabledAttr : `title="${escapeHtml(texto)}"`}>${montoSpan(texto)}</button>`;
  }
  if (c.estado_dia === 'CERO') {
    return `<button type="button" class="fila-excel-monto monto-neutro" data-accion="abono" ${bloqueada ? disabledAttr : 'title="Dijo que hoy no abona"'}>${montoSpan('$0')}</button>`;
  }
  if (c.estado_dia === 'FUTURO') {
    return `<button type="button" class="fila-excel-monto monto-neutro" data-accion="abono" ${bloqueada ? disabledAttr : 'title="Día futuro — tocá para registrar un adelanto"'}>${montoSpan('+')}</button>`;
  }
  return `<button type="button" class="fila-excel-monto monto-neutro" data-accion="abono" ${bloqueada ? disabledAttr : 'title="Todavía sin visitar"'}>${montoSpan('—')}</button>`;
}

function filaClienteHtml(c, categoriaColor) {
  const sinMovimientos = !c.tiene_movimientos;
  const saldoParaMostrar = sinMovimientos ? null : c.saldo_centavos;
  const textoCargo = montoOGuion(c.cargos_mes_centavos);
  const textoSaldo = montoOGuion(saldoParaMostrar);
  const bloqueada = edicionBloqueada();
  const tituloBloqueo = bloqueada ? escapeHtml(motivoEdicionBloqueada()) : '';
  // R-004 (auditoría): el asa de arrastre no debe prometer un reordenamiento
  // que no puede cumplir — mismo criterio visual (title explicativo) que el
  // resto de los controles ya bloqueados por edicionBloqueada() en esta fila;
  // el gesto en sí se corta en origen dentro de activarArrastreOrden().
  const tituloArrastre = bloqueada ? tituloBloqueo : 'Mantené presionado para reordenar';
  return `
    <li class="lista-item fila-cliente fila-excel" data-cliente-id="${escapeHtml(c.id)}">
      <span class="asa-arrastre ${bloqueada ? 'asa-arrastre-deshabilitada' : ''}" aria-hidden="true" title="${escapeHtml(tituloArrastre)}">${Iconos.arrastre()}</span>
      ${bolitaHtml(categoriaColor)}
      <button type="button" class="fila-excel-nombre" data-accion="ver-persona" title="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</button>
      ${celdaAbonoDiaHtml(c, bloqueada, tituloBloqueo)}
      <button type="button" class="fila-excel-monto monto-negativo col-cargo" data-accion="cargo" ${bloqueada ? `disabled title="${tituloBloqueo}"` : `title="${escapeHtml(textoCargo)}"`}>${montoSpan(textoCargo)}</button>
      <span class="fila-excel-monto ${claseSaldo(saldoParaMostrar)}" title="${escapeHtml(textoSaldo)}">${montoSpan(textoSaldo)}</span>
    </li>`;
}

function filaSumaHtml(grupo) {
  const colorEstilo = grupo.categoria_color ? `color:${escapeHtml(grupo.categoria_color)}` : '';
  const textoAbonos = montoOGuion(grupo.totales.abonos_mes_centavos);
  const textoCargos = montoOGuion(grupo.totales.cargos_mes_centavos);
  const textoSaldo = montoOGuion(grupo.totales.saldo_centavos);
  return `
    <li class="lista-item fila-suma-grupo fila-excel" style="${colorEstilo}">
      <span class="asa-arrastre-vacia" aria-hidden="true"></span>
      <span class="fila-suma-etiqueta">Σ ${escapeHtml(grupo.categoria_nombre)}</span>
      <span class="fila-excel-monto monto-positivo" title="${escapeHtml(textoAbonos)}">${montoSpan(textoAbonos)}</span>
      <span class="fila-excel-monto monto-negativo col-cargo" title="${escapeHtml(textoCargos)}">${montoSpan(textoCargos)}</span>
      <span class="fila-excel-monto ${claseSaldo(grupo.totales.saldo_centavos)}" title="${escapeHtml(textoSaldo)}">${montoSpan(textoSaldo)}</span>
    </li>`;
}

function filaArchivadoHtml(c) {
  const textoSaldo = montoOGuion(c.saldo_centavos);
  return `
    <li class="lista-item fila-archivado" data-cliente-archivado-id="${escapeHtml(c.id)}">
      ${bolitaHtml(c.categoria ? c.categoria.color : null)}
      <span class="fila-archivado-nombre">${escapeHtml(c.nombre)}</span>
      <span class="fila-excel-monto ${claseSaldo(c.saldo_centavos)}" title="${escapeHtml(textoSaldo)}">${montoSpan(textoSaldo)}</span>
      <button type="button" class="btn btn-secundario btn-pequeno" data-accion="restaurar">${Iconos.restaurar()} Restaurar</button>
    </li>`;
}

/**
 * Sheet de alta de cliente — independiente (fetch propio de categorías) para
 * poder abrirse tanto desde esta pantalla como desde el botón central de la
 * barra inferior (§2.11), sin depender del estado de `renderPantallaClientes`.
 * @param {{onCreado?: () => void}} [cfg]
 */
export function abrirSheetNuevoCliente({ onCreado } = {}) {
  abrirSheet((host) => {
    let categorias = [];
    let categoriaSeleccionada = null;
    let mostrarNuevaCategoria = false;
    let colorNuevaCategoria = PALETA_COLORES_CATEGORIA[0];
    let error = {};
    let cargando = true;
    // Lo ya tipeado sobrevive a los re-render que disparan elegir/crear una
    // categoría (si no se capturara acá, cada render() reconstruye el <form>
    // desde cero y nombre/teléfono/notas ya tipeados se perderían — A-102).
    let valorNombre = '';
    let valorTelefono = '';
    let valorNotas = '';
    let valorNuevaCategoriaNombre = '';

    function capturarValoresActuales() {
      const nombreEl = host.querySelector('#nc-nombre');
      if (nombreEl) valorNombre = nombreEl.value;
      const telefonoEl = host.querySelector('#nc-telefono');
      if (telefonoEl) valorTelefono = telefonoEl.value;
      const notasEl = host.querySelector('#nc-notas');
      if (notasEl) valorNotas = notasEl.value;
      const nuevaCatEl = host.querySelector('#nc-nueva-categoria-nombre');
      if (nuevaCatEl) valorNuevaCategoriaNombre = nuevaCatEl.value;
    }

    async function refrescarCategorias() {
      categorias = await listarCategorias();
    }

    function render() {
      if (cargando) { host.innerHTML = '<p class="cargando">Cargando…</p>'; return; }
      capturarValoresActuales();
      host.innerHTML = `
        <form id="form-nuevo-cliente" class="formulario" novalidate>
          <div class="campo">
            <label for="nc-nombre">Nombre</label>
            <input id="nc-nombre" name="nombre" type="text" value="${escapeHtml(valorNombre)}" required autofocus />
            ${errorCampo(error.nombre)}
          </div>
          <div class="campo">
            <label for="nc-telefono">Teléfono (opcional)</label>
            <input id="nc-telefono" name="telefono" type="text" value="${escapeHtml(valorTelefono)}" placeholder="Ej. 5215512340000" />
            ${errorCampo(error.telefono)}
          </div>
          <div class="campo">
            <label>Categoría (opcional)</label>
            <div class="chips-fila">
              <button type="button" class="chip ${categoriaSeleccionada === null ? 'chip-activo' : ''}" data-cat="">Sin categoría</button>
              ${categorias.map((c) => `<button type="button" class="chip ${categoriaSeleccionada === c.id ? 'chip-activo' : ''}" data-cat="${escapeHtml(c.id)}">${bolitaHtml(c.color, 'bolita-chip')}${escapeHtml(c.nombre)}</button>`).join('')}
              <button type="button" class="chip chip-nuevo" id="nc-btn-nueva-categoria">${Iconos.mas()} Nueva</button>
            </div>
            ${mostrarNuevaCategoria ? `
              <div class="fila-nuevo-inline fila-nueva-categoria-inline">
                <input id="nc-nueva-categoria-nombre" type="text" value="${escapeHtml(valorNuevaCategoriaNombre)}" placeholder="Nombre de la categoría" />
                <div class="paleta-colores paleta-colores-chica">
                  ${PALETA_COLORES_CATEGORIA.map((col) => `<button type="button" class="bolita-color ${col === colorNuevaCategoria ? 'bolita-color-activa' : ''}" data-color="${col}" style="background:${col}">${col === colorNuevaCategoria ? Iconos.check() : ''}</button>`).join('')}
                </div>
                <button type="button" class="btn btn-primario btn-pequeno" id="nc-confirmar-nueva-categoria">Agregar categoría</button>
              </div>` : ''}
          </div>
          <div class="campo">
            <label for="nc-notas">Notas (opcional)</label>
            <textarea id="nc-notas" name="notas" rows="2">${escapeHtml(valorNotas)}</textarea>
          </div>
          ${errorGeneral(error.general)}
          <div class="acciones-formulario">
            <button type="submit" class="btn btn-primario btn-ancho">Crear cliente</button>
          </div>
        </form>`;

      host.querySelectorAll('.chip[data-cat]').forEach((chip) => {
        chip.addEventListener('click', () => {
          categoriaSeleccionada = chip.dataset.cat || null;
          mostrarNuevaCategoria = false;
          render();
        });
      });
      host.querySelector('#nc-btn-nueva-categoria').addEventListener('click', () => {
        mostrarNuevaCategoria = !mostrarNuevaCategoria;
        render();
        const campo = host.querySelector('#nc-nueva-categoria-nombre');
        if (campo) campo.focus();
      });
      if (mostrarNuevaCategoria) {
        host.querySelectorAll('.paleta-colores-chica .bolita-color').forEach((b) => {
          b.addEventListener('click', () => { colorNuevaCategoria = b.dataset.color; render(); });
        });
        host.querySelector('#nc-confirmar-nueva-categoria').addEventListener('click', async () => {
          const nombre = host.querySelector('#nc-nueva-categoria-nombre').value.trim();
          if (nombre.length < 1) { host.querySelector('#nc-nueva-categoria-nombre').focus(); return; }
          try {
            const cat = await crearCategoria({ nombre, color: colorNuevaCategoria });
            await refrescarCategorias();
            categoriaSeleccionada = cat.id;
            mostrarNuevaCategoria = false;
            render();
          } catch (err) {
            error.general = err.message || 'No se pudo crear la categoría.';
            render();
          }
        });
      }

      host.querySelector('#form-nuevo-cliente').addEventListener('submit', async (e) => {
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
          await crearCliente({
            nombre: nombreLimpio,
            telefono: telefonoLimpio || undefined,
            categoria_id: categoriaSeleccionada || undefined,
            notas: form.notas.value.trim() || undefined,
          });
          cerrarSheet();
          mostrarToast('Cliente creado.', 'exito');
          if (onCreado) onCreado();
        } catch (err) {
          if (err.code === 'VALIDATION_ERROR' && err.detalle && err.detalle.campo) error[err.detalle.campo] = err.message;
          else if (err.code === 'CONFLICT') error.nombre = err.message;
          else error.general = err.message || 'No se pudo crear el cliente.';
          render();
        }
      });
    }

    render();
    refrescarCategorias().then(() => { cargando = false; render(); });
  }, { titulo: 'Nuevo cliente' });
}

/**
 * @param {HTMLElement} contenedor
 */
export async function renderPantallaClientes(contenedor) {
  let fechaVista = hoy();
  let cargosOcultos = leerPreferenciaCargosOcultos();

  function renderNav() {
    const elTitulo = contenedor.querySelector('#nav-fecha-titulo');
    if (elTitulo) elTitulo.textContent = tituloNav(fechaVista);
    const inputFecha = contenedor.querySelector('#input-fecha-vista');
    if (inputFecha) inputFecha.value = fechaVista;
    // §2.12: la navegación hacia adelante ya no tiene tope — "Hoy" da una
    // vuelta sin fricción cuando el gestor se fue lejos a cargar adelantos.
    const btnHoy = contenedor.querySelector('#btn-volver-hoy');
    if (btnHoy) btnHoy.classList.toggle('chip-hoy-oculto', fechaVista === hoy());
  }

  /** §2.13: suma los cargos del día VISTO desde los totales de grupo que
   * `listarClientesAgrupados` ya entrega (en modo-día, `cargos_mes_centavos`
   * es el total del DÍA, no del mes) — cero queries nuevas. */
  function sumarCargosDelDia(grupos) {
    return grupos.reduce((acc, g) => acc + g.totales.cargos_mes_centavos, 0);
  }

  /** §2.13/§2.14: 3 tarjetas — Abonos del día (verde) · Cargos del día (rojo)
   * · Balance general (color semántico de saldo, TODA la cartera, estable
   * entre días — calculado con el helper COMPARTIDO de componentes.js, el
   * mismo que usa Global, para que las dos pantallas jamás vuelvan a
   * divergir — hallazgo de Agustín: "el Global no me da"). Sublínea de
   * conteos de visita debajo, SALVO en día futuro (esos conteos no
   * significan nada — vienen null desde db.js — se muestra el badge FUTURO
   * en su lugar). */
  function renderResumenDia(grupos, resumenDia) {
    const elTarjetas = contenedor.querySelector('#tarjetas-resumen-dia');
    const elExtra = contenedor.querySelector('#linea-extra-resumen-dia');
    if (!elTarjetas || !elExtra || !resumenDia) return;

    const cargosDiaCentavos = sumarCargosDelDia(grupos);
    const abonosDiaCentavos = resumenDia.cobradoCentavos;
    const balanceGeneralCentavos = calcularBalanceGeneral(grupos);
    const textoAbonos = formatearCentavos(abonosDiaCentavos);
    const textoCargos = formatearCentavos(cargosDiaCentavos);
    const textoBalance = montoOGuion(balanceGeneralCentavos);

    elTarjetas.innerHTML = `
      <div class="tarjeta-resumen-dia">
        <span class="tarjeta-resumen-dia-etiqueta">Abonos del día</span>
        <span class="tarjeta-resumen-dia-monto monto-positivo ${claseLongitudMonto(textoAbonos)}">${escapeHtml(textoAbonos)}</span>
      </div>
      <div class="tarjeta-resumen-dia">
        <span class="tarjeta-resumen-dia-etiqueta">Cargos del día</span>
        <span class="tarjeta-resumen-dia-monto monto-negativo ${claseLongitudMonto(textoCargos)}">${escapeHtml(textoCargos)}</span>
      </div>
      <div class="tarjeta-resumen-dia">
        <span class="tarjeta-resumen-dia-etiqueta">Balance general</span>
        <span class="tarjeta-resumen-dia-monto ${claseSaldo(balanceGeneralCentavos)} ${claseLongitudMonto(textoBalance)}">${escapeHtml(textoBalance)}</span>
      </div>
    `;

    if (resumenDia.esFuturo) {
      elExtra.innerHTML = `<span class="franja-badge-futuro">FUTURO</span>`;
      return;
    }
    // Mockup confirmado por Agustín (§2.13): una sola línea discreta y
    // centrada, "sin visitar" destacado en tono de advertencia (es lo que
    // todavía queda por hacer hoy) — el resto en gris neutro.
    elExtra.innerHTML = `
      ${resumenDia.abonaron} abonaron · ${resumenDia.dijeronNo} dijeron hoy no ·
      <span class="sublinea-destacado">${resumenDia.sinVisitar} sin visitar</span>
    `;
  }

  /** §2.14: acceso directo de respaldo — reemplaza la microcopy "¿Para qué
   * sirve esta pantalla?" de Clientes. Tap ejecuta exportarRespaldo() (misma
   * descarga que en Global), toast de éxito y refresco de "hace N días". La
   * fecha se pinta ámbar SOLO cuando N>7 o nunca se exportó — dato con
   * color, no un banner (el banner de Global se retira, punto 5). No se
   * recalcula en cada refrescarLista(): la fecha de último respaldo no
   * cambia solo por mirar otro día.
   *
   * Pedido del dueño (avisos amarillos ocupan demasiado espacio): el banner
   * amarillo de ancho completo "almacenamiento persistente denegado" se
   * retiró del shell (router.js). Su información NO se pierde: si
   * navigator.storage.persisted() devuelve false, esta misma línea suma un
   * ícono de advertencia discreto (sin renglón propio) con title/aria-label
   * explicando el riesgo — cero pérdida de información, espacio mínimo. */
  async function renderLineaRespaldo() {
    const el = contenedor.querySelector('#linea-respaldo-clientes');
    if (!el) return;
    const [ultimoRespaldoIso, persistenciaDenegada] = await Promise.all([
      obtenerUltimoRespaldo(),
      almacenamientoPersistenteDenegado(),
    ]);
    // W-18 (postmortem 2-sep-2026): la fecha que db.js escribió no basta —
    // hasta que el gestor confirme "sí, ahí está" en el sheet de respaldo, se
    // muestra "sin confirmar" en vez de una fecha que todavía puede ser
    // mentira (descarga errática en iOS).
    const { estado, iso } = estadoRespaldoUi(ultimoRespaldoIso);
    const diasDesde = iso ? Math.max(0, diasEntre(fechaLocalDeIso(iso), hoy())) : null;
    const sinConfirmar = estado === 'sin_confirmar';
    const destacar = sinConfirmar || diasDesde === null || diasDesde > 7;
    const textoFecha = sinConfirmar
      ? `sin confirmar (exportado hace ${diasDesde} día(s))`
      : diasDesde === null ? 'nunca' : `hace ${diasDesde} día(s)`;
    const textoAvisoPersistencia = 'Almacenamiento persistente denegado: el navegador podría liberar espacio ' +
      'si el dispositivo anda justo de memoria. Te recomendamos exportar un respaldo seguido.';
    const bloqueadaImportar = edicionBloqueada();
    el.innerHTML = `
      <div class="fila-linea-respaldo-clientes">
        <button type="button" class="linea-respaldo-clientes" id="btn-respaldar-clientes" ${estaSoloLectura() ? 'disabled title="Modo solo lectura"' : ''}>
          ${Iconos.respaldo()}
          <span>Respaldar · último: ${destacar ? `<span class="linea-respaldo-destacado">${escapeHtml(textoFecha)}</span>` : escapeHtml(textoFecha)}</span>
        </button>
        ${persistenciaDenegada ? `<span class="icono-aviso-persistencia" role="img" aria-label="${escapeHtml(textoAvisoPersistencia)}" title="${escapeHtml(textoAvisoPersistencia)}">${Iconos.alerta()}</span>` : ''}
        <button type="button" class="linea-respaldo-clientes linea-restaurar-clientes" id="btn-restaurar-clientes" ${bloqueadaImportar ? `disabled title="${escapeHtml(motivoEdicionBloqueada())}"` : ''}>
          ${Iconos.restaurar()}
          <span>Restaurar</span>
        </button>
      </div>
    `;
    // exportarRespaldo() NUNCA está bloqueada por modo seguro (es uno de sus
    // dos escapes) — solo por estaSoloLectura() (conflicto real de pestañas).
    const btn = el.querySelector('#btn-respaldar-clientes');
    if (btn) {
      btn.addEventListener('click', () => ejecutarExportarRespaldoConConfirmacion({ onCambio: renderLineaRespaldo }));
    }
    // Emergencia de producción: acceso discreto pero presente para restaurar
    // un .sqlite sin tener que ir a Global — mismo flujo compartido que el
    // banner de modo demo y el panel Ajustes/Respaldo de Global.
    const btnRestaurar = el.querySelector('#btn-restaurar-clientes');
    if (btnRestaurar) btnRestaurar.addEventListener('click', () => dispararImportarRespaldo());
  }

  function renderCabeceraColumnas() {
    const el = contenedor.querySelector('#cabecera-columnas-clientes');
    if (!el) return;
    el.className = `cabecera-columnas cabecera-columnas-excel ${cargosOcultos ? 'cargos-ocultos' : ''}`;
    // Bug del dueño: la cabecera debe compartir EXACTAMENTE el mismo grid que
    // .fila-excel en ambos estados. Antes, al ocultar, se SUSTITUÍA la celda
    // "Cargos" por "‹C" (ambas ocupando el mismo slot de grid) — eso deja 6
    // ítems visibles en la cabecera contra el grid de 5 columnas de las filas
    // de datos, y el 6to (Saldo) se desborda a un renglón aparte. Ahora la
    // celda "Cargos" SIEMPRE existe con la clase .col-cargo (se oculta con la
    // misma regla CSS que las filas) y "‹C" vive ANIDADA dentro de la celda
    // "Abonos" (hijo de un ítem de grid, no un ítem de grid en sí mismo) para
    // no alterar el conteo de columnas.
    el.innerHTML = `
      <span></span><span></span><span class="cabecera-columnas-nombre">Cliente</span>
      <span class="cabecera-columnas-monto">Abonos${cargosOcultos ? ` <button type="button" class="btn-pestania-cargos" id="btn-mostrar-cargos" aria-label="Mostrar columna Cargos">‹C</button>` : ''}</span>
      <button type="button" class="cabecera-columnas-monto btn-ocultar-cargos col-cargo" id="btn-ocultar-cargos">Cargos</button>
      <span class="cabecera-columnas-monto">Saldo</span>
    `;
    const btnOcultar = el.querySelector('#btn-ocultar-cargos');
    if (btnOcultar) btnOcultar.addEventListener('click', () => alternarCargosOcultos(true));
    const btnMostrar = el.querySelector('#btn-mostrar-cargos');
    if (btnMostrar) btnMostrar.addEventListener('click', () => alternarCargosOcultos(false));
  }

  function alternarCargosOcultos(ocultar) {
    cargosOcultos = ocultar;
    guardarPreferenciaCargosOcultos(cargosOcultos);
    renderCabeceraColumnas();
    const elLista = contenedor.querySelector('#lista-clientes-agrupados');
    if (elLista) elLista.classList.toggle('cargos-ocultos', cargosOcultos);
  }

  /** §2.14: refresca el icono/aria-label del toggle claro/oscuro con el
   * tema realmente activo ahora (elección manual, o sistema si no hay). */
  function renderBotonTema() {
    const btn = contenedor.querySelector('#btn-toggle-tema');
    if (!btn) return;
    btn.innerHTML = iconoTemaHtml();
    btn.setAttribute('aria-label', temaActivo() === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
  }

  async function refrescarTodo() {
    await refrescarLista();
    await refrescarArchivados();
    await renderLineaRespaldo();
  }

  async function refrescarLista() {
    const { grupos, resumenDia } = await listarClientesAgrupados({ fecha: fechaVista });
    const elLista = contenedor.querySelector('#lista-clientes-agrupados');
    if (!elLista) return;

    renderNav();
    renderResumenDia(grupos, resumenDia);

    elLista.className = `${cargosOcultos ? 'cargos-ocultos' : ''}`;

    if (grupos.length === 0) {
      elLista.innerHTML = estadoVacio('Todavía no hay clientes.', 'Creá el primero con el botón "+ Nuevo cliente" de abajo.');
      return;
    }

    elLista.innerHTML = grupos.map((grupo) => `
      <section class="grupo-clientes">
        <h3 class="grupo-titulo">${bolitaHtml(grupo.categoria_color)} ${escapeHtml(grupo.categoria_nombre)}</h3>
        <ul class="lista lista-grupo" data-categoria-id="${grupo.categoria_id ?? ''}">
          ${grupo.clientes.map((c) => filaClienteHtml(c, grupo.categoria_color)).join('')}
          ${filaSumaHtml(grupo)}
        </ul>
      </section>
    `).join('');

    elLista.querySelectorAll('.lista-grupo').forEach((ul) => {
      ul.querySelectorAll('[data-accion="ver-persona"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const li = btn.closest('[data-cliente-id]');
          window.location.hash = `#/clientes/${encodeURIComponent(li.dataset.clienteId)}`;
        });
      });
      ul.querySelectorAll('[data-accion="abono"], [data-accion="cargo"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const li = btn.closest('[data-cliente-id]');
          const nombre = li.querySelector('.fila-excel-nombre').textContent;
          abrirPanelRapido({
            tipo: btn.dataset.accion === 'abono' ? 'ABONO' : 'CARGO',
            clienteId: li.dataset.clienteId,
            clienteNombre: nombre,
            fechaInicial: fechaVista,
            onGuardado: refrescarLista,
          });
        });
      });
      activarArrastreOrden(ul, async (idsEnOrden) => {
        try {
          await actualizarOrdenClientes(idsEnOrden);
        } catch (e) {
          mostrarToast(e.message || 'No se pudo guardar el nuevo orden.', 'error');
        }
        await refrescarLista();
      });
    });
  }

  async function refrescarArchivados() {
    const elDetalles = contenedor.querySelector('#seccion-archivados');
    const elLista = contenedor.querySelector('#lista-archivados');
    if (!elDetalles || !elLista) return;
    const archivados = await listarClientesArchivados();
    const elResumen = contenedor.querySelector('#resumen-archivados');
    if (elResumen) elResumen.innerHTML = `${Iconos.cajaArchivo()} Archivados (${archivados.length})`;
    if (archivados.length === 0) {
      elLista.innerHTML = estadoVacio('No hay clientes archivados.');
      return;
    }
    elLista.innerHTML = `<ul class="lista lista-archivados">${archivados.map(filaArchivadoHtml).join('')}</ul>`;
    elLista.querySelectorAll('[data-accion="restaurar"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const li = btn.closest('[data-cliente-archivado-id]');
        const idCliente = li.dataset.clienteArchivadoId;
        try {
          await restaurarCliente(idCliente);
          mostrarToast('Cliente restaurado.', 'exito');
          await refrescarArchivados();
          await refrescarLista();
        } catch (e) {
          mostrarToast(e.message || 'No se pudo restaurar el cliente.', 'error');
        }
      });
    });
  }

  contenedor.innerHTML = `
    <section class="pantalla" data-pantalla="clientes">
      ${bannerModoDemoHtml()}
      <div class="encabezado-sticky-clientes">
        <div class="encabezado-clientes">
          <h1>Clientes</h1>
          <div class="encabezado-clientes-acciones">
            <button type="button" class="btn-icono" id="btn-toggle-tema" aria-label="Cambiar de tema">${iconoTemaHtml()}</button>
            <button type="button" class="btn-icono" id="btn-config" aria-label="Configuración de categorías y conceptos" ${edicionBloqueada() ? `disabled title="${escapeHtml(motivoEdicionBloqueada())}"` : ''}>${Iconos.engrane()}</button>
          </div>
        </div>

        <div class="nav-fecha-clientes">
          <button type="button" class="btn-icono" id="btn-dia-anterior" aria-label="Día anterior">${Iconos.chevronIzquierda()}</button>
          <button type="button" class="nav-fecha-titulo-btn" id="btn-elegir-fecha" aria-label="Elegir fecha">
            <span id="nav-fecha-titulo"></span> ▾
          </button>
          <input type="date" id="input-fecha-vista" class="input-fecha-oculto" aria-hidden="true" tabindex="-1" />
          <button type="button" class="btn-icono" id="btn-dia-siguiente" aria-label="Día siguiente">${Iconos.chevronDerecha()}</button>
          <button type="button" class="chip-hoy chip-hoy-oculto" id="btn-volver-hoy">Hoy</button>
        </div>

        <div id="tarjetas-resumen-dia" class="tarjetas-resumen-dia" aria-live="polite"></div>
        <div id="linea-extra-resumen-dia" class="linea-extra-resumen-dia" aria-live="polite"></div>

        <div class="cabecera-columnas cabecera-columnas-excel" id="cabecera-columnas-clientes"></div>

        <div id="linea-respaldo-clientes"></div>
      </div>

      <div id="lista-clientes-agrupados" aria-live="polite"></div>

      <details class="panel-colapsable panel-archivados" id="seccion-archivados">
        <summary id="resumen-archivados">${Iconos.cajaArchivo()} Archivados (0)</summary>
        <div id="lista-archivados" aria-live="polite"></div>
      </details>
    </section>
  `;

  renderCabeceraColumnas();
  await refrescarTodo();

  // R-003 (auditoría): "Respaldar · último" debe repintarse ante CUALQUIER
  // cambio de estado de respaldo, incluido el que dispara el botón "Exportar
  // respaldo ahora" de la alarma roja (router.js — ese call site no pasa
  // `onCambio`). Reemplaza la suscripción anterior en vez de apilarla.
  if (desuscribirCambioRespaldo) desuscribirCambioRespaldo();
  desuscribirCambioRespaldo = suscribirseACambioRespaldo(renderLineaRespaldo);

  contenedor.querySelector('#btn-config').addEventListener('click', () => {
    abrirSheetConfiguracion({ onCambios: refrescarTodo });
  });
  contenedor.querySelector('#btn-toggle-tema').addEventListener('click', () => {
    alternarTema();
    renderBotonTema();
  });
  // §2.14: si el gestor NO tiene una elección manual guardada, el toggle
  // sigue al sistema — este listener mantiene el icono correcto si el
  // sistema cambia de tema mientras la pantalla está abierta.
  wireCambioTemaSistema(renderBotonTema);
  wireBannerModoDemo(contenedor);

  contenedor.querySelector('#btn-dia-anterior').addEventListener('click', () => {
    fechaVista = sumarDias(fechaVista, -1);
    refrescarLista();
  });
  contenedor.querySelector('#btn-dia-siguiente').addEventListener('click', () => {
    // §2.12: navegación hacia adelante desbloqueada (adelantos) — sin tope.
    fechaVista = sumarDias(fechaVista, 1);
    refrescarLista();
  });
  contenedor.querySelector('#btn-volver-hoy').addEventListener('click', () => {
    fechaVista = hoy();
    refrescarLista();
  });
  const inputFecha = contenedor.querySelector('#input-fecha-vista');
  contenedor.querySelector('#btn-elegir-fecha').addEventListener('click', () => {
    if (inputFecha.showPicker) inputFecha.showPicker();
    else inputFecha.focus();
  });
  inputFecha.addEventListener('change', () => {
    const valor = inputFecha.value;
    if (!valor || !esFechaIsoValida(valor)) return;
    fechaVista = valor;
    refrescarLista();
  });
}
