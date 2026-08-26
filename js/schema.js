// DDL completo de la base de datos (contrato 2.2 del PLAN-MVP.md).
// Ejecutado por db.js en el primer arranque (cuando no existe una DB en IndexedDB).
//
// v2 (2.8, gate del dueño 25-ago-2026): acuerdos gana frecuencia de cobro
// configurable (DIARIA/SEMANAL/MENSUAL). Bases v1 existentes se migran en
// initDb() (ALTER TABLE, sin tocar datos) o en importarRespaldo() (migración
// en memoria antes de aceptar el archivo) usando MIGRACION_V1_A_V2 más abajo.

export const SCHEMA_VERSION = '2';

export const DDL = `
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
-- Índices compuestos (firmes por especificación)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_movimientos_cliente_fecha ON movimientos (cliente_id, fecha);
CREATE INDEX IF NOT EXISTS idx_movimientos_cliente_tipo  ON movimientos (cliente_id, tipo);
CREATE INDEX IF NOT EXISTS idx_acuerdos_cliente_vigencia ON acuerdos (cliente_id, vigente_desde);

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
