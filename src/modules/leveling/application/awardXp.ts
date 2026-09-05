import type { Database } from '../../../platform/db/pool.js';
import type { Logger } from '../../../platform/logging/logger.js';
import { noopMetrics, type MetricsSink } from '../../../platform/metrics/metrics.js';
import { getCurve } from '../domain/curve/curve.js';
import { computeLevelTransition, evaluateXp } from '../domain/engine/pipeline.js';
import { currentPeriodStart } from '../domain/periods/calendar.js';
import type {
  Clock,
  GuildLevelingConfig,
  MemberContext,
  Rng,
  XpCandidate,
  XpDecision,
} from '../domain/types.js';
import type { MemberXpRepository, StatDelta } from '../ports/memberXp.js';
import { cooldownKey, type CooldownStore } from '../ports/cooldowns.js';

/**
 * THE AWARD USE CASE — layer 3 and the dispatch into layer 4 (spec `04` §1).
 *
 * The layering this enforces:
 *
 *   layer 2 (domain)  decides WHETHER and HOW MUCH — pure, already tested
 *   layer 3 (here)    persists atomically and reports the transition
 *   layer 4 (effects) reacts: level-up message, reward roles, metrics
 *
 * Two rules that are easy to violate and expensive to debug:
 *
 * 1. **No Discord call inside the transaction.** A transaction holds a pooled
 *    connection; awaiting the network inside one starves the pool under load.
 *    Effects run strictly AFTER commit.
 *
 * 2. **A failing effect never rolls back the XP.** If the level-up message
 *    cannot be sent because the bot lost Send Messages, the member still earned
 *    their XP. Effects are dispatched with their failures isolated.
 */

export interface XpAwardedEvent {
  readonly guildId: string;
  readonly userId: string;
  readonly source: XpCandidate['source'] | 'manual';
  readonly xpAwarded: number;
  readonly totalXpBefore: number;
  readonly totalXpAfter: number;
  readonly levelBefore: number;
  readonly levelAfter: number;
  readonly leveledUp: boolean;
  readonly leveledDown: boolean;
  readonly levelsCrossed: readonly number[];
  /** Suppresses the level-up message (manual grants can be silent). */
  readonly silent: boolean;
  readonly channelId?: string | undefined;
  readonly config: GuildLevelingConfig;
}

export type XpAwardedHandler = (event: XpAwardedEvent) => Promise<void> | void;

export interface AwardXpDeps {
  readonly db: Database;
  readonly memberXp: MemberXpRepository;
  readonly cooldowns: CooldownStore;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly log: Logger;
  readonly metrics?: MetricsSink;
}

export interface AwardXpInput {
  readonly guildId: string;
  readonly userId: string;
  readonly candidate: XpCandidate;
  readonly member: MemberContext;
  readonly config: GuildLevelingConfig;
  readonly identity?: { displayName?: string | null; avatarHash?: string | null };
  readonly statDelta?: StatDelta;
}

export type AwardXpOutcome =
  | { readonly awarded: false; readonly decision: XpDecision }
  | { readonly awarded: true; readonly decision: XpDecision; readonly event: XpAwardedEvent };

export class XpAwarder {
  private readonly handlers: XpAwardedHandler[] = [];
  /**
   * Best-effort duplicate suppression for redelivered gateway events
   * (ADR-010). In memory for message and voice, because a duplicated award
   * after a resume is worth ~20 XP; reaction dedup is durable instead, because
   * there it is a farming primitive rather than a rounding error.
   */
  private readonly seen = new Map<string, number>();
  private readonly seenLimit = 50_000;

  private readonly metrics: MetricsSink;

  constructor(private readonly deps: AwardXpDeps) {
    // Deny REASONS are a closed set (the DenyCode union), so labelling by them
    // is safe. Nothing here is ever labelled by guild or user.
    this.metrics = deps.metrics ?? noopMetrics;
  }

  /** Register a layer-4 effect. Failures are isolated per handler. */
  on(handler: XpAwardedHandler): void {
    this.handlers.push(handler);
  }

  async award(input: AwardXpInput): Promise<AwardXpOutcome> {
    const { candidate, config, member, guildId, userId } = input;

    // --- idempotency ------------------------------------------------------
    if (this.isDuplicate(candidate.idempotencyKey)) {
      this.metrics.increment('enoki_xp_denied_total', { reason: 'duplicate_event' });
      return {
        awarded: false,
        decision: deniedDecision('duplicate_event', 'this event was already processed'),
      };
    }

    // --- layer 2: decide (pure) -------------------------------------------
    const cooldownExpiresAt = this.deps.cooldowns.peek(
      cooldownKey(guildId, userId, candidate.source),
    );

    const decision = evaluateXp(
      candidate,
      { ...member, cooldownExpiresAt },
      config,
      this.deps.clock,
      this.deps.rng,
    );

    if (decision.outcome === 'denied') {
      this.metrics.increment('enoki_xp_denied_total', {
        reason: decision.denyReason ?? 'unknown',
      });
      this.deps.log.debug(
        { guildId, userId, source: candidate.source, reason: decision.denyReason },
        'xp denied',
      );
      return { awarded: false, decision };
    }

    // --- consume the cooldown SYNCHRONOUSLY, before any await --------------
    // This is the check-and-set that stops two messages in the same millisecond
    // both earning. Doing it after the database write would leave a window.
    const cooldownSeconds = config.sources[candidate.source].cooldownSeconds;
    if (cooldownSeconds > 0) {
      const outcome = this.deps.cooldowns.tryConsume(
        cooldownKey(guildId, userId, candidate.source),
        cooldownSeconds * 1000,
      );
      if (!outcome.consumed) {
        this.metrics.increment('enoki_xp_denied_total', { reason: 'on_cooldown' });
        // Lost the race against a concurrent message from the same member.
        return {
          awarded: false,
          decision: { ...decision, outcome: 'denied', denyReason: 'on_cooldown', finalXp: 0 },
        };
      }
    }

    this.markSeen(candidate.idempotencyKey);

    // --- layer 3: persist atomically --------------------------------------
    const curve = getCurve(config.curve);
    const levelFor = (xp: number): number => curve.levelFromTotalXp(xp);
    const now = this.deps.clock.now();

    const mutation = await this.deps.db.withTransaction(async (tx) => {
      const result = await this.deps.memberXp.addXp(
        tx,
        guildId,
        userId,
        decision.finalXp,
        levelFor,
        input.identity,
      );

      if (input.statDelta) await this.deps.memberXp.bumpStats(tx, guildId, userId, input.statDelta);

      // Period buckets are written in the SAME transaction (ADR-006). The
      // "reset" is simply that this key changes when the clock crosses the
      // guild's local midnight — no job, no deletion.
      for (const periodType of ['week', 'month'] as const) {
        const start = currentPeriodStart(now, periodType, config.timezone, config.weekStartDay);
        await this.deps.memberXp.bumpPeriodXp(
          tx,
          guildId,
          userId,
          periodType,
          new Date(start),
          decision.finalXp,
        );
      }

      return result;
    });

    const transition = computeLevelTransition(
      mutation.totalXpBefore,
      mutation.totalXpAfter,
      config,
    );

    const event: XpAwardedEvent = {
      guildId,
      userId,
      source: candidate.source,
      xpAwarded: decision.finalXp,
      totalXpBefore: mutation.totalXpBefore,
      totalXpAfter: mutation.totalXpAfter,
      levelBefore: transition.levelBefore,
      levelAfter: transition.levelAfter,
      leveledUp: transition.leveledUp,
      leveledDown: transition.leveledDown,
      levelsCrossed: transition.levelsCrossed,
      silent: false,
      channelId: candidate.location?.channelId,
      config,
    };

    this.deps.log.debug(
      {
        guildId,
        userId,
        source: candidate.source,
        xp: decision.finalXp,
        total: mutation.totalXpAfter,
        level: transition.levelAfter,
        leveledUp: transition.leveledUp,
      },
      'xp awarded',
    );

    this.metrics.increment('enoki_xp_awarded_total', { source: candidate.source });
    this.metrics.increment('enoki_xp_amount_total', { source: candidate.source }, decision.finalXp);
    if (transition.leveledUp) this.metrics.increment('enoki_levelups_total');

    // --- layer 4: effects, AFTER commit, failures isolated -----------------
    await this.dispatch(event);

    return { awarded: true, decision, event };
  }

  /**
   * Manual XP. Bypasses the gates (it is an explicit administrative act) but
   * shares the persistence and effect path, so a level-up from `/xp add`
   * behaves exactly like one earned by chatting.
   */
  async awardManual(input: {
    readonly guildId: string;
    readonly userId: string;
    readonly delta: number;
    readonly config: GuildLevelingConfig;
    readonly silent?: boolean;
    readonly setAbsolute?: number;
  }): Promise<XpAwardedEvent> {
    const curve = getCurve(input.config.curve);
    const levelFor = (xp: number): number => curve.levelFromTotalXp(xp);

    const mutation = await this.deps.db.withTransaction(async (tx) =>
      input.setAbsolute === undefined
        ? this.deps.memberXp.addXp(tx, input.guildId, input.userId, input.delta, levelFor)
        : this.deps.memberXp.setTotalXp(
            tx,
            input.guildId,
            input.userId,
            input.setAbsolute,
            levelFor,
          ),
    );

    const transition = computeLevelTransition(
      mutation.totalXpBefore,
      mutation.totalXpAfter,
      input.config,
    );

    const event: XpAwardedEvent = {
      guildId: input.guildId,
      userId: input.userId,
      source: 'manual',
      xpAwarded: mutation.appliedDelta,
      totalXpBefore: mutation.totalXpBefore,
      totalXpAfter: mutation.totalXpAfter,
      levelBefore: transition.levelBefore,
      levelAfter: transition.levelAfter,
      leveledUp: transition.leveledUp,
      leveledDown: transition.leveledDown,
      levelsCrossed: transition.levelsCrossed,
      silent: input.silent ?? false,
      config: input.config,
    };

    await this.dispatch(event);
    return event;
  }

  private async dispatch(event: XpAwardedEvent): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch (error) {
        // NFR-8: a side effect must never undo or obscure a committed award.
        this.deps.log.error(
          { err: error, guildId: event.guildId, userId: event.userId },
          'xp side effect failed',
        );
      }
    }
  }

  private isDuplicate(key: string): boolean {
    const seenAt = this.seen.get(key);
    return seenAt !== undefined && this.deps.clock.now() - seenAt < 600_000;
  }

  private markSeen(key: string): void {
    this.seen.set(key, this.deps.clock.now());
    if (this.seen.size > this.seenLimit) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

function deniedDecision(reason: 'duplicate_event', detail: string): XpDecision {
  return {
    outcome: 'denied',
    baseXp: 0,
    effortBonus: 0,
    multiplierBps: 10000,
    finalXp: 0,
    denyReason: reason,
    allDenyReasons: [reason],
    consumesCooldown: false,
    trace: [{ gate: 'idempotency', verdict: 'deny', detail }],
  };
}
