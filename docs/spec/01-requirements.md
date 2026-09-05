# 01 — Requirements Inventory

Requirement IDs are stable and referenced by user stories (`02`), the edge-case matrix (`08`), and the roadmap (`10`).

Priority tags: **[M]** MVP · **[P]** Post-MVP · **[F]** Future.

---

## 1. Functional Requirements — what the bot must do

### FR-1 XP acquisition

| ID | Requirement | Pri |
|---|---|---|
| FR-1.1 | Award XP when an eligible member sends an eligible message in an eligible channel, subject to a per-source cooldown. | M |
| FR-1.2 | Random mode: award a uniformly random integer in `[min_xp, max_xp]`. | M |
| FR-1.3 | Per-word mode: award `max_xp` scaled by the count of words with ≥3 characters, valid only when the message has more words than whitespace runs; requires the Message Content intent. | P |
| FR-1.4 | Award XP for time spent in voice, only while the member is *active* (see FR-1.5), in ticks, subject to a cooldown/tick interval. | M |
| FR-1.5 | A member is voice-active only if: not self-deafened, not server-deafened, not self-muted, not server-muted, not in the AFK channel, and the channel contains at least `voice_min_members` other active non-bot humans. Each condition is individually configurable. | M |
| FR-1.6 | Anti-AFK: after `anti_afk_after_minutes` of continuous session time, progressively reduce awarded voice XP per tick down to a floor. | M |
| FR-1.7 | Award XP when a member adds a reaction, and/or when a member's message receives a reaction — independently configurable (`add` / `receive` / `both` / `off`). | P |
| FR-1.8 | Reaction XP must be deduplicated so that add/remove/re-add of the same emoji by the same user on the same message cannot be farmed. | P |
| FR-1.9 | Never award XP to bots, webhooks, system messages, or the bot itself. Not configurable. | M |
| FR-1.10 | Support multiple simultaneous XP sources with independent enable flags, min/max, and cooldowns. | M |
| FR-1.11 | Manually grant, deduct, or set XP/level for a member. | M |
| FR-1.12 | Manual XP must respect a configurable `manual_xp_level_limit` (Arcane parity: default level 100 ceiling) unless overridden by the guild owner. | M |

### FR-2 XP calculation

| ID | Requirement | Pri |
|---|---|---|
| FR-2.1 | Evaluate eligibility before computing any XP amount; ineligible events produce zero XP and a reasoned decision trace. | M |
| FR-2.2 | Compute a base amount from the source configuration. | M |
| FR-2.3 | Apply the combined multiplier from all applicable boosters using the configured stacking mode. | P |
| FR-2.4 | Clamp the final amount to `[0, per_event_xp_cap]` and round to an integer. | M |
| FR-2.5 | Produce a structured, serializable decision trace for every evaluation, awarded or not. | M |
| FR-2.6 | Level is a pure function of total XP and the guild's curve configuration. | M |
| FR-2.7 | Support three built-in curves (linear, exponential, flat), a global curve multiplier, and an optional max level. | M |
| FR-2.8 | Total XP may exceed the max level's threshold; level is capped, XP is not. | M |

### FR-3 XP persistence & side effects

| ID | Requirement | Pri |
|---|---|---|
| FR-3.1 | Persist XP increments atomically; concurrent increments for one member must never lose an update. | M |
| FR-3.2 | Detect a level change by comparing the level derived from the pre-write total against the post-write total, using values returned by the same atomic write. | M |
| FR-3.3 | On level increase, evaluate role rewards and emit a level-up notification (unless suppressed). | M |
| FR-3.4 | On level decrease, evaluate role rewards for removal (configurable) and emit no notification. | M |
| FR-3.5 | Update per-member lifetime statistics (messages counted, voice seconds, reactions given/received) alongside XP. | M (schema) / P (surfaced) |
| FR-3.6 | Update the current weekly and monthly XP buckets in the same transaction as the XP write. | M (write path) / P (queries) |
| FR-3.7 | Record an audit entry for every manual XP mutation and every configuration change. | M |

### FR-4 Role rewards

| ID | Requirement | Pri |
|---|---|---|
| FR-4.1 | Configure rewards as (level → one or more roles). | M |
| FR-4.2 | Configure rewards as (every N levels starting at level S → role). | P |
| FR-4.3 | Stacking mode `stack`: assign every reward role for level ≤ current level. Mode `highest`: assign only the highest-level reward's roles and remove lower ones. | M |
| FR-4.4 | Compute a *desired role set* and reconcile against the member's actual roles with a single grant/revoke diff. | M |
| FR-4.5 | Optionally remove reward roles when a member's level drops below the reward threshold (`remove_on_level_down`, default on). | M |
| FR-4.6 | Reconcile rewards on: level change, member rejoin, explicit `/rank` invocation (opt-in), manual XP change, and an admin-triggered backfill job. | M (first four) / P (backfill) |
| FR-4.7 | Detect and report roles that cannot be assigned (deleted, above the bot in hierarchy, managed/integration roles, missing Manage Roles). Never retry in a tight loop. | M |
| FR-4.8 | Assign a configurable "first place" role to the current #1 member, refreshed on a schedule. | P |
| FR-4.9 | Never remove a role from a member if that role is not currently configured as a reward (do not touch roles we don't own). | M |

### FR-5 Notifications

| ID | Requirement | Pri |
|---|---|---|
| FR-5.1 | Level-up message destinations: source channel, fixed channel, or disabled. | M |
| FR-5.2 | Template placeholders: `{user.mention}`, `{user.name}`, `{user.id}`, `{user.level}`, `{user.xp}` (progress within level), `{user.totalXp}`, `{user.rank}`, `{server.name}`, `{earned}`. | M |
| FR-5.3 | Plain text or embed rendering. | M |
| FR-5.4 | On a multi-level jump, announce once at the final level. | M |
| FR-5.5 | Level-up messages must be suppressible per manual-XP action (`silent: true`). | M |
| FR-5.6 | Attach the `{image}` level-up graphic when configured. | F |
| FR-5.7 | Weekly/monthly Highlights auto-post of the period top 10 to a configured channel. | P |

### FR-6 Member-facing reads

| ID | Requirement | Pri |
|---|---|---|
| FR-6.1 | `/rank` shows level, XP within level, XP to next level, total XP, and rank position. | M |
| FR-6.2 | `/rank` may target another member. | M |
| FR-6.3 | Rank position is computed live from the database, not stored. | M |
| FR-6.4 | `/leaderboard` supports metric selection (xp, level, weekly, monthly, voice, reactions, messages) and pagination. | M (xp) / P (rest) |
| FR-6.5 | `/rewards` lists configured role rewards and which the caller has. | M |
| FR-6.6 | `/boosters` lists active role/channel/temporary boosters. | P |
| FR-6.7 | Rank cards render as an image with avatar, names, level, rank, progress bar, and per-guild customization. | P |
| FR-6.8 | Rank card personalization (`/card`) per member per guild. | P |

### FR-7 Administration & debugging

| ID | Requirement | Pri |
|---|---|---|
| FR-7.1 | `/xp add \| remove \| set xp \| set level \| reset member \| reset server`. | M |
| FR-7.2 | Reset operations must default to preserving activity statistics, with an explicit opt-in to clear them, and require a confirmation step for server-wide resets. | M |
| FR-7.3 | `/level-config` subcommands covering every configurable setting in §2. | M |
| FR-7.4 | `/level-debug why` replays the XP pipeline for a member in a channel and shows every gate's verdict and reason. | M |
| FR-7.5 | `/level-debug rewards` shows desired vs actual reward roles and any blocking condition. | P |
| FR-7.6 | `/level-debug health` reports intents, permissions, config sanity warnings, DB connectivity, and job status. | P |
| FR-7.7 | Optional auto-reset of a member's data when they leave the guild. | P |
| FR-7.8 | Import XP from a CSV export of another leveling bot. | P |
| FR-7.9 | A member may request deletion of their own leveling data in a guild. | P |

---

## 2. Configuration Requirements — what a guild admin can set

All settings are per-guild. Defaults follow Arcane where documented; otherwise chosen and flagged.

### 2.1 Curve

| Setting | Type | Default | Notes |
|---|---|---|---|
| `curve_type` | `linear \| exponential \| flat` | `linear` | Arcane parity |
| `curve_multiplier` | decimal ≥ 0.01 | `1.0` | Applied as `formula × multiplier` |
| `max_level` | int, nullable | `null` (uncapped) | Arcane parity |

### 2.2 Sources (one row per source: `message`, `voice`, `reaction_add`, `reaction_receive`)

| Setting | Type | Default | Notes |
|---|---|---|---|
| `enabled` | bool | message=`true`, others=`false` | |
| `min_xp` / `max_xp` | int | message `15`/`25`; reaction `20`/`25`; voice `10`/`15` | **Our decision** — Arcane's numeric defaults aren't published (reaction 25/5min is documented) |
| `cooldown_seconds` | int | message `60`, reaction `300`, voice `180` | Arcane-documented |
| `message_mode` | `random \| per_word` | `random` | per_word needs Message Content intent |
| `per_event_cap` | int | `500` | **Our decision**; safety clamp |

### 2.3 Voice-specific

| Setting | Default |
|---|---|
| `voice_min_members` (other active humans required) | `1` |
| `voice_require_unmuted` / `require_undeafened` | `true` / `true` |
| `voice_count_server_mute_as_inactive` | `true` |
| `voice_ignore_afk_channel` | `true` |
| `voice_ignore_bots_in_member_count` | `true` |
| `voice_tick_seconds` | `180` |
| `anti_afk_enabled` | `true` |
| `anti_afk_after_minutes` | `120` |
| `anti_afk_decay_per_hour` | `0.25` (×0.75, ×0.5625, …) |
| `anti_afk_floor_multiplier` | `0.1` |

### 2.4 Restrictions

| Setting | Type |
|---|---|
| `no_xp_channels` | channel/category ID list (blacklist) |
| `xp_only_channels` | channel/category ID list (whitelist; empty = no whitelist) |
| `no_xp_roles` | role ID list |
| `ignored_users` | user ID list |
| `xp_in_threads` / `xp_in_forum_posts` / `xp_in_voice_text` | bool, default `true` |
| `min_message_length` | int, default `0` (needs Message Content intent if > 0) |

### 2.5 Boosters

| Setting | Type |
|---|---|
| role boosters | list of (role_id, bonus_bps) |
| channel boosters | list of (channel/category_id, bonus_bps) |
| `server_bonus_bps` | int, default `0` |
| per-source bonus | optional (source, bonus_bps) |
| temporary boosters | (scope, target_id, bonus_bps, expires_at) |
| `booster_stacking` | `stack \| highest`, default `stack` (Arcane parity) |
| `effort_booster` | enabled, per-char bonus, per-attachment bonus, cap |

### 2.6 Rewards

| Setting | Default |
|---|---|
| rewards list | (level, role_id[]) and (every_n, start_level, role_id) |
| `reward_stacking` | `stack \| highest`, default `stack` |
| `remove_on_level_down` | `true` |
| `reconcile_on_rank_command` | `false` (Arcane does this; it's surprising) |
| `first_place_role_id` | `null` |
| `first_place_refresh_minutes` | `60` |

### 2.7 Notifications

| Setting | Default |
|---|---|
| `levelup_mode` | `source_channel \| fixed_channel \| disabled` → `source_channel` |
| `levelup_channel_id` | `null` |
| `levelup_template` | `{user.mention} has reached level **{user.level}**. GG!` (Arcane's default) |
| `levelup_use_embed` / embed color | `false` / guild accent |
| `levelup_delete_after_seconds` | `null` |
| `levelup_only_on_reward_levels` | `false` |
| highlights weekly/monthly channel + enabled | `null` / `false` |

### 2.8 Periods & leaderboard

| Setting | Default |
|---|---|
| `timezone` (IANA) | `UTC` |
| `week_start_day` | `monday` |
| `leaderboard_page_size` | `10` |
| `hide_departed_members` | `false` |
| `auto_reset_on_leave` | `false` |

### 2.9 Administration

| Setting | Default |
|---|---|
| `manual_xp_level_limit` | `100` (Arcane parity) |
| `manual_grant_max` (per-command amount ceiling) | `1000000` |
| `min_account_age_days` / `min_member_age_hours` | `0` / `0` (alt-account levers, off) |
| `xp_command_owner_only` | `false` |
| `disable_resets` | `false` |
| `admin_role_ids` (in addition to Manage Server) | `[]` |

---

## 3. Administrative Requirements

| ID | Requirement |
|---|---|
| AR-1 | All configuration and XP mutation commands require **Manage Server** by default; the guild owner may additionally whitelist roles. |
| AR-2 | Permission checks are enforced server-side in the handler, never solely via Discord's `default_member_permissions` (which an admin can override in Integrations settings). |
| AR-3 | Destructive actions (server reset, stat wipe, mass role backfill) require a confirmation interaction with a 60-second expiry and are recorded in the audit log with actor, timestamp, and scope. |
| AR-4 | `disable_resets` and `xp_command_owner_only` may only be changed by the guild **owner**. |
| AR-5 | Admins can see *why* the bot did or did not act (FR-7.4–7.6) without reading server logs. |
| AR-6 | Admins can list, add, and remove every restriction, booster and reward entity, and receive a warning when a configuration is self-contradictory (e.g. a role is both no-XP and a booster). |
| AR-7 | Admins can trigger a reward reconciliation backfill, which runs as a rate-limited background job with progress reporting. |

## 4. Member Requirements

| ID | Requirement |
|---|---|
| MR-1 | View own rank/level/progress, and another member's. |
| MR-2 | Browse the leaderboard by metric with pagination, and jump to the page containing themselves. |
| MR-3 | See what role rewards exist and which level unlocks each. |
| MR-4 | See active boosters and their own effective multiplier. |
| MR-5 | Customize their own rank card (within guild-allowed bounds). |
| MR-6 | Not be spammed: level-up messages are the only unsolicited output, and they are guild-configurable. |
| MR-7 | Request deletion of their own leveling data. |
| MR-8 | All member command responses are ephemeral-by-default where they are noise (`/rewards`, `/boosters`) and public where they are social (`/rank`, `/leaderboard`) — with an `ephemeral` option on each. |

## 5. Background / System Requirements

| ID | Requirement | Cadence |
|---|---|---|
| BR-1 | **Voice tick job** (MVP): credit XP for open voice sessions and advance their watermark. | every `voice_tick_seconds` (default 180s) |
| BR-2 | **Voice reconciliation on startup**: close orphaned sessions, re-open sessions for members currently in voice per the gateway's initial state. | on ready |
| BR-3 | **Cooldown sweep**: evict expired in-memory cooldown entries. | every 60s |
| BR-4 | **Temporary booster expiry**: no job needed if expiry is evaluated at read time; a nightly purge removes dead rows. | nightly |
| BR-5 | **Period rollover**: none required — period buckets are keyed by computed period start, so rollover is implicit. A nightly job may pre-create nothing and instead verify no writes landed in a stale period. | nightly (verification only) |
| BR-6 | **Highlights posting**: post weekly/monthly top 10 at the guild's local midnight on the period boundary. | hourly scan |
| BR-7 | **First-place role refresh**. | `first_place_refresh_minutes` |
| BR-8 | **Reward backfill job**: throttled reconciliation across a guild's members. | on demand |
| BR-9 | **Guild-leave retention job**: soft-delete guild data after a retention window (default 30 days) when the bot is removed. | nightly |
| BR-10 | **Config cache invalidation** on write (in-process; pub/sub when multi-process). | on write |
| BR-11 | **Graceful shutdown**: flush open voice sessions' accrued-but-uncredited time, stop accepting events, drain in-flight writes. | on SIGTERM |
| BR-12 | **Migrations run before the gateway connects.** | on boot |

---

## 6. Non-Functional Requirements

### 6.1 Scalability
- **NFR-1** Single process must comfortably handle the target of ≤50 guilds; design must not preclude sharding. All state that would need sharing across processes (cooldowns, config cache, voice sessions) sits behind an interface with an in-process implementation.
- **NFR-2** No unbounded in-memory structures. Every cache has a size bound and a TTL.
- **NFR-3** Leaderboard queries must not scan a whole guild's members unbounded; pagination with keyset or `LIMIT/OFFSET` over an index.

### 6.2 Performance
- **NFR-4** Message XP path (event → decision → write) budget: **p99 < 50 ms** of bot-side work, excluding DB round-trip queueing.
- **NFR-5** Every slash command acknowledges within Discord's 3-second window; anything slower defers immediately.
- **NFR-6** Rank card render budget: **p95 < 400 ms** with a warm font/avatar cache.
- **NFR-7** Guild configuration reads are served from memory in the hot path; the message handler performs **at most one** DB round trip in the common case (the atomic XP upsert).

### 6.3 Reliability
- **NFR-8** A failure in a side effect (role assignment, notification) must never roll back or lose the XP write. XP persistence and side effects are separate stages.
- **NFR-9** The bot must recover from a crash mid-voice-session losing at most one tick interval of voice XP per member.
- **NFR-10** Discord API failures are retried with exponential backoff and jitter, honoring `Retry-After`; permanent failures (403/404) are recorded, not retried.
- **NFR-11** Database unavailability degrades to: stop awarding XP, keep the process alive, surface an error on commands, recover automatically on reconnect. No crash loop.

### 6.4 Discord rate limits
- **NFR-12** All Discord writes go through the library's rate-limit-aware client; the bot never constructs raw HTTP calls that bypass it.
- **NFR-13** Bulk role operations are queued and throttled (target ≤ 2 role writes/sec/guild) rather than issued in a loop.
- **NFR-14** Level-up messages are subject to a per-channel outbound throttle and are dropped (with a log) rather than queued unboundedly during a storm.

### 6.5 Database consistency
- **NFR-15** All XP mutation happens through atomic SQL (`INSERT … ON CONFLICT DO UPDATE … RETURNING`), never read-modify-write in application code.
- **NFR-16** Multi-table writes that must agree (XP + period buckets + stats) occur in one transaction.
- **NFR-17** Every guild-scoped table has `guild_id` in its primary key or a unique constraint including it; no query may omit `guild_id`.
- **NFR-18** Foreign keys with `ON DELETE CASCADE` from `guild` downward, so a guild wipe is one statement.

### 6.6 Concurrency
- **NFR-19** Two concurrent XP awards for the same member must produce the sum, and must produce **at most one** level-up notification per level crossed.
- **NFR-20** Idempotency: an event delivered twice by Discord must award XP at most once. Enforced by a dedup key per source.

### 6.7 Security & permissions
- **NFR-21** No secrets in the repository; configuration by environment variables, validated at boot with a schema.
- **NFR-22** Least-privilege Discord intents and permissions; document exactly which are required and why.
- **NFR-23** All user-supplied strings that are re-rendered (level-up templates, card text) are sanitized against mention injection (`@everyone`, `@here`, role mentions) using allowed-mentions rather than string filtering.
- **NFR-24** All command inputs validated with a schema before use; numeric bounds enforced server-side.
- **NFR-25** Rank card background URLs are fetched only over HTTPS from allow-listed hosts, size-capped, content-type-checked, and never followed cross-host redirect. (SSRF protection.)
- **NFR-26** No PII beyond Discord IDs and public display names; no message content persisted.

### 6.8 Observability
- **NFR-27** Structured JSON logs with correlation IDs (`guild_id`, `user_id`, `event_id`).
- **NFR-28** Counters/histograms for events processed, XP awarded, level-ups, role ops, Discord errors by code, job durations, DB latency.
- **NFR-29** `/healthz` (process) and `/readyz` (gateway connected + DB reachable) endpoints.
- **NFR-30** The XP decision trace must be reconstructible for any member without shipping a debug build.

### 6.9 Maintainability
- **NFR-31** The `domain` layer imports nothing from the Discord library or the database driver. Enforced by a lint rule (`eslint-plugin-boundaries` or equivalent), not convention.
- **NFR-32** New XP sources are added by implementing one interface and registering it, without editing the engine.
- **NFR-33** Future plugins register their own commands, listeners and migrations through a plugin interface.

### 6.10 Testing
- **NFR-34** Domain layer ≥ 90% branch coverage; overall ≥ 70%.
- **NFR-35** The full XP engine test suite runs with no network and no database.
- **NFR-36** Repository tests run against a real PostgreSQL (Testcontainers or a compose service), not a mock.

### 6.11 Deployment, migrations, backups
- **NFR-37** One `docker compose up` brings up bot + database from a clean checkout.
- **NFR-38** Migrations are versioned, forward-only files checked into the repo, applied automatically on boot, and idempotent.
- **NFR-39** Every migration that changes data has a documented rollback plan, even if the mechanism is forward-only.
- **NFR-40** A documented `pg_dump` backup procedure and a restore drill in the runbook; nightly dump in the compose profile.
- **NFR-41** Configuration and code version are reported by `/level-debug health` so an operator can confirm what is deployed.
