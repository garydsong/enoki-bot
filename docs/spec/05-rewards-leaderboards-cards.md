# 05 — Role Rewards, Leaderboards, Rank Cards

---

## 1. Role Reward System

### 1.1 Core principle: reconciliation, not incremental grants

Arcane's documented model is incremental — roles are assigned "when members level up, when they run `/level`, or rejoin", with no mass backfill. That model accumulates drift: change the stacking mode, delete a reward, lower someone's XP, or have a role assignment fail once, and the member is permanently wrong until they happen to level again.

**Our model:** compute a **desired role set** as a pure function, diff it against actual, apply the diff.

```
desiredRewardRoles(level, config) -> Set<roleId>      // pure, no I/O, trivially testable
diff = {
  toAdd:    desired \ actual,
  toRemove: (managedRewardRoles ∩ actual) \ desired   // only roles we own
}
```

`managedRewardRoles` = every role that appears in *any* reward rule for the guild. **We never remove a role that is not in that set** (FR-4.9). A member's staff role, colour role, or self-assigned role is untouchable.

Pure-function benefits: reward logic is 100% unit-testable with no Discord, and the same function powers `/level debug rewards` (desired vs actual) and the backfill job.

### 1.2 Reward rule types

| Type | Shape | Status |
|---|---|---|
| Exact level | `(level: 10, roles: [A, B])` | MVP |
| Recurring | `(every: 5, start: 5, role: C)` → levels 5, 10, 15, … | Post-MVP (our addition; Arcane has no equivalent) |

Multiple roles per level are allowed with a configurable cap (`max_roles_per_level`, default 5) — not a tier gate, purely a rate-limit and sanity guard.

### 1.3 Stacking modes

| Mode | `desiredRewardRoles(L)` |
|---|---|
| `stack` (default) | all roles from every rule whose threshold ≤ L |
| `highest` | roles from **only the highest-threshold rule** with threshold ≤ L |

`highest` with multiple rules at the same level includes all roles at that level. `highest` with a recurring rule uses the highest matching iteration.

**Interaction:** in `highest` mode a lower reward role is *removed* as part of the same diff, so there is never a moment where the member holds both — one API call each, issued together.

### 1.4 Reconciliation triggers

| Trigger | Mode | Pri |
|---|---|---|
| Level increased | reconcile | MVP |
| Level decreased (`remove_on_level_down`) | reconcile | MVP |
| Manual XP change | reconcile to final level, once | MVP |
| `GUILD_MEMBER_ADD` (rejoin) | reconcile (restore roles) | MVP |
| `/rank` invoked (`reconcile_on_rank_command`) | reconcile, default **off** | MVP |
| Reward config changed | **not automatic** — offer backfill | MVP (the offer) |
| `/level rewards backfill` | throttled bulk reconcile | Post-MVP |
| `GUILD_ROLE_DELETE` | mark rule broken, no role ops | MVP |

Default `reconcile_on_rank_command = false` because a member spamming `/rank` becomes a role-API amplifier, and because a silent role change from a read command is surprising. Arcane does it; we make it opt-in. Flagged in `11`.

### 1.5 When Discord refuses

The unhappy path is where most leveling bots are worst. Classification and response:

| Condition | Detection | Behavior |
|---|---|---|
| Role deleted | `GUILD_ROLE_DELETE`, or 404 on assignment | Mark the rule `broken_reason = 'role_deleted'`. Omit from `/rank rewards`. Show in `/level rewards list` and `/level debug health`. **Do not delete the rule** — the admin may recreate the role, and silently discarding config is hostile. |
| Role above bot's highest role | Compare positions before calling; 403 otherwise | `broken_reason = 'hierarchy'`. Report the exact fix: "move [Bot Role] above [Reward Role] in Server Settings → Roles." |
| Bot lacks Manage Roles | Permission check | `broken_reason = 'missing_permission'`. Guild-wide banner in health. |
| Managed / integration / booster role | `role.managed === true` | Refuse **at configuration time** in `/level rewards add`, so it never becomes a runtime failure. |
| `@everyone` | id === guild id | Refuse at configuration time. |
| Rate limited (429) | Response header | Honor `Retry-After`; queue and retry. Not a "broken" state. |
| Transient 5xx | Response code | Retry with backoff, max 3, then defer to the next reconciliation. |
| Member left mid-operation | 404 on member | Silently skip. |

**Cardinal rule: a role failure must never block the XP write, the level-up message, or the next event.** Reconciliation is a side effect (layer 4). It runs after the transaction commits, and it swallows its own failures into structured logs plus the `broken_reason` field.

**Failure reporting cadence:** at most one admin-facing notification per guild per role per 24 hours (a `notified_at` column on the rule), so a broken hierarchy does not produce hundreds of messages. Everything else lives in `/level debug`.

### 1.6 Backfill job (post-MVP)

- Iterates guild members in pages (requires `GuildMembers` intent + `guild.members.fetch()`).
- Computes the diff per member; **skips members already correct** (the common case, and why re-running is cheap).
- Applies changes through a token-bucket limiter: default **2 role writes/second/guild**, configurable.
- Reports progress by editing the deferred reply every ~10 s: `1,240 / 8,900 members · 61 roles added · ETA 4m`.
- Cancellable; idempotent; **one per guild at a time** (advisory lock).
- Dry-run mode reports what would change without acting — should be the default first run.

### 1.7 First-place role (post-MVP)

A periodic job (`first_place_refresh_minutes`, default 60): query the #1 member, if changed, remove the role from the previous holder and add to the new one. Two role writes per change, at most. Edge cases: ties broken by the same `(total_xp, user_id)` rule; the previous holder having left is a no-op; the role being unassignable is reported like any other reward failure.

---

## 2. Leaderboard Architecture

### 2.1 The central decision: how are values obtained?

| Approach | Verdict |
|---|---|
| Compute from raw activity on read (sum an event log) | **No.** Requires an append-only event table with one row per message — huge, and every read is an aggregation. |
| Stored counters, updated on write | **Yes for all metrics.** O(1) write, O(log n) indexed read. |
| Periodic aggregation into snapshot tables | **No for MVP.** Adds staleness and a job for a query that is already fast. Becomes attractive only at 10k+ guilds — a documented migration point. |
| Cache results | **Yes, briefly** — a 30-second TTL on rendered leaderboard pages absorbs the "everyone runs `/leaderboard` at once" pattern without meaningful staleness. |

**Decision: stored counters + a short-TTL read cache.** ADR-005.

### 2.2 Metrics and their sources

| Metric | Column | Written when |
|---|---|---|
| `xp` (lifetime) | `member_xp.total_xp` | every XP award |
| `level` | `member_xp.level` (denormalized) | every XP award; ordered by `(level, total_xp)` |
| `weekly` | `member_period_xp.xp` where `period_type='week'` and current period | every XP award |
| `monthly` | same, `period_type='month'` | every XP award |
| `voice` | `member_stats.voice_seconds` | every voice tick |
| `reactions` | `member_stats.reactions_given` / `_received` | every reaction award |
| `messages` | `member_stats.messages_counted` | every message award |

All seven are the same query shape with a different sort column — one implementation, seven indexes.

> Note: `messages_counted` counts **XP-earning** messages (post-cooldown), not all messages. Counting all messages would require a write on every message even when no XP is awarded, tripling hot-path writes. Documented in the command output so nobody misreads it.

### 2.3 Weekly / monthly periods — the reset design

**The key idea: a "reset" is not an operation. It is a change in the current period key.**

```
member_period_xp {
  guild_id, user_id,
  period_type: 'week' | 'month',
  period_start: date,        -- the UTC instant of the period's local start
  xp: bigint,
  PRIMARY KEY (guild_id, user_id, period_type, period_start)
}
```

On every XP award, the engine computes `currentPeriodStart(now, guild.timezone, guild.week_start_day)` for both types and does two `INSERT … ON CONFLICT DO UPDATE SET xp = xp + delta` in the same transaction as the main XP write.

Consequences — all of them good:

- **No reset job exists.** At 00:00 local on Monday, `currentPeriodStart` returns a new value and writes land in a new row. Nothing is deleted, nothing must run on time, and a bot that is offline at midnight suffers zero consequences.
- **Lifetime XP is structurally unaffected** — it lives in a different table (US-34 AC1).
- **History is retained for free.** "Top 10 of March" is a query, not an archive. This directly enables Highlights, seasons, and trend charts later.
- Arcane's documented quirk — "weekly and monthly leaderboards will only reset if you have the respective notification enabled" — is structurally impossible here (US-34 AC3).

**Retention:** period rows accumulate at ~52 + 12 rows per active member per year. For 50 guilds × 500 active members that is ~1.6M rows/year — fine. A retention setting (`period_retention_weeks`, default 104) prunes older rows nightly.

Recorded as ADR-006.

### 2.4 Timezone behavior

- Each guild has an IANA `timezone` (default `UTC`) and a `week_start_day` (default `monday`).
- `period_start` is computed by converting `now` into the guild's zone, truncating to the start of the week/month **in that zone**, then converting back to a UTC instant, which is what is stored.
- **DST correctness:** because the boundary is computed from a zoned datetime, a week in a DST-shifting zone is 167 or 169 hours. That is correct behavior — the boundary is local midnight, not "168 hours later".
- Ambiguous/nonexistent local midnights (DST transitions at midnight, as in some zones) are resolved by the timezone library's standard rule (first occurrence / shift forward). Must use a real tz database (`Temporal`, `luxon`, or `date-fns-tz`), never manual offset arithmetic.
- **Changing a guild's timezone does not rewrite history.** Existing period rows keep their computed boundaries; new writes use the new zone. The `/level config set timezone` response says so. Trying to re-bucket history would be a data migration with no correct answer.
- Arcane is UTC-only at 12am UTC; ours defaults to that and allows configuration.

### 2.5 Query design

Ranked page, keyset pagination:

```sql
-- lifetime XP, page after cursor (xp, user_id)
SELECT user_id, total_xp, level, display_name, is_departed
FROM member_xp
WHERE guild_id = $1
  AND total_xp > 0
  AND (total_xp, user_id) < ($cursor_xp, $cursor_user)   -- DESC xp, ASC user_id via tuple trick
ORDER BY total_xp DESC, user_id ASC
LIMIT 10;
```

- Index `(guild_id, total_xp DESC, user_id ASC)` serves both this and the rank count.
- Keyset (not `OFFSET`) so a concurrent XP write cannot cause a duplicated or skipped row across pages (US-21 AC1). The "jump to page N" and "jump to me" affordances use a bounded `OFFSET` fallback since exact page numbers require it — acceptable because those are single queries, not a scan sequence.
- `total_xp > 0` keeps never-active members off the board.

### 2.6 Members who have left

- Leaderboard rows are **not** deleted when a member leaves (unless `auto_reset_on_leave`).
- We cannot resolve a departed user's name from Discord cheaply, so `member_xp` carries a **denormalized `display_name` and `avatar_hash` snapshot**, refreshed opportunistically whenever we see the member. Without it, departed entries render as raw snowflakes.
- `hide_departed_members` (default false) filters them out of the query via an `is_departed` flag maintained by `GUILD_MEMBER_REMOVE` / `_ADD`.
- Departed members are still counted for rank position unless hidden — otherwise a member's rank would silently improve when strangers leave, which is confusing in the other direction too. Flagged in `11` as a preference.

### 2.7 Highlights (post-MVP)

An hourly job scans guilds where highlights are enabled and whose local period boundary has passed since the last post, and posts the top 10 of the **just-closed** period. Idempotency: a `highlight_post` row keyed `(guild_id, period_type, period_start)` — inserted before posting, so a restart cannot double-post. If more than `highlight_grace_hours` (default 6) have elapsed, skip with a log rather than posting a stale board (US-35 AC2).

### 2.8 Web leaderboard (future)

Arcane's vanity-URL public leaderboard is a Future item. The relevant design hook now: leaderboard queries live in a **query service** that the command layer calls, so an HTTP layer can call the identical service later. No leaderboard SQL in a command handler.

---

## 3. Rank Card Subsystem

### 3.1 Separation

**The core leveling system must not depend on the renderer.** The dependency runs one way:

```
LevelingQueryService.getRankView(guildId, userId) -> RankView   (pure data, no images)
        │
        ├──> embed formatter   (MVP)         -> Discord embed
        └──> CardRenderer      (post-MVP)    -> PNG buffer
```

`RankView` is a plain object. The embed path uses it. The renderer uses it. Neither knows about the other. If image rendering is removed, deleted, or fails, `/rank` still works (US-24 AC2).

### 3.2 `RankView` contract

```
RankView {
  guildId, userId,
  displayName,          // nickname > global name > username
  username,             // for the @handle line
  avatarUrl,            // resolved CDN URL, or the default-avatar URL
  accentColor?,         // member card setting, else guild default
  level, rank, rankTotal,
  xpIntoLevel, xpForNextLevel, progressRatio (0..1),
  totalXp,
  isDeparted, isMaxLevel,
  stats?: { messages, voiceSeconds, reactionsGiven, reactionsReceived },
  card?: { backgroundUrl?, accentHex?, textHex?, layout }
}
```

Note it carries **no Discord objects** — just strings and numbers. This makes card rendering testable with a fixture and snapshot comparison.

### 3.3 Rendering pipeline

```
RankView → layout (fixed template, 934×282 or Arcane's 800×200) → raster → PNG buffer → Discord attachment
```

Concerns and decisions:

| Concern | Decision |
|---|---|
| Library | `@napi-rs/canvas` (Skia, prebuilt binaries, no system deps). See `07` §Technology for the comparison against satori+resvg and Puppeteer. |
| Fonts | Bundle a font with broad Unicode coverage (Noto Sans + Noto Sans CJK/Arabic/Hebrew fallbacks, or Inter + Noto fallbacks). Register at boot. **Missing glyphs are the #1 rank-card bug** — usernames contain everything. |
| Emoji in names | Bundle an emoji font (Noto Color Emoji) or strip emoji from the rendered name. Bundling is ~10 MB; stripping is uglier but free. Recommend bundling. |
| Long names | Measure and ellipsize to a max width; never overflow. |
| RTL / complex scripts | Skia handles shaping; test with Arabic and Devanagari fixtures. |
| Avatars | Fetch over HTTPS with a timeout (2 s), size cap (1 MB), and an LRU cache keyed by `avatar_hash` (TTL 1 h). On failure, fall back to Discord's default avatar. Never let an avatar fetch fail the command. |
| Custom backgrounds | Validated at upload time, not render time: HTTPS only, host allow-list (Discord CDN by default), ≤2 MB, dimensions checked, content-type verified by magic bytes not header. Store the URL, re-validate periodically. **SSRF is the real risk here** (NFR-25). |
| Caching rendered cards | **No.** The data changes constantly and a card render is ~100–300 ms. Cache the *inputs* (avatar bytes, background bytes, fonts), not the output. |
| Timeout | Render has a hard 3-second budget; on timeout, fall back to the embed. |
| Interaction timing | `/rank` defers immediately (US-24, `03` §4.7). |
| Isolation | Rendering is CPU-bound and blocks the event loop. At MVP scale this is acceptable. **Migration point:** move rendering to a worker thread pool once card usage or guild count makes event-loop stalls visible in the message-XP p99. |

### 3.4 Customization model

Two layers, both optional:

- **Guild defaults** (`guild_card_config`): default background, accent color, whether member customization is allowed, which layout template.
- **Member overrides** (`member_card_config`, scoped per guild — Arcane's cards are per-server): background URL, accent, text color.

Resolution: member override → guild default → built-in default. `/rank card reset` clears the member layer.

Content policy: the operator is self-hosting, so Arcane's blacklist system is overkill. Provide `allow_member_backgrounds` (default **false**) and, when enabled, an admin-visible log of set backgrounds. Documented in the runbook as an operator responsibility.

### 3.5 The `{image}` level-up graphic

A distinct, simpler render (a banner saying "X reached level N"). Same subsystem, different template. Deliberately Future — level-up messages work as text/embed and the graphic is pure decoration that doubles the rendering surface.
