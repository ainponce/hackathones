# Virtual Brainstorm Room — Design Spec

**Status:** Draft
**Date:** 2026-05-21
**Author:** ainponce (with Claude)

## Problem

En una hackathon, el momento más caro y desorganizado es el primero: el equipo
recién formado tiene que aterrizar una idea sólida antes de empezar a construir.
Hoy ese proceso es improvisado — un Notion en blanco, un Google Meet sin
estructura, un chat de WhatsApp con ideas perdidas. Las consecuencias: idea poco
validada, scope no definido, tiempo de coding perdido refactoreando la premisa.

## Goal

Una **sala virtual efímera** que un equipo puede crear en segundos, compartir por
link, y atravesar juntos un proceso estructurado de 4 fases para llegar a un
brief de proyecto listo para empezar a codear.

Brand-aligned: experiencia 100% terminal/CLI, sin auth, sin persistencia
post-sesión, sin facilitator obligatorio.

## Non-Goals (v1)

- Linkar la sala a una hackathon específica del directorio (`--hackathon=<slug>`).
  Compatible a futuro, no necesario para v1.
- Export directo a GitHub issue. El brief sale como markdown copyable; abrir
  issue es manual.
- Audio / video / whiteboard. Sólo texto.
- AI prompts o facilitator automático. El proceso es human-driven.
- Replay temporal de salas pasadas. Incompatible con el modelo efímero.
- Mobile pulido. Funciona pero no es prioridad — hackeo en laptop.

## Process (4 phases)

Definido con el usuario. Determina el modelo de datos y los comandos.

1. **brainstorm** — todos tiran ideas en paralelo, sin filtro. Al llegar a
   quórum de `ready`, se cierra la fase.
2. **pick_two** — votación con 2 dots por participante. Las 2 ideas con más
   votos pasan a la siguiente fase.
3. **assess** — para cada una de las 2 ideas, dos sub-checks independientes:
   - **feasibility** — ¿existe un camino técnico conocido para construirlo en
     el tiempo de la hackathon?
   - **state_of_the_art** — ¿hay productos/proyectos resolviendo este problema
     hoy? (referencia válida vs. especulación pura)

   Una idea avanza si en cada `kind` el `yes` supera o iguala al `no`
   (`maybe` no cuenta). Ramas:
   - Pasan las 2 → mini-vote desempate (`pick_winner`).
   - Pasa 1 → esa avanza directo.
   - No pasa ninguna → la sala vuelve a `brainstorm` con mensaje explícito.
4. **persona** — definir target user de la idea ganadora (who / context / pain).
5. **scope** — definir alcance del prototipo (must_have / nice_to_have / out_of_scope).
6. **done** — brief visual estructurado en pantalla; copiable como markdown;
   sala se marca para purga inmediata.

## Architecture

### Stack

- **Frontend:** Astro 6 + React island. La página `/room/[id]` monta
  `<RoomTerminal client:only="react" />`; el resto del sitio sigue siendo
  Astro estático.
- **Backend:** Supabase (Postgres + RLS + Realtime + pg_cron). Sin Node server
  propio. Sin nuevas dependencias.
- **Realtime:** Supabase Realtime, tres mecanismos por canal `room:<slug>`:
  - `postgres_changes` → ideas, votos, assessments, persona, scope, fase actual.
  - `presence` → roster vivo + flag `ready` por participante.
  - `broadcast` → eventos efímeros (typing indicator opcional).
- **Sin nuevas piezas de infra.** CSP actual (`connect-src https://*.supabase.co`)
  ya permite el tráfico Realtime sin cambios.

### Flujo

```
Browser (cada participante)
├── /room/[id] (Astro + React island)
│   ├── RoomTerminal.tsx     ← UI tipo terminal, comandos
│   ├── useRoomChannel.ts    ← Supabase Realtime (presence + broadcast + postgres-changes)
│   └── useRoomState.ts      ← Reducer puro: (state, dbEvent) → newState
│
└── Terminal.astro (sitio principal)
    └── Comandos `room create` / `room join <id>` → Supabase → redirect /room/<id>

Supabase
├── Tablas: rooms, room_participants, room_ideas, room_votes,
│           room_assessments, room_personas, room_scopes, room_phase_events
├── Función: attempt_advance_phase(room_id) — SECURITY DEFINER, quórum-aware
├── RLS: anon read/write filtrado por session_token y room_id
├── Realtime: postgres_changes sobre todas las tablas, filtrado por room_id
└── pg_cron: DELETE FROM rooms WHERE expires_at < now() — cada 15 min
```

### State machine

```
brainstorm ──(quorum ready)──► pick_two ──(top-2)──► assess
                                                       │
                          ┌─(2 pasan)─► pick_winner ───┤
                          │                            │
                          ├─(1 pasa)──────────────────►│
                          │                            ▼
                          └─(0 pasan)──► brainstorm    persona ──(quorum)──► scope ──(quorum)──► done
```

## Data model

7 tablas. Todas con `room_id` para RLS, `created_at` para orden estable.
`ON DELETE CASCADE` desde `rooms` hacia el resto.

### `rooms`
```
id            uuid PK
slug          text UNIQUE       -- short code: "tx7-bear-9k"; aparece en /room/<slug>
host_token    text              -- secreto que solo conoce el creador (controla `close`)
phase         text              -- 'brainstorm' | 'pick_two' | 'assess' | 'pick_winner'
                                --   | 'persona' | 'scope' | 'done'
locale        text              -- 'en' | 'es' | 'pt' (idioma de los prompts UI)
winner_idea_id uuid NULL        -- set al pasar de assess / pick_winner a persona
created_at    timestamptz
expires_at    timestamptz       -- default now() + 4h
```

### `room_participants`
```
room_id          uuid FK
session_token    text             -- generado en cliente al unirse; vive en localStorage
handle           text             -- "@aiponce"
joined_at        timestamptz
last_seen_at     timestamptz      -- actualizado por heartbeat cada 20s
ready            bool DEFAULT false
PRIMARY KEY (room_id, session_token)
UNIQUE (room_id, handle)
```

### `room_ideas`
```
id             uuid PK
room_id        uuid FK
session_token  text                -- autor (para editar/borrar solo lo suyo)
handle         text                -- snapshot del handle al momento de la idea
text           text CHECK (length(text) between 1 and 280)
created_at     timestamptz
```
Constraint adicional: máx 20 ideas por `(room_id, session_token)` — vía trigger
o partial unique. Anti-spam suave.

### `room_votes`
```
room_id        uuid
session_token  text
idea_id        uuid FK
phase          text             -- 'pick_two' | 'pick_winner' (para reusar la tabla)
PRIMARY KEY (room_id, session_token, idea_id, phase)
```
Constraint: máx 2 filas por `(room_id, session_token, phase='pick_two')` y máx 1
para `pick_winner`. Vía trigger.

### `room_assessments`
```
id              uuid PK
room_id         uuid FK
idea_id         uuid FK
kind            text             -- 'feasibility' | 'state_of_the_art'
session_token   text
verdict         text             -- 'yes' | 'no' | 'maybe'
note            text             -- razón corta, opcional
UNIQUE (room_id, idea_id, kind, session_token)  -- un verdict por persona/check
```

### `room_personas`
```
room_id      uuid PK FK
idea_id      uuid                 -- la idea ganadora
who          text
context      text
pain         text
updated_at   timestamptz
```
Fila única por sala (UPSERT). Último write gana.

### `room_scopes`
```
room_id      uuid PK FK
must_have    text[]
nice_to_have text[]
out_of_scope text[]
updated_at   timestamptz
```
Fila única por sala (UPSERT).

### `room_phase_events`
```
id           uuid PK
room_id      uuid FK
event_type   text                 -- 'phase_advanced' | 'idea_added' | ...
payload      jsonb
created_at   timestamptz
```
Append-only. Útil para audit y para que un cliente que reconecta arme una vista
del log del stream.

### RLS policies

- `SELECT`: anon puede leer cualquier fila filtrada por `room_id` que conozca.
  No hay autenticación; el "secreto" es el slug de la URL.
- `INSERT`: anon puede insertar si la columna `session_token` de la fila
  coincide con el header `x-session-token` que el cliente envía. La policy
  lee el header via `current_setting('request.headers', true)::json->>'x-session-token'`.
  Aceptamos que esto no defiende contra adversarios serios (un atacante puede
  setear cualquier header), pero sí contra accidentes y contra que clientes
  borren/editen filas de otros participantes.
- `UPDATE/DELETE`: anon puede modificar solo filas donde su
  `session_token` matchea el header `x-session-token`.
- `rooms.phase`: ningún anon puede UPDATE-arlo directamente. Solo se modifica
  via `attempt_advance_phase(room_id)` (SECURITY DEFINER) o si el cliente
  presenta `host_token` válido en `close`.

### `attempt_advance_phase(p_room uuid)`

```sql
create or replace function attempt_advance_phase(p_room uuid)
returns void as $$
declare
  ready_count int;
  total int;
  current_phase text;
begin
  select phase into current_phase from rooms where id = p_room for update;

  select count(*) into total from room_participants
    where room_id = p_room and last_seen_at > now() - interval '60 seconds';

  select count(*) into ready_count from room_participants
    where room_id = p_room
      and last_seen_at > now() - interval '60 seconds'
      and ready = true;

  if total = 0 then return; end if;
  if ready_count * 2 <= total then return; end if;

  update rooms
    set phase = next_phase(p_room, current_phase)
    where id = p_room;

  update room_participants set ready = false where room_id = p_room;
end;
$$ language plpgsql security definer;
```

`next_phase(room, current)` encapsula la state machine, incluido el branching
de `assess` (devuelve `pick_winner`, `persona` o `brainstorm` según los
assessments existentes).

### Cleanup

`pg_cron` con job cada 15 min:
```sql
DELETE FROM rooms WHERE expires_at < now();
```
`ON DELETE CASCADE` borra todas las tablas dependientes.

## UI / Commands

### Entry from main terminal

Comandos nuevos en `Terminal.astro`:

| Comando | Qué hace |
|---|---|
| `room create [--locale=<en\|es\|pt>]` | Crea una sala. Devuelve slug, guarda `host_token` en localStorage, redirige a `/room/<slug>`. |
| `room join <slug>` | Navega a `/room/<slug>`. |

### Sub-terminal en `/room/<slug>`

Layout:
- **Stream** (parte superior, scrolleable) — log append-only de eventos:
  ideas, votos, transiciones de fase, errores, joins/leaves. Cada línea con
  timestamp + handle del autor cuando aplica.
- **Prompt** (sticky bottom) — input con `<handle>@room:<phase>$ ` y autocomplete
  por Tab de comandos válidos en la fase actual + IDs cortos de ideas (primeros
  6 chars del uuid).
- **Side panel** (angosto, derecha) — roster con handles + estado ready/not-ready,
  fase actual, contador de quórum ("3/5 ready"), indicador "● live" / "○ reconectando…".

### Comandos dentro de la sala

| Comando | Fase válida | Qué hace |
|---|---|---|
| `idea <texto>` | brainstorm | Agrega una idea autoría tuya. |
| `idea rm <id>` | brainstorm | Borra tu propia idea. |
| `vote <idea-id>` | pick_two, pick_winner | Suma 1 dot (máx 2 en pick_two, 1 en pick_winner). |
| `unvote <idea-id>` | pick_two, pick_winner | Quita tu dot. |
| `assess <idea-id> <feasibility\|sota> <yes\|no\|maybe> [--note "..."]` | assess | Tu veredicto en un check. |
| `persona who/context/pain <texto>` | persona | Set un campo. Último write gana. |
| `scope must/nice/out <texto>` | scope | Append a la lista. |
| `scope rm must/nice/out <n>` | scope | Quita el ítem n. |
| `ready` / `not-ready` | cualquiera | Marca tu flag. Trigger `attempt_advance_phase`. |
| `who` | cualquiera | Lista el roster con últimos handles vivos. |
| `phase` | cualquiera | Imprime fase actual y progreso del quórum. |
| `help` | cualquiera | Cheatsheet de comandos válidos en la fase actual. |
| `leave` | cualquiera | Sale de la sala, libera el handle. |
| `close` | cualquiera | Solo válido si presentás `host_token` válido → fuerza `done`. |

### Vista `done` — brief visual

No es un dump plano. Es un summary estructurado que muestra el viaje:

```
═══════════════ BRIEF ═══════════════
🏆  IDEA GANADORA
    ┌─────────────────────────────────────┐
    │  <texto de la idea>                 │
    └─────────────────────────────────────┘

📋  IDEAS GENERADAS  (8 en total)
    ✅ <idea ganadora>     7 votos · pasó feasibility + sota
    ✅ <idea finalista>    5 votos · pasó feasibility · ✗ sota
    ⚪ <idea>              2 votos
    ⚪ <idea>              1 voto
    ... (resto colapsado)

🔬  ASSESSMENT
    feasibility: 4 yes / 1 maybe / 0 no
        notes: "podemos usar la API de X", "demo en 24h con stack Y"
    state_of_the_art: 3 yes / 1 no / 1 maybe
        notes: "existe Z pero no resuelve W"

👤  PERSONA
    who:     <texto>
    context: <texto>
    pain:    <texto>

🎯  SCOPE
    MUST HAVE
      • <item>
      • <item>
    NICE TO HAVE
      • <item>
    OUT OF SCOPE
      • <item>

═════════════════════════════════════
[c] copy as markdown   [enter] close room
```

Renderizado con ASCII art + colores ANSI sutiles, coherente con el resto de la
terminal. Los íconos (✅ ⚪ 🏆) son los únicos emojis del sistema, justificados
porque dan jerarquía visual instantánea en el resumen final.

`[c]` copia el equivalente markdown limpio (sin ANSI ni ASCII art) al portapapeles.
`[enter]` borra la sala inmediatamente (no espera `expires_at`).

## Sync strategy

Cada cliente al montar `/room/<slug>`:

1. Lee `localStorage['room:<slug>:session']`. Si existe, intenta reconectar
   con ese token. Si no, abre flujo de onboarding (pedir handle).
2. Hace `SELECT` paralelo sobre todas las tablas filtradas por `room_id`.
   Hidrata el estado completo.
3. Se suscribe a Supabase Realtime: presence (tracking propio), postgres_changes
   con filter `room_id=eq.${id}`, broadcast.
4. Inicia heartbeat: cada 20s, `UPDATE room_participants SET last_seen_at = now()`.
5. Cualquier cambio en `ready` dispara `attempt_advance_phase(room_id)`.

`useRoomState` es un **reducer puro** `(state, event) → newState`:
- Deduplica por `id` cuando aplica (postgres puede entregar el mismo evento dos veces).
- Maneja inserts out-of-order ordenando por `created_at`.
- Estado derivado (ej: roster) se computa desde el snapshot, no se mantiene
  separado.

## Error handling — casos cubiertos

| Caso | Tratamiento |
|---|---|
| Colisión de handle en misma sala | UNIQUE constraint rechaza, UI pide otro handle. |
| Misma persona dos pestañas | Botón "reconectar como @X (cerrar otra)" — transfiere session_token al nuevo tab; el viejo queda read-only con mensaje. |
| Refresh / reconexión wifi | session_token en localStorage → rehidrata desde Supabase + re-suscribe. |
| Host cierra browser | La sala sigue (quórum no depende del host). `close` no disponible; termina por expiración. |
| Todos abandonan | Sala huérfana hasta `expires_at`; quien vuelva dentro de 4h reconecta. Cron purga después. |
| Quórum imposible (1 persona) | `ready_count * 2 > total` con total=1 → avanza solo. Deseado. |
| Idea vacía o >280 chars | Constraint DB rechaza, terminal muestra error. |
| Spam | Trigger limita a 20 ideas / 2 votos por session por sala. |
| Assess ambiguo | Regla: `yes >= no` por kind. `maybe` no cuenta. Sin votos → no pasa. |
| Realtime cae | Cliente muestra "○ reconectando…", SDK reintenta, rehidrata al volver. |
| Slug colisiona | Cliente reintenta hasta 3 veces con nuevo slug. |
| Sala expira mid-uso | DELETE llega vía Realtime, cliente muestra "esta sala expiró" y cierra. Banner 15 min antes; v1.1 podrá `extend`. |
| Locale mixto | `rooms.locale` es fijo al crearse. Trade-off conocido y aceptado. |

## Testing strategy

Tres niveles:

1. **SQL / RLS / state machine** — tests en `supabase/tests/` corridos contra
   branch de Supabase:
   - Anon no puede modificar `session_token` ajeno.
   - Anon no puede UPDATE `rooms.phase` directamente.
   - `attempt_advance_phase` no avanza sin quórum.
   - Constraints (20 ideas, 2 votos, longitud) rechazan.
   - `ON DELETE CASCADE` limpia.
   - `next_phase()` cubre todas las transiciones, incluido vuelta a brainstorm.

2. **Reducer client-side** — Vitest contra `useRoomState`:
   - Aplicar eventos out-of-order.
   - Dedupe de eventos repetidos.
   - Reconstrucción desde snapshot + deltas.

3. **End-to-end** — Playwright, un solo test: 3 pestañas + 3 handles + happy path
   completo, validar brief en las 3 pantallas.

**Out:** UI fina (autocomplete, scroll) — visual, frágil.

**Manual QA pre-merge:** dos browsers distintos, refresh por fase, transferir
handle, cortar wifi 30s, llegar a done, validar markdown copiado.

## Roll-out plan

Seis PRs incrementales:

| Etapa | Entrega |
|---|---|
| 1 | Migraciones Supabase + RLS + tests SQL + `attempt_advance_phase` + `next_phase` + cron de purga. |
| 2 | Comando `room create` / `room join` en terminal principal + ruta `/room/[id]` esqueleto + onboarding de handle. |
| 3 | Fase `brainstorm` end-to-end: ideas, roster, presence, ready/quórum, advance. |
| 4 | Fases `pick_two` + `assess` (+ `pick_winner` branch) + retroceso a `brainstorm`. |
| 5 | Fases `persona` + `scope` + vista `done` con brief visual estructurado + copy markdown. |
| 6 | i18n (en/es/pt) de todos los prompts y mensajes de la sala. |

Cada PR mergeable independientemente. Dogfooding posible desde etapa 3 (sala como
brainstorm simple) antes de feature completa.

## Open questions

Ninguna bloqueante para empezar la implementación. Decisiones diferidas:

- ¿Algún cap explícito en participantes simultáneos? Sugerencia: soft-cap 12,
  decidir al implementar etapa 3 si vemos límites de Realtime.
- Wording exacto de los prompts traducidos — se itera en etapa 6.
- Formato exacto del markdown copiado — se cierra en etapa 5 cuando se vea la
  vista `done` real.
