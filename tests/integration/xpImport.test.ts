import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { createGuildRepository } from '../../src/platform/guilds/guildRepository.js';
import { createMemberXpRepository } from '../../src/modules/leveling/infrastructure/repositories/memberXpRepository.js';
import { createXpImporter } from '../../src/modules/leveling/application/xpImport.js';
import { parseXpCsv } from '../../src/modules/leveling/domain/import/csv.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';
import type { GuildLevelingConfig } from '../../src/modules/leveling/domain/types.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';

/**
 * `/xp import` against a real database (roadmap M15).
 *
 * The parser has its own unit tests; these are about what reaches the tables —
 * that `set` really replaces and `add` really adds, that a batch is a
 * transaction, and above all that a preview leaves the database untouched.
 */

const CORE = join(import.meta.dirname, '..', '..', 'migrations');
const LEVELING = join(import.meta.dirname, '..', '..', 'src', 'modules', 'leveling', 'migrations');

const GUILD = '111111111111111111';
const user = (n: number): string => String(100000000000000000n + BigInt(n));

let temp: TempDatabase | null = null;
afterEach(async () => {
  await temp?.drop();
  temp = null;
});

const config: GuildLevelingConfig = { ...DEFAULT_LEVELING_CONFIG, enabled: true };

async function setup() {
  temp = await createTempDatabase();
  await runMigrations(temp.db, [CORE, LEVELING], silentLogger);
  await createGuildRepository(temp.db).upsert(GUILD, 'Test Guild');

  const memberXp = createMemberXpRepository(temp.db);
  const importer = createXpImporter({ db: temp.db, memberXp, log: silentLogger });
  return { db: temp.db, memberXp, importer };
}

async function totals(db: TempDatabase['db']): Promise<Record<string, number>> {
  const { rows } = await db.query<{ user_id: string; total_xp: string; level: number }>(
    `SELECT user_id, total_xp, level FROM member_xp WHERE guild_id = $1 ORDER BY user_id`,
    [GUILD],
  );
  return Object.fromEntries(rows.map((r) => [r.user_id, Number(r.total_xp)]));
}

describe.runIf(await postgresAvailable())('xp import', () => {
  it('imports members who do not exist here yet', async () => {
    const { db, importer } = await setup();
    const csv = `user_id,xp\n${user(1)},500\n${user(2)},1500`;

    const plan = await importer.plan(GUILD, csv, 'set', config);
    expect(plan.fresh).toBe(2);
    expect(plan.existing).toBe(0);

    await importer.apply(GUILD, plan.rows, 'set', config);

    expect(await totals(db)).toEqual({ [user(1)]: 500, [user(2)]: 1500 });
  });

  it('WRITES THE LEVEL, not just the XP', async () => {
    // The level column is a denormalised cache that SQL sorts by. An import
    // that filled in XP and left level at zero would produce a leaderboard
    // where everyone is level 0 — and nothing would ever fix it, because
    // levels are only recomputed on award.
    const { db, importer } = await setup();
    await importer.apply(
      GUILD,
      parseXpCsv(`user_id,xp\n${user(1)},100000`).rows,
      'set',
      config,
    );

    const { rows } = await db.query<{ level: number }>(
      `SELECT level FROM member_xp WHERE guild_id = $1 AND user_id = $2`,
      [GUILD, user(1)],
    );
    expect(rows[0]?.level).toBeGreaterThan(0);
  });

  it('set REPLACES an existing total', async () => {
    const { db, importer } = await setup();
    await db.query(
      `INSERT INTO member_xp (guild_id, user_id, total_xp, level) VALUES ($1, $2, 9999, 9)`,
      [GUILD, user(1)],
    );

    const plan = await importer.plan(GUILD, `user_id,xp\n${user(1)},100`, 'set', config);
    expect(plan.existing).toBe(1);
    expect(plan.resultingXp).toBe(100);

    await importer.apply(GUILD, plan.rows, 'set', config);
    expect((await totals(db))[user(1)]).toBe(100);
  });

  it('add ACCUMULATES onto an existing total', async () => {
    const { db, importer } = await setup();
    await db.query(
      `INSERT INTO member_xp (guild_id, user_id, total_xp, level) VALUES ($1, $2, 400, 4)`,
      [GUILD, user(1)],
    );

    const plan = await importer.plan(GUILD, `user_id,xp\n${user(1)},100`, 'add', config);
    expect(plan.resultingXp).toBe(500);

    await importer.apply(GUILD, plan.rows, 'add', config);
    expect((await totals(db))[user(1)]).toBe(500);
  });

  it('re-levels correctly in add mode, where the level depends on the RESULT', async () => {
    const { db, importer } = await setup();
    await db.query(
      `INSERT INTO member_xp (guild_id, user_id, total_xp, level) VALUES ($1, $2, 100, 1)`,
      [GUILD, user(1)],
    );

    await importer.apply(
      GUILD,
      parseXpCsv(`user_id,xp\n${user(1)},50000`).rows,
      'add',
      config,
    );

    const { rows } = await db.query<{ total_xp: string; level: number }>(
      `SELECT total_xp, level FROM member_xp WHERE guild_id = $1 AND user_id = $2`,
      [GUILD, user(1)],
    );
    expect(Number(rows[0]?.total_xp)).toBe(50100);
    expect(rows[0]?.level).toBeGreaterThan(1);
  });

  it('PLANNING WRITES NOTHING', async () => {
    // The dry run is the whole safety mechanism. If planning had a side effect,
    // the preview would be the import.
    const { db, importer } = await setup();
    await importer.plan(GUILD, `user_id,xp\n${user(1)},500`, 'set', config);
    expect(await totals(db)).toEqual({});
  });

  it('is idempotent in set mode', async () => {
    const { db, importer } = await setup();
    const rows = parseXpCsv(`user_id,xp\n${user(1)},700`).rows;

    await importer.apply(GUILD, rows, 'set', config);
    await importer.apply(GUILD, rows, 'set', config);

    expect((await totals(db))[user(1)]).toBe(700);
  });

  it('commits in batches, and reports how far it got when one fails', async () => {
    // A member id that is not a valid bigint gets past the plan (it never went
    // through the parser) and fails in Postgres. The batch it is in rolls back
    // whole; the batches before it stay.
    const { db, importer } = await setup();

    const rows = [
      ...Array.from({ length: 600 }, (_, i) => ({ userId: user(i + 1), xp: 10, line: i + 2 })),
      { userId: 'not-a-number', xp: 10, line: 602 },
    ];

    const result = await importer.apply(GUILD, rows, 'set', config);

    expect(result.failedAtBatch).toBe(2);
    expect(result.applied).toBe(500);
    expect(result.error).toBeTruthy();

    // Exactly the first batch: the second rolled back entirely rather than
    // leaving the 100 good rows that preceded the bad one.
    const { rows: counted } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM member_xp WHERE guild_id = $1`,
      [GUILD],
    );
    expect(counted[0]?.count).toBe('500');
  });

  it('handles a file larger than one batch', async () => {
    const { db, importer } = await setup();
    const csv = ['user_id,xp', ...Array.from({ length: 1200 }, (_, i) => `${user(i + 1)},${i + 1}`)].join('\n');

    const plan = await importer.plan(GUILD, csv, 'set', config);
    const result = await importer.apply(GUILD, plan.rows, 'set', config);

    expect(result.applied).toBe(1200);
    expect(result.batches).toBe(3);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM member_xp WHERE guild_id = $1`,
      [GUILD],
    );
    expect(rows[0]?.count).toBe('1200');
  });

  it('reports the top level the file would produce, honouring a max level', async () => {
    const { importer } = await setup();
    const capped: GuildLevelingConfig = {
      ...config,
      curve: { ...config.curve, maxLevel: 10 },
    };

    const plan = await importer.plan(
      GUILD,
      `user_id,xp\n${user(1)},100000000`,
      'set',
      capped,
    );
    expect(plan.topLevel).toBe(10);
  });

  it('surfaces the file’s problems in the plan rather than dropping them', async () => {
    const { importer } = await setup();
    const plan = await importer.plan(
      GUILD,
      `user_id,xp\n${user(1)},500\nnonsense,1\n${user(2)},oops`,
      'set',
      config,
    );

    expect(plan.rows).toHaveLength(1);
    expect(plan.errors).toHaveLength(2);
  });

  it('does nothing at all for an empty file', async () => {
    const { db, importer } = await setup();
    const plan = await importer.plan(GUILD, '', 'set', config);
    expect(plan.rows).toEqual([]);

    const result = await importer.apply(GUILD, plan.rows, 'set', config);
    expect(result.applied).toBe(0);
    expect(await totals(db)).toEqual({});
  });

  it('does not touch members the file does not mention', async () => {
    const { db, importer } = await setup();
    await db.query(
      `INSERT INTO member_xp (guild_id, user_id, total_xp, level) VALUES ($1, $2, 1234, 3)`,
      [GUILD, user(9)],
    );

    await importer.apply(GUILD, parseXpCsv(`user_id,xp\n${user(1)},5`).rows, 'set', config);

    expect((await totals(db))[user(9)]).toBe(1234);
  });
});
