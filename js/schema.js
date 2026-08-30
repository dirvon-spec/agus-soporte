// DDL completo de la base de datos (contrato 2.2 del PLAN-MVP.md).
// Ejecutado por db.js en el primer arranque (cuando no existe una DB en IndexedDB).
//
// v2 (2.8, gate del dueño 25-ago-2026): acuerdos gana frecuencia de cobro
// configurable (DIARIA/SEMANAL/MENSUAL). Bases v1 existentes se migran en
// initDb() (ALTER TABLE, sin tocar datos) o en importarRespaldo() (migración
// en memoria antes de aceptar el archivo) usando MIGRACION_V1_A_V2 más abajo.
//
// v3 (§2.9, gate del dueño 28-ago-2026 — REDISEÑO "SENCILLO"): se retira el
// sistema de cuotas/frecuencias de la UI (la tabla `acuerdos` se CONSERVA con
// sus datos, append-only, pero deja de usarse para altas nuevas). Entran
// `categorias` (para agrupar/filtrar clientes) y `conceptos` (catálogo
// editable que reemplaza el enum fijo de `servicio`), y `clientes` gana
// `categoria_id` + `orden` (orden manual dentro de su grupo). Migración
// v2->v3 en MIGRACION_V2_A_V3 más abajo, aplicada por db.js.
//
// v4 (§2.11, ROUND 4, gate del dueño 30-ago-2026): nueva tabla
// `visitas_sin_abono` para el semáforo de 3 estados por cliente-día
// (abonó / dijo "hoy no" / sin visitar). NO es un movimiento de dinero — el
// ledger no admite ABONO de $0, así que es una tabla aparte, sin impacto en
// saldos/calendarios. Migración v3->v4 en MIGRACION_V3_A_V4 más abajo (solo
// CREATE TABLE + índice, sin lógica de datos: la tabla nace vacía).

export const SCHEMA_VERSION = '4';

export const DDL = `
-- ============================================================
-- categorias (§2.9): agrupan/filtran clientes. nombre único solo entre
-- ACTIVAS (deleted_at IS NULL) — se aplica en la validación de db.js, no acá,
-- porque un UNIQUE de SQL bloquearía reusar un nombre tras borrado lógico.
-- Paleta de colores FIJA (12), definida en la capa de UI (js/ui/componentes.js);
-- db.js no la valida para no acoplarse a esa paleta.
-- ============================================================
CREATE TABLE IF NOT EXISTS categorias (
  id            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL CHECK (length(trim(nombre)) >= 1),
  color         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

-- ============================================================
-- conceptos (§2.9): catálogo editable de conceptos de cargo, reemplaza el
-- enum fijo de 'servicio'. Los cargos siguen guardando el NOMBRE del
-- concepto como texto en movimientos.servicio (no hay FK ahí) para no
-- reescribir historia si un concepto se borra o se crea después.
-- ============================================================
CREATE TABLE IF NOT EXISTS conceptos (
  id            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL CHECK (length(trim(nombre)) >= 1),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

-- ============================================================
-- clientes
-- ============================================================
CREATE TABLE IF NOT EXISTS clientes (
  id            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL CHECK (length(trim(nombre)) >= 2),
  telefono      TEXT,
  categoria_id  TEXT REFERENCES categorias(id),
  orden         INTEGER,
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
  frecuencia              TEXT NOT NULL DEFAULT 'DIARIA' CHECK (frecuencia IN ('DIARIA','SEMANAL','MENSUAL')),
  dia_semana              INTEGER CHECK (dia_semana IS NULL OR (dia_semana >= 0 AND dia_semana <= 6)), -- 0=domingo..6=sábado, solo SEMANAL
  dia_mes                 INTEGER CHECK (dia_mes IS NULL OR (dia_mes >= 1 AND dia_mes <= 31)),          -- 1..31, solo MENSUAL (clamp a fin de mes en meses cortos)
  vigente_desde           TEXT NOT NULL,
  vigente_hasta           TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT,
  CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde),
  CHECK (
    (frecuencia = 'DIARIA'  AND dia_semana IS NULL     AND dia_mes IS NULL)
    OR (frecuencia = 'SEMANAL' AND dia_semana IS NOT NULL AND dia_mes IS NULL)
    OR (frecuencia = 'MENSUAL' AND dia_semana IS NULL     AND dia_mes IS NOT NULL)
  )
);

-- ============================================================
-- movimientos: ledger append-only (CARGO, ABONO, AJUSTE)
-- ============================================================
CREATE TABLE IF NOT EXISTS movimientos (
  id                        TEXT PRIMARY KEY,
  cliente_id                TEXT NOT NULL REFERENCES clientes(id),
  tipo                       TEXT NOT NULL CHECK (tipo IN ('CARGO', 'ABONO', 'AJUSTE')),
  monto_centavos             INTEGER NOT NULL,
  fecha                      TEXT NOT NULL,
  servicio                   TEXT,
  referencia                 TEXT,
  nota                       TEXT,
  movimiento_original_id     TEXT REFERENCES movimientos(id),
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
-- visitas_sin_abono (§2.11): marca ligera de "visité y dijo hoy no" — NO es
-- dinero, no toca movimientos ni saldos. Vive aparte porque el ledger no
-- admite un ABONO de $0 (CHECK monto_centavos > 0 en movimientos).
-- ============================================================
CREATE TABLE IF NOT EXISTS visitas_sin_abono (
  id            TEXT PRIMARY KEY,
  cliente_id    TEXT NOT NULL REFERENCES clientes(id),
  fecha         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

-- ============================================================
-- Índices compuestos (firmes por especificación)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_movimientos_cliente_fecha ON movimientos (cliente_id, fecha);
CREATE INDEX IF NOT EXISTS idx_movimientos_cliente_tipo  ON movimientos (cliente_id, tipo);
CREATE INDEX IF NOT EXISTS idx_acuerdos_cliente_vigencia ON acuerdos (cliente_id, vigente_desde);
CREATE INDEX IF NOT EXISTS idx_clientes_categoria_orden  ON clientes (categoria_id, orden);
CREATE INDEX IF NOT EXISTS idx_visitas_sin_abono_cliente_fecha ON visitas_sin_abono (cliente_id, fecha);

-- ============================================================
-- Tabla de metadatos del propio archivo (versión de esquema, para el import de respaldos)
-- ============================================================
CREATE TABLE IF NOT EXISTS meta (
  clave  TEXT PRIMARY KEY,
  valor  TEXT NOT NULL
);
`;

/**
 * Migración v1 -> v2 (2.8): agrega las columnas de frecuencia a `acuerdos`
 * SIN TOCAR DATOS. Usada por db.js tanto en initDb() (bases locales v1
 * existentes) como en importarRespaldo() (migración en memoria de un archivo
 * v1 antes de aceptarlo) — una sola fuente de verdad para el ALTER TABLE.
 *
 * Limitación conocida y deliberada: SQLite no permite agregar un CHECK
 * multi-columna vía ALTER TABLE ADD COLUMN (solo CHECKs de una sola columna).
 * Por eso acá se agregan los CHECK de `frecuencia` (enum) y de rango de
 * `dia_semana`/`dia_mes` por columna, pero NO el CHECK de coherencia
 * cruzada (frecuencia vs. nulidad de dia_semana/dia_mes) que sí tienen las
 * bases nuevas creadas directo en v2 vía DDL. Para bases migradas, esa
 * coherencia la sigue garantizando exclusivamente la validación de
 * `crearClienteConAcuerdo`/`crearAcuerdo` en db.js — igual que ya ocurría
 * con la regla de `vigente_hasta >= vigente_desde` (R-004).
 */
export const MIGRACION_V1_A_V2 = [
  "ALTER TABLE acuerdos ADD COLUMN frecuencia TEXT NOT NULL DEFAULT 'DIARIA' CHECK (frecuencia IN ('DIARIA','SEMANAL','MENSUAL'))",
  'ALTER TABLE acuerdos ADD COLUMN dia_semana INTEGER CHECK (dia_semana IS NULL OR (dia_semana >= 0 AND dia_semana <= 6))',
  'ALTER TABLE acuerdos ADD COLUMN dia_mes INTEGER CHECK (dia_mes IS NULL OR (dia_mes >= 1 AND dia_mes <= 31))',
];

/**
 * Migración v2 -> v3 (§2.9): crea `categorias`/`conceptos` (tablas nuevas,
 * pueden llevar su CHECK completo porque CREATE TABLE no tiene la limitación
 * de ALTER TABLE ADD COLUMN) y agrega `categoria_id`/`orden` a `clientes`
 * SIN TOCAR DATOS existentes. Solo el DDL vive acá — el llenado de datos
 * (sembrar `conceptos` desde los `servicio` ya usados en movimientos, y
 * asignar `orden` inicial a los clientes existentes) requiere lógica en JS
 * y vive en `aplicarMigracionV2AV3()` en db.js, compartida por initDb() y
 * importarRespaldo() — mismo patrón que v1->v2 a nivel arquitectura (una
 * sola fuente de verdad), aunque acá no puede ser un array plano de SQL.
 */
export const MIGRACION_V2_A_V3 = [
  `CREATE TABLE IF NOT EXISTS categorias (
    id            TEXT PRIMARY KEY,
    nombre        TEXT NOT NULL CHECK (length(trim(nombre)) >= 1),
    color         TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    deleted_at    TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS conceptos (
    id            TEXT PRIMARY KEY,
    nombre        TEXT NOT NULL CHECK (length(trim(nombre)) >= 1),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    deleted_at    TEXT
  )`,
  'ALTER TABLE clientes ADD COLUMN categoria_id TEXT REFERENCES categorias(id)',
  'ALTER TABLE clientes ADD COLUMN orden INTEGER',
  'CREATE INDEX IF NOT EXISTS idx_clientes_categoria_orden ON clientes (categoria_id, orden)',
];

/**
 * Migración v3 -> v4 (§2.11): crea `visitas_sin_abono` (tabla nueva, nace
 * vacía) + su índice. Sin lógica de datos — a diferencia de v2->v3, acá no
 * hace falta backfill ni siembra, así que es un array plano de SQL puro,
 * mismo patrón que v1->v2.
 */
export const MIGRACION_V3_A_V4 = [
  `CREATE TABLE IF NOT EXISTS visitas_sin_abono (
    id            TEXT PRIMARY KEY,
    cliente_id    TEXT NOT NULL REFERENCES clientes(id),
    fecha         TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    deleted_at    TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_visitas_sin_abono_cliente_fecha ON visitas_sin_abono (cliente_id, fecha)',
];
