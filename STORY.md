# STORY — Nacimiento de Agus-Soporte

*25 de agosto de 2026. Lectura #1 para cualquier agente o persona que se sume al proyecto.*

## El problema real

Hay una persona (el gestor) que vive de esto: paga los servicios de otras personas — agua, luz, internet — con su propio dinero, a crédito, y les cobra de vuelta una cuota fija todos los días hasta saldar. Su herramienta era una app genérica de finanzas personales (Money Manager) que le quedó chica en tres puntos exactos: no genera reportes por cliente, tiene tope de 100 cuentas, y no tiene un calendario filtrado por cliente para ver de un vistazo "¿ya me pagó hoy?". De ahí nace este sistema: no es una app de finanzas, es una **cartera de cobranza**.

## Qué se decidió y por qué

**HTML primero, y no es prototipo desechable.** El dueño exige aprobar viendo antes de invertir. Se eligió deliberadamente un stack (HTML/JS vanilla + sql.js) en el que el MVP de aprobación ES la app final: Capacitor lo empaqueta tal cual a Android/iOS y solo se intercambia la capa de persistencia. La decisión se validó con una investigación de 4 agentes con fuentes (agosto 2026) y se contrastó contra una investigación independiente de otro modelo LLM que proponía Dexie/IndexedDB — se mantuvo SQLite porque el requisito era SQL, porque iOS purga IndexedDB, y porque el propio análisis rival admitía que terminaría migrando a SQLite.

**El dinero es sagrado, la estructura lo protege.** Centavos enteros (jamás flotantes), ledger append-only (un movimiento no se edita: se compensa con un AJUSTE vinculado), saldos siempre derivados. Esquema nacido listo para sincronizar algún día: UUID v7, `created_at`/`updated_at`, borrado lógico.

**El calendario es la pantalla que vende el producto** — y también donde vivió el bug más importante (ver cicatrices). Mide *cumplimiento de cuota* con saldo de arrastre (estados PAGADO / GRACIA-ADELANTO / PARCIAL / DEUDA / SIN OBLIGACIÓN), no el saldo del ledger. Son dos números distintos a propósito, y la UI lo explica.

## Cómo se construyó (el proceso importa tanto como el código)

Metodología del dueño del proyecto: plan escrito antes de codear; análisis de riesgo por un agente que NO planificó; el que codea nunca se audita a sí mismo; hallazgo serio se reproduce con test en ROJO antes del fix; los auditores mutan los fixes para confirmar que los tests no son placebo. Ese proceso, en esta primera construcción, cazó de verdad:

- **El bug del arrastre** (spec del plan errónea): el arranque del arrastre se calculaba desde el saldo del ledger; el cliente de demo "en DEUDA franca" salía en azul de adelanto. Lo encontró el builder de UI usando la app, lo reprodujo, NO lo parchó (no era su capa), y el fix entró con 3 tests rojo→verde. El auditor después mutó el fix y confirmó que los tests lo detectan.
- **sql.js apaga `PRAGMA foreign_keys` en cada export** — la integridad referencial se habría desactivado silenciosamente tras el primer guardado. Solo se descubrió *ejecutando*.
- **`resumenMensual` mentía** tras dar de baja un cliente (su historia desaparecía de meses cerrados) y **la suite de verificación contaminaba la demo** con clientes de prueba. Ambos del auditor independiente, ambos corregidos con evidencia.

Cifra final de esta etapa: 40/40 checks en navegador + 19/19 en Node, con seguridad verificada (XSS escapado en todas las superficies, SQL con parámetros bindeados).

## Estado al cierre de esta historia

MVP completo (5 pantallas, seed demo auto-renovable, export/import de respaldo), pendiente de la validación en vivo del dueño (gate §4.5 del plan). Fuera de alcance todavía: Capacitor (B-001), sync en la nube (B-002), PDF real (B-003) — backlog completo en PLAN-MVP.md §6.

## Evolución del producto

*Esta sección crece con cada cambio de alcance aprobado por el dueño. Registra el qué y el porqué de negocio, no el cómo técnico (eso vive en PLAN-MVP.md y en los commits).*

**25-ago-2026 — Pestaña Calendario de primer nivel.** Al probar la demo publicada, el dueño detectó que la vista central de su app anterior — el calendario grande del mes — quedaba escondida dentro del detalle de cada cliente. Se agregó la pestaña "Calendario" con mockup aprobado antes de construir: modo por persona (grilla de estados + monto abonado por día) y modo "todas las personas" (cuántos cumplieron de cuántos esperados por día, con lista ✓/✗ al tocar). El umbral del rojo global (faltó la mitad o más) fue decisión explícita del dueño.

**25-ago-2026 — Buscador de clientes en el selector.** El usuario final maneja más de 100 clientes; un menú desplegable no escala. El selector de persona se convirtió en buscador con filtro por nombre/teléfono y paginación (componente compartido con el formulario de movimientos). Probado con 130 clientes reales: búsqueda fluida y calendario global en ~30 ms.

**25-ago-2026 — Frecuencia de cobro configurable (cambio de modelo de negocio).** El dueño aclaró que el cobro no siempre es diario: hay clientes que pagan un día específico del mes o cada semana, y cada cliente varía. Decisión de negocio confirmada por el dueño: la deuda se acumula por fecha de cobro vencida (el semanal que no paga su viernes debe esa cuota; a la semana siguiente, dos). El acuerdo de cada cliente gana frecuencia Diaria / Semanal (día de la semana) / Mensual (día del mes, con ajuste a fin de mes en meses cortos), la cuota se exige solo los días que tocan, y la pantalla Hoy pasa a listar únicamente a quienes les toca cobrar ese día. Es el primer cambio que amplía el modelo de datos después de la publicación (schema_version 1 → 2, con migración transparente). En el mismo lote: números del calendario más grandes (legibilidad en teléfono reportada por el dueño) e iconos SVG propios en lugar de emoji, para identidad visual consistente.

**28-ago-2026 — PIVOTE V2 "SENCILLO" (el cambio más grande de la historia del producto).** El cliente final probó la demo v1 y su veredicto reordenó todo: quiere algo mucho más sencillo y a su medida. Su negocio se basa en la CERCANÍA — cobros personalizados acordados de palabra con cada quien — y las cuotas fijas, frecuencias y recordatorios automáticos de WhatsApp le generaban fricción con sus clientes, no valor. Se retiran: pantalla Hoy, calendario global, mensajes WhatsApp y todo el sistema de cuotas/frecuencias (que habíamos construido apenas 3 días antes — el costo de descubrirlo en demo HTML fue horas; descubrirlo con el APK publicado habrían sido semanas). Entra: Clientes como pantalla única de trabajo estilo Excel (categorías con bolitas de color creadas por él, orden manual arrastrando, botones +Abono/+Cargo con los montos del mes adentro, sumatoria Σ por categoría), captura en 1 clic, catálogo de conceptos editable, y el calendario de la persona como REPORTE: mes completo iniciando en lunes, movimientos con concepto en las celdas, saldo acumulado por día (con switch para ocultarlo), celda que se agranda al tocarla. El gestor manda el pantallazo de esa pantalla a sus clientes — esa transparencia ES el producto. Las especificaciones retiradas se conservan en PLAN-MVP.md como historia: se quitaron por decisión de negocio del dueño, no porque estuvieran rotas — que nadie las "repare" de vuelta ni las borre pensando que fueron un error.

## Para el que viene después

Lee [CLAUDE.md](CLAUDE.md) (reglas y cicatrices operativas) y [PLAN-MVP.md](PLAN-MVP.md) (el contrato). No rompas el ledger, no metas flotantes al dinero, no toques el calendario sin correr los casos de ventana-a-mitad-de-historial, y no des nada por hecho que no hayas visto correr.
