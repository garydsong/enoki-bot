# 00 — Product Definition & Arcane Feature Inventory

> Part of the Enoki design spec. Read `README.md` in this folder for the index.
> **Status:** design phase. No code exists. This document is the product reference.

---

## 1. Product Definition

### 1.1 One-line

A self-hostable, multi-guild Discord bot that awards XP for member activity (messages, voice, reactions), turns XP into levels, and turns levels into role rewards — with per-guild configuration, leaderboards, rank cards, and first-class debuggability.

### 1.2 Problem it solves

Discord server operators want a lightweight, legible incentive loop: participation is measured, progression is visible, and status (roles) is earned rather than granted. Arcane.bot is the market reference for this. The two things operators complain about most with existing bots are (a) opaque behavior — "why isn't this person earning XP?" — and (b) paywalled core features (Arcane gates **voice XP entirely behind Premium**). This project targets both: everything is unlocked, and the XP decision pipeline is introspectable by design.

### 1.3 Deployment context (decided)

| Dimension | Decision |
|---|---|
| Audience | **Self-hosted, few guilds** (single operator, ~1–50 guilds) |
| Multi-guild | **Required from day one.** Every row is guild-scoped; nothing global-by-accident. |
| Config surface | **Slash commands in MVP**, but the configuration layer is built as an API-first service so a web dashboard can be added later without rework. |
| Stack | **TypeScript · discord.js v14 · PostgreSQL 16 · Drizzle** (confirmed) — see `07-architecture-and-technology.md` |
| Premium/paid tiers | **Out of scope.** No feature gating, no billing, no tier limits. Where Arcane has a free/premium limit, we substitute a plain configurable limit or no limit. |

### 1.4 Explicit non-goals

Moderation, reaction roles, non-leveling autoroles, custom commands, welcome/goodbye, general logging, counters, YouTube/Twitch notifications, music, tickets, giveaways. The **plugin/module architecture must make these addable later** (see `07`), but none of them are designed or built now.

### 1.5 Design principles

1. **Discord is an adapter, not the application.** Core leveling logic must be testable with zero network.
2. **Deny beats allow; configuration is deterministic.** No ambiguous precedence anywhere.
3. **Every XP decision is explainable.** The engine produces a trace, always.
4. **Derived data is derived.** Level is a function of XP, not an independently mutable field. Rank is a query, not a stored number.
5. **Resets create new buckets; they do not delete history.**
6. **Boring technology.** Complexity must be paid for with a concrete, present benefit.

---

## 2. Arcane Feature Inventory

**Legend**
- **[D]** — Documented behavior, stated on the public docs. Cited.
- **[P]** — Partially documented; the feature exists but a material detail is missing.
- **[U]** — Undocumented / not stated publicly. **We must decide this ourselves.** Never presented as Arcane fact.

Sources: [Leveling overview](https://docs.arcane.bot/plugins/leveling/), [XP Options](https://docs.arcane.bot/plugins/leveling/setup/xp-options), [Levelup Message](https://docs.arcane.bot/plugins/leveling/setup/levelup-message), [Role Rewards](https://docs.arcane.bot/plugins/leveling/setup/role-rewards), [XP Boosters](https://docs.arcane.bot/plugins/leveling/setup/xp-boosters), [XP Restrictions](https://docs.arcane.bot/plugins/leveling/setup/restrictions), [Highlights](https://docs.arcane.bot/plugins/leveling/setup/highlights), [XP Management](https://docs.arcane.bot/plugins/leveling/setup/xp-management), [XP/Level Management](https://docs.arcane.bot/plugins/leveling/management), [Leaderboard](https://docs.arcane.bot/plugins/leveling/setup/leaderboard), [Rank Card](https://docs.arcane.bot/plugins/leveling/card), [Debugging](https://docs.arcane.bot/plugins/leveling/debugging), [Leveling rewrite changelog](https://docs.arcane.bot/changelogs/1-29-2025/), [Command list](https://docs.arcane.bot/core/commands/list).

### 2.1 XP sources

| Feature | Arcane | Ev. |
|---|---|---|
| Message XP | Exists. Two modes: **Random** (roll between min and max per message) and **Per Word** (grants max XP per word of 3+ characters; requires more words than whitespace). Default cooldown **1 minute**. | D |
| Message XP min/max defaults | Numeric defaults not published. | U |
| Reaction XP | Exists. Default cooldown **5 minutes**. Configurable to award for **receiving** reactions on your message, **adding** reactions, or **both**. Changelog states default 25 XP per 5 min. | D |
| Reaction XP: does removing a reaction remove XP? | Not stated. | U |
| Reaction XP: are self-reactions excluded? | Not stated. | U |
| Voice XP | Exists, **Premium-only**. Default cooldown **3 minutes**. "Minimum Members" threshold. A member is only "active" when **unmuted and not deafened**. **Anti-AFK** "automatically starts to lower how much XP is given to members after they have been in a voice channel for multiple hours in one session." | D |
| Voice: does self-mute vs server-mute differ? AFK channel? alone-with-a-bot? | Not stated. | U |
| Voice: how is time accounted across restarts? | Not stated (internal). | U |
| Manual XP | `/xp add`, `/xp remove`, `/xp set xp`, `/xp set level`, `/xp reset server`, `/xp reset member`. Requires **Manage Server**. `/xp set xp` changes "the XP progress for a member's **current level**" — implying Arcane stores level + within-level progress. | D |
| `/xp` limit | Separate from Max Level: a manual ceiling to prevent abuse, **default 100**. Premium raises it dynamically as top members level organically. | D |
| Effort booster | Bonus XP for "longer messages" and "images". Formula not published. | P |

### 2.2 Leveling math

| Feature | Arcane | Ev. |
|---|---|---|
| Curve: Linear (default) | `(level * 100) + 75` | D |
| Curve: Exponential | `5 * (level^2) + (level * 50) + 75` | D |
| Curve: Flat | `1000` | D |
| Global multiplier | Applied as `Formula * Multiplier` | D |
| Custom curve | "Coming in a future update" — not shipped | D |
| Max level cap | Optional; unlimited if unset | D |
| Whether the formula is **XP-to-next-level** or **total-XP-to-reach** | Not stated. The `(level*100)+75` shape and `/xp set xp` semantics strongly imply **XP required to advance from `level` to `level+1`**, but this is inference. | P |
| Rounding of `Formula * Multiplier` | Not stated. | U |
| Multiple level-ups from one XP event | Changelog says XP range customization has "support for multiple level-ups per event." | D |

### 2.3 Restrictions

| Feature | Arcane | Ev. |
|---|---|---|
| No-XP channels (blacklist) | "Members will **not** earn any XP in the channels selected." | D |
| XP channels (whitelist) | "Members will **only** earn XP in the channels selected." | D |
| No-XP roles | Members with these roles cannot earn XP "regardless of channel or message type." | D |
| Threads toggle | Message XP in threads on/off | D |
| Forum posts toggle | Message XP in forum threads on/off | D |
| Voice-channel-text toggle | Messages in voice channels' text on/off | D |
| Slash-command XP toggle | Whether using any bot's slash commands earns XP. **We do not implement this** (decision A12): a Discord app only receives its *own* interactions, so awarding XP for other bots' slash commands is not observable. See `03` §3.3. | D |
| Category-level restrictions | Not documented as a distinct feature (channel selection may or may not include categories). | U |
| Per-user ignore list | Not documented. | U |
| Precedence when whitelist and blacklist both configured | Not stated. | U |
| Precedence between restriction and booster | Not stated. | U |

### 2.4 Boosters

| Feature | Arcane | Ev. |
|---|---|---|
| Role boosters | Yes. Free: 1. Premium: unlimited. | D |
| Channel boosters | Yes. Free: 1. Premium: unlimited. | D |
| Vote reward | Premium. **12-hour, 10% XP boost** for voting on bot lists. A temporary, time-boxed booster. | D |
| Effort booster | Longer messages and images give bonus XP. | P |
| Stacking toggle | "Stack boosters" on → boosts **combined**; off → only the **highest** applies. Worked example: Vote 10% + Role 25% = **35%** stacked, **25%** unstacked. This confirms boosts are **additive bonus percentages over a 1.0 base**, not multiplied factors. | D |
| Booster multiplier ranges / whether negative (nerf) values allowed | Not stated. | U |
| Server-wide multiplier as a booster | Only the curve multiplier is documented; a separate server-wide XP multiplier is not. | U |
| Source-specific multipliers (e.g. 2× voice only) | Not documented. | U |
| Booster interaction with the curve multiplier | Not stated. | U |

### 2.5 Level-up messages

| Feature | Arcane | Ev. |
|---|---|---|
| Destination | Channel where XP was earned, a fixed channel, or disabled. | D |
| Placeholders | `{user.level}`, `{user.xp}` (progress within level, **not total**), `{user.mention}`, `{user.username}`/`{user.name}`, `{user.id}`, `{image}` (level-up graphic), `{earned:text}` (shows earned role rewards, conditional). | D |
| Embeds | Supported. | D |
| Default template | `{user.mention} has reached level **{user.level}**. GG!` | D |
| Advanced tags (conditionals, arrays, choose) | Premium. | D |
| Per-level unique messages | Not documented; appears to be one template + conditionals. | U |
| DM level-ups | Not documented. | U |
| Behavior on multi-level jump | Not documented. | U |

### 2.6 Role rewards

| Feature | Arcane | Ev. |
|---|---|---|
| Stacking on | All qualifying roles are assigned. | D |
| Stacking off | Only the highest earned reward is kept; lower ones are **removed**. | D |
| Assignment triggers | "Arcane only assigns role rewards when members level up, when they run the `/level` command, or rejoin the server." **No mass backfill** when new rewards are configured. | D |
| Debug note | "Arcane does not update roles when members earn xp, only level-ups." | D |
| Limits | Free: 15 total rewards, 1 role per level. Premium: unlimited, 3 per level. | D |
| First Place Role | Auto-assigned to the #1 member; refreshed every 24h (free) or 1h (premium). | D |
| Rewards "every N levels" | **Not offered.** | D (absence) |
| Removal on XP loss / level-down | Not documented. | U |
| Behavior when role is deleted, above bot in hierarchy, or bot lacks Manage Roles | Not documented beyond "needs permissions". | U |

### 2.7 Leaderboards & periodic stats

| Feature | Arcane | Ev. |
|---|---|---|
| Types | Overall XP & Level, Voice Time, Reactions, Weekly XP, Monthly XP. | D |
| `/leaderboard` | Shows top 10 and top 100. | D |
| Web leaderboard | Yes, with **vanity URLs** (`arcane.bot/lb/<vanity>`), first-come-first-served. Reset/removal of departed members is done there. | D |
| Weekly/monthly reset | Resets at **12am UTC**. **"Weekly and monthly leaderboards will only reset if you have the respective notification enabled."** (a quirk, arguably a bug) | D |
| Timezone configurability | Not offered — UTC only. | D (implied) |
| Auto-reset on leave | Optional: automatically reset level/XP of members who leave or are removed. | D |
| Whether weekly/monthly are counters or aggregations | Not stated (internal). | U |
| Whether lifetime XP survives a weekly reset | Implied yes (separate leaderboards) but not stated. | P |

### 2.8 Highlights

| Feature | Arcane | Ev. |
|---|---|---|
| Weekly highlights | Auto-post top 10 most active of the past week to a chosen channel. | D |
| Monthly highlights | Same, monthly. | D |
| Timing | "around 12am UTC" | D |
| Status | Beta | D |
| Ranking metric | XP earned in the period. | D |

### 2.9 Rank cards

| Feature | Arcane | Ev. |
|---|---|---|
| `/card` command | Manages rank card settings; actual customization on the dashboard. | D |
| Background image | 800×200 px. | D |
| Per-server customization | Cards "can be customized for each server". | D |
| Content policy | NSFW backgrounds → permanent blacklist from card customization. | D |
| Exact fields, colors, premium-gated options | Not published. | U |

### 2.10 Debugging

| Feature | Arcane | Ev. |
|---|---|---|
| Automated diagnostic command | **None.** Docs provide a manual checklist only. | D (absence) |
| Required bot permissions for leveling | View Channels/Read Messages, Send Messages, Attach Images. | D |

### 2.11 Command surface

`/level`, `/leaderboard`, `/xp` (Manage Server), `/boosters`, `/rewards`, `/card`. `/xp` is slash-only. — D

---

## 3. Where we deliberately diverge from Arcane

| # | Divergence | Why |
|---|---|---|
| 1 | **Voice XP is a core v1.0 feature, not paid.** | No monetization; voice XP is the single most-requested leveling feature, and Arcane gates it entirely behind Premium. |
| 2 | **No tier limits anywhere** (reward counts, booster counts, per-level role caps). | Replaced with plain configurable limits sized to protect Discord rate limits, not revenue. |
| 3 | **Store canonical `total_xp`, derive level and within-level progress.** | Arcane's `/xp set xp` implies level+progress storage. Total XP makes rank a single indexed sort, makes level always consistent with XP, and makes the curve changeable retroactively. See ADR-001. |
| 4 | **Reward roles are reconciled (desired-set diff), not incrementally granted.** | Arcane's "only on level-up / `/level` / rejoin" model leaves members permanently out of sync after config changes. Reconciliation fixes drift for free and handles level-down. |
| 5 | **Weekly/monthly XP resets are implicit period buckets, never `DELETE`.** | Arcane's "only resets if the notification is enabled" is a coupling bug. Bucketing makes reset a pure function of the clock and preserves history. |
| 6 | **A real debugging command that replays the XP decision pipeline.** | Arcane offers only a prose checklist; this is the highest-leverage differentiator and costs little if the engine is designed for it from the start. |
| 7 | **Configurable week start and guild timezone** for periodic stats. | UTC-only is wrong for most non-US-and-non-EU communities. Low cost if designed in from day one; painful to retrofit. |
| 8 | **`/xp` actions are audit-logged.** | Manual XP is the main admin-abuse vector; Arcane's answer is a limit, which is necessary but not sufficient. |
| 9 | **Rewards "every N levels" is supported.** | Arcane does not offer it; it is trivially expressible in the reward-resolution model and commonly requested. |

---

## 4. MVP / Post-MVP / Future matrix

Sequencing rationale: **MVP** (= v1.0, end of milestone M10) is the smallest set that produces a *coherent, usable leveling bot* — a member can earn XP from messages **and voice**, see their rank, and receive a role. Anything not on that path is deferred. **Post-MVP** items are things a real server will demand within weeks. **Future** items are quality-of-life or scale-driven.

### 4.1 MVP

| Feature | Why MVP |
|---|---|
| Multi-guild bootstrap, guild config CRUD, guild join/leave lifecycle | Nothing works without per-guild config; retrofitting guild scoping is the classic fatal mistake. |
| Message XP (Random mode) with per-source cooldown | The core loop. Per-word mode is a variant, not a prerequisite. |
| Curve engine: linear / exponential / flat + multiplier + max level | Levels are meaningless without a curve; all three are ~30 lines and locking the interface early prevents a rewrite. |
| XP persistence with atomic increment + level derivation | Correctness foundation. Cannot be bolted on. |
| Level-up detection & level-up message (plain + embed, placeholders, destination choice, disable) | The feedback loop; without it members can't tell the bot works. |
| Role rewards: define, stack on/off, reconcile on level change | The actual *point* of a leveling bot for most operators. |
| XP restrictions: no-XP channels, XP-only channels, no-XP roles, ignore bots/webhooks | Without restrictions the bot is unusable in real servers (bot-spam channels). |
| **Voice XP** (sessions, tick crediting, restart recovery, eligibility, anti-AFK) | **Promoted to v1.0 (decision A10).** The largest and only stateful source — persistent sessions, a scheduler, and crash recovery. It lands late in the v1.0 sequence (M9), after the debug tooling that makes its failure modes diagnosable, but a leveling bot without voice XP is not the product. |
| `/rank` (text embed) | Members must be able to see progress. Card rendering deferred. |
| `/leaderboard` lifetime XP, paginated | Second-most-used member command. |
| `/xp add/remove/set/reset` with Manage Server + audit log + `/xp` limit | Operators need an escape hatch on day one; also needed to test. |
| `/level-config` command tree | Configuration surface for everything above. |
| `/level-debug why` (message-XP pipeline trace) | Cheap if built with the engine; enormously expensive to retrofit. Also the primary dev tool. |
| Structured logging, health check, migrations, Docker Compose | Deployment is part of "usable". |
| Domain-layer unit tests | The engine is the product; untested it is a liability. |

### 4.2 Post-MVP

(Voice XP was here; it moved to MVP — see decision A10.)

| Feature | Why deferred, why still important |
|---|---|
| **Reaction XP** (add and/or receive, dedup, self-reaction rules) | Small, but has real abuse surface (reaction farming) that deserves its own design pass. |
| **XP boosters** (role, channel, server-wide, source-specific, temporary) | Multiplies configuration complexity; the precedence rules must be right. The engine reserves the hook from day one (multiplier stage is present but returns 1.0×). |
| **Weekly / monthly XP + those leaderboards** | Needs the period-bucket write path in the same transaction as XP grants — so the *schema* lands in MVP; the queries, resets and commands land here. |
| **Rank cards (image)** | Pure presentation. Rendering is a separate subsystem with its own dependency weight (native canvas, fonts, avatar fetching). `/rank` works as an embed until then. |
| **Activity leaderboards** (voice time, reactions, message count) | Depends on voice/reaction sources existing. |
| **Reward reconciliation backfill job** (throttled mass-sync after config change) | Needs rate-limit-aware job infrastructure; correct-but-slow beats a rate-limit ban. |
| **`/level-debug rewards`** (desired vs actual roles, hierarchy/permission blockers) | Depends on rewards being in production long enough for the failure modes to matter. |
| **Auto-reset on member leave** (configurable) | Destructive; wants an audit trail and a "soft" retention window first. |
| **Per-word message XP mode, effort booster** | Both require the **Message Content privileged intent** — a compliance step, not just code. See `03`. |
| **Highlights** (auto-posted weekly/monthly top 10) | Trivial once periodic stats + a scheduler exist. |
| **First-place role** | Requires a periodic leaderboard job; a nice touch, not core. |
| **XP import from other bots** (MEE6/Arcane/Atlas CSV) | High adoption value for a *migrating* server, zero value for a new one. |

### 4.3 Future / Optional

| Feature | Why |
|---|---|
| Web dashboard + OAuth2 + public leaderboard page with vanity URL | Large second product. The API-first config service in MVP is the hook. |
| Custom curve formula (expression parser) | Arcane hasn't shipped it either. Sandboxing arbitrary expressions is a security project. |
| Per-level custom level-up messages / message templating language with conditionals | Config complexity; the placeholder set covers 95%. |
| DM level-up notifications | Rate-limit heavy, frequently unwanted, easy to add later. |
| XP decay / inactivity penalties | Divisive product decision; needs a scheduler and a lot of policy. |
| Seasons (archive a leaderboard, reset to zero, keep history) | Natural extension of period buckets, but needs UX. |
| Prestige / level rebirth | Niche. |
| Achievements / badges | A separate product. |
| Sharding, Redis, multi-process | Only at ~2,000+ guilds. See `08` §Scalability. Not needed for the stated deployment. |
| Additional plugins (moderation, welcome, etc.) | Explicitly out of scope; architecture must merely permit them. |
| GraphQL/REST public API for third parties | Speculative. |

---

## 5. Implementation traps (all decided — see `11`)

These change the MVP, not just later work. All are now decided; they are repeated in `11` §D as a pre-coding checklist because they are easy to lose in a long document.

1. **The Message Content privileged intent.** Per-word XP mode, the effort booster (message length), and any anti-spam that inspects text all require it. Without it the bot only sees message *metadata*. Self-serve in the Developer Portal below Discord's **10,000-unique-user** threshold (raised from the old 100-server rule in June 2026); above it, a formal application plus **annual reapplication**. Given "self-hosted, few guilds," this is available — but the architecture should treat message content as an *optional capability* so the bot degrades gracefully rather than breaking. (**Arcane necessarily has this intent** to implement per-word mode.)
2. **The `GuildMembers` privileged intent** is required to reliably know a member's roles for role-based restrictions/boosters and to handle rejoin reconciliation. Same 10,000-user threshold. This one is effectively mandatory.
3. **Interaction deferral.** Discord requires an interaction response within 3 seconds. Rank card rendering and leaderboard queries must `deferReply()` first. This is a hard architectural constraint on every command handler.
4. **Denormalized username/avatar snapshots.** Leaderboards must render members who have left the guild or who are not in the member cache. Without a stored display-name snapshot, entries render as raw IDs. Cheap to add up front, painful later.
5. **Level-up announcement storms.** `/xp add 500000` will cross dozens of levels. Announce **once, for the final level**, and give manual XP a `silent` option. Similarly, reward reconciliation after a big grant must apply the final desired role set, not walk each level.
6. **Data deletion / GDPR.** A member (or guild) may ask for their data to be erased. A `/xp forget` (member-initiated, self-scoped) and a documented guild-wipe path cost little now.
7. **Message edits and deletes.** Should XP be clawed back if a message is deleted? Arcane does not document this. Recommendation: **no clawback** (see `04` §Duplicate & retraction handling) — but it is a product preference.
8. **The `{image}` level-up graphic** is a second rendering surface distinct from rank cards. Deferring it does not block level-up messages.
9. **Discord's per-guild role assignment rate limits** make "reward everyone retroactively" a background job, not a command that runs inline.
10. **Clock/DST correctness** for weekly/monthly boundaries once timezones are configurable — periods must be computed in the guild's zone and stored as UTC instants.

---

## 6. Requirement challenges

Where the brief implies complexity I do not think is justified:

| Requested | Challenge | Recommendation |
|---|---|---|
| "Multiple bot instances processing events" (§14 of brief) | For 1–50 guilds a single process handles this comfortably; multi-instance requires Redis, distributed locks, and shard coordination. | Design for **single-writer**, with idempotency keys and DB-level atomicity that *remain correct* if a second instance appears. Do not build coordination now. Documented migration point in `08`. |
| "Category restrictions" as a separate feature | A category is a channel with children. Modeling it as its own restriction type doubles the config surface. | One `restriction_target` table with a `target_type` of `channel \| category \| role \| user`; resolution walks thread → parent channel → category. Same code path. |
| "Included channels" (whitelist) *and* "excluded channels" (blacklist) both configurable | Two overlapping mechanisms cause the #1 Arcane support issue by their own admission. | Keep both (parity), but define precedence unambiguously (whitelist evaluated first as a gate, blacklist can still deny inside it) and have `/level-config` **warn** when both are populated. |
| "Configuration/audit history" as a full entity | Full config versioning is a large feature. | MVP: append-only `audit_log` of *actions* (who changed what setting to what, who granted XP). Not full snapshots/rollback. |
| Separate leaderboards for voice time, reactions, messages, XP, level | Five leaderboards = five index strategies. | One `member_stats` row per member with counters, and a leaderboard query parameterized by a sort column. One code path, four indexes. |
| Redis in MVP | Not needed at this scale, and it turns a one-container deploy into two. | In-process cache with an interface that Redis can implement later. ADR-009. |
