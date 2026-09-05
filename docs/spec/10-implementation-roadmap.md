# 10 — Implementation Roadmap

Each milestone leaves the system in a **coherent, demonstrable state**. Nothing is half-wired at a milestone boundary.

## Sequencing rationale — where this differs from the order in the brief

The brief's suggested order was: foundation → Discord → persistence → config → message XP → engine → rank → leaderboards → rewards → restrictions → boosters → voice → reactions → cards → admin → hardening.

Five changes:

1. **The leveling engine and curve come before any Discord wiring**, not after message XP. The engine is pure and testable with zero infrastructure; building it first means the entire core is proven before a single gateway event exists, and it converts the riskiest part of the project (the math and precedence rules) into the cheapest part to get wrong and fix.
2. **Restrictions move ahead of leaderboards and rewards.** A leveling bot without restrictions is unusable in a real server (the bot-command channel farms XP immediately), so restrictions belong with message XP, not three milestones later. They are also gates in the same pipeline — building them separately means touching the engine twice.
3. **Admin `/xp` commands move much earlier** (M5, with the engine). They are the primary way to *test* everything downstream — you cannot verify rewards, leaderboards or level-up messages without being able to set someone's XP. Building them last means hand-crafting SQL to test every feature in between.
4. **The plugin seam is M1, not a hardening step.** Retrofitting a module boundary after leveling is written is a refactor of everything; establishing it first costs an afternoon.
5. **Voice XP lands before hardening, inside v1.0** (decision A10). It is the largest and only stateful source, so it goes immediately after the debugging milestone — the tooling from M8 is what makes voice's failure modes (a silently stopped tick job, eligibility churn, restart recovery) diagnosable while you build them, rather than after. Hardening then covers voice too, instead of being redone for it.

Rewards move slightly later than the brief implies (after leaderboards) because they need `GuildMembers` and the failure-classification machinery, and because a bot that awards XP and shows rank is already useful to demo.

---

## M0 — Repository foundation

**Goal.** A checked-in project that builds, lints, tests, and enforces its own architecture.

**Functionality.** None user-visible.

**Work.** TypeScript + ESM + strict; Vitest; ESLint flat config with `eslint-plugin-boundaries` configured for the layer rules in `07` §1.2; Prettier; the directory skeleton from `07` §3 (empty folders with index files); Dockerfile; docker-compose with Postgres; `.env.example`; Zod env schema with fail-fast boot; pino; GitHub Actions running typecheck → lint → test.

**Dependencies.** None.

**DB changes.** None.

**Tests.** A deliberately-illegal import (`domain` importing discord.js) fails lint. Env validation rejects a missing token.

**Definition of done.** `docker compose up` starts a process that logs "started", validates env, and exits cleanly on SIGTERM. CI is green. The boundary rule demonstrably fails on a violation.

---

## M1 — Platform core & plugin seam

**Goal.** A module-agnostic bot core that can host modules, with leveling registered as the first (empty) one.

**Functionality.** Bot connects to Discord, registers zero commands, responds to `/healthz`.

**Work.** `BotModule` interface + registry; intent computation from enabled modules; discord.js client factory with explicit cache sweeper configuration; command registrar with diffing (don't re-upload an unchanged set); permission guard; deferral helper; error boundary with correlation IDs; DB pool + transaction helper; migration runner that runs **before** the gateway connects and merges module-owned migrations; in-process scheduler with `job_run` single-flight; `/healthz` + `/readyz`; the composition root.

**Dependencies.** M0.

**DB changes.** `schema_migrations`, `job_run`, `guild`.

**Tests.** Migration runs up from empty and is idempotent on re-run. A failing migration aborts boot before login. Module registration composes intents correctly. `/readyz` returns 503 with the DB down.

**Definition of done.** The bot logs in, appears online, `GUILD_CREATE` upserts a `guild` row idempotently across reconnects, `/readyz` is accurate.

---

## M2 — The XP domain (pure, no I/O)

**Goal.** The entire leveling brain, tested, with no database and no Discord.

**Functionality.** None user-visible. This is the highest-value milestone in the project.

**Work.** Curve module (three formulas, multiplier, cumulative table builder, binary-search lookup, max-level handling); `RankView` construction; the gate pipeline runner and `XpDecision`/`TraceStep` types; all eligibility gates; restriction resolver (location chain, whitelist/blacklist precedence); booster resolver (bps, stacking modes); reward desired-set resolver + diff; period calendar (timezone/week-start/DST); voice eligibility predicate and anti-AFK decay; rounding and clamping. `Clock` and `Rng` as injected ports.

**Dependencies.** M0 (not even M1).

**DB changes.** None.

**Tests.** The full unit suite from `08` §4.2 — golden curve fixtures matching `04` §4.3 exactly; the property test on the level/XP invariant; the brief's worked precedence example as a named test; period boundaries across timezones, week-start days, DST and leap years; the reward diff never touching unmanaged roles.

**Definition of done.** ≥90% branch coverage on `domain/`. The suite runs in under 2 seconds with no Docker. Every number in `04` §4.3 is asserted.

---

## M3 — Persistence & guild configuration

**Goal.** Config and member XP can be read and written correctly and atomically.

**Functionality.** None user-visible yet.

**Work.** Migrations for `guild_leveling_config`, `xp_source_config`, `xp_rule`, `role_reward`, `member_xp`, `member_stats`, `member_period_xp`, `audit_log`. Repositories for each. **The atomic upsert from `06` §4**, returning before/after. The config service (read/write with validation, `config_version` bump). The `ConfigCache` port + in-memory implementation with version-based invalidation. Defaults seeding on first `GUILD_CREATE`.

**Dependencies.** M1, M2.

**DB changes.** As above — the bulk of the schema.

**Tests.** Integration (Testcontainers): concurrent increments sum correctly; before/after values are atomic; the guild-isolation test (two guilds, same user IDs); cascade deletion; every index exists; a repository-level assertion that no guild-scoped query omits `guild_id`.

**Definition of done.** A test can award XP to a member 100 times concurrently and get exactly the right total and exactly the right sequence of level transitions.

---

## M4 — Message XP end-to-end

**Goal.** **The first user-visible milestone.** Members earn XP by talking.

**Functionality.** `messageCreate` → engine → atomic write → stats + period buckets. Cooldowns. Bot/webhook/system-message rejection. Level-up detection (no message yet — just logged and metered).

**Work.** The `messageCreate` listener (thin: build an `XpCandidate`, call the use case); `AwardXpUseCase` with the transaction boundary; `CooldownStore` in-memory implementation with atomic `tryConsume`; the in-process event bus and `XpAwarded` event; idempotency LRU; debug logging of traces.

**Dependencies.** M3.

**DB changes.** None new.

**Tests.** Integration with a faked Discord port: a message awards XP once; a second message within the cooldown does not; a bot message never does; a webhook message never does; a duplicate event awards once; XP, stats and period buckets are written in one transaction.

**Definition of done.** In a real test guild, chatting increases `member_xp.total_xp` at the configured rate, and the logs show a trace for each decision.

---

## M5 — Restrictions + `/xp` admin + `/level config`

**Goal.** The bot is configurable and controllable — and testable by hand.

**Functionality.** `/level config set|view|reset|enable|disable`; `/level restrict channel|role|user|list`; `/xp add|remove|set xp|set total|set level|reset member|reset server`.

**Work.** The **setting registry** (name → Zod schema + description + parser) driving `/level config set` autocomplete; restriction rules wired into the engine's gates via the config cache; manual XP use case with `manual_xp_level_limit`, `silent`, and audit writes; reset use cases with confirmation components and `disable_resets`; owner-only enforcement.

**Dependencies.** M4.

**DB changes.** None new (tables exist from M3).

**Tests.** Every restriction type denies as specified; the whitelist+blacklist conflict resolves to deny; thread/category chain resolution; every admin command refuses without Manage Server; owner-only settings; audit rows written; manual limit enforced; reset preserves stats by default.

**Definition of done.** An admin can fully configure XP behavior from Discord, verify it took effect, and grant/remove XP — with every action audited.

---

## M6 — Level-up messages & `/rank` & `/leaderboard`

**Goal.** Progression is visible. The bot is now genuinely usable.

**Functionality.** Level-up messages (source channel / fixed channel / disabled, template placeholders, embed or plain, multi-level jump announced once, `allowed_mentions` safety). `/rank` as an embed. `/leaderboard` for lifetime XP with keyset pagination and working buttons.

**Work.** Template renderer with placeholder substitution and mention sanitization; the level-up notifier as an isolated bus handler; `LevelingQueryService` (rank view, leaderboard pages); the paginator component with invoker binding and expiry; `/level config preview-levelup`.

**Dependencies.** M5.

**DB changes.** None.

**Tests.** Placeholder rendering including markdown-special and non-Latin names; `@everyone` in a template does not ping; a send failure does not affect the XP write; multi-level jump produces one message; rank tie-break stability; keyset pagination correctness under concurrent writes; empty leaderboard; button hijack refused.

**Definition of done.** **This is a shippable bot.** A guild can install it, chat, level up, see announcements, and check `/rank` and `/leaderboard`.

---

## M7 — Role rewards

**Goal.** Levels have consequences.

**Functionality.** `/level rewards add|remove|list`; stacking modes; reconciliation on level change, manual XP change, and rejoin; failure classification.

**Work.** `ReconcileRewardsUseCase` using M2's pure resolver; `DiscordRoleGateway` with rate-limit-aware batching; configuration-time validation (managed roles, `@everyone`, hierarchy); `broken_reason` recording with 24-hour notification throttling; `GUILD_ROLE_DELETE` handling; `GUILD_MEMBER_ADD` reconciliation; `/rank rewards`. Requires enabling the `GuildMembers` intent.

**Dependencies.** M6.

**DB changes.** `role_reward.broken_reason`, `broken_notified_at` (or included in M3's migration).

**Tests.** Both stacking modes; level-down removal; the diff never removes unmanaged roles; every failure classification with a faked Discord returning 403/404/429; reconciliation idempotency; rejoin restores roles.

**Definition of done.** Reaching a configured level grants the role; dropping below removes it (when configured); every failure mode produces an actionable message rather than a stack trace.

---

## M8 — Debugging & observability

**Goal.** The differentiator. Any admin question about XP is answerable from Discord.

**Functionality.** `/level debug why|rewards|health|member`; metrics endpoint; correlation-ID error surfacing.

**Work.** Dry-run pipeline execution in **collect-all mode** (continue past the first deny); trace rendering; the reward diff view with blockers and a retry button; the health report (intents required vs granted, per-guild permission problems, dangling config targets, broken rewards, DB latency, job last-success times, version); `prom-client` wiring behind the `MetricsSink` port.

**Dependencies.** M7.

**DB changes.** None.

**Tests.** Dry run awards nothing and consumes no cooldown; collect-all reports every failing gate; health detects a deleted level-up channel, a hierarchy problem, and a stopped job.

**Definition of done.** For every scenario in the `08` §2 matrix that an admin could plausibly hit, `/level debug` explains it correctly.

---

## M9 — Voice XP

**Goal.** The largest single feature, and the last one in v1.0.

**Functionality.** Voice sessions, tick crediting, eligibility (mute/deaf/AFK/minimum members), anti-AFK decay, restart reconciliation, voice-time stats.

**Work.** `voice_session` table with the partial unique index; `voiceStateUpdate` listener handling join/leave/move/mute/deaf **and re-evaluating every session in an affected channel**; the tick job (batched multi-row update) with single-flight; end-of-session flush; SIGTERM flush; startup reconciliation against `GUILD_CREATE` voice states; orphan sweep; `GuildVoiceStates` intent.

**Dependencies.** M8.

**DB changes.** `voice_session`; `member_stats.voice_seconds` already exists.

**Tests.** Every transition in `04` §8.3; channel move preserves accrual and anti-AFK age; a member becoming alone stops earning; **all four restart-reconciliation cases**; the unique constraint prevents double sessions; anti-AFK decay curve; partial-tick crediting.

**Definition of done.** A member can sit in voice through a bot restart and lose no more than one tick of XP, verified by an integration test that kills and restarts the session service.

---

## M10 — Production hardening (v1.0 release)

**Goal.** Something you can actually leave running. **This is the v1.0 boundary.**

**Functionality.** No new features.

**Work.** Graceful shutdown (drain in-flight, stop accepting, close pool) — **including the voice-session flush from M9**; DB-unavailable degradation without crash-looping; Discord retry/backoff policy audit; discord.js cache sweeper tuning; log redaction; retention job (audit, job_run, closed voice sessions); nightly `pg_dump` compose profile; a **restore drill** actually performed and documented; the runbook (deploy, upgrade, backup, restore, rotate token, common incidents); README with the least-privilege invite URL; version/commit reporting.

**Dependencies.** M9.

**DB changes.** None.

**Tests.** Kill the DB mid-load → no crash, `/readyz` 503, automatic recovery. SIGTERM during load → clean drain, no lost writes, open voice sessions flushed and resumable. Restore from a dump into a clean database and verify the bot starts against it.

**Definition of done.** **v1.0.** Message, voice and manual XP; levels; level-up messages; role rewards; rank and leaderboards; full configuration; debugging tools. Documented, backed up, restorable, and survivable across restarts and dependency outages.

---

## M11 — Reaction XP

**Goal.** The third XP source.

**Functionality.** `reaction_add` and `reaction_receive`, durable dedup, self-reaction rules, per-message reactor cap, reaction stats.

**Work.** `messageReactionAdd` listener; message-author resolution with an LRU and a single fallback fetch; `reaction_award` table and retention; the two independent cooldowns; `GuildMessageReactions` intent.

**Dependencies.** M10.

**DB changes.** `reaction_award`.

**Tests.** Add/remove/re-add earns once, ever; self-reaction denied; per-message cap; uncached-message fetch and its failure path; both sources' cooldowns are independent.

**Definition of done.** Reaction XP works and cannot be farmed by any add/remove sequence.

---

## M12 — Boosters

**Goal.** Multipliers, with unambiguous precedence.

**Functionality.** `/level boost role|channel|server|temporary|stacking|list`; `/rank boosters`; effort booster (if the Message Content intent is enabled).

**Work.** Wire the M2 booster resolver's multiplier stage into the live pipeline (the hook exists from M4, returning 1.0×); temporary booster expiry at read time + nightly purge; the effort booster behind an intent capability check; contradiction warnings in config writes.

**Dependencies.** M10.

**DB changes.** None (`xp_rule` already supports `boost`).

**Tests.** Stack vs highest; expiry; negative bonuses; the multiplier ceiling; restrictions still beating boosters; `/rank boosters` arithmetic matches what the engine actually applies.

**Definition of done.** An admin can construct any combination of boosters and restrictions, and `/rank boosters` plus `/level debug why` agree with the XP actually awarded.

---

## M13 — Periodic leaderboards & Highlights

**Goal.** Weekly/monthly competition.

**Functionality.** `/leaderboard metric:weekly|monthly|voice|reactions|messages`; guild timezone and week-start settings; auto-posted weekly/monthly Highlights; first-place role.

**Work.** Period leaderboard queries and indexes (writes have existed since M3); timezone/week-start config; the Highlights job with `job_run` idempotency and a grace window; the first-place role job; the period retention job.

**Dependencies.** M11 (for the reaction metric to be meaningful); voice metrics are already available from M9. M10 otherwise.

**DB changes.** The period leaderboard index; nothing structural.

**Tests.** A period "resets" purely by advancing the clock, with no job running; lifetime XP unaffected; Highlights post exactly once per period across a restart; the grace window skips a stale post; DST boundaries.

**Definition of done.** Advancing a fake clock past midnight Monday in the guild's timezone produces a fresh weekly board with lifetime XP untouched, with no scheduled task involved.

---

## M14 — Rank cards

**Goal.** The visual payoff.

**Functionality.** `/rank` renders an image; `/rank card` personalization; guild card defaults.

**Work.** `CardRenderer` port + `@napi-rs/canvas` implementation; font bundling and registration (including CJK/Arabic/emoji fallbacks); avatar and background fetching with LRU caches, timeouts and size caps; **SSRF-safe** background validation; the 3-second budget with embed fallback; `member_card_config` / `guild_card_config`.

**Dependencies.** M10.

**DB changes.** The two card config tables.

**Tests.** Snapshot tests across long names, CJK, Arabic, emoji, default avatars, missing backgrounds, rank 1 and rank 9999, max level; render failure falls back to the embed; SSRF payloads rejected; render stays within the p95 budget.

**Definition of done.** `/rank` returns a correct, attractive image for every fixture, and never fails the command when rendering fails.

---

## M15 — Admin depth

**Goal.** Operational completeness.

**Functionality.** `/level rewards backfill`; `/level rewards add-recurring`; `/xp import`; `auto_reset_on_leave`; `/xp forget` (member self-service deletion); audit querying.

**Work.** The throttled backfill job with progress editing, cancellation, advisory locking and a dry-run default; recurring reward rules in the resolver and the config surface; CSV import with streaming, validation, dry run and batched transactions; member-leave auto-reset; the data-deletion path.

**Dependencies.** M13, M14.

**DB changes.** None.

**Tests.** Backfill is idempotent, respects the rate limit, is cancellable, and refuses a concurrent run; import validates and rolls back per batch on failure; auto-reset audits without retaining the data.

**Definition of done.** A server migrating from Arcane or MEE6 can import its XP, backfill its reward roles, and be fully caught up.

---

## Post-roadmap (Future)

Web dashboard (OAuth2 + the existing config/query use cases behind HTTP), public leaderboard with vanity URLs, custom curve expressions, seasons/archiving, level-up graphics, DM notifications, additional non-leveling modules.

---

## Dependency graph

```
                                              ┌──── v1.0 ────┐
M0 ─► M1 ─┬─► M3 ─► M4 ─► M5 ─► M6 ─► M7 ─► M8 ─► M9 ─► M10 ─┬─► M11 (reactions) ─┬─► M13 ─► M15
          │                                 debug  voice  hard ├─► M12 (boosters)  │
     M2 ──┘  pure domain; needs only M0                        └─► M14 (cards) ────┘
```

M2 can be built in parallel with M1 by a second developer or agent. M11, M12 and M14 are mutually independent after M10 and can be reordered or parallelized freely — M13 is the only post-v1.0 milestone with a real upstream dependency (M11, for the reaction metric).

**v1.0 boundary = end of M10**, and it now includes voice XP (decision A10). That is a complete, shippable, self-hostable leveling bot with message, voice and manual XP, rewards, leaderboards, configuration and debugging.

**What v1.0 does not include:** reaction XP, boosters, weekly/monthly leaderboards and Highlights, rank card images, reward backfill, and XP import. Those are M11–M15.
