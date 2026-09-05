# 03 — Discord Event Inventory & Slash-Command Specification

---

## 1. Gateway intents

| Intent | Required? | Privileged? | Why |
|---|---|---|---|
| `Guilds` | **Yes** | No | Guild/channel/role caches; `GUILD_CREATE`/`DELETE`; role and channel lifecycle. Nothing works without it. |
| `GuildMessages` | **Yes** | No | Message XP. Delivers message events **without content**. |
| `MessageContent` | **Conditional** | **Yes** | Only needed for per-word mode, `min_message_length`, and the effort booster. The bot must run correctly without it and disable those features with a clear warning. Self-serve below 10,000 users (§1.1). |
| `GuildMembers` | **Yes** | **Yes** | Reliable member role data (role-based restrictions and boosters), `GUILD_MEMBER_ADD` for rejoin reconciliation, and resolving members for leaderboards/rewards. Without it, role checks depend on an incomplete cache and are wrong. Self-serve below 10,000 users (§1.1). |
| `GuildVoiceStates` | Post-MVP | No | Voice XP. Also required to receive the initial voice state snapshot on `GUILD_CREATE` for restart recovery. |
| `GuildMessageReactions` | Post-MVP | No | Reaction XP. |
| `GuildPresences` | **No** | Yes | We never need online status. Explicitly excluded — it is the heaviest intent and a common thoughtless inclusion. |
| `DirectMessages`, `GuildInvites`, `GuildIntegrations`, `GuildWebhooks`, `GuildScheduledEvents`, `AutoModeration*` | **No** | No | No leveling use. |

**Design rule:** intents are computed at boot from enabled features, and `/level-debug health` reports the delta between required and granted.

### 1.1 Privileged intent access policy (current as of September 2026)

Discord offers exactly **three** privileged intents: `GuildPresences`, `GuildMembers`, and `MessageContent`. As of **11 June 2026** the access rule changed:

| | |
|---|---|
| **Threshold** | **Fewer than 10,000 unique users** across all installs → all three are self-serve toggles in the Developer Portal, no application needed. (This replaced the older "under 100 servers" rule.) |
| **At or above 10,000 users** | A formal application is required. Discord notifies you and gives **90 days** to submit it. |
| **Annual reapplication** | Apps holding privileged intents must **reapply once per year** to confirm continued access, with the same 90-day window. |
| **Scope** | The threshold is identical for all three — there is no per-intent difference. |

What each grants:

| Intent | Grants |
|---|---|
| `GuildMembers` | Member join/leave/update events, and the ability to list all members of a guild |
| `MessageContent` | The `content`, `embeds`, `attachments`, `components` and `poll` fields on message objects |
| `GuildPresences` | Online/offline status, activities, platform info |

**Consequences for this project.** At the stated scale (self-hosted, ~1–50 guilds), all three are available immediately with a portal toggle. Two design implications survive regardless of scale:

1. **`MessageContent` is modeled as an optional capability**, not an assumption. Per-word mode, `min_message_length`, and the effort booster check for it at boot and self-disable with a warning if absent. This protects against the *annual reapplication* risk as much as the growth threshold — an app that misses a reapplication window loses access while still running.
2. **`GuildPresences` is never requested**, which keeps the app off the review path for the one intent it has no use for and avoids the heaviest event stream on the gateway.

Sources: [Changes to Privileged Intent Access for Discord Apps](https://support-dev.discord.com/hc/en-us/articles/40281523410967-Changes-to-Privileged-Intent-Access-for-Discord-Apps) · [Getting Started with Privileged Intent Review](https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review)

## 2. Bot permissions

| Permission | Scope | Why |
|---|---|---|
| View Channels | required | To receive message/voice events at all |
| Send Messages | required | Level-up messages, command responses |
| Embed Links | required | Embeds |
| Attach Files | post-MVP | Rank cards, level-up graphic |
| Read Message History | optional | Only if we ever fetch a message for reaction-receive attribution when it isn't cached |
| Manage Roles | required for rewards | Role grants/removals |
| Send Messages in Threads | required if thread XP enabled | Level-up messages inside threads |
| Use External Emojis | optional | Cosmetic |

Never request Administrator.

---

## 3. Event inventory

Events are classified **Consume** (drive behavior), **Observe** (maintain cache/consistency), or **Reject** (explicitly not used, with reason).

### 3.1 Consume

| Event | Used for | Notes / hazards |
|---|---|---|
| `MESSAGE_CREATE` | Message XP | Filter: `guild_id` present, author not bot/webhook (`webhook_id` set ⇒ reject), message `type` in an allowlist (`DEFAULT`, `REPLY` only — reject joins, pins, boosts, thread-created system messages). Content may be empty without the intent. |
| `INTERACTION_CREATE` | All slash commands (ours only — see §3.3 on slash-command XP) | Discord delivers an app only its *own* interactions. |
| `VOICE_STATE_UPDATE` | Voice session open/close/mutate | Fires for join, leave, channel move, mute/deaf/self-mute/self-deaf, stream/video start. One event per state change per user; a channel move is a single event with a new `channel_id`. |
| `MESSAGE_REACTION_ADD` | Reaction XP (add and receive) | `message_author_id` is **not** on the payload in all cases — the message may need fetching or the cached message used; requires Read Message History for uncached fetches. Reactions on very old messages are common. |
| `GUILD_MEMBER_ADD` | Rejoin: restore reward roles per stored level | Also the point at which auto-reset-on-leave data would already be gone. |
| `GUILD_CREATE` | Guild join/availability; seed config row; snapshot voice states for recovery | Fires both on real join and on reconnect/availability — must be idempotent, and must distinguish `unavailable` transitions. |
| `GUILD_DELETE` | Bot removed or guild deleted | Start the retention timer; stop jobs for that guild. `unavailable: true` means an outage, **not** a removal — do not delete data. |
| `READY` / `RESUMED` | Startup reconciliation; distinguishing a fresh session from a resumed one | Only run heavy reconciliation on `READY` after a fresh identify, not on every `RESUMED`. |

### 3.2 Observe (cache/consistency, no XP)

| Event | Used for |
|---|---|
| `GUILD_ROLE_UPDATE` / `GUILD_ROLE_DELETE` | Invalidate reward/booster/restriction validity; mark a reward as broken when its role is deleted; detect hierarchy changes affecting assignability |
| `CHANNEL_DELETE` | Mark restriction/booster/notification targets as dangling; if the level-up channel is deleted, flag it in health |
| `CHANNEL_UPDATE` | Category re-parenting changes restriction resolution; invalidate the channel→category cache |
| `THREAD_CREATE` / `THREAD_DELETE` | Maintain the thread→parent map used by restriction resolution (or resolve lazily from the channel cache) |
| `GUILD_MEMBER_UPDATE` | Role changes invalidate that member's cached booster/restriction verdict; nickname change updates the display-name snapshot |
| `GUILD_MEMBER_REMOVE` | Auto-reset-on-leave; mark the leaderboard entry as departed |
| `GUILD_UPDATE` | Guild name snapshot for `{server.name}` |

### 3.3 Reject — and why

| Event | Why not |
|---|---|
| `MESSAGE_UPDATE` | We do not claw back or top up XP on edits. XP was earned for the act of participating. Consuming edits invites "edit a message 100 times" abuse and adds no value. (Arcane does not document any edit behavior.) |
| `MESSAGE_DELETE` / `MESSAGE_DELETE_BULK` | No XP clawback. Clawback would make moderation (purging spam) silently alter the leaderboard, would require storing message→XP attribution for every message (a large, privacy-heavy table), and produces confusing negative level movement. **Recommended: never claw back.** Flagged as a product preference in `11`. |
| `MESSAGE_REACTION_REMOVE` | Removing a reaction does not remove XP. Consuming it would let a user farm by add/remove loops if paired incorrectly, and the dedup key (see `04`) already prevents re-earning. We do not need the event at all. |
| `MESSAGE_REACTION_REMOVE_ALL` / `_EMOJI` | Same reasoning. |
| Slash-command usage as an XP source | Arcane documents a toggle for "XP from using any bot's slash commands", but Discord delivers `INTERACTION_CREATE` **only for our own app's interactions** — another bot's commands are invisible to us. The nearest observable proxy is a `MESSAGE_CREATE` of type `CHAT_INPUT_COMMAND`, which is inconsistent across clients and command types. Rather than ship a setting that silently half-works, **we do not implement this at all** (decision A12) and the setting is absent from the config schema. |
| `TYPING_START` | Not an activity signal we reward; extremely high volume. |
| `PRESENCE_UPDATE` | Requires a privileged intent for zero leveling value. |
| `GUILD_BAN_ADD` | Banning is not a leveling action. If an admin wants the data gone, that's `/xp reset member`. |
| `VOICE_SERVER_UPDATE`, `STAGE_INSTANCE_*` | We track voice *state*, not media routing. Stage speakers are ordinary voice states. |
| `GUILD_AUDIT_LOG_ENTRY_CREATE` | We keep our own audit log; Discord's is not needed and requires View Audit Log. |

### 3.4 Event hazards to design around

1. `GUILD_CREATE` arrives on every reconnect — all handling must be upsert-shaped.
2. Discord may redeliver events after a resume; every XP-granting path needs an idempotency key (§`04`).
3. `MESSAGE_REACTION_ADD` for an uncached message requires an API fetch — do this **once**, cache the author ID keyed by message ID with a bounded LRU, and if the fetch fails, skip receive-XP rather than retry.
4. `VOICE_STATE_UPDATE` for a channel move is one event, not leave+join — the session handler must treat it as a mutation.
5. A guild becoming `unavailable` (Discord outage) must not be mistaken for a removal.
6. Shard resume gaps mean voice state can silently drift; startup reconciliation is mandatory, not optional.

---

## 4. Slash-command surface

### 4.1 Design rules

- **Four top-level commands.** Discord's UI degrades past ~5–6 top-level commands per app, and grouping keeps permissions coherent: `/rank`, `/leaderboard`, `/xp`, `/level`.
- `/level` is the **admin namespace** (config + rewards + boosters + restrictions + debug) with `default_member_permissions = ManageGuild`. `/xp` is separate because Arcane users expect it and it is the highest-risk surface.
- `/rewards`, `/boosters`, `/card` are subcommands of `/rank` rather than top-level, because they are all "things about my progression" — with the exception noted below.
- Discord's limit: 25 subcommands or groups per command, 25 options per subcommand, 25 choices per option. `/level config` will exceed 25 settings, so config uses a **`setting` autocomplete option + a `value` option** rather than one subcommand per setting.
- Every handler re-checks permissions server-side (NFR-AR-2).
- Anything that may exceed ~2s (rendering, leaderboard queries, backfills) calls `deferReply()` **first**.
- All responses default to ephemeral for admin commands; member commands are public with an `ephemeral` option.

### 4.2 `/rank` — member progression

| Sub | Purpose | Options | Perms | Response | Validation | Edge cases |
|---|---|---|---|---|---|---|
| `/rank` (root) | Show a member's level, progress, rank | `member?` (User), `ephemeral?` (Bool) | none | Public embed (MVP) → rank card image (post-MVP) with text fallback | target must be in-guild or have data; leveling must be enabled | Target never earned XP → "no XP yet, rank —"; target is a bot → refuse; target left the guild → render from snapshot with a note; render failure → text embed |
| `/rank card` | Configure own rank card | `background?` (Attachment or URL), `accent?` (String hex), `reset?` (Bool) | none | Ephemeral preview | hex format; image ≤ 2 MB, PNG/JPG/WEBP, ≥800×200; HTTPS only, allow-listed hosts | Guild disabled member customization → refuse with reason; SSRF-shaped URL → refuse |
| `/rank rewards` | List role rewards and my progress | `ephemeral?` | none | Embed of level → roles, with "you have"/"next at level N" | — | No rewards configured → helpful empty state; deleted roles omitted |
| `/rank boosters` | Show active boosters and my effective multiplier | `channel?` (to preview a channel's multiplier), `ephemeral?` | none | Embed listing server/role/channel/temporary bonuses and the resulting multiplier | — | Excluded role/channel → shows "you earn no XP here" rather than a multiplier |

> **Alternative considered:** keep Arcane's `/rewards`, `/boosters`, `/card` as top-level commands for familiarity. That is 7 top-level commands. **Recommendation:** nest under `/rank`, and optionally register `/rewards`, `/boosters`, `/card` as thin top-level aliases if user familiarity proves to matter. Flagged in `11` as a product preference.

### 4.3 `/leaderboard` — rankings

| Sub | Purpose | Options | Perms | Response | Validation | Edge cases |
|---|---|---|---|---|---|---|
| `/leaderboard` (root) | Ranked list | `metric?` choice: `xp`(default) \| `level` \| `weekly` \| `monthly` \| `voice` \| `reactions` \| `messages`; `page?` (Int ≥1); `me?` (Bool — jump to my page); `ephemeral?` | none | Deferred, paginated embed with prev/next/jump buttons (components v2), 10 per page | page within range; metric must be an enabled source | Empty guild → empty state; page beyond end → clamp to last page; departed members labeled or hidden per config; **keyset pagination** so concurrent XP writes don't duplicate/skip rows; button interactions expire after 5 min and disable |

Rationale for one command with a `metric` option rather than `/leaderboard voice`, `/leaderboard weekly`, …: identical query shape, identical rendering, one code path, and it keeps future metrics from consuming subcommand slots.

### 4.4 `/xp` — XP administration

`default_member_permissions = ManageGuild`, `dm_permission = false`. Every subcommand writes an audit entry.

| Sub | Purpose | Options | Perms | Response | Validation | Edge cases |
|---|---|---|---|---|---|---|
| `/xp add` | Grant XP | `member` (User, req), `amount` (Int, req), `reason?` (Str ≤200), `silent?` (Bool, default false) | ManageGuild (or owner-only if configured) | Ephemeral: before/after level & total | `1 ≤ amount ≤ manual_grant_max`; resulting level ≤ `manual_xp_level_limit` unless owner; target not a bot | Multi-level jump → single announcement at final level; target has no row → create; `disable_resets` unrelated |
| `/xp remove` | Deduct XP | same as add | same | same | amount ≥ 1 | Floor at 0 total XP; level-down triggers reward removal if configured; no announcement |
| `/xp set xp` | Set XP progress within the current level | `member`, `amount` (Int ≥0), `reason?` | same | same | `amount < xpForLevel(currentLevel)` else suggest `set level` | Arcane-parity semantics; documented as "within-level progress", implemented as `totalXpToReach(level) + amount` |
| `/xp set total` | Set absolute lifetime XP | `member`, `amount` (Int ≥0), `reason?` | same | same | ≤ total for `manual_xp_level_limit` | Our addition; unambiguous and the one an importer/scripter wants |
| `/xp set level` | Set level directly | `member`, `level` (Int ≥0), `keep_progress?` (Bool) | same | same | ≤ `manual_xp_level_limit`; ≤ `max_level` warn | Sets total XP to that level's threshold; lossy — warned in the response |
| `/xp reset member` | Wipe one member | `member`, `stats?` (Bool, default false), `roles?` (Bool, default false) | same; blocked by `disable_resets` | Confirmation button then result | — | Removing roles is throttled; irreversible warning |
| `/xp reset server` | Wipe the guild | `stats?`, `roles?` | **Owner** by default | Two-step confirm naming the guild, 60s expiry | `disable_resets` blocks | Runs as a background job for large guilds; only one at a time |
| `/xp import` | Import from CSV | `file` (Attachment), `mode` choice `replace \| add`, `dry_run?` (Bool, default true) | Owner | Deferred; dry-run summary then confirm | CSV ≤ 5 MB, ≤ 100k rows, columns validated, IDs must be snowflakes | Unknown user IDs are recorded but not created as members; partial failures reported, transactional per batch |

### 4.5 `/level` — configuration, rewards, restrictions, boosters, debug

`default_member_permissions = ManageGuild`, `dm_permission = false`.

**Group `/level config`**

| Sub | Options | Notes |
|---|---|---|
| `set` | `setting` (Str, **autocomplete** over the setting registry), `value` (Str) | One handler; the setting registry carries type, bounds, parser, and validation message. Avoids the 25-subcommand ceiling and means adding a setting requires no new command. |
| `view` | `section?` choice: `curve \| sources \| restrictions \| rewards \| boosters \| notifications \| periods \| admin` | Renders current values with defaults marked |
| `reset` | `setting?` — omit to reset the whole config | Confirmation required for whole-config reset |
| `enable` / `disable` | — | Master switch for the leveling module in this guild |
| `preview-levelup` | `level?` | Renders the level-up message in the invoking channel without granting XP |
| `curve-preview` | `curve`, `multiplier?`, `max_level?` | Shows, for the current member distribution, how levels would change if applied — **without applying**. Directly serves US-4. |

**Group `/level rewards`**

| Sub | Options | Validation / edges |
|---|---|---|
| `add` | `level` (Int 1–`max_level`), `role` (Role), `remove_lower?` | Refuse `@everyone`, managed/integration roles, roles ≥ bot's top role; refuse if the bot lacks Manage Roles; warn if the role is also a no-XP role |
| `add-recurring` | `every` (Int ≥1), `start_level` (Int), `role` | Post-MVP; refuse overlaps that would produce >N roles at one level |
| `remove` | `level`, `role?` (omit = all roles at that level) | Asks whether to strip the role from members who currently hold it |
| `list` | — | Flags broken entries (deleted role, hierarchy problem) inline |
| `backfill` | `confirm` (Bool) | Post-MVP. Deferred, throttled background job with a progress-updating message; one per guild |
| `first-place` | `role?` (omit = disable) | Post-MVP |

**Group `/level restrict`**

| Sub | Options |
|---|---|
| `channel` | `action` choice `deny \| only \| clear`, `channel` (Channel — accepts categories, text, voice, forum) |
| `role` | `action` choice `deny \| clear`, `role` |
| `user` | `action` choice `ignore \| clear`, `member` |
| `list` | — (also renders the effective precedence and warns on contradictions) |

**Group `/level boost`** *(post-MVP)*

| Sub | Options |
|---|---|
| `role` | `role`, `bonus_percent` (Int −100..1000), `remove?` |
| `channel` | `channel`, `bonus_percent`, `remove?` |
| `server` | `bonus_percent` |
| `temporary` | `scope` choice `server \| role \| channel \| member`, `target?`, `bonus_percent`, `duration` (Str, e.g. `12h`) |
| `stacking` | `mode` choice `stack \| highest` |
| `list` | — |

**Group `/level debug`**

| Sub | Purpose | Options | Response |
|---|---|---|---|
| `why` | Dry-run the XP pipeline | `member`, `channel?`, `source?` choice `message \| voice \| reaction_add \| reaction_receive` | Ordered gate-by-gate trace with verdicts and reasons; shows cooldown remaining; **awards nothing, consumes nothing** |
| `rewards` | Desired vs actual roles | `member` | Diff plus per-role blocking reason; optional "retry now" button |
| `health` | System sanity | — | Intents granted vs required, channel/role permission problems, dangling config targets, DB latency, job last-run times, version/commit |
| `member` | Raw stored state | `member` | Total XP, level, per-source stats, period buckets, cooldown state, last events — the "what does the DB actually say" view |

### 4.6 Commands deliberately **not** created

| Not created | Why |
|---|---|
| `/level` as a member alias for `/rank` | One concept, one command. (Arcane uses `/level`; we use `/rank`, which is the more common convention across MEE6/Atlas/Amari. Flagged as a preference in `11`.) |
| `/setxp`, `/addxp`, `/resetxp` as separate top-level commands | Fragmented namespace; `/xp` subcommands cover it |
| `/levelup-message`, `/xp-cooldown`, one command per setting | Ceiling on subcommands; `/level config set` with autocomplete is strictly better |
| `/stats` | Overlaps `/rank` and `/leaderboard` |
| Context-menu (right-click) commands | Adds surface for no new capability in MVP; a "View rank" user-context command is a cheap Future addition |
| Prefix/message commands | Requires the Message Content intent purely for command parsing; slash-only avoids the compliance dependency (Arcane also makes `/xp` slash-only) |

### 4.7 Cross-cutting command behavior

- **Deferral:** `/rank` (card), `/leaderboard`, `/xp import`, `/xp reset server`, `/level rewards backfill`, `/level config curve-preview` defer immediately.
- **Autocomplete:** setting names, timezones, existing reward levels, existing booster targets.
- **Component lifetime:** paginator buttons carry `(guildId, metric, cursor, invokerId)` in the custom ID; another user pressing them gets an ephemeral "run the command yourself" rather than hijacking the message.
- **Error surface:** every handler catches, logs with a correlation ID, and replies with a short user-facing message plus that ID. Never leak stack traces.
- **Command registration:** guild-scoped registration in development (instant), global registration in production (1-hour propagation). Registration diffing so an unchanged command set is not re-uploaded on every boot.
