import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { Scheduler, lastSuccesses } from '../../src/platform/jobs/scheduler.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';
import type { ModuleContext } from '../../src/platform/plugin/types.js';

const CORE = join(import.meta.dirname, '..', '..', 'migrations');

let temp: TempDatabase | null = null;
afterEach(async () => {
  await temp?.drop();
  temp = null;
});

async function harness() {
  temp = await createTempDatabase();
  await runMigrations(temp.db, [CORE], silentLogger);
  const ctx = { log: silentLogger, db: temp.db, client: {} as never } as ModuleContext;
  return { db: temp.db, scheduler: new Scheduler({ db: temp.db, log: silentLogger, ctx }) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(await postgresAvailable())('scheduler', () => {
  it('runs a job and records success', async () => {
    const { db, scheduler } = await harness();
    let runs = 0;
    scheduler.add({ name: 'tick', intervalMs: 60_000, run: async () => { runs++; } });

    await scheduler.runOnce(scheduler.get('tick')!);

    expect(runs).toBe(1);
    const { rows } = await db.query<{ status: string; finished_at: Date | null }>(
      `SELECT status, finished_at FROM job_run WHERE job_name = 'tick'`,
    );
    expect(rows[0]?.status).toBe('succeeded');
    expect(rows[0]?.finished_at).toBeInstanceOf(Date);
  });

  it('records a failure without throwing out of the scheduler', async () => {
    const { db, scheduler } = await harness();
    scheduler.add({
      name: 'flaky',
      intervalMs: 60_000,
      run: async () => {
        throw new Error('job exploded');
      },
    });

    const outcome = await scheduler.runOnce(scheduler.get('flaky')!);
    expect(outcome).toBe('failed');

    const { rows } = await db.query<{ status: string; error: string }>(
      `SELECT status, error FROM job_run WHERE job_name = 'flaky'`,
    );
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toContain('job exploded');
  });

  /**
   * SINGLE-FLIGHT IS THE POINT. A voice tick that takes longer than its interval
   * must skip, not stack — overlapping runs would double-credit XP.
   */
  it('skips a tick while the previous run is still in flight', async () => {
    const { scheduler } = await harness();
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    scheduler.add({
      name: 'slow',
      intervalMs: 60_000,
      run: async () => {
        started++;
        await gate;
      },
    });

    const entry = scheduler.get('slow')!;
    const first = scheduler.runOnce(entry);
    await sleep(20);

    const second = await scheduler.runOnce(entry);
    expect(second).toBe('skipped');
    expect(started).toBe(1);

    release();
    expect(await first).toBe('ran');

    // Once the first finished, a later tick runs normally.
    expect(await scheduler.runOnce(entry)).toBe('ran');
    expect(started).toBe(2);
  });

  it('refuses two jobs with the same name', async () => {
    const { scheduler } = await harness();
    scheduler.add({ name: 'dup', intervalMs: 1000, run: async () => {} });
    expect(() => scheduler.add({ name: 'dup', intervalMs: 1000, run: async () => {} })).toThrow(
      /duplicate job name/,
    );
  });

  it('runs immediately on start, then on the interval', async () => {
    const { scheduler } = await harness();
    let runs = 0;
    scheduler.add({ name: 'fast', intervalMs: 40, run: async () => { runs++; } });

    scheduler.start();
    await sleep(140);
    await scheduler.stop();

    expect(runs).toBeGreaterThanOrEqual(2);
  });

  it('honours skipInitialRun', async () => {
    const { scheduler } = await harness();
    let runs = 0;
    scheduler.add({
      name: 'later',
      intervalMs: 10_000,
      skipInitialRun: true,
      run: async () => { runs++; },
    });

    scheduler.start();
    await sleep(60);
    await scheduler.stop();

    expect(runs).toBe(0);
  });

  it('stops cleanly and refuses further runs', async () => {
    const { scheduler } = await harness();
    let runs = 0;
    scheduler.add({ name: 'x', intervalMs: 20, run: async () => { runs++; } });
    scheduler.start();
    await sleep(50);
    await scheduler.stop();
    const after = runs;
    await sleep(60);
    expect(runs).toBe(after);
    expect(await scheduler.runOnce(scheduler.get('x')!)).toBe('skipped');
  });

  /**
   * The worst failure mode in this system is a job that silently stops — voice
   * XP just ceases, with no error anywhere. This query is what
   * /level debug health reads to catch it.
   */
  it('reports the last success time per job', async () => {
    const { db, scheduler } = await harness();
    scheduler.add({ name: 'alpha', intervalMs: 60_000, run: async () => {} });
    scheduler.add({ name: 'beta', intervalMs: 60_000, run: async () => {} });

    await scheduler.runOnce(scheduler.get('alpha')!);

    const seen = await lastSuccesses(db);
    const names = seen.map((s) => s.jobName);
    expect(names).toContain('alpha');
    expect(names).not.toContain('beta'); // never succeeded — exactly the signal
    expect(seen.find((s) => s.jobName === 'alpha')?.finishedAt).toBeInstanceOf(Date);
  });
});
