# 11 — Decisions Log & Remaining Questions

**Status: ALL BLOCKING QUESTIONS RESOLVED (2026-09-04). The spec is scaffolding-ready.**

Every §A question is answered, all 16 ADRs in `09` are **Accepted**, and the §B/§C recommendations are adopted as the implementation defaults. A coding agent should treat everything below as settled and build to it. If something here turns out to be wrong during implementation, raise it — do not silently deviate.

---

## Resolved — architecture & data (§A)

| # | Question | Decision |
|---|---|---|
| **A1| Language / runtime | **TypeScript** on Node 22 LTS, strict mode, ESM, discord.js v14 |
| **A2| Database | **PostgreSQL 16+** with Drizzle ORM and Drizzle Kit migrations |
| **A3| XP storage model | **Store canonical `total_xp`; derive level, within-level progress and rank.** `level` is a denormalized cache written in the same statement, never independently mutable. (ADR-001) |
| **A4| Leveling formula interpretation | **Arcane's three formulas are per-level widths** (`xpForLevel(L)`), members start at **level 0**, multiplier applied per level with rounding. The verified reference values in `04` §4.3 are a test contract. (ADR-002) |
| **A5| Restriction vs booster precedence | **Two strictly ordered phases: eligibility (boolean) before amount (arithmetic). Restrictions always win; blacklist beats whitelist.** (ADR-011) |
| **A6| XP clawback | **None.** `MESSAGE_UPDATE`, `MESSAGE_DELETE` and `MESSAGE_REACTION_REMOVE` are not consumed. No per-message XP ledger exists. (ADR-015) |
| **A7| Weekly / monthly periods | **Period-keyed buckets in `member_period_xp`.** A reset is the clock advancing into a new key. No reset job, nothing ever deleted. (ADR-006) |
| **A8| Privileged intents | **Enable `GuildMembers` and `MessageContent`; never request `GuildPresences`.** Self-serve below Discord's 10,000-unique-user threshold (`03` §1.1). `MessageContent` is modeled as an **optional capability** — the bot boots without it and self-disables per-word mode, `min_message_length` and the effort booster, because the annual reapplication requirement means access can lapse on a live bot. |
| **A9| Snowflake column type | **`BIGINT`.** Half the index size and correct ordering; BigInt↔string conversion is confined to the repository mapping layer. |
| **A10| Voice XP in v1.0 | **Yes.** Voice is milestone **M9**, hardening becomes **M10**, and v1.0 ends at M10. FR-1.4–1.6 and BR-1 are MVP. |
| **A11| Web dashboard | **Much later.** The Discord-free `application/config` and `application/queries` seam is kept as designed; no HTTP/OAuth2/frontend work in M0–M15. |
| **A12| `xp_from_slash_commands` | **Not implemented.** A Discord app receives only its own interactions; removed from the config schema rather than shipped half-working. (`00` §2.3, `03` §3.3) |

## Resolved — product behavior (§C)

| # | Question | Decision |
|---|---|---|
| C1 | Member command name | **`/rank`** for the member view; `/level` is the admin namespace |
| C2 | Reward roles on level-down | Configurable `remove_on_level_down`, default on** |
| C3 | Does XP removal reduce weekly/monthly XP? | **No** — an admin correction is not un-earning |
| C4 | `/rank` reconciles reward roles? | **Off by default** (`reconcile_on_rank_command`) |
| C5 | Departed members count toward rank? | **Yes, counted and labeled** — rank shouldn't drift for unrelated reasons |
| C6 | Voice "time" on the leaderboard | **Eligible time only**, so the stat matches the XP |
| C7 | Voice minimum-members counting | Count non-deafened humans**; mute ignored, bots excluded |
| C8 | Rounding on small boosts | **Round half-up once at the end**; no fractional XP |
| C9 | XP past max level | **Keeps accruing**; level is capped, ordering preserved |
| C10 | Level-up message frequency | **Every level**, with `levelup_only_on_reward_levels` available |
| C11 | Self-reactions | **Denied** by default |
| C12 | Stats after `/xp reset server` | **Preserved** by default; the confirmation must state the resulting inconsistency |
| C13 | DMs | **Never** in v1 |
| C14 | Retention after guild removal | **30 days**, then cascade delete |

## Resolved — implementation defaults (§B)

All §B defaults below are **adopted**. They are tuning values, not architecture; change them freely during implementation if something proves wrong in practice, but start here.

| # | Setting | Adopted default |
|---|---|---|
| B1 | Per-source min/max XP | message 15–25 · reaction 20–25 · voice 10–15 per tick |
| B2 | Anti-AFK | 25%/hour decay after 2 hours, floor ×0.1 |
| B3 | Effort booster | +1 XP per 50 chars capped at +10, plus +5 for having any attachment |
| B4 | Per-word tokenization | As specified in `04` §7.1 |
| B5 | Safety clamps | `per_event_cap` 500 · `MAX_MULT_BPS` 10× |
| B6 | Rank card size | 934×282 |
| B7 | Emoji font | Bundle Noto Color Emoji |
| B8 | Reaction dedup retention | 90 days |
| B9 | Leaderboard | Page size 10; keyset paging, bounded OFFSET only for explicit page jumps |
| B10 | Metrics | `MetricsSink` port from M1 (no-op); `prom-client` wired in M8 |
| B11 | Error tracking | Sentry off by default, opt-in via env |
| B12 | Alt-account levers | `min_account_age_days` 0, `min_member_age_hours` 0 (available, off) |
| B13 | Command aliases | No top-level `/rewards`, `/boosters`, `/card`; nested under `/rank` |
| B14 | Voice tick interval | 180 s |
| B15 | `messages_counted` | Counts XP-earning messages only |

---

## Original question list (retained for rationale)

The tables below are the original analysis, kept so the *reasoning* behind each decision stays with the spec. Every item is now resolved above.

### A. Architecture & data — *all resolved*

These changed the architecture or the database. Getting them wrong would have meant a migration or a rewrite.

| # | Question | Why it mattered | Decision taken |
|---|---|---|---|
| A1 | Language/runtime: TypeScript or Python? | Everything downstream. A language change invalidates half the technology section. | TypeScript, for discord.js maturity and shared types with the future dashboard. |
| A2 | PostgreSQL vs SQLite. At 10 guilds SQLite genuinely works and is one less container. | Migrating later is a real project. The schema uses partial unique indexes and `ON CONFLICT … RETURNING` semantics that differ. | PostgreSQL (ADR-012). One compose line; removes the migration risk entirely. |
| A3 | Store `total_xp` and derive level (ADR-001)? | The single most structural decision. Reversing it later means migrating every member row in every guild. | Store `total_xp`. |
| A4 | Arcane's formulas as per-level widths, starting at level 0 (ADR-002)? | Determines everyone's level numbers forever. Changing it re-levels every server. | Per-level widths, start at level 0. |
| A5 | Restrictions strictly beat boosters; blacklist beats whitelist (ADR-011)? | Baked into the gate pipeline order. | Two-phase, deny-wins. |
| A6 | No XP clawback on message delete or reaction removal (ADR-015)? | Determines whether we need a per-message XP ledger — the largest table in the system, and it must exist from day one if we ever want clawback. | No clawback. |
| A7 | Period buckets with no reset job (ADR-006)? | Determines the `member_period_xp` schema and whether weekly XP is a column or a table. | Period buckets. |
| A8 | Which privileged intents to enable? | `MessageContent` determines whether three features exist at all and whether the bot needs a capability-degradation path. `GuildMembers` determines whether role restrictions can be correct. | Both, and never `GuildPresences`. Build `MessageContent` as an optional capability regardless — access can lapse via the annual reapplication. |
| A9 | Snowflakes as `BIGINT` or `TEXT`? | A schema-wide type decision. | `BIGINT` — half the index size, correct ordering, and the JS BigInt friction is confined to one mapping layer. |
| A10 | Voice XP in the first release? | It's the largest single feature and the only stateful one. | Included in v1.0 as M9, placed after the debugging milestone so its silent failure modes are diagnosable while being built. |
| A11 | Is a web dashboard actually coming? | It's the reason `application/config` and `application/queries` are Discord-free API surfaces. | Coming much later; keep the seam — it also makes those use cases testable without Discord. |
| A12 | `xp_from_slash_commands` — implementable? | If it can't be implemented, it shouldn't be in the config schema at all. | Not implementable faithfully; dropped entirely rather than shipped half-working. |

---

### B. Implementation defaults — *all adopted*

Real questions, but none of them change the foundation. Tune freely during implementation.

| # | Question | Adopted default |
|---|---|---|
| B1 | Default `min_xp`/`max_xp` per source. Arcane doesn't publish theirs. | message 15–25, reaction 20–25, voice 10–15 per tick |
| B2 | Exact anti-AFK decay shape and defaults. Arcane documents only that it exists. | 25%/hour decay after 2 hours, floor ×0.1 |
| B3 | Effort booster formula. Arcane publishes none. | 1 XP per 50 chars capped at +10, plus +5 for having any attachment |
| B4 | Per-word mode's exact tokenization and the "more words than whitespace" rule. Our interpretation of one sentence. | As specified in `04` §7.1 |
| B5 | `per_event_cap` and `MAX_MULT_BPS` values. | 500 and 10× |
| B6 | Card dimensions and layout — Arcane's 800×200, or the roomier 934×282 that most modern bots use. | 934×282 |
| B7 | Bundle a color emoji font (~10 MB image size) or strip emoji from rendered names? | Bundle it; usernames are full of emoji |
| B8 | `reaction_dedup_retention_days` — after this, a very old reaction could theoretically be re-farmed. | 90 days |
| B9 | Leaderboard page size and whether "jump to page N" uses OFFSET. | 10; yes, bounded OFFSET for explicit jumps only |
| B10 | Prometheus metrics in v1.0 or later? | Port exists from M1 with a no-op impl; wire `prom-client` in M8 |
| B11 | Sentry / error tracking on by default? | Off; opt-in via env |
| B12 | `min_account_age_days` / `min_member_age_hours` defaults for alt-account mitigation. | 0 (off), documented as available |
| B13 | Whether to also register `/rewards`, `/boosters`, `/card` as top-level aliases for Arcane familiarity. | No — nest under `/rank`; revisit if users complain |
| B14 | Voice tick interval default. | 180 s (Arcane's documented voice cooldown) |
| B15 | Whether `messages_counted` counts all messages or only XP-earning ones. | XP-earning only (all messages would triple hot-path writes) |

---

### C. Product preferences — *all resolved as recommended*

These had no technically correct answer. The owner accepted every recommendation; the reasoning is kept here.

| # | Question | Options | Decision |
|---|---|---|---|
| C1 | **`/rank` or `/level` for the member command?** Arcane uses `/level`; MEE6, Atlas and Amari use `/rank`. | `/rank` · `/level` · both | `/rank` for the member view, `/level` for the admin namespace — but if your community comes from Arcane, matching their muscle memory has real value. |
| C2 | Do reward roles come off when someone loses levels? | remove · keep forever ("once earned, always yours") | Configurable toggle, default remove. |
| C3 | **Does XP removal also reduce weekly/monthly XP?| no (an admin correction isn't un-earning) · yes (the boards should reflect reality) | No. |
| C4 | **Should `/rank` reconcile reward roles as a side effect?** Arcane does this. | off (default) · on | Off — a read command silently changing roles is surprising, and it makes `/rank` spam a role-API amplifier. But it's how members self-serve a stuck role. |
| C5 | **Do departed members count toward rank position?| yes, still counted (rank is stable) · no, hidden and excluded (rank improves when people leave) | Count them, label them. Otherwise a member's rank silently improves for reasons unrelated to them. |
| C6 | **Does voice "time" on the leaderboard mean eligible time or total time present?| eligible only · all time present | Eligible only, so the stat matches the XP. But "I was in voice for 6 hours" is what members mean. |
| C7 | **Minimum-members counting rule for voice.** Do muted people count toward the threshold? | count non-deafened humans (mute ignored) · count only fully eligible members | Count non-deafened humans. Requiring full eligibility means two muted friends never enable each other, which is a confusing deadlock. |
| C8 | **Rounding on small boosts.** A +1% boost on 15 XP rounds to 15 — invisible. | round half-up, accept it · track fractional XP · round up when a boost applies | Round half-up. Fractional XP is a column and a lot of explanation for no felt benefit. |
| C9 | **Does XP keep accruing past max level?| yes (leaderboard ordering survives) · no (hard stop) | Yes, accrue. |
| C10 | **Level-up messages: every level, or only levels with a reward?| every level · reward levels only · configurable (default every) | Configurable, defaulting to every level. |
| C11 | **Self-reactions: earn or not?| deny (default) · allow | Deny. |
| C12 | **After `/xp reset server`, the voice/reaction/message leaderboards still show pre-reset activity while XP shows zero.** Is that acceptable, or should stats reset by default too? | preserve stats (Arcane's default, ADR-014) · reset everything by default | Preserve. But it's a visible inconsistency and members will ask — the reset confirmation must say so. |
| C13 | **Should the bot ever DM anyone?** (level-ups, reward notifications) | never · opt-in per member | Never in v1. Rate-limit heavy and widely disliked. |
| C14 | **Retention when the bot is removed from a guild.| 30 days then delete · keep forever · delete immediately | 30 days — long enough to survive an accidental kick, short enough to be defensible. |

---

## D. Implementation traps — read these before writing code

Repeated from `00` §5 because they're easy to lose in a long document:

1. **Interaction deferral within 3 seconds** is a hard constraint on every command handler, not an optimization.
2. **Denormalized display-name snapshots** must be in the schema from day one or departed members render as raw IDs.
3. **`/xp add 500000` crossing 40 levels** must announce once and reconcile once — the naive implementation announces 40 times and issues 40 role calls.
4. **Mass role assignment is a rate-limit event**, so "apply rewards to everyone" is a background job, never an inline command.
5. **A stopped voice tick job silently stops all voice XP** with no error anywhere. This is why `job_last_success_timestamp` is in the health check rather than being nice-to-have.
6. **The domain-layer boundary lint rule is load-bearing.** If it's a warning instead of a CI failure, every testability claim in this spec quietly stops being true within a couple of months.
