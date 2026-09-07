# Enoki

A self-hostable, multi-guild Discord leveling bot. Members earn XP from messages, voice and reactions; XP becomes levels; levels become roles.

> *Enoki* — mushrooms that grow in dense clusters, each stalk a little taller than it was yesterday. Communities do the same thing when you give them something to measure.

Built to a written specification — see **`docs/spec/`** (also in the Claude project "Arcane.bot Clone"). Every architectural decision is recorded as an accepted ADR in `docs/spec/09-adrs.md`. **Read the spec before changing behaviour.**

---

## Current status

| Milestone | State |
|---|---|
| **M0 — Repository foundation** | ✅ done |
| **M1 — Platform core & plugin seam** | ✅ done |
| **M2 — The XP domain (pure, no I/O)** | ✅ done |
| **M3 — Persistence & guild config** | ✅ done |
| **M4 — Message XP, end to end** | ✅ done |
| **M5 — `/level` configuration & `/xp` admin** | ✅ done |
| **M6 — Level-up messages, `/rank`, `/leaderboard`** | ✅ done |
| **M7 — Role rewards** | ✅ done |
| **M8 — Debugging & observability** | ✅ done |
| **M9 — Voice XP** | ✅ done |
| **M10 — Production hardening** | ✅ **v1.0** |
| **M11 — Reaction XP** | ✅ done |
| **M12 — Boosters end to end** | ✅ done |
| **M13 — Periodic boards & Highlights** | ✅ done |
| **M14 — Rank cards** | ✅ done |
| **M15 — Admin depth** | ✅ done — **the roadmap is complete** |

**697 tests green** — unit, integration (real Postgres) and architecture.

Every milestone in `docs/spec/10-implementation-roadmap.md` is implemented:
message, voice, reaction and manual XP; levels; level-up messages; role rewards
including recurring rules and a backfill; rank and leaderboards including
weekly, monthly and automatic Highlights; rank card images; XP import from
another bot; full configuration; debugging tools; and a member's right to have
their data deleted. Documented, backed up, restorable, and survivable across
restarts and dependency outages. See **`docs/RUNBOOK.md`** to operate it.

```bash
npm install
docker compose up -d postgres   # integration tests need it; unit tests do not
npm run verify                  # typecheck + lint + all tests
npm run test:unit               # fast loop: ~2s, no Docker, no network
```

To actually start the bot, copy `.env.example` to `.env` and fill in
`DISCORD_TOKEN`, `DISCORD_APPLICATION_ID` and `DATABASE_URL` — see
**Discord application setup** below. The `.env` file is loaded automatically
from the directory you run from; under Docker there is no `.env` and compose
injects the variables instead. A real environment variable always beats the
file, so `DATABASE_URL=... npm run dev` overrides it.

```bash
npm run dev
```

Expect: migrations applied, five commands registered, gateway ready, Enoki
online in your server.

Then, in Discord:

```
/level config set key:enabled value:on
```

Send a message, wait a minute, send another, and run `/rank`.

---

## What already works

**The platform core (M1).** A module-agnostic bot host:

- **Plugin seam** — `BotModule` interface and registry. Leveling is itself a
  module, so the boundary is exercised by the only feature that exists and
  cannot silently rot. Duplicate module names or command claims fail at boot.
- **Intent composition** — the gateway requests exactly the union of enabled
  modules' needs. `GuildPresences` is never requested; `MessageContent` is an
  optional capability the bot degrades without.
- **Migrations** — forward-only numbered SQL, checksummed, transactional,
  namespaced per module, applied **before** the gateway connects. Boot aborts
  on failure rather than running against a schema it doesn't understand.
- **Command registrar** — hashes the command set and skips the upload when
  nothing changed, so a dev restart loop doesn't burn Discord's 200/day
  global command budget.
- **Dispatcher** — automatic deferral for slow handlers (Discord's 3-second
  rule), an error boundary that reports a correlation ID instead of a stack
  trace, and no path that bypasses a handler's own permission check.
- **Scheduler** — in-process, single-flight (an overrunning job skips rather
  than stacking), every run recorded in `job_run` so a silently-stopped job is
  detectable.
- **Health** — `/healthz` (liveness) and `/readyz` (gateway + database).
  Deliberately separate: a database blip should not restart the bot.
- **Guild lifecycle** — reconciled on ready, not from events alone. discord.js
  emits `guildCreate` only once the websocket reaches Ready, so guilds the bot
  was *already in* never fire it; reconciliation is what gives them a row at
  all. It also covers the two cases events cannot: a guild joined while the bot
  was down, and one it was removed from while down. Removal is a soft delete,
  and `unavailable` is correctly treated as a Discord outage rather than a
  removal.

**The entire leveling brain (M2)**, implemented and tested with no I/O:

- **Curve engine** — Arcane's three documented formulas (linear, exponential, flat), a per-level multiplier, optional max level, and a precomputed cumulative table with binary-search lookup (ADR-003). The reference values in the spec are asserted as golden fixtures.
- **The 14-gate XP pipeline** — eligibility gates strictly before amount gates, so restrictions always beat boosters (ADR-011). Every evaluation emits a full decision trace, which is what `/level debug why` will render.
- **Restrictions** — channel/category/role/user rules with thread→parent→category chain resolution, whitelist and blacklist with documented precedence, and contradiction warnings.
- **Boosters** — additive basis-point bonuses with `stack` / `highest` modes, temporary expiry, and clamping.
- **Role rewards** — desired-set resolution and diffing that provably never removes a role the bot doesn't manage (ADR-007).
- **Period calendar** — timezone- and DST-correct weekly/monthly bucket keys, so a "reset" is a clock function rather than a job (ADR-006).
- **Voice eligibility & anti-AFK** — mute/deafen/AFK rules, the minimum-members counting rule, and the decay curve.

**Persistence, XP awarding and the command surface (M3–M6).**

- **The atomic increment** — XP is mutated under a row lock inside one
  transaction, which is what makes the reported before/after pair race-free and
  therefore makes level-up detection race-free. Proven under 100 concurrent
  awards. The obvious `UPDATE ... SET total_xp = total_xp + $1` with a self-join
  to read the old value is *not* safe here and the repository says why.
- **Message XP** — a thin `messageCreate` adapter, the cached config, the pure
  pipeline, then one transaction that writes XP, statistics and both period
  buckets together. A bot message or a disabled guild costs no I/O at all.
- **Guild configuration** — one wide row plus per-source rows, assembled into
  the single object the engine consumes, cached in process and invalidated by a
  `config_version` comparison rather than a protocol.
- **`/level`** — `config view` / `config set` / `config reset`, `restrict`,
  `boost` and `reward`, all behind a re-checked **Manage Server** permission.
  Every setting comes from one declarative registry, which is also the SQL
  identifier whitelist — an unknown key can never reach an `UPDATE`.
- **`/xp`** — `add`, `remove`, `set`, `reset`, `reset-server` and `audit`. Every
  mutation is written to the audit log with actor, before and after. The
  server-wide wipe requires typing the server's name, not ticking a box.
- **`/rank`** — level, rank, progress bar and next reward, from one snapshot
  object the future image card will consume unchanged.
- **`/leaderboard`** — seven boards, paginated by buttons whose custom id
  carries the entire state, so they still work after a restart. A button pressed
  by someone other than the person who opened the board answers them privately
  instead of yanking the shared message around.
- **Level-up announcements** — Arcane's placeholder set, validated at
  configuration time, with `@everyone` inert by construction. A channel the bot
  cannot post in is warned about once, not once per message.
- **Reward roles** — reconciled to a desired set, never removing an unmanaged
  role, with hierarchy and managed-role problems detected *before* calling
  Discord and recorded so `/level reward list` can show the admin what to fix.

**Role rewards, voice XP, debugging and hardening (M7–M10).**

- **Reward roles converge from every direction** — a level-up, a manual XP
  change, a rejoin. Reconciliation never removes a role the bot does not manage,
  detects hierarchy and managed-role problems *before* calling Discord (which
  answers "Missing Permissions" for both, so they cannot be told apart
  afterwards), and keeps a broken rule rather than discarding it. An hourly
  sweep re-checks broken rules, so fixing the cause fixes the reward without
  the admin having to remember to re-add it.
- **Voice XP** — ticks plus an end-of-session flush (ADR-004), built around one
  invariant: *a second of voice time is credited at most once, and only if we
  can prove the member was eligible during it*. Downtime is not credited,
  because we cannot prove eligibility during it and paying for it would reward
  crashes. A channel move is a mutation rather than a leave-plus-join, so
  hopping channels cannot reset the anti-AFK timer. Eligibility depends on who
  *else* is in the channel, so one gateway event re-evaluates every session in
  it. All four restart-recovery cases are covered and tested.
- **`/level debug`** — `why` runs the real pipeline in collect-all mode against
  a synthesised message, so it cannot drift from the awarding path; it writes
  nothing and *peeks* the cooldown rather than consuming it. `rewards`, `member`
  and `health` answer the other three questions an admin would otherwise have to
  read source code for.
- **Metrics** at `/metrics` in Prometheus exposition format, with no dependency
  and no unbounded labels.
- **Hardening** — every listener has its own error boundary, so a database blip
  during a `messageCreate` cannot become an unhandled rejection; shutdown
  flushes voice credit and leaves sessions open, because the members are still
  in voice; retention removes only operational data, never XP; and the restore
  drill in the runbook was actually performed rather than merely written.

**Reactions, boosters, periodic boards, cards and admin depth (M11–M15).**

- **Reaction XP** — the only source with *durable* idempotency (ADR-010),
  because removing a reaction and adding it back is a two-click loop anyone can
  run forever; an in-memory window would set the price of farming at "wait ten
  minutes". One award per (message, reactor, emoji), for good.
- **Weekly and monthly boards, and Highlights** — a period "reset" is the clock
  advancing, not a job (ADR-006). The Highlights poster claims a
  (guild, period) row *before* posting, so it posts exactly once however often
  the job runs or the process restarts, and a stale period is marked done
  rather than announced a fortnight late.
- **Rank cards** — a 900×260 PNG with member-level personalisation, an SSRF
  allowlist that accepts only Discord's own CDN, and a render budget: if
  anything at all goes wrong the command answers with the embed instead. A
  member who asks for their rank always gets an answer.
- **Reward backfill** — reconciliation is level-triggered, so a rule added to a
  year-old server matches nobody until they next level up (and for a member at
  max level, never). `/level reward backfill` walks every member, claims the
  guild so two runs cannot overlap, paces itself against Discord's role budget,
  reports progress, can be cancelled from anywhere — and **defaults to a dry
  run**, using the same code path with the writes skipped.
- **XP import** — a server leaving Arcane or MEE6 arrives with a CSV. The
  parser is permissive about layout (headers or not, extra columns, BOM, CRLF,
  semicolons, thousands separators) and unforgiving about values, because the
  expensive failure is not "the import errored" but "the import read the wrong
  column". Batches are transactions, so a bad row costs its batch and reports
  exactly how far it got.
- **Data deletion** — `/xp forget` is the one `/xp` subcommand a member can run
  on themselves without Manage Server, because a deletion right that needs an
  admin's cooperation is not a right. `admin.autoResetOnLeave` does the same on
  departure, and audits the erasure without retaining what it erased.

## What does not exist yet

Everything on the roadmap is built. What remains is explicitly post-roadmap in
`docs/spec/10-implementation-roadmap.md`: a web dashboard, a public leaderboard
with vanity URLs, custom curve expressions, seasons and archiving, level-up
graphics, DM notifications, and additional non-leveling modules — which is what
the `BotModule` seam exists for.

---

## Development

```bash
npm run dev              # watch mode
npm run test:unit        # fast domain suite — ~2s, no Docker, no network
npm run test:integration # real Postgres; set TEST_DATABASE_URL or use compose
npm run test:arch        # proves the boundary rule fails on violations
npm run test:coverage    # enforces the >=90% domain coverage threshold
npm run verify           # everything CI runs
```

Integration tests create and drop a throwaway database per test, so they need a
Postgres they can `CREATE DATABASE` on. `docker compose up -d postgres` then:

```bash
TEST_DATABASE_URL=postgres://enoki:enoki@localhost:5432/enoki npm run test:integration
```

### The architecture rule is not decoration

`src/modules/leveling/domain/` may import **only** from `domain/` (plus `luxon`, for timezone maths). No `discord.js`, no database driver, no `node:fs`, no reaching into `application/` or `infrastructure/`.

This is enforced by ESLint as an **error**, checked in CI, and — because a configured-but-ignored rule rots within weeks — verified by `tests/architecture/boundaries.test.ts`, which writes real violating files into `domain/`, runs ESLint over them via its Node API, and asserts the lint fails. If those tests ever pass while a violation compiles, the architecture has silently stopped being enforced.

Everything the spec claims about testing the XP engine without a network depends on this rule holding.

> **Deviation from the spec, recorded:** `07` §4.13 named `eslint-plugin-boundaries`. This repo uses ESLint's built-in `no-restricted-imports` with per-layer overrides instead — same enforcement, one fewer dependency, and clearer error messages. The behaviour required by the spec (errors, in CI, on violation) is unchanged and is proven by the architecture tests.

### Layout

```
src/
  main.ts                    entrypoint: validate env -> (M1) migrate -> connect
  platform/                  module-agnostic bot core
    config/env.ts            Zod schema, fail-fast at boot
    logging/logger.ts        pino, with token/DSN redaction
  modules/leveling/
    domain/                  PURE. no I/O. the crown jewels.
      curve/                 formulas + cumulative table + level lookup
      engine/                the 14-gate pipeline and its trace
      restrictions/          location chain, whitelist/blacklist precedence
      boosters/              bps stacking
      rewards/               desired-set resolution and diffing
      periods/               tz/DST-correct week and month boundaries
      voice/                 eligibility predicate, anti-AFK decay
      rank/                  RankView — the data /rank needs, no rendering
      notifications/         level-up templating, pure and testable
      support/               defaults, system Clock and Rng
    ports/                   interfaces application/ and adapters/ depend on
    application/             use cases: awardXp, leaderboard queries, settings
    infrastructure/          Postgres repositories, config cache, cooldowns
    adapters/                Discord translation: listeners, commands, effects
    migrations/              the module's own tables, namespaced by module name
  platform/metrics/          dependency-free Prometheus registry
docs/RUNBOOK.md              deploy, upgrade, back up, restore, incidents
    platform/                  module-agnostic bot core
      plugin/                  BotModule interface + registry
      db/                      pool, transactions, migration runner
      discord/                 client factory, intent handling
      commands/                registrar (with diffing), dispatcher
      jobs/                    scheduler with single-flight
      http/                    /healthz, /readyz
      guilds/                  guild lifecycle persistence
    composition/               THE ONLY place concretes are constructed
  modules/leveling/
    index.ts                   the module's only export to the core
migrations/                    core schema, forward-only
tests/
  unit/                        domain + registry. no docker, no network.
  integration/                 real Postgres, throwaway DB per test.
  architecture/                proves the boundary rule bites.
```

---

## Commands

| Command | Who | What |
|---|---|---|
| `/rank [user]` | everyone | Level, rank, progress, next reward |
| `/leaderboard [board] [page]` | everyone | XP, level, weekly, monthly, voice, messages, reactions |
| `/level config view [group]` | Manage Server | Every setting and its current value |
| `/level config set <key> <value>` | Manage Server | Change one setting (autocompleted) |
| `/level config reset confirm:` | Manage Server | Defaults, without touching member XP |
| `/level restrict add\|remove\|list` | Manage Server | No-XP and XP-only-here rules |
| `/level boost add\|remove` | Manage Server | Bonus XP for a role or channel, optionally temporary |
| `/level reward add\|remove\|list` | Manage Server | Roles granted at a level |
| `/level reward add-recurring\|remove-recurring` | Manage Server | "…and again every N levels" |
| `/level reward backfill [apply]` | Manage Server | Catch every member up. Dry run by default |
| `/xp add\|remove\|set <user>` | Manage Server | Manual adjustment, audit-logged |
| `/xp reset <user>` / `/xp reset-server` | Manage Server | Wipes, both explicitly confirmed |
| `/xp import <file> [mode] [apply]` | Manage Server | CSV from another bot. Dry run by default |
| `/xp forget [user]` | **everyone, for themselves** | Permanently delete leveling data |
| `/xp audit [user] [actor] [action]` | Manage Server | Administrative changes, filterable |
| `/card color\|background\|preview\|reset` | everyone | Personalise your rank card |
| `/level debug why [user] [channel]` | Manage Server | Every gate a message would pass or fail |
| `/level debug member [user]` | Manage Server | Everything stored about one member |
| `/level debug rewards [user]` | Manage Server | Desired roles, the diff, and what is blocking |
| `/level debug health` | Manage Server | Everything wrong with this server's setup |

`/level config set` autocompletes over the whole setting registry, so
`curve`, `levelup` or `cooldown` typed into the key box finds what you want.
The permission check is re-run inside every handler — Discord's
`default_member_permissions` is only a UI hint that a server admin can override.

---

## Discord application setup

1. Go to <https://discord.com/developers/applications> and click **New Application**.
2. **Bot** tab → **Reset Token** → copy it into `DISCORD_TOKEN` in your `.env`. Treat it like a password; if it leaks, reset it here.
3. On the same tab, enable these **Privileged Gateway Intents**:
   - ✅ **Server Members Intent** — required. Role-based restrictions and boosters, and reward reconciliation on rejoin, cannot be correct without it.
   - ✅ **Message Content Intent** — optional. Only per-word XP mode, `min_message_length` and the effort booster need it. The bot boots and runs without it, disabling exactly those features.
   - ❌ **Presence Intent** — leave OFF. No leveling use, and it is the heaviest event stream on the gateway.

   Both are self-serve toggles while the app has access to fewer than **10,000 unique users**. Above that, Discord requires an application (90 days' notice). Note that apps holding privileged intents must **reapply once per year** — which is why Message Content is treated as an optional capability in code rather than an assumption.
4. **General Information** → copy the **Application ID** into `DISCORD_APPLICATION_ID`.
5. Invite the bot with least privilege — replace `<APPLICATION_ID>`:

   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=275146460160
   ```

   `275146460160` is exactly: View Channels (1<<10), Send Messages (1<<11),
   Embed Links (1<<14), Attach Files (1<<15), Read Message History (1<<16),
   Manage Roles (1<<28), Send Messages in Threads (1<<38).
   **Never grant Administrator.**

   Read Message History is only needed once reaction XP lands (M11), to resolve
   the author of an uncached message. Including it now avoids a re-invite later.
6. For development, put your test server's ID in `DISCORD_DEV_GUILD_ID` so slash
   commands register instantly instead of taking about an hour to propagate
   globally. To find it: **User Settings → Advanced → Developer Mode**, then
   right-click your server's icon in the sidebar → **Copy Server ID**.
   Leaving it blank is valid and means "register globally".

### Role hierarchy

For role rewards to work, the bot's own role must sit **above** every reward role in Server Settings → Roles. Discord refuses otherwise, and the bot will report this as a `hierarchy` failure rather than failing silently.

---

## Deployment

```bash
cp .env.example .env      # fill in DISCORD_TOKEN and DISCORD_APPLICATION_ID
docker compose up -d
```

Migrations run before the gateway connects, and a failed migration aborts boot
rather than running against a mismatched schema.

### Running Postgres for local development

`npm run dev` runs on the host, so it needs the database reachable there:

```bash
docker compose up -d postgres   # then npm run dev
```

Compose publishes Postgres on `127.0.0.1:5432` — **loopback only**, deliberately.
The usual `5432:5432` short form binds to every interface, which on a laptop
means anyone on the same café or office network can reach your database.

No Docker? Any Postgres 16 works. Install it natively, or point `DATABASE_URL`
at a hosted one — Enoki only needs a database it can `CREATE TABLE` in. The
integration tests additionally need `CREATE DATABASE` rights, because each test
gets a throwaway database.

---

## Licence

Unlicensed / private.
