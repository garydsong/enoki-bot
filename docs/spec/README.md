# Enoki — Design Specification

*(A self-hostable Discord leveling bot. The name is Enoki; the spec predates it and refers to "the bot" throughout.)*

**Status: ✅ APPROVED — ready to scaffold (2026-09-04).** No code written yet. Every blocking question is answered, all 16 ADRs are **Accepted**, and every default is adopted. `11-open-questions.md` is now the decisions log.

**A coding agent implementing this should treat the spec as settled** and build to it, starting at milestone M0 in `10-implementation-roadmap.md`. If something here proves wrong in practice, raise it and record a superseding ADR — do not silently deviate.

**Project:** A self-hostable, multi-guild Discord leveling bot inspired by [Arcane.bot's Leveling plugin](https://docs.arcane.bot/plugins/leveling/), architected so additional bot modules can be added later without touching the leveling system.

---

## How to read this

**If you're a coding agent about to scaffold this:** read all of it, in order. Start with `11` (every decision, settled) and `09` (why). Then `10` is your execution sequence — work milestone by milestone and do not skip ahead. `06` and `07` §3 define what you build. `04` is the part that must be exactly right; its verified numbers in §4.3 are a test contract. `11` §D lists the traps.

**If you're the project owner returning to this:** `11` is the decisions log. `00` §3–§6 covers where we diverge from Arcane and why. `10` is the plan.

---

## Contents

| Doc | Contains | Brief's deliverables |
|---|---|---|
| [`00-product-and-feature-inventory.md`](00-product-and-feature-inventory.md) | Product definition · Arcane feature inventory with documented/undocumented flags · deliberate divergences · MVP / post-MVP / future matrix with rationale · things you overlooked · requirement challenges | 1, 2, 3 |
| [`01-requirements.md`](01-requirements.md) | Functional · configuration (with every setting and default) · administrative · member · background/system · non-functional requirements | 4, 5 |
| [`02-user-stories.md`](02-user-stories.md) | 40 user stories with acceptance criteria, plus explicitly out-of-scope stories | 6 |
| [`03-discord-surface.md`](03-discord-surface.md) | Intents · permissions · event inventory (consume / observe / **reject with reasons**) · full slash-command specification · commands deliberately not created | 7, 8 |
| [`04-xp-engine-and-mathematics.md`](04-xp-engine-and-mathematics.md) | The four separated layers · the 14-gate pipeline · restriction & booster precedence with the worked example · leveling math with verified closed forms · cooldowns · idempotency · per-source specs · **voice XP design** | 9, 10, 11, 12 |
| [`05-rewards-leaderboards-cards.md`](05-rewards-leaderboards-cards.md) | Role reward reconciliation model & failure handling · leaderboard architecture & the period-bucket reset design · timezone behavior · rank card subsystem | 13, 14, 15 |
| [`06-data-model.md`](06-data-model.md) | 14 entities with fields, relationships, constraints, indexes · guild isolation rules · **the hot-path write** · what we deliberately don't store · retention | 16 |
| [`07-architecture-and-technology.md`](07-architecture-and-technology.md) | Layered architecture & enforced dependency rules · plugin seam · project structure · technology recommendations with alternatives · concurrency & data integrity · caching strategy | 17, 18, 19, 24, 25 |
| [`08-operations-security-testing-scale.md`](08-operations-security-testing-scale.md) | Abuse vectors (technical vs configurable vs policy) · 53-row failure/edge-case matrix · observability & the decision trace · testing strategy · scalability at 10/100/1k/10k guilds with migration points | 20, 21, 22, 23, 26 |
| [`09-adrs.md`](09-adrs.md) | 16 architecture decision records, **all Accepted** | 27 |
| [`10-implementation-roadmap.md`](10-implementation-roadmap.md) | 16 milestones with goal, functionality, dependencies, DB changes, tests, definition of done · **v1.0 ends at M10** · dependency graph · why this order differs from the brief's | 28 |
| [`11-open-questions.md`](11-open-questions.md) | **Decisions log** — every architecture, default and product-behavior decision, with the reasoning retained · implementation traps | 29 |

---

## The decisions this spec locks in (all approved)

| | |
|---|---|
| **Stack** | TypeScript · discord.js v14 · PostgreSQL 16 · Drizzle · Zod · Pino · Vitest · `@napi-rs/canvas` · Docker Compose. No Redis. **(confirmed)** |
| **XP storage** | One canonical `total_xp`; level, progress and rank all derived. |
| **Leveling curve** | Arcane's three formulas read as per-level widths; precomputed cumulative table + binary search. |
| **Precedence** | Eligibility (boolean) strictly before amount (arithmetic). Restrictions always beat boosters. Blacklist beats whitelist. |
| **Voice XP** | **In v1.0 (milestone M9).** Persistent sessions, 3-minute tick crediting, end-of-session flush, startup reconciliation. Crash loss ≤ one tick. |
| **Weekly/monthly** | Period-keyed buckets. A "reset" is the clock advancing, not a job. Nothing is ever deleted. |
| **Role rewards** | Desired-set reconciliation, not incremental grants. Only roles we own are ever removed. |
| **Architecture** | Modular monolith. `domain` imports nothing. Boundary rule enforced in CI. Leveling is itself a plugin. |
| **Debuggability** | Every XP evaluation produces a decision trace. `/level debug why` replays the pipeline as a dry run. |

## What is deliberately not built

No XP clawback on message deletion. No per-message XP ledger. No Redis, sharding, or multi-process coordination. No prefix commands. No premium tiers or feature gating. **No XP for slash-command usage** — Discord does not let an app observe other bots' interactions. No moderation, welcome, reaction roles, or any other Arcane plugin.

---

## Sources

Arcane documentation reviewed for the feature inventory:
[Leveling](https://docs.arcane.bot/plugins/leveling/) · [XP Options](https://docs.arcane.bot/plugins/leveling/setup/xp-options) · [Levelup Message](https://docs.arcane.bot/plugins/leveling/setup/levelup-message) · [Role Rewards](https://docs.arcane.bot/plugins/leveling/setup/role-rewards) · [XP Boosters](https://docs.arcane.bot/plugins/leveling/setup/xp-boosters) · [XP Restrictions](https://docs.arcane.bot/plugins/leveling/setup/restrictions) · [Highlights](https://docs.arcane.bot/plugins/leveling/setup/highlights) · [XP Management](https://docs.arcane.bot/plugins/leveling/setup/xp-management) · [XP/Level Management](https://docs.arcane.bot/plugins/leveling/management) · [Leaderboard](https://docs.arcane.bot/plugins/leveling/setup/leaderboard) · [Rank Card](https://docs.arcane.bot/plugins/leveling/card) · [Debugging](https://docs.arcane.bot/plugins/leveling/debugging) · [Leveling rewrite changelog](https://docs.arcane.bot/changelogs/1-29-2025/) · [Command list](https://docs.arcane.bot/core/commands/list)

Every claim about Arcane in this spec is tagged **[D]** documented, **[P]** partially documented, or **[U]** undocumented (our decision). No claim is made about Arcane's internal implementation.
