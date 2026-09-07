import type { JobDefinition, ModuleContext } from '../../../../platform/plugin/types.js';

/**
 * Data retention (spec `08` §5, roadmap M10).
 *
 * THE RULE THAT MATTERS IS WHAT THIS DOES NOT TOUCH.
 *
 * `member_xp`, `member_stats`, `leveling_config`, `xp_rule` and `role_reward`
 * are never aged out by anything. Deleting a member's level because a cleanup
 * job ran would be the single worst bug this system could have, and "retention"
 * is exactly the kind of feature that acquires scope until it does. The three
 * tables below are operational residue whose value genuinely expires:
 *
 *   audit_log        who changed what, months ago
 *   voice_session    closed sessions; their XP is already in member_xp, and
 *                    the row only survives to answer "why was I credited that?"
 *   member_period_xp last year's weekly boards
 *
 * Deletion is BATCHED. A guild with two years of audit history would otherwise
 * produce a single DELETE holding locks for seconds on a table the /xp commands
 * write to synchronously.
 */

export interface RetentionOptions {
  readonly auditDays: number;
  readonly voiceSessionDays: number;
  readonly periodXpDays: number;
  /**
   * Reaction dedup records. LONG by default and deliberately so: this table IS
   * the anti-farming guarantee, and deleting a row re-opens the "remove and
   * re-react" loop for that message. A year means a farm has to wait a year.
   */
  readonly reactionAwardDays?: number;
  /** Rows per statement. Bounded so no single delete holds long locks. */
  readonly batchSize?: number;
}

export function createRetentionJob(options: RetentionOptions): JobDefinition {
  const batchSize = options.batchSize ?? 5_000;

  return {
    name: 'leveling:retention',
    intervalMs: 24 * 3_600_000,
    // Not at boot: a restart loop would otherwise run this on every restart,
    // and there is never anything urgent about deleting a 90-day-old row.
    skipInitialRun: true,

    async run(ctx: ModuleContext) {
      const deleted = {
        audit: await purge(
          ctx,
          `DELETE FROM audit_log WHERE id IN (
             SELECT id FROM audit_log
             WHERE created_at < now() - make_interval(days => $1)
             LIMIT $2)`,
          options.auditDays,
          batchSize,
        ),
        voiceSessions: await purge(
          ctx,
          `DELETE FROM voice_session WHERE id IN (
             SELECT id FROM voice_session
             WHERE ended_at IS NOT NULL
               AND ended_at < now() - make_interval(days => $1)
             LIMIT $2)`,
          options.voiceSessionDays,
          batchSize,
        ),
        reactionAwards: await purge(
          ctx,
          `DELETE FROM reaction_award WHERE ctid IN (
             SELECT ctid FROM reaction_award
             WHERE awarded_at < now() - make_interval(days => $1)
             LIMIT $2)`,
          options.reactionAwardDays ?? 365,
          batchSize,
        ),
        // Expired boosters are already INERT — the resolver checks expiry at
        // read time, so this is tidiness rather than correctness. Left alone
        // they accumulate in `/level restrict list` until an admin cannot see
        // the rules that still matter.
        expiredBoosters: await purge(
          ctx,
          `DELETE FROM xp_rule WHERE id IN (
             SELECT id FROM xp_rule
             WHERE kind = 'boost'
               AND expires_at IS NOT NULL
               AND expires_at < now() - make_interval(days => $1)
             LIMIT $2)`,
          1,
          batchSize,
        ),
        periodXp: await purge(
          ctx,
          `DELETE FROM member_period_xp
           WHERE (guild_id, user_id, period_type, period_start) IN (
             SELECT guild_id, user_id, period_type, period_start
             FROM member_period_xp
             WHERE period_start < now() - make_interval(days => $1)
             LIMIT $2)`,
          options.periodXpDays,
          batchSize,
        ),
      };

      const total =
        deleted.audit +
        deleted.voiceSessions +
        deleted.periodXp +
        deleted.reactionAwards +
        deleted.expiredBoosters;
      if (total > 0) ctx.log.info(deleted, 'retention removed expired operational rows');
    },
  };
}

/**
 * Delete in bounded batches until a pass removes nothing.
 *
 * The loop is capped as well as the batch: if something is producing rows
 * faster than this deletes them, running forever inside one job tick would
 * starve the scheduler's single-flight slot, and stopping early simply means
 * the rest goes tomorrow.
 */
async function purge(
  ctx: ModuleContext,
  sql: string,
  days: number,
  batchSize: number,
  maxBatches = 20,
): Promise<number> {
  let total = 0;

  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await ctx.db.query(sql, [days, batchSize]);
    const removed = result.rowCount ?? 0;
    total += removed;
    if (removed < batchSize) break;
  }

  return total;
}
