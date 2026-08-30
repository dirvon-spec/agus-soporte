// Bootstrap de la app: initDb() -> router -> pantalla inicial "Clientes".
// Maneja el modo solo-lectura de una segunda pestaña (aviso permanente
// mostrado por router.js) y errores fatales de inicialización (DB_ERROR)
// con un mensaje explícito en vez de una pantalla en blanco.

import { initDb } from './db.js';
import { iniciarRouter } from './router.js';

async function main() {
  const appEl = document.getElementById('app');

  try {
    await initDb();
  } catch (e) {
    console.error('[app] Error fatal al inicializar la base de datos:', e);
    appEl.innerHTML = `
      <div class="error-boundary error-boundary-fatal">
        <p class="error-boundary-titulo">No se pudo iniciar la app${e.code ? ` [${e.code}]` : ''}.</p>
        <p>${(e.message || 'Error desconocido.').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>
        <details>
          <summary>Detalle técnico</summary>
          <pre>${(e.stack || String(e)).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>
        </details>
      </div>`;
    return;
  }

  iniciarRouter(appEl);

  const params = new URLSearchParams(window.location.search);
  if (params.get('verify') === '1') {
    const modulo = await import('./dev-verify.js');
    await modulo.ejecutarVerificacion();
  }
}

main();
