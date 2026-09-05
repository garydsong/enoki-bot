import type { Database } from '../db/pool.js';
import type { Logger } from '../logging/logger.js';
import type { JobDefinition, ModuleContext } from '../plugin/types.js';
import { noopMetrics, type MetricsSink } from '../metrics/metrics.js';

/**
 * In-process scheduler (spec `07` §4.11).
 *
 * No broker. Every job here is either idempotent (highlights, first-place,
 * retention) or self-healing (the voice tick reconciles on startup), so durable
 * queuing solves a problem we do not have at this scale. `pg-boss` is the
 * documented migration point once there are two processes.
 *
 * SINGLE-FLIGHT IS THE POINT. A job that overruns its interval must skip, not
 * stack — a voice tick that takes 4 minutes on a 3-minute interval would
 * otherwise accumulate overlapping runs and double-credit XP.
 *
 * Every run is recorded in `job_run`, because the worst failure mode in this
 * system is a job that silently stops: voice XP simply ceases, with no error
 * anywhere. `lastSuccess()` is what /level debug health reads to catch that.
 */

export interface SchedulerOptions {
  readonly db: Database;
  readonly log: Logger;
  readonly ctx: ModuleContext;
  readonly metrics?: MetricsSink;
}

interface Scheduled {
  readonly job: JobDefinition;
  timer?: NodeJS.Timeout;
  running: boolean;
}

export class Scheduler {
  private readonly jobs = new Map<string, Scheduled>();
  private stopped = false;

  private readonly metrics: MetricsSink;

  constructor(private readonly options: SchedulerOptions) {
    this.metrics = options.metrics ?? noopMetrics;
  }

  add(job: JobDefinition): void {
    if (this.jobs.has(job.name)) {
      throw new Error(`duplicate job name: ${job.name}`);
    }
    this.jobs.set(job.name, { job, running: false });
  }

  start(): void {
    for (const entry of this.jobs.values()) {
      if (!entry.job.skipInitialRun) void this.runOnce(entry);
      entry.timer = setInterval(() => void this.runOnce(entry), entry.job.intervalMs);
      // Do not hold the event loop open on this timer alone.
      entry.timer.unref();
    }
    this.options.log.info({ jobs: [...this.jobs.keys()] }, 'scheduler started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of this.jobs.values()) {
      if (entry.timer) clearInterval(entry.timer);
    }
    // Let an in-flight run finish rather than killing it mid-transaction.
    const deadline = Date.now() + 5_000;
    while ([...this.jobs.values()].some((e) => e.running) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.options.log.info('scheduler stopped');
  }

  /** Exposed for tests and for a future admin "run now" command. */
  async runOnce(entry: Scheduled): Promise<'ran' | 'skipped' | 'failed'> {
    if (this.stopped) return 'skipped';

    // Single-flight: an overrunning job skips its next tick.
    if (entry.running) {
      this.options.log.warn(
        { job: entry.job.name },
        'previous run still in progress, skipping this tick',
      );
      return 'skipped';
    }

    entry.running = true;
    const started = Date.now();
    const log = this.options.log.child({ job: entry.job.name });

    try {
      await this.options.db.query(
        `INSERT INTO job_run (job_name, scope_key, status, started_at, finished_at, error)
         VALUES ($1, '', 'running', now(), NULL, NULL)
         ON CONFLICT (job_name, scope_key)
         DO UPDATE SET status = 'running', started_at = now(), finished_at = NULL, error = NULL`,
        [entry.job.name],
      );

      await entry.job.run({ ...this.options.ctx, log });

      await this.options.db.query(
        `UPDATE job_run SET status = 'succeeded', finished_at = now()
         WHERE job_name = $1 AND scope_key = ''`,
        [entry.job.name],
      );

      this.metrics.increment('enoki_job_runs_total', { job: entry.job.name, outcome: 'ok' });
      this.metrics.observe('enoki_job_duration_ms', Date.now() - started, { job: entry.job.name });
      log.debug({ durationMs: Date.now() - started }, 'job finished');
      return 'ran';
    } catch (error) {
      this.metrics.increment('enoki_job_runs_total', { job: entry.job.name, outcome: 'failed' });
      this.metrics.observe('enoki_job_duration_ms', Date.now() - started, { job: entry.job.name });
      log.error({ err: error, durationMs: Date.now() - started }, 'job failed');
      try {
        await this.options.db.query(
          `UPDATE job_run SET status = 'failed', finished_at = now(), error = $2
           WHERE job_name = $1 AND scope_key = ''`,
          [entry.job.name, error instanceof Error ? error.message : String(error)],
        );
      } catch (recordError) {
        log.error({ err: recordError }, 'could not record the job failure');
      }
      return 'failed';
    } finally {
      entry.running = false;
    }
  }

  /** Test/debug hook. */
  get(name: string): Scheduled | undefined {
    return this.jobs.get(name);
  }
}

/** When did each job last succeed? Backs the health report. */
export async function lastSuccesses(
  db: Database,
): Promise<{ jobName: string; finishedAt: Date | null }[]> {
  const { rows } = await db.query<{ job_name: string; finished_at: Date | null }>(
    `SELECT job_name, max(finished_at) AS finished_at
     FROM job_run WHERE status = 'succeeded' GROUP BY job_name ORDER BY job_name`,
  );
  return rows.map((r) => ({ jobName: r.job_name, finishedAt: r.finished_at }));
}
