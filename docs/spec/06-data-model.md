# 06 — Conceptual Data Model

Conceptual only — no DDL. Types are described logically. Target engine: PostgreSQL (see `07`).

---

## 1. Global rules

1. **Guild isolation is structural, not conventional.** Every guild-scoped table has `guild_id` as the **first column of its primary key**. There is no table where a row can exist without belonging to exactly one guild (except `guild` itself and operator-level tables).
2. **No query may omit `guild_id`.** Repository methods take `guildId` as a mandatory first parameter; a repository-level lint/test asserts no leveling query lacks a `guild_id` predicate.
3. **Cascade from `guild` downward.** `ON DELETE CASCADE` everywhere, so purging a guild is one `DELETE FROM guild`.
4. **Snowflakes are stored as `BIGINT`**, not text. They are 64-bit integers, they sort correctly, and the index is half the size. (Application-side they are strings; the mapping is one place in the repository layer.) *Alternative: `TEXT` — simpler in JS, avoids BigInt handling. Either is defensible; `BIGINT` chosen for index size and correct ordering. Flagged in `11`.*
5. **XP amounts are `BIGINT`.** `INT` overflows at ~2.1 billion; a long-lived guild with a high multiplier can plausibly approach that.
6. **All timestamps are `timestamptz`,** written from the database clock (`now()`) unless the value is genuinely an application-side observation.
7. **No message content is ever stored.** Not in logs, not in audit rows, not in traces (§8).
8. **Money-style integer math:** multipliers as basis points (`INT`), never floats.

---

## 2. Entities

### 2.1 `guild`

**Purpose:** the root of every guild-scoped tree; presence/lifecycle tracking.

| Field | Notes |
|---|---|
| `guild_id` **PK** | |
| `name_snapshot` | for `{server.name}` and admin UIs; refreshed on `GUILD_UPDATE` |
| `joined_at`, `left_at` | `left_at` set on `GUILD_DELETE` (removal, not unavailability) |
| `is_active` | false while removed; data retained until the retention job |
| `created_at`, `updated_at` | |

**Indexes:** PK. `(is_active)` for job scans.

---

### 2.2 `guild_leveling_config`

**Purpose:** every scalar setting for the leveling module in one guild.

One row per guild, `guild_id` PK, 1:1 with `guild`.

| Group | Fields |
|---|---|
| Module | `enabled` |
| Curve | `curve_type`, `curve_multiplier_bps`, `max_level`, `hard_cap_xp` |
| Notifications | `levelup_mode`, `levelup_channel_id`, `levelup_template`, `levelup_use_embed`, `levelup_embed_color`, `levelup_delete_after_seconds`, `levelup_only_on_reward_levels` |
| Rewards | `reward_stacking`, `remove_on_level_down`, `reconcile_on_rank_command`, `first_place_role_id`, `first_place_refresh_minutes`, `max_roles_per_level` |
| Boosters | `booster_stacking`, `effort_enabled`, `effort_chars_per_xp`, `effort_length_cap`, `effort_attachment_xp` |
| Contexts | `xp_in_threads`, `xp_in_forum_posts`, `xp_in_voice_text`, `min_message_length` |
| Voice | `voice_min_members`, `voice_require_unmuted`, `voice_require_undeafened`, `voice_count_server_mute_as_inactive`, `voice_ignore_afk_channel`, `voice_ignore_bots_in_member_count`, `voice_tick_seconds`, `anti_afk_*` (4 fields), `voice_stat_counts_ineligible_time` |
| Periods | `timezone`, `week_start_day`, `period_retention_weeks`, `highlights_weekly_channel_id`, `highlights_monthly_channel_id`, `highlight_grace_hours` |
| Leaderboard | `leaderboard_page_size`, `hide_departed_members`, `auto_reset_on_leave` |
| Admin | `manual_xp_level_limit`, `manual_grant_max`, `xp_command_owner_only`, `disable_resets`, `admin_role_ids` (array), `min_account_age_days`, `min_member_age_hours` |
| Cards | `allow_member_backgrounds`, `default_card_background_url`, `default_card_accent` |
| Meta | `config_version` (bumped on every write — used for cache invalidation), `updated_at`, `updated_by` |

**Why one wide table rather than a key/value `setting` table:** a wide row is one indexed read into a typed object; a KV table requires an aggregate on every hot-path read and pushes all typing into the application. The cost is a migration per new setting, which is a feature (settings are reviewed) not a bug. `config_version` makes cache invalidation trivial.

**Frequently queried:** the whole row, by `guild_id`, on every XP event — hence it is the primary cache target (`07` §Caching).

---

### 2.3 `xp_source_config`

**Purpose:** per-source tuning, one row per (guild, source).

| Field | Notes |
|---|---|
| `guild_id`, `source` **PK** | source ∈ `message`, `voice`, `reaction_add`, `reaction_receive` |
| `enabled`, `min_xp`, `max_xp`, `cooldown_seconds`, `per_event_cap` | |
| `message_mode` | `random` \| `per_word`; null for non-message sources |
| `reaction_max_per_message`, `reaction_allow_self`, `reaction_max_message_age_days` | reaction sources only |

Separate from `guild_leveling_config` because sources are a **set** that will grow (a future `thread_create` or `event_attendance` source adds a row, not a migration of 4 columns).

Loaded and cached together with the config row (one join or one extra indexed read).

---

### 2.4 `xp_rule`

**Purpose:** unified restrictions and boosters (see `04` §3.1).

| Field | Notes |
|---|---|
| `id` **PK** (bigserial) | |
| `guild_id` | FK cascade |
| `kind` | `restrict_deny` \| `restrict_only` \| `boost` |
| `target_type` | `channel` \| `category` \| `role` \| `user` \| `source` \| `guild` |
| `target_id` | snowflake, or null for `guild` scope, or a source name |
| `bonus_bps` | `boost` only |
| `source_scope` | optional: rule applies to one source only |
| `expires_at` | temporary boosters; null = permanent |
| `note`, `created_by`, `created_at` | |

**Unique:** `(guild_id, kind, target_type, target_id, source_scope)` — one rule per target per kind. Adding a duplicate updates instead.
**Indexes:** `(guild_id, kind)`; `(guild_id, target_type, target_id)`; partial `(expires_at) WHERE expires_at IS NOT NULL` for the purge job.
**Frequently queried:** *all rules for a guild*, on every XP event — so the access pattern is "load the guild's whole rule set into memory", not "query per event". A guild will have tens of rules, not thousands. Cached with `config_version`.

**Why unified:** restrictions and boosters share targeting semantics entirely. One table means one resolution function, one cache, one config-warning check for contradictions ("this role is both no-XP and a booster").

---

### 2.5 `role_reward`

| Field | Notes |
|---|---|
| `id` **PK** | |
| `guild_id` | |
| `rule_type` | `exact` \| `recurring` |
| `level` | for `exact` |
| `every_n`, `start_level` | for `recurring` |
| `role_id` | |
| `broken_reason` | null \| `role_deleted` \| `hierarchy` \| `missing_permission` |
| `broken_notified_at` | throttles admin notifications to 1/24h |
| `created_by`, `created_at` | |

**Unique:** `(guild_id, rule_type, level, every_n, start_level, role_id)` (nulls distinct handling via a generated key column or partial unique indexes).
**Indexes:** `(guild_id, level)`; partial `(guild_id) WHERE broken_reason IS NOT NULL` for health checks.
**Frequently queried:** all rewards for a guild, on every level change → cached with `config_version`.

---

### 2.6 `member_xp` — the central table

**Purpose:** canonical XP state per member per guild.

| Field | Notes |
|---|---|
| `guild_id`, `user_id` **PK (composite)** | |
| `total_xp` **BIGINT** | canonical; never negative |
| `level` **INT** | **denormalized cache**, written in the same statement as `total_xp`, never independently mutable |
| `display_name` | snapshot for departed-member rendering |
| `avatar_hash` | snapshot for card rendering |
| `is_departed` | maintained by member add/remove events |
| `last_xp_at` | last award; supports inactivity queries and debugging |
| `first_seen_at`, `updated_at` | |

**Indexes (all guild-first):**
- PK `(guild_id, user_id)` — point reads and the atomic upsert
- `(guild_id, total_xp DESC, user_id ASC)` — rank count and lifetime leaderboard keyset
- `(guild_id, level DESC, total_xp DESC)` — level leaderboard
- Partial `(guild_id) WHERE total_xp > 0` is unnecessary; the composite index handles it with a range predicate

**Why `level` is stored despite being derived:** sorting and filtering by level in SQL, and level-change detection via `RETURNING`. It is recomputed from `total_xp` on every write using a value the application supplies (the DB does not know the curve). **Invariant to test:** a background consistency check asserts `level == levelFromTotalXp(total_xp, config)` for a sample of rows; a curve change intentionally invalidates it until rewritten, which is why the check is advisory, not enforced by a constraint. *Alternative considered: a generated column — impossible, since the curve is guild config, not a pure SQL function.*

---

### 2.7 `member_stats`

**Purpose:** activity counters, separate from currency.

| Field |
|---|
| `guild_id`, `user_id` **PK** |
| `messages_counted` (XP-earning messages) |
| `voice_seconds` |
| `reactions_given`, `reactions_received` |
| `levelups_count` |
| `updated_at` |

**Separate from `member_xp`** because: (a) XP resets should not clear stats by default (US-30 AC2); (b) the hot path writes both but a stat-only write (e.g. voice seconds when ineligible-but-counted) shouldn't touch the XP row's indexes; (c) these are the sort columns for three leaderboards and deserve their own indexes without bloating `member_xp`.

**Indexes:** `(guild_id, voice_seconds DESC, user_id)`, `(guild_id, reactions_received DESC, user_id)`, `(guild_id, messages_counted DESC, user_id)`.

---

### 2.8 `member_period_xp`

**Purpose:** weekly/monthly buckets (see `05` §2.3).

| Field |
|---|
| `guild_id`, `user_id`, `period_type`, `period_start` **PK (composite)** |
| `xp` BIGINT |
| `updated_at` |

**Indexes:** PK; `(guild_id, period_type, period_start, xp DESC, user_id ASC)` — the period leaderboard keyset index. Note this index is the reason the PK column order is `guild, user, type, start` while the query index is `guild, type, start, xp` — two different access patterns, two indexes, both necessary.

**Frequently queried:** upserted twice per XP award; read for leaderboards and highlights.
**Retention:** rows older than `period_retention_weeks` pruned nightly.

---

### 2.9 `voice_session`

**Purpose:** stateful voice tracking (see `04` §8.2).

| Field |
|---|
| `id` **PK** |
| `guild_id`, `user_id`, `channel_id` |
| `started_at`, `last_credited_at`, `last_heartbeat_at`, `ended_at` |
| `accrued_eligible_seconds`, `credited_xp` |
| `is_eligible`, `ineligible_since` |
| `tick_count` (for the idempotency key) |
| `end_reason` (`left` \| `orphaned` \| `shutdown` \| `guild_removed`) |

**Constraints:** partial unique index `(guild_id, user_id) WHERE ended_at IS NULL` — enforces at most one open session per member, at the database level. This is the single most valuable constraint in the schema; without it a race in the event handler silently double-credits.

**Indexes:** the partial unique above; `(ended_at, last_heartbeat_at) WHERE ended_at IS NULL` for the tick job and orphan sweep; `(guild_id, started_at)` for history.

**Retention:** closed sessions are useful for debugging voice complaints but grow unboundedly. Prune closed sessions older than 30 days; the aggregate lives in `member_stats.voice_seconds`.

---

### 2.10 `reaction_award`

**Purpose:** durable dedup for reaction XP (see `04` §6).

| Field |
|---|
| `guild_id`, `message_id`, `reactor_id`, `emoji_key`, `award_kind` **PK (composite)** |
| `awarded_at` |

`award_kind` ∈ `add` \| `receive` so a single reaction can independently satisfy both sources.
`emoji_key` is the unicode codepoint or `name:id` for custom emoji.

**This is the one high-volume table.** Estimate: a busy guild might see 50k reactions/month. Retention: prune rows older than `reaction_dedup_retention_days` (default 90). After pruning, a very old reaction could theoretically be re-farmed — acceptable, and 90 days makes it not worth anyone's time. Flagged in `11`.

**Indexes:** PK covers lookup; `(awarded_at)` for pruning.

---

### 2.11 `member_card_config` / `guild_card_config`

| `member_card_config` | `guild_card_config` |
|---|---|
| `guild_id`, `user_id` **PK** | `guild_id` **PK** |
| `background_url`, `accent_hex`, `text_hex`, `layout` | `default_background_url`, `default_accent_hex`, `allow_member_backgrounds`, `layout` |
| `updated_at` | `updated_at` |

Per-guild member cards match Arcane's documented "customized for each server" behavior.

---

### 2.12 `audit_log`

**Purpose:** who did what. Not full config versioning (see `00` §6 challenge).

| Field |
|---|
| `id` **PK** |
| `guild_id` |
| `actor_id` (or null for `system`) |
| `action` (`xp.add`, `xp.remove`, `xp.set`, `xp.reset_member`, `xp.reset_server`, `config.set`, `reward.add`, `reward.remove`, `rule.add`, `rule.remove`, `import`, `backfill`, `member.forget`) |
| `target_user_id` (nullable) |
| `before` / `after` (JSONB, small — a setting's value or an XP delta, **never message content**) |
| `reason` (admin-supplied, ≤200 chars) |
| `created_at` |

**Indexes:** `(guild_id, created_at DESC)`; `(guild_id, target_user_id, created_at DESC)`.
**Retention:** `audit_retention_days` default 365.

---

### 2.13 `job_run`

**Purpose:** idempotency and observability for background jobs.

| Field |
|---|
| `job_name`, `scope_key` **PK** (e.g. `highlights_weekly`, `guild:123:2026-W36`) |
| `status` (`running` \| `succeeded` \| `failed`) |
| `started_at`, `finished_at`, `error` |

Insert-before-act gives free idempotency for highlights posting (`05` §2.7) and single-flight for backfills.

---

### 2.14 `schema_migrations`

Owned by the migration tool. Listed for completeness.

---

## 3. Relationship diagram (text)

```
guild (1)
 ├─1:1─ guild_leveling_config
 ├─1:1─ guild_card_config
 ├─1:N─ xp_source_config          (guild_id, source)
 ├─1:N─ xp_rule                   restrictions + boosters
 ├─1:N─ role_reward
 ├─1:N─ member_xp                 (guild_id, user_id)   ◄── the hot table
 │        ├─1:1─ member_stats           (same PK)
 │        ├─1:1─ member_card_config     (same PK)
 │        └─1:N─ member_period_xp       (+ period_type, period_start)
 ├─1:N─ voice_session
 ├─1:N─ reaction_award
 ├─1:N─ audit_log
 └─1:N─ job_run (scoped)
```

There is **no `member` entity** distinct from `member_xp`. A Discord user is not our entity; we store per-guild leveling facts about them. `member_stats` and `member_card_config` share `member_xp`'s key but do not have an FK to it (a member can have card settings before earning XP) — or they do, with `member_xp` created on first touch. **Decision: no FK between them; each is independently upsertable keyed by `(guild_id, user_id)`.** Simpler, avoids ordering constraints in the hot path.

---

## 4. The hot-path write

The single most important statement in the system:

```sql
-- Layer 3, in one transaction with the period upserts and stat upsert
INSERT INTO member_xp (guild_id, user_id, total_xp, level, display_name, avatar_hash, last_xp_at)
VALUES ($guild, $user, $delta, $levelIfNew, $name, $avatar, now())
ON CONFLICT (guild_id, user_id) DO UPDATE
  SET total_xp   = member_xp.total_xp + EXCLUDED.total_xp,
      display_name = EXCLUDED.display_name,
      avatar_hash  = EXCLUDED.avatar_hash,
      last_xp_at   = now(),
      updated_at   = now()
RETURNING (SELECT total_xp FROM member_xp WHERE ...) AS before_xp, total_xp AS after_xp;
```

Postgres exposes the pre-update row inside `DO UPDATE` as the table alias (`member_xp.total_xp`) and the post-update value in `RETURNING`, so **before and after come from one round trip**, atomically. The application then computes `levelFromTotalXp` for both and issues the `level` write in the same transaction (or as a computed column in the same statement via a CTE). This is the mechanism behind FR-3.2 and NFR-19: level-up detection can never race, because before/after are a single atomic observation.

**Explicitly forbidden:** `SELECT total_xp` → compute → `UPDATE SET total_xp = $newValue`. That is the classic lost-update bug and it must not appear anywhere in the codebase.

---

## 5. Data we deliberately do NOT store

| Not stored | Why |
|---|---|
| **Message content** | Privacy, volume, and no leveling need. Even per-word mode only needs a word count, computed and discarded in memory. |
| **A per-message XP ledger** | One row per XP-earning message would be the largest table by far and only enables XP clawback on delete — a feature we've declined (`03` §3.3). |
| **Message IDs for message XP dedup** | The in-memory LRU is sufficient (`04` §6); a durable table is all cost, no benefit. |
| **Rank position** | Derived; storing it means a guild-wide rewrite per award. |
| **XP progress within level** | Derived from `total_xp`. |
| **Discord role membership** | Discord is the source of truth; we query the member's roles at evaluation time from the gateway cache. |
| **Presence / online status** | Not needed; would require a privileged intent. |
| **Emails, IPs, real names, any PII beyond Discord IDs and public display names** | NFR-26. |
| **Cooldown state** | In-memory only (`04` §5.2). |
| **Rendered rank card images** | Cache inputs, not outputs (`05` §3.3). |
| **Full configuration snapshots/history** | `audit_log` records the delta; snapshot versioning is a Future feature. |

## 6. Retention summary

| Data | Default retention |
|---|---|
| `member_xp`, `member_stats` | forever (or until reset / auto-reset-on-leave) |
| `member_period_xp` | 104 weeks |
| `voice_session` (closed) | 30 days |
| `reaction_award` | 90 days |
| `audit_log` | 365 days |
| `job_run` | 90 days |
| A guild's entire tree after `GUILD_DELETE` | 30 days, then cascade delete |

All configurable; all enforced by one nightly retention job that logs what it pruned.

## 7. Guild isolation verification

Concrete checks a coding agent must implement:

1. Every migration adding a guild-scoped table must include `guild_id` in the PK or a unique constraint, and an FK to `guild` with cascade. Enforced by a schema test that reflects the catalog.
2. A repository-layer test asserts that every generated SQL statement touching a guild-scoped table contains a `guild_id` predicate.
3. Integration test: create two guilds with identical user IDs, exercise every command and every event path, assert zero cross-contamination.
4. Row-Level Security is **not** used in MVP (single trusted application, adds real complexity), but the schema is RLS-ready because `guild_id` is universally present. Documented migration point.
