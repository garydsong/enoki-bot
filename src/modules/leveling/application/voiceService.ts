import type { Logger } from '../../../platform/logging/logger.js';
import { evaluateVoiceEligibility } from '../domain/voice/eligibility.js';
import type {
  GuildLevelingConfig,
  MemberContext,
  Snowflake,
  VoiceConfig,
} from '../domain/types.js';
import type { VoiceChannelState, VoiceMemberState } from '../domain/voice/eligibility.js';
import type { ConfigCache } from '../ports/config.js';
import type { VoiceSession, VoiceSessionRepository } from '../ports/voice.js';
import type { XpAwarder } from './awardXp.js';

/**
 * VOICE XP — the only stateful source (spec `04` §8, ADR-004).
 *
 * The crediting strategy is ticks plus an end-of-session flush. Everything else
 * in this file exists to keep one invariant true:
 *
 *   **A second of voice time is credited at most once, and only if we can prove
 *   the member was eligible during it.**
 *
 * That invariant is what makes every awkward case fall out rather than needing
 * its own rule. Downtime is not credited because we cannot prove eligibility
 * during it. An ineligible gap is not credited because regaining eligibility
 * moves the watermark. A channel move credits the old channel and keeps the
 * session, because the member never stopped being present.
 *
 * THE SUBTLE PART IS THAT ELIGIBILITY IS NOT A PROPERTY OF ONE MEMBER. It
 * depends on who else is in the channel, so a single VOICE_STATE_UPDATE can
 * change the eligibility of every session in a channel — the member who just
 * became alone must stop earning, and the arrival of a second person must start
 * everyone earning. `reevaluateChannel` is that, and forgetting it is the
 * classic way voice XP quietly goes wrong.
 */

export interface VoiceServiceDeps {
  readonly sessions: VoiceSessionRepository;
  readonly configs: ConfigCache;
  readonly awarder: XpAwarder;
  readonly log: Logger;
}

/** What the adapter must be able to tell us about a channel, right now. */
export interface VoiceChannelSnapshot extends VoiceChannelState {
  readonly guildId: string;
}

export interface VoiceService {
  /** A member joined, or reconnected into, a voice channel. */
  onJoin(guildId: string, member: VoiceMemberState, channel: VoiceChannelSnapshot): Promise<void>;
  /** A member left voice entirely. Flushes the partial interval first. */
  onLeave(guildId: string, userId: string): Promise<void>;
  /** A move between channels — a mutation, never a leave plus a join. */
  onMove(
    guildId: string,
    member: VoiceMemberState,
    to: VoiceChannelSnapshot,
    from: string,
  ): Promise<void>;
  /** Re-evaluate every session in a channel. See the header. */
  reevaluateChannel(channel: VoiceChannelSnapshot): Promise<void>;
  /** The periodic tick: credit every session that is owed a full interval. */
  tick(now?: number): Promise<{ credited: number; awardedXp: number }>;
  /** Startup and shutdown handling — see `reconcile` and `flushAll`. */
  reconcile(present: readonly VoiceChannelSnapshot[]): Promise<ReconcileVoiceResult>;
  flushAll(): Promise<number>;
}

export interface ReconcileVoiceResult {
  readonly resumed: number;
  readonly closed: number;
  readonly opened: number;
  readonly orphaned: number;
}

export function createVoiceService(deps: VoiceServiceDeps): VoiceService {
  /**
   * Apply an eligibility decision to one session, flushing first when the
   * member is LOSING eligibility.
   *
   * The order matters and is easy to get backwards: if the flag were cleared
   * first, the interval the member had genuinely earned up to that moment would
   * become un-claimable, because `claimInterval` only pays eligible sessions.
   */
  const applyEligibility = async (
    session: VoiceSession,
    eligible: boolean,
    config: GuildLevelingConfig,
  ): Promise<void> => {
    if (session.isEligible === eligible) return;

    if (!eligible) {
      await creditSession(session.id, config);
    }
    await deps.sessions.setEligibility(session.id, eligible);
  };

  /**
   * Claim whatever eligible time is owed and award XP for it through the normal
   * pipeline, so restrictions, boosters, the max-level cap and level-up effects
   * all behave exactly as they do for messages.
   */
  const creditSession = async (
    sessionId: string,
    config: GuildLevelingConfig,
  ): Promise<number> => {
    // Cap a single claim at two ticks. After downtime the watermark can be
    // hours stale, and a member must not receive hours of XP in one lump for
    // time nobody verified.
    const claim = await deps.sessions.claimInterval(sessionId, config.voice.tickSeconds * 2);
    if (!claim) return 0;

    const { session, eligibleSeconds } = claim;

    const outcome = await deps.awarder.award({
      guildId: session.guildId,
      userId: session.userId,
      candidate: {
        source: 'voice',
        occurredAt: Date.now(),
        // The watermark makes this unique per credited interval, so a retried
        // tick cannot pay twice even before the SQL-level guarantee.
        idempotencyKey: `voice:${session.id}:${session.lastCreditedAt.getTime()}`,
        location: {
          channelId: session.channelId,
          parentChannelId: null,
          categoryId: null,
          isThread: false,
          isForumPost: false,
          isVoiceText: false,
        },
        voiceEligibleSeconds: eligibleSeconds,
        voiceTickSeconds: config.voice.tickSeconds,
        sessionEligibleSeconds: session.accruedEligibleSeconds,
      },
      member: memberContextFor(session.userId),
      config,
      statDelta: { voiceSeconds: eligibleSeconds },
    });

    if (outcome.awarded) {
      await deps.sessions.recordAward(session.id, outcome.event.xpAwarded);
      return outcome.event.xpAwarded;
    }
    return 0;
  };

  return {
    async onJoin(guildId, member, channel) {
      const config = await deps.configs.get(guildId);
      if (!config.enabled || !config.sources.voice.enabled) return;
      if (member.isBot) return;

      const eligible = evaluateVoiceEligibility(member, channel, config.voice).eligible;
      await deps.sessions.open({
        guildId,
        userId: member.userId,
        channelId: channel.channelId,
        eligible,
      });

      // Their arrival may have made everyone ELSE eligible.
      await this.reevaluateChannel(channel);
    },

    async onLeave(guildId, userId) {
      const session = await deps.sessions.find(guildId, userId);
      if (!session) return;

      const config = await deps.configs.get(guildId);
      // The end-of-session flush: a member who leaves 2:59 into a three-minute
      // tick is not robbed of it (ADR-004).
      await creditSession(session.id, config);
      await deps.sessions.close(session.id);
    },

    async onMove(guildId, member, to, from) {
      const session = await deps.sessions.find(guildId, member.userId);
      const config = await deps.configs.get(guildId);

      if (!session) {
        await this.onJoin(guildId, member, to);
        return;
      }

      // Credit the OLD channel before the move, then mutate. Closing and
      // reopening would reset accrued eligible time, and hopping channels every
      // two hours would defeat anti-AFK entirely.
      await creditSession(session.id, config);
      await deps.sessions.moveTo(session.id, to.channelId);

      const eligible = evaluateVoiceEligibility(member, to, config.voice).eligible;
      await deps.sessions.setEligibility(session.id, eligible);

      // Both channels changed population.
      await this.reevaluateChannel(to);
      await this.reevaluateChannel({ ...to, channelId: from, members: [], isAfkChannel: false });
    },

    async reevaluateChannel(channel) {
      const config = await deps.configs.get(channel.guildId);
      if (!config.enabled || !config.sources.voice.enabled) return;

      const sessions = await deps.sessions.openInChannel(channel.guildId, channel.channelId);
      const byUser = new Map(channel.members.map((m) => [m.userId, m]));

      for (const session of sessions) {
        const member = byUser.get(session.userId);

        // In our records but not in the channel: they left while we were not
        // looking. Credit what they earned and close it.
        if (!member) {
          await creditSession(session.id, config);
          await deps.sessions.close(session.id);
          continue;
        }

        const eligible = evaluateVoiceEligibility(member, channel, config.voice).eligible;
        await applyEligibility(session, eligible, config);
      }
    },

    async tick() {
      const open = await deps.sessions.allOpen();
      if (open.length === 0) return { credited: 0, awardedXp: 0 };

      let credited = 0;
      let awardedXp = 0;
      const heartbeats: string[] = [];
      const configs = new Map<string, GuildLevelingConfig>();

      for (const session of open) {
        heartbeats.push(session.id);

        let config = configs.get(session.guildId);
        if (!config) {
          config = await deps.configs.get(session.guildId);
          configs.set(session.guildId, config);
        }

        if (!config.enabled || !config.sources.voice.enabled) continue;
        if (!session.isEligible) continue;

        // Credit only whole ticks. The remainder stays behind the watermark and
        // is paid by the next tick or by the end-of-session flush, which is
        // what keeps a member's XP rate independent of the job's cadence.
        const owedSeconds = (Date.now() - session.lastCreditedAt.getTime()) / 1000;
        if (owedSeconds + 1 < config.voice.tickSeconds) continue;

        const xp = await creditSession(session.id, config);
        if (xp > 0) {
          credited++;
          awardedXp += xp;
        }
      }

      // One statement for every session, so a busy guild costs one write here
      // rather than one per member.
      await deps.sessions.heartbeat(heartbeats);

      return { credited, awardedXp };
    },

    /**
     * Startup reconciliation (spec `04` §8.6).
     *
     * GUILD_CREATE carries the authoritative voice states, so on connect we can
     * see exactly who is where and settle every open session against reality.
     * The four cases are all of them:
     *
     *   still present  -> resume, moving the watermark to now (the downtime is
     *                     NOT credited: we cannot prove they were active, and
     *                     paying for it would reward crashes)
     *   gone           -> close at the last proven-present moment
     *   present, no session -> open one
     *   heartbeat stale -> orphan, close unconditionally
     */
    async reconcile(present) {
      const orphaned = await deps.sessions.closeOrphans(3_600_000);

      const open = await deps.sessions.allOpen();
      const seen = new Map<string, VoiceChannelSnapshot>();
      const presentMembers = new Map<string, VoiceMemberState>();

      for (const channel of present) {
        for (const member of channel.members) {
          const key = `${channel.guildId}:${member.userId}`;
          seen.set(key, channel);
          presentMembers.set(key, member);
        }
      }

      let resumed = 0;
      let closed = 0;
      let opened = 0;

      for (const session of open) {
        const key = `${session.guildId}:${session.userId}`;
        const channel = seen.get(key);
        const member = presentMembers.get(key);

        if (!channel || !member) {
          // Closed at last_heartbeat_at — their last proven-present moment,
          // rather than now(), which would credit the outage.
          await deps.sessions.close(session.id, session.lastHeartbeatAt);
          closed++;
          continue;
        }

        const config = await deps.configs.get(session.guildId);
        const eligible = evaluateVoiceEligibility(member, channel, config.voice).eligible;

        // One operation, because the watermark must move to now whatever the
        // previous eligibility was — that IS the "downtime is not credited"
        // rule, and expressing it as a sequence of eligibility flips almost
        // works and cannot be read.
        await deps.sessions.resume(session.id, channel.channelId, eligible);
        resumed++;
      }

      const openByKey = new Set(open.map((s) => `${s.guildId}:${s.userId}`));
      for (const [key, channel] of seen) {
        if (openByKey.has(key)) continue;
        const member = presentMembers.get(key);
        if (!member || member.isBot) continue;

        const config = await deps.configs.get(channel.guildId);
        if (!config.enabled || !config.sources.voice.enabled) continue;

        await deps.sessions.open({
          guildId: channel.guildId,
          userId: member.userId,
          channelId: channel.channelId,
          eligible: evaluateVoiceEligibility(member, channel, config.voice).eligible,
        });
        opened++;
      }

      deps.log.info({ resumed, closed, opened, orphaned }, 'voice sessions reconciled');
      return { resumed, closed, opened, orphaned };
    },

    /**
     * Graceful shutdown: credit every open session's partial interval and leave
     * the sessions OPEN. The members are still in voice — closing them would
     * make the next startup treat a clean restart as everyone having left.
     */
    async flushAll() {
      const open = await deps.sessions.allOpen();
      let flushed = 0;

      for (const session of open) {
        if (!session.isEligible) continue;
        const config = await deps.configs.get(session.guildId);
        if (await creditSession(session.id, config)) flushed++;
      }

      if (flushed > 0) deps.log.info({ flushed }, 'flushed voice credit before shutdown');
      return flushed;
    },
  };
}

/**
 * Voice XP does not consult member roles.
 *
 * Role-scoped restrictions and boosters for voice would need a member fetch per
 * tick — hundreds of API calls a minute on a busy server — for a feature nobody
 * has asked for. Documented here rather than silently omitted; the pipeline
 * still applies channel, category, guild and source rules normally.
 */
function memberContextFor(userId: Snowflake): MemberContext {
  return {
    userId,
    roleIds: [],
    isBot: false,
    isWebhook: false,
    isSelf: false,
    isIgnored: false,
    currentTotalXp: 0,
    currentLevel: 0,
  };
}

/** Re-exported so adapters can build a snapshot without reaching into domain/. */
export type { VoiceConfig, VoiceMemberState };
