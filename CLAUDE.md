# CLAUDE.md — Agus-Soporte

App de cobro diario a crédito: un gestor paga servicios (agua/luz/internet) de sus clientes y les cobra una cuota fija diaria. MVP en HTML/JS vanilla + SQLite (sql.js), 100% offline. Fase siguiente: empaquetar con Capacitor (Android/iOS) reutilizando este mismo código.

**Lectura #1 obligatoria para cualquier agente nuevo: [STORY.md](STORY.md).** El contrato completo de diseño está en [PLAN-MVP.md](PLAN-MVP.md) (incluye decisiones cerradas del gate en §3.5 y backlog con IDs B-xxx en §6).

## Comandos

```bash
npx serve . -l 5173          # levantar la demo (WASM no carga con file://)
# suite de verificación en navegador: abrir http://localhost:5173/?verify=1 y leer la consola (40 checks)
npm run verify:node          # módulos puros (calendar, money, date, uuid, seed) en Node (19 checks)
```

`?verify=1` usa una base de IndexedDB AISLADA (`agus-db-verify`, se recrea limpia en cada corrida) — jamás toca la base de demo.

## Arquitectura (capas — no cruzarlas)

- `js/db.js` — ÚNICA puerta a los datos. La UI jamás ejecuta SQL. Errores siempre relanzados con `{code}` (`VALIDATION_ERROR`/`NOT_FOUND`/`CONFLICT`/`DB_ERROR`), nunca tragados.
- `js/calendar.js` — algoritmo de estados PURO (sin DOM ni DB). El calendario mide CUMPLIMIENTO DE CUOTA, no saldo del ledger (decisión R-001; son métricas distintas por diseño).
- `js/schema.js` / `js/seed.js` — DDL y seed dinámico relativo a hoy (re-siembra solo en `modo_demo`).
- `js/utils/` — money (centavos ↔ texto, locale es-MX fijo), date (`hoy()` = fecha LOCAL, jamás UTC), uuid (v7), whatsapp.
- `js/router.js` + `js/ui/pantalla-*.js` — una pantalla por archivo, componentes compartidos en `ui/componentes.js`. Error boundary global: nunca pantalla en blanco.

## Reglas firmes (no re-decidir)

- Dinero: SIEMPRE enteros en centavos. Nunca flotantes.
- Ledger append-only: movimientos no se editan ni borran; se compensan con `AJUSTE` (firmado, vinculado al original). Saldos SIEMPRE derivados, nunca almacenados.
- Borrado de entidades: lógico (`deleted_at`), cascadas manuales en `db.js` (sin `ON DELETE CASCADE`). Los reportes mensuales incluyen la historia de clientes dados de baja (hallazgo A-001).
- Null honesto en UI: sin dato = "—", jamás $0.00 inventado. Color = semántica del dato.
- Todo cambio se verifica EJECUTANDO (suite `?verify=1` + Node). Hallazgo serio → test en ROJO antes del fix. La suite completa, no solo el módulo tocado.

## Cicatrices (cómo cazarlas si vuelven)

1. **sql.js apaga `PRAGMA foreign_keys` como efecto secundario de cada `db.export()`.** Por eso existe `exportarBytesDb()` en db.js que re-afirma el pragma tras cada export. Si las FKs "dejan de funcionar", revisar que ningún código llame `db.export()` directo.
2. **`arrastreInicial` NO es `-saldo`.** El arrastre del calendario se computa con barrido histórico de cuotas vs créditos (`calcularArrastreCumplimiento`). Usar la fórmula del saldo produce estados demasiado optimistas en clientes con tramos de incumplimiento. Tests: sección 6b de dev-verify — las ventanas de prueba DEBEN arrancar a mitad de historial (las que arrancan en arrastre 0 no atrapan este bug).
3. **Los tests de calendario con ventanas "desde el inicio" son ciegos** al bug anterior — toda prueba nueva de calendario debe incluir al menos un caso con historial previo a la ventana.
