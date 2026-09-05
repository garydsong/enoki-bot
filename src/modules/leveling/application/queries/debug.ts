import { evaluateXp } from '../../domain/engine/pipeline.js';
import { getCurve } from '../../domain/curve/curve.js';
import { currentPeriodStart } from '../../domain/periods/calendar.js';
import type {
  Clock,
  GuildLevelingConfig,
  MemberContext,
  Rng,
  TraceStep,
  XpCandidate,
  XpDecision,
} from '../../domain/types.js';
import type { Database } from '../../../../platform/db/pool.js';

/**
 * `/level debug` — the differentiator (spec `08` §2, roadmap M8).
 *
 * The single most common support question for any leveling bot is "why didn't I
 * get XP?", and the honest answer usually involves a cooldown, a restriction, a
 * context toggle or a permission — four different subsystems. Making an admin
 * reason about that from configuration alone is how a bot acquires a reputation
 * for being broken when it is working exactly as configured.
 *
 * So the answer is not documentation, it is the engine itself: this runs the
 * REAL pipeline in collect-all mode against a synthesised candidate and renders
 * the trace. It cannot drift from the awarding path, because it IS the awarding
 * path — with two differences, both essential:
 *
 *   1. It writes nothing.
 *   2. It consumes no cooldown. A debug command that burns the cooldown it is
 *      reporting on would change the answer by asking the question.
 */

export interface DryRunInput {
  readonly candidate: XpCandidate;
  readonly member: MemberContext;
  readonly config: GuildLevelingConfig;
}

export interface DryRunResult {
  readonly decision: XpDecision;
  /** Only the steps that explain the outcome — passes are noise once it fails. */
  readonly failing: readonly TraceStep[];
  readonly trace: readonly TraceStep[];
}

/**
 * Evaluate without awarding. `collectAll` continues past the first denial so an
 * admin who fixes one problem is not immediately ambushed by a second — the
 * difference between one round trip and four.
 */
export function dryRun(input: DryRunInput, clock: Clock, rng: Rng): DryRunResult {
  const decision = evaluateXp(input.candidate, input.member, input.config, clock, rng, {
    collectAll: true,
  });

  return {
    decision,
    trace: decision.trace,
    failing: decision.trace.filter((step) => step.verdict === 'deny'),
  };
}

// ---------------------------------------------------------------------------
// Member snapshot
// ---------------------------------------------------------------------------

export interface MemberDebugRow {
  readonly totalXp: number;
  readonly level: number;
  readonly xpIntoLevel: number;
  readonly xpForNextLevel: number;
  readonly rank: number | null;
  readonly isDeparted: boolean;
  readonly lastXpAt: Date | null;
  readonly firstSeenAt: Date | null;
  readonly messagesCounted: number;
  readonly voiceSeconds: number;
  readonly reactionsGiven: number;
  readonly reactionsReceived: number;
  readonly levelups: number;
  readonly weeklyXp: number;
  readonly monthlyXp: number;
}

/** Everything stored about one member, in one round trip. */
export async function memberDebug(
  db: Database,
  guildId: string,
  userId: string,
  config: GuildLevelingConfig,
  now = Date.now(),
): Promise<MemberDebugRow | null> {
  const weekStart = new Date(
    currentPeriodStart(now, 'week', config.timezone, config.weekStartDay),
  );
  const monthStart = new Date(
    currentPeriodStart(now, 'month', config.timezone, config.weekStartDay),
  );

  const { rows } = await db.query<{
    total_xp: string;
    level: number;
    is_departed: boolean;
    last_xp_at: Date | null;
    first_seen_at: Date | null;
    rank: string | null;
    messages_counted: string | null;
    voice_seconds: string | null;
    reactions_given: string | null;
    reactions_received: string | null;
    levelups_count: string | null;
    weekly_xp: string | null;
    monthly_xp: string | null;
  }>(
    `SELECT m.total_xp,
            m.level,
            m.is_departed,
            m.last_xp_at,
            m.first_seen_at,
            CASE WHEN m.total_xp > 0 THEN (
              SELECT count(*) + 1 FROM member_xp o
              WHERE o.guild_id = m.guild_id AND o.total_xp > 0
                AND (o.total_xp > m.total_xp
                     OR (o.total_xp = m.total_xp AND o.user_id < m.user_id))
            ) END AS rank,
            s.messages_counted, s.voice_seconds, s.reactions_given,
            s.reactions_received, s.levelups_count,
            w.xp AS weekly_xp,
            mo.xp AS monthly_xp
     FROM member_xp AS m
     LEFT JOIN member_stats AS s
            ON s.guild_id = m.guild_id AND s.user_id = m.user_id
     LEFT JOIN member_period_xp AS w
            ON w.guild_id = m.guild_id AND w.user_id = m.user_id
           AND w.period_type = 'week' AND w.period_start = $3
     LEFT JOIN member_period_xp AS mo
            ON mo.guild_id = m.guild_id AND mo.user_id = m.user_id
           AND mo.period_type = 'month' AND mo.period_start = $4
     WHERE m.guild_id = $1 AND m.user_id = $2`,
    [guildId, userId, weekStart, monthStart],
  );

  const row = rows[0];
  if (!row) return null;

  const totalXp = Number(row.total_xp);
  const progress = getCurve(config.curve).progressFor(totalXp);

  return {
    totalXp,
    level: progress.level,
    xpIntoLevel: progress.xpIntoLevel,
    xpForNextLevel: progress.xpForNextLevel,
    rank: row.rank === null ? null : Number(row.rank),
    isDeparted: row.is_departed,
    lastXpAt: row.last_xp_at,
    firstSeenAt: row.first_seen_at,
    messagesCounted: Number(row.messages_counted ?? 0),
    voiceSeconds: Number(row.voice_seconds ?? 0),
    reactionsGiven: Number(row.reactions_given ?? 0),
    reactionsReceived: Number(row.reactions_received ?? 0),
    levelups: Number(row.levelups_count ?? 0),
    weeklyXp: Number(row.weekly_xp ?? 0),
    monthlyXp: Number(row.monthly_xp ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Guild health
// ---------------------------------------------------------------------------

export type HealthSeverity = 'ok' | 'warn' | 'error';

export interface HealthFinding {
  readonly severity: HealthSeverity;
  readonly title: string;
  readonly detail: string;
}

/**
 * Configuration that points at something which no longer exists.
 *
 * These are the quiet failures — a level-up channel that was deleted, a no-XP
 * rule for a channel that is gone, a reward role that was removed. None of them
 * produce an error anywhere; the feature simply stops working, and the admin
 * has no reason to suspect configuration they set up months ago.
 */
export interface DanglingTarget {
  readonly kind: 'levelup_channel' | 'rule_channel' | 'rule_role' | 'reward_role';
  readonly id: string;
  readonly detail: string;
}

export function findDanglingTargets(
  config: GuildLevelingConfig,
  exists: { channel(id: string): boolean; role(id: string): boolean },
): DanglingTarget[] {
  const dangling: DanglingTarget[] = [];

  if (
    config.notifications.mode === 'fixed_channel' &&
    config.notifications.channelId !== null &&
    !exists.channel(config.notifications.channelId)
  ) {
    dangling.push({
      kind: 'levelup_channel',
      id: config.notifications.channelId,
      detail: 'level-up messages are set to a channel that no longer exists',
    });
  }

  for (const rule of config.rules) {
    if (rule.targetId === null) continue;

    if (rule.targetType === 'channel' || rule.targetType === 'category') {
      if (!exists.channel(rule.targetId)) {
        dangling.push({
          kind: 'rule_channel',
          id: rule.targetId,
          detail: `a ${describeKind(rule.kind)} rule targets a deleted channel`,
        });
      }
    } else if (rule.targetType === 'role' && !exists.role(rule.targetId)) {
      dangling.push({
        kind: 'rule_role',
        id: rule.targetId,
        detail: `a ${describeKind(rule.kind)} rule targets a deleted role`,
      });
    }
  }

  for (const reward of config.rewards) {
    if (!exists.role(reward.roleId)) {
      dangling.push({
        kind: 'reward_role',
        id: reward.roleId,
        detail: 'a reward grants a role that no longer exists',
      });
    }
  }

  return dangling;
}

function describeKind(kind: string): string {
  switch (kind) {
    case 'restrict_deny':
      return 'no-XP';
    case 'restrict_only':
      return 'XP-only-here';
    default:
      return 'booster';
  }
}

/**
 * Configuration that is internally contradictory and therefore silently does
 * nothing — the class of problem that looks fine in `/level config view`.
 */
export function findConfigContradictions(config: GuildLevelingConfig): HealthFinding[] {
  const findings: HealthFinding[] = [];

  if (!config.enabled) {
    findings.push({
      severity: 'warn',
      title: 'Leveling is off',
      detail: 'Nothing earns XP. Turn it on with `/level config set enabled on`.',
    });
  }

  for (const [source, settings] of Object.entries(config.sources)) {
    if (settings.enabled && settings.minXp > settings.maxXp) {
      findings.push({
        severity: 'error',
        title: `${source} XP range is inverted`,
        detail: `xpMin (${settings.minXp}) is above xpMax (${settings.maxXp}), so nothing is awarded.`,
      });
    }
    if (settings.enabled && settings.maxXp === 0) {
      findings.push({
        severity: 'warn',
        title: `${source} awards zero XP`,
        detail: 'The source is enabled but its maximum is 0.',
      });
    }
  }

  // Restrictions always beat boosters (ADR-011), so a target that is both is a
  // booster that can never fire — legal, and almost never intended.
  for (const boost of config.rules.filter((r) => r.kind === 'boost')) {
    const denied = config.rules.some(
      (r) => r.kind === 'restrict_deny' && r.targetId === boost.targetId,
    );
    if (denied) {
      findings.push({
        severity: 'warn',
        title: 'A booster can never apply',
        detail: `<@&${boost.targetId ?? ''}> (or that channel) is both boosted and on the no-XP list. Restrictions always win.`,
      });
    }
  }

  const onlyRules = config.rules.filter((r) => r.kind === 'restrict_only');
  if (onlyRules.length > 0) {
    findings.push({
      severity: 'warn',
      title: `XP is restricted to ${onlyRules.length} place(s)`,
      detail: 'Everywhere else earns nothing. This is often set up and forgotten.',
    });
  }

  if (config.notifications.mode === 'fixed_channel' && config.notifications.channelId === null) {
    findings.push({
      severity: 'error',
      title: 'Level-up channel is not set',
      detail: 'Mode is `fixed_channel` but no channel was chosen, so nothing is announced.',
    });
  }

  if (config.effort.enabled) {
    findings.push({
      severity: 'warn',
      title: 'The effort bonus needs Message Content',
      detail: 'Without that intent it silently contributes nothing.',
    });
  }

  return findings;
}
