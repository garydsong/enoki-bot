import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { createGuildRepository } from '../../src/platform/guilds/guildRepository.js';
import { createRetentionJob } from '../../src/modules/leveling/adapters/jobs/retention.js';
import { createConfigRepository } from '../../src/modules/leveling/infrastructure/repositories/configRepository.js';
import type { ModuleContext } from '../../src/platform/plugin/types.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';

const CORE = join(import.meta.dirname, '..', '..', 'migrations');
const LEVELING = join(import.meta.dirname, '..', '..', 'src', 'modules', 'leveling', 'migrations');

const GUILD = '111111111111111111';
const USER = '222222222222222222';

let temp: TempDatabase | null = null;
afterEach(async () => {
  await temp?.drop();
  temp = null;
});

async function setup() {
  temp = await createTempDatabase();
  await runMigrations(temp.db, [CORE, LEVELING], silentLogger);
  await createGuildRepository(temp.db).upsert(GUILD, 'Test Guild');
  await createConfigRepository(temp.db).ensure(GUILD);

  const job = createRetentionJob({ auditDays: 90, voiceSessionDays: 30, periodXpDays: 400 });
  const ctx = { db: temp.db, log: silentLogger, client: {} } as unknown as ModuleContext;
  return { db: temp.db, job, ctx };
}

describe.runIf(await postgresAvailable())('retention', () => {
  it('removes audit entries past the window and keeps recent ones', async () => {
    const { db, job, ctx } = await setup();
    await db.query(
      `INSERT INTO audit_log (guild_id, action, created_at)
       VALUES ($1, 'old', now() - interval '200 days'),
              ($1, 'recent', now() - interval '10 days')`,
      [GUILD],
    );

    await job.run(ctx);

    const { rows } = await db.query<{ action: string }>(`SELECT action FROM audit_log`);
    expect(rows.map((r) => r.action)).toEqual(['recent']);
  });

  it('removes closed voice sessions but never an OPEN one', async () => {
    // An open session belongs to someone who may still be in voice. Deleting it
    // by age would strand their accrued time and, on the next reconcile, look
    // like they had never joined.
    const { db, job, ctx } = await setup();
    await db.query(
      `INSERT INTO voice_session (guild_id, user_id, channel_id, started_at, ended_at)
       VALUES ($1, $2, '333', now() - interval '90 days', now() - interval '89 days'),
              ($1, '444', '333', now() - interval '90 days', NULL)`,
      [GUILD, USER],
    );

    await job.run(ctx);

    const { rows } = await db.query<{ user_id: string; ended_at: Date | null }>(
      `SELECT user_id, ended_at FROM voice_session`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ended_at).toBeNull();
  });

  it('removes ancient period buckets and keeps the current ones', async () => {
    const { db, job, ctx } = await setup();
    await db.query(
      `INSERT INTO member_period_xp (guild_id, user_id, period_type, period_start, xp)
       VALUES ($1, $2, 'week', now() - interval '500 days', 100),
              ($1, $2, 'week', now() - interval '3 days', 50)`,
      [GUILD, USER],
    );

    await job.run(ctx);

    const { rows } = await db.query<{ xp: string }>(`SELECT xp FROM member_period_xp`);
    expect(rows.map((r) => r.xp)).toEqual(['50']);
  });

  it('NEVER touches member XP, statistics or configuration', async () => {
    // The assertion that matters. "Retention" is exactly the kind of feature
    // that acquires scope until it deletes someone's level.
    const { db, job, ctx } = await setup();
    await db.query(
      `INSERT INTO member_xp (guild_id, user_id, total_xp, level, first_seen_at, updated_at)
       VALUES ($1, $2, 9999, 12, now() - interval '900 days', now() - interval '900 days')`,
      [GUILD, USER],
    );
    await db.query(
      `INSERT INTO member_stats (guild_id, user_id, messages_counted, updated_at)
       VALUES ($1, $2, 500, now() - interval '900 days')`,
      [GUILD, USER],
    );

    await job.run(ctx);

    const xp = await db.query<{ total_xp: string }>(`SELECT total_xp FROM member_xp`);
    expect(xp.rows[0]?.total_xp).toBe('9999');
    const stats = await db.query<{ messages_counted: string }>(
      `SELECT messages_counted FROM member_stats`,
    );
    expect(stats.rows[0]?.messages_counted).toBe('500');
    const config = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM leveling_config`,
    );
    expect(config.rows[0]?.count).toBe('1');
  });

  it('is a no-op on a fresh database', async () => {
    const { job, ctx } = await setup();
    await expect(job.run(ctx)).resolves.toBeUndefined();
  });

  it('deletes more rows than one batch holds', async () => {
    // Batched so no single statement holds locks on a table /xp writes to
    // synchronously — but it must still finish the job.
    const { db, job, ctx } = await setup();
    await db.query(
      `INSERT INTO audit_log (guild_id, action, created_at)
       SELECT $1, 'old', now() - interval '200 days' FROM generate_series(1, 120)`,
      [GUILD],
    );

    const small = createRetentionJob({
      auditDays: 90,
      voiceSessionDays: 30,
      periodXpDays: 400,
      batchSize: 25,
    });
    await small.run(ctx);
    void job;

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log`,
    );
    expect(rows[0]?.count).toBe('0');
  });
});
