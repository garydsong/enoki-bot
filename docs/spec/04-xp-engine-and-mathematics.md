# 04 — XP Engine, Leveling Mathematics, Restrictions & Boosters, Voice XP

This is the heart of the product. Everything here is Discord-free and must be unit-testable with no I/O.

---

## 1. The four separated responsibilities

The brief's key requirement. These are four distinct layers with one-way data flow:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. XP SOURCE            adapters that turn Discord events into XpCandidate   │
│    (adapter layer)      "a thing happened that might be worth XP"            │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. XP CALCULATION       pure: XpCandidate + GuildConfig + MemberContext      │
│    (domain, no I/O)     -> XpDecision { awarded | denied, amount, trace }    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. XP PERSISTENCE       atomic write; returns XpMutationResult with          │
│    (repository)         beforeTotal / afterTotal / beforeLevel / afterLevel  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. SIDE EFFECTS         reward reconciliation, notification, stats, metrics  │
│    (effect handlers)    fired from the result; failures never undo layer 3   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Non-negotiable invariants**

- Layer 2 is a pure function. Same inputs ⇒ same outputs. The only impurity is an injected RNG and an injected clock, both of which are parameters.
- Layer 3 never decides *whether* to award; it only applies a delta.
- Layer 4 never mutates XP. If a side effect needs to change XP, it re-enters at layer 1 as a new candidate.
- The **cooldown check** lives in layer 2's gate sequence but its *state* lives outside (see §5). The engine receives "cooldown expires at T" as an input and returns "consume the cooldown" as part of its output — it does not write the cooldown itself.

### 1.1 Types (conceptual, not code)

```
XpCandidate {
  guildId, userId, source: 'message'|'voice'|'reaction_add'|'reaction_receive'|'manual',
  occurredAt: Instant,
  idempotencyKey: string,            // see §6
  channelId?, parentChannelId?, categoryId?,
  messageLength?, attachmentCount?,  // only if MessageContent intent
  wordCount?,                        // only if MessageContent intent
  voiceSeconds?, voiceSessionAgeSeconds?,
  targetMessageAuthorId?,            // reaction_receive
  manualAmount?, manualActorId?, silent?
}

MemberContext { roleIds: Set, isBot, isWebhook, joinedAt, currentTotalXp, currentLevel }

XpDecision {
  outcome: 'awarded' | 'denied',
  baseXp, multiplierBps, finalXp,
  denyReason?: DenyCode,
  consumesCooldown: boolean,
  trace: TraceStep[]              // always populated
}

TraceStep { gate: string, verdict: 'pass'|'deny'|'skip'|'modify', detail: string, data?: object }
```

`XpDecision.trace` is the single mechanism behind `/level debug why`, structured debug logs, and engine tests. It is produced on **every** evaluation, not only in debug mode — the cost is a small array of objects that is discarded unless sampled or requested.

---

## 2. The evaluation pipeline (canonical order)

Gates run in this exact order. The **first deny short-circuits**, and short-circuiting early matters both for correctness (§3 precedence) and for cost (avoid DB/cache lookups for obviously-ineligible events).

| # | Gate | Deny code | Notes |
|---|---|---|---|
| 1 | `module_enabled` | `module_disabled` | Guild-level master switch |
| 2 | `source_enabled` | `source_disabled` | Per-source flag |
| 3 | `actor_is_human` | `actor_is_bot` / `actor_is_webhook` / `actor_is_self` | **Not configurable.** Webhook messages carry `webhook_id`; also reject system message types |
| 4 | `actor_eligible` | `user_ignored` / `account_too_new` / `member_too_new` | `ignored_users` list, plus the optional `min_account_age_days` / `min_member_age_hours` alt-account levers (§9) |
| 5 | `actor_has_no_denied_role` | `role_denied` | Any no-XP role denies. **Beats every booster.** |
| 6 | `location_allowed` | `channel_denied` / `channel_not_whitelisted` / `context_disabled` | See §3.2 for full resolution |
| 7 | `source_specific_gate` | `message_too_short` / `voice_inactive` / `voice_below_min_members` / `self_reaction` / `reaction_already_counted` | Per-source preconditions |
| 8 | `cooldown` | `on_cooldown` | Input: `cooldownExpiresAt`. Denies without consuming anything |
| 9 | `max_level_reached` | `max_level` | Only denies *level* progression; see §4.6 — by default **XP is still awarded** so leaderboards keep ordering; configurable to hard-stop |
| 10 | `base_xp_roll` | — | modify step |
| 11 | `effort_bonus` | — | modify step, needs message content |
| 12 | `multiplier_stack` | — | modify step, §3.3 |
| 13 | `clamp_and_round` | — | modify step, §3.4 |
| 14 | `zero_check` | `computed_zero` | If final XP is 0, treat as denied so we don't write a no-op or consume a cooldown |

**Gates 1–9 are the "eligibility" phase (boolean). Gates 10–14 are the "amount" phase (arithmetic).** No amount-phase step can resurrect an eligibility denial. This is the deterministic answer to the brief's precedence question.

---

## 3. Restrictions & boosters

### 3.1 Model

Both are rows in one table with a discriminator, so resolution is one query and one code path:

```
xp_rule {
  guild_id, id,
  kind:        'restrict_deny' | 'restrict_only' | 'boost',
  target_type: 'channel' | 'category' | 'role' | 'user' | 'source' | 'guild',
  target_id:   snowflake | source name | null (for guild scope),
  bonus_bps:   int | null,     // boosts only; 2500 = +25%
  expires_at:  timestamptz | null,  // temporary boosters
  source_scope: source | null  // optional: rule applies only to one XP source
}
```

`bonus_bps` uses **basis points as an integer bonus over a 1.0 base**, matching Arcane's documented additive semantics (10% + 25% = 35%). Integer math avoids float drift.

### 3.2 Location resolution

For a message in channel `C`:

1. Build the **location chain**: `[thread?] → [parent text/forum channel] → [category]`. For voice: `[voice channel] → [category]`. Each element is a candidate target for channel/category rules.
2. **Context toggles first** (cheapest, most specific): if the location is a thread and `xp_in_threads = false` → deny `context_disabled`. Same for forum posts, voice-channel text.
3. **Whitelist gate:** if `restrict_only` channel/category rules exist for this guild, then *some element of the chain* must match one, else deny `channel_not_whitelisted`.
4. **Blacklist gate:** if *any element of the chain* matches a `restrict_deny` channel/category rule → deny `channel_denied`.

Order matters: **blacklist is evaluated after whitelist and therefore wins.** A channel that is both whitelisted and blacklisted denies. This is the only self-consistent choice — "only these channels" is a scope statement, "never this channel" is a prohibition, and prohibitions must be able to carve exceptions out of scopes. `/level restrict list` warns whenever this contradiction exists.

Thread inheritance: a thread inherits its parent's rules **and** may have its own. An explicitly whitelisted thread inside a non-whitelisted parent passes step 3 (the chain contains the thread). An explicitly blacklisted thread inside an allowed parent denies at step 4.

### 3.3 Multiplier stacking

Applies only after all eligibility gates pass.

```
applicable = all 'boost' rules where:
     (target is guild)
  or (target_type=role   and member has that role)
  or (target_type=channel/category and it is in the location chain)
  or (target_type=source and it matches this source)
  or (target_type=user   and it is this member)
  AND (expires_at is null or expires_at > now)
  AND (source_scope is null or source_scope = this source)

if booster_stacking == 'stack':
    totalBonusBps = sum(applicable.bonus_bps)
else: # 'highest'
    totalBonusBps = max(applicable.bonus_bps, default 0)

multiplierBps = clamp(10000 + totalBonusBps, MIN_MULT_BPS, MAX_MULT_BPS)
```

Defaults: `MIN_MULT_BPS = 0` (a −100% nerf is allowed and means zero XP), `MAX_MULT_BPS = 100000` (10×) as a foot-gun guard, configurable.

**Location chain and multiple channel boosts:** if both a channel and its category have boosts, in `stack` mode both apply. That is surprising to some admins — `/rank boosters` shows the arithmetic explicitly so it is never a mystery.

**The brief's worked example.** Member has: a +100% role booster, a +50% channel booster, a no-XP role, and is posting in a no-XP channel.

> **Result: no XP. Deny code `role_denied` (gate 5).**
> The role restriction is reached first; the channel restriction would also have denied at gate 6; neither booster is ever evaluated because boosters live in the amount phase. The trace shows: gates 1–4 pass, gate 5 deny, remaining gates `skip`.

The reported deny reason is the **first** failing gate, but `/level debug why` runs in a "collect all" mode that continues past the first deny and reports every failing gate — so an admin fixing one problem is not surprised by a second.

### 3.4 Rounding & clamping

```
baseXp        : integer  (from the roll, already integral)
effortBonus   : integer
subtotal      = baseXp + effortBonus
finalXp       = round(subtotal * multiplierBps / 10000)
finalXp       = clamp(finalXp, 0, per_event_cap)
```

- Rounding is **half-up** (`Math.round`), applied once at the end. Rounding intermediate steps compounds error.
- `per_event_cap` (default 500) is a hard safety valve so a misconfigured 100× booster cannot mint a million XP from one message.
- Rounding half-up means a +1% boost on 15 XP yields 15 (15.15 → 15), i.e. small boosts on small amounts can be invisible. This is acceptable and documented; the alternative (accumulating fractional XP) adds a column and a lot of confusion for no user-visible benefit. Flagged in `11` as a product preference.

---

## 4. Leveling mathematics

### 4.1 Arcane's documented formulas

Arcane publishes three "level formulas", all modified by a multiplier:

| Curve | Formula | Notes |
|---|---|---|
| Linear (default) | `(level * 100) + 75` | |
| Exponential | `5 * (level^2) + (level * 50) + 75` | |
| Flat | `1000` | |

**What is documented:** the expressions themselves and that they are multiplied by a configurable multiplier.
**What is NOT documented:** whether these give *XP to advance from `level` to `level+1`* or *cumulative XP to reach `level`*. **This is our design decision.** We interpret them as **XP required to advance from `level` to `level + 1`**, i.e. `xpForLevel(L)`. Two reasons: (a) at `L=0` linear gives 75, a sensible first-level cost, while a cumulative reading would mean you start at level 0 needing 75 total and level 1 needing 175 total — a 100 XP second level, which is also plausible but (b) Arcane's `/xp set xp` is documented as "change the XP progress for a member's **current level**", which only makes sense if a level has a defined *width*. Recorded as ADR-002.

### 4.2 Our model

- **Canonical stored value: `total_xp`** — lifetime XP in this guild, a non-negative integer.
- **Derived: `level`**, `xpIntoLevel`, `xpForNextLevel`, `progressPercent`. A `level` column is stored **only as a denormalized cache** for indexing and leaderboards, recomputed in the same statement as every XP write and never independently writable.

```
xpForLevel(L)        = round(baseFormula(L) * curve_multiplier)   // width of level L
totalXpToReach(L)    = Σ_{i=0}^{L-1} xpForLevel(i)
levelFromTotalXp(X)  = max L such that totalXpToReach(L) <= X
xpIntoLevel(X)       = X - totalXpToReach(levelFromTotalXp(X))
xpForNextLevel(X)    = xpForLevel(levelFromTotalXp(X))
```

Everyone starts at **level 0** with 0 XP. (Arcane's `(level*100)+75` at level 0 giving 75 implies a level 0 exists.) Level 1 costs 75 XP with default settings.

### 4.3 Closed forms (verified numerically)

With `curve_multiplier = 1`:

| Curve | `xpForLevel(L)` | `totalXpToReach(N)` | Inverse |
|---|---|---|---|
| Linear | `100L + 75` | `50N² + 25N` | `N = ⌊(−25 + √(625 + 200X)) / 100⌋` — exact with integer sqrt |
| Exponential | `5L² + 50L + 75` | `5(N−1)N(2N−1)/6 + 25(N−1)N + 75N` | no clean closed form → binary search |
| Flat | `1000` | `1000N` | `N = ⌊X / 1000⌋` |

Sanity values (multiplier 1): linear total to level 10 = **5 250**, to level 50 = **126 250**, to level 100 = **502 500**. Exponential to level 10 = **4 425**, to level 50 = **267 125**, to level 100 = **1 896 750**. Flat to level 100 = **100 000**.

*(These closed forms were verified by brute-force summation for N = 0…59, and the linear inverse verified for X = 0…3 000 000. Any implementation must reproduce these numbers — they belong in the test fixtures.)*

**With a multiplier**, per-level rounding means `totalXpToReach` is no longer the closed form of the scaled polynomial (`Σ round(f(i)·m) ≠ round(Σ f(i)·m)`). **Decision:** build a **precomputed cumulative table** at config-load time, `cum[0..maxLevelBound]`, using per-level rounding, and answer `levelFromTotalXp` by binary search over it. With `maxLevelBound = 1000` this is an 8 KB array per distinct (curve, multiplier) pair, computed once and cached. Lookups are O(log n) ≈ 10 comparisons. This is simpler, exactly consistent, and fast enough that the closed forms are only used as a cross-check in tests. Recorded as ADR-003.

`maxLevelBound` = `max_level` if set, else 1000; if a member's total XP exceeds `cum[1000]` the table extends lazily in blocks. Guard: refuse a curve/multiplier configuration whose level 1000 threshold overflows `BIGINT`.

### 4.4 Rank

Rank is **always computed, never stored**:

```sql
SELECT count(*) + 1
FROM member_xp
WHERE guild_id = $1 AND (total_xp, user_id) > ($2, $3)  -- tuple compare for stable ties
```

- **Tie-break: higher `total_xp` first, then lower `user_id` first.** Deterministic and stable between calls, so a member's rank doesn't flicker (US-20 AC2).
- Members with 0 XP are excluded from ranking entirely and displayed as "unranked".
- Rank is one indexed query on `(guild_id, total_xp DESC, user_id ASC)`. Even at 100k members this is sub-millisecond. Storing a rank column would require a full-guild rewrite on every XP grant — never do this.
- Leaderboard **listing** uses keyset pagination on the same tuple, which is why the tie-break must be part of the index.

### 4.5 XP removal and level loss

| Situation | Behavior |
|---|---|
| Manual removal | `total_xp = max(0, total_xp − amount)`; level recomputed; may drop many levels at once |
| Level drops | `remove_on_level_down = true` (default): reward roles are reconciled downward. `false`: roles are kept (a "once earned, always yours" policy) |
| Notification | **Never** announce a level decrease |
| Statistics | Message/voice/reaction counters are **not** decremented by XP removal — they are activity records, not currency. Only an explicit `stats: true` reset clears them |
| Period buckets | XP removal does **not** decrement weekly/monthly buckets by default. Those are "XP earned this week", and an admin correction is not un-earning. Flagged in `11` |
| `total_xp` reaching 0 | Row is kept (so stats survive) with `total_xp = 0`, level 0, unranked |

### 4.6 Max level

- At `max_level`, the displayed level is capped.
- **Default: XP continues to accumulate** past the cap. This keeps leaderboard ordering meaningful for a maxed community and preserves the ability to raise the cap later without anyone "losing" earned XP.
- `hard_cap_xp` (default false) stops awarding entirely at the cap — cheaper on writes, but destroys ordering. Offered as a setting.
- No level-up messages fire at or above the cap.

### 4.7 Changing the curve

Because level is derived, changing `curve_type` or `curve_multiplier` instantly re-levels everyone with **zero data migration**. This is the main payoff of the total-XP model. Consequences to handle:

- Reward roles become stale until reconciled → `/level config set` on a curve setting warns and offers `/level rewards backfill`.
- `/level config curve-preview` shows the before/after distribution without applying.
- No level-up messages are emitted for curve-change-induced level increases (they are not achievements).

---

## 5. Cooldowns

### 5.1 Semantics

- Per **(guild, member, source)**. A message cooldown never blocks reaction or voice XP.
- **Fixed window from last award**, not sliding. A message sent during the cooldown does not extend it (US-3 AC1) — a sliding window would let a spammer permanently suppress their own earning, which is confusing rather than protective.
- A denied event **never** consumes or refreshes a cooldown. Only an actually-awarded event sets `cooldownExpiresAt = now + cooldown_seconds`.

### 5.2 Storage

**In-process `Map<string, number>` with periodic sweep, not the database.** Rationale:

- Cooldowns are worth at most one XP grant if lost. Losing them on restart costs a member ~20 XP.
- Writing a cooldown row on every message doubles the hot-path write volume for data that is worthless in 60 seconds.
- Bounded: keys are evicted on expiry by a 60-second sweep, plus an LRU cap (default 200k entries) as a memory guard.

**Migration point:** the moment there are two bot processes, cooldowns must move behind a shared store (Redis `SET key val NX PX ttl`, which is also the atomic check-and-set the engine wants). The interface `CooldownStore { tryConsume(key, ttlMs): Promise<Consumed | RemainingMs> }` is defined from day one with an in-memory implementation. Recorded as ADR-008.

### 5.3 The check-and-set race

Two messages from the same member in the same millisecond both read "no cooldown" and both award. Prevented by making the cooldown store's operation **atomic check-and-set** rather than read-then-write, and by serializing per-member work (§`07` concurrency). With the in-memory Map this is trivially atomic because Node is single-threaded per event loop turn — provided no `await` occurs between the read and the write. **The engine must therefore consume the cooldown synchronously before any async persistence.** This is a real, easy-to-get-wrong detail and belongs in the implementation notes.

---

## 6. Idempotency & duplicate events

Every candidate carries an `idempotencyKey`:

| Source | Key | Rationale |
|---|---|---|
| `message` | `msg:{messageId}` | Discord may redeliver on resume |
| `reaction_add` | `radd:{messageId}:{userId}:{emoji}` | Also permanently prevents add/remove/re-add farming |
| `reaction_receive` | `rrecv:{messageId}:{reactorId}:{emoji}` | Same |
| `voice` | `voice:{sessionId}:{tickIndex}` | Ticks are numbered; a replayed tick is a no-op |
| `manual` | `manual:{interactionId}` | Discord retries interactions |

**Two-tier enforcement:**

1. **Cheap:** an in-process LRU of recently seen keys (last ~50k, ~10 min) short-circuits the common case with zero I/O.
2. **Durable, only where it matters:** reaction keys are persisted in `reaction_award` because "already counted" must survive restarts *forever* to prevent farming. Message and voice keys are **not** persisted — the cost of a duplicated message award after a crash is trivial, and a table with one row per message is unacceptable.

This asymmetry is deliberate and is the correct cost/benefit split. Recorded as ADR-010.

---

## 7. Per-source specifications

### 7.1 Message XP

**Random mode (MVP, default)**
`baseXp = randomInt(min_xp, max_xp)` inclusive, from an injected RNG (seedable in tests).

**Per-word mode (post-MVP, requires Message Content intent)**
Arcane documents: "grants maximum XP per word (3+ characters), requiring more words than whitespace." Our interpretation, flagged as a design decision:

```
words       = tokens matching /\p{L}\p{N}'-/u of length >= 3   (Unicode-aware)
whitespaceRuns = count of maximal whitespace sequences
if words.length <= whitespaceRuns: deny 'per_word_padding'   // anti-padding heuristic
baseXp = min(words.length * max_xp, per_event_cap)
```

The "more words than whitespace" rule is an anti-padding heuristic (defeats `a  b  c   d` and long runs of spaces). Ours is an interpretation of a one-sentence doc, not Arcane's actual algorithm.

**Effort booster (post-MVP, requires Message Content intent)** — Arcane documents that longer messages and images give bonus XP but publishes no formula. Our proposal:

```
lengthBonus     = min(floor(charCount / effort_chars_per_xp), effort_length_cap)   // default 50 chars/XP, cap 10
attachmentBonus = min(attachmentCount, 1) * effort_attachment_xp                   // default 5, counted once
effortBonus     = lengthBonus + attachmentBonus
```

Capping the attachment bonus at "any attachments at all" rather than per-attachment prevents 10-image spam.

**Excluded message types:** everything except `DEFAULT` and `REPLY`. Explicitly excluded: joins, boosts, pins, thread-created, call, channel-follow-add, auto-moderation-action, poll-result, and any future system type (allowlist, not denylist).

**Bots and webhooks:** `author.bot === true` or `webhookId != null` → deny. Not configurable. A webhook can impersonate any name/avatar, so "trusted webhook XP" is an abuse hole with no legitimate use.

### 7.2 Reaction XP

Two independent sources.

| | `reaction_add` | `reaction_receive` |
|---|---|---|
| Actor | the reactor | the message author |
| Cooldown key | `(guild, reactor, reaction_add)` | `(guild, author, reaction_receive)` |
| Self-reaction | reactor == author → deny `self_reaction` (configurable, default deny) | same |
| Dedup | persisted per `(message, reactor, emoji)` | same |
| Author lookup | n/a | from the cached message; if uncached, one API fetch with an LRU cache; on failure skip |

**Farming vectors and mitigations:**
- Add/remove/re-add loop → persisted dedup key (never re-earns).
- Alt account spamming reactions on a friend's messages → cooldown on the *receiver* limits total intake; plus `reaction_receive_max_per_message` (default 3 distinct reactors credited).
- Reacting to a 2-year-old message → optional `reaction_max_message_age_days` (default null = allowed).
- Mass-reacting to one's own old messages with alts → covered by the receive cooldown and per-message cap.

### 7.3 Manual XP

Bypasses gates 2–9 (it is an explicit administrative act) but still runs gates 10–14 in reverse: no multipliers apply (a manual grant of 100 means 100, not 135), no cooldown is consumed, `per_event_cap` does not apply, and `manual_xp_level_limit` applies instead. Always audited. Always carries `silent` semantics under the operator's control.

---

## 8. Voice XP

Voice deserves its own design because it is the only **stateful, time-based** source, and the only one that can lose data across a restart.

### 8.1 Crediting strategy — the core decision

| Strategy | How | Pros | Cons |
|---|---|---|---|
| **A. Continuous** | award on every state change, computing elapsed time | exact | no natural cadence for level-ups; a 4-hour session yields one giant award at the end |
| **B. On session end** | record join, award everything on leave | one write per session | **loses everything on crash**; level-ups arrive in a lump hours later; a member who never leaves never levels |
| **C. Periodic ticks** | a job runs every `voice_tick_seconds`, credits each open eligible session for the elapsed interval, advances a watermark | bounded loss (≤ one tick), level-ups arrive in real time, uniform write rate, naturally implements cooldown-as-tick-interval | a job must run; N writes per tick |
| **D. Hybrid C + end-of-session flush** | ticks plus a final partial credit on leave | exact to the second, still bounded loss | slightly more code |

**Recommendation: D (ticks with an end-of-session flush).** Ticks bound crash loss to one interval (default 180 s ≈ one message's worth of XP), give members live level-up feedback, and produce a predictable write rate: with 50 guilds and 200 concurrent voice members that is 200 writes per 3 minutes ≈ **1.1 writes/second**. The end-of-session flush credits the partial interval so a member who leaves at 2:59 into a tick is not robbed.

Recorded as ADR-004.

### 8.2 Session model

```
voice_session {
  id, guild_id, user_id, channel_id,
  started_at,
  last_credited_at,        // watermark: everything before this is paid for
  accrued_eligible_seconds,// running total of *eligible* time this session
  credited_xp,             // running total awarded this session
  is_eligible,             // current eligibility snapshot
  ineligible_since,        // when eligibility was lost (for partial crediting)
  last_heartbeat_at,       // updated each tick; used for orphan detection
  ended_at                 // null while open
}
```

Exactly one open session per `(guild_id, user_id)` — enforced by a partial unique index `WHERE ended_at IS NULL`.

### 8.3 State transitions

| Discord event | Action |
|---|---|
| Join eligible channel | Open session. `started_at = last_credited_at = now`. |
| Leave voice | Flush partial credit (from `last_credited_at` to now, if eligible), close session. |
| Move to another voice channel | **Mutation, not leave+join.** Flush partial credit for the old channel, update `channel_id`, keep the session (so anti-AFK aging and accrued time survive channel hopping — otherwise hopping resets the anti-AFK timer, which is the obvious exploit). Re-evaluate eligibility for the new channel. |
| Move to the AFK channel | Flush, mark ineligible, keep the session open. |
| Self/server mute or deafen | Flush credit up to now, set `is_eligible = false`, `ineligible_since = now`. Session stays open. |
| Unmute/undeafen | `is_eligible = true`, `last_credited_at = now` (the ineligible gap is simply never credited). |
| Another member joins/leaves the channel | Re-evaluate `voice_min_members` for **every** session in that channel — a member becoming alone must stop earning, and a second person arriving must start everyone earning. This is the subtle one: eligibility depends on *other* members' states, so a single `VOICE_STATE_UPDATE` can change N sessions. |

### 8.4 Eligibility predicate

A member is voice-eligible iff **all** configured conditions hold:

```
not bot
not in AFK channel                       (if voice_ignore_afk_channel)
not self_deaf                            (if voice_require_undeafened)
not self_mute                            (if voice_require_unmuted)
not server_deaf / server_mute            (if voice_count_server_mute_as_inactive)
channel not restricted (deny/whitelist/category rules apply to voice channels too)
member has no no-XP role
count(other members in channel who are themselves "present and countable") >= voice_min_members
```

**"Countable" for the minimum-members test** is a separate, looser predicate than "eligible": a member counts toward the threshold if they are a non-bot human in the channel and (configurably) not deafened. Using *eligible* for the count creates a deadlock-ish oddity where two muted people never enable each other. **Decision:** count non-bot humans who are not deafened; ignore mute. `voice_ignore_bots_in_member_count` default true. Flagged in `11`.

Arcane documents "Arcane only considers a member to be active when unmuted and not deaf" and a "Minimum Members" setting, but does not publish the counting rule — this is ours.

### 8.5 Anti-AFK

Arcane documents only: XP "automatically starts to lower... after they have been in a voice channel for multiple hours in one session." Our design:

```
hoursOverThreshold = max(0, (sessionAgeSeconds - anti_afk_after_minutes*60) / 3600)
decay = (1 - anti_afk_decay_per_hour) ^ hoursOverThreshold
antiAfkMultiplier = max(anti_afk_floor_multiplier, decay)
```

Defaults: threshold 120 min, 25%/hour decay, floor 0.1. So hours 0–2 full rate, hour 3 ×0.75, hour 4 ×0.56, hour 6 ×0.32, asymptote ×0.10. `sessionAge` is *eligible* time, not wall-clock, and it resets only when the session closes — a member must actually leave voice (for a configurable `anti_afk_reset_after_minutes`, default 30) to reset. Otherwise "leave and rejoin every 2 hours" defeats it.

Anti-AFK is applied as a multiplier in gate 12 alongside boosters, but as a **separate multiplicative factor**, not an additive bonus: `finalXp = round(base * boosterBps/10000 * antiAfkMultiplier)`. It is a penalty, not a booster, and must not be cancelled out by stacking a big booster.

### 8.6 Restart and crash recovery

**On graceful shutdown (SIGTERM):** flush every open session's partial credit, set `last_heartbeat_at`, leave sessions **open** with a `paused_at` marker. Do not close them — the members are still in voice.

**On startup (`READY`), reconciliation:**

1. `GUILD_CREATE` payloads carry `voice_states` for each guild — the authoritative current picture.
2. For each open session in the DB: if the member is still in that voice channel per the gateway snapshot → **resume it**, setting `last_credited_at = now` (the downtime gap is *not* credited — we cannot prove they were active during it, and crediting it would reward crashes).
3. If the member is no longer in voice → close the session with `ended_at = last_heartbeat_at` (their last proven-present moment). No further credit.
4. For each member currently in voice with no open session → open a fresh session.
5. Sessions whose `last_heartbeat_at` is older than `orphan_threshold` (default 1 hour) are closed unconditionally as orphans.

**Result:** maximum loss is one tick interval plus the downtime itself. A member in voice through a 30-second restart loses ≤ 3.5 minutes of credit. A member in voice through a 3-hour outage loses the 3 hours (correct — the bot could not verify their state) but keeps everything before and resumes after. This satisfies "the system should not lose large amounts of voice activity because the bot restarted."

**Discord outage / guild unavailable:** treated as downtime, same handling. Do **not** close sessions on `GUILD_DELETE` with `unavailable: true`.

**Clock:** all timestamps are `timestamptz` in UTC from the database's clock where possible (`now()`), not the app's, to avoid drift across restarts on a machine with a bad clock.

### 8.7 Voice XP amount

Per tick: `baseXp = randomInt(voice.min_xp, voice.max_xp)` scaled by the fraction of the tick that was eligible (a member who muted 60 s into a 180 s tick gets ⅓). Then boosters and anti-AFK as above. Voice time for the leaderboard accumulates in `member_stats.voice_seconds` from eligible seconds only — with a config flag to count all seconds present, since "voice time" as a stat arguably means presence. Flagged in `11`.

---

## 9. Spam & abuse handling in the engine

| Vector | Mechanism | Layer |
|---|---|---|
| Message spam | cooldown (fixed window) | engine gate 8 |
| One-character message spam | `min_message_length` (needs content intent); cooldown otherwise | gate 7 |
| Reaction farming | persisted dedup key + receive cooldown + per-message reactor cap | gate 7 |
| Self-reactions | explicit gate | gate 7 |
| Voice AFK farming | eligibility predicate + minimum members + anti-AFK decay | §8.4/8.5 |
| Voice channel-hop to reset anti-AFK | anti-AFK age tracks the session, and the session survives moves | §8.3 |
| Bot/webhook XP | hard rejection, not configurable | gate 3 |
| Booster misconfiguration minting XP | `per_event_cap`, `MAX_MULT_BPS` | gate 13 |
| Admin XP abuse | `manual_xp_level_limit`, `xp_command_owner_only`, audit log | command layer |
| Alt-account farming | **not solvable technically.** Mitigations are guild policy: minimum account age / minimum time-in-guild before earning XP (`min_account_age_days`, `min_member_age_hours`, both default 0). Offered as configuration, not enforced. | gate 4 |
