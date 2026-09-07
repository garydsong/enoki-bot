/**
 * Core domain types. Pure data — no Discord objects, no database rows.
 * Spec `04` §1.1.
 */

export type Snowflake = string;

export const XP_SOURCES = ['message', 'voice', 'reaction_add', 'reaction_receive', 'manual'] as const;
export type XpSource = (typeof XP_SOURCES)[number];

/** Passive sources are the ones subject to the full gate pipeline. */
export type PassiveXpSource = Exclude<XpSource, 'manual'>;

export type CurveType = 'linear' | 'exponential' | 'flat';
export type StackingMode = 'stack' | 'highest';
export type WeekStartDay =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

// ---------------------------------------------------------------------------
// Configuration (the shape the engine consumes; persistence maps onto this)
// ---------------------------------------------------------------------------

export interface CurveConfig {
  readonly type: CurveType;
  /** Basis points. 10000 = 1.0x. Spec: integer math, never floats. */
  readonly multiplierBps: number;
  readonly maxLevel: number | null;
  /** When true, XP stops accruing at maxLevel instead of merely capping level. */
  readonly hardCapXp: boolean;
}

export interface SourceConfig {
  readonly enabled: boolean;
  readonly minXp: number;
  readonly maxXp: number;
  readonly cooldownSeconds: number;
  readonly perEventCap: number;
  readonly messageMode?: 'random' | 'per_word';
  /** reaction_receive only: distinct reactors credited per message. */
  readonly reactionMaxPerMessage?: number;
  /** Reactions on a message older than this earn nothing. Null = no limit. */
  readonly reactionMaxMessageAgeDays?: number | null;
}

export type RuleKind = 'restrict_deny' | 'restrict_only' | 'boost';
export type RuleTargetType = 'channel' | 'category' | 'role' | 'user' | 'source' | 'guild';

/** Unified restriction/booster rule. Spec `04` §3.1. */
export interface XpRule {
  readonly kind: RuleKind;
  readonly targetType: RuleTargetType;
  /** Snowflake, or an XpSource name for `source` targets, or null for `guild`. */
  readonly targetId: string | null;
  /** Boosters only. 2500 = +25%. May be negative (a nerf). */
  readonly bonusBps?: number;
  /** Optional: the rule applies to one source only. */
  readonly sourceScope?: PassiveXpSource | null;
  /** Temporary boosters. Epoch millis; null/undefined = permanent. */
  readonly expiresAt?: number | null;
}

export type RoleRewardRule =
  | { readonly type: 'exact'; readonly level: number; readonly roleId: Snowflake }
  | {
      readonly type: 'recurring';
      readonly everyN: number;
      readonly startLevel: number;
      readonly roleId: Snowflake;
    };

export interface ContextConfig {
  readonly xpInThreads: boolean;
  readonly xpInForumPosts: boolean;
  readonly xpInVoiceText: boolean;
  readonly minMessageLength: number;
}

export interface VoiceConfig {
  readonly minMembers: number;
  readonly requireUnmuted: boolean;
  readonly requireUndeafened: boolean;
  readonly countServerMuteAsInactive: boolean;
  readonly ignoreAfkChannel: boolean;
  readonly ignoreBotsInMemberCount: boolean;
  readonly tickSeconds: number;
  readonly antiAfkEnabled: boolean;
  readonly antiAfkAfterMinutes: number;
  /** Fraction of XP lost per hour beyond the threshold. 0.25 = -25%/h. */
  readonly antiAfkDecayPerHour: number;
  readonly antiAfkFloorMultiplier: number;
}

export interface EffortConfig {
  readonly enabled: boolean;
  readonly charsPerXp: number;
  readonly lengthCap: number;
  readonly attachmentXp: number;
}

export type LevelUpMode = 'source_channel' | 'fixed_channel' | 'disabled';

export interface NotificationConfig {
  readonly mode: LevelUpMode;
  /** Required when mode is `fixed_channel`; ignored otherwise. */
  readonly channelId: Snowflake | null;
  readonly template: string;
  readonly useEmbed: boolean;
  /** 0xRRGGBB, or null for Discord's default. */
  readonly embedColor: number | null;
  /** Auto-delete the announcement after N seconds. Null keeps it. */
  readonly deleteAfterSeconds: number | null;
  /** Announce only on levels that grant a role — quiet servers' preference. */
  readonly onlyOnRewardLevels: boolean;
}

export interface HighlightsConfig {
  readonly enabled: boolean;
  readonly channelId: Snowflake | null;
  readonly weekly: boolean;
  readonly monthly: boolean;
  readonly size: number;
  readonly firstPlaceRoleId: Snowflake | null;
  /** Beyond this, a finished period is marked done without posting. */
  readonly graceHours: number;
}

export interface CardsConfig {
  readonly enabled: boolean;
  /** 0xRRGGBB. The server's house accent. */
  readonly accentColor: number;
  readonly backgroundUrl: string | null;
  readonly allowMemberCustomisation: boolean;
}

export interface GuildLevelingConfig {
  readonly enabled: boolean;
  readonly curve: CurveConfig;
  readonly sources: Readonly<Record<PassiveXpSource, SourceConfig>>;
  readonly rules: readonly XpRule[];
  readonly rewards: readonly RoleRewardRule[];
  readonly notifications: NotificationConfig;
  readonly highlights: HighlightsConfig;
  readonly cards: CardsConfig;
  readonly rewardStacking: StackingMode;
  readonly removeOnLevelDown: boolean;
  readonly boosterStacking: StackingMode;
  readonly effort: EffortConfig;
  readonly context: ContextConfig;
  readonly voice: VoiceConfig;
  readonly timezone: string;
  readonly weekStartDay: WeekStartDay;
  readonly leaderboardPageSize: number;
  readonly hideDepartedMembers: boolean;
  /** Safety ceiling on the combined multiplier. 100000 = 10x. */
  readonly maxMultiplierBps: number;
  readonly minAccountAgeDays: number;
  readonly minMemberAgeHours: number;
  readonly allowSelfReactions: boolean;
  /** Largest single manual grant an admin may make. Guards a fat-fingered zero. */
  readonly manualGrantMax: number;
  /** When true, `/xp reset` refuses — a deliberate one-way door for a live server. */
  readonly disableResets: boolean;
  /**
   * Delete a member's leveling data when they LEAVE, rather than keeping it for
   * a rejoin (ADR-014's opt-out). Off by default because the surprising
   * behaviour is the destructive one: a member who leaves by accident and comes
   * back expects their level to still be there.
   */
  readonly autoResetOnLeave: boolean;
  /** Reconcile reward roles opportunistically when a member runs `/rank`. */
  readonly reconcileOnRankCommand: boolean;
}

// ---------------------------------------------------------------------------
// Evaluation inputs
// ---------------------------------------------------------------------------

/**
 * The location of an event, innermost-first. Restriction and booster resolution
 * walk this chain: [thread?] -> [parent channel] -> [category].
 * Spec `04` §3.2.
 */
export interface LocationChain {
  readonly channelId: Snowflake;
  readonly parentChannelId?: Snowflake | null;
  readonly categoryId?: Snowflake | null;
  readonly isThread: boolean;
  readonly isForumPost: boolean;
  readonly isVoiceText: boolean;
}

export interface XpCandidate {
  readonly source: PassiveXpSource;
  readonly occurredAt: number;
  readonly idempotencyKey: string;
  readonly location?: LocationChain;

  // message-only, and only when the MessageContent intent is granted
  readonly messageLength?: number;
  readonly wordCount?: number;
  readonly whitespaceRuns?: number;
  readonly attachmentCount?: number;
  readonly hasContent?: boolean;

  // voice-only
  readonly voiceEligibleSeconds?: number;
  readonly voiceTickSeconds?: number;
  readonly sessionEligibleSeconds?: number;

  // reaction-only
  readonly reactorId?: Snowflake;
  readonly messageAuthorId?: Snowflake;
  readonly alreadyCounted?: boolean;
}

export interface MemberContext {
  readonly userId: Snowflake;
  readonly roleIds: readonly Snowflake[];
  readonly isBot: boolean;
  readonly isWebhook: boolean;
  readonly isSelf: boolean;
  readonly isIgnored: boolean;
  readonly accountCreatedAt?: number;
  readonly joinedGuildAt?: number;
  readonly currentTotalXp: number;
  readonly currentLevel: number;
  /** Epoch millis at which the cooldown for this source expires, if active. */
  readonly cooldownExpiresAt?: number | null;
}

// ---------------------------------------------------------------------------
// Evaluation output
// ---------------------------------------------------------------------------

export type DenyCode =
  | 'module_disabled'
  | 'source_disabled'
  | 'actor_is_bot'
  | 'actor_is_webhook'
  | 'actor_is_self'
  | 'user_ignored'
  | 'account_too_new'
  | 'member_too_new'
  | 'role_denied'
  | 'channel_denied'
  | 'channel_not_whitelisted'
  | 'context_disabled'
  | 'message_too_short'
  | 'per_word_padding'
  | 'voice_inactive'
  | 'self_reaction'
  | 'reaction_already_counted'
  | 'on_cooldown'
  | 'max_level'
  | 'computed_zero'
  | 'duplicate_event';

export type Verdict = 'pass' | 'deny' | 'skip' | 'modify';

export interface TraceStep {
  readonly gate: string;
  readonly verdict: Verdict;
  readonly detail: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface XpDecision {
  readonly outcome: 'awarded' | 'denied';
  readonly baseXp: number;
  readonly effortBonus: number;
  readonly multiplierBps: number;
  readonly finalXp: number;
  readonly denyReason: DenyCode | null;
  /** Every failing gate, in order. Populated in collect-all mode. */
  readonly allDenyReasons: readonly DenyCode[];
  readonly consumesCooldown: boolean;
  readonly trace: readonly TraceStep[];
}

// ---------------------------------------------------------------------------
// Injected ports (spec: time and randomness are parameters, never globals)
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
}

export interface Rng {
  /** Uniform integer in [min, max], inclusive. */
  intBetween(min: number, max: number): number;
}
