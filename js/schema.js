// DDL completo de la base de datos (contrato 2.2 del PLAN-MVP.md).
// Ejecutado por db.js en el primer arranque (cuando no existe una DB en IndexedDB).

export const SCHEMA_VERSION = '1';

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
  vigente_desde           TEXT NOT NULL,
  vigente_hasta           TEXT,
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
