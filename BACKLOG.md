# BACKLOG — Agus-Soporte

Backlog **activo** de mejoras/deuda técnica que NO bloquean, para retomar más
adelante. Continúa la numeración `B-xxx` que arrancó en el backlog histórico de
[PLAN-MVP.md](PLAN-MVP.md) §6 (ese queda como registro de lo ya decidido/cerrado;
los ítems nuevos viven acá).

- **Último ID usado en PLAN-MVP.md §6:** `B-034` → los nuevos arrancan en `B-035`.
- **Prioridad:** Alta (hacer pronto) · Media (cuando se toque la zona) · Baja (nice-to-have).
- Cerrar un ítem = marcar `Estado: Hecho (fecha, commit)` o moverlo a STORY.md si fue un cambio de alcance.

### Formato para agregar un ítem

```
### B-0XX — Título corto
- **Prioridad:** Alta | Media | Baja
- **Origen:** de dónde salió (auditoría §2.x, feedback de Agustín, post-mortem…)
- **Contexto:** qué pasa hoy / por qué importa.
- **Criterio de aceptación:** cuándo se considera hecho.
- **Estado:** Pendiente
```

---

## Pendientes

### B-035 — Unificar la condición "fuera del balance" en una sola fuente de verdad
- **Prioridad:** Media
- **Origen:** Auditoría §2.15 (hallazgo M4).
- **Contexto:** la regla "una categoría participa de los agregados solo si `modo_resumen === 'NORMAL'`" está replicada en 3 lugares hoy consistentes: el loop de `listarClientesAgrupados` (`js/db.js`, `cuentaEnAgregados`), el `WHERE` de `obtenerCalendarioGlobalMovimientos` (`js/db.js`, `cat.modo_resumen = 'NORMAL'`) y `grupoParticipaEnBalance` (`js/ui/componentes.js`). Es la misma clase de duplicación que causó la cicatriz §2.14 ("el Global no me da").
- **Criterio de aceptación:** una sola definición del predicado/constante; agregar un 4º modo o renombrar `NORMAL` se hace en un solo lugar. La rama SQL quizá no se unifique 100% con la JS, pero al menos centralizar el predicado JS + dejar documentado el acoplamiento con la consulta SQL.
- **Estado:** Pendiente

### B-036 — Mostrar el `modo_resumen` en la lista de ⚙ Configuración
- **Prioridad:** Baja
- **Origen:** Auditoría §2.15 (hallazgo B1).
- **Contexto:** en el sheet de Configuración, cada categoría muestra bolita + nombre + conteo, sin indicar cuáles están en NO_SUMA/OCULTA. Para saberlo hay que abrir cada una.
- **Criterio de aceptación:** un badge (reutilizar `.badge-fuera`) o etiqueta junto a las categorías que no están en NORMAL, visible de un vistazo en la lista de Configuración.
- **Estado:** Pendiente

### B-037 — Corregir comentario desactualizado en `dev-verify.js`
- **Prioridad:** Baja
- **Origen:** Auditoría §2.15 (nota del builder).
- **Contexto:** la cabecera de la sección de tests de migración dice que "ambos tests son DESTRUCTIVOS… lleguen a v3", pero ya hay 4 tests de migración (v2→v3, v1→v3, v3→v4 y el nuevo v4→v5) que llegan a v5.
- **Criterio de aceptación:** el comentario refleja los tests de migración actuales (cantidad y versión destino).
- **Estado:** Pendiente

---

## Notas de entorno de desarrollo

- **Colisión de service worker por puerto compartido.** Servir dos proyectos
  distintos en el mismo `localhost:<puerto>` hace que el SW de uno secuestre al
  otro (mismo origen = misma caché/SW) — pasó el 4-sep-2026 con diver-hub
  robándole el origen a Agus-Soporte en `:5173`. Recomendación: puerto fijo
  propio por proyecto y, al cambiar de app en un mismo puerto, desregistrar el
  SW y limpiar cachés antes de probar.
