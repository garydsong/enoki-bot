# 02 — User Stories & Acceptance Criteria

Personas: **Owner** (guild owner), **Admin** (Manage Server), **Member**, **Operator** (the person self-hosting the bot).

Format: `US-n` · story · **AC** where the story is non-obvious or has real edge cases. Stories without AC are mechanically simple.

---

## A. Setup & configuration (Admin/Owner)

**US-1** — As an Admin, I want to enable leveling in my server so members start earning XP.
- **AC1** Before enabling, no XP is recorded for any event in that guild.
- **AC2** Enabling creates a guild config row with documented defaults and requires no other input.
- **AC3** The response tells me which permissions/intents are missing, if any, and what will not work as a result.
- **AC4** Enabling does not retroactively award XP for past activity.

**US-2** — As an Admin, I want to choose how much XP a message is worth so I can tune progression speed.
- **AC1** I can set `min` and `max`; `min > max` is rejected with a clear message.
- **AC2** Negative values and values above the per-event cap are rejected.
- **AC3** The change takes effect for the very next eligible message, with no restart.
- **AC4** The response shows a worked example: "a member sending ~30 messages/day will reach level 10 in about N days."

**US-3** — As an Admin, I want to set a message XP cooldown so chat spam doesn't equal fast levels.
- **AC1** Within the cooldown, further messages are ignored for XP and the cooldown is **not** extended (a sliding window would let spam suppress a member's own earning; fixed window from last award).
- **AC2** Setting the cooldown to 0 is allowed but warns.

**US-4** — As an Admin, I want to pick the leveling curve so progression matches my community's size.
- **AC1** Changing the curve does **not** change anyone's total XP.
- **AC2** Changing the curve **does** immediately change everyone's displayed level, and the command warns me of this with a preview ("your top member goes from level 42 to level 28").
- **AC3** After a curve change, reward roles are out of sync until reconciliation; the command offers to run a backfill.

**US-5** — As an Admin, I want to cap the maximum level so progression has an endpoint.
- **AC1** A member at max level still accrues total XP (for leaderboard ordering) but their level stops.
- **AC2** No level-up messages fire at or above the cap.

**US-6** — As an Admin, I want to prevent certain channels from giving XP.
- **AC1** Adding a **category** applies to all its current and future children.
- **AC2** A thread inherits its parent channel's restriction status.
- **AC3** Messages in a blacklisted channel produce a decision trace with reason `channel_blacklisted`, and no cooldown is consumed.

**US-7** — As an Admin, I want XP to only be earnable in specific channels.
- **AC1** With a non-empty whitelist, all other channels deny.
- **AC2** If a channel appears in **both** the whitelist and blacklist, the blacklist wins, and the config command warns me at the moment I create the contradiction.
- **AC3** Emptying the whitelist restores "everywhere except blacklist" behavior.

**US-8** — As an Admin, I want certain roles never to earn XP (e.g. muted, bots-with-user-accounts, staff).
- **AC1** Holding **any** no-XP role denies, regardless of other roles held.
- **AC2** A no-XP role always beats a booster role.

**US-9** — As an Admin, I want members to receive roles automatically at certain levels.
- **AC1** I can map one level to multiple roles.
- **AC2** The command refuses roles the bot cannot assign (above its highest role, managed/integration roles, `@everyone`) and says exactly why.
- **AC3** After adding a reward, existing members at or above that level do **not** silently receive it; I am told this and offered a backfill.

**US-10** — As an Admin, I want to choose whether reward roles stack or replace.
- **AC1** In `highest` mode, crossing into a higher reward removes lower reward roles in the same operation.
- **AC2** In either mode, roles that are not configured rewards are never touched.

**US-11** — As an Admin, I want to give bonus XP in specific channels or to specific roles.
- **AC1** Bonuses are expressed as percentages; the command shows the resulting effective multiplier.
- **AC2** With stacking on, bonuses add (25% + 10% = 35%); with stacking off, only the largest applies.
- **AC3** A member in an excluded channel gets nothing regardless of boosters.

**US-12** — As an Admin, I want to customize the level-up message.
- **AC1** Placeholders render correctly, including for members with no nickname and with markdown-special characters in their names.
- **AC2** A template containing `@everyone`/`@here`/role mentions does not actually ping (allowed-mentions restricted to the leveling member).
- **AC3** I can preview the message without waiting for a real level-up.
- **AC4** If the configured level-up channel is deleted or the bot loses Send Messages, the failure is logged once per hour per guild and surfaced by `/level-debug health` — it does not spam logs or retry forever.

**US-13** — As an Admin, I want to send level-up messages to a dedicated channel instead of wherever the member was talking.

**US-14** — As an Admin, I want to turn off level-up messages entirely.

**US-15** — As an Owner, I want to restrict who can use `/xp` so admins can't inflate their friends.
- **AC1** With `xp_command_owner_only`, non-owners receive a clear refusal.
- **AC2** Only the owner can change this setting; an Admin attempting it is refused.

**US-16** — As an Owner, I want to prevent anyone from resetting the leaderboard.

---

## B. XP earning (Member — mostly implicit)

**US-17** — As a Member, I want to earn XP when I chat.
- **AC1** My first eligible message ever creates my member row and awards XP.
- **AC2** A message I send in a thread of an allowed channel earns XP when threads are enabled.
- **AC3** Editing or deleting my message does not change my XP.

**US-18** — As a Member, I want to earn XP for time spent in voice chat.
- **AC1** I earn only while unmuted, undeafened, and not alone (per config).
- **AC2** Moving between eligible voice channels does not reset or lose my accrued time.
- **AC3** If the bot restarts while I'm in voice, I lose at most one tick's worth of XP and my session resumes.
- **AC4** Sitting in an AFK channel earns nothing.
- **AC5** After several hours in one session my per-tick XP visibly decreases (anti-AFK), down to a floor, and resets when I leave for a while.

**US-19** — As a Member, I want to earn XP when people react to my messages.
- **AC1** The same user reacting to the same message with different emoji does not multiply my XP beyond the configured dedup rule.
- **AC2** Reacting to my own message earns nothing (giver or receiver) when self-reactions are disabled.
- **AC3** Removing a reaction does not remove XP already awarded.

---

## C. Member reads

**US-20** — As a Member, I want to check my rank and progress toward the next level.
- **AC1** Shows level, XP within the current level, XP required for the next level, total XP, and rank among guild members.
- **AC2** Rank ties are broken deterministically (lower user ID first) so the number is stable between calls.
- **AC3** Members with 0 XP are either unranked or ranked last, consistently, and the message says which.
- **AC4** Responds within 3 seconds or defers.
- **AC5** Works for a member who has left the guild if their data still exists (shows a "no longer in server" note).

**US-21** — As a Member, I want to see the server leaderboard and find myself on it.
- **AC1** Pagination is stable: a page-2 read immediately after page 1 does not show a duplicate or skipped member because someone gained XP in between (keyset pagination on `(xp, user_id)`).
- **AC2** A "jump to me" control lands on the page containing the caller.
- **AC3** Members who left are labeled or hidden per the guild setting; their display names still render from the stored snapshot.
- **AC4** An empty leaderboard shows a helpful message rather than an empty embed.

**US-22** — As a Member, I want to see which roles I can earn and at what level.
- **AC1** Shows my current level and how much XP remains to the next reward.
- **AC2** Rewards whose role no longer exists are omitted and reported to admins, not shown as broken.

**US-23** — As a Member, I want to see what XP boosts are active and what my effective multiplier is right now.

**US-24** — As a Member, I want a good-looking rank card image.
- **AC1** Renders correctly for long usernames, non-Latin scripts, emoji in names, and members with a default (non-uploaded) avatar.
- **AC2** If rendering fails, the bot falls back to the text embed rather than erroring.
- **AC3** The card is generated fresh (no stale level) but avatar bytes may be cached.

**US-25** — As a Member, I want to customize my own rank card colors/background.
- **AC1** Invalid or oversized images are rejected with the size/format requirements stated.
- **AC2** Guild admins can disable member customization.

**US-26** — As a Member, I want my leveling data deleted if I ask.
- **AC1** Removes XP, stats, sessions and card settings for that guild; is recorded in the audit log without retaining the data itself.

---

## D. Administration & moderation

**US-27** — As an Admin, I want to give a member bonus XP for something good they did.
- **AC1** `add` accepts an amount, an optional reason (audited), and a `silent` flag.
- **AC2** Crossing multiple levels announces once, at the final level.
- **AC3** Reward roles are reconciled to the final level in one operation.
- **AC4** The grant cannot exceed `manual_xp_level_limit`; the refusal states the limit.

**US-28** — As an Admin, I want to remove XP from someone who cheated.
- **AC1** XP cannot go below 0.
- **AC2** Dropping levels removes reward roles when `remove_on_level_down` is on, and the member is not notified.
- **AC3** The action is audited with actor, target, delta, before/after level, and reason.

**US-29** — As an Admin, I want to set a member's level directly.
- **AC1** Sets total XP to exactly the threshold of that level (progress within level = 0), unless I also specify progress.
- **AC2** Documented as lossy: it discards prior within-level progress.

**US-30** — As an Admin, I want to reset one member or the whole server.
- **AC1** Server reset requires a typed/clicked confirmation naming the guild, expiring in 60s.
- **AC2** Statistics are preserved unless I opt in to clearing them.
- **AC3** Reset removes reward roles only if I opt in (default: leave roles alone, because mass role removal is a rate-limit event and often not intended).
- **AC4** The action is irreversible and says so before confirmation.

**US-31** — As an Admin, I want to know why a specific member isn't earning XP.
- **AC1** `/level-debug why @member #channel` outputs each pipeline gate in order with pass/fail and a human reason.
- **AC2** It reports whether a cooldown is currently active and when it expires.
- **AC3** It reports missing intents/permissions relevant to that path.
- **AC4** It performs a **dry run** — no XP is awarded and no cooldown is consumed.

**US-32** — As an Admin, I want to know why a reward role wasn't given.
- **AC1** Shows desired role set vs actual, and for each missing role the blocking reason: role deleted, hierarchy, missing Manage Roles, managed role, or "not yet reconciled".
- **AC2** Offers to retry the reconciliation inline.

**US-33** — As an Admin, I want to apply new reward roles to everyone who already qualifies.
- **AC1** Runs as a background job with a progress message that updates.
- **AC2** Is throttled to stay within Discord rate limits and reports estimated completion.
- **AC3** Can be cancelled; is idempotent if re-run.
- **AC4** Only one backfill per guild at a time.

**US-34** — As an Admin, I want weekly/monthly leaderboards that reset.
- **AC1** Resetting the weekly board never changes lifetime XP or levels.
- **AC2** The boundary is my guild's configured timezone and week start, not UTC-only.
- **AC3** Reset happens regardless of whether highlight posting is enabled (explicitly unlike Arcane's documented coupling).

**US-35** — As an Admin, I want a weekly top-10 posted automatically.
- **AC1** Posts once per period even if the bot restarts during the window (idempotent per (guild, period)).
- **AC2** If the bot is offline across the boundary, the post is made on next start if within a grace window, otherwise skipped with a log.

**US-36** — As an Admin, I want migrating from another leveling bot not to lose my community's progress.
- **AC1** Accepts a CSV of `user_id,xp` (or `user_id,level`), validates it, shows a dry-run summary, and requires confirmation.
- **AC2** Import is additive or replacing (my choice) and audited.

---

## E. Operator

**US-37** — As an Operator, I want to deploy the bot with one command.
- **AC1** `docker compose up` from a clean checkout with a filled `.env` yields a running, migrated, connected bot.
- **AC2** Missing/invalid env vars fail fast at boot with a readable list, before connecting to Discord.

**US-38** — As an Operator, I want to know the bot is healthy.
- **AC1** `/readyz` returns 200 only when the gateway is connected and the DB responds.
- **AC2** Logs are structured JSON and include guild context.

**US-39** — As an Operator, I want database upgrades to be safe.
- **AC1** Migrations run before the gateway connects; a failed migration aborts boot rather than running on a mismatched schema.

**US-40** — As an Operator, I want to add a new feature module later without touching the leveling code.
- **AC1** A new module registers commands, listeners and migrations through the plugin interface only.
- **AC2** Removing a module's registration removes its commands with no leveling changes.

---

## F. Stories deliberately **not** in scope

Recorded so a coding agent doesn't invent them: XP decay, prestige, per-level custom messages, DM level-ups, cross-guild global levels, achievements, XP trading/gambling, currency/economy, voice XP for streaming/camera specifically, per-member XP multipliers awarded as prizes.
