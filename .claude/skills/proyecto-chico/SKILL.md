---
name: proyecto-chico
description: Flujo completo para construir un proyecto chico de software (MVP web offline-first o similar) con agentes — desde la idea hasta producción con rounds de retro del cliente final. Usar cuando el usuario diga que quiere arrancar un proyecto nuevo pequeño, un MVP, o "hazlo como Agus-Soporte".
---

# Proyecto chico — flujo base

Destilado del proyecto Agus-Soporte (ago-sep 2026): app de cobranza entregada en ~8 días, ~$87 USD de tokens, ~6h de tiempo del dueño, 100/100 checks, 7 rounds de retro del cliente final entregados el mismo día que llegaban. Este flujo ES la fábrica; mejórala aquí con cada proyecto.

## Roles y economía de modelos (regla de oro)

- **Orquestador: tú.** Planificas, decides alcance, escribes specs, delegas TODO lo demás. Jamás construyes ni te auditas a ti mismo.
- **Builders y auditores: Sonnet** (`model: "sonnet"` en cada Agent). Escriben todo el código. En Agus-Soporte produjeron el 78% de los tokens por el 40% del costo.
- **Fable/el modelo grande, SOLO en 3 bisagras:** (1) arquitectura inicial + su validación; (2) la spec de cada PIVOTE de alcance (no de cada round); (3) una auditoría de arquitectura antes de entregar. Si la sesión ya corre en el modelo grande, está bien — pero los subagentes siempre Sonnet.
- Presupuesto de referencia para un gemelo de Agus-Soporte: ~$45-55 USD y 3-4 h del dueño.

## Fase 0 — Idea y arquitectura [bisagra: modelo grande]

1. Escucha la idea. Haz SOLO las preguntas que cambian la arquitectura (qué guarda, quién lo usa, offline u online, a qué dispositivo llegará).
2. Propón stack con el criterio "el MVP no se tira": elegir tecnología donde el prototipo aprobable ES el producto (ej. HTML/JS vanilla + sql.js → empaquetable después). Documenta el porqué.
3. Si la decisión pesa, valida con investigación paralela (agentes Sonnet con búsqueda web, fuentes citadas) y contrasta. El informe va a un artifact o a `knowledge/`.

## Fase 1 — Plan con contrato

- `PLAN.md` con estructura fija: Contexto (y qué queda FUERA) → Cambios propuestos (esquema, contratos de la capa de datos, spec pantalla por pantalla, seed) → Análisis de riesgo (por un AGENTE INDEPENDIENTE que no planificó: FODA → modos de falla → pre-mortem, hallazgos R-xxx con severidad) → Plan de verificación EJECUTANDO → Orden de construcción por fases con criterio de "hecho" → Backlog con IDs B-xxx.
- El dueño resuelve los hallazgos como gate CON FECHA (sección de resoluciones en el plan). Toda decisión de alcance posterior se agrega como sección §N nueva — NUNCA se borra spec vieja: se marca retirada con su porqué.

## Fase 2 — Mockup antes de UI (gate del dueño)

- Toda pantalla o flujo NUEVO se dibuja primero (HTML estático de mockup, frames de teléfono) y se itera con el dueño/cliente ANTES de construir. Cambiar un mockup cuesta minutos; cambiar código, horas.
- Lo COSMÉTICO (tamaños, colores, mover un botón) NO necesita mockup: se construye directo y se valida con la app viva.

## Fase 3 — Construcción (builders Sonnet, protocolo completo)

- **Reparto por capas disjuntas:** Builder A = datos (esquema, capa db, algoritmos puros, seed, suite de verificación); Builder B = UI (pantallas, router, css). Pueden correr en paralelo si no comparten archivos; el brief de cada uno prohíbe explícitamente tocar los del otro.
- **Reglas firmes del código:** dinero en centavos enteros; ledger append-only (borrado lógico auditable, jamás DELETE; la UI puede verse "limpia" por fuera); capa de datos como única puerta al almacenamiento; lógica de negocio JAMÁS en la UI; null honesto ("—" ≠ $0); errores relanzados con code, nunca tragados; componentes compartidos, no copy-paste.
- **Verificar EJECUTANDO es obligatorio:** suite propia en navegador (con base de datos AISLADA que jamás toca la demo) + runner Node para módulos puros. Lo que no se vio correr, no está hecho.
- **Hallazgo serio → test en ROJO antes del fix** (verlo fallar de verdad). El que encuentra un bug en capa ajena lo REPORTA con reproducción, no lo parcha.

## Fase 4 — Auditoría independiente

- Agente fresco que no construyó nada: conformidad con el plan + **mutation-check** (romper temporalmente los fixes clave y exigir que la suite se ponga en roja — tests que no detectan su mutación son placebo) + uso hostil (XSS, inputs malformados, flujos cruzados, doble-tap, multi-pestaña) + calidad (duplicación, contraste en AMBOS temas — probar primero el que usa el cliente real).
- Hallazgos A-xxx con severidad y reproducción ejecutada. Fix-pass por los builders dueños de cada capa; el auditor jamás corrige.

## Fase 5 — Publicación

- Repo público en GitHub + Pages (o equivalente). Antes del primer push: escaneo de secretos/datos personales, `.gitignore` correcto, rutas relativas.
- Commit con pathspec explícito, push verificado con `git rev-list --left-right --count origin/main...main` == `0 0`, y espera activa a que el deploy sirva EXACTAMENTE ese commit antes de avisar.
- **Antes de que el cliente meta datos reales:** si hay seed/modo demo con re-sembrado, DEBE existir el botón "empezar con mis datos reales" que lo apague para siempre. Datos en navegador = advertir sobre limpiezas de caché + botón de respaldo exportable desde el día uno + "Añadir a pantalla de inicio" en iOS (purga de 7 días).

## Fase 6 — Rounds de retro (el régimen de producción)

- La retro del cliente llega en LOTES (pedirle: captura + "yo esperaba ver X", juntada cada 2-3 días), no en goteo.
- Cada round: registrar §N en el plan → mockup SOLO si hay flujo nuevo → builders → verificación → push → **mensaje listo-para-reenviar**: cada entrega incluye un párrafo escrito para el cliente final, en su lenguaje, sin tecnicismos, listo para copiar a WhatsApp ("Ya puedes: … Recarga la app").
- Preguntas al dueño en UN paquete a/b/c por sesión, no goteadas.
- Todo retiro de funcionalidad es reversible vía backlog (B-xxx) y queda en la STORY como decisión de negocio, no como error.

## Memoria institucional (la palanca)

- `STORY.md`: nacimiento + sección "Evolución del producto" con cada cambio de alcance fechado y su porqué de NEGOCIO. Lectura #1 de todo agente nuevo.
- `CLAUDE.md`: comandos, arquitectura por capas, reglas firmes, y CICATRICES (cada bug no-obvio con cómo cazarlo si vuelve).
- El plan acumula la historia completa de specs; el backlog nunca pierde una idea.

## Anti-patrones (aprendidos con sangre)

- Tests de calendario/fechas cuyas ventanas arrancan "desde cero": ciegos a bugs de arrastre. Toda suite de fechas necesita casos a mitad de historial Y correr bien en fronteras de mes.
- Fechas: `hoy()` SIEMPRE de componentes locales, jamás UTC; comparar timestamps UTC contra fechas locales da "hace -1 días".
- Dos métricas que el cliente espera iguales (ej. dos "saldos" en dos pantallas) deben salir del MISMO helper compartido o divergirán.
- El grid/columna nuevo que "funciona" puede estar rompiendo la cabecera: cabecera y filas comparten la MISMA definición de grid en todos los estados.
- Re-render de formularios que pierde lo tecleado: capturar/reinyectar valores vivos antes de cada re-render.
- Botones de acción destructiva o Deshacer: guarda one-shot + try/catch con error visible + un-solo-vigente.
