# 08 — Security & Abuse, Failure Matrix, Observability, Testing, Scalability

---

## 1. Security & Abuse Prevention

### 1.1 The technical / configurable / policy split

The useful question is not "is this abuse?" but "who should decide?"

| Vector | Handling | Rationale |
|---|---|---|
| Bot accounts earning XP | **Technical, hard-coded.** Never awarded. | No legitimate use; making it configurable creates a footgun with no upside |
| Webhook messages earning XP | **Technical, hard-coded.** `webhook_id` present → reject. | A webhook can impersonate any user; "trusted webhook XP" is an XP-minting API |
| Self-XP by the bot itself | **Technical, hard-coded.** | — |
| System messages (joins, boosts, pins) | **Technical**, via a message-type allowlist | Not participation |
| Message spam | **Configurable**: cooldown (default 60 s) | Guilds legitimately differ on pace |
| Very short messages ("a", "k") | **Configurable**: `min_message_length` (default 0) | Requires the Message Content intent; some guilds don't want the intent |
| Reaction farming (add/remove loops) | **Technical**: durable per-`(message, reactor, emoji)` dedup | There is no legitimate reason to earn twice for one reaction |
| Self-reactions | **Configurable**, default deny | Some guilds may want to allow it |
| One person mass-reacting to a friend's messages | **Configurable**: receive cooldown + `reaction_max_per_message` | Threshold is a community judgment |
| Voice AFK farming | **Configurable**: mute/deaf requirements, `voice_min_members`, anti-AFK decay | Different communities have different voice norms |
| Voice channel-hopping to reset anti-AFK | **Technical**: the session survives channel moves | An implementation detail, not a policy |
| Two people sitting muted in a channel to farm | **Configurable**: minimum-member counting rule + mute requirements | — |
| Alt-account farming | **Not technically solvable.** Mitigations offered as config: `min_account_age_days`, `min_member_age_hours`. | Discord provides no reliable identity signal. Pretending to solve it would be dishonest; giving admins the levers is the correct answer |
| Admin inflating XP for friends | **Configurable + audited**: `manual_xp_level_limit` (default 100, Arcane parity), `xp_command_owner_only`, full audit log | An admin with Manage Server can already do far worse; the answer is transparency, not prevention |
| Admin wiping the server's leaderboard | **Configurable**: `disable_resets`, owner-only confirmation | — |
| Malicious configuration values | **Technical**: every setting bounded and validated server-side; `per_event_cap`; `MAX_MULT_BPS` | A `999999x` booster should be impossible to set, not merely unwise |
| Mention injection in level-up templates | **Technical**: `allowed_mentions` restricted to the leveling member only | String-filtering `@everyone` is defeatable; the API-level control is not |
| SSRF via custom card backgrounds | **Technical**: HTTPS only, host allow-list, no cross-host redirects, size cap, magic-byte content check, DNS resolution checked against private ranges | The classic image-upload vulnerability |
| Decompression / pixel bombs in backgrounds | **Technical**: dimension caps checked before decode; render timeout | — |
| CSV import bombs | **Technical**: 5 MB / 100k row caps, streaming parse, batch transactions, dry-run default | — |
| Command permission bypass via Discord's Integrations settings | **Technical**: re-check permissions server-side in every handler | `default_member_permissions` is a UI hint an admin can override |
| Paginator button hijacking | **Technical**: invoker ID embedded in the custom ID | — |
| Secrets in logs | **Technical**: pino redaction paths for token/env; never log the full config object | — |
| DoS by command spam | Discord's own interaction rate limits, plus a per-user in-process token bucket on expensive commands (card render, leaderboard) | — |

### 1.2 Operational security

- Bot token in an env var only; never in the repo, never in logs, never echoed by `/level debug health`.
- Least-privilege OAuth2 invite URL published in the README with exactly the permissions in `03` §2 — never Administrator.
- Container runs as a non-root user; the DB is not port-published outside the compose network by default.
- Dependencies pinned via lockfile; Dependabot/Renovate for updates; `npm audit` in CI.
- The database is the only durable secret-adjacent asset; the backup procedure in the runbook must cover encryption at rest for backups placed off-host.

---

## 2. Failure Modes & Edge-Case Matrix

| # | Scenario | Detection | Expected behavior |
|---|---|---|---|
| **Configuration & Discord objects** ||||
| 1 | Guild deletes a role configured as a reward | `GUILD_ROLE_DELETE` or 404 | Mark rule `broken_reason='role_deleted'`; keep the rule; hide from member-facing lists; show in `/level rewards list` and `health`; notify admins once per 24 h |
| 2 | Guild deletes a configured channel (level-up channel, restricted channel, booster channel) | `CHANNEL_DELETE` | Restrictions/boosters targeting it become inert (no error). Level-up channel: fall back to **no message** (not the source channel — that would surprise) and flag in health |
| 3 | Bot loses Manage Roles | 403 on assignment, or permission check | Reconciliation records `missing_permission`; XP and messages continue normally; health shows a guild-level banner; one admin notification per 24 h |
| 4 | Bot's role moves below a reward role | Position check before the call; 403 otherwise | `broken_reason='hierarchy'` with the exact remediation text |
| 5 | Bot loses Send Messages in the level-up channel | 403 | Suppress messages, log once/hour/guild, flag in health. **Never retry in a loop** |
| 6 | Reward role is a managed/integration role | `role.managed` | Refused at configuration time; if it becomes managed later, `broken_reason='managed'` |
| 7 | Category re-parented, changing restriction scope | `CHANNEL_UPDATE` | Location chain is resolved live from the channel cache, so it is correct on the next event. No stored denormalization to fix |
| 8 | Admin sets a channel both whitelisted and blacklisted | Config write | Allowed but warned at write time; blacklist wins (`04` §3.2); `/level restrict list` shows the contradiction |
| 9 | Admin sets `min_xp > max_xp` | Validation | Rejected at write time with a clear message |
| 10 | Admin changes the curve | Config write | Everyone's level changes instantly; warned with a preview; rewards flagged as needing backfill; **no level-up messages fire** |
| **Members** ||||
| 11 | Member leaves the guild | `GUILD_MEMBER_REMOVE` | Data retained by default; `is_departed = true`; still on the leaderboard (labeled) unless hidden. If `auto_reset_on_leave`, data is deleted and audited |
| 12 | Member rejoins | `GUILD_MEMBER_ADD` | XP restored (it was never deleted); reward roles reconciled to their level; `is_departed=false`. If auto-reset was on, they start fresh — and the setting's description says so plainly |
| 13 | Member changes username / nickname / avatar | `GUILD_MEMBER_UPDATE` | Snapshot columns updated opportunistically; nothing else changes |
| 14 | Member deletes a message after earning XP | Not observed (we don't consume `MESSAGE_DELETE`) | **No clawback.** Documented behavior |
| 15 | Member edits a message | Not observed | No change to XP |
| 16 | A reaction is removed | Not observed | No clawback; dedup key persists so it cannot be re-earned |
| 17 | Member is at max level | Gate 9 | Level frozen, XP continues (default), no level-up messages |
| 18 | Member's XP is set to 0 | Manual | Row retained with stats; level 0; unranked; reward roles removed if `remove_on_level_down` |
| 19 | Member drops many levels at once | Manual removal | Reconcile once to the final desired set (not level by level); no notification |
| 20 | Member has a no-XP role **and** a booster role | Gate 5 | No XP. Deny code `role_denied`. Boosters never evaluated |
| 21 | Member with 0 XP runs `/rank` | Query | "No XP yet" state, unranked, no error |
| 22 | `/rank` on a bot | Validation | Refused with an explanation |
| **Events & timing** ||||
| 23 | Discord delivers an event twice | Idempotency key | Second occurrence is a no-op; trace records `duplicate` |
| 24 | Reaction on an uncached message | Cache miss | One API fetch, LRU-cached; on failure, skip receive-XP silently (log at debug) |
| 25 | Configuration changes while members are active | `config_version` bump | Next event uses the new config; in-flight events complete with the old one. No mid-event inconsistency because config is read once per evaluation |
| 26 | Two level-ups within milliseconds | Atomic before/after | Two distinct correct transitions; at most one notification per level |
| **Voice** ||||
| 27 | Bot crashes during a voice session | Startup reconciliation | Session resumed if the member is still in voice; downtime is not credited; ≤ one tick lost |
| 28 | Bot restarts gracefully during voice | SIGTERM handler | Partial credit flushed; session left open with a heartbeat; resumed on boot with no loss beyond the restart gap |
| 29 | Member moves between voice channels | `VOICE_STATE_UPDATE` | Session mutates; accrued time and anti-AFK age preserved; eligibility re-evaluated |
| 30 | Member alone in a voice channel | Member-count re-evaluation on every channel state change | Ineligible while `voice_min_members` is unmet; time not credited; session stays open |
| 31 | A bot joins the voice channel | Member count | Bots excluded from the count by default |
| 32 | Member deafens themselves for 3 hours | Eligibility flip | Ineligible period never credited; session ages for anti-AFK purposes only if configured (default: eligible time only) |
| 33 | Member sits in voice 12 hours | Anti-AFK | XP per tick decays to the floor multiplier |
| 34 | Orphaned voice session (heartbeat stale > 1 h) | Sweep job | Closed with `end_reason='orphaned'`; credited only to `last_credited_at` |
| **Infrastructure** ||||
| 35 | Database temporarily unavailable | Pool errors | Stop awarding XP; **do not crash**; commands reply "temporarily unavailable" with a correlation ID; retry with backoff; `/readyz` returns 503; recover automatically. Voice ticks skip (sessions are reconciled later) |
| 36 | Database returns a unique-violation on voice session insert | Constraint | Treated as "session already open"; fetch and continue |
| 37 | Discord API unavailable / 5xx | discord.js | Library retries; gateway auto-reconnects; role ops retried with backoff then deferred to the next reconciliation; XP writes continue (they don't need Discord) |
| 38 | Discord rate limit (429) | `Retry-After` | Honored by the library; bulk role ops throttled below the limit by design; level-up messages dropped rather than queued unboundedly during a storm |
| 39 | Gateway disconnect and resume | `RESUMED` | No heavy reconciliation; missed events are replayed by Discord where possible; voice reconciliation only on a fresh `READY` |
| 40 | Guild becomes unavailable (Discord outage) | `GUILD_DELETE` with `unavailable: true` | **Not** treated as removal. No data deletion, no session closing |
| 41 | Bot removed from a guild | `GUILD_DELETE` without `unavailable` | `left_at` set, jobs stop, data retained for the retention window, then cascade-deleted |
| 42 | Bot re-added to a guild within the window | `GUILD_CREATE` | Everything restored; `is_active=true` |
| 43 | Migration fails at boot | Migration runner | Process exits non-zero **before** connecting to Discord. Never run on a mismatched schema |
| 44 | Missing privileged intent | `READY` / login error | Fail fast with an explicit message naming the intent and the developer-portal toggle; or, for `MessageContent`, start with dependent features disabled and a loud warning |
| 45 | Card render fails or times out | Try/catch + 3 s budget | Fall back to the text embed; log; never fail the command |
| 46 | Avatar/background fetch fails | Timeout | Default avatar / plain background; render proceeds |
| 47 | Leaderboard contains members who left | Query | Rendered from the display-name snapshot with a marker, or hidden per config |
| 48 | Leaderboard is empty | Query | Friendly empty state |
| 49 | Interaction not answered within 3 s | Deferral discipline | All slow commands defer first; a missed deferral is a bug caught by an integration test |
| 50 | Two backfills requested for one guild | Advisory lock | Second is refused with "a backfill is already running" |
| 51 | Highlights window missed due to downtime | `job_run` + grace window | Posted late if within `highlight_grace_hours`, else skipped with a log; **the period bucket itself is unaffected** |
| 52 | Clock/DST boundary | Zoned period computation | Week/month boundaries are local midnight; DST weeks are 167/169 h; correct by construction |
| 53 | XP overflow | `BIGINT` + bounds on curve config | Configuration that would exceed safe integers at level 1000 is refused |

---

## 3. Observability & Debugging

### 3.1 The decision trace — the core mechanism

Every XP evaluation produces `XpDecision.trace`: an ordered list of `{ gate, verdict, detail, data }`. This one object answers all three of the brief's questions:

| Question | Answered by |
|---|---|
| "Why didn't this user receive XP?" | `/level debug why @user #channel` — a dry run producing the trace, in **collect-all mode** so every failing gate is shown, not just the first |
| "Why didn't this reward role get assigned?" | `/level debug rewards @user` — desired set vs actual, with the per-role blocking reason and a retry button |
| "Why did this user receive this amount of XP?" | The same trace, showing base roll, effort bonus, each applicable booster with its bps, the stacking mode, the anti-AFK factor, and the final rounding |

Example output of `/level debug why`:

```
XP evaluation — @alice in #general, source: message   (DRY RUN — nothing awarded)

  ✓ module_enabled          leveling is enabled
  ✓ source_enabled          message XP is on (random, 15–25, 60s cooldown)
  ✓ actor_is_human          not a bot or webhook
  ✓ actor_eligible          not ignored; account and member age OK
  ✗ role_denied             holds @Muted, which is a no-XP role
  ✗ channel_denied          #general is inside category "Archive", which is a no-XP category
  – cooldown                skipped (would have passed: no active cooldown)
  – base_xp_roll            skipped
  – multiplier_stack        skipped (would have been ×1.35: @Booster +25%, server +10%)

  Result: NO XP.  Fix either the @Muted role or the "Archive" category restriction.
```

That output is the product differentiator, and it exists only because the engine was designed to produce a trace as a first-class output rather than as a debug afterthought.

### 3.2 Structured logging

| Level | What |
|---|---|
| `error` | Unhandled exceptions, DB failures, migration failures, unexpected Discord errors |
| `warn` | Permission/hierarchy failures, broken rewards, dropped level-up messages, rate-limit backoffs, skipped jobs |
| `info` | Startup/shutdown, guild join/leave, config changes, job start/finish with counts, backfill progress |
| `debug` | XP awards with the compact trace, cooldown denials (sampled), voice transitions |
| `trace` | Full traces for every evaluation — **sampled** (default 1%) or enabled per-guild for a time window via `/level debug` |

Every log line carries `guild_id`, `user_id` where relevant, `event_id` (correlation), `module`, and `version`. Implemented with pino child loggers bound in `AsyncLocalStorage` so handlers don't thread context manually.

**Never logged:** message content, tokens, full config objects, card background bytes.

### 3.3 Metrics

| Metric | Type | Purpose |
|---|---|---|
| `events_received_total{event}` | counter | Gateway throughput |
| `xp_evaluations_total{source,outcome,deny_reason}` | counter | The single most useful metric — deny-reason distribution instantly shows a misconfiguration |
| `xp_awarded_total{source}` | counter | |
| `levelups_total` | counter | |
| `role_operations_total{op,result}` | counter | Grants/removals and their failure classes |
| `discord_api_errors_total{code}` | counter | 403/404/429 breakdown |
| `xp_pipeline_duration_seconds` | histogram | NFR-4 budget |
| `db_query_duration_seconds{query}` | histogram | |
| `card_render_duration_seconds` | histogram | NFR-6 budget |
| `job_duration_seconds{job}` / `job_last_success_timestamp{job}` | histogram / gauge | Job health |
| `voice_sessions_open` | gauge | |
| `cache_hit_ratio{cache}` | gauge | Validates the caching decisions |

Exposed at `/metrics` (Prometheus). Optional — the `MetricsSink` port has a no-op implementation so a self-hoster who doesn't want Prometheus loses nothing.

### 3.4 Health checks

| Endpoint | Returns 200 when |
|---|---|
| `/healthz` | The process is alive (liveness) |
| `/readyz` | Gateway connected **and** a DB round trip succeeded within 1 s (readiness) |

`/level debug health` is the human-facing version: intents required vs granted, per-guild permission problems, dangling config targets (deleted channels/roles), broken rewards, DB latency, each job's last success time, and the running version/commit (NFR-41).

### 3.5 Audit trail

Every mutation an admin makes is recorded (`06` §2.12): actor, action, target, before/after, reason, timestamp. Exposed via a future `/level debug audit` command (Post-MVP) and queryable directly. This is what makes "an admin quietly gave their friend 50 levels" discoverable.

---

## 4. Testing Strategy

### 4.1 The pyramid, and what goes where

| Layer | Scope | Tooling | Speed target |
|---|---|---|---|
| **Unit (domain)** | Curve math, gates, restriction resolution, booster stacking, reward resolver, period calendar, anti-AFK decay, rounding, trace shape | Vitest, no I/O, injected clock + seeded RNG | Whole suite < 2 s |
| **Integration (application + DB)** | Use cases against a real Postgres: atomic increments, level-change detection, transactions, period bucket writes, voice session lifecycle, resets, imports | Vitest + Testcontainers | < 60 s |
| **Database** | Constraint enforcement, index presence, cascade behavior, guild-isolation assertions, migration up-from-empty | Vitest + Testcontainers | < 30 s |
| **Discord adapter** | Listener mapping, command validation, deferral discipline, permission re-checks, error boundaries, embed/paginator formatting — all against a **faked Discord port**, no network | Vitest + hand-written fakes | < 10 s |
| **End-to-end** | A real bot in a test guild: invite, configure, send a message, level up, receive a role | Manual checklist + optional scripted run | on demand |

### 4.2 Coverage by concern (the brief's list)

| Concern | Level | Key cases |
|---|---|---|
| XP calculations | Unit | Every curve at levels 0/1/10/50/100 against the **golden fixture** (`04` §4.3 numbers); multiplier rounding; per-event cap; per-word mode; effort bonus |
| Cooldowns | Unit + Integration | Fixed-window semantics; denial does not consume; per-source independence; the check-and-set race (concurrent awards) |
| Boosters | Unit | Stack vs highest; additive bps; expiry; negative bonuses; interaction with anti-AFK; the multiplier ceiling |
| Restrictions | Unit | The full precedence table including whitelist+blacklist conflict; thread/category chain resolution; role denial beating boosters; **the brief's worked example as a named test** |
| Level transitions | Unit + Integration | Single level up; multi-level jump from one event; multi-level drop; exact-threshold boundaries (X = totalXpToReach(N) exactly); max level; level 0 |
| XP removal | Integration | Floor at 0; reward removal; stats preserved; period buckets unaffected |
| Role rewards | Unit + Discord-fake | Desired-set computation in both modes; recurring rules; the diff never touches unmanaged roles; every failure classification (deleted/hierarchy/permission/managed); reconciliation idempotency |
| Leaderboard ordering | Integration | Tie-break stability; keyset pagination with concurrent writes; departed members; empty guild; each metric |
| Weekly/monthly statistics | Unit + Integration | Period boundary computation across timezones, week-start days, DST transitions, month lengths, leap years; writes land in the right bucket; lifetime XP unaffected; a "reset" is observable without any job running |
| Voice sessions | Unit + Integration | Every transition in `04` §8.3; channel move preserves accrual; eligibility flips; anti-AFK curve; **restart reconciliation in all four cases** (still in voice / left / orphaned / new); the partial unique constraint |
| Permissions | Discord-fake | Every admin command refuses without Manage Server; owner-only settings; `disable_resets`; paginator hijack protection |
| Discord API failures | Discord-fake | 403 on role add → recorded not thrown; 404 → marked broken; 429 → honored; 5xx → retried then deferred; message send failure → XP still committed |
| Idempotency | Integration | Duplicate message/reaction/voice-tick/interaction events |
| Concurrency | Integration | N parallel awards for one member sum correctly and produce exactly the right number of level-up events |
| Guild isolation | Database | Two guilds, same user IDs, every path, zero leakage |
| Migrations | Database | Up from empty; up from the previous release's schema; idempotent re-run |
| Card rendering | Unit + snapshot | Long names, CJK, Arabic, emoji, default avatars, missing background, max level, rank 1 vs rank 9999 |

### 4.3 Test design rules

1. **The domain suite must never require Docker.** It is the suite that runs on every save; if it needs a container it will stop being run.
2. **Golden fixtures for the math.** The verified numbers in `04` §4.3 go into a checked-in table; any change to the curve code that alters them fails loudly. This is what prevents an "innocuous refactor" from silently re-leveling every server.
3. **Time and randomness are injected**, never read from globals. `Clock` and `Rng` are ports. A test that needs "3 hours later" advances a fake clock.
4. **The Discord fake is hand-written, not a mock library.** It records calls and returns programmable responses (including 403/429), so failure-path tests are readable.
5. **Property-based tests** for the curve: for random `(curve, multiplier, X)`, assert `totalXpToReach(levelFromTotalXp(X)) <= X < totalXpToReach(levelFromTotalXp(X)+1)` — this invariant catches every off-by-one in the cumulative-table implementation.
6. **No test asserts on log output** except the dedicated logging tests.
7. CI gates: typecheck, lint (including the boundary rule), unit, integration. A failing boundary rule fails the build.

---

## 5. Scalability

### 5.1 By guild count

| Scale | Architecture | What changes |
|---|---|---|
| **10 guilds** (your target) | Single process, single Postgres, in-memory caches, in-process scheduler, one container each. | Nothing. Event volume is a handful per second. A 512 MB / 1 vCPU host is generous. |
| **100 guilds** | Identical. | Tune discord.js cache sweepers (message cache to ~50/channel, no presence cache). Consider moving card rendering to a worker thread if p99 message-XP latency degrades. DB stays trivially small (~100k rows). Watch the **10,000-unique-user** privileged-intent threshold (`03` §1.1) — 100 guilds averaging 100 members crosses it, so this arrives by user count, not guild count. |
| **1,000 guilds** | Still single process, **one shard is still fine** (Discord requires sharding at 2,500 guilds). | Connection pool sized ~20. Add proper indexes-in-anger review; `EXPLAIN` the leaderboard and rank queries. Voice ticks now touch maybe 2–5k open sessions per interval — batch them into a single multi-row `UPDATE … FROM (VALUES …)` rather than N statements. Move card rendering to a worker pool. Consider `pg-boss` for the backfill/highlights jobs so a restart doesn't lose them. Metrics become genuinely necessary. |
| **10,000+ guilds** | Sharded, multi-process. **This is where the architecture actually changes.** | (1) **Sharding**: `ShardingManager` or a separate gateway process per shard group. Discord routes each guild to exactly one shard, so guild-scoped in-memory state stays correct per shard — but any process that isn't the guild's shard owner (a dashboard API, a job runner) must not hold that state. (2) **Redis** for `CooldownStore`, `ConfigCache` invalidation pub/sub, and leaderboard caching. (3) **Job runner as a separate process** with `pg-boss`, since jobs must not run once per shard. (4) **Database**: read replica for leaderboard/dashboard queries; partition `member_period_xp` and `reaction_award` by time; PgBouncer in transaction mode. (5) **Leaderboard**: consider materialized top-N per guild refreshed on a cadence, since a public web leaderboard's read volume dwarfs the bot's. (6) **Voice ticks**: shard-local, batched, and staggered so all guilds don't tick on the same second. |

### 5.2 Clean migration points (the deliverable that matters)

Each of these is a bounded change because of a decision made now:

| Migration | Enabled by | Effort |
|---|---|---|
| In-memory cache → Redis | `CooldownStore` / `ConfigCache` / `QueryCache` ports | 3 implementations + 1 line in the container |
| In-process bus → durable queue | `XpAwarded` is a serializable value object; handlers are already isolated | Replace the bus impl; handlers become consumers |
| In-process scheduler → `pg-boss` | Jobs are plain functions calling use cases; `job_run` already provides idempotency | Swap the scheduler adapter |
| Single process → sharded | discord.js `ShardingManager`; no cross-guild in-memory state anywhere; all correctness is DB-level or per-guild | Composition change + Redis (above) |
| Bot-only → bot + dashboard | Config and query use cases are already an API-first service with no Discord types in their signatures | Add an HTTP adapter over the same use cases |
| Postgres → Postgres + read replica | All reads go through repositories | Route the query repositories to a second pool |
| Sync card render → worker pool | `CardRenderer` is a port taking a plain `RankView` and returning a buffer | Swap the implementation |
| Counters → periodic aggregation | Leaderboard reads go through a query service | Replace the query implementation; the write path is unchanged |

### 5.3 What will break first, in order

Useful for knowing where to look when growth happens:

1. **Privileged intent review at 10,000 unique users**, plus the annual reapplication that applies from day one — a paperwork gate, not a load one, and the first hard wall. Note it is measured in *users*, so a handful of large guilds trips it long before the guild count looks significant.
2. **discord.js default caches** (messages, members) → memory growth. Fix with sweepers; cheap.
3. **Event-loop stalls from card rendering** → p99 latency on message XP. Fix with worker threads.
4. **N-statement voice ticks** → DB round-trip amplification. Fix by batching.
5. **Discord role rate limits during backfills** → already throttled by design, but the throttle constant will need tuning.
6. **The 2,500-guild sharding requirement** — a hard Discord limit, and the real architectural boundary.

Everything before step 6 is tuning. Step 6 is the redesign, and §5.2 is the map for it.
