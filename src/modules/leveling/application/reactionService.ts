import type { Logger } from '../../../platform/logging/logger.js';
import type { GuildLevelingConfig, LocationChain, MemberContext } from '../domain/types.js';
import type { ConfigCache } from '../ports/config.js';
import type { ReactionAwardRepository } from '../ports/reactions.js';
import type { XpAwarder } from './awardXp.js';

/**
 * REACTION XP (spec `04` §7.2, roadmap M11).
 *
 * One click can award XP to TWO different people for two different reasons:
 *
 *   reaction_add     — the reactor, for engaging
 *   reaction_receive — the message author, for writing something worth reacting to
 *
 * They are separate sources with separate settings and, critically, SEPARATE
 * COOLDOWNS keyed on different people. Sharing a cooldown would mean that
 * reacting to someone silently used up their ability to receive.
 *
 * THE FARMING VECTORS, and what stops each:
 *
 *   add / remove / re-add          durable dedup — awarded once per
 *                                  (message, reactor, emoji), ever
 *   a ring of alts reacting to
 *   one friend's message           the receive cooldown, plus a cap on distinct
 *                                  reactors credited per message
 *   mass-reacting to one's own
 *   old messages                   self-reactions denied by default, plus an
 *                                  optional message-age limit
 *
 * The dedup is claimed BEFORE either award and is never rolled back. A reaction
 * that was claimed but earned nothing (cooldown, restriction) must still be
 * spent: otherwise "react, get denied, remove, re-react" is a retry loop that
 * eventually lands inside the cooldown window.
 */

export interface ReactionServiceDeps {
  readonly awards: ReactionAwardRepository;
  readonly configs: ConfigCache;
  readonly awarder: XpAwarder;
  readonly log: Logger;
}

export interface ReactionEvent {
  readonly guildId: string;
  readonly messageId: string;
  readonly reactorId: string;
  readonly emoji: string;
  readonly reactorIsBot: boolean;
  readonly reactorRoleIds: readonly string[];
  readonly location: LocationChain;
  /** Null when the message is uncached and could not be fetched. */
  readonly messageAuthorId: string | null;
  readonly messageAuthorIsBot: boolean;
  readonly messageCreatedAt: number;
  readonly occurredAt: number;
}

export interface ReactionOutcome {
  readonly claimed: boolean;
  readonly reactorXp: number;
  readonly authorXp: number;
  readonly skipped?: 'duplicate' | 'disabled' | 'bot' | 'too_old' | 'reactor_cap';
}

export interface ReactionService {
  handle(event: ReactionEvent): Promise<ReactionOutcome>;
}

const NOTHING: ReactionOutcome = { claimed: false, reactorXp: 0, authorXp: 0 };

export function createReactionService(deps: ReactionServiceDeps): ReactionService {
  return {
    async handle(event) {
      const config = await deps.configs.get(event.guildId);
      if (!config.enabled) return { ...NOTHING, skipped: 'disabled' };

      const addConfig = config.sources.reaction_add;
      const receiveConfig = config.sources.reaction_receive;
      if (!addConfig.enabled && !receiveConfig.enabled) {
        return { ...NOTHING, skipped: 'disabled' };
      }

      if (event.reactorIsBot) return { ...NOTHING, skipped: 'bot' };

      // Age is checked BEFORE claiming: refusing an ancient message should not
      // consume its dedup slot, because the reaction never had a chance to earn
      // and the admin may lift the limit later.
      const maxAgeDays =
        receiveConfig.reactionMaxMessageAgeDays ?? addConfig.reactionMaxMessageAgeDays ?? null;
      if (maxAgeDays !== null) {
        const ageDays = (event.occurredAt - event.messageCreatedAt) / 86_400_000;
        if (ageDays > maxAgeDays) return { ...NOTHING, skipped: 'too_old' };
      }

      // CLAIMED FIRST, and never rolled back. A reaction that earns nothing
      // still spends its slot, or "react, get denied, remove, re-react" becomes
      // a retry loop that eventually lands outside the cooldown.
      const claimed = await deps.awards.claim(
        {
          guildId: event.guildId,
          messageId: event.messageId,
          reactorId: event.reactorId,
          emoji: event.emoji,
        },
        event.messageAuthorId,
      );

      if (!claimed) return { ...NOTHING, skipped: 'duplicate' };

      const reactorXp = addConfig.enabled
        ? await award(deps, event, config, 'reaction_add', event.reactorId)
        : 0;

      let authorXp = 0;
      let cappedOut = false;

      if (receiveConfig.enabled && event.messageAuthorId !== null && !event.messageAuthorIsBot) {
        // The distinct-reactor cap counts rows that already exist — including
        // the one just claimed — so the Nth DISTINCT reactor is the last to
        // pay. Counting after the claim is what makes it exact rather than
        // off-by-one under concurrency.
        const distinctReactors = await deps.awards.countReactors(
          event.guildId,
          event.messageId,
        );
        const cap = receiveConfig.reactionMaxPerMessage ?? 3;

        if (distinctReactors > cap) {
          cappedOut = true;
        } else {
          authorXp = await award(deps, event, config, 'reaction_receive', event.messageAuthorId);
        }
      }

      return {
        claimed: true,
        reactorXp,
        authorXp,
        ...(cappedOut ? { skipped: 'reactor_cap' as const } : {}),
      };
    },
  };
}

/**
 * One side of the reaction. Goes through the normal pipeline so restrictions,
 * boosters, the max-level cap and level-up effects behave identically to a
 * message — the only thing special about reactions is the dedup above.
 */
async function award(
  deps: ReactionServiceDeps,
  event: ReactionEvent,
  config: GuildLevelingConfig,
  source: 'reaction_add' | 'reaction_receive',
  earnerId: string,
): Promise<number> {
  const member: MemberContext = {
    userId: earnerId,
    // Role-scoped rules apply to the REACTOR's roles only, because the author's
    // roles are not knowable without a member fetch per reaction.
    roleIds: source === 'reaction_add' ? [...event.reactorRoleIds] : [],
    isBot: false,
    isWebhook: false,
    isSelf: false,
    isIgnored: false,
    currentTotalXp: 0,
    currentLevel: 0,
  };

  const outcome = await deps.awarder.award({
    guildId: event.guildId,
    userId: earnerId,
    candidate: {
      source,
      occurredAt: event.occurredAt,
      // Distinct per side, so the two awards never collide in the in-memory
      // duplicate map.
      idempotencyKey: `${source}:${event.messageId}:${event.reactorId}:${event.emoji}`,
      location: event.location,
      // BOTH ids, always. The pipeline's own gate compares them and denies a
      // self-reaction with `self_reaction` — deciding it here instead would
      // report it as `actor_is_self`, which means something different and
      // would read as a bug in a trace.
      reactorId: event.reactorId,
      ...(event.messageAuthorId !== null ? { messageAuthorId: event.messageAuthorId } : {}),
      alreadyCounted: false,
    },
    member,
    config,
    statDelta:
      source === 'reaction_add' ? { reactionsGiven: 1 } : { reactionsReceived: 1 },
  });

  return outcome.awarded ? outcome.event.xpAwarded : 0;
}
