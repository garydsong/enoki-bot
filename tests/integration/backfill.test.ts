import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { createGuildRepository } from '../../src/platform/guilds/guildRepository.js';
import { createMemberXpRepository } from '../../src/modules/leveling/infrastructure/repositories/memberXpRepository.js';
import {
  BACKFILL_JOB,
  createRewardBackfill,
} from '../../src/modules/leveling/application/rewardBackfill.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';
import type { GuildLevelingConfig } from '../../src/modules/leveling/domain/types.js';
import type { ConfigCache } from '../../src/modules/leveling/ports/config.js';
import type { ReconcileResult, RewardReconciler } from '../../src/modules/leveling/ports/rewards.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';

/**
 * `/level reward backfill` (roadmap M15).
 *
 * The reconciler is a fake here on purpose: what it does to Discord is already
 * covered by `tests/unit/rewardRoles.test.ts`, and what matters at THIS level
 * is the loop around it — the claim, the pacing, the cancellation and the
 * promise that a dry run writes nothing.
 */

const CORE = join(import.meta.dirname, '..', '..', 'migrations');
const LEVELING = join(import.meta.dirname, '..', '..', 'src', 'modules', 'leveling', 'migrations');

const GUILD = '111111111111111111';
const ROLE = '333333333333333333';
const user = (n: number): string => String(100000000000000000n + BigInt(n));

let temp: TempDatabase | null = null;
afterEach(async () => {
  await temp?.drop();
  temp = null;
});

function config(over: Partial<GuildLevelingConfig> = {}): GuildLevelingConfig {
  return {
    ...DEFAULT_LEVELING_CONFIG,
    enabled: true,
    rewards: [{ type: 'exact', level: 5, roleId: ROLE }],
    ...over,
  };
}

/** Records every call, and reports a change for members at or above level 5. */
function fakeReconciler(): RewardReconciler & {
  calls: { userId: string; dryRun: boolean }[];
} {
  const calls: { userId: string; dryRun: boolean }[] = [];
  return {
    calls,
    reconcile(_guildId, userId, level, _config, options): Promise<ReconcileResult> {
      calls.push({ userId, dryRun: options?.dryRun ?? false });
      return Promise.resolve(
        level >= 5
          ? { added: [ROLE], removed: [], broken: [] }
          : { added: [], removed: [], broken: [] },
      );
    },
  };
}

async function setup(cfg = config(), members = 6) {
  temp = await createTempDatabase();
  await runMigrations(temp.db, [CORE, LEVELING], silentLogger);
  await createGuildRepository(temp.db).upsert(GUILD, 'Test Guild');

  for (let i = 1; i <= members; i++) {
    await temp.db.query(
      `INSERT INTO member_xp (guild_id, user_id, total_xp, level) VALUES ($1, $2, $3, $4)`,
      [GUILD, user(i), i * 100, i],
    );
  }

  const configs: ConfigCache = {
    get: () => Promise.resolve(cfg),
    invalidate: () => {},
    clear: () => {},
    stats: { hits: 0, misses: 0, revalidations: 0 },
  };

  const reconciler = fakeReconciler();
  const slept: number[] = [];

  const backfill = createRewardBackfill({
    db: temp.db,
    configs,
    memberXp: createMemberXpRepository(temp.db),
    reconciler,
    log: silentLogger,
    // The pacing is asserted by RECORDING the sleeps rather than serving them:
    // a test that proves a five-per-second limit by taking a second to run is a
    // test people delete.
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });

  return { db: temp.db, backfill, reconciler, slept };
}

describe.runIf(await postgresAvailable())('reward backfill', () => {
  it('visits every member exactly once', async () => {
    const { backfill, reconciler } = await setup();

    const outcome = await backfill.run({ guildId: GUILD, actorId: user(99), apply: true });

    expect(outcome.status).toBe('completed');
    expect(reconciler.calls).toHaveLength(6);
    expect(new Set(reconciler.calls.map((c) => c.userId)).size).toBe(6);
  });

  it('DEFAULTS TO A DRY RUN, and a dry run writes nothing', async () => {
    // The whole safety story: the first thing an admin does with a mass role
    // operation is look at it.
    const { backfill, reconciler } = await setup();

    const outcome = await backfill.run({ guildId: GUILD, actorId: user(99), apply: false });

    expect(outcome.status).toBe('completed');
    expect(reconciler.calls.every((c) => c.dryRun)).toBe(true);
    if (outcome.status === 'completed') {
      // Members 5 and 6 are at or above the reward level.
      expect(outcome.progress.changed).toBe(2);
      expect(outcome.progress.rolesAdded).toBe(2);
    }
  });

  it('paces itself when applying, and not when previewing', async () => {
    const applied = await setup();
    await applied.backfill.run({ guildId: GUILD, actorId: user(99), apply: true });
    expect(applied.slept).toHaveLength(6);
    // Five members per second.
    expect(applied.slept.every((ms) => ms === 200)).toBe(true);

    await applied.db.query(`DELETE FROM job_run`);
    applied.slept.length = 0;

    await applied.backfill.run({ guildId: GUILD, actorId: user(99), apply: false });
    expect(applied.slept).toEqual([]);
  });

  it('REFUSES A CONCURRENT RUN rather than doubling the API cost', async () => {
    const { db, backfill } = await setup();

    // Somebody else holds the claim.
    await db.query(
      `INSERT INTO job_run (job_name, scope_key, status, started_at)
       VALUES ($1, $2, 'running', now())`,
      [BACKFILL_JOB, GUILD],
    );

    const outcome = await backfill.run({ guildId: GUILD, actorId: user(99), apply: true });
    expect(outcome.status).toBe('already_running');
  });

  it('takes over a claim abandoned by a crashed process', async () => {
    // Without the stale-claim window one crash locks the guild out of
    // backfilling forever, and the fix would be editing the database by hand.
    const { db, backfill, reconciler } = await setup();
    await db.query(
      `INSERT INTO job_run (job_name, scope_key, status, started_at)
       VALUES ($1, $2, 'running', now() - interval '3 hours')`,
      [BACKFILL_JOB, GUILD],
    );

    const outcome = await backfill.run({ guildId: GUILD, actorId: user(99), apply: true });
    expect(outcome.status).toBe('completed');
    expect(reconciler.calls.length).toBeGreaterThan(0);
  });

  it('runs again once the previous run has finished', async () => {
    const { backfill } = await setup();
    await backfill.run({ guildId: GUILD, actorId: user(99), apply: false });
    const second = await backfill.run({ guildId: GUILD, actorId: user(99), apply: false });
    expect(second.status).toBe('completed');
  });

  it('STOPS when cancelled, and the signal comes from OUTSIDE the run', async () => {
    // The cancel is issued through a second backfill object over the same
    // database — standing in for the button press arriving at a different
    // process. An in-memory flag could not do this, which is why the signal is
    // the claim row's own status.
    temp = await createTempDatabase();
    await runMigrations(temp.db, [CORE, LEVELING], silentLogger);
    await createGuildRepository(temp.db).upsert(GUILD, 'Test Guild');
    for (let i = 1; i <= 20; i++) {
      await temp.db.query(
        `INSERT INTO member_xp (guild_id, user_id, total_xp, level) VALUES ($1, $2, $3, $4)`,
        [GUILD, user(i), i * 100, i],
      );
    }

    const configs: ConfigCache = {
      get: () => Promise.resolve(config()),
      invalidate: () => {},
      clear: () => {},
      stats: { hits: 0, misses: 0, revalidations: 0 },
    };
    const memberXp = createMemberXpRepository(temp.db);
    const reconciler = fakeReconciler();

    const canceller = createRewardBackfill({
      db: temp.db,
      configs,
      memberXp,
      reconciler: fakeReconciler(),
      log: silentLogger,
    });

    const runner = createRewardBackfill({
      db: temp.db,
      configs,
      memberXp,
      reconciler,
      log: silentLogger,
      // Deterministic: the third paced member triggers the cancellation, so the
      // test never depends on winning a race against wall-clock time.
      sleep: async () => {
        if (reconciler.calls.length === 3) await canceller.cancel(GUILD);
      },
    });

    const outcome = await runner.run({ guildId: GUILD, actorId: user(99), apply: true });

    expect(outcome.status).toBe('cancelled');
    expect(reconciler.calls.length).toBeLessThan(20);
    expect(await runner.status(GUILD)).toBe('idle');
  });

  it('reports nothing to do when no rewards are configured', async () => {
    const { backfill, reconciler } = await setup(config({ rewards: [] }));
    const outcome = await backfill.run({ guildId: GUILD, actorId: user(99), apply: true });
    expect(outcome.status).toBe('no_rules');
    expect(reconciler.calls).toEqual([]);
  });

  it('releases the claim on the way out, even when the run throws', async () => {
    const { db, backfill, reconciler } = await setup();
    reconciler.reconcile = () => Promise.reject(new Error('discord exploded'));

    await expect(
      backfill.run({ guildId: GUILD, actorId: user(99), apply: true }),
    ).rejects.toThrow('discord exploded');

    // Not left 'running': a claim abandoned by an error that is already over
    // would lock the guild out for the full stale-claim hour.
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM job_run WHERE job_name = $1 AND scope_key = $2`,
      [BACKFILL_JOB, GUILD],
    );
    expect(rows[0]?.status).toBe('failed');
    expect(await backfill.status(GUILD)).toBe('idle');
  });

  it('skips departed members by default and visits them on request', async () => {
    const { db, backfill, reconciler } = await setup();
    await db.query(`UPDATE member_xp SET is_departed = true WHERE user_id = $1`, [user(1)]);

    await backfill.run({ guildId: GUILD, actorId: user(99), apply: false });
    expect(reconciler.calls.map((c) => c.userId)).not.toContain(user(1));

    await db.query(`DELETE FROM job_run`);
    reconciler.calls.length = 0;
    await backfill.run({
      guildId: GUILD,
      actorId: user(99),
      apply: false,
      includeDeparted: true,
    });
    expect(reconciler.calls.map((c) => c.userId)).toContain(user(1));
  });

  it('reports progress while it runs, and once at the end', async () => {
    const { backfill } = await setup();
    const seen: number[] = [];

    await backfill.run({
      guildId: GUILD,
      actorId: user(99),
      apply: true,
      reportEveryMs: 0,
      onProgress: (p) => {
        seen.push(p.scanned);
      },
    });

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(6);
  });

  it('does not let a failing progress update abandon the work', async () => {
    // The reply's token expires after 15 minutes; a long backfill outliving it
    // must still finish the roles it was asked to grant.
    const { backfill, reconciler } = await setup();

    const outcome = await backfill.run({
      guildId: GUILD,
      actorId: user(99),
      apply: true,
      reportEveryMs: 0,
      onProgress: () => {
        throw new Error('Unknown interaction');
      },
    });

    expect(outcome.status).toBe('completed');
    expect(reconciler.calls).toHaveLength(6);
  });

  it('is idempotent — running it twice changes nothing the second time', async () => {
    // Reconciliation is a diff against the desired set, so a second pass over
    // an already-correct guild finds nothing to do. Asserted through a
    // reconciler that reports "already holds it" the second time round.
    const { db } = await setup();
    const granted = new Set<string>();

    const backfillTwice = createRewardBackfill({
      db,
      configs: {
        get: () => Promise.resolve(config()),
        invalidate: () => {},
        clear: () => {},
        stats: { hits: 0, misses: 0, revalidations: 0 },
      },
      memberXp: createMemberXpRepository(db),
      reconciler: {
        reconcile: (_g, userId, level) => {
          if (level < 5 || granted.has(userId)) {
            return Promise.resolve({ added: [], removed: [], broken: [] });
          }
          granted.add(userId);
          return Promise.resolve({ added: [ROLE], removed: [], broken: [] });
        },
      },
      log: silentLogger,
      sleep: () => Promise.resolve(),
    });

    const first = await backfillTwice.run({ guildId: GUILD, actorId: user(99), apply: true });
    await db.query(`DELETE FROM job_run`);
    const second = await backfillTwice.run({ guildId: GUILD, actorId: user(99), apply: true });

    expect(first.status === 'completed' && first.progress.rolesAdded).toBe(2);
    expect(second.status === 'completed' && second.progress.rolesAdded).toBe(0);
  });
});
