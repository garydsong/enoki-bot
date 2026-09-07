import type { Database } from '../../../platform/db/pool.js';
import type { Logger } from '../../../platform/logging/logger.js';
import type { ConfigCache } from '../ports/config.js';
import type { MemberXpRepository } from '../ports/memberXp.js';
import type { RewardReconciler } from '../ports/rewards.js';

/**
 * `/level reward backfill` — reconcile every member at once (AR-7, roadmap M15).
 *
 * The use case exists because reward reconciliation is LEVEL-TRIGGERED. An
 * admin who adds "@Regular at level 10" to a server that has been running for a
 * year has just described a rule that nobody will match until they next level
 * up — and for a member at max level, never. Backfill is how the configuration
 * catches up with the members who already earned it.
 *
 * Four properties, in the order they matter:
 *
 * 1. **DRY RUN IS THE DEFAULT.** The first thing an admin does with a mass role
 *    operation should be look at it. The caller passes `apply: true` to make it
 *    real, and the dry run walks exactly the same code (see `ReconcileOptions`).
 *
 * 2. **ONE RUN PER GUILD.** Concurrency here means two passes granting the same
 *    role to the same member at the same time, doubling the API cost of an
 *    already-expensive operation. The claim is a row in `job_run`, the same
 *    mechanism the Highlights job uses — it survives a restart, and it is
 *    visible to a second process, which an in-memory flag would not be.
 *
 * 3. **PACED.** Discord's per-guild role endpoints are the tightest budget the
 *    bot spends. A backfill of ten thousand members that runs flat out gets the
 *    bot rate-limited for everything else it does, including the messages the
 *    members are still sending. So the loop is deliberately slow.
 *
 * 4. **CANCELLABLE, and cancellable from ANYWHERE.** The signal is the claim
 *    row's status, checked at every batch boundary, so a button press in
 *    Discord stops a run that a different process may be executing.
 */

export const BACKFILL_JOB = 'leveling:reward_backfill';

/** Members fetched per keyset page. Bounded by memory, not by the API. */
const PAGE_SIZE = 200;

/**
 * Members reconciled per second when APPLYING.
 *
 * Each one is up to two role calls, so five members per second is a ceiling of
 * ten role writes per second against Discord's global budget of fifty requests
 * per second — leaving the bot's ordinary traffic room to breathe. A dry run
 * makes no API calls of its own beyond the member fetch and runs unthrottled.
 */
const APPLY_PER_SECOND = 5;

export interface BackfillProgress {
  readonly scanned: number;
  readonly changed: number;
  readonly rolesAdded: number;
  readonly rolesRemoved: number;
  readonly broken: number;
  readonly done: boolean;
  readonly cancelled: boolean;
}

export interface BackfillRequest {
  readonly guildId: string;
  readonly actorId: string;
  readonly apply: boolean;
  /** Also visit members who have left. Off by default: they hold no roles. */
  readonly includeDeparted?: boolean;
  /** Called at most every `reportEveryMs`, and once at the end. */
  readonly onProgress?: (progress: BackfillProgress) => void | Promise<void>;
  readonly reportEveryMs?: number;
}

export type BackfillOutcome =
  | { readonly status: 'completed'; readonly progress: BackfillProgress }
  | { readonly status: 'cancelled'; readonly progress: BackfillProgress }
  | { readonly status: 'already_running'; readonly startedAt: Date | null }
  | { readonly status: 'no_rules' };

export interface RewardBackfillDeps {
  readonly db: Database;
  readonly configs: ConfigCache;
  readonly memberXp: MemberXpRepository;
  readonly reconciler: RewardReconciler;
  readonly log: Logger;
  /** Injected so tests do not spend real seconds proving the pacing works. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface RewardBackfill {
  run(request: BackfillRequest): Promise<BackfillOutcome>;
  /** Ask a running backfill to stop. True when there was one to stop. */
  cancel(guildId: string): Promise<boolean>;
  status(guildId: string): Promise<'running' | 'cancelling' | 'idle'>;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export function createRewardBackfill(deps: RewardBackfillDeps): RewardBackfill {
  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? Date.now;

  /**
   * Take the guild's backfill slot, or report who has it.
   *
   * The conflict clause is the interesting half: a claim is granted when no row
   * exists, when the previous run FINISHED, or when a run has been "running"
   * for over an hour — which means the process holding it died. Without that
   * last clause one crash would lock the guild out of backfilling forever, and
   * the fix would be an admin editing the database.
   */
  const claim = async (guildId: string): Promise<{ won: boolean; startedAt: Date | null }> => {
    const { rows } = await deps.db.query<{ won: boolean; started_at: Date | null }>(
      `INSERT INTO job_run (job_name, scope_key, status, started_at)
       VALUES ($1, $2, 'running', now())
       ON CONFLICT (job_name, scope_key) DO UPDATE
         SET status = 'running', started_at = now(), finished_at = NULL, error = NULL
         WHERE job_run.status <> 'running'
            OR job_run.started_at < now() - interval '1 hour'
       RETURNING true AS won, started_at`,
      [BACKFILL_JOB, guildId],
    );

    if (rows.length > 0) return { won: true, startedAt: null };

    // The upsert's WHERE refused, so somebody else holds it. Report since when.
    const existing = await deps.db.query<{ started_at: Date | null }>(
      `SELECT started_at FROM job_run WHERE job_name = $1 AND scope_key = $2`,
      [BACKFILL_JOB, guildId],
    );
    return { won: false, startedAt: existing.rows[0]?.started_at ?? null };
  };

  const release = async (
    guildId: string,
    status: 'succeeded' | 'failed',
    note: string | null,
  ): Promise<void> => {
    await deps.db.query(
      `UPDATE job_run SET status = $3, finished_at = now(), error = $4
       WHERE job_name = $1 AND scope_key = $2`,
      [BACKFILL_JOB, guildId, status, note],
    );
  };

  const isCancelled = async (guildId: string): Promise<boolean> => {
    const { rows } = await deps.db.query<{ status: string }>(
      `SELECT status FROM job_run WHERE job_name = $1 AND scope_key = $2`,
      [BACKFILL_JOB, guildId],
    );
    return rows[0]?.status === 'cancelling';
  };

  return {
    async cancel(guildId) {
      const result = await deps.db.query(
        `UPDATE job_run SET status = 'cancelling'
         WHERE job_name = $1 AND scope_key = $2 AND status = 'running'`,
        [BACKFILL_JOB, guildId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async status(guildId) {
      const { rows } = await deps.db.query<{ status: string }>(
        `SELECT status FROM job_run WHERE job_name = $1 AND scope_key = $2`,
        [BACKFILL_JOB, guildId],
      );
      const status = rows[0]?.status;
      return status === 'running' || status === 'cancelling' ? status : 'idle';
    },

    async run(request) {
      const config = await deps.configs.get(request.guildId);
      if (config.rewards.length === 0) return { status: 'no_rules' };

      const claimed = await claim(request.guildId);
      if (!claimed.won) {
        return { status: 'already_running', startedAt: claimed.startedAt };
      }

      const reportEveryMs = request.reportEveryMs ?? 2_000;
      let scanned = 0;
      let changed = 0;
      let rolesAdded = 0;
      let rolesRemoved = 0;
      const brokenRoles = new Set<string>();
      let cancelled = false;
      let after: string | null = null;
      let lastReport = 0;

      const snapshot = (done: boolean): BackfillProgress => ({
        scanned,
        changed,
        rolesAdded,
        rolesRemoved,
        broken: brokenRoles.size,
        done,
        cancelled,
      });

      const report = async (done: boolean): Promise<void> => {
        if (!request.onProgress) return;
        if (!done && now() - lastReport < reportEveryMs) return;
        lastReport = now();
        try {
          await request.onProgress(snapshot(done));
        } catch (error) {
          // A failed progress edit (an expired token, a deleted message) must
          // not abort the work the admin actually asked for.
          deps.log.debug({ err: error, guildId: request.guildId }, 'backfill progress failed');
        }
      };

      try {
        for (;;) {
          const page = await deps.memberXp.pageMembers(request.guildId, {
            afterUserId: after,
            limit: PAGE_SIZE,
            includeDeparted: request.includeDeparted ?? false,
          });
          if (page.length === 0) break;

          for (const member of page) {
            // Checked per member rather than per page: a page is up to 200
            // members, which at the applied rate is forty seconds of a Cancel
            // button appearing to do nothing.
            if (await isCancelled(request.guildId)) {
              cancelled = true;
              break;
            }

            const result = await deps.reconciler.reconcile(
              request.guildId,
              member.userId,
              member.level,
              config,
              { dryRun: !request.apply },
            );

            scanned += 1;
            if (result.added.length > 0 || result.removed.length > 0) changed += 1;
            rolesAdded += result.added.length;
            rolesRemoved += result.removed.length;
            for (const entry of result.broken) brokenRoles.add(entry.roleId);

            // The bot losing Manage Roles part-way through is not something to
            // discover ten thousand members later.
            if (result.skipped === 'no_permission') {
              cancelled = true;
              break;
            }

            after = member.userId;
            await report(false);
            if (request.apply) await sleep(1000 / APPLY_PER_SECOND);
          }

          if (cancelled) break;
          if (page.length < PAGE_SIZE) break;
        }

        await report(true);
        await release(
          request.guildId,
          'succeeded',
          cancelled ? 'cancelled' : request.apply ? null : 'dry run',
        );

        deps.log.info(
          {
            guildId: request.guildId,
            actor: request.actorId,
            apply: request.apply,
            scanned,
            changed,
            rolesAdded,
            rolesRemoved,
            cancelled,
          },
          'reward backfill finished',
        );

        return cancelled
          ? { status: 'cancelled', progress: snapshot(true) }
          : { status: 'completed', progress: snapshot(true) };
      } catch (error) {
        // Released on the way out, always: a claim left behind by a thrown
        // error would lock the guild out for the full hour of the stale-claim
        // window, for a failure that is over.
        await release(
          request.guildId,
          'failed',
          error instanceof Error ? error.message.slice(0, 200) : 'unknown error',
        ).catch(() => undefined);
        throw error;
      }
    },
  };
}
