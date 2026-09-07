import { DateTime } from 'luxon';
import { validateTemplate } from '../../domain/notifications/template.js';
import { validateDiscordCdnUrl } from '../../domain/net/discordCdn.js';
import type { GuildLevelingConfig, PassiveXpSource } from '../../domain/types.js';

/**
 * THE SETTING REGISTRY — one declarative table describing every configurable
 * value (spec `03` §4.2).
 *
 * Why a registry rather than forty hand-written subcommands:
 *
 * 1. **It is the SQL whitelist.** `ConfigRepository.update` interpolates a
 *    column name into an UPDATE statement, because you cannot parameterise an
 *    identifier. That is only safe if the set of column names is closed. This
 *    file is that closed set: a column that is not here can never be written,
 *    so the command layer must resolve every write through `findSetting`.
 *    NOTHING may pass a user-supplied string to `update()` directly.
 *
 * 2. **One command, autocompleted.** `/level config set <key> <value>` with
 *    autocomplete over these keys beats forty subcommands that Discord would
 *    not even let us register (25-option limit).
 *
 * 3. **Parsing and display live together.** The value an admin types and the
 *    value `/level config view` shows are produced from one definition, so they
 *    cannot drift.
 *
 * Adding a setting = a migration column + one entry here. Nothing else.
 */

export type SettingKind = 'boolean' | 'integer' | 'string' | 'channel' | 'choice' | 'decimal';

export type ParseResult =
  | { readonly ok: true; readonly value: string | number | boolean | null }
  | { readonly ok: false; readonly error: string };

export interface SettingDefinition {
  /** The user-facing dotted key, e.g. `curve.multiplier`. */
  readonly key: string;
  /** The database column. Whitelisted BY BEING HERE — see the header. */
  readonly column: string;
  /** When set, the column lives on `xp_source_config` for this source. */
  readonly source?: PassiveXpSource;
  readonly kind: SettingKind;
  readonly description: string;
  readonly choices?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  /** Whether `none`/`off` clears the value to NULL. */
  readonly nullable?: boolean;
  readonly example?: string;
  /** Overrides the generic parser for this kind. */
  readonly parse?: (raw: string) => ParseResult;
  /** How the current value reads in `/level config view`. */
  readonly read: (config: GuildLevelingConfig) => string;
}

// --- helpers ---------------------------------------------------------------

const yesNo = (value: boolean): string => (value ? 'yes' : 'no');
const orNone = (value: string | number | null): string =>
  value == null ? 'none' : String(value);
const asMultiplier = (bps: number): string => `${(bps / 10000).toFixed(2)}x`;

/** A decimal multiplier ("1.5") stored as basis points (15000). */
function parseMultiplier(max: number) {
  return (raw: string): ParseResult => {
    const trimmed = raw.trim().replace(/x$/i, '');
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, error: 'must be a positive number like `1.5`' };
    }
    const bps = Math.round(value * 10000);
    if (bps > max) return { ok: false, error: `must be at most ${(max / 10000).toFixed(2)}x` };
    return { ok: true, value: bps };
  };
}

function parseTimezone(raw: string): ParseResult {
  const zone = raw.trim();
  // Luxon is the authority here rather than a hand-kept list: an unknown zone
  // would otherwise be stored happily and then break every period boundary.
  if (!DateTime.local().setZone(zone).isValid) {
    return {
      ok: false,
      error: `\`${zone}\` is not an IANA timezone. Examples: \`UTC\`, \`America/New_York\`, \`Europe/London\`.`,
    };
  }
  return { ok: true, value: zone };
}

function parseTemplate(raw: string): ParseResult {
  const issues = validateTemplate(raw);
  // Unknown placeholders and mass mentions are WARNINGS (the command surfaces
  // them); only a structurally unusable template is refused.
  const fatal = issues.filter((i) => i.kind === 'empty' || i.kind === 'too_long');
  if (fatal.length > 0) return { ok: false, error: fatal.map((i) => i.detail).join('; ') };
  return { ok: true, value: raw };
}

function parseColor(raw: string): ParseResult {
  const trimmed = raw.trim().replace(/^#/, '');
  if (/^(none|off|default)$/i.test(trimmed)) return { ok: true, value: null };
  if (!/^[0-9a-f]{6}$/i.test(trimmed)) {
    return { ok: false, error: 'must be a hex colour like `#5865F2`, or `none`' };
  }
  return { ok: true, value: Number.parseInt(trimmed, 16) };
}

// --- the table -------------------------------------------------------------

const CONFIG_SETTINGS: readonly SettingDefinition[] = [
  {
    key: 'enabled',
    column: 'enabled',
    kind: 'boolean',
    description: 'Master switch. Nothing earns XP while this is off.',
    read: (c) => yesNo(c.enabled),
  },

  // --- curve ---------------------------------------------------------------
  {
    key: 'curve.type',
    column: 'curve_type',
    kind: 'choice',
    choices: ['linear', 'exponential', 'flat'],
    description: 'Shape of the level curve. Changing it re-derives every level.',
    read: (c) => c.curve.type,
  },
  {
    key: 'curve.multiplier',
    column: 'curve_multiplier_bps',
    kind: 'decimal',
    description: 'Scales every level width. 2.0 makes levelling twice as slow.',
    example: '1.5',
    parse: parseMultiplier(1_000_000),
    read: (c) => asMultiplier(c.curve.multiplierBps),
  },
  {
    key: 'curve.maxLevel',
    column: 'max_level',
    kind: 'integer',
    nullable: true,
    min: 0,
    max: 100_000,
    description: 'Highest reachable level, or `none` for uncapped.',
    read: (c) => orNone(c.curve.maxLevel),
  },
  {
    key: 'curve.hardCapXp',
    column: 'hard_cap_xp',
    kind: 'boolean',
    description: 'At max level, stop XP accruing entirely rather than just capping level.',
    read: (c) => yesNo(c.curve.hardCapXp),
  },

  // --- level-up announcements ---------------------------------------------
  {
    key: 'levelup.mode',
    column: 'levelup_mode',
    kind: 'choice',
    choices: ['source_channel', 'fixed_channel', 'disabled'],
    description: 'Where level-up messages go: where they levelled, one channel, or nowhere.',
    read: (c) => c.notifications.mode,
  },
  {
    key: 'levelup.channel',
    column: 'levelup_channel_id',
    kind: 'channel',
    nullable: true,
    description: 'The channel used when levelup.mode is `fixed_channel`.',
    read: (c) => (c.notifications.channelId ? `<#${c.notifications.channelId}>` : 'none'),
  },
  {
    key: 'levelup.template',
    column: 'levelup_template',
    kind: 'string',
    description: 'Message text. Placeholders: {user.mention} {user.level} {user.rank} {earned}',
    example: '{user.mention} reached level {user.level}!',
    parse: parseTemplate,
    read: (c) => `\`${c.notifications.template}\``,
  },
  {
    key: 'levelup.useEmbed',
    column: 'levelup_use_embed',
    kind: 'boolean',
    description: 'Send level-ups as an embed instead of plain text.',
    read: (c) => yesNo(c.notifications.useEmbed),
  },
  {
    key: 'levelup.color',
    column: 'levelup_embed_color',
    kind: 'string',
    nullable: true,
    description: 'Embed colour as hex, e.g. #5865F2.',
    parse: parseColor,
    read: (c) =>
      c.notifications.embedColor == null
        ? 'none'
        : `#${c.notifications.embedColor.toString(16).padStart(6, '0')}`,
  },
  {
    key: 'levelup.deleteAfter',
    column: 'levelup_delete_after_seconds',
    kind: 'integer',
    nullable: true,
    min: 1,
    max: 3600,
    description: 'Delete the announcement after N seconds. `none` keeps it.',
    read: (c) => orNone(c.notifications.deleteAfterSeconds),
  },
  {
    key: 'levelup.onlyOnRewardLevels',
    column: 'levelup_only_on_reward_levels',
    kind: 'boolean',
    description: 'Announce only levels that grant a role.',
    read: (c) => yesNo(c.notifications.onlyOnRewardLevels),
  },

  // --- rewards -------------------------------------------------------------
  {
    key: 'rewards.stacking',
    column: 'reward_stacking',
    kind: 'choice',
    choices: ['stack', 'highest'],
    description: 'Keep every earned reward role, or only the highest.',
    read: (c) => c.rewardStacking,
  },
  {
    key: 'rewards.removeOnLevelDown',
    column: 'remove_on_level_down',
    kind: 'boolean',
    description: 'Take reward roles back when a member drops below the level.',
    read: (c) => yesNo(c.removeOnLevelDown),
  },
  {
    key: 'rewards.reconcileOnRank',
    column: 'reconcile_on_rank_command',
    kind: 'boolean',
    description: 'Re-check a member’s reward roles when they run /rank.',
    read: (c) => yesNo(c.reconcileOnRankCommand),
  },

  // --- boosters ------------------------------------------------------------
  {
    key: 'boosters.stacking',
    column: 'booster_stacking',
    kind: 'choice',
    choices: ['stack', 'highest'],
    description: 'Add matching boosters together, or apply only the largest.',
    read: (c) => c.boosterStacking,
  },
  {
    key: 'boosters.maxMultiplier',
    column: 'max_multiplier_bps',
    kind: 'decimal',
    description: 'Safety ceiling on the combined multiplier.',
    example: '10',
    parse: parseMultiplier(10_000_000),
    read: (c) => asMultiplier(c.maxMultiplierBps),
  },
  {
    key: 'effort.enabled',
    column: 'effort_enabled',
    kind: 'boolean',
    description: 'Bonus XP for longer messages. Requires the Message Content intent.',
    read: (c) => yesNo(c.effort.enabled),
  },
  {
    key: 'effort.charsPerXp',
    column: 'effort_chars_per_xp',
    kind: 'integer',
    min: 1,
    max: 10_000,
    description: 'Characters per point of effort bonus.',
    read: (c) => String(c.effort.charsPerXp),
  },
  {
    key: 'effort.lengthCap',
    column: 'effort_length_cap',
    kind: 'integer',
    min: 0,
    max: 1000,
    description: 'Maximum effort bonus from length alone.',
    read: (c) => String(c.effort.lengthCap),
  },
  {
    key: 'effort.attachmentXp',
    column: 'effort_attachment_xp',
    kind: 'integer',
    min: 0,
    max: 1000,
    description: 'Bonus XP for a message with an attachment.',
    read: (c) => String(c.effort.attachmentXp),
  },

  // --- contexts ------------------------------------------------------------
  {
    key: 'context.threads',
    column: 'xp_in_threads',
    kind: 'boolean',
    description: 'Earn XP in threads.',
    read: (c) => yesNo(c.context.xpInThreads),
  },
  {
    key: 'context.forumPosts',
    column: 'xp_in_forum_posts',
    kind: 'boolean',
    description: 'Earn XP in forum posts.',
    read: (c) => yesNo(c.context.xpInForumPosts),
  },
  {
    key: 'context.voiceText',
    column: 'xp_in_voice_text',
    kind: 'boolean',
    description: 'Earn XP in the text chat attached to a voice channel.',
    read: (c) => yesNo(c.context.xpInVoiceText),
  },
  {
    key: 'context.minMessageLength',
    column: 'min_message_length',
    kind: 'integer',
    min: 0,
    max: 2000,
    description: 'Messages shorter than this earn nothing. Needs Message Content.',
    read: (c) => String(c.context.minMessageLength),
  },

  // --- periods -------------------------------------------------------------
  {
    key: 'periods.timezone',
    column: 'timezone',
    kind: 'string',
    description: 'IANA timezone deciding when weekly/monthly boards roll over.',
    example: 'America/New_York',
    parse: parseTimezone,
    read: (c) => c.timezone,
  },
  {
    key: 'periods.weekStart',
    column: 'week_start_day',
    kind: 'choice',
    choices: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
    description: 'First day of the weekly leaderboard period.',
    read: (c) => c.weekStartDay,
  },

  // --- leaderboard ---------------------------------------------------------
  {
    key: 'leaderboard.pageSize',
    column: 'leaderboard_page_size',
    kind: 'integer',
    min: 1,
    max: 25,
    description: 'Entries per leaderboard page.',
    read: (c) => String(c.leaderboardPageSize),
  },
  {
    key: 'leaderboard.hideDeparted',
    column: 'hide_departed_members',
    kind: 'boolean',
    description: 'Hide members who have left the server.',
    read: (c) => yesNo(c.hideDepartedMembers),
  },

  // --- highlights ----------------------------------------------------------
  {
    key: 'highlights.enabled',
    column: 'highlights_enabled',
    kind: 'boolean',
    description: 'Post a summary of the top members when a week or month ends.',
    read: (c) => yesNo(c.highlights.enabled),
  },
  {
    key: 'highlights.channel',
    column: 'highlights_channel_id',
    kind: 'channel',
    nullable: true,
    description: 'Where the weekly/monthly summary is posted.',
    read: (c) => (c.highlights.channelId ? `<#${c.highlights.channelId}>` : 'none'),
  },
  {
    key: 'highlights.weekly',
    column: 'highlights_weekly',
    kind: 'boolean',
    description: 'Post a summary at the end of each week.',
    read: (c) => yesNo(c.highlights.weekly),
  },
  {
    key: 'highlights.monthly',
    column: 'highlights_monthly',
    kind: 'boolean',
    description: 'Post a summary at the end of each month.',
    read: (c) => yesNo(c.highlights.monthly),
  },
  {
    key: 'highlights.size',
    column: 'highlights_size',
    kind: 'integer',
    min: 1,
    max: 25,
    description: 'How many members the summary lists.',
    read: (c) => String(c.highlights.size),
  },
  {
    key: 'highlights.firstPlaceRole',
    column: 'first_place_role_id',
    kind: 'string',
    nullable: true,
    description: 'Role given to whoever tops the weekly board. Accepts a role id.',
    parse: (raw) => {
      const trimmed = raw.trim().replace(/^<@&(\d+)>$/, '$1');
      if (/^(none|off|clear|default|unset)$/i.test(trimmed)) return { ok: true, value: null };
      if (!/^\d{17,20}$/.test(trimmed)) {
        return { ok: false, error: 'must be a role mention or a role id, or `none`' };
      }
      return { ok: true, value: trimmed };
    },
    read: (c) =>
      c.highlights.firstPlaceRoleId ? `<@&${c.highlights.firstPlaceRoleId}>` : 'none',
  },
  {
    key: 'highlights.graceHours',
    column: 'highlights_grace_hours',
    kind: 'integer',
    min: 1,
    max: 720,
    description: 'After this long, a finished period is skipped rather than announced late.',
    read: (c) => `${c.highlights.graceHours}h`,
  },

  // --- rank cards ----------------------------------------------------------
  {
    key: 'cards.enabled',
    column: 'cards_enabled',
    kind: 'boolean',
    description: 'Render /rank as an image instead of an embed.',
    read: (c) => yesNo(c.cards.enabled),
  },
  {
    key: 'cards.accent',
    column: 'card_accent_color',
    kind: 'string',
    nullable: true,
    description: 'The server’s card accent colour, as hex.',
    parse: parseColor,
    read: (c) => `#${c.cards.accentColor.toString(16).padStart(6, '0')}`,
  },
  {
    key: 'cards.background',
    column: 'card_background_url',
    kind: 'string',
    nullable: true,
    description: 'Default card background. Must be an image hosted on Discord.',
    parse: (raw) => {
      const trimmed = raw.trim();
      if (/^(none|off|clear|default|unset)$/i.test(trimmed)) return { ok: true, value: null };
      const validated = validateDiscordCdnUrl(trimmed);
      return validated.ok
        ? { ok: true, value: validated.url }
        : {
            ok: false,
            error:
              'must be an image hosted on Discord (upload it to a channel and copy that link)',
          };
    },
    read: (c) => c.cards.backgroundUrl ?? 'none',
  },
  {
    key: 'cards.allowMemberCustomisation',
    column: 'card_allow_member_customisation',
    kind: 'boolean',
    description: 'Let members override the card colour and background with /card.',
    read: (c) => yesNo(c.cards.allowMemberCustomisation),
  },

  // --- anti-abuse ----------------------------------------------------------
  {
    key: 'limits.minAccountAgeDays',
    column: 'min_account_age_days',
    kind: 'integer',
    min: 0,
    max: 3650,
    description: 'Discord accounts younger than this earn nothing.',
    read: (c) => String(c.minAccountAgeDays),
  },
  {
    key: 'limits.minMemberAgeHours',
    column: 'min_member_age_hours',
    kind: 'integer',
    min: 0,
    max: 8760,
    description: 'Members who joined less than this long ago earn nothing.',
    read: (c) => String(c.minMemberAgeHours),
  },
  {
    key: 'reactions.allowSelf',
    column: 'allow_self_reactions',
    kind: 'boolean',
    description: 'Allow reacting to your own message to earn XP. Almost always no.',
    read: (c) => yesNo(c.allowSelfReactions),
  },

  // --- administration ------------------------------------------------------
  {
    key: 'admin.manualGrantMax',
    column: 'manual_grant_max',
    kind: 'integer',
    min: 1,
    max: 1_000_000_000,
    description: 'Largest single /xp add or remove.',
    read: (c) => String(c.manualGrantMax),
  },
  {
    key: 'admin.disableResets',
    column: 'disable_resets',
    kind: 'boolean',
    description: 'Refuse /xp reset entirely. A deliberate safety catch.',
    read: (c) => yesNo(c.disableResets),
  },
  {
    key: 'admin.autoResetOnLeave',
    column: 'auto_reset_on_leave',
    kind: 'boolean',
    // The description says what it DELETES, because the setting's name sounds
    // like a reset — reversible — and it is not.
    description: 'DELETE a member’s XP, stats and history when they leave. No undo, no rejoin.',
    read: (c) => yesNo(c.autoResetOnLeave),
  },

  // --- voice ---------------------------------------------------------------
  {
    key: 'voice.minMembers',
    column: 'voice_min_members',
    kind: 'integer',
    min: 0,
    max: 99,
    description: 'Other humans required in the channel before voice XP accrues.',
    read: (c) => String(c.voice.minMembers),
  },
  {
    key: 'voice.requireUnmuted',
    column: 'voice_require_unmuted',
    kind: 'boolean',
    description: 'Muted members earn no voice XP.',
    read: (c) => yesNo(c.voice.requireUnmuted),
  },
  {
    key: 'voice.requireUndeafened',
    column: 'voice_require_undeafened',
    kind: 'boolean',
    description: 'Deafened members earn no voice XP.',
    read: (c) => yesNo(c.voice.requireUndeafened),
  },
  {
    key: 'voice.tickSeconds',
    column: 'voice_tick_seconds',
    kind: 'integer',
    min: 30,
    max: 3600,
    description: 'How often voice XP is granted, in seconds.',
    read: (c) => String(c.voice.tickSeconds),
  },
  {
    key: 'voice.antiAfk',
    column: 'anti_afk_enabled',
    kind: 'boolean',
    description: 'Decay voice XP for members parked in a channel all day.',
    read: (c) => yesNo(c.voice.antiAfkEnabled),
  },
];

// --- per-source settings ---------------------------------------------------
// Generated rather than typed out five times: the shape is identical for every
// source, so writing them by hand would only create opportunities to differ.

const SOURCE_LABELS: Readonly<Record<PassiveXpSource, string>> = {
  message: 'messages',
  voice: 'voice activity',
  reaction_add: 'giving a reaction',
  reaction_receive: 'receiving a reaction',
};

function sourceSettings(source: PassiveXpSource): SettingDefinition[] {
  const label = SOURCE_LABELS[source];
  const read = (c: GuildLevelingConfig) => c.sources[source];

  const settings: SettingDefinition[] = [
    {
      key: `${source}.enabled`,
      column: 'enabled',
      source,
      kind: 'boolean',
      description: `Earn XP from ${label}.`,
      read: (c) => yesNo(read(c).enabled),
    },
    {
      key: `${source}.xpMin`,
      column: 'min_xp',
      source,
      kind: 'integer',
      min: 0,
      max: 100_000,
      description: `Lowest XP awarded for ${label}.`,
      read: (c) => String(read(c).minXp),
    },
    {
      key: `${source}.xpMax`,
      column: 'max_xp',
      source,
      kind: 'integer',
      min: 0,
      max: 100_000,
      description: `Highest XP awarded for ${label}.`,
      read: (c) => String(read(c).maxXp),
    },
    {
      key: `${source}.cooldown`,
      column: 'cooldown_seconds',
      source,
      kind: 'integer',
      min: 0,
      max: 86_400,
      description: `Seconds between XP awards for ${label}.`,
      read: (c) => `${read(c).cooldownSeconds}s`,
    },
  ];

  if (source === 'reaction_add' || source === 'reaction_receive') {
    settings.push(
      {
        key: `${source}.maxPerMessage`,
        column: 'reaction_max_per_message',
        source,
        kind: 'integer',
        min: 1,
        max: 100,
        description: `Distinct reactors credited per message for ${label}.`,
        read: (c) => String(read(c).reactionMaxPerMessage ?? 3),
      },
      {
        key: `${source}.maxMessageAgeDays`,
        column: 'reaction_max_message_age_days',
        source,
        kind: 'integer',
        nullable: true,
        min: 1,
        max: 3650,
        description: `Reactions on messages older than this earn nothing. \`none\` = no limit.`,
        read: (c) => orNone(read(c).reactionMaxMessageAgeDays ?? null),
      },
    );
  }

  if (source === 'message') {
    settings.push({
      key: 'message.mode',
      column: 'message_mode',
      source,
      kind: 'choice',
      choices: ['random', 'per_word'],
      description: 'random: a roll between min and max. per_word: scaled by word count.',
      read: (c) => read(c).messageMode ?? 'random',
    });
  }

  return settings;
}

export const SETTINGS: readonly SettingDefinition[] = [
  ...CONFIG_SETTINGS,
  ...(['message', 'voice', 'reaction_add', 'reaction_receive'] as const).flatMap(sourceSettings),
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key.toLowerCase(), s]));

/**
 * THE ONLY WAY to turn a user-supplied key into a writable column. A caller
 * that builds SQL from anything else has reintroduced injection.
 */
export function findSetting(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key.trim().toLowerCase());
}

/** Autocomplete: substring match over key and description, Discord's 25 cap. */
export function searchSettings(query: string, limit = 25): SettingDefinition[] {
  const q = query.trim().toLowerCase();
  if (q === '') return SETTINGS.slice(0, limit);

  // Prefix matches first — typing "curve" should not bury `curve.type` beneath
  // something that merely mentions the word in its description.
  const prefix = SETTINGS.filter((s) => s.key.toLowerCase().startsWith(q));
  const substring = SETTINGS.filter(
    (s) => !s.key.toLowerCase().startsWith(q) && s.key.toLowerCase().includes(q),
  );
  const described = SETTINGS.filter(
    (s) => !s.key.toLowerCase().includes(q) && s.description.toLowerCase().includes(q),
  );

  return [...prefix, ...substring, ...described].slice(0, limit);
}

export const SETTING_GROUPS: readonly string[] = [
  ...new Set(SETTINGS.map((s) => (s.key.includes('.') ? (s.key.split('.')[0] ?? '') : 'general'))),
];

// --- parsing ---------------------------------------------------------------

const NULL_WORDS = /^(none|null|off|clear|default|unset)$/i;

/**
 * Parse a raw command argument into the value for this setting's column.
 * Returns a message rather than throwing, because every failure here is a user
 * typo and deserves an explanation instead of a correlation ID.
 */
export function parseSettingValue(setting: SettingDefinition, raw: string): ParseResult {
  const trimmed = raw.trim();

  if (setting.nullable && NULL_WORDS.test(trimmed) && !setting.parse) {
    return { ok: true, value: null };
  }
  if (setting.parse) return setting.parse(trimmed);

  switch (setting.kind) {
    case 'boolean': {
      if (/^(true|yes|on|1|enable|enabled)$/i.test(trimmed)) return { ok: true, value: true };
      if (/^(false|no|off|0|disable|disabled)$/i.test(trimmed)) return { ok: true, value: false };
      return { ok: false, error: 'must be `on` or `off`' };
    }

    case 'integer': {
      const value = Number(trimmed);
      if (!Number.isInteger(value)) return { ok: false, error: 'must be a whole number' };
      if (setting.min !== undefined && value < setting.min) {
        return { ok: false, error: `must be at least ${setting.min}` };
      }
      if (setting.max !== undefined && value > setting.max) {
        return { ok: false, error: `must be at most ${setting.max}` };
      }
      return { ok: true, value };
    }

    case 'choice': {
      const match = setting.choices?.find((c) => c.toLowerCase() === trimmed.toLowerCase());
      if (!match) {
        return { ok: false, error: `must be one of: ${setting.choices?.join(', ') ?? ''}` };
      }
      return { ok: true, value: match };
    }

    case 'channel': {
      // Accepts a mention (<#123>), a raw id, or a null word.
      const id = trimmed.replace(/^<#(\d+)>$/, '$1');
      if (!/^\d{17,20}$/.test(id)) {
        return { ok: false, error: 'must be a channel mention like #general' };
      }
      return { ok: true, value: id };
    }

    case 'decimal':
    case 'string':
    default:
      if (trimmed.length > 1900) return { ok: false, error: 'that is too long' };
      return { ok: true, value: trimmed };
  }
}

/** A one-line hint for what this setting will accept, used in errors. */
export function describeAccepted(setting: SettingDefinition): string {
  const base = (() => {
    switch (setting.kind) {
      case 'boolean':
        return '`on` or `off`';
      case 'choice':
        return setting.choices?.map((c) => `\`${c}\``).join(', ') ?? '';
      case 'integer':
        return `a whole number${setting.min !== undefined ? ` from ${setting.min}` : ''}${
          setting.max !== undefined ? ` to ${setting.max}` : ''
        }`;
      case 'channel':
        return 'a channel mention';
      case 'decimal':
        return `a number like \`${setting.example ?? '1.5'}\``;
      default:
        return setting.example ? `text, e.g. \`${setting.example}\`` : 'text';
    }
  })();
  return setting.nullable ? `${base}, or \`none\`` : base;
}
