import { Client, Options, type GatewayIntentBits } from 'discord.js';

/**
 * discord.js client factory.
 *
 * The default caches are the single most common cause of a Discord bot's memory
 * growing without bound: discord.js will happily retain every message it has
 * ever seen, forever. At 10 guilds nobody notices; at 500 the process is
 * measured in gigabytes. We configure sweepers explicitly rather than
 * discovering this later (spec `08` §5.3, failure #2).
 *
 * What Enoki actually needs cached:
 *   guilds, channels, roles, members  — restriction and reward resolution
 *   messages                          — a small window, only to resolve the
 *                                       author of a reacted-to message (M11)
 *   presences, voice states, emoji…   — never
 */
export function createDiscordClient(intents: readonly GatewayIntentBits[]): Client {
  return new Client({
    intents: [...intents],

    // Never ping @everyone/@here or roles from a level-up template. String
    // filtering is defeatable; the API-level control is not (spec NFR-23).
    allowedMentions: { parse: ['users'], repliedUser: false },

    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      // Small window: enough to resolve a reaction's message author without
      // retaining chat history.
      MessageManager: 50,
      // Never cached — we do not use these, and they are the heaviest.
      PresenceManager: 0,
      GuildEmojiManager: 0,
      GuildStickerManager: 0,
      ReactionUserManager: 0,
      GuildInviteManager: 0,
      GuildScheduledEventManager: 0,
      AutoModerationRuleManager: 0,
      ThreadMemberManager: 0,
    }),

    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 300, lifetime: 900 },
      threads: { interval: 3600, lifetime: 14400 },
    },
  });
}
