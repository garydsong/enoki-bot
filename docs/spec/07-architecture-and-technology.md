# 07 — Architecture, Project Structure, Technology, Caching, Concurrency

---

## 1. Layered architecture

### 1.1 The diagram

```
                        ┌──────────────────────────────────────────┐
   Discord Gateway ────►│  ADAPTERS — INBOUND                      │
                        │  discord/listeners/*                     │
                        │  discord/commands/*                      │
                        │  http/health, jobs/schedulers            │
                        │  · translate Discord objects into        │
                        │    domain inputs; zero business logic    │
                        └───────────────┬──────────────────────────┘
                                        │ calls (never the reverse)
                        ┌───────────────▼──────────────────────────┐
                        │  APPLICATION — use cases                 │
                        │  AwardXpUseCase, ReconcileRewardsUseCase │
                        │  GetRankUseCase, ConfigureGuildUseCase   │
                        │  VoiceSessionService, ImportXpUseCase    │
                        │  · orchestration, transactions,          │
                        │    side-effect dispatch                  │
                        └──────┬─────────────────────┬─────────────┘
                               │                     │
             ┌─────────────────▼──────┐   ┌──────────▼────────────────────┐
             │  DOMAIN — pure         │   │  PORTS (interfaces)           │
             │  xp/engine             │   │  MemberXpRepository           │
             │  xp/gates              │   │  GuildConfigRepository        │
             │  leveling/curve        │   │  CooldownStore                │
             │  leveling/rank         │   │  DiscordRoleGateway           │
             │  rewards/resolver      │   │  DiscordMessageGateway        │
             │  boosters/resolver     │   │  Clock, Rng, MetricsSink      │
             │  periods/calendar      │   │  CardRenderer                 │
             │  · no imports outside  │   └──────────┬────────────────────┘
             │    the domain folder   │              │ implemented by
             └────────────────────────┘   ┌──────────▼────────────────────┐
                                          │  INFRASTRUCTURE — outbound    │
                                          │  db/repositories/*  (SQL)     │
                                          │  discord/gateways/* (REST)    │
                                          │  cache/*, render/*, logging/* │
                                          └──────────┬────────────────────┘
                                                     │
                                        PostgreSQL ──┘── Discord REST API
```

### 1.2 Dependency rules (enforced, not suggested)

| Layer | May import | Must never import |
|---|---|---|
| `domain` | `domain` only | discord.js, the DB driver, the ORM, `node:fs`, anything async |
| `application` | `domain`, `ports` | discord.js, the ORM, concrete repositories |
| `infrastructure` | `domain` (types), `ports` | `application`, `adapters` |
| `adapters` | `application`, `ports`, `domain` (types) | `infrastructure` concretes (they arrive by injection) |
| `composition` (the only place that wires concretes) | everything | — |

Enforced with `eslint-plugin-boundaries` (or `dependency-cruiser`) configured to **fail CI**, not warn (NFR-31). This one rule is what makes the whole spec's testability claims real; without mechanical enforcement, the layering rots in a month.

**No circular dependencies:** the graph is a DAG by construction — `adapters → application → domain`, with `infrastructure` depending only on `domain`/`ports` and being injected upward. The `ports` package is the seam that breaks the otherwise-inevitable cycle between application and infrastructure.

### 1.3 Module responsibilities

| Module | Responsibility | Depends on |
|---|---|---|
| `domain/xp/engine` | Runs the gate pipeline, produces `XpDecision` + trace | domain types only |
| `domain/xp/gates/*` | One file per gate; each is `(candidate, config, ctx) => TraceStep` | domain types |
| `domain/leveling/curve` | `xpForLevel`, `totalXpToReach`, `levelFromTotalXp`, cumulative table builder | none |
| `domain/leveling/rank` | Rank/progress view construction from raw numbers | curve |
| `domain/rewards/resolver` | `desiredRewardRoles(level, rules, mode)` and the diff | none |
| `domain/boosters/resolver` | Applicable-rule selection and bps math | none |
| `domain/restrictions/resolver` | Location chain + whitelist/blacklist verdict | none |
| `domain/periods/calendar` | `currentPeriodStart(now, tz, weekStart)` for week/month | a tz library (the one exception; pure computation) |
| `application/awardXp` | Transaction boundary; calls engine, repository, then dispatches side effects | domain, ports |
| `application/reconcileRewards` | Computes the diff, calls `DiscordRoleGateway`, records `broken_reason` | domain, ports |
| `application/voiceSessions` | Session lifecycle, tick crediting, startup reconciliation | domain, ports |
| `application/queries` | Rank view, leaderboard pages, booster/reward listings | ports |
| `application/config` | Read/write config with validation and cache invalidation; **this is the future dashboard's API** | domain, ports |
| `application/effects` | The side-effect dispatcher: level-up notification, reward reconcile, metrics | ports |
| `infrastructure/db` | Repositories, migrations, transaction helper | domain types, ports |
| `infrastructure/discord` | REST gateways (roles, messages), rate-limit-aware | ports |
| `infrastructure/cache` | In-memory implementations of `CooldownStore`, `ConfigCache`, LRUs | ports |
| `infrastructure/render` | Card renderer | ports, domain types |
| `adapters/discord/listeners` | One file per gateway event; maps to a use case | application |
| `adapters/discord/commands` | One file per command; validate, defer, call a use case, format | application |
| `adapters/jobs` | Schedulers that call use cases | application |
| `platform/plugin` | The plugin/module registry (see §2) | — |

### 1.4 Side-effect dispatch

`AwardXpUseCase` returns an `XpMutationResult`. Side effects are dispatched **after commit**, through an in-process event bus:

```
awardXp() -> commit -> emit XpAwarded{before, after, levelBefore, levelAfter, ...}
                        ├─ LevelUpNotifier      (if levelAfter > levelBefore && !silent)
                        ├─ RewardReconciler     (if levelAfter != levelBefore)
                        ├─ StatsRecorder        (already in the txn; metrics only here)
                        └─ MetricsSink
```

Each handler is independently failure-isolated: a thrown error is logged with correlation and does not affect siblings or the caller. This is FR/NFR-8 made concrete.

**Why an in-process bus and not a queue:** at this scale a queue adds a broker, at-least-once semantics we'd have to make idempotent, and operational surface, in exchange for durability of *notifications* — the least valuable thing to make durable. Migration point: replace the bus implementation with a queue producer; handlers become consumers; the `XpAwarded` payload is already a serializable value object precisely so this swap is mechanical.

---

## 2. Plugin architecture (for future modules)

The requirement is "additional modules could reasonably be added without rewriting leveling." The minimum viable seam:

```
interface BotModule {
  name: string
  requiredIntents: IntentFlag[]
  migrations: MigrationDir                  // owned, namespaced by table prefix
  commands: CommandDefinition[]             // registered by the central registrar
  listeners: { event: GatewayEvent, handler: (ctx) => Promise<void> }[]
  jobs: { name, schedule, handler }[]
  register(container: Container): void       // binds its own services
}
```

- The bot core owns: the gateway connection, the command registrar, the scheduler, the DB pool, logging, config plumbing, health.
- A module owns: its tables (prefixed), its commands, its listeners, its jobs.
- **Modules do not import each other.** If a future module needs leveling data it consumes a published read port (`LevelingQueryPort`), not a repository.
- Intents are the union of enabled modules' requirements, computed at boot.
- Leveling is itself implemented as a module (`modules/leveling`) from day one, so the seam is exercised rather than theoretical — this is the single most important structural decision for the "add features trivially" goal in the project description.

---

## 3. Project structure

```
.
├─ docker-compose.yml            # bot + postgres (+ optional pgadmin, backup)
├─ Dockerfile
├─ .env.example
├─ README.md
├─ docs/
│  ├─ spec/                      # this design spec
│  ├─ runbook.md                 # deploy, backup/restore, incident playbooks
│  └─ adr/                       # ADRs as they evolve past 09-adrs.md
├─ migrations/                   # versioned SQL, forward-only
│  ├─ 0001_core.sql
│  ├─ 0002_leveling_config.sql
│  └─ ...
├─ src/
│  ├─ main.ts                    # entrypoint: env → migrate → wire → connect
│  ├─ composition/               # THE ONLY place concretes are constructed
│  │  ├─ container.ts
│  │  └─ modules.ts              # which BotModules are enabled
│  ├─ platform/                  # module-agnostic bot core
│  │  ├─ plugin/                 # BotModule interface + registry
│  │  ├─ discord/                # client factory, intent computation, rate-limit wrapper
│  │  ├─ commands/               # registrar, deferral helper, permission guard, error boundary
│  │  ├─ jobs/                   # scheduler, single-flight, job_run bookkeeping
│  │  ├─ db/                     # pool, transaction helper, migration runner
│  │  ├─ cache/                  # LRU, TTL map, CooldownStore in-memory impl
│  │  ├─ config/                 # env schema + validation
│  │  ├─ logging/                # pino setup, correlation context
│  │  ├─ metrics/                # counters/histograms
│  │  └─ http/                   # /healthz, /readyz (and the future dashboard API host)
│  └─ modules/
│     └─ leveling/
│        ├─ index.ts             # the BotModule definition — the module's only export
│        ├─ domain/              # PURE. no external imports. the crown jewels.
│        │  ├─ curve/            # formulas, cumulative table, level<->xp
│        │  ├─ engine/           # pipeline runner, XpDecision, trace
│        │  ├─ gates/            # one file per gate
│        │  ├─ restrictions/
│        │  ├─ boosters/
│        │  ├─ rewards/          # desired-set resolver + diff
│        │  ├─ periods/          # week/month boundary math
│        │  ├─ voice/            # eligibility predicate, anti-afk decay, tick math
│        │  └─ types.ts
│        ├─ ports/               # interfaces the module needs from the outside
│        ├─ application/         # use cases (one file each)
│        │  ├─ awardXp.ts
│        │  ├─ reconcileRewards.ts
│        │  ├─ voiceSessions.ts
│        │  ├─ queries/          # rank, leaderboard, rewards list, boosters list
│        │  ├─ config/           # the future dashboard's API surface
│        │  ├─ admin/            # manual xp, reset, import, backfill
│        │  ├─ debug/            # dry-run pipeline, reward diff, health
│        │  └─ effects/          # levelup notifier, reward reconciler, stats
│        ├─ infrastructure/
│        │  ├─ repositories/     # SQL. one per aggregate.
│        │  ├─ discord/          # role gateway, message gateway
│        │  ├─ cache/            # config cache keyed by config_version
│        │  └─ render/           # rank card renderer, font registration
│        ├─ adapters/
│        │  ├─ listeners/        # messageCreate, voiceStateUpdate, reactionAdd, ...
│        │  ├─ commands/         # rank/, leaderboard/, xp/, level/
│        │  └─ jobs/             # voiceTick, highlights, firstPlace, retention
│        └─ migrations/          # module-owned SQL, merged by the runner
└─ tests/
   ├─ unit/                      # domain only. no db, no network. fastest suite.
   ├─ integration/               # use cases + real postgres (testcontainers)
   ├─ discord/                   # command/listener tests with a faked Discord port
   ├─ e2e/                       # optional: real bot + test guild, manually triggered
   └─ fixtures/                  # golden XP tables, curve vectors, card snapshots
```

**What belongs where — the test a reader should apply:**
- If it needs `guildId` and returns a number or a decision and imports nothing → `domain`.
- If it coordinates two of {DB, Discord, domain} → `application`.
- If it mentions a SQL string or a discord.js type → `infrastructure` or `adapters`.
- If it constructs a class with `new` and passes dependencies → `composition`.

---

## 4. Technology recommendations

### 4.1 Language / runtime

| | |
|---|---|
| **Recommendation** | **TypeScript on Node.js 22 LTS**, strict mode, ESM |
| Alternatives | Python 3.12, Go, Rust, Java/Kotlin |
| Advantages | discord.js is the most mature and best-documented Discord library; TS's type system expresses the domain (discriminated unions for `XpDecision`, branded snowflake types) cleanly; a future web dashboard shares types and validation schemas with the bot; excellent rank-card rendering options; enormous hiring/AI-assistance surface |
| Disadvantages | Single-threaded — CPU-bound card rendering blocks the event loop (mitigated by worker threads at scale); `BigInt` ↔ JSON friction for snowflakes; numeric types need care for `BIGINT` XP |
| Why here | The dashboard-later decision makes shared types materially valuable, and discord.js's maturity around gateway resumption, rate limiting, and sharding is exactly the boring-and-proven property we want for the parts we don't want to write. Python/discord.py is a completely reasonable alternative and would be my pick if you were more fluent in Python — say so and I'll re-cut the stack. |

### 4.2 Discord library

| | |
|---|---|
| **Recommendation** | **discord.js v14** |
| Alternatives | `@discordjs/core` + `@discordjs/ws` (lower level), Eris, Oceanic.js, Sapphire/Necord frameworks |
| Advantages | Handles gateway resume, rate limiting, sharding, caching, and interaction plumbing; huge community; typed |
| Disadvantages | Opinionated caching that can be memory-heavy (must configure `makeCache` sweepers explicitly); large dependency |
| Why here | We deliberately want none of that machinery to be our problem. Configure cache sweepers aggressively (message cache small, presence cache off) and it is a good fit. `@discordjs/core` would be right only at 1000+ guilds where cache control dominates. **Do not** use an opinionated framework (Sapphire/Necord) — it would impose its own architecture on top of ours. |

### 4.3 Database

| | |
|---|---|
| **Recommendation** | **PostgreSQL 16+** |
| Alternatives | SQLite (+WAL), MySQL/MariaDB, MongoDB |
| Advantages | Atomic `INSERT … ON CONFLICT … RETURNING` (the hot path, §`06` §4); window functions for rank; partial and expression indexes (the voice-session unique constraint, the broken-reward index); `timestamptz` with real timezone handling; JSONB for audit payloads; trivial in compose; a clean path to read replicas and RLS later |
| Disadvantages | A second container; more operational surface than a file |
| Why here | SQLite is genuinely viable for 1–50 guilds and would be simpler — but the three things that would push you off it (concurrent writers under a voice tick + message burst, partial unique indexes, and a future dashboard reading concurrently) are all things this design uses. Migrating SQLite→Postgres later is a real project; starting on Postgres costs one line of compose. MongoDB is wrong here: this data is highly relational and the correctness story depends on atomic SQL upserts and constraints. |

### 4.4 Query layer / ORM

| | |
|---|---|
| **Recommendation** | **Drizzle ORM** |
| Alternatives | Prisma, Kysely, raw `pg` + hand-written SQL, TypeORM/MikroORM |
| Advantages | SQL-shaped and thin; typed schema in TypeScript; **first-class escape hatch to raw SQL** (mandatory — our hot path is a hand-written upsert with `RETURNING`, and keyset pagination with tuple comparison is awkward in every ORM); built-in migration generation; no separate engine binary |
| Disadvantages | Younger than Prisma; some rough edges on complex queries |
| Why here | The critical queries in this system are ones an ORM's query builder handles badly, so the deciding criterion is "how painlessly can I drop to SQL and still get types." Drizzle wins that. Prisma's engine binary, its historically weak raw-SQL typing, and its connection-pool behavior make it a worse fit despite better DX elsewhere. Kysely is excellent but ships no migration story. **Raw `pg` is the honorable fallback** if the ORM ever fights us. |

### 4.5 Migrations

| | |
|---|---|
| **Recommendation** | **Drizzle Kit**, forward-only versioned SQL files, checked in, applied at boot before the gateway connects |
| Alternatives | node-pg-migrate, Flyway, Atlas, umzug |
| Advantages | Same toolchain as the query layer; generated migrations are reviewable SQL, not opaque |
| Disadvantages | Generated diffs need review; no automatic down-migrations |
| Why here | Forward-only is the correct discipline for a live bot: a down-migration that drops a column loses XP. Every destructive migration gets a documented manual rollback plan instead (NFR-39). |

### 4.6 Caching

| | |
|---|---|
| **Recommendation** | **In-process only** for MVP: `lru-cache` for bounded caches, a plain `Map` + sweep for cooldowns, all behind `ports` interfaces |
| Alternatives | Redis/Valkey from day one, Memcached, no cache at all |
| Advantages | Zero operational surface; nanosecond reads; correct by construction with a single process (no invalidation races) |
| Disadvantages | Lost on restart; wrong the moment there are two processes |
| Why here | See §6. Redis buys nothing at 50 guilds and costs a container, a failure mode, and serialization on every hot-path read. The interfaces exist so the swap is a composition-root change. |

### 4.7 Validation

| | |
|---|---|
| **Recommendation** | **Zod** |
| Alternatives | Valibot (smaller), TypeBox/AJV (faster, JSON-Schema), io-ts, manual |
| Advantages | One schema serves env validation, command option parsing, config setting bounds, CSV import validation, and (later) dashboard request bodies; inferred types; excellent error messages to surface directly to admins |
| Disadvantages | Bundle size and runtime cost (irrelevant server-side) |
| Why here | The setting registry (`03` §4.5, `/level config set` with autocomplete) is essentially "a map of name → Zod schema + description". Zod makes that registry ~40 lines. |

### 4.8 Logging

| | |
|---|---|
| **Recommendation** | **Pino** + `AsyncLocalStorage` for correlation context |
| Alternatives | Winston, `console` + JSON, OpenTelemetry logs |
| Advantages | Fastest structured JSON logger in Node; child loggers carry `guild_id`/`user_id` automatically; `pino-pretty` for local dev |
| Disadvantages | Less batteries-included transport ecosystem than Winston |
| Why here | Hot-path logging must be nearly free, and structured-by-default is what makes "why didn't this user get XP" answerable from logs. |

### 4.9 Testing

| | |
|---|---|
| **Recommendation** | **Vitest** (unit + integration) + **Testcontainers** for PostgreSQL |
| Alternatives | Jest, node:test, Mocha; docker-compose test DB instead of Testcontainers |
| Advantages | Fast, ESM-native, TS-native without transform config, great watch mode, built-in snapshot testing (used for card rendering and embed formatting) |
| Disadvantages | Testcontainers needs a Docker daemon in CI |
| Why here | The domain suite must be fast enough to run on save — that's what makes the XP engine actually get tested. A compose-based test DB is an acceptable fallback if Docker-in-CI is a problem. |

### 4.10 Rank card rendering

| | |
|---|---|
| **Recommendation** | **`@napi-rs/canvas`** (Skia bindings, prebuilt platform binaries) |
| Alternatives | `satori` + `@resvg/resvg-js` (JSX→SVG→PNG), `node-canvas` (needs Cairo system libs), Puppeteer/Playwright screenshot, `sharp` compositing, an external render service |
| Advantages | No system dependencies; excellent text shaping and font fallback via Skia; direct image drawing for avatars and backgrounds; fast (~50–150 ms per card) |
| Disadvantages | Imperative layout — you compute positions by hand; a redesign means editing drawing code |
| Why here | The card layout is fixed and simple (background, avatar circle, two text runs, a progress bar). Imperative drawing is fine for that, and the alternative's advantage (flexbox layout via satori) doesn't pay for a second pipeline stage. **Puppeteer is disqualified** — a headless Chromium per render is 200 MB of RAM and seconds of latency for a progress bar. If card layouts later become admin-designable templates, that is exactly the moment to switch to satori. |

### 4.11 Scheduling

| | |
|---|---|
| **Recommendation** | **In-process scheduler** — `setInterval` for the voice tick, a small cron library (`croner`) for calendar jobs, with `job_run` rows for idempotency and single-flight |
| Alternatives | BullMQ (Redis), pg-boss (Postgres-backed queue), system cron + a CLI entrypoint |
| Advantages | No broker; jobs are ordinary functions calling use cases; trivially testable |
| Disadvantages | Jobs die with the process; no retry queue; wrong with multiple instances |
| Why here | Every job here is either idempotent (highlights, first-place, retention) or self-healing (voice tick reconciles on startup). Durable queuing solves a problem we don't have. **Migration point:** `pg-boss` when there are two processes — it reuses the database we already run, which is why it beats BullMQ/Redis as the next step. |

### 4.12 Containerization & deployment

| | |
|---|---|
| **Recommendation** | Multi-stage **Dockerfile** (build → slim runtime, non-root user) + **docker compose** (bot, postgres, optional nightly `pg_dump` sidecar) |
| Alternatives | Bare systemd service, PM2, Kubernetes, a PaaS (Railway/Fly/Render) |
| Advantages | One-command deploy (US-37); reproducible; the same image runs locally and in production |
| Disadvantages | Requires Docker on the host |
| Why here | Self-hosting a bot + database is exactly what compose is for. Kubernetes at 50 guilds is theatre. A PaaS is a fine deployment *target* for the same image if you'd rather not run a host. |

### 4.13 Supporting choices

| Concern | Recommendation | Note |
|---|---|---|
| Timezone math | `Temporal` (Node 22 polyfill) or `luxon` | Never manual offset arithmetic (`05` §2.4) |
| Metrics | `prom-client` exposing `/metrics` | Optional in MVP; the `MetricsSink` port exists from day one with a no-op impl |
| Env config | Zod schema, fail-fast at boot | US-37 AC2 |
| Lint/format | ESLint (flat config) + `eslint-plugin-boundaries` + Prettier | The boundaries plugin is load-bearing, not cosmetic |
| CI | GitHub Actions: typecheck → lint → unit → integration (with a Postgres service) → build image | |
| Error tracking | Sentry (optional, off by default) | Self-hosters may not want it |

---

## 5. Concurrency & data integrity

### 5.1 The threats and their answers

| Threat | Mechanism |
|---|---|
| **Two messages from one member land simultaneously** | (a) The cooldown store's synchronous check-and-set makes the second a no-op in the common case (`04` §5.3). (b) If both pass (different sources), the atomic `ON CONFLICT DO UPDATE SET total_xp = total_xp + delta` sums them — no lost update. |
| **Manual `/xp add` races an automatic award** | Same atomic increment. Both deltas apply. The level-up notification may fire from either, but §5.2 prevents duplicates. |
| **Two level-up events in quick succession** | Level-change detection uses `before`/`after` from **one** atomic statement, so the two writes see `(0→75)` and `(75→180)` — two distinct, correct transitions. It is impossible for both to observe the same "before". |
| **Duplicate level-up notification for the same level** | The notifier is driven by `levelAfter > levelBefore` from an atomic observation, so the same crossing cannot be observed twice by two writers. Additionally, an in-memory `(guild,user,level)` LRU suppresses a duplicate within 60 s as belt-and-braces. |
| **Discord redelivers an event** | Idempotency keys (`04` §6). |
| **Two concurrent role reconciliations for one member** | A per-member in-process async mutex around reconciliation; the operation is also idempotent (diff of desired vs actual converges), so the worst case is a redundant no-op API call. |
| **Voice tick overlaps the previous tick** | The tick job is single-flight (a module-level `isRunning` flag plus a `job_run` row); a tick that overruns its interval skips rather than stacking. |
| **Two open voice sessions for one member** | Partial unique index — the database refuses (`06` §2.9). The handler catches the unique violation and treats it as "session already open". |
| **Leaderboard read during writes** | Postgres MVCC: readers never block writers. A page is a consistent snapshot of that statement. Keyset pagination keeps *multi-page* traversal sane despite concurrent writes. |
| **Config read during a config write** | Config is cached by `config_version`; a write bumps the version and invalidates. A hot-path event may use a config that is one write stale for microseconds — harmless. |
| **Backfill running twice** | Advisory lock (`pg_advisory_lock` on a hash of the guild ID) plus a `job_run` row. |
| **Reset racing an award** | The reset runs in a transaction that takes a row lock (`SELECT … FOR UPDATE`) on the member rows it clears; a concurrent award either lands before (and is cleared) or after (and survives). Both are acceptable; neither corrupts. |

### 5.2 Where to use what

| Mechanism | Where | Not where |
|---|---|---|
| **Atomic SQL upsert** | Every XP/stat/period write | — |
| **Transaction** | XP + stats + period buckets (must agree); reset; import batches | Around Discord API calls — **never**. A transaction must never be open across a network call to Discord. |
| **In-process async mutex** (keyed by `guild:user`) | Serializing an individual member's XP pipeline so the cooldown check-and-set and the write are not interleaved | Anything cross-guild |
| **Postgres advisory lock** | Guild-scoped long jobs (backfill, server reset) | Hot path |
| **Partial unique index** | One open voice session per member | — |
| **Idempotency key** | Every XP-granting entry point | — |
| **Optimistic concurrency (`config_version`)** | Config writes from the future dashboard | Hot path |

### 5.3 Deliberately not built (and why that's safe)

- **No distributed locks, no leader election, no Redlock.** Single process. Every mechanism above is either DB-level (correct regardless of process count) or in-process (correct for one process). The design therefore **remains correct** when a second process appears, except for two things which are explicitly listed as migration blockers: the cooldown store and the voice tick's single-flight. Both are behind interfaces.
- **No event sourcing.** The `XpAwarded` event exists in memory for side-effect dispatch, not as a persisted log. Persisting it would be the largest table in the system for a benefit (replay) we don't need.
- **No two-phase commit across Discord and the DB.** Impossible anyway; instead, the DB write is authoritative and Discord effects are idempotent retries.

---

## 6. Caching strategy

### 6.1 What lives where

| Data | Location | TTL / invalidation | Size bound | Cost of loss |
|---|---|---|---|---|
| Guild config + source config + rules + rewards | **Process memory**, one composite object per guild, keyed by `config_version` | Invalidated on write; 10 min idle TTL | ≤ number of guilds (trivial) | One DB read |
| Cooldowns | **Process memory** `Map` + 60 s sweep | Entry TTL = cooldown duration | LRU cap 200k | One extra XP grant per member |
| Idempotency keys (message, voice) | **Process memory** LRU | ~10 min | 50k entries | One duplicate grant after a redelivery — rare and harmless |
| Idempotency keys (reaction) | **Database** (`reaction_award`) | 90-day retention | — | Farming becomes possible → must be durable |
| Member XP | **Not cached** | — | — | — |
| Leaderboard pages | **Process memory**, keyed `(guild, metric, cursor)` | 30 s | 500 entries | A slightly stale board |
| Rank views | **Not cached** | — | — | Members expect `/rank` to be live |
| Avatar bytes | **Process memory** LRU keyed by `avatar_hash` | 1 h | 200 entries / 50 MB | An extra CDN fetch |
| Background images | **Process memory** LRU | 1 h | 50 entries / 50 MB | An extra fetch |
| Fonts | Loaded once at boot | forever | — | — |
| Voice sessions | **Database** (authoritative) with an in-memory index of open sessions | Rebuilt on startup | ≤ concurrent voice users | Handled by reconciliation (`04` §8.6) |
| Message author for reaction-receive | **Process memory** LRU | 30 min | 10k entries | An extra API fetch |
| Channel → category / thread → parent | **discord.js cache** | library-managed | configured sweepers | An extra API fetch |
| Temporary boosters | Part of the config cache; **expiry evaluated at read time** | — | — | — |

**Why member XP is not cached:** it changes on every write, is read almost exclusively by the write itself (which needs the authoritative value anyway), and a cache would introduce the exact staleness bug that atomic increments were chosen to avoid.

### 6.2 Does the MVP need Redis?

**No.** Concretely, at 50 guilds:

- Config cache: ~50 objects. A `Map` is not just adequate, it is *better* than Redis (no serialization, no network hop, no invalidation race).
- Cooldowns: peak maybe 5,000 live entries. ~500 KB.
- Leaderboard cache: a few hundred KB.
- Total incremental memory: single-digit megabytes.

Redis would add a container, a connection failure mode, a serialization cost on the hottest path, and an invalidation protocol — to solve nothing.

**When Redis becomes useful, precisely:**

1. **The moment a second bot process exists** (sharding, or a separate dashboard process that writes config). Then cooldowns must be shared (or duplicated XP becomes possible across shards handling the same guild — though note Discord routes a guild to exactly one shard, so even *this* is not automatic) and config invalidation needs pub/sub. **This is the real trigger, and it arrives at roughly 2,000+ guilds** where sharding becomes mandatory.
2. If leaderboard read volume ever justifies a shared cache — realistically only with a public web leaderboard.
3. If cooldown loss on restart ever matters — it doesn't.

**Migration path:** `CooldownStore`, `ConfigCache`, and `QueryCache` are ports with in-memory implementations. Adding Redis means writing three implementations and changing one line in `composition/container.ts`. Recorded as ADR-009.
