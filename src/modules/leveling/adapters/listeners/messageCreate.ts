import { ChannelType, MessageType, type Message } from 'discord.js';
import type { LocationChain, MemberContext, XpCandidate } from '../../domain/types.js';

/**
 * The messageCreate ADAPTER. Deliberately thin: its whole job is turning a
 * discord.js Message into the plain data the engine consumes. No business
 * logic lives here — that is what keeps the engine testable without Discord.
 *
 * The filtering below is NOT policy; it is "is this even a candidate". Policy
 * (cooldowns, restrictions, boosters) belongs to the engine.
 */

/**
 * Message types that count as participation.
 *
 * An ALLOWLIST, not a denylist: Discord adds new system message types
 * regularly, and a denylist silently starts awarding XP for each new one. A
 * "member boosted the server" message should never earn XP.
 */
const EARNING_MESSAGE_TYPES: ReadonlySet<MessageType> = new Set([
  MessageType.Default,
  MessageType.Reply,
]);

export type MessageRejection =
  | 'not_in_guild'
  | 'webhook'
  | 'bot'
  | 'self'
  | 'system_message'
  | 'no_member';

export type MessageCandidate =
  | { readonly ok: false; readonly reason: MessageRejection }
  | {
      readonly ok: true;
      readonly guildId: string;
      readonly userId: string;
      readonly candidate: XpCandidate;
      readonly member: MemberContext;
      readonly identity: { displayName: string; avatarHash: string | null };
    };

export interface BuildOptions {
  /** False when the MessageContent intent is absent — content is then empty. */
  readonly hasMessageContent: boolean;
  readonly botUserId: string;
  readonly ignoredUserIds?: ReadonlySet<string>;
}

export function buildMessageCandidate(
  message: Message,
  options: BuildOptions,
): MessageCandidate {
  if (!message.inGuild()) return { ok: false, reason: 'not_in_guild' };

  // A webhook can impersonate any name and avatar, so "trusted webhook XP"
  // would be an XP-minting API. Checked before the bot flag because a webhook
  // message also has author.bot set, and the distinction matters for the trace.
  if (message.webhookId !== null) return { ok: false, reason: 'webhook' };
  if (message.author.id === options.botUserId) return { ok: false, reason: 'self' };
  if (message.author.bot) return { ok: false, reason: 'bot' };
  if (!EARNING_MESSAGE_TYPES.has(message.type)) return { ok: false, reason: 'system_message' };

  const member = message.member;
  if (!member) return { ok: false, reason: 'no_member' };

  const location = describeLocation(message);

  // Content-derived fields are only populated when the intent grants them.
  // Without it the engine still awards random-mode XP; it simply cannot apply
  // per-word mode, min_message_length or the effort booster.
  const content = options.hasMessageContent ? message.content : '';
  const contentFields = options.hasMessageContent
    ? {
        hasContent: true as const,
        messageLength: content.length,
        wordCount: countWords(content),
        whitespaceRuns: countWhitespaceRuns(content),
        attachmentCount: message.attachments.size,
      }
    : { hasContent: false as const };

  return {
    ok: true,
    guildId: message.guildId,
    userId: message.author.id,
    candidate: {
      source: 'message',
      occurredAt: message.createdTimestamp,
      // Discord message ids are unique and monotonic, so this is a free,
      // perfect idempotency key for a redelivered event.
      idempotencyKey: `msg:${message.id}`,
      location,
      ...contentFields,
    },
    member: {
      userId: message.author.id,
      roleIds: [...member.roles.cache.keys()],
      isBot: false,
      isWebhook: false,
      isSelf: false,
      isIgnored: options.ignoredUserIds?.has(message.author.id) ?? false,
      ...(message.author.createdTimestamp
        ? { accountCreatedAt: message.author.createdTimestamp }
        : {}),
      ...(member.joinedTimestamp ? { joinedGuildAt: member.joinedTimestamp } : {}),
      currentTotalXp: 0, // filled by the use case; the engine only needs level for the cap
      currentLevel: 0,
    },
    identity: {
      displayName: member.displayName || message.author.username,
      avatarHash: message.author.avatar,
    },
  };
}

/**
 * The location chain the restriction resolver walks: thread -> parent -> category.
 * Getting this wrong means a no-XP category silently fails to cover its threads.
 */
function describeLocation(message: Message<true>): LocationChain {
  const channel = message.channel;
  const isThread = channel.isThread();
  const parent = isThread ? channel.parent : null;
  const isForumPost = isThread && parent?.type === ChannelType.GuildForum;

  // The category is the thread's grandparent, not its parent.
  const categoryId = isThread ? (parent?.parentId ?? null) : (channel.parentId ?? null);

  return {
    channelId: channel.id,
    parentChannelId: isThread ? (channel.parentId ?? null) : null,
    categoryId,
    isThread,
    isForumPost: isForumPost ?? false,
    isVoiceText: channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice,
  };
}

/** Words of 3+ characters, Unicode-aware (spec `04` §7.1). */
function countWords(content: string): number {
  const matches = content.match(/[\p{L}\p{N}'-]{3,}/gu);
  return matches?.length ?? 0;
}

function countWhitespaceRuns(content: string): number {
  const matches = content.match(/\s+/g);
  return matches?.length ?? 0;
}
