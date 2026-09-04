// Bootstrap de la app: initDb() -> router -> pantalla inicial "Clientes".
// Maneja el modo solo-lectura de una segunda pestaña (aviso permanente
// mostrado por router.js) y errores fatales de inicialización (DB_ERROR)
// con un mensaje explícito en vez de una pantalla en blanco.
//
// R-001 (b) — auditoría independiente, POSTMORTEM 2-sep-2026: antes de esta
// corrección, un DB_ERROR inesperado de initDb() (p.ej. el propio almacén de
// snapshots caído — ver db.js, R-001 (a)) llegaba acá y esta pantalla
// mostraba SOLO el mensaje técnico, sin ninguna acción posible: los datos
// del usuario quedaban intactos en disco pero inalcanzables — peor que el
// bug que este mismo blindaje intenta prevenir. Ahora, cualquier fallo de
// initDb() ofrece además acciones de rescate que no dependen de que initDb()
// haya completado: exportar los bytes crudos guardados en IndexedDB (bypass
// total de sql.js) y listar/restaurar copias de seguridad (snapshots).

import { initDb, exportarBytesCrudosSinAbrir, listarSnapshots, obtenerBytesSnapshot, restaurarSnapshot } from './db.js';
import { iniciarRouter } from './router.js';

function escaparHtml(texto) {
  return String(texto).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

/** Dispara la descarga de un Blob en el navegador vía un <a download> temporal. */
function descargarBlob(blob, nombreArchivo) {
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = nombreArchivo;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function formatearFechaLocal(fechaIso) {
  try {
    return new Date(fechaIso).toLocaleString('es-MX');
  } catch (e) {
    return fechaIso;
  }
}

/**
 * R-001 (b): sección de rescate de la pantalla fatal. Cada acción está
 * aislada en su propio try/catch — si sql.js nunca llegó a cargar (fallo
 * previo a `SQL = await initSqlJsVendor(...)` dentro de initDb()), listar o
 * restaurar snapshots no puede funcionar (dependen de `new SQL.Database`),
 * pero eso no debe romper el resto de la pantalla ni impedir el otro rescate
 * (exportar bytes crudos, que SOLO depende de IndexedDB y sí funciona en ese
 * caso). Ningún camino de esta función debe poder tirar una excepción sin
 * capturar: es la última pantalla que le queda al usuario.
 */
function construirSeccionRescate() {
  const contenedor = document.createElement('div');
  contenedor.className = 'error-boundary error-boundary-fatal';
  contenedor.style.textAlign = 'left';

  const titulo = document.createElement('p');
  titulo.className = 'error-boundary-titulo';
  titulo.textContent = 'Rescatar mis datos';
  contenedor.appendChild(titulo);

  const explicacion = document.createElement('p');
  explicacion.style.fontSize = '0.85rem';
  explicacion.style.color = 'var(--color-texto-secundario)';
  explicacion.textContent =
    'La app no pudo terminar de arrancar, pero tus datos guardados en este dispositivo probablemente siguen intactos. Probá estas dos acciones antes de pedir ayuda:';
  contenedor.appendChild(explicacion);

  const estilizarBoton = (boton) => {
    boton.style.display = 'block';
    boton.style.width = '100%';
    boton.style.margin = 'var(--espaciado-sm) 0';
    boton.style.padding = 'var(--espaciado-sm) var(--espaciado-md)';
    boton.style.background = 'var(--color-primario)';
    boton.style.color = 'var(--color-primario-texto)';
    boton.style.border = 'none';
    boton.style.borderRadius = 'var(--radio-borde-chico)';
    boton.style.cursor = 'pointer';
    boton.style.fontWeight = '600';
  };

  const mensajeEstado = (contenedorPadre) => {
    const p = document.createElement('p');
    p.style.fontSize = '0.8rem';
    p.style.marginTop = 'var(--espaciado-xs)';
    contenedorPadre.appendChild(p);
    return p;
  };

  // --- Acción 1: exportar los bytes crudos, sin pasar por sql.js. ---
  const bloqueExport = document.createElement('div');
  const botonExport = document.createElement('button');
  botonExport.type = 'button';
  botonExport.textContent = '⬇️ Exportar mis datos guardados (.sqlite)';
  estilizarBoton(botonExport);
  bloqueExport.appendChild(botonExport); // el botón va ANTES que su propio mensaje de estado (orden de lectura)
  const estadoExport = mensajeEstado(bloqueExport);
  botonExport.addEventListener('click', async () => {
    botonExport.disabled = true;
    estadoExport.textContent = 'Buscando tus datos guardados…';
    try {
      const resultado = await exportarBytesCrudosSinAbrir();
      if (!resultado) {
        estadoExport.textContent = 'No se encontró ninguna base guardada todavía en este dispositivo.';
      } else {
        descargarBlob(resultado.blob, resultado.nombreArchivo);
        estadoExport.textContent = `Descarga iniciada: ${resultado.nombreArchivo}. Guardala en un lugar seguro (WhatsApp, Archivos, correo).`;
      }
    } catch (e) {
      estadoExport.textContent = `No se pudo exportar: ${(e && e.message) || String(e)}`;
    } finally {
      botonExport.disabled = false;
    }
  });
  contenedor.appendChild(bloqueExport);

  // --- Acción 2: listar y restaurar copias de seguridad (snapshots). ---
  const bloqueSnapshots = document.createElement('div');
  const botonSnapshots = document.createElement('button');
  botonSnapshots.type = 'button';
  botonSnapshots.textContent = '🗂️ Ver copias de seguridad';
  estilizarBoton(botonSnapshots);
  bloqueSnapshots.appendChild(botonSnapshots); // el botón va ANTES que su estado y su lista de resultados
  const estadoSnapshots = mensajeEstado(bloqueSnapshots);
  const listaSnapshots = document.createElement('ul');
  listaSnapshots.style.listStyle = 'none';
  listaSnapshots.style.padding = '0';
  listaSnapshots.style.margin = 'var(--espaciado-sm) 0 0';
  bloqueSnapshots.appendChild(listaSnapshots);

  botonSnapshots.addEventListener('click', async () => {
    botonSnapshots.disabled = true;
    estadoSnapshots.textContent = 'Buscando copias de seguridad…';
    listaSnapshots.innerHTML = '';
    try {
      const snapshots = await listarSnapshots();
      if (!snapshots.length) {
        estadoSnapshots.textContent = 'No hay ninguna copia de seguridad guardada todavía en este dispositivo.';
        return;
      }
      estadoSnapshots.textContent = `${snapshots.length} copia(s) encontrada(s), más reciente primero:`;
      for (const snap of snapshots) {
        const item = document.createElement('li');
        item.style.borderTop = '1px solid var(--color-error)';
        item.style.padding = 'var(--espaciado-sm) 0';

        const detalle = document.createElement('div');
        detalle.style.fontSize = '0.8rem';
        detalle.innerHTML = `<strong>${escaparHtml(formatearFechaLocal(snap.fechaIso))}</strong> — ${escaparHtml(snap.motivo)} (${escaparHtml(snap.categoria)})`;
        item.appendChild(detalle);

        const acciones = document.createElement('div');
        acciones.style.marginTop = 'var(--espaciado-xs)';
        acciones.style.display = 'flex';
        acciones.style.gap = 'var(--espaciado-sm)';

        const botonDescargar = document.createElement('button');
        botonDescargar.type = 'button';
        botonDescargar.textContent = 'Descargar';
        botonDescargar.addEventListener('click', async () => {
          try {
            const bytes = await obtenerBytesSnapshot(snap.clave);
            if (!bytes) {
              estadoSnapshots.textContent = 'Ese snapshot ya no está disponible.';
              return;
            }
            const blob = new Blob([bytes], { type: 'application/x-sqlite3' });
            descargarBlob(blob, `snapshot-${snap.fechaLocal}-${snap.categoria}.sqlite`);
          } catch (e) {
            estadoSnapshots.textContent = `No se pudo descargar: ${(e && e.message) || String(e)}`;
          }
        });
        acciones.appendChild(botonDescargar);

        const botonRestaurar = document.createElement('button');
        botonRestaurar.type = 'button';
        botonRestaurar.textContent = 'Restaurar y reintentar';
        botonRestaurar.addEventListener('click', async () => {
          const confirmado = window.confirm(
            `¿Restaurar la copia del ${formatearFechaLocal(snap.fechaIso)} (${snap.motivo}) y reintentar abrir la app? Se guarda antes una copia del estado actual, por si te arrepentís.`
          );
          if (!confirmado) return;
          botonRestaurar.disabled = true;
          estadoSnapshots.textContent = 'Restaurando…';
          try {
            await restaurarSnapshot(snap.clave);
            estadoSnapshots.textContent = 'Restaurado. Reiniciando la app…';
            window.location.reload();
          } catch (e) {
            estadoSnapshots.textContent = `No se pudo restaurar: ${(e && e.message) || String(e)}`;
            botonRestaurar.disabled = false;
          }
        });
        acciones.appendChild(botonRestaurar);

        item.appendChild(acciones);
        listaSnapshots.appendChild(item);
      }
    } catch (e) {
      estadoSnapshots.textContent = `No se pudo acceder a las copias de seguridad: ${(e && e.message) || String(e)}`;
    } finally {
      botonSnapshots.disabled = false;
    }
  });
  contenedor.appendChild(bloqueSnapshots);

  return contenedor;
}

function renderizarPantallaFatal(appEl, e) {
  appEl.innerHTML = `
      <div class="error-boundary error-boundary-fatal">
        <p class="error-boundary-titulo">No se pudo iniciar la app${e.code ? ` [${e.code}]` : ''}.</p>
        <p>${escaparHtml(e.message || 'Error desconocido.')}</p>
        <details>
          <summary>Detalle técnico</summary>
          <pre>${escaparHtml(e.stack || String(e))}</pre>
        </details>
      </div>`;
  appEl.appendChild(construirSeccionRescate());
}

async function main() {
  const appEl = document.getElementById('app');

  try {
    await initDb();
  } catch (e) {
    console.error('[app] Error fatal al inicializar la base de datos:', e);
    renderizarPantallaFatal(appEl, e);
    return;
  }

  iniciarRouter(appEl);

  const params = new URLSearchParams(window.location.search);
  if (params.get('verify') === '1') {
    const modulo = await import('./dev-verify.js');
    await modulo.ejecutarVerificacion();
  }
}

// PWA (W-19/W-20, POSTMORTEM-2026-09-02.md): registra el service worker que
// precachea el app shell para que la app abra sin red. Un fallo de registro
// (navegador viejo, política del dispositivo, etc.) se loguea pero JAMÁS
// debe impedir que la app arranque — por eso vive detrás de un try/catch
// propio y después de iniciarRouter(), no antes.
function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => {
      console.error('[app] No se pudo registrar el service worker (la app sigue funcionando igual, solo sin precache offline):', e);
    });
  });

  // Guard anti-bucle: un SW nuevo llama a self.skipWaiting()+clients.claim()
  // (sw.js) apenas termina de instalar, lo que dispara 'controllerchange' en
  // toda pestaña abierta — incluida la primera vez que se registra el SW.
  // Sin el flag `yaRecargando`, cualquier evento repetido recargaría en
  // bucle. Un solo reload es seguro: el flush en pagehide/visibilitychange
  // (W-06, js/db.js) ya garantiza que no se pierde una captura en curso.
  let yaRecargando = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (yaRecargando) return;
    yaRecargando = true;
    mostrarAvisoNuevaVersion();
    setTimeout(() => window.location.reload(), 600);
  });
}

function mostrarAvisoNuevaVersion() {
  const aviso = document.createElement('div');
  aviso.className = 'sw-aviso-actualizacion';
  aviso.setAttribute('role', 'status');
  aviso.textContent = 'Actualizando a la nueva versión…';
  document.body.appendChild(aviso);
}

registrarServiceWorker();
main();
