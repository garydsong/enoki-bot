# 09 — Architecture Decision Records

These are the decisions that must be locked before scaffolding. Each is expensive or impossible to reverse later.

**All 16 ADRs were accepted by the project owner on 2026-09-04.** They are binding for implementation. A coding agent must not revisit these decisions; if one appears wrong during implementation, raise it rather than silently deviating, and record the change as a superseding ADR.

---

## ADR-001 — XP storage model

**Status:** **Accepted** (2026-09-04)

**Decision.** Store a single canonical `total_xp` (lifetime XP earned in a guild) per member. Derive level, within-level progress, and rank. Keep a denormalized `level` column written in the same statement as `total_xp`, used only for indexing and sorting, never independently mutable.

**Options considered.**
1. **`total_xp` only, level derived.** ← recommended
2. **`level` + `xp_in_level` stored separately.** Implied by Arcane's documented `/xp set xp` ("change the XP progress for a member's current level").
3. **An append-only XP event ledger, with balance computed or materialized.**

**Reasoning.**
- Option 2 makes level and XP independently writable, which means they can disagree. Every bug in this class ("my level says 12 but my XP bar says level 9") is unfixable without a reconciliation job.
- Option 2 makes changing the curve a **data migration** over every member of every guild. Option 1 makes it free — the entire content of `04` §4.7.
- Option 1 makes rank a single indexed query and leaderboard ordering trivially correct.
- Option 3 is the largest table in the system, built to enable XP clawback on message deletion — a feature we've explicitly declined (`03` §3.3).
- Arcane's `/xp set xp` semantics are preserved in option 1 by translating: `total_xp = totalXpToReach(currentLevel) + amount`.

**Consequences.**
- ✅ Level is always consistent with XP by construction. Curve changes are instant and free. Rank/leaderboards are one index.
- ⚠️ The `level` column is a cache that can go stale after a curve change until rows are rewritten — mitigated by recomputing on every write and an advisory consistency check, not a constraint.
- ⚠️ We cannot answer "which message gave me this XP." Accepted; nobody asks.

---

## ADR-002 — Interpretation of Arcane's level formula

**Status:** **Accepted** (2026-09-04)

**Decision.** Interpret Arcane's published formulas as **XP required to advance from `level` to `level + 1`** (`xpForLevel(L)`), not as cumulative XP to reach a level. Members start at level 0. `curve_multiplier` scales the per-level width with rounding applied per level.

**Options considered.**
1. `f(L)` = width of level L, cumulative = Σ. ← recommended
2. `f(L)` = total XP required to reach level L.
3. Ignore Arcane and design our own curve.

**Reasoning.**
- Under option 2, the linear curve would make every level cost exactly 100 XP after the first — a "linear" curve with constant width, which is what Arcane calls **Flat**. That reading makes two of the three curves identical in shape and is almost certainly wrong.
- Option 1 gives linear a genuinely linearly-increasing width, exponential a quadratically-increasing width, and flat a constant width — three distinct, sensibly-named curves.
- `/xp set xp` operating on "progress within the current level" requires a level to have a defined width, which only option 1 provides.
- **This is documented as our inference, not as Arcane fact.** The docs do not state which reading is correct.

**Consequences.**
- ✅ Curve names match curve behavior; Arcane-familiar admins get recognizable progression speeds.
- ⚠️ If Arcane actually uses option 2, our numbers differ from theirs. Since we are not claiming compatibility and any imported XP is rescaled by the admin, this is acceptable.
- ⚠️ Verified reference values (`04` §4.3) become a compatibility contract; changing this interpretation later re-levels every server.

---

## ADR-003 — Level lookup implementation

**Status:** **Accepted** (2026-09-04)

**Decision.** Precompute a cumulative XP table per distinct `(curve_type, multiplier, maxLevelBound)` at config load, cache it, and resolve `levelFromTotalXp` by binary search. Use closed-form inverses only as test cross-checks.

**Options considered.**
1. Precomputed cumulative table + binary search. ← recommended
2. Closed-form algebraic inverse per curve.
3. Iterative subtraction from level 0 upward.

**Reasoning.**
- Per-level rounding under a multiplier breaks the algebraic identity: `Σ round(f(i)·m) ≠ round(Σ f(i)·m)`. Option 2 would therefore be *wrong* whenever the multiplier isn't 1, in a way that only shows up as an off-by-one at level boundaries — the worst kind of bug.
- The exponential curve has no clean closed-form inverse anyway.
- Option 3 is O(level) per call, which is fine at level 20 and bad at level 5000.
- Option 1 is ~8 KB per configuration, built once, O(log n) per lookup, and exactly consistent with the per-level widths shown to users.

**Consequences.**
- ✅ Displayed level width and computed level always agree.
- ✅ Adding a fourth curve requires only `xpForLevel`; the table builder and lookup are generic.
- ⚠️ A bounded table (default 1000 levels) needs lazy extension for extreme cases; guarded by a config validation that refuses configurations overflowing BIGINT at the bound.

---

## ADR-004 — Voice XP tracking strategy

**Status:** **Accepted** (2026-09-04) · in v1.0 scope (decision A10, milestone M9)

**Decision.** Persistent `voice_session` rows with **periodic tick crediting** (default 180 s) plus an **end-of-session partial flush**, and startup reconciliation against the gateway's voice-state snapshot.

**Options considered.**
1. Credit on session end only.
2. Credit continuously on every state change.
3. Periodic ticks. ← core of the recommendation
4. Ticks + end-of-session flush. ← recommended

**Reasoning.** Full comparison in `04` §8.1. In short: option 1 loses everything on a crash and delays level-ups by hours; option 2 has no natural cadence and still lumps; option 3 bounds crash loss to one tick and gives live feedback; option 4 adds exactness at the tail for a few lines of code. Write volume at target scale is ~1 write/second.

**Consequences.**
- ✅ Crash loss ≤ one tick interval. Level-ups arrive in real time. Uniform, predictable write rate.
- ✅ Because sessions are DB rows, "who is in voice" survives restarts and is debuggable.
- ⚠️ Requires a running scheduler; a stopped tick job silently stops voice XP → must be covered by `job_last_success_timestamp` alerting and `/level debug health`.
- ⚠️ Downtime is deliberately **not** credited. This is a product choice (we cannot verify presence during downtime) and must be stated in the docs so it isn't reported as a bug.

---

## ADR-005 — Leaderboard value derivation

**Status:** **Accepted** (2026-09-04)

**Decision.** Stored counters updated in the same transaction as XP writes, read via indexed keyset queries, with a 30-second TTL cache on rendered pages. No periodic aggregation, no event-log summation.

**Options considered.** (1) Compute from raw activity; (2) stored counters ←; (3) periodic aggregation into snapshots; (4) counters + snapshots.

**Reasoning.** Option 1 requires the event ledger rejected in ADR-001. Option 3 introduces staleness and a job to make an already-sub-millisecond query faster. Option 2 is O(1) write, O(log n) read, always current. The short TTL cache handles the only realistic load pattern (a burst of `/leaderboard` after an announcement) without introducing user-visible staleness.

**Consequences.**
- ✅ Simplest correct thing; no job can break the leaderboard.
- ✅ Seven metrics share one query shape and one code path.
- ⚠️ Each metric needs its own index — seven indexes across two tables. Acceptable; they are all guild-prefixed and narrow.
- ⚠️ Migration point documented for 10k+ guilds with a public web leaderboard.

---

## ADR-006 — Weekly / monthly period semantics

**Status:** **Accepted** (2026-09-04)

**Decision.** Period XP lives in `member_period_xp` keyed by `(guild, user, period_type, period_start)`. `period_start` is computed from the guild's IANA timezone and week-start day. **A "reset" is the natural consequence of the clock advancing into a new period key. No reset job exists and nothing is ever deleted.**

**Options considered.**
1. A `weekly_xp` column zeroed by a scheduled job.
2. Period-keyed buckets. ← recommended
3. Derive period XP by summing an event log within a date range.

**Reasoning.**
- Option 1 has a job that *must* run at the right moment, in every guild's timezone, and whose failure silently corrupts a competition. Arcane's documented quirk — weekly boards "only reset if you have the respective notification enabled" — is exactly this class of bug.
- Option 1 also destroys history: last week's board is gone.
- Option 2 makes reset a pure function of the clock. Downtime across a boundary has zero consequence. History is retained for free, enabling Highlights, seasons and trends with no extra work.
- Option 3 needs the rejected event log.

**Consequences.**
- ✅ Reset correctness is unconditional. Lifetime XP is structurally isolated. History is free.
- ⚠️ Row growth: ~64 rows per active member per year. Managed by a retention setting (default 104 weeks).
- ⚠️ Two extra upserts per XP award, in the same transaction. Measured cost is small; it is the price of correctness.
- ⚠️ Changing a guild's timezone does not re-bucket history. Documented in the setting's help text.

---

## ADR-007 — Role reward semantics

**Status:** **Accepted** (2026-09-04)

**Decision.** Rewards are resolved as a **desired role set** (a pure function of level + rules + stacking mode), diffed against the member's actual roles, and applied as one add/remove batch. Only roles that appear in the guild's reward rules are ever removed. Level-down triggers reconciliation by default.

**Options considered.**
1. Incremental grants on level-up only (Arcane's documented model).
2. Desired-set reconciliation. ← recommended
3. Full sync of all members on a schedule.

**Reasoning.**
- Option 1 accumulates permanent drift: a failed API call, a config change, or an XP removal leaves the member wrong forever. Arcane's own docs say rewards apply only on level-up, `/level`, or rejoin, with no backfill — which is precisely why "why didn't I get my role" is a perennial support question for every bot using this model.
- Option 2 makes correctness convergent: any reconciliation from any trigger fixes everything at once. It is also a pure function, so it is fully unit-testable and drives the debug command for free.
- Option 3 is option 2 plus rate-limit abuse; reconciliation should be triggered by events, with a bulk backfill available on demand.

**Consequences.**
- ✅ Idempotent, self-healing, testable without Discord. Handles level-down, stacking-mode changes, and reward deletion uniformly.
- ✅ `/level debug rewards` is nearly free — it is the diff, not applied.
- ⚠️ Requires knowing the member's current roles (the `GuildMembers` intent).
- ⚠️ We must be disciplined about `managedRewardRoles`: removing a role we don't own would be a serious bug. Enforced by a named test.

---

## ADR-008 — Cooldown persistence

**Status:** **Accepted** (2026-09-04)

**Decision.** Cooldowns live in process memory (`Map` + periodic sweep + LRU cap) behind a `CooldownStore` port with an atomic `tryConsume` operation. Not persisted.

**Options considered.** (1) In-memory ←; (2) a database table; (3) Redis from day one.

**Reasoning.** A lost cooldown costs at most one extra XP grant (~20 XP). Persisting it would add a write to the hottest path in the system for data that is worthless within 60 seconds. Redis adds a container and a network hop to a nanosecond operation. The atomic `tryConsume` shape is chosen now so the Redis implementation (`SET NX PX`) is a drop-in later.

**Consequences.**
- ✅ Zero hot-path I/O for cooldown checks. No operational surface.
- ⚠️ Restarts reset cooldowns. Documented, harmless.
- ⚠️ **This is one of exactly two things that must change before running two processes.** Flagged as a migration blocker, not a latent bug.
- ⚠️ Implementation constraint: the check and set must occur with no `await` between them (`04` §5.3).

---

## ADR-009 — Cache strategy / no Redis in MVP

**Status:** **Accepted** (2026-09-04)

**Decision.** In-process caching only for MVP, behind ports (`CooldownStore`, `ConfigCache`, `QueryCache`). Redis is introduced only when a second process exists.

**Options considered.** (1) No caching (DB every time); (2) in-process ←; (3) Redis; (4) in-process + Redis tiered.

**Reasoning.** At 50 guilds the entire cacheable working set is single-digit megabytes. Option 1 would put a config read on every message — wasteful but survivable; still, config is the ideal cache (small, rarely changing, versioned). Option 3 makes the hot path *slower* (serialization + network) while adding a failure mode. The precise trigger for Redis — a second process — is documented in `08` §5.2, and the port design makes the swap a composition-root change.

**Consequences.**
- ✅ One-container deploy. Fastest possible hot path. No invalidation races (single process = single source of truth).
- ⚠️ Cold cache after restart; ~50 DB reads to warm. Irrelevant.
- ⚠️ Discipline required: no new cache may be added outside the port pattern, or the migration story rots.

---

## ADR-010 — Idempotency strategy

**Status:** **Accepted** (2026-09-04)

**Decision.** Every XP-granting entry point carries an idempotency key. Enforcement is two-tier: an in-process LRU for all sources, plus **durable persistence for reaction keys only** (`reaction_award`).

**Options considered.** (1) No idempotency; (2) in-memory only; (3) durable for everything; (4) tiered ←.

**Reasoning.** The cost of a duplicate differs sharply by source. A duplicated message award after a gateway resume is worth ~20 XP and is invisible. A duplicated reaction award is not a duplicate at all — it is a **farming primitive**, because a user can deliberately remove and re-add a reaction indefinitely. So reaction dedup must survive restarts forever (bounded by a 90-day retention), while message dedup can be best-effort. Option 3 would mean a durable row per message — the rejected event ledger by another name.

**Consequences.**
- ✅ Farming is structurally prevented where it matters; no large table where it doesn't.
- ⚠️ `reaction_award` is the highest-volume table; needs the retention job.
- ⚠️ After 90 days a very old reaction could be re-farmed. Accepted (see `11`).

---

## ADR-011 — Restriction vs booster precedence

**Status:** **Accepted** (2026-09-04)

**Decision.** Two strictly ordered phases. **Eligibility (boolean, gates 1–9)** runs entirely before **amount (arithmetic, gates 10–14)**. Any denial in the eligibility phase yields zero XP regardless of boosters. Within location resolution, whitelist is a scope gate and blacklist is a prohibition that wins.

**Options considered.**
1. Two-phase, deny-wins. ← recommended
2. Boosters can override restrictions (an "override" flag per booster).
3. A numeric priority field on every rule.

**Reasoning.** Option 2 and 3 both create configurations whose behavior an admin cannot predict by reading them, which is the failure mode the brief explicitly asks to avoid. Restrictions and boosters answer different questions ("may they earn?" vs "how much?"); conflating them into one weighted system is the root of every ambiguous leveling bot config. Deny-wins is also the only choice a human intuits correctly on first reading.

**Consequences.**
- ✅ Fully deterministic and explainable; the debug trace shows the phase boundary explicitly.
- ✅ The brief's worked example has one unambiguous answer (`04` §3.3).
- ⚠️ Cannot express "this booster role bypasses the channel blacklist." If that is ever wanted, it must be modeled as a *separate whitelist entry*, not a booster flag.

---

## ADR-012 — Database choice

**Status:** **Accepted** (2026-09-04)

**Decision.** PostgreSQL 16+.

**Options considered.** (1) PostgreSQL ←; (2) SQLite with WAL; (3) MySQL/MariaDB; (4) MongoDB.

**Reasoning.** Full comparison in `07` §4.3. The deciding features are all used by this design: atomic `ON CONFLICT DO UPDATE … RETURNING` with access to the pre-update row (the hot path), partial unique indexes (one open voice session), expression/partial indexes, `timestamptz`, and a clean path to replicas/RLS. SQLite is genuinely viable at 10 guilds and simpler, but a later migration is a real project and the cost of starting on Postgres is one compose service. MongoDB is a poor fit for relational, constraint-dependent data.

**Consequences.**
- ✅ Every consistency mechanism in `07` §5 is available.
- ⚠️ A second container and a backup obligation. Covered by the compose profile and the runbook.
- ⚠️ Self-hosters who wanted a single binary are not served. If that becomes a goal, note it now — the repository layer would need a second dialect, which is much cheaper to plan than to retrofit.

---

## ADR-013 — Modular monolith with a plugin seam

**Status:** **Accepted** (2026-09-04)

**Decision.** One process, one repository, one deployable. Leveling is implemented as a `BotModule` alongside a module-agnostic platform core. Future features are additional modules. No microservices.

**Options considered.** (1) Monolith with no seam; (2) modular monolith with a plugin interface ←; (3) separate services per plugin.

**Reasoning.** The project's stated goal is "modular enough where I can continuously add features trivially." Option 1 makes that a matter of discipline that erodes. Option 3 is absurd at this scale. Option 2 costs a small interface and a registry, and — critically — the seam is **exercised from day one** because leveling itself goes through it, so it cannot silently rot.

**Consequences.**
- ✅ Adding a module means adding a folder, not editing the core.
- ✅ Intents, commands, migrations and jobs are composed from enabled modules.
- ⚠️ Modules must not import each other; cross-module needs go through published read ports. Enforced by the boundary lint rule.

---

## ADR-014 — Handling of historical statistics on reset

**Status:** **Accepted** (2026-09-04)

**Decision.** XP and activity statistics are separate. `/xp reset` clears XP and derived level by default and **preserves** `member_stats` and `member_period_xp` unless the operator explicitly opts in. Period buckets are never decremented by manual XP removal.

**Options considered.** (1) Reset everything; (2) reset XP only, stats opt-in ←; (3) archive-then-reset (soft reset with a snapshot).

**Reasoning.** Arcane documents exactly this default ("By default, resets exclude statistics"), and it is right: statistics are a record of what happened, while XP is a score. Wiping "3.2 million messages sent" because an admin wanted a fresh leaderboard destroys information that cannot be recovered. Option 3 is attractive (it is how "seasons" would work) but is a Future feature and needs UX; the bucket model in ADR-006 already makes it cheap to add later.

**Consequences.**
- ✅ Matches Arcane's documented behavior and the least-surprising interpretation.
- ✅ "Seasons" becomes an easy Future feature on top of the period buckets.
- ⚠️ After a reset, the voice/reactions/messages leaderboards still show pre-reset activity while XP shows zero. **This is a real inconsistency users will ask about** — the reset confirmation and the leaderboard footer must say so explicitly.

---

## ADR-015 — No XP clawback on message deletion or reaction removal

**Status:** **Accepted** (2026-09-04)

**Decision.** XP awarded is never revoked by the deletion of the message that earned it, by an edit, or by the removal of a reaction. `MESSAGE_UPDATE`, `MESSAGE_DELETE` and `MESSAGE_REACTION_REMOVE` are not consumed.

**Options considered.** (1) No clawback ←; (2) claw back on delete; (3) claw back only when a moderator deletes.

**Reasoning.** Clawback requires a durable per-message XP attribution table (the ledger rejected in ADR-001) — the largest table in the system, for a feature that makes moderation silently alter the leaderboard. It also produces confusing negative level movement and interacts badly with role removal. Option 3 cannot be distinguished reliably (the gateway does not tell us who deleted a message without the audit-log intent, and even then only asynchronously and incompletely). Arcane documents no clawback behavior at all.

**Consequences.**
- ✅ Three gateway events and one large table eliminated. Simpler, cheaper, more predictable.
- ⚠️ Spam that is purged still earned XP. Mitigation is the admin's `/xp remove`, which is auditable and intentional.
- ⚠️ Must be documented prominently, because users *will* expect otherwise.

---

## ADR-016 — Slash-command-only, no message commands

**Status:** **Accepted** (2026-09-04)

**Decision.** All interaction is via slash commands and components. No prefix/message commands.

**Options considered.** (1) Slash only ←; (2) slash + prefix; (3) prefix only.

**Reasoning.** Prefix commands require parsing message content, which means the **Message Content privileged intent becomes mandatory** rather than optional — and that intent is the single most likely growth blocker (`08` §5.3). Slash commands also give free permission integration, typed options, autocomplete, ephemeral responses, and mobile discoverability. Arcane itself makes `/xp` slash-only.

**Consequences.**
- ✅ The bot can run entirely without the Message Content intent (per-word mode and the effort booster degrade gracefully).
- ✅ Better UX and permission handling; no custom parser.
- ⚠️ Users used to `!rank` must adapt. Acceptable and universal now.
