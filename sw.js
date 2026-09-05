// Service worker — Agus Soporte.
//
// Por qué existe (POSTMORTEM-2026-09-02.md W-19/W-20 y CLAUDE.md): la app se
// vende como "100% offline" pero, sin service worker, el SHELL (HTML/CSS/JS/
// WASM) dependía de la red para cargar. GitHub Pages caído o el gestor sin
// señal en la ruta de cobro dejaban una app con los datos intactos en
// IndexedDB pero sin forma de abrirla. Esto la resuelve con:
//   - precache versionado del app shell completo (§ APP_SHELL abajo),
//   - navegaciones: network-first con fallback a caché (SIEMPRE la versión
//     más nueva si hay red; abre desde caché si no la hay),
//   - estáticos (js/css/wasm/iconos/manifest): cache-first, para no pagar un
//     round-trip de red en cada archivo del shell,
//   - al activarse un SW nuevo, se borran los cachés de versiones previas —
//     así nunca queda al gestor clavado en un JS viejo (W-20: una versión
//     vieja podía volver a disparar el re-sembrado de datos).
//
// TODO camino es relativo (./…): la app vive en un subdirectorio de GitHub
// Pages (/agus-soporte/), nunca en la raíz del dominio.
//
// IMPORTANTE al desplegar un cambio: subir VERSION. El navegador solo
// reinstala el SW cuando el archivo sw.js cambia byte a byte — sin bump acá,
// una actualización de la app puede quedar servida desde caché vieja.

const VERSION = 'v2';
const CACHE_NAME = `agus-soporte-${VERSION}`;

// App shell: TODO lo que la app necesita para arrancar y operar sin red.
// Si se agrega un archivo js/** nuevo que la app carga siempre (no solo en
// una rama de error), hay que sumarlo acá.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/calendar.js',
  './js/db.js',
  './js/dev-verify.js',
  './js/router.js',
  './js/schema.js',
  './js/seed.js',
  './js/ui/componentes.js',
  './js/ui/pantalla-cliente-detalle.js',
  './js/ui/pantalla-clientes.js',
  './js/ui/pantalla-global.js',
  './js/utils/date.js',
  './js/utils/errors.js',
  './js/utils/money.js',
  './js/utils/uuid.js',
  './js/utils/whatsapp.js',
  './js/vendor/sql-wasm.js',
  './js/vendor/sql-wasm.wasm',
  './assets/icons/icon-180.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // addAll() es atómico (si un solo archivo falla, ninguno queda
      // cacheado) — preferible a fallar en silencio con precache parcial.
      await cache.addAll(APP_SHELL);
      // Entra en vigor sin esperar a que se cierren las pestañas viejas; el
      // guard de recarga vive en js/app.js (controllerchange, una sola vez).
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const nombres = await caches.keys();
      await Promise.all(
        nombres
          .filter((nombre) => nombre !== CACHE_NAME)
          .map((nombre) => caches.delete(nombre)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Solo GET, mismo origen. Deja pasar todo lo demás sin tocar (POST,
  // blob:/data: de las descargas de respaldo, peticiones cross-origin) —
  // el SW no debe interferir con la descarga de respaldos ni con nada que
  // no sea el propio shell de la app.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navegaciones (documento HTML): network-first. Si hay red, siempre la
  // versión más nueva (y de paso se refresca la copia en caché); sin red,
  // fallback a la copia cacheada de la propia URL o, si no existe, al shell
  // (index.html) — la app es una SPA por hash, así que sirve para cualquier
  // ruta profunda que el navegador pida como navegación.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const respuestaRed = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, respuestaRed.clone());
          return respuestaRed;
        } catch (e) {
          const cache = await caches.open(CACHE_NAME);
          const cacheada = await cache.match(request);
          return cacheada || cache.match('./index.html');
        }
      })(),
    );
    return;
  }

  // Estáticos (js/css/wasm/iconos/manifest): cache-first. Las versiones
  // nuevas llegan al activarse un SW nuevo (que borra el caché viejo), no
  // por-request — así no se paga red en cada archivo del shell.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cacheada = await cache.match(request);
      if (cacheada) return cacheada;
      try {
        const respuestaRed = await fetch(request);
        // Solo cachear respuestas OK — evita guardar 404/opaque de forma
        // permanente si algo no estaba en APP_SHELL.
        if (respuestaRed && respuestaRed.ok) cache.put(request, respuestaRed.clone());
        return respuestaRed;
      } catch (e) {
        // Sin red y sin caché: no hay nada más que ofrecer para este
        // recurso puntual (a diferencia de las navegaciones, no tiene
        // sentido un fallback genérico para un .js/.wasm específico).
        throw e;
      }
    })(),
  );
});
