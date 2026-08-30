# PLAN MVP — App de Cobro Diario a Crédito

> Documento de planificación exhaustivo. No contiene código de aplicación (salvo el esquema SQL y pseudocódigo, explícitamente requeridos como contrato). Está pensado para ser auditado y ejecutado sin retomar decisiones ya cerradas.

---

## 1. Contexto

### 1.1 Resumen del negocio

El usuario (en adelante "el gestor") paga por adelantado servicios de terceros (agua, luz, internet, etc.) a crédito, y les cobra ese monto de vuelta mediante una **cuota fija diaria** hasta saldar la deuda. Hoy administra esto con una app genérica de finanzas personales que no está diseñada para este modelo de negocio:

- No genera reportes por cliente individual.
- Tiene un límite duro de 100 cuentas (cada cliente ocuparía una "cuenta"), insuficiente para escalar.
- No tiene un calendario que se pueda filtrar por cliente para ver día a día quién pagó y quién no.

### 1.2 Objetivo del MVP

Construir una **demo funcional en HTML/CSS/JS vanilla**, ejecutable en un navegador (servida localmente, no `file://`), que el gestor pueda probar con datos de ejemplo realistas y **aprobar antes de invertir en la construcción de la app real**. La app real reutilizará esta misma base de código y, en una fase posterior, se empaquetará con Capacitor para Android/iOS.

El MVP debe:
- Funcionar **100% offline** (sin backend, sin llamadas de red salvo cargar los archivos estáticos y, opcionalmente, el enlace `wa.me` que abre WhatsApp).
- Persistir datos localmente entre sesiones (recargar la página, cerrar y reabrir el navegador).
- Arrancar con datos de ejemplo (seed) que demuestren todos los estados y flujos relevantes, sin que el gestor tenga que cargar nada a mano para evaluarlo.
- Ser mobile-first, porque se va a demostrar en un teléfono o en una ventana angosta de escritorio.

### 1.3 Explícitamente FUERA de alcance del MVP

| Fuera de alcance | Razón |
|---|---|
| Empaquetado con Capacitor (Android/iOS nativo) | Es la fase siguiente, condicionada a que el dueño apruebe este MVP. |
| Sincronización entre dispositivos / backend en la nube | El MVP es de un solo dispositivo, offline, con export/import manual de archivo. |
| Generación de PDF real | El "Estado de cuenta" del MVP es una vista imprimible HTML (`window.print()`), no un PDF generado programáticamente. |
| Autenticación / PIN / multiusuario | Es una app de un solo gestor, un solo dispositivo físico controlado por él. |
| Envío automático de mensajes de WhatsApp (API oficial) | Se usa el enlace `wa.me` que abre WhatsApp con texto precargado; el envío lo hace el gestor manualmente. |
| Notificaciones push / recordatorios programados | No hay proceso en segundo plano en una demo HTML estática. |
| Edición o borrado físico de movimientos | El ledger es append-only por diseño; toda corrección es un contramovimiento tipo `AJUSTE`. |
| Reportes fiscales/contables, multi-moneda | No están en el problema de negocio descrito. |

---

## 2. Cambios propuestos

### 2.1 Estructura de archivos del proyecto

```
Agus-Soporte/
├── index.html                 # único punto de entrada (SPA con router simple por hash)
├── PLAN-MVP.md
├── css/
│   └── styles.css             # mobile-first, variables CSS para color semántico del calendario
├── js/
│   ├── app.js                 # bootstrap: initDb(), registra router, monta pantalla inicial "Hoy"
│   ├── router.js              # router por hash (#/hoy, #/clientes, #/clientes/:id, #/nuevo-movimiento, #/resumen)
│   ├── db.js                  # capa de acceso a datos (contrato detallado en 2.3)
│   ├── schema.js               # string con el DDL completo (CREATE TABLE + índices), usado por db.js en el primer arranque
│   ├── seed.js                 # datos de ejemplo (formato detallado en 2.6)
│   ├── calendar.js             # algoritmo de estados de calendario (pseudocódigo en 2.5), puro y testeable sin DOM
│   ├── utils/
│   │   ├── money.js            # formateo/parseo centavos <-> texto. Contrato: locale explícito es-MX vía Intl.NumberFormat ("$1,234.50" <-> 123450); el parseo acepta "1234.50", "1,234.50" y "$1,234.50" y rechaza todo lo demás con VALIDATION_ERROR
│   │   ├── uuid.js              # generador UUID v7
│   │   ├── date.js              # utilidades de fecha ISO (hoy(), sumarDias(), rango(), esFutura()). Contrato: hoy() se construye con componentes de fecha LOCAL del dispositivo (getFullYear/getMonth/getDate), JAMÁS toISOString().slice(0,10) — el negocio opera por día calendario local del gestor
│   │   └── whatsapp.js          # normalización de teléfono + construcción de enlace wa.me
│   ├── ui/
│   │   ├── pantalla-hoy.js
│   │   ├── pantalla-clientes.js
│   │   ├── pantalla-cliente-detalle.js
│   │   ├── pantalla-movimiento-form.js
│   │   ├── pantalla-resumen.js
│   │   └── componentes.js       # microcopy colapsable, toast de error, paginador, estado vacío, badge de color
│   └── vendor/
│       ├── sql-wasm.js          # sql.js
│       └── sql-wasm.wasm
└── assets/
    └── (íconos/ilustraciones simples si se necesitan para estados vacíos)
```

**Servidor local para la demo:** WASM no carga vía `file://`. La demo se levanta con `npx serve .` (o `python -m http.server`) desde la raíz del proyecto. Esto se documenta en un `README.md` corto o directamente en la pantalla de bienvenida si el gestor va a levantarlo él mismo; para la sesión de aprobación, el arquitecto/desarrollador lo deja corriendo.

### 2.2 Esquema SQL completo

Convenciones firmes aplicadas en las tres tablas:
- `id TEXT PRIMARY KEY` con UUID v7 generado en la app (no `AUTOINCREMENT`).
- `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`: ISO 8601 UTC con milisegundos, ej. `2026-08-25T14:30:00.000Z`.
- `deleted_at TEXT` (nullable): borrado lógico; `NULL` = activo.
- Montos en **enteros de centavos** (`INTEGER`), nunca `REAL`.
- Fechas de negocio (`fecha`, `vigente_desde`, `vigente_hasta`) son `TEXT` en formato `YYYY-MM-DD` (sin hora), porque el negocio opera por día calendario, no por instante.
- Sin `ON DELETE CASCADE`: las cascadas de borrado lógico las resuelve `db.js` explícitamente (ver 2.3).

```sql
-- ============================================================
-- clientes
-- ============================================================
CREATE TABLE IF NOT EXISTS clientes (
  id            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL CHECK (length(trim(nombre)) >= 2),
  telefono      TEXT,
  notas         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

-- ============================================================
-- acuerdos: cuota diaria pactada, con vigencia (historial de renegociaciones)
-- ============================================================
CREATE TABLE IF NOT EXISTS acuerdos (
  id                      TEXT PRIMARY KEY,
  cliente_id              TEXT NOT NULL REFERENCES clientes(id),
  monto_cuota_centavos    INTEGER NOT NULL CHECK (monto_cuota_centavos > 0),
  vigente_desde           TEXT NOT NULL,          -- YYYY-MM-DD
  vigente_hasta           TEXT,                    -- YYYY-MM-DD o NULL = indefinido/actual
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT,
  CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde)
);

-- ============================================================
-- movimientos: ledger append-only (CARGO, ABONO, AJUSTE)
-- ============================================================
CREATE TABLE IF NOT EXISTS movimientos (
  id                        TEXT PRIMARY KEY,
  cliente_id                TEXT NOT NULL REFERENCES clientes(id),
  tipo                       TEXT NOT NULL CHECK (tipo IN ('CARGO', 'ABONO', 'AJUSTE')),
  monto_centavos             INTEGER NOT NULL,
  -- Convención de signo: para CARGO y ABONO, monto_centavos es SIEMPRE > 0 (validado en la app).
  -- Para AJUSTE, monto_centavos representa el efecto directo y firmado sobre el saldo
  -- (positivo = aumenta deuda, negativo = la reduce), para poder compensar tanto CARGOs como ABONOs mal cargados.
  fecha                      TEXT NOT NULL,          -- YYYY-MM-DD, fecha de negocio (puede diferir de created_at)
  servicio                   TEXT,                    -- solo aplica a tipo=CARGO: 'AGUA' | 'LUZ' | 'INTERNET' | 'GAS' | 'CABLE' | 'OTRO'
  referencia                 TEXT,                    -- nº de factura/comprobante, opcional
  nota                       TEXT,
  movimiento_original_id     TEXT REFERENCES movimientos(id), -- solo aplica a tipo=AJUSTE
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  deleted_at                 TEXT,
  CHECK (
    (tipo IN ('CARGO','ABONO') AND monto_centavos > 0 AND movimiento_original_id IS NULL)
    OR
    (tipo = 'AJUSTE' AND monto_centavos != 0 AND movimiento_original_id IS NOT NULL)
  )
);

-- ============================================================
-- Índices compuestos (firmes por especificación)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_movimientos_cliente_fecha ON movimientos (cliente_id, fecha);
CREATE INDEX IF NOT EXISTS idx_movimientos_cliente_tipo  ON movimientos (cliente_id, tipo);

-- Índice de apoyo para resolver "acuerdo vigente en fecha X" rápido
CREATE INDEX IF NOT EXISTS idx_acuerdos_cliente_vigencia ON acuerdos (cliente_id, vigente_desde);

-- ============================================================
-- Tabla de metadatos del propio archivo (versión de esquema, para el import de respaldos)
-- ============================================================
CREATE TABLE IF NOT EXISTS meta (
  clave  TEXT PRIMARY KEY,
  valor  TEXT NOT NULL
);
-- Fila esperada tras crear el esquema: ('schema_version', '1')
```

**Fórmula de saldo (derivado, nunca almacenado)**, usada de manera consistente en `db.js` y en `calendar.js`:

```
efecto_saldo(movimiento) =
    +monto_centavos   si tipo = 'CARGO'
    -monto_centavos   si tipo = 'ABONO'
    +monto_centavos   si tipo = 'AJUSTE'   (ya viene firmado)

saldo(cliente, hasta_fecha?) = SUM(efecto_saldo) de todos los movimientos con deleted_at IS NULL
                                (y fecha <= hasta_fecha, si se especifica)
```
Saldo positivo = el cliente debe. Saldo negativo o cero = está al día o a favor.

### 2.3 Contrato de la capa `db.js`

Todas las funciones son `async` (sql.js es síncrono internamente pero se envuelve en promesas para aislar la capa y facilitar el reemplazo futuro por un driver nativo de Capacitor). Toda función que escribe llama internamente a `persistirEnIndexedDB()` (debounced ~500ms) al final de una transacción exitosa. Ninguna función atrapa errores silenciosamente: los relanza con un `code` (`VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `DB_ERROR`) para que la capa de UI los muestre siempre.

**Ciclo de vida / infraestructura**
- `initDb(): Promise<void>` — Carga `sql-wasm.wasm`, intenta abrir el archivo SQLite existente en IndexedDB; si no existe, crea uno nuevo ejecutando `schema.js` y corre `seed.js`. Ejecuta `PRAGMA foreign_keys = ON;` inmediatamente después de abrir/crear la DB (sql.js lo trae desactivado por defecto; sin esto las `REFERENCES` del esquema son decorativas) — aplica R-003. Adquiere un lock de instancia única con `navigator.locks.request('agus-db', {ifAvailable: true})`: si el lock ya está tomado (otra pestaña abierta), la app arranca en modo solo-lectura con un aviso permanente "La app ya está abierta en otra pestaña; cerrala para editar aquí" — aplica mitigación C2. Llama `navigator.storage.persist()` y registra el resultado (aceptado/rechazado) en un log visible en consola y, si fue rechazado, en un aviso discreto en la UI. Lanza `DB_ERROR` si `sql.js` no pudo inicializarse (ej. falta el `.wasm`), con mensaje explícito para diagnosticar (no una pantalla en blanco).
- `persistirEnIndexedDB(): Promise<void>` — Serializa la DB actual (`db.export()`) y la guarda en IndexedDB bajo una clave fija. Debounced para no escribir en cada tecla. Además, registra listeners de `pagehide` y `visibilitychange` (a hidden) que fuerzan un flush inmediato de cualquier escritura pendiente del debounce, para que cerrar la pestaña justo después de guardar no pierda el último movimiento — aplica mitigación C1.
- `exportarRespaldo(): Promise<{blob: Blob, nombreArchivo: string}>` — Igual export, pero devuelve un Blob descargable con nombre `respaldo-{YYYYMMDD-HHmm}.sqlite`.
- `importarRespaldo(arrayBuffer: ArrayBuffer): Promise<void>` — Abre el archivo recibido como una DB de sql.js y valida ANTES de reemplazar nada (aplica E1): (1) existe la tabla `meta` con `schema_version` **exactamente igual** a la de la app; (2) integridad mínima: cero movimientos con `cliente_id` huérfano y cero acuerdos con `cliente_id` huérfano. Solo si todo pasa, reemplaza la DB activa en memoria e IndexedDB y marca `modo_demo = 0`. Si algo falla, lanza `VALIDATION_ERROR` con mensaje "El archivo no es un respaldo válido de esta app" y **no** toca la DB activa.

**Clientes**
- `crearClienteConAcuerdo({nombre, telefono, notas, monto_cuota_centavos, vigente_desde}): Promise<{cliente, acuerdo}>` — Único punto de alta: crea el cliente y su primer acuerdo en una sola transacción SQL (`BEGIN`/`COMMIT`). Valida: `nombre` recortado con longitud >= 2; `monto_cuota_centavos` entero > 0; `vigente_desde` fecha ISO válida y no futura respecto a hoy. Si algo falla, `ROLLBACK` y lanza `VALIDATION_ERROR` con el campo específico.
- `listarClientes({busqueda, pagina, tamanioPagina}): Promise<{clientes: ClienteConSaldo[], total: number}>` — `ClienteConSaldo` = cliente + `saldo_centavos` (derivado) + `cuota_vigente_centavos` (del acuerdo activo, o `null`). Filtra `deleted_at IS NULL`. `busqueda` aplica `LIKE '%...%'` sobre `nombre` y `telefono` (case-insensitive). Paginado con `LIMIT`/`OFFSET`.
- `obtenerCliente(id): Promise<Cliente|null>`
- `actualizarCliente(id, {nombre?, telefono?, notas?}): Promise<Cliente>` — actualiza `updated_at`; no toca acuerdos.
- `borrarClienteLogico(id): Promise<void>` — Setea `deleted_at` en el cliente **y** en cascada lógica (manual, sin `ON DELETE CASCADE`) en sus acuerdos activos. Los movimientos históricos **no se tocan** (quedan como registro, pero el cliente deja de listarse en pantallas activas). Lanza `CONFLICT` si el cliente tiene saldo pendiente distinto de cero y no se pasó `{forzar: true}} (confirmación explícita en UI).

**Acuerdos**
- `crearAcuerdo({cliente_id, monto_cuota_centavos, vigente_desde}): Promise<Acuerdo>` — Si existe un acuerdo vigente para ese cliente sin `vigente_hasta`, lo cierra automáticamente poniendo `vigente_hasta = vigente_desde_nuevo - 1 día` dentro de la misma transacción, para que nunca haya dos acuerdos abiertos simultáneos. Regla explícita para el caso mismo-día (aplica R-004): si `vigente_desde_nuevo == vigente_desde` del acuerdo abierto, el acuerdo abierto se marca con `deleted_at` (fue reemplazado antes de gobernar un día completo — es una corrección, no una renegociación) y el nuevo lo sustituye; si `vigente_desde_nuevo < vigente_desde` del acuerdo abierto, se rechaza con `VALIDATION_ERROR` ("La nueva vigencia no puede ser anterior al acuerdo actual") ANTES de tocar la DB. Con esto el `CHECK (vigente_hasta >= vigente_desde)` nunca puede dispararse en runtime. Valida `monto_cuota_centavos > 0`.
- `listarAcuerdos(cliente_id): Promise<Acuerdo[]>` — ordenado por `vigente_desde` ascendente, incluye cerrados (para mostrar el historial de renegociaciones en el detalle del cliente).
- `obtenerAcuerdoVigente(cliente_id, fecha): Promise<Acuerdo|null>` — el que cumple `vigente_desde <= fecha AND (vigente_hasta IS NULL OR vigente_hasta >= fecha)`.

**Movimientos**
- `registrarCargo({cliente_id, monto_centavos, fecha, servicio, referencia, nota}): Promise<Movimiento>` — Valida: `monto_centavos` entero > 0; `servicio` ∈ enum fijo; `fecha` ISO válida y `<= hoy` (no se permiten cargos a futuro); `cliente_id` existe y está activo.
- `registrarAbono({cliente_id, monto_centavos, fecha, nota}): Promise<Movimiento>` — mismas validaciones de monto/fecha/cliente, sin `servicio`.
- `registrarAjuste({movimiento_original_id, delta_centavos, nota}): Promise<Movimiento>` — Valida que `movimiento_original_id` exista, no esté con `deleted_at`, y que su `tipo` sea `CARGO` o `ABONO` (no se ajustan ajustes, para no encadenar). `delta_centavos != 0`. `fecha` del ajuste = hoy. Se permiten VARIOS ajustes sobre el mismo movimiento original (correcciones parciales sucesivas son legítimas en un ledger; decisión R-010); la UI muestra todos vinculados al original. Este es el **único** mecanismo de "editar/borrar" un movimiento: nunca se hace `UPDATE`/`DELETE` sobre `monto_centavos` de un `CARGO`/`ABONO` ya creado.
- `listarMovimientos({cliente_id, desde?, hasta?, tipo?, pagina, tamanioPagina}): Promise<{movimientos, total}>` — orden `fecha DESC, created_at DESC`. Cada fila de `AJUSTE` se muestra vinculada visualmente a su `movimiento_original_id` en la UI.
- `calcularSaldo(cliente_id, hastaFecha?): Promise<number>` — aplica la fórmula de 2.2. `hastaFecha` opcional (por defecto, hoy) para poder calcular saldos "a una fecha" (usado por el calendario).

**Reportes / pantallas**
- `resumenDia(fecha): Promise<{totalEsperadoCentavos, totalCobradoCentavos, clientes: [{cliente_id, nombre, cuotaCentavos, abonadoHoyCentavos, estado}]}>` — para la pantalla "Hoy". Usa `calendar.js` internamente para el `estado` de cada cliente en esa fecha puntual. `totalCobradoCentavos` y `abonadoHoyCentavos` usan EXACTAMENTE la misma fórmula de crédito-por-día que `calendar.js` (`creditoPorFecha`: ABONO + efecto de AJUSTE), para que el número de "Hoy" nunca difiera del que sustenta el color del calendario (aplica R-007).
- `resumenMensual(anioMes: 'YYYY-MM'): Promise<{totalCargosCentavos, totalAbonosCentavos, carteraPendienteCentavos, porCliente: [{cliente_id, nombre, cargos, abonos, saldoFinMes}]}>`.
- `obtenerEstadoCalendario(cliente_id, fechaDesde, fechaHasta): Promise<Map<string, Estado>>` — delega en `calendar.js` (función pura), pasándole los acuerdos y movimientos ya consultados desde `db.js`.

**Utilitario de mensajería**
- `generarEnlaceWhatsApp(cliente_id): Promise<string>` — obtiene cliente + saldo, arma el texto (`"Hola {nombre}, tu saldo pendiente es de {saldo formateado}. ¡Gracias!"`), normaliza el teléfono (quita todo lo que no sea dígito) y devuelve `https://wa.me/{telefono_normalizado}?text={encodeURIComponent(texto)}`. Si el cliente no tiene teléfono cargado, lanza `VALIDATION_ERROR` ("Este cliente no tiene teléfono registrado") — la UI deshabilita el botón y muestra un tooltip en vez de dejar que falle en el click.

### 2.4 Especificación pantalla por pantalla

Navegación global: barra inferior fija (mobile-first) con 3 accesos — **Hoy** / **Clientes** / **Resumen** — más un botón flotante `+` (visible en Hoy y en Clientes) que lleva a **Registrar movimiento**. Cada pantalla tiene, arriba, un bloque de **microcopy didáctica colapsable** (`<details>` nativo o equivalente): título corto siempre visible ("¿Para qué sirve esta pantalla?") y contenido oculto por defecto con la explicación y modo de uso.

**Error boundary global (mitigación F2):** el render de cada pantalla en `router.js` va envuelto en `try/catch`; una excepción no capturada muestra un estado de error recuperable ("Algo salió mal. [Volver a Hoy]") con el detalle técnico en un `<details>` colapsado — nunca una pantalla en blanco ni un error solo en consola.

**1. Hoy (pantalla de inicio)**
- Encabezado con la fecha de hoy (formateada legible, ej. "Martes 25 de agosto") y navegación de un día atrás/adelante (para revisar días pasados) — el título deja claro cuando no es "hoy" ("Viendo: 24 de agosto").
- Resumen numérico: **Total esperado hoy** vs **Total cobrado hoy** (ambos en pesos, formato `$1,234.50`), y un tercer dato derivado: diferencia (positiva = falta cobrar). Si no hay ningún cliente con cuota vigente ese día, el resumen muestra `—` en vez de `$0.00` (null honesto).
- Lista de clientes con obligación vigente ese día, cada fila: nombre, cuota del día, badge de color con el estado (PAGADO/GRACIA-ADELANTO/PARCIAL/DEUDA), monto abonado hoy si lo hay. Tocar una fila navega al detalle del cliente.
- Estado vacío: si no hay clientes con cuota vigente ese día → mensaje "No hay cobros programados para hoy" (no una lista vacía muda).
- Validación: ninguna (pantalla de solo lectura + navegación).

**2. Clientes**
- Buscador de texto libre (nombre/teléfono), con debounce ~300ms.
- Lista paginada (tamaño de página fijo, ej. 20), cada fila: nombre, teléfono (o `—` si no tiene), saldo derivado con color (rojo si > 0, verde/gris si <= 0), cuota vigente (o `—` si no tiene acuerdo activo).
- Botón "Nuevo cliente" (FAB o botón fijo arriba) abre formulario de alta:
  - `nombre` (texto, requerido, mín 2 caracteres) — error inline si se envía vacío o muy corto.
  - `telefono` (texto, opcional, se recomienda con código de país; validación laxa: solo dígitos, espacios, `+`, `-`, longitud 7–20).
  - `notas` (texto libre, opcional).
  - `cuota diaria` (numérico, requerido, > 0, en pesos con hasta 2 decimales — se convierte a centavos antes de guardar).
  - `vigente desde` (fecha, requerida, default hoy, no puede ser futura).
  - Al confirmar, llama `crearClienteConAcuerdo`; si falla, muestra el error debajo del campo correspondiente (nunca un alert genérico ni un fallo silencioso).
- Estado vacío (sin resultados de búsqueda): "No se encontraron clientes para “{busqueda}”". Estado vacío real (sin clientes, imposible en el MVP por el seed, pero contemplado): "Todavía no hay clientes. Creá el primero."

**3. Detalle de cliente**
- Encabezado: nombre, teléfono, saldo actual grande y con color semántico, cuota vigente.
- Botones de acción: **Recordatorio WhatsApp** (deshabilitado + tooltip si no hay teléfono), **Estado de cuenta** (abre vista imprimible en una pestaña/sección aparte con `window.print()`, incluye nombre, período, tabla de movimientos y saldo final) y **Renegociar cuota** (aplica R-002): abre formulario con `nueva cuota diaria` (requerida, > 0, en pesos) y `vigente desde` (default hoy, no futura, no anterior al acuerdo actual — el error de `crearAcuerdo` se muestra inline); al confirmar llama `crearAcuerdo` y refresca el historial de acuerdos y el calendario.
- Calendario de estados: vista mensual (grilla de días) navegable mes a mes, coloreada según el algoritmo de 2.5. Tocar un día muestra el detalle de movimientos de ese día en un panel/acordeón. Leyenda de colores siempre visible junto al calendario, acompañada de la aclaración de alcance (aplica R-001): *"El calendario mide el cumplimiento de la cuota diaria. El saldo de arriba incluye además los servicios pagados (cargos)."* Los días en que entra en vigencia un cambio de cuota llevan un marcador visual con la nueva cuota (mitigación B2).
- Historial de movimientos paginado, más reciente primero, con filtro opcional por tipo (Todos/Cargos/Abonos/Ajustes). Cada fila de `AJUSTE` muestra una referencia visual ("Ajusta movimiento del {fecha}") al movimiento original.
- Botón "Registrar movimiento" preselecciona a este cliente en el formulario.
- Historial de acuerdos (cuotas históricas) visible en una sección secundaria colapsable, mostrando vigencias pasadas y la actual.
- Estado vacío: cliente sin movimientos → "Este cliente todavía no tiene movimientos registrados" (saldo mostrado como `—`, no `$0.00`).

**4. Registrar movimiento**
- Selector de cliente con buscador (si se llega desde el detalle de un cliente, viene preseleccionado y bloqueado con opción de "Cambiar").
- Selector de tipo: **Cargo** (le pagué un servicio) / **Abono** (me entregó dinero). Cambia los campos visibles.
  - Cargo: `monto` (requerido, > 0), `servicio` (select requerido: Agua/Luz/Internet/Gas/Cable/Otro), `referencia` (texto opcional), `fecha` (requerida, no futura, default hoy), `nota` (opcional, máx 280 caracteres).
  - Abono: `monto` (requerido, > 0), `fecha` (requerida, no futura, default hoy), `nota` (opcional, máx 280).
- Validación en tiempo real (al perder foco) y al enviar; errores inline junto a cada campo, mensaje general si el guardado falla por otra razón (ej. cliente inexistente).
- Confirmación visual clara tras guardar (toast "Movimiento registrado") y regreso al detalle del cliente.
- No existe botón "editar" ni "borrar" sobre movimientos existentes — coherente con el ledger append-only. Desde el historial, la acción disponible sobre un movimiento erróneo es "Corregir con ajuste", que abre un mini-formulario y llama `registrarAjuste`. El formulario NO pide un delta firmado en crudo (mitigación A3): pide un selector en lenguaje de negocio — "¿La corrección **aumenta** o **reduce** la deuda del cliente?" — más un monto siempre positivo y la nota; la UI arma el signo de `delta_centavos` internamente y muestra una previsualización del efecto ("El saldo pasará de $X a $Y") antes de confirmar.

**5. Resumen mensual**
- Selector de mes/año (default: mes actual).
- Totales del mes: **Cargos totales**, **Abonos totales**, **Cartera pendiente** (suma de saldos positivos de todos los clientes a fin del mes seleccionado), cada uno en pesos, `—` si no hay datos ese mes.
- Tabla por cliente: nombre, cargos del mes, abonos del mes, saldo a fin de mes, ordenable por columna (al menos por saldo descendente por defecto).
- Estado vacío: mes sin ningún movimiento → "No hay movimientos registrados en {mes}".

**6. Calendario (pestaña nueva — gate del dueño 25-ago-2026, mockup aprobado)**
- Cuarto acceso en la barra inferior: Hoy / **Calendario** / Clientes / Resumen. Ruta `#/calendario` (y `#/calendario/:clienteId`).
- Selector de persona arriba: opción por defecto **"Todas las personas"** + una entrada por cliente activo ("Nombre — cuota vigente"). Navegación de mes con ‹ › .
- **Modo una persona:** la misma grilla de estados del Detalle (mismo `calendar.js`), con dos adiciones: cada casilla muestra el monto abonado ese día (formateado corto, "—" si nada en día SIN_OBLIGACION), y arriba un resumen del mes: días pagados (PAGADO+GRACIA), días en deuda, total abonado del mes. Marcador de cambio de cuota y leyenda como en el Detalle. Tocar un día abre sus movimientos.
- **Modo todas las personas:** cada casilla del mes muestra `cumplieron/esperados` (clientes cuyo estado del día es PAGADO o GRACIA_ADELANTO, sobre clientes con obligación vigente ese día). Color: verde si cumplieron todos, amarillo si faltaron algunos, rojo si faltó la mitad o más (umbral aprobado por el dueño), neutro si nadie tenía obligación. Resumen del mes: días con cobro completo, días con faltantes, total cobrado. Tocar un día abre la lista del día: quién cumplió ✓ y quién no ✗ (con lo abonado), cada fila navega al detalle del cliente. Días futuros: sin conteo, "—" (null honesto).
- Datos: la agregación vive en `db.js` (`obtenerCalendarioGlobal(anioMes)`), NO en la UI; reutiliza `calendar.js` por cliente.

### 2.5 Algoritmo del calendario (pseudocódigo)

Función pura en `calendar.js`, sin acceso a DOM ni a la DB directamente (recibe los datos ya consultados, para poder testearla en aislamiento).

```
función calcularEstadosCalendario(acuerdos, movimientos, arrastreInicial, fechaDesde, fechaHasta):
    # acuerdos: lista de {vigente_desde, vigente_hasta, monto_cuota_centavos} ordenados por vigente_desde
    # movimientos: lista de {tipo, monto_centavos, fecha} de tipo ABONO o AJUSTE, ya filtrados
    #              a fechaDesde..fechaHasta (los CARGO no participan del cálculo de estado del día)
    # arrastreInicial: posición de CUMPLIMIENTO DE CUOTA acumulada justo ANTES de fechaDesde
    #                   (positivo = crédito, negativo = deuda de cuotas). NO es el saldo del ledger:
    #                   se calcula con un barrido histórico real desde el primer acuerdo del cliente
    #                   hasta fechaDesde - 1: sum(créditos por día: ABONO + efecto AJUSTE) - sum(cuotas
    #                   exigibles de cada día con acuerdo vigente). Usar la fórmula de saldo de 2.2 aquí
    #                   es INCORRECTO (los CARGO no participan del cumplimiento — decisión R-001) y produce
    #                   estados demasiado optimistas en clientes con tramos de incumplimiento.
    #                   (Corrección del gate 25-ago-2026: bug detectado por Builder B en verificación en vivo.)

    creditoPorFecha = agrupar_y_sumar(movimientos, clave = fecha, valor = -efecto_saldo(movimiento))
        # ABONO aporta +monto_centavos de crédito; AJUSTE aporta -monto_centavos de crédito (porque su
        # monto ya viene firmado con la MISMA convención que efecto_saldo)

    arrastre = arrastreInicial
    estados = mapa_vacío()

    para cada fecha en rango(fechaDesde, fechaHasta):
        acuerdoVigente = buscar(acuerdos, tal que vigente_desde <= fecha
                                  y (vigente_hasta es nulo o vigente_hasta >= fecha))

        si acuerdoVigente es nulo:
            estados[fecha] = SIN_OBLIGACION
            # el arrastre NO se modifica: un día sin cuota no genera ni consume obligación
            continuar

        cuota = acuerdoVigente.monto_cuota_centavos
        creditoDelDia = creditoPorFecha[fecha] o 0     # crédito aportado específicamente ese día (abonos/ajustes con esa fecha)
        disponible = arrastre + creditoDelDia           # crédito previo + lo que entró hoy
        arrastre = disponible - cuota                     # se consume la cuota del día; puede quedar negativo (deuda)

        si creditoDelDia >= cuota:
            estados[fecha] = PAGADO
        si_no si disponible >= cuota:
            estados[fecha] = GRACIA_ADELANTO      # no alcanzó solo, pero el arrastre previo cubre
        si_no si creditoDelDia > 0:
            estados[fecha] = PARCIAL               # abonó algo pero no alcanza ni con arrastre
        si_no:
            estados[fecha] = DEUDA                  # no abonó nada y no hay arrastre que cubra

    retornar estados
```

Notas de diseño del algoritmo:
- **Decisión de alcance (resuelve R-001, gate del dueño 25-ago-2026):** el calendario mide **cumplimiento de la cuota diaria**, NO saldo total. Los `CARGO` dentro del rango consultado deliberadamente NO descuentan del `arrastre` corriente: un servicio nuevo pagado por el gestor aumenta el saldo (que sí lo refleja de inmediato) pero no convierte en "rojos" días en los que el cliente sí cumplió su cuota. Son dos métricas distintas por diseño; la UI lo aclara con microcopy junto a la leyenda del calendario (2.4) y el caso de prueba correspondiente está en 4.2.
- **Regla de desempate (mitigación B1):** si por datos corruptos existieran dos acuerdos aplicables a la misma fecha, `buscar(acuerdos, ...)` toma el de `vigente_desde` más reciente (y entre iguales, el de `created_at` más reciente). No debe ocurrir con la regla mismo-día de `crearAcuerdo`, pero el algoritmo no puede quedar ambiguo ante datos importados.
- El `arrastre` se "resetea" conceptualmente en el primer día de un acuerdo nuevo del cliente: si el cliente es nuevo, `arrastreInicial = 0` porque no hay movimientos previos.
- Un cambio de cuota a mitad de rango simplemente hace que `cuota` cambie de valor en la fecha en que el nuevo acuerdo entra en vigencia; el `arrastre` sigue arrastrándose sin reiniciarse (una renegociación no borra el historial de crédito/deuda acumulado).
- Días `SIN_OBLIGACION` (antes del inicio del primer acuerdo, o en un hueco entre acuerdos si lo hubiera) no consumen ni generan arrastre — quedan "fuera" del barrido para efectos de deuda.
- El barrido es estrictamente cronológico (ascendente) y de una sola pasada — O(n) sobre los días del rango, con los movimientos ya agrupados en memoria por fecha (`creditoPorFecha`) para evitar recorrer la lista de movimientos día por día.

### 2.6 Formato del seed de datos de ejemplo

`seed.js` genera sus datos **dinámicamente relativos a `hoy()`** en el momento de sembrar (nunca fechas absolutas hardcodeadas), y se inserta dentro de una transacción al primer arranque (solo si la tabla `clientes` está vacía). Al sembrar se escribe `('modo_demo', '1')` en la tabla `meta`. **Re-sembrado automático anti-congelamiento (mitigación D1):** en cada `initDb()`, si `modo_demo = 1` y el movimiento más reciente de toda la DB tiene fecha anterior a ayer, se borra todo y se re-siembra relativo al `hoy()` actual — así la demo siempre luce "viva" aunque la reunión de aprobación sea días después de armarla. Este comportamiento aplica SOLO en modo demo: en cuanto el gestor importa un respaldo propio o se marca `modo_demo = 0`, jamás se re-siembra ni se toca un dato real. Composición mínima obligatoria:

- **8 a 10 clientes**, con nombres y teléfonos ficticios verosímiles (formato de teléfono consistente con lo que espera `whatsapp.js`).
- **Rango de ~2 meses de movimientos** (desde `hoy - 60 días` hasta `hoy`), con cuotas diarias variadas (ej. entre $20 y $150 pesos) para que los montos totales se vean realistas.
- Casos obligatorios a cubrir entre los clientes del seed, para que el calendario y el resumen se puedan validar visualmente sin escribir nada:
  1. Un cliente **siempre PAGADO** (abona su cuota todos los días).
  2. Un cliente con **GRACIA-ADELANTO** (adelantó varios días de una vez y luego no abona por un tramo, cubierto por el arrastre).
  3. Un cliente con **PARCIAL recurrente** (abona menos que la cuota casi todos los días, deuda creciendo lento).
  4. Un cliente en **DEUDA** franca (dejó de abonar hace semanas).
  5. Un cliente **nuevo a mitad del rango** (acuerdo con `vigente_desde` hace ~10 días, para ver `SIN_OBLIGACION` antes de esa fecha).
  6. Un cliente con **cambio de cuota** (dos acuerdos consecutivos con distinto `monto_cuota_centavos`, para ver el efecto en el calendario y en el historial de acuerdos).
  7. Al menos un cliente con **al menos un `AJUSTE`** en su historial (para validar que se ve vinculado al movimiento original y que no rompe el cálculo de saldo/calendario).
  8. Al menos un cliente **sin teléfono cargado** (para validar el estado deshabilitado del botón de WhatsApp).
  9. 1–2 clientes adicionales "de relleno" con datos mixtos, para que las listas y la paginación (si el tamaño de página es menor a 10) se puedan probar con más de una página si se reduce el tamaño de página a modo de prueba.
- Los `id` del seed se generan con el mismo `uuid.js` que usa la app (no hardcodeados), y las fechas `created_at`/`updated_at` de cada fila respetan el orden cronológico simulado (no todas con el instante de la inserción real).

### 2.7 Plan de respaldo / export (e import)

- Al primer `initDb()`, se solicita `navigator.storage.persist()`. El resultado (concedido/denegado) se loguea en consola; si es denegado, aparece un aviso no bloqueante ("El navegador podría liberar espacio si el dispositivo anda justo de memoria; te recomendamos exportar un respaldo seguido") en vez de fallar silenciosamente.
- Botón **"Exportar respaldo"**, visible desde el día uno en un punto fijo de la navegación (ej. en la pantalla Resumen o en un menú de "Ajustes" mínimo). Descarga un archivo `.sqlite` vía `exportarRespaldo()` + creación de un enlace `<a download>` temporal.
- Botón/entrada de archivo **"Importar respaldo"** en la misma sección: selecciona un `.sqlite` local, llama `importarRespaldo()`, y tras éxito recarga la app para reflejar los datos importados. Antes de importar, se le pide confirmación explícita al usuario ("Esto reemplaza todos los datos actuales por los del archivo. ¿Continuar?"), porque es una operación destructiva sobre el estado local.
- Este flujo de export/import es, en el MVP, también la única forma de "mover" datos entre dispositivos o de tener un respaldo fuera del propio navegador — se lo comunica así en la microcopy de esa pantalla.

### 2.8 Frecuencia de cobro configurable + pase visual (gate del dueño, 25-ago-2026)

Solicitado por el dueño tras probar la demo publicada. Decisión de negocio confirmada: **la deuda se acumula por fecha de cobro vencida** (un semanal que no paga su viernes debe esa cuota; a la siguiente semana, dos).

**Esquema (schema_version pasa de 1 a 2):**
- `acuerdos` gana: `frecuencia TEXT NOT NULL DEFAULT 'DIARIA' CHECK (frecuencia IN ('DIARIA','SEMANAL','MENSUAL'))`, `dia_semana INTEGER` (0=domingo..6=sábado, solo SEMANAL), `dia_mes INTEGER` (1..31, solo MENSUAL), con CHECK de coherencia (SEMANAL exige dia_semana no nulo; MENSUAL exige dia_mes; DIARIA exige ambos nulos).
- Migración en `initDb()`: si `schema_version = 1`, ALTER TABLE para agregar las columnas (default DIARIA) y actualizar `meta` a 2 — sin tocar datos. `importarRespaldo` acepta versión 1 o 2; si importa v1, migra en memoria antes de activar.

**Algoritmo (`calendar.js`):** nueva noción de **día exigible**: DIARIA = todos los días; SEMANAL = solo el `dia_semana`; MENSUAL = solo el `dia_mes` (si el mes no tiene ese día, el ÚLTIMO día del mes). El barrido consume cuota SOLO en días exigibles; los no exigibles no generan ni consumen arrastre y se pintan SIN_OBLIGACION (visualmente "neutro", no deuda). Los abonos de cualquier día siguen sumando crédito. `calcularArrastreCumplimiento` (db.js) aplica la misma regla. El resto de estados (PAGADO/GRACIA/PARCIAL/DEUDA) se evalúa igual pero solo en días exigibles.

**Contratos (`db.js`):** `crearClienteConAcuerdo` y `crearAcuerdo` aceptan `{frecuencia, dia_semana?, dia_mes?}` (default DIARIA) con validación completa (VALIDATION_ERROR claro por campo). `resumenDia`/pantalla Hoy: solo lista clientes con cobro EXIGIBLE ese día según frecuencia. `obtenerCalendarioGlobal`: `esperados` cuenta solo clientes exigibles ese día.

**UI:** formularios de alta y renegociación ganan selector de frecuencia (Diaria / Semanal con día de la semana / Mensual con día del mes), microcopy explicando el clamp de fin de mes; el chip/detalle del cliente muestra la frecuencia ("$200.00 cada viernes"). Calendario individual: días no exigibles en neutro suave.

**Seed:** se agregan 2 clientes — uno SEMANAL (viernes, con una semana pagada por adelantado → azul) y uno MENSUAL (día 31 → verifica visualmente el clamp en meses cortos).

**Verificación (tests en ROJO primero, protocolo completo):** (1) mensual día 31 en mes de 30 días → exigible el 30; (2) semanal que no paga 2 viernes → deuda de 2 cuotas acumuladas; (3) semanal que pagó doble la semana previa → viernes siguiente en GRACIA_ADELANTO; (4) cambio de frecuencia DIARIA→SEMANAL a mitad de mes → días posteriores solo exigibles los viernes, arrastre continuo; (5) migración v1→v2 preserva datos y `frecuencia='DIARIA'`; (6) import de respaldo v1 funciona; (7) Hoy solo lista exigibles del día.

**Pase visual (independiente, sin riesgo):** números del calendario más grandes (número de día y monto legibles en teléfono — el dueño reportó que "casi no se ven"), e iconos SVG inline propios (barra de navegación, badges de estado, botones de acción) en lugar de emoji/texto, para identidad visual consistente entre dispositivos.

### 2.9 REDISEÑO V2 "SENCILLO" — gate del dueño 28-ago-2026 (mockup de 5 pantallas aprobado)

> **Este es el contrato VIGENTE de la app y SUPERSEDE parcialmente a §2.4, §2.5 y §2.8.** Nada de lo aquí especificado se "simplifica" ni se borra por parecer raro: cada decisión salió de la retroalimentación directa del cliente final probando la demo v1. Su negocio se basa en CERCANÍA: cobros personalizados y manuales, sin cuotas fijas ni mensajes automáticos, con el gestor decidiendo todo. Estilo de uso: Excel — mínimos clics, los datos a la vista.

**SE RETIRA de la app (las specs anteriores quedan en este documento como historia, NO borrar):**
- Pantalla "Hoy" y pestaña "Calendario" global (§2.4-1, §2.4-6).
- Función de mensaje/recordatorio WhatsApp (`wa.me`) — generaba fricción con sus clientes.
- TODO el sistema de cuotas y frecuencias (§2.8): sin cuota pactada, sin días exigibles, sin estados PAGADO/GRACIA/PARCIAL/DEUDA. La tabla `acuerdos` se CONSERVA con sus datos (append-only, historia) pero deja de usarse; el alta de cliente ya no crea acuerdos.
- Navegación queda en 2 pestañas: **Clientes** (inicio) y **Resumen**.

**Esquema v3 (migración v2→v3 transparente, mismo patrón que v1→v2):**
- Nueva tabla `categorias(id, nombre UNIQUE-vivo, color TEXT, created_at, updated_at, deleted_at)`. Paleta FIJA de 12 colores (definida en componentes); los colores PUEDEN repetirse entre categorías.
- `clientes` gana `categoria_id TEXT NULL REFERENCES categorias(id)` y `orden INTEGER` (orden manual del gestor; nuevos clientes al final).
- Nueva tabla `conceptos(id, nombre, created_at, updated_at, deleted_at)` — catálogo EDITABLE de conceptos de cargo (reemplaza el enum fijo de `servicio`). Migración: sembrar conceptos desde los valores distintos ya usados en `movimientos.servicio`; los cargos siguen guardando el nombre del concepto en `movimientos.servicio` (texto) para no reescribir historia.
- `importarRespaldo` acepta v1/v2/v3 (migra en memoria).

**Pantalla 1 — Clientes (inicio):**
- Chips de filtro por categoría arriba (bolita + nombre, "Todos" default, chip "+ Nueva" crea categoría). Etiqueta "Filtrar por categoría". Mantener presionado un chip → editar/eliminar categoría (eliminar = borrado lógico; sus clientes pasan a "Sin categoría").
- Buscador (nombre/teléfono) como hoy.
- Lista AGRUPADA por categoría; dentro de cada grupo, ORDEN MANUAL: agarre ⋮⋮ con arrastre (long-press en táctil), persiste en `clientes.orden`, reordena solo dentro del grupo. Grupo final "Sin categoría".
- Fila de cliente: ⋮⋮ + bolita de categoría + nombre + botón **+Abono con el total de abonos del MES actual dentro** + botón **+Cargo con los cargos del MES** + saldo total (color semántico, "—" si sin movimientos). Cabecera fina "Abonos (mes) · Cargos (mes) · Saldo".
- Al final de cada grupo, fila **Σ {categoría}** (fondo sutil, nombre en el color de la categoría): suma de abonos del mes, cargos del mes y saldo del grupo, alineada bajo las columnas.
- Clic en el nombre → pantalla Persona. Clic en +Abono/+Cargo → panel rápido.

**Panel rápido (bottom sheet, 1 clic desde fila o desde Persona):**
- Abono: monto en grande (teclado numérico), fecha default hoy (editable, no futura), Guardar. 3 toques en total.
- Cargo: igual + fila de chips de concepto del catálogo con "+ Nuevo" para crear concepto al vuelo sin salir del panel. Concepto obligatorio. Referencia opcional (campo chico). Sin nota.

**Pantalla 2 — Persona (clic en el nombre):**
- Encabezado COMPACTO: ‹ nombre + bolita. El calendario es el protagonista (esta pantalla ES el reporte que el gestor manda por pantallazo a sus clientes — debe caber completa: tarjeta + mes entero).
- Tarjeta superior: botón **+Abonos $X (mes visible)** + botón **+Cargos $Y (mes visible)** (mismo patrón dato-es-botón; abren el panel rápido con el cliente preseleccionado) + **Saldo total histórico** como dato.
- Calendario mensual completo, **semana inicia LUNES**. Celdas: verde = día con abono (monto visible), rojo = día con cargo (**concepto + monto visibles en la celda**), mixto (degradado) = ambos, neutro = sin movimientos. Cada celda muestra además **"= $saldo" acumulado hasta esa fecha** (línea inferior discreta) — con **switch "Saldo diario en el calendario"** para mostrar/ocultar (preferencia persistente; el dueño no está seguro de que a su cliente le guste, por eso es opcional y NO se elimina).
- Clic en una fecha → **esa celda se agranda** (popover flotante sobre el calendario): fecha, movimientos del día con concepto y monto, saldo a ese día. Cierra con ✕ o tocando fuera. NO hay lista de movimientos permanente abajo.
- El saldo diario por celda se deriva con la fórmula de saldo de §2.2 acumulada por fecha (una sola pasada, nunca N queries).

**Pantalla 3 — Nueva categoría:** sheet con nombre + paleta de 12 colores (bolitas grandes, selección marcada). Si hay más de 12 categorías los colores se repiten — la bolita+nombre desambigua.

**Pantalla 4 — Nuevo cliente:** nombre (único obligatorio), teléfono opcional, categoría por chips (con "+ Nueva" inline), notas opcional. SIN cuota ni frecuencia. Entra al final de la lista de su grupo.

**Pantalla 5 — Resumen:** queda COMO ESTÁ hoy (totales del mes + tabla por cliente + Ajustes/Respaldo). La sumatoria por categoría vive en Clientes (decisión explícita del dueño), NO aquí.

**Verificación mínima obligatoria del rediseño (ejecutando):** Σ de cada grupo coincide con la suma manual de sus filas; abonos/cargos del mes en los botones coinciden con resumenMensual del cliente; saldo diario de las celdas coincide con calcularSaldo(cliente, fecha) para 3 fechas verificadas a mano; el orden manual sobrevive a F5 y a filtrar; migración v2→v3 preserva todo y siembra conceptos desde los servicios usados; el switch de saldo diario persiste; semana arranca en lunes (verificar con un mes cuyo día 1 sea domingo); panel rápido guarda en la fecha elegida.

### 2.10 ITERACIÓN V3 "EXCEL" — gate del dueño 28-ago-2026 (mockup v3 de 5 piezas aprobado; resuelve B-020 a B-026)

> Refina §2.9 tras el segundo round de feedback del cliente final. Mismo mandato: nada se borra por parecer raro.

**1. Clientes — filas Excel de UNA línea.** Cada cliente ocupa una sola línea: ⋮⋮ + bolita + nombre (elipsis si no cabe) + tres columnas alineadas: abonos del mes (VERDE), cargos del mes (ROJO), saldo. **El monto ES el botón**: tocar el verde abre el panel rápido de abono, el rojo el de cargo, el nombre abre Persona (se eliminan los botones "+Abono/+Cargo" de caja). Filas Σ por grupo con los mismos colores semánticos. Cabecera de columnas fina. Sección colapsable "📦 Archivados (n)" al final (colapsada por defecto): filas atenuadas con saldo y botón "↩ Restaurar" (regresa al final de su grupo con su historia intacta). Archivados fuera del buscador y de las Σ; su historia sigue en meses pasados de Global.

**2. Engrane ⚙️ (barra superior de Clientes) — Configuración de catálogos:** lista de CATEGORÍAS (bolita, nombre, nº de clientes, ✎ Editar → renombrar/cambiar color de la paleta/eliminar con confirmación; eliminar deja a sus clientes "sin categoría") y de CONCEPTOS (nombre, veces usado, ✎ Editar → renombrar/eliminar; eliminar lo saca del picker pero la historia conserva el texto). "+ Nueva/Nuevo" en cada sección. Resuelve B-020 y B-022.

**3. Teclado numérico INTEGRADO (B-024):** en el panel rápido, el monto se captura con keypad propio (dígitos, "00", punto, ⌫, y tecla grande "✓ Guardar"); el teclado del sistema NO debe aparecer (campo readonly/inputmode-none con display propio). Aplica a abono y cargo. La fecha sigue editable (default hoy).

**4. Persona (B-021 + B-025):** botón ✎ Editar en el encabezado → sheet con datos precargados (nombre único-vivo, teléfono, categoría por chips, notas) + zona "📦 Archivar cliente" (confirmación extra si saldo ≠ 0, usando el flujo forzar existente). Calendario AÚN más grande (celdas más altas); en celdas con cargo, CONCEPTO en una línea y MONTO en otra; saldo diario "= $" con su switch se conserva. Debajo del calendario: lista COMPLETA de movimientos del mes visible (fecha corta, tipo/concepto, monto con color); el popover del día sigue al tocar celda.

**5. Pestaña GLOBAL (B-026, reemplaza a "Resumen"):** nombre y propósito nuevos — el mes del negocio POR FECHA. Contiene: navegación de mes + 3 totales a color (Abonos/Cargos/Cartera) + calendario global con SOLO totales por día (suma de abonos en verde y de cargos en rojo, de todos los clientes; sin conceptos; celdas compactas) + al tocar un día, desglose de esa fecha: cada movimiento con nombre del cliente, concepto si es cargo, y monto (fila navega al cliente) + recordatorio de respaldo ("tu último respaldo fue hace N días" cuando N>7, con acción directa) + Ajustes/Respaldo + historia de archivados. Sin tabla por cliente (vive en Clientes). Complemento conceptual: Clientes = por persona, Global = por fecha.

**Capa de datos nueva requerida:** `restaurarCliente(id)` (limpia deleted_at, orden al final de su grupo); `listarClientesArchivados()`; `obtenerCalendarioGlobalMovimientos(anioMes)` → por día: {abonosCentavos, cargosCentavos, movimientos: [{cliente_id, cliente_nombre, tipo, concepto, montoCentavos}]} en pocas queries; `metaUltimoRespaldo` (fecha del último export, para el recordatorio). Lo demás ya existe.

**Verificación mínima (ejecutando):** montos-botón abren el panel correcto con el cliente correcto; keypad captura montos con decimales y "00" y jamás dispara el teclado del sistema (verificable: el input no recibe foco de sistema); archivar con saldo pide confirmación extra y el cliente desaparece de lista/buscador/Σ pero no de meses pasados de Global; restaurar lo regresa al final de su grupo; editar categoría (color) se refleja en bolitas/chips/Σ al instante; eliminar concepto lo saca del picker sin tocar cargos históricos; totales por día de Global == suma manual del desglose para 3 días; desglose navega al cliente; recordatorio de respaldo aparece con última fecha >7 días y desaparece tras exportar; filas de una línea sin desborde a 375px con nombres largos; Σ con colores correctos.

### 2.11 ROUND 4 — retro de Agustín (cliente final) vía WhatsApp, gate del dueño 30-ago-2026 (mockup aprobado)

**1. Clientes = trabajo del DÍA.** Navegador de fecha arriba (‹ Hoy · sáb 30 ago ▾ ›; ▾ abre date picker; adelante deshabilitado más allá de hoy). Columnas ABONOS y CARGOS muestran lo del DÍA visto; SALDO sigue siendo total histórico; Σ suma el día (saldo Σ = total). La captura (montos-botón y panel) registra EN EL DÍA VISTO.

**2. Semáforo de 3 estados por cliente-día (decisión de Agustín):** monto verde = abonó; **$0 gris = visitado y dijo "hoy no"** (dato real capturado); **"—" = sin visitar aún**. Para el $0 existe el registro ligero "visita sin abono": nueva tabla `visitas_sin_abono(id, cliente_id, fecha, created_at, updated_at, deleted_at)` (migración v3→v4, solo CREATE TABLE — el ledger no admite ABONO de 0 y esto NO es un movimiento de dinero). Se captura con botón "Hoy no abona ($0)" en el panel rápido de abono. Franja resumen del día sobre la lista: "Cobrado hoy: $X · N abonaron · M dijeron hoy no · K sin visitar".

**3. Corregir/eliminar movimientos (aprobado por el dueño — ajuste a la regla firme):** cada movimiento (en Persona y en el desglose de Global) tiene ✎ Corregir monto (teclado precargado) y 🗑 Eliminar (confirmación con datos). Implementación: BORRADO LÓGICO del original (+ nuevo movimiento en corrección, misma fecha/concepto/referencia). El ledger físico sigue append-only y auditable (deleted_at, nunca DELETE); la UI muestra el resultado limpio. El mecanismo AJUSTE queda deprecated en UI (el dato histórico con AJUSTEs se sigue mostrando bien).

**4. Deshacer:** toast tras cada acción (captura, visita-$0, corrección, eliminación) con "Deshacer" ~6s → revierte por borrado lógico/restauración. 

**5. Columna CARGOS colapsable al tap:** tap en el encabezado "CARGOS" la oculta dejando pestañita `‹C`; tap en la pestañita la reabre. Preferencia persistente (localStorage con try/catch).

**6. "+ Nuevo cliente" a la barra inferior:** barra queda Clientes · ＋Nuevo cliente (botón central) · Global. Se retira el botón azul superior.

**7. Sin `.00` en TODO el programa:** `formatearMoneda` muestra centavos solo cuando ≠ 0 ($1,250 / $1,250.50). Aplica a listas, Σ, calendarios, paneles, toasts, franja, Global.

**Verificación mínima:** captura en día pasado cae en ese día; los 3 estados se muestran y cuentan bien en la franja; visita-$0 se registra/deshace y NO afecta saldo; corrección cambia el monto visible y el saldo, y el original queda con deleted_at (verificable en DB); eliminar+deshacer restaura exacto; Σ del día cuadra a mano; columna cargos oculta/reaparece y persiste; sin ".00" en barrido de todas las pantallas (y "$1,250.50" conserva centavos); migración v3→v4 preserva todo; suite completa verde con tests actualizados al nuevo formato de dinero.

---

## 3. Análisis de riesgo

> Elaborado por un analista de riesgo independiente, sin participación en la planificación. Alcance: el **plan**, no el negocio. Cada riesgo especifica qué falla, cómo se manifiesta, probabilidad/impacto y mitigación concreta con su fase de aplicación en la sección 5.

### 3.1 FODA del plan

**Fortalezas**
- Contratos de `db.js` con firmas, validaciones y códigos de error explícitos (2.3): reduce el margen de interpretación al implementar.
- Ledger append-only + `AJUSTE` como único mecanismo de corrección: decisión contable sólida, evita `UPDATE`/`DELETE` silenciosos sobre historia.
- Plan de verificación (sección 4) con casos borde de calendario explícitos y comparación contra cálculo manual, no solo "probar que anda".
- Fases pequeñas con criterio de "hecho" ejecutable (sección 5), permite detectar desvíos temprano en vez de al final.
- El seed mapea 1 a 1 contra los estados de UI (2.6), lo que en principio facilita validar visualmente sin escribir datos a mano.

**Debilidades (del plan mismo)**
- El contrato de `db.js` define `crearAcuerdo` (renegociar cuota) pero ninguna pantalla de la sección 2.4 expone esa acción en la UI (ver 3.4, R-002).
- No define timezone para `hoy()`/fechas de negocio, crítico en una app que cobra "por día calendario".
- Declara `REFERENCES` en el esquema pero no activa `PRAGMA foreign_keys` en ningún punto del contrato de `initDb()`.
- No contempla el caso multi-pestaña de sql.js + IndexedDB (dos instancias en memoria del mismo archivo), riesgo que se hereda tal cual a Capacitor si no se resuelve ahora.
- El algoritmo del calendario (2.5) y la fórmula de saldo (2.2) pueden divergir entre sí dentro de la misma ventana de fechas (ver riesgo 3.2-A), y el plan no lo señala como una decisión de diseño explícita.

**Oportunidades**
- Al ser 100% offline con export/import ya diseñados, es barato agregar un "modo demo reseteable" (botón que borra y re-siembra con fecha relativa a hoy) que elimina de raíz el riesgo de seed desactualizado el día de la reunión.
- `calendar.js` ya está aislado como función pura (2.5): es fácil agregarle tests automatizados reales más adelante sin rediseñar nada, aunque el plan actual solo pida verificación manual (4.2).
- La convención de centavos enteros deja la puerta abierta a `Intl.NumberFormat` con poco esfuerzo adicional, resolviendo el riesgo de locale de forma prolija.

**Amenazas (externas al plan, pero que lo condicionan)**
- Dependencia de que el navegador del dueño soporte bien WASM + IndexedDB persistente (Android WebView viejo, Safari iOS con ITP agresivo).
- Que la sesión de aprobación (4.5) no ocurra el mismo día en que se terminó de armar la demo.
- El propio plan declara que "la app real reutilizará esta misma base de código": cualquier atajo tomado ahora (sin locks, sin FKs activas, sin timezone definida) se convierte en deuda técnica heredada directamente por Capacitor, no en algo descartable junto con la demo.

### 3.2 Modos de falla concretos

#### A. Esquema y convención de signos

- **A1 — El calendario y el saldo pueden divergir dentro de la misma ventana de fechas (ALTO / ALTO).** La fórmula de saldo (2.2) suma el efecto de `CARGO`, `ABONO` y `AJUSTE`. El algoritmo de calendario (2.5), en cambio, arma `creditoPorFecha` solo con `ABONO`/`AJUSTE` y arrastra ese crédito día a día — los `CARGO` **no** descuentan del `arrastre` corriente dentro del rango `fechaDesde..fechaHasta`, solo entran en el `arrastreInicial` (el saldo *antes* del rango). Consecuencia: si se registra un `CARGO` nuevo (el gestor paga otro servicio del cliente) en un día dentro de la ventana consultada, el saldo real (`calcularSaldo`) sube inmediatamente, pero el calendario sigue mostrando `PAGADO`/`GRACIA_ADELANTO` para los días siguientes como si esa deuda nueva no existiera, hasta que se vuelva a calcular `arrastreInicial` para una ventana posterior. Se manifiesta como: encabezado del cliente en rojo (saldo grande) mientras el calendario de abajo está en verde. Mitigación: decidir explícitamente si el calendario debe reflejar saldo total (restar los `CARGO` del `arrastre` igual que la `cuota`) o si es una métrica deliberadamente distinta ("cumplimiento de cuota", no "saldo total") — y en ese caso agregar microcopy junto al calendario que lo aclare, más un caso de prueba en 4.2 que compare explícitamente estados de calendario vs. `calcularSaldo()` cuando hay un `CARGO` intermedio. Se aplica en Fase 4 (algoritmo) antes de construir Fase 6 (UI que expone ambos números juntos).
- **A2 — CHECK de `acuerdos` puede violarse en tiempo de ejecución (ALTO / MEDIO).** `crearAcuerdo` cierra el acuerdo abierto poniendo `vigente_hasta = vigente_desde_nuevo - 1 día`. Si el gestor crea un segundo acuerdo el **mismo día calendario** que el primero (ej. corrige una cuota mal cargada minutos después de dar de alta al cliente), `vigente_hasta` queda un día **antes** de `vigente_desde` de esa misma fila, violando `CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde)`. Sql.js lanza una excepción de constraint cruda, no un `VALIDATION_ERROR` prolijo. Se manifiesta como: error técnico en consola / posible pantalla rota en vivo frente al dueño si el gestor prueba justamente ese flujo (corregir una cuota recién cargada). Mitigación: en el contrato de `crearAcuerdo` (2.3), definir explícitamente la regla para `vigente_desde_nuevo <= vigente_desde` del acuerdo abierto (ej. cerrar con `vigente_hasta = vigente_desde_nuevo`, mismo día, o rechazar con `VALIDATION_ERROR` claro antes de tocar la DB). Se aplica al implementar `crearAcuerdo`, que hoy no tiene fase asignada (ver R-002).
- **A3 — Signo de `AJUSTE` es invisible a la validación de la DB (MEDIO / MEDIO).** El `CHECK` solo exige `monto_centavos != 0`; no hay forma de que la base detecte un ajuste con el signo invertido (gestor quiso reducir deuda y aumentó, o viceversa). Como el ledger es append-only, un ajuste con signo equivocado solo se corrige con **otro** ajuste, quedando dos correcciones visibles en el historial de un cliente por un solo error humano. Mitigación: en `pantalla-movimiento-form.js`/mini-formulario de ajuste, no pedir un `delta_centavos` firmado en crudo — pedir "¿Aumenta o reduce la deuda?" + monto positivo, y que la UI arme el signo. Se aplica en Fase 3 (formulario de movimiento/ajuste).
- **A4 — Centavos y locale de formateo (MEDIO / MEDIO).** El documento usa el formato `"$1,234.50"` (coma=miles, punto=decimales, convención US) en una app en español pensada para un gestor de LatAm, donde la convención habitual es la inversa (`$1.234,50`). Si `money.js` no fija el locale explícitamente, un usuario que escribe `1.234,50` esperando que sea "mil doscientos treinta y cuatro con cincuenta" puede terminar cargando `$1.23` o un monto que falla silenciosamente el `CHECK (monto_centavos > 0)` por redondear a centavos erróneos. Mitigación: fijar `Intl.NumberFormat('es-AR', …)` (o el locale que corresponda al gestor real) como contrato explícito de `money.js`, con casos de prueba de parseo en 4.1. Se aplica en Fase 1.

#### B. Algoritmo de calendario — casos borde no cubiertos por 4.2

- **B1 — Acuerdos superpuestos por corrupción de datos (BAJO / ALTO).** Si por un bug de A2, un import corrupto, o una condición de carrera multi-pestaña (ver C2) llegan a existir dos acuerdos "vigentes" para el mismo cliente en la misma fecha, `buscar(acuerdos, ...)` no tiene una regla de desempate documentada (¿el primero encontrado? ¿el de `vigente_desde` más reciente?). El resultado es una cuota ambigua para ese día, sin error visible. Mitigación: agregar una regla de desempate explícita en el pseudocódigo de 2.5 (ej. tomar el de `vigente_desde` más reciente) y, más importante, blindar la causa raíz en A2. Se aplica en Fase 4.
- **B2 — Salto visual no explicado en cambio de cuota (BAJO / MEDIO).** El propio plan reconoce (nota de diseño en 2.5) que el arrastre no se reinicia al cambiar de acuerdo. Esto es correcto matemáticamente, pero produce un salto de color potencialmente contraintuitivo el día exacto del cambio (ej. un cliente que estaba en `GRACIA_ADELANTO` con la cuota vieja puede caer a `PARCIAL` el mismo día que sube la cuota, sin haber cambiado su comportamiento de pago). Mitigación: agregar microcopy en el detalle de cliente que indique la fecha de cambio de cuota sobre el propio calendario (ej. un marcador visual en el día de transición), y sumarlo como caso explícito en 4.2 con el resultado esperado documentado antes de correr la demo. Se aplica en Fase 6.

#### C. Persistencia (sql.js + IndexedDB)

- **C1 — Pérdida de la última escritura por debounce (MEDIO / MEDIO).** `persistirEnIndexedDB()` está debounced ~500ms. Si el gestor registra un movimiento y cierra la pestaña/navegador antes de que se cumplan esos 500ms, el cambio se pierde silenciosamente — no hay `beforeunload`/`visibilitychange` flush descripto en el contrato de 2.3. Se manifiesta en la demo como "cargué un movimiento y al recargar no está" (justo el caso que 4.3 promete verificar). Mitigación: agregar un flush síncrono en `beforeunload`/`pagehide` al contrato de `persistirEnIndexedDB`, documentado en 2.3. Se aplica en Fase 1.
- **C2 — Dos pestañas abiertas del mismo origen (MEDIO / ALTO).** sql.js mantiene la DB completa en memoria por pestaña; no hay lock ni `BroadcastChannel` mencionado. Si el gestor (o el dueño, curioseando en la demo) abre una segunda pestaña, cada una tiene su propia copia en memoria cargada al momento de abrir, y la última en escribir a IndexedDB pisa silenciosamente los cambios de la otra — sin ningún aviso. Riesgo bajo *durante* la demo controlada, pero **alto** en uso real y heredado tal cual a Capacitor (ver FODA). Mitigación: usar `navigator.locks` (Web Locks API) o `BroadcastChannel` para detectar una segunda instancia y avisar/bloquear escritura, definido en el contrato de `initDb()`. Se aplica en Fase 1, antes de dar el MVP por reutilizable en la fase Capacitor.
- **C3 — Vigencia de IndexedDB en iOS Safari (MEDIO / ALTO específicamente para el día de la demo).** Safari en iOS aplica políticas de retención agresivas (ITP) que pueden liberar almacenamiento local de un sitio sin interacción reciente del usuario (ventana típica: días de inactividad). Si la demo se arma un día y la reunión de aprobación (4.5) es días después en el teléfono del dueño, los datos —incluido el seed— pueden haber desaparecido. Mitigación: si el dispositivo de demo es iOS, probarlo el mismo día o el día anterior sin dejar pasar tiempo; tener siempre a mano el `.sqlite` exportado (Fase 9) para reimportar en el momento como red de seguridad. Se aplica como paso explícito del guion de Fase 11 / 4.5.

#### D. Seed

- **D1 — El seed "se congela" en el día en que se generó (ALTO / ALTO).** El seed se inserta una única vez, la primera vez que `clientes` está vacía, calculando el rango `hoy-60..hoy` en ese momento. Si la demo se arma un día X y la sesión de aprobación con el dueño (4.5) ocurre en un día X+n (muy probable: agendar una reunión toma días), el cliente "siempre PAGADO" del seed (2.6, caso 1) va a mostrar `n` días de `DEUDA` sin abonos, porque el seed nunca insertó movimientos después de X. Esto es exactamente el tipo de cosa que un dueño no técnico interpreta como "la app tiene un bug", en el peor momento posible. Mitigación: (a) documentar como paso obligatorio de Fase 11 borrar IndexedDB y recargar el mismo día de la reunión para re-sembrar con `hoy` actualizado, o (b) mejor, diseñar el seed para detectar en cada `initDb()` si los datos existentes están "viejos" respecto a hoy (ej. el último movimiento del cliente-caso-1 tiene más de 1 día) y, solo en ese caso, re-sembrar automáticamente. Se aplica en Fase 8 (diseño del seed) y como gate explícito antes de 4.5.

#### E. Export / Import

- **E1 — Import sobre base con datos reales ya cargados (ALTO si ocurre, MEDIO probabilidad).** El flujo pide confirmación explícita antes de reemplazar ("Esto reemplaza todos los datos actuales..."), lo cual es correcto, pero el contrato no especifica **qué tan estricta** es la validación de `schema_version` (¿exacta, o `>=`?) ni si se valida integridad referencial del archivo importado más allá de que exista la tabla `meta`. Un archivo con `schema_version` compatible pero filas huérfanas (ej. editado a mano, o de una versión futura con columnas extra) pasaría la validación descripta y reemplazaría datos reales sin más chequeo. Mitigación: definir explícitamente en 2.3 si `schema_version` debe matchear exacto, y agregar una verificación mínima de integridad post-import (ej. contar movimientos con `cliente_id` sin cliente correspondiente) antes de aceptar el reemplazo. Relacionado directamente con R-003 (FKs no activas). Se aplica en Fase 9.

#### F. Demo en vivo

- **F1 — Alcance de red para llegar del teléfono del dueño al servidor local (MEDIO / ALTO).** `npx serve .` corre en la laptop de quien demuestra; para que el teléfono del dueño lo vea necesita estar en la misma red y sin firewall/aislamiento de cliente (AP isolation, común en redes de oficina/comercio) bloqueando el tráfico entre dispositivos. Esto puede tirar la demo en el momento sin que sea un problema de la app. Mitigación: probar la conectividad teléfono-laptop en la red real del lugar de la demo **antes** del día de la reunión, y tener como plan B mostrar la demo directamente en la laptop en formato "ventana angosta" (ya contemplado como mobile-first alternativo en 1.2/2.4). Se aplica en Fase 11.
- **F2 — Falta de manejo global de errores (MEDIO / ALTO).** El plan especifica manejo de errores por función de `db.js` (códigos `VALIDATION_ERROR`/`NOT_FOUND`/`CONFLICT`/`DB_ERROR`) pero no menciona un error boundary global en el router/UI. Una excepción no capturada en cualquier pantalla puede dejar la SPA en blanco sin ruta de recuperación salvo recargar (y perder el estado de navegación), muy visible en una demo en vivo. Mitigación: agregar un `try/catch` global alrededor del render de cada pantalla en `router.js` que muestre un estado de error recuperable ("Algo salió mal, volver a Hoy") en vez de pantalla en blanco. Se aplica en Fase 0/1 (infraestructura del router).

### 3.3 Pre-mortem

1. **"La demo falló porque el calendario se veía verde y el saldo del cliente se veía rojo al mismo tiempo."** Causa: A1 (CARGO intermedio no descuenta del arrastre del calendario). Mitigación: definir y documentar el alcance del calendario (cumplimiento de cuota vs. saldo total) y agregar el caso de prueba correspondiente en 4.2. Fase: 4 (algoritmo) y 6 (UI).
2. **"El MVP se aprobó, pero cuando llegó la hora de armar la demo para el dueño no había forma de mostrarle en vivo el caso de 'cambio de cuota' porque no existe botón para renegociar la cuota de un cliente."** Causa: `crearAcuerdo` está en el contrato de `db.js` (2.3) y el seed exige el caso (2.6-6), pero ninguna pantalla de 2.4 lo expone, y no tiene fase asignada en la sección 5. Mitigación: agregar explícitamente a 2.4 (Detalle de cliente) una acción "Renegociar cuota" y asignarle una fase de construcción. Fase: nueva, antes de Fase 8 (el seed depende de que la lógica exista, aunque sea invocable sin UI).
3. **"La demo falló porque el cliente 'siempre PAGADO' del seed apareció en DEUDA."** Causa: D1, seed congelado en la fecha de generación, reunión de aprobación días después. Mitigación: re-sembrado obligatorio el mismo día de la demo, o auto-detección de datos viejos. Fase: 8 y gate en 11.
4. **"La demo se cortó con un error de SQLite en consola al crear un segundo acuerdo el mismo día para corregir un error de tipeo."** Causa: A2, CHECK de `vigente_hasta >= vigente_desde` violado por el cierre automático mismo-día. Mitigación: definir regla explícita para renegociación same-day en el contrato de `crearAcuerdo`. Fase: implementación de `crearAcuerdo` (ver punto 2).
5. **"El MVP se aprobó, pero el diseño escondía un problema que explotó en la fase Capacitor porque dos instancias de la app (o una pestaña de navegador owner-controlada + la app instalada) escribían sobre el mismo almacenamiento sin coordinación, y el gestor perdió movimientos de un día completo sin darse cuenta."** Causa: C2, ausencia de lock/aviso multi-instancia, heredado sin cambios porque "la app real reutiliza esta misma base de código" (1.2). Mitigación: agregar Web Locks/BroadcastChannel a la capa de persistencia **antes** de declarar la base de código lista para reutilizar en Capacitor, no después. Fase: 1.
6. **"El dueño probó la demo en su iPhone dos días antes de la reunión formal, y el día de la reunión formal la app abrió vacía, como si nunca hubiera existido nada."** Causa: C3, retención agresiva de almacenamiento en Safari iOS sin interacción reciente. Mitigación: instruir explícitamente probar en el mismo dispositivo el mismo día, y tener el respaldo `.sqlite` a mano para reimportar en vivo si hace falta. Fase: gate en 11/4.5.
7. **"La demo falló porque, al querer mostrar en vivo la corrección de un abono mal cargado, el ajuste tenía el signo invertido y el saldo del cliente aumentó en vez de bajar frente al dueño."** Causa: A3, `delta_centavos` firmado sin traducción a lenguaje natural en la UI. Mitigación: reemplazar el campo firmado por un selector "aumenta/reduce deuda" + monto positivo en el formulario de ajuste. Fase: 3.

### 3.4 Observaciones del auditor al plan

Hallazgos sobre otras secciones del plan. No se editan aquí — quedan a criterio del orquestador/dueño aplicarlos.

| ID | Severidad | Hallazgo | Qué cambiaría |
|---|---|---|---|
| R-001 | ALTA | El algoritmo de calendario (2.5) excluye `CARGO` del `arrastre` corriente dentro de la ventana consultada, mientras que `calcularSaldo` (2.2) sí los incluye — ambos pueden divergir para el mismo cliente y rango (ver 3.2-A1). | Definir explícitamente si el calendario debe reflejar saldo total o solo cumplimiento de cuota; documentarlo en 2.5 y en la UI (2.4); agregar caso de prueba en 4.2. |
| R-002 | ALTA | `crearAcuerdo` está definido en el contrato de `db.js` (2.3) y el seed exige un caso de "cambio de cuota" (2.6-6), pero ninguna pantalla de 2.4 expone una acción para renegociar la cuota de un cliente existente, y no tiene fase asignada en la sección 5. | Agregar a 2.4 (Detalle de cliente) una acción "Renegociar cuota" con su formulario, y asignarle fase explícita en la sección 5. |
| R-003 | ALTA | El esquema (2.2) declara `REFERENCES` en `cliente_id`, `movimiento_original_id`, etc., pero el contrato de `initDb()` (2.3) nunca menciona `PRAGMA foreign_keys = ON`. SQLite (y sql.js) lo tiene desactivado por defecto, por lo que esas referencias son decorativas tal como está especificado. | Agregar `PRAGMA foreign_keys = ON;` como paso explícito de `initDb()` en 2.3, y un checkbox de verificación en 4.3. |
| R-004 | ALTA | El cierre automático de acuerdos en `crearAcuerdo` (`vigente_hasta = vigente_desde_nuevo - 1 día`) puede violar el propio `CHECK (vigente_hasta >= vigente_desde)` de la tabla `acuerdos` cuando el nuevo acuerdo se crea el mismo día (o antes) que el `vigente_desde` del acuerdo abierto (ver 3.2-A2). | Definir en 2.3 la regla exacta para ese caso (cerrar mismo día en vez de día-1, o rechazar con `VALIDATION_ERROR` explícito antes de tocar la DB). |
| R-005 | MEDIA | El contrato de `date.js` (2.1) no especifica si `hoy()` usa fecha UTC o fecha local. Toda la lógica de negocio depende de "día calendario", que en husos horarios negativos (ej. Argentina, UTC-3) diverge de la fecha UTC durante varias horas cada noche. | Fijar explícitamente que `hoy()` debe construirse con componentes de fecha locales del dispositivo, no `toISOString().slice(0,10)`. |
| R-006 | MEDIA | El formato de dinero usado como ejemplo en todo el documento (`"$1,234.50"`) sigue la convención de EE.UU. (coma=miles, punto=decimales), inconsistente con la convención habitual en Argentina/LatAm para una UI enteramente en español. | Definir explícitamente el locale de formateo/parseo en el contrato de `money.js` (2.1), con `Intl.NumberFormat` del locale real del gestor. |
| R-007 | BAJA | El contrato de `resumenDia` (2.3) no aclara si `totalCobradoCentavos` incluye el efecto de los `AJUSTE` del día o solo `ABONO`, lo que puede generar un número distinto al que usa el calendario (`creditoPorFecha`) para el mismo día. | Aclarar en 2.3 que usa la misma fórmula de crédito por día que `calendar.js`. |
| R-008 | BAJA | No existe función `actualizarAcuerdo` ni mecanismo documentado para corregir un `vigente_desde` mal ingresado en el primer acuerdo de un cliente (`crearAcuerdo` exige que la nueva vigencia no sea anterior a la que cierra). | Documentar el procedimiento de corrección esperado, o agregarlo al backlog (sección 6) como ítem explícito. |
| R-009 | BAJA | El índice `idx_movimientos_cliente_tipo` no incluye `fecha`, por lo que las consultas del calendario (`cliente_id` + `tipo` + rango de `fecha`) no quedan totalmente cubiertas por índice. Irrelevante en volumen de MVP/seed. | Si la misma base de datos se reutiliza en producción con años de historial, evaluar `idx_movimientos_cliente_tipo_fecha`. |
| R-010 | BAJA | El contrato de `registrarAjuste` (2.3) no aclara si se permite más de un `AJUSTE` sobre el mismo `movimiento_original_id` (correcciones apiladas). | Aclarar si es intencional (correcciones parciales sucesivas) o si debería bloquearse/advertirse. |

### 3.5 Resolución de observaciones — gate del dueño (25-ago-2026)

El dueño aprobó la opción "a": aplicar correcciones y arrancar la construcción. Resolución aplicada por el orquestador:

| ID | Resolución |
|---|---|
| R-001 | APLICADA — decisión: el calendario mide cumplimiento de cuota, no saldo total (documentado en 2.5, microcopy en 2.4, caso de prueba en 4.2). |
| R-002 | APLICADA — acción "Renegociar cuota" agregada a 2.4 (Detalle) y a la Fase 6; casos de prueba en 4.1. |
| R-003 | APLICADA — `PRAGMA foreign_keys = ON` en `initDb()` (2.3) + verificación en 4.3. |
| R-004 | APLICADA — regla mismo-día / fecha-anterior definida en `crearAcuerdo` (2.3) + casos de prueba en 4.1. |
| R-005 | APLICADA — `hoy()` con fecha local del dispositivo (contrato en 2.1) + caso de prueba en 4.2. |
| R-006 | APLICADA — locale es-MX explícito en `money.js` (2.1). El formato `$1,234.50` ES la convención mexicana; queda como decisión, no como default heredado. |
| R-007 | APLICADA — `resumenDia` usa la misma fórmula de crédito-por-día que `calendar.js` (2.3). |
| R-008 | DIFERIDA — backlog B-018. |
| R-009 | DIFERIDA — backlog B-019 (irrelevante a volumen de MVP). |
| R-010 | RESUELTA — se permiten ajustes múltiples sobre el mismo original; documentado en `registrarAjuste` (2.3). |
| A3, B1, B2, C1, C2, D1, F2 | APLICADAS — mitigaciones incorporadas a 2.3/2.4/2.5/2.6 y a las fases 1, 6 y 8. |
| C3, E1, F1 | ACEPTADAS como pasos del guion de Fase 11 (ensayo, respaldo a mano, prueba de red previa); E1 además endurece `importarRespaldo` en Fase 9 con chequeo de huérfanos post-import. |

---

## 4. Plan de verificación

Filosofía: **lo que no se verificó ejecutando, no está hecho.** Cada punto de esta sección se ejecuta manualmente contra la demo corriendo (con `npx serve`), no se da por bueno por inspección de código.

### 4.1 Casos de prueba manuales por pantalla

**Hoy**
- [ ] Al abrir la demo por primera vez, la pantalla "Hoy" carga sin errores en consola y muestra clientes con cuota vigente en la fecha actual del seed.
- [ ] Navegar un día atrás y un día adelante actualiza correctamente la lista y el resumen numérico.
- [ ] Un día sin ningún cliente con cuota vigente muestra el estado vacío correcto, no `$0.00`.
- [ ] El total cobrado hoy coincide con la suma manual de los abonos de ese día en el seed.

**Clientes**
- [ ] La búsqueda por nombre parcial filtra correctamente (case-insensitive).
- [ ] La búsqueda por teléfono parcial filtra correctamente.
- [ ] Buscar un texto sin resultados muestra el estado vacío específico (no una lista en blanco).
- [ ] Alta de cliente: enviar el formulario vacío muestra errores inline en `nombre` y `cuota diaria` sin recargar la página.
- [ ] Alta de cliente con teléfono con letras es rechazada con mensaje claro.
- [ ] Alta de cliente exitosa aparece inmediatamente en la lista, con saldo `—` (sin movimientos aún).
- [ ] El saldo mostrado en la lista coincide con `calcularSaldo()` verificado a mano para al menos 2 clientes del seed.

**Detalle de cliente**
- [ ] El botón "Recordatorio WhatsApp" está deshabilitado (con tooltip) para el cliente del seed sin teléfono.
- [ ] El botón "Recordatorio WhatsApp" en un cliente con teléfono abre (o construye, verificable inspeccionando el `href`) una URL `wa.me` con el texto de saldo correcto.
- [ ] "Estado de cuenta" abre una vista imprimible legible con `Ctrl+P` / vista previa de impresión, sin elementos de navegación de la app mezclados.
- [ ] El calendario mensual pinta correctamente los 5 estados para los clientes de casos obligatorios del seed (comparando contra el resultado esperado documentado en 2.6).
- [ ] Tocar un día del calendario muestra el detalle de movimientos de ese día específico.
- [ ] El historial de acuerdos muestra correctamente las vigencias del cliente con cambio de cuota (2 filas, sin solape de fechas).
- [ ] "Corregir con ajuste" sobre un movimiento crea un `AJUSTE` visible en el historial, vinculado al original, y el saldo se recalcula de inmediato.
- [ ] "Corregir con ajuste" con el selector en "reduce la deuda" efectivamente BAJA el saldo (verifica que la UI arma bien el signo — mitigación A3).
- [ ] "Renegociar cuota" con vigencia hoy crea el nuevo acuerdo, cierra el anterior sin solape, y el calendario usa la cuota nueva desde hoy (R-002).
- [ ] "Renegociar cuota" dos veces el mismo día NO lanza error técnico: la segunda reemplaza a la primera con mensaje claro (R-004).
- [ ] "Renegociar cuota" con vigencia anterior al acuerdo actual es rechazada con error inline entendible.

**Registrar movimiento**
- [ ] Registrar un cargo con todos los campos válidos lo agrega al historial del cliente correcto, con el saldo actualizado.
- [ ] Registrar un cargo sin `servicio` seleccionado es rechazado con error inline.
- [ ] Registrar un abono con fecha futura es rechazado con mensaje claro.
- [ ] Registrar un movimiento con monto no numérico o negativo es rechazado antes de tocar la DB.
- [ ] Tras guardar, aparece confirmación visual y se regresa al detalle del cliente correspondiente.

**Resumen mensual**
- [ ] Cambiar de mes recalcula todos los totales.
- [ ] Un mes sin movimientos (ej. muy anterior al seed) muestra el estado vacío correcto.
- [ ] El total de "cartera pendiente" del mes coincide con la suma manual de saldos positivos de todos los clientes a esa fecha de corte.
- [ ] La tabla por cliente es ordenable por saldo.

### 4.2 Casos borde del calendario (verificación cruzada con cálculo manual)

Para cada caso, se documenta por escrito (antes de correr la demo) el resultado esperado día por día para una ventana de al menos 10 días, y se compara contra lo que renderiza la UI:

- [ ] **Adelanto puro:** cliente abona 5 cuotas de una vez un día, y no abona los 4 días siguientes → esos 4 días deben pintar GRACIA-ADELANTO, no DEUDA.
- [ ] **Pagos parciales acumulados:** cliente abona sistemáticamente el 60% de su cuota por varios días seguidos → el arrastre negativo debe crecer de forma monotónica y todos esos días deben pintar PARCIAL (no alternar con DEUDA por error de comparación).
- [ ] **Cliente nuevo a mitad de mes:** los días anteriores a `vigente_desde` de su primer acuerdo deben pintar SIN_OBLIGACION, y el arrastre no debe "heredar" nada de antes de esa fecha.
- [ ] **Cambio de cuota:** el día exacto del cambio de acuerdo debe usar la cuota nueva (no la vieja) al calcular `disponible`/`arrastre`, y el arrastre acumulado de días anteriores debe seguir aplicando sin reiniciarse.
- [ ] **Transición GRACIA-ADELANTO → DEUDA:** un cliente con crédito acumulado que se agota exactamente en un día puntual debe mostrar el cambio de color en el día correcto, ni uno antes ni uno después (verificar el borde `disponible == cuota` clasifica como PAGADO/GRACIA-ADELANTO, no como DEUDA).
- [ ] **Día con `AJUSTE` positivo (aumenta deuda) sobre un `ABONO` mal cargado:** el ajuste debe reducir el crédito efectivo de ese día en el calendario, no solo en el saldo agregado del detalle.
- [ ] **`CARGO` intermedio (decisión R-001):** registrar un `CARGO` nuevo en mitad de la ventana consultada NO cambia los colores del calendario de días donde la cuota se cumplió, pero el saldo del encabezado SÍ sube de inmediato; la microcopy junto a la leyenda explica la diferencia. Se verifica que ambos números coexisten sin parecer un bug.
- [ ] **Fecha local vs UTC (R-005):** con el reloj del sistema después de las 6pm (hora local UTC-6), un abono registrado "hoy" cae en el día calendario local correcto, no en el de mañana UTC.

### 4.3 Verificación de persistencia

- [ ] Cargar un cliente y un movimiento nuevos, recargar la página (`F5`) sin cerrar el navegador → los datos siguen presentes.
- [ ] Cerrar completamente el navegador (todas las ventanas) y volver a abrir la demo → los datos siguen presentes (confirma que la persistencia sobrevive más allá de la sesión de pestaña).
- [ ] Verificar en las DevTools (Application → IndexedDB) que existe el registro esperado tras cada escritura relevante.
- [ ] Confirmar en consola que `navigator.storage.persist()` fue concedido en el navegador/perfil usado para la demo; si fue denegado, confirmar que el aviso no bloqueante se muestra correctamente.
- [ ] Confirmar que `PRAGMA foreign_keys` devuelve `1` en la conexión activa (ejecutar `PRAGMA foreign_keys;` desde consola) — R-003.
- [ ] Registrar un movimiento y cerrar la pestaña inmediatamente (< 500ms) → al reabrir, el movimiento está (flush de `pagehide`, mitigación C1).
- [ ] Abrir una segunda pestaña de la demo → muestra el aviso de instancia única y no permite escribir (mitigación C2).
- [ ] Con `modo_demo = 1` y datos de seed viejos (simular cambiando la fecha del sistema o editando la DB), recargar re-siembra automáticamente con fechas frescas; con `modo_demo = 0`, jamás re-siembra (mitigación D1).

### 4.4 Verificación de export/import de respaldo

- [ ] Exportar respaldo descarga un archivo `.sqlite` con nombre y tamaño razonables (no 0 bytes).
- [ ] Vaciar manualmente el IndexedDB de la demo (DevTools) y volver a cargar la app → arranca con un estado nuevo (o con el seed, según corresponda) sin errores.
- [ ] Importar el archivo exportado en el paso anterior restaura exactamente los mismos clientes, movimientos y acuerdos (verificar al menos el saldo de 2 clientes antes/después).
- [ ] Intentar importar un archivo que no es un respaldo válido (ej. un `.txt` renombrado a `.sqlite`) es rechazado con mensaje claro, sin corromper la DB activa.

### 4.5 Gate final: validación visual en vivo con el dueño

- [ ] Sesión en vivo con el dueño, demo corriendo en un teléfono real o ventana angosta de escritorio, con el seed de datos de ejemplo (sin datos reales del negocio todavía).
- [ ] El dueño recorre las 5 pantallas sin guía, usando solo la microcopy colapsable como ayuda, y logra: encontrar un cliente, ver su calendario, entender los 4 colores de estado, registrar un movimiento de prueba, generar un enlace de WhatsApp y exportar un respaldo.
- [ ] Se recogen objeciones o dudas del dueño por escrito (no se resuelven en vivo salvo que sean triviales) y se transforman en ítems del backlog (sección 6) o en ajustes al propio plan si son bloqueantes para la aprobación.
- [ ] Aprobación explícita y verbal/escrita del dueño registrada como criterio de cierre del MVP, antes de iniciar cualquier trabajo de la fase Capacitor.

---

## 5. Orden de construcción

Cada fase es pequeña, verificable de forma aislada, y tiene un criterio de "hecho" ejecutable (no solo "el código está escrito").

**Fase 0 — Esqueleto del proyecto**
- Crear estructura de carpetas de 2.1, `index.html` vacío con `<div id="app">`, `vendor/sql-wasm.js`/`.wasm` copiados.
- *Hecho cuando:* `npx serve .` levanta el proyecto y `index.html` carga sin error 404 de ningún archivo estático.

**Fase 1 — Base de datos e infraestructura de persistencia**
- Implementar `schema.js`, `db.js: initDb()` (con `PRAGMA foreign_keys = ON` y lock de instancia única), `persistirEnIndexedDB()` (con flush en `pagehide`), `uuid.js`, `date.js` (fecha local), `money.js` (locale es-MX), y el error boundary global del router.
- *Hecho cuando:* al abrir la demo en consola se ve la DB creada, con las 4 tablas (`clientes`, `acuerdos`, `movimientos`, `meta`); `PRAGMA foreign_keys;` devuelve 1; recargar la página no recrea la DB desde cero; una segunda pestaña muestra el aviso de instancia única.

**Fase 2 — Clientes: CRUD mínimo + pantalla Clientes**
- `crearClienteConAcuerdo`, `listarClientes`, `obtenerCliente`, `actualizarCliente`, `borrarClienteLogico` en `db.js`; `pantalla-clientes.js` con lista, buscador, alta.
- *Hecho cuando:* se puede dar de alta un cliente desde la UI, verlo en la lista, buscarlo por nombre parcial, y sobrevive a un `F5` (casos de 4.1 "Clientes" pasan).

**Fase 3 — Movimientos: registrar cargo/abono + ajuste**
- `registrarCargo`, `registrarAbono`, `registrarAjuste`, `listarMovimientos`, `calcularSaldo` en `db.js`; `pantalla-movimiento-form.js`.
- *Hecho cuando:* se puede registrar un cargo y un abono para un cliente creado en la Fase 2, el saldo mostrado (aunque sea en una vista provisoria) coincide con el cálculo manual, y un ajuste sobre un movimiento existente se refleja correctamente.

**Fase 4 — Algoritmo de calendario (aislado, sin UI)**
- Implementar `calendar.js` puro según el pseudocódigo de 2.5, y `obtenerAcuerdoVigente`/`obtenerEstadoCalendario` en `db.js`.
- *Hecho cuando:* corriendo el algoritmo a mano (ej. desde la consola del navegador, invocando la función con datos de prueba armados a mano) contra al menos los 6 casos borde de 4.2, el resultado coincide con lo calculado manualmente en papel/hoja de cálculo.

**Fase 5 — Pantalla Hoy**
- `resumenDia` en `db.js`, `pantalla-hoy.js`, router apuntando a esta pantalla como inicio.
- *Hecho cuando:* los casos de prueba de "Hoy" en 4.1 pasan contra clientes/movimientos cargados manualmente en las fases anteriores.

**Fase 6 — Detalle de cliente completo**
- `pantalla-cliente-detalle.js`: saldo, historial, calendario visual (consume Fase 4) con microcopy de alcance y marcador de cambio de cuota, botón WhatsApp (`whatsapp.js`), vista imprimible de estado de cuenta, historial de acuerdos, y acción **Renegociar cuota** (R-002, consume `crearAcuerdo`).
- *Hecho cuando:* todos los casos de "Detalle de cliente" en 4.1 pasan, incluidos los 4 nuevos de renegociación y ajuste con signo.

**Fase 7 — Resumen mensual**
- `resumenMensual` en `db.js`, `pantalla-resumen.js`.
- *Hecho cuando:* los casos de "Resumen mensual" en 4.1 pasan.

**Fase 8 — Seed de datos de ejemplo**
- Implementar `seed.js` con los 8-10 clientes y casos obligatorios de 2.6, generación dinámica relativa a `hoy()`, marca `modo_demo` y re-sembrado automático anti-congelamiento (D1).
- *Hecho cuando:* al borrar el IndexedDB y recargar, la demo arranca poblada, cada caso obligatorio del seed se identifica visualmente en la UI, y el re-sembrado automático se verifica según 4.3.

**Fase 9 — Export/Import de respaldo**
- `exportarRespaldo`, `importarRespaldo` en `db.js`; UI de export/import con confirmación destructiva.
- *Hecho cuando:* pasan todos los casos de 4.4.

**Fase 10 — Pulido UX transversal**
- Microcopy colapsable en las 5 pantallas, mobile-first real (probado en ventana angosta/teléfono), estados vacíos y "null honesto" revisados pantalla por pantalla, paginación verificada con listas largas (forzar tamaño de página chico contra el seed para probarla), accesibilidad básica de color (no depender solo del color: agregar texto/ícono al badge de estado).
- *Hecho cuando:* pasa íntegramente el checklist de 4.1 (todas las pantallas) y el punto de accesibilidad de color queda verificado con captura o inspección visual.

**Fase 12 — Pestaña Calendario (post-aprobación de mockup, 25-ago-2026)**
- `obtenerCalendarioGlobal(anioMes)` en `db.js` (con tests en dev-verify: conteos correctos contra el seed calculados a mano, adelantos cuentan como cumplido, día sin obligaciones = neutro, días futuros excluidos) + `pantalla-calendario.js` con los dos modos del mockup aprobado + cuarto tab en el router.
- *Hecho cuando:* los conteos del modo global coinciden con la suma manual de estados por cliente para al menos 3 días del seed (uno verde, uno amarillo, uno rojo), el modo una-persona coincide con el calendario del Detalle para el mismo cliente/mes, y ambos modos pasan revisión en viewport 375px.

**Fase 11 — Ensayo general y gate final**
- Corrida completa de las secciones 4.1 a 4.4 sin encontrar fallos bloqueantes; export de respaldo de seguridad antes de la sesión real.
- *Hecho cuando:* se ejecuta 4.5 con el dueño y se obtiene su aprobación explícita, o se documentan los pendientes bloqueantes para una iteración siguiente antes de tocar Capacitor.

---

## 6. Backlog diferido

Ideas identificadas durante la planificación que quedan explícitamente fuera del MVP, con ID estable para referenciarlas más adelante sin perderlas.

| ID | Ítem |
|---|---|
| B-001 | Empaquetado con Capacitor para Android/iOS (app real instalable). |
| B-002 | Sincronización multi-dispositivo / respaldo automático en la nube. |
| B-003 | Generación de PDF real para el "Estado de cuenta" (en vez de vista imprimible del navegador). |
| B-004 | Autenticación / PIN de acceso a la app. |
| B-005 | Envío de recordatorios de WhatsApp vía API oficial (no solo enlace `wa.me` manual). |
| B-006 | Notificaciones push locales de cobros pendientes del día. |
| B-007 | Soporte multi-moneda. |
| B-008 | Exportación de reportes en formato contable/fiscal. |
| B-009 | Soporte multiusuario / roles (ej. varios cobradores bajo un mismo negocio). |
| B-010 | Vista avanzada de historial de renegociaciones de cuota (línea de tiempo visual). |
| B-011 | Gráficos de tendencia de cartera pendiente a lo largo del tiempo. |
| B-012 | Modo oscuro. |
| B-013 | Filtros combinados avanzados en la búsqueda de clientes (por rango de saldo, por estado del día, etc.). |
| B-014 | Recordatorios automáticos programados (requiere proceso en segundo plano, no disponible en HTML estático offline). |
| B-015 | Importación masiva de clientes desde CSV. |
| B-016 | Edición de datos del cliente (teléfono/nombre) con historial de cambios auditable, igual que los acuerdos. |
| B-017 | Confirmación de lectura/apertura del recordatorio de WhatsApp (no posible con el enlace `wa.me` simple). |
| B-018 | Mecanismo para corregir un `vigente_desde` mal ingresado en el primer acuerdo de un cliente (origen: R-008). |
| B-019 | Índice `idx_movimientos_cliente_tipo_fecha` si la base se reutiliza en producción con años de historial (origen: R-009). |
| B-020 | UI para renombrar/eliminar conceptos del catálogo (la capa de datos ya lo soporta; origen: A-103 de la auditoría v2). |
| B-021 | Edición de clientes + archivar/restaurar (pedido del dueño 28-ago-2026, EN ESPERA de más ítems antes de construir). Propuesta ya mockupeada: botón ✎ Editar en la pantalla Persona → sheet con datos precargados + zona "📦 Archivar cliente" (usa el borrado lógico existente, con confirmación extra si debe); sección colapsable "Archivados (n)" al final de Clientes con "↩ Restaurar" (regresa al final de su grupo). Archivados fuera de buscador y Σ; su historia sigue en Resumen "(baja)". Falta en datos: `restaurarCliente(id)`. |
| B-022 | UI completa de edición de categorías: cambiar nombre/color y eliminar (la capa de datos ya lo soporta con actualizarCategoria/borrarCategoriaLogica; hacerlo accesible y obvio, no solo long-press). Pedido del dueño 28-ago. |
| B-023 | Lista de Clientes en filas COMPACTAS estilo Excel: una sola línea por cliente (no tarjetas altas), y las filas Σ con colores semánticos (abonos en verde, cargos en rojo). Pedido del dueño 28-ago. |
| B-024 | Teclado numérico INTEGRADO en la app para montos (estilo Money Manager): el teclado del sistema no debe aparecer; keypad propio en el panel rápido. Pedido del dueño 28-ago. |
| B-025 | Calendario de Persona aún más grande; en las celdas con cargo, concepto y monto en LÍNEAS SEPARADAS; y debajo del calendario la lista COMPLETA de movimientos del mes visible (regresa la lista, ahora de todo el mes, no solo del día). Pedido del dueño 28-ago. |
| B-026 | Reestructura mayor: Clientes se convierte en LA vista-resumen principal (tabla compacta Excel con categorización, Σ con colores y captura en fila). PENDIENTE decisión del dueño: ¿la pestaña Resumen desaparece/se fusiona, o queda para los totales del mes + Ajustes/Respaldo? |
