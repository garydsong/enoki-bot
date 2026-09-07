import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { createGuildRepository } from '../../src/platform/guilds/guildRepository.js';
import { createHighlightsJob } from '../../src/modules/leveling/adapters/jobs/highlights.js';
import { createLeaderboardService } from '../../src/modules/leveling/application/queries/leaderboard.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';
import {
  currentPeriodStart,
  previousPeriodStart,
} from '../../src/modules/leveling/domain/periods/calendar.js';
import type { GuildLevelingConfig } from '../../src/modules/leveling/domain/types.js';
import type { ConfigCache } from '../../src/modules/leveling/ports/config.js';
import type { ModuleContext } from '../../src/platform/plugin/types.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';

const CORE = join(import.meta.dirname, '..', '..', 'migrations');
const LEVELING = join(import.meta.dirname, '..', '..', 'src', 'modules', 'leveling', 'migrations');

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
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
    highlights: {
      ...DEFAULT_LEVELING_CONFIG.highlights,
      enabled: true,
      channelId: CHANNEL,
      weekly: true,
      monthly: false,
      size: 3,
    },
    ...over,
  };
}

/** A guild whose one channel records what was sent to it. */
function fakeGuild(sent: unknown[]) {
  const me = {
    permissions: { has: () => true },
    roles: { highest: { position: 100 } },
  };
  const channel = {
    id: CHANNEL,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: (payload: unknown) => {
      sent.push(payload);
      return Promise.resolve({});
    },
  };
  return {
    id: GUILD,
    name: 'Test Guild',
    members: { me, fetch: () => Promise.resolve(null) },
    channels: { cache: new Map([[CHANNEL, channel]]) },
    roles: { cache: new Map() },
  };
}

async function setup(cfg = config()) {
  temp = await createTempDatabase();
  await runMigrations(temp.db, [CORE, LEVELING], silentLogger);
  await createGuildRepository(temp.db).upsert(GUILD, 'Test Guild');

  const sent: unknown[] = [];
  const configs: ConfigCache = {
    get: () => Promise.resolve(cfg),
    invalidate: () => {},
    clear: () => {},
    stats: { hits: 0, misses: 0, revalidations: 0 },
  };

  const job = createHighlightsJob({
    db: temp.db,
    configs,
    boards: createLeaderboardService(temp.db),
  });

  const ctx = {
    db: temp.db,
    log: silentLogger,
    client: { guilds: { cache: new Map([[GUILD, fakeGuild(sent)]]) } },
  } as unknown as ModuleContext;

  return { db: temp.db, job, ctx, sent, cfg };
}

/** Put XP into the period that has just ENDED. */
async function seedFinishedWeek(db: TempDatabase['db'], cfg: GuildLevelingConfig) {
  const currentStart = currentPeriodStart(Date.now(), 'week', cfg.timezone, cfg.weekStartDay);
  const finishedStart = previousPeriodStart(
    currentStart,
    'week',
    cfg.timezone,
    cfg.weekStartDay,
  );

  for (const [index, xp] of [300, 200, 100, 50].entries()) {
    const id = user(index + 1);
    await db.query(
      `INSERT INTO member_xp (guild_id, user_id, total_xp, level, display_name)
       VALUES ($1, $2, $3, 1, $4)`,
      [GUILD, id, xp, `member ${index + 1}`],
    );
    await db.query(
      `INSERT INTO member_period_xp (guild_id, user_id, period_type, period_start, xp)
       VALUES ($1, $2, 'week', $3, $4)`,
      [GUILD, id, new Date(finishedStart), xp],
    );
  }

  return finishedStart;
}

describe.runIf(await postgresAvailable())('Highlights', () => {
  it('posts the finished period’s board', async () => {
    const { db, job, ctx, sent, cfg } = await setup();
    await seedFinishedWeek(db, cfg);

    await job.run(ctx);

    expect(sent).toHaveLength(1);
    const embed = (sent[0] as { embeds: { data: { description: string } }[] }).embeds[0];
    expect(embed?.data.description).toContain('300');
    // `size: 3` — the fourth member is not listed.
    expect(embed?.data.description).not.toContain('50 XP');
  });

  it('POSTS EXACTLY ONCE, however many times the job runs', async () => {
    // The job runs hourly and the process restarts on every deploy, so "post
    // when the period ends" cannot be a timer. The claim is what makes it safe.
    const { db, job, ctx, sent, cfg } = await setup();
    await seedFinishedWeek(db, cfg);

    await job.run(ctx);
    await job.run(ctx);
    await job.run(ctx);

    expect(sent).toHaveLength(1);
  });

  it('still posts only once after a restart', async () => {
    // A brand-new job object over the same database, as after a deploy.
    const { db, job, ctx, sent, cfg } = await setup();
    await seedFinishedWeek(db, cfg);
    await job.run(ctx);

    const afterRestart = createHighlightsJob({
      db,
      configs: {
        get: () => Promise.resolve(cfg),
        invalidate: () => {},
        clear: () => {},
        stats: { hits: 0, misses: 0, revalidations: 0 },
      },
      boards: createLeaderboardService(db),
    });
    await afterRestart.run(ctx);

    expect(sent).toHaveLength(1);
  });

  it('records the claim against the period, not the run', async () => {
    const { db, job, ctx, cfg } = await setup();
    const finishedStart = await seedFinishedWeek(db, cfg);
    await job.run(ctx);

    const { rows } = await db.query<{ scope_key: string; status: string }>(
      `SELECT scope_key, status FROM job_run WHERE job_name = 'leveling:highlights'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scope_key).toBe(
      `${GUILD}:week:${new Date(finishedStart).toISOString()}`,
    );
    expect(rows[0]?.status).toBe('succeeded');
  });

  it('marks a stale period done WITHOUT posting it', async () => {
    // Returning from a fortnight of downtime, announcing a two-week-old board
    // is noise — and announcing every backlogged period at once is worse.
    const { db, job, ctx, sent, cfg } = await setup(
      config({
        highlights: { ...config().highlights, graceHours: 1 },
      }),
    );
    await seedFinishedWeek(db, cfg);

    await job.run(ctx);

    expect(sent).toHaveLength(0);
    const { rows } = await db.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM job_run WHERE job_name = 'leveling:highlights'`,
    );
    // Claimed and finished, so it is never reconsidered.
    expect(rows[0]?.status).toBe('succeeded');
    expect(rows[0]?.error).toContain('grace');
  });

  it('says nothing when nobody earned anything', async () => {
    const { job, ctx, sent } = await setup();
    await job.run(ctx);
    expect(sent).toHaveLength(0);
  });

  it('does nothing when Highlights are off', async () => {
    const { db, job, ctx, sent, cfg } = await setup(
      config({ highlights: { ...config().highlights, enabled: false } }),
    );
    await seedFinishedWeek(db, cfg);

    await job.run(ctx);

    expect(sent).toHaveLength(0);
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM job_run WHERE job_name = 'leveling:highlights'`,
    );
    // Not even claimed: turning Highlights on later should still announce.
    expect(rows[0]?.count).toBe('0');
  });

  it('reads the FINISHED period, not the current one', async () => {
    // `now` selects the bucket, so reporting has to happen from an instant
    // inside the period being reported.
    const { db, job, ctx, sent, cfg } = await setup();
    await seedFinishedWeek(db, cfg);

    const currentStart = currentPeriodStart(Date.now(), 'week', cfg.timezone, cfg.weekStartDay);
    await db.query(
      `INSERT INTO member_period_xp (guild_id, user_id, period_type, period_start, xp)
       VALUES ($1, $2, 'week', $3, 99999)`,
      [GUILD, user(9), new Date(currentStart)],
    );
    await db.query(
      `INSERT INTO member_xp (guild_id, user_id, total_xp, level, display_name)
       VALUES ($1, $2, 99999, 9, 'this week')`,
      [GUILD, user(9)],
    );

    await job.run(ctx);

    const embed = (sent[0] as { embeds: { data: { description: string } }[] }).embeds[0];
    expect(embed?.data.description).not.toContain('99,999');
    expect(embed?.data.description).toContain('300');
  });

  it('keeps guilds independent', async () => {
    const { db, job, ctx, cfg } = await setup();
    await seedFinishedWeek(db, cfg);
    await job.run(ctx);

    // A second guild's claim must not collide with the first's.
    await createGuildRepository(db).upsert('999999999999999999', 'Other');
    const sent: unknown[] = [];
    const other = { ...fakeGuild(sent), id: '999999999999999999' };
    (ctx.client.guilds.cache as Map<string, unknown>).set('999999999999999999', other);

    await job.run(ctx);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM job_run WHERE job_name = 'leveling:highlights'`,
    );
    expect(rows[0]?.count).toBe('2');
  });

  it('survives a guild that throws without abandoning the others', async () => {
    const { db, job, ctx, cfg } = await setup();
    await seedFinishedWeek(db, cfg);

    const exploding = {
      id: '888888888888888888',
      get name(): string {
        throw new Error('boom');
      },
    };
    const cache = ctx.client.guilds.cache as unknown as Map<string, unknown>;
    const rebuilt = new Map<string, unknown>([['888888888888888888', exploding], ...cache]);
    (ctx.client.guilds as { cache: Map<string, unknown> }).cache = rebuilt;

    await expect(job.run(ctx)).resolves.toBeUndefined();

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM job_run WHERE job_name = 'leveling:highlights'`,
    );
    expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(1);
  });
});

describe('the job definition', () => {
  it('runs at boot, because a restart can span a period boundary', () => {
    const job = createHighlightsJob({
      db: {} as never,
      configs: {} as never,
      boards: {} as never,
    });
    expect(job.skipInitialRun).toBe(false);
    expect(job.intervalMs).toBe(3_600_000);
    void vi;
  });
});
