import type { GuildLevelingConfig } from '../types.js';

/**
 * Default guild configuration (spec `01` §2, decisions B1/B2/B3/B5/B14).
 *
 * Where Arcane publishes a value we match it (cooldowns: message 60s,
 * reaction 300s, voice 180s). Where it does not, these are our choices and are
 * flagged as such in the spec.
 */
export const DEFAULT_LEVELING_CONFIG: GuildLevelingConfig = {
  enabled: false,
  curve: { type: 'linear', multiplierBps: 10000, maxLevel: null, hardCapXp: false },
  sources: {
    message: {
      enabled: true,
      minXp: 15,
      maxXp: 25,
      cooldownSeconds: 60,
      perEventCap: 500,
      messageMode: 'random',
    },
    voice: { enabled: false, minXp: 10, maxXp: 15, cooldownSeconds: 180, perEventCap: 500 },
    reaction_add: {
      enabled: false,
      minXp: 20,
      maxXp: 25,
      cooldownSeconds: 300,
      perEventCap: 500,
      reactionMaxPerMessage: 3,
      reactionMaxMessageAgeDays: null,
    },
    reaction_receive: {
      enabled: false,
      minXp: 20,
      maxXp: 25,
      cooldownSeconds: 300,
      perEventCap: 500,
      // Three DISTINCT reactors credited per message. The cap is on the
      // receiving side because that is the farmable one: a ring of alts
      // reacting to one friend's message is the vector.
      reactionMaxPerMessage: 3,
      reactionMaxMessageAgeDays: null,
    },
  },
  rules: [],
  rewards: [],
  notifications: {
    mode: 'source_channel',
    channelId: null,
    template: '{user.mention} has reached level **{user.level}**. GG!',
    useEmbed: false,
    embedColor: null,
    deleteAfterSeconds: null,
    onlyOnRewardLevels: false,
  },
  highlights: {
    enabled: false,
    channelId: null,
    weekly: true,
    monthly: false,
    size: 5,
    firstPlaceRoleId: null,
    graceHours: 48,
  },
  cards: {
    enabled: false,
    // Discord blurple, so an unconfigured card still looks deliberate.
    accentColor: 0x5865f2,
    backgroundUrl: null,
    allowMemberCustomisation: true,
  },
  rewardStacking: 'stack',
  removeOnLevelDown: true,
  boosterStacking: 'stack',
  effort: { enabled: false, charsPerXp: 50, lengthCap: 10, attachmentXp: 5 },
  context: {
    xpInThreads: true,
    xpInForumPosts: true,
    xpInVoiceText: true,
    minMessageLength: 0,
  },
  voice: {
    minMembers: 1,
    requireUnmuted: true,
    requireUndeafened: true,
    countServerMuteAsInactive: true,
    ignoreAfkChannel: true,
    ignoreBotsInMemberCount: true,
    tickSeconds: 180,
    antiAfkEnabled: true,
    antiAfkAfterMinutes: 120,
    antiAfkDecayPerHour: 0.25,
    antiAfkFloorMultiplier: 0.1,
  },
  timezone: 'UTC',
  weekStartDay: 'monday',
  leaderboardPageSize: 10,
  hideDepartedMembers: false,
  maxMultiplierBps: 100000,
  minAccountAgeDays: 0,
  minMemberAgeHours: 0,
  allowSelfReactions: false,
  manualGrantMax: 1_000_000,
  disableResets: false,
  autoResetOnLeave: false,
  reconcileOnRankCommand: false,
};
