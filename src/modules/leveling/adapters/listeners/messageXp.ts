import { Events, type Message } from 'discord.js';
import type { ListenerDefinition, ModuleContext } from '../../../../platform/plugin/types.js';
import type { XpAwarder } from '../../application/awardXp.js';
import type { ConfigCache } from '../../ports/config.js';
import type { MemberXpRepository } from '../../ports/memberXp.js';
import { buildMessageCandidate } from './messageCreate.js';

/**
 * The messageCreate LISTENER — the hot path (spec `04` §2).
 *
 * Everything expensive is avoided before it is needed:
 *
 *   adapter filter  ->  cached config  ->  pure evaluation  ->  one transaction
 *
 * A bot message, a system message or a disabled guild costs a few comparisons
 * and no I/O at all. The database is touched only for a message that has
 * actually earned something.
 */

export interface MessageXpDeps {
  readonly awarder: XpAwarder;
  readonly configs: ConfigCache;
  readonly memberXp: MemberXpRepository;
  readonly hasMessageContent: boolean;
}

export function createMessageXpListener(deps: MessageXpDeps): ListenerDefinition {
  return {
    event: Events.MessageCreate,
    handle: async (ctx: ModuleContext, ...args: unknown[]) => {
      const message = args[0] as Message;
      await handleMessage(message, deps, ctx);
    },
  };
}

async function handleMessage(
  message: Message,
  deps: MessageXpDeps,
  ctx: ModuleContext,
): Promise<void> {
  const botUserId = ctx.client.user?.id;
  if (!botUserId) return;

  const built = buildMessageCandidate(message, {
    hasMessageContent: deps.hasMessageContent,
    botUserId,
  });
  if (!built.ok) return;

  const config = await deps.configs.get(built.guildId);

  // The cheapest possible rejection for the overwhelmingly common case of a
  // guild that has not turned leveling on. Checked here as well as in the
  // pipeline so a disabled guild never reads a member row.
  if (!config.enabled || !config.sources.message.enabled) return;

  // The max-level gate is the ONLY reason evaluation needs the member's current
  // level, so the read happens only for guilds that have a cap configured.
  let member = built.member;
  if (config.curve.maxLevel !== null) {
    const row = await deps.memberXp.get(built.guildId, built.userId);
    if (row) member = { ...member, currentTotalXp: row.totalXp, currentLevel: row.level };
  }

  await deps.awarder.award({
    guildId: built.guildId,
    userId: built.userId,
    candidate: built.candidate,
    member,
    config,
    identity: built.identity,
    // Counts XP-EARNING messages, not all messages: the leaderboard metric is
    // "participation that counted", and counting rate-limited messages would
    // make it a chattiness contest.
    statDelta: { messagesCounted: 1 },
  });
}
