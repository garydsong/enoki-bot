import {
  ChannelType,
  Events,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';
import type { ListenerDefinition, ModuleContext } from '../../../../platform/plugin/types.js';
import type { ReactionEvent, ReactionService } from '../../application/reactionService.js';
import type { LocationChain } from '../../domain/types.js';

/**
 * The messageReactionAdd ADAPTER (roadmap M11).
 *
 * THE HARD PART IS RESOLVING THE MESSAGE AUTHOR. Discord sends the reaction,
 * not the message, and the message is only in the cache if the bot saw it
 * posted — which for anything older than the current uptime it did not. So the
 * author is fetched, and that fetch is:
 *
 *   - cached in a bounded LRU, because a popular message gets many reactions
 *     and they must not each cost an API call;
 *   - attempted ONCE and never retried, because the failure modes (deleted
 *     message, lost Read Message History) do not heal on a retry and a retry
 *     storm on a mass-reaction is worse than losing the receive-side XP;
 *   - allowed to fail. The reactor still earns; only the author's side is lost.
 */

export interface MessageReactionDeps {
  readonly reactions: ReactionService;
  /** Bounded author cache. Defaults to 5,000 messages. */
  readonly authorCacheSize?: number;
}

export function createReactionListener(deps: MessageReactionDeps): ListenerDefinition {
  // messageId -> author id, or null for "we tried and could not".
  // Caching the FAILURE matters as much as caching the success: without it, a
  // deleted message with fifty reactions is fifty failed fetches.
  const authors = new Map<string, { id: string | null; isBot: boolean }>();
  const limit = deps.authorCacheSize ?? 5_000;

  const remember = (messageId: string, value: { id: string | null; isBot: boolean }): void => {
    authors.set(messageId, value);
    if (authors.size > limit) {
      const oldest = authors.keys().next().value;
      if (oldest !== undefined) authors.delete(oldest);
    }
  };

  return {
    event: Events.MessageReactionAdd,
    handle: async (ctx: ModuleContext, ...args: unknown[]) => {
      const reaction = args[0] as MessageReaction | PartialMessageReaction;
      const user = args[1] as User | PartialUser;

      const guildId = reaction.message.guildId;
      if (!guildId) return; // a DM reaction

      const channel = reaction.message.channel;
      if (channel.isDMBased()) return;

      let author = authors.get(reaction.message.id);

      if (author === undefined) {
        // One fetch, then remembered either way.
        const message = reaction.message.partial
          ? await reaction.message.fetch().catch(() => null)
          : reaction.message;

        author = message?.author
          ? { id: message.author.id, isBot: message.author.bot }
          : { id: null, isBot: false };

        remember(reaction.message.id, author);

        if (author.id === null) {
          ctx.log.debug(
            { guildId, messageId: reaction.message.id },
            'could not resolve the reacted message author; crediting the reactor only',
          );
        }
      }

      const member = reaction.message.guild?.members.cache.get(user.id) ?? null;

      const event: ReactionEvent = {
        guildId,
        messageId: reaction.message.id,
        reactorId: user.id,
        emoji: emojiKey(reaction),
        reactorIsBot: user.bot ?? false,
        reactorRoleIds: member ? [...member.roles.cache.keys()] : [],
        location: describeLocation(reaction),
        messageAuthorId: author.id,
        messageAuthorIsBot: author.isBot,
        messageCreatedAt: reaction.message.createdTimestamp ?? Date.now(),
        occurredAt: Date.now(),
      };

      const outcome = await deps.reactions.handle(event);

      if (outcome.reactorXp > 0 || outcome.authorXp > 0) {
        ctx.log.debug(
          {
            guildId,
            reactor: event.reactorId,
            author: event.messageAuthorId,
            reactorXp: outcome.reactorXp,
            authorXp: outcome.authorXp,
          },
          'reaction xp awarded',
        );
      }
    },
  };
}

/**
 * A stable key for the emoji.
 *
 * A custom emoji is identified by its ID (the name can be changed), a unicode
 * emoji by the character itself. Using the name for both would let someone
 * rename a custom emoji and re-earn on every message they had already reacted
 * to — the dedup key has to be the thing that cannot change.
 */
export function emojiKey(reaction: MessageReaction | PartialMessageReaction): string {
  return reaction.emoji.id ?? reaction.emoji.name ?? 'unknown';
}

function describeLocation(reaction: MessageReaction | PartialMessageReaction): LocationChain {
  const channel = reaction.message.channel;
  if (channel.isDMBased()) {
    return {
      channelId: channel.id,
      parentChannelId: null,
      categoryId: null,
      isThread: false,
      isForumPost: false,
      isVoiceText: false,
    };
  }

  const isThread = channel.isThread();
  const parent = isThread ? channel.parent : null;

  return {
    channelId: channel.id,
    parentChannelId: isThread ? (channel.parentId ?? null) : null,
    categoryId: isThread ? (parent?.parentId ?? null) : (channel.parentId ?? null),
    isThread,
    isForumPost: isThread && parent?.type === ChannelType.GuildForum,
    isVoiceText:
      channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice,
  };
}
