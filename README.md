# Agus Soporte — Demo MVP (cobro diario a crédito)

Demo 100% offline en HTML/CSS/JS vanilla (sin frameworks). No usar `file://`:
sql.js necesita un servidor HTTP para cargar el `.wasm`.

## Cómo levantar la demo

Desde la raíz del proyecto:

```bash
npx serve .
```

o, si preferís Python:

```bash
python -m http.server
```

Abrí la URL que te indique la consola (ej. `http://localhost:3000` o
`http://localhost:8000`). La demo arranca directamente en la pantalla **Hoy**,
poblada con el seed de ejemplo (ver "Primer arranque" más abajo).

## Estado de este build

El MVP está completo end-to-end: capa de datos (`db.js`), algoritmo de
calendario puro (`calendar.js`), datos de ejemplo (`seed.js`), utilidades
(`uuid.js`, `date.js`, `money.js`, `whatsapp.js`), router por hash
(`router.js`) y las 5 pantallas de la especificación (`js/ui/`):

- **Hoy** (`#/hoy`) — resumen del día, navegación día atrás/adelante.
- **Clientes** (`#/clientes`) — lista, búsqueda, alta de cliente.
- **Detalle de cliente** (`#/clientes/:id`) — saldo, calendario de estados,
  historial de movimientos y acuerdos, WhatsApp, estado de cuenta imprimible
  (`#/clientes/:id/imprimir`), renegociar cuota.
- **Registrar movimiento** (`#/nuevo-movimiento` o `#/nuevo-movimiento/:id`) —
  cargo, abono o ajuste de un movimiento existente.
- **Resumen mensual** (`#/resumen/:YYYY-MM`) — totales del mes, exportar/importar
  respaldo.

## Primer arranque

Al abrir la demo por primera vez, `initDb()` crea el esquema y siembra ~8-10
clientes de ejemplo con dos meses de movimientos relativos a la fecha actual
(cubriendo los 9 casos obligatorios de la sección 2.6 del plan: siempre
pagado, gracia/adelanto, parcial recurrente, deuda franca, cliente nuevo,
cambio de cuota, ajuste, sin teléfono, y relleno para paginación). Si el
navegador soporta `navigator.storage.persist()`, se solicita almacenamiento
persistente automáticamente (el resultado queda logueado en consola). En cada
arranque posterior, si los datos de la demo quedaron "viejos" respecto a hoy
se re-siembran automáticamente (mitigación anti-congelamiento D1) — esto
**solo** ocurre en modo demo (`modo_demo=1`); en cuanto se importa un
respaldo propio, nunca más se re-siembra ni se toca un dato real.

## Respaldo

Botón **"Exportar respaldo"** / **"Importar respaldo"** en la pantalla
Resumen, sobre `exportarRespaldo()` / `importarRespaldo()` de `db.js`.
Importar reemplaza todos los datos actuales con confirmación explícita.

## Verificación

Hay dos suites de verificación, ejecutadas de verdad (no solo revisadas por
inspección de código):

### En el navegador, contra la DB real (`js/dev-verify.js`)

Agregá `?verify=1` a la URL (ej. `http://localhost:3000/?verify=1`) para
correr una batería de chequeos PASS/FAIL contra sql.js + IndexedDB reales:
esquema y `PRAGMA foreign_keys`, validaciones de `crearClienteConAcuerdo` /
`registrarCargo` / `registrarAbono` / `registrarAjuste`, cálculo de saldo,
reglas de negocio (mismo-día de `crearAcuerdo`, R-001, R-005, A-001), los 9
casos del seed, y 6+ casos borde del calendario. El resultado se ve en la
consola del navegador y en un panel al pie de la pantalla.

**Importante — DB aislada:** `?verify=1` corre sobre una base de IndexedDB
**separada** de la demo (`agus-db-verify`, con su propio lock de instancia),
que se borra y re-siembra limpia al inicio de **cada** corrida. La base de la
demo (`agus-app-almacen`) nunca se lee ni se escribe en modo verificación —
correr la suite las veces que haga falta no contamina los datos que le vas a
mostrar al dueño. La propia suite confirma esto en su último paso (chequea
que la demo no tenga ningún cliente `"...Verify"`).

### En Node, los módulos puros (`js/dev-verify-node.mjs`)

`calendar.js`, `seed.js` y las utilidades de `date.js`/`money.js`/`uuid.js`
son funciones puras (sin DOM, sin sql.js, sin IndexedDB) y se pueden correr
directo en Node, sin servidor ni navegador:

```bash
npm run verify:node
# o: node js/dev-verify-node.mjs
```

Esto cubre los mismos 6+ casos borde del calendario (sección 4.2 del plan) y
las validaciones de `money.js`/`date.js`/`uuid.js`/`seed.js`, pero **no**
reemplaza la suite del navegador: todo lo que toca `db.js` (SQL real,
transacciones, `PRAGMA foreign_keys`, persistencia) solo se verifica con
`?verify=1`, porque depende de sql.js + IndexedDB.
