import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { createGuildRepository } from '../../src/platform/guilds/guildRepository.js';
import {
  bumpPeriodXp,
  bumpStats,
  createMemberXpRepository,
} from '../../src/modules/leveling/infrastructure/repositories/memberXpRepository.js';
import { LevelCurve } from '../../src/modules/leveling/domain/curve/curve.js';
import { computeLevelTransition } from '../../src/modules/leveling/domain/engine/pipeline.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';

const CORE = join(import.meta.dirname, '..', '..', 'migrations');
const LEVELING = join(import.meta.dirname, '..', '..', 'src', 'modules', 'leveling', 'migrations');

const GUILD = '111111111111111111';
const USER = '222222222222222222';
const USER_B = '333333333333333333';

const curve = new LevelCurve(DEFAULT_LEVELING_CONFIG.curve);
const levelFor = (xp: number) => curve.levelFromTotalXp(xp);

let temp: TempDatabase | null = null;
afterEach(async () => {
  await temp?.drop();
  temp = null;
});

async function setup() {
  temp = await createTempDatabase();
  await runMigrations(temp.db, [CORE, LEVELING], silentLogger);
  await createGuildRepository(temp.db).upsert(GUILD, 'Test Guild');
  return { db: temp.db, repo: createMemberXpRepository(temp.db) };
}

describe.runIf(await postgresAvailable())('the atomic XP increment', () => {
  it('creates a member on first award and reports before/after', async () => {
    const { db, repo } = await setup();

    const result = await db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, 20, levelFor));

    expect(result).toMatchObject({
      totalXpBefore: 0,
      totalXpAfter: 20,
      appliedDelta: 20,
      isNewMember: true,
    });
  });

  it('reports isNewMember false on a subsequent award', async () => {
    const { db, repo } = await setup();
    await db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, 20, levelFor));

    const second = await db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, 20, levelFor));

    expect(second).toMatchObject({ totalXpBefore: 20, totalXpAfter: 40, isNewMember: false });
  });

  /**
   * THE TEST THIS WHOLE DESIGN EXISTS FOR.
   *
   * A read-modify-write would lose updates here — two awards reading the same
   * value and both writing back their own total. The database doing the
   * arithmetic makes that impossible.
   */
  it('loses no updates under 100 concurrent awards', async () => {
    const { db, repo } = await setup();

    await Promise.all(
      Array.from({ length: 100 }, () =>
        db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, 7, levelFor)),
      ),
    );

    expect((await repo.get(GUILD, USER))?.totalXp).toBe(700);
  });

  /**
   * The other half: every award must observe a DISTINCT before/after pair.
   * If two observed the same "before", a level-up could be announced twice or
   * missed entirely.
   */
  it('gives every concurrent award a distinct, contiguous before/after pair', async () => {
    const { db, repo } = await setup();

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, 10, levelFor)),
      ),
    );

    const befores = results.map((r) => r.totalXpBefore).sort((a, b) => a - b);
    const afters = results.map((r) => r.totalXpAfter).sort((a, b) => a - b);

    // Every "before" is unique — no two awards saw the same starting value.
    expect(new Set(befores).size).toBe(50);
    // And they tile the range exactly: 0,10,20,... with no gaps or repeats.
    expect(befores).toEqual(Array.from({ length: 50 }, (_, i) => i * 10));
    expect(afters).toEqual(Array.from({ length: 50 }, (_, i) => (i + 1) * 10));
  });

  it('produces exactly one level-up per level crossed, even concurrently', async () => {
    const { db, repo } = await setup();
    const config = { ...DEFAULT_LEVELING_CONFIG, enabled: true };

    const results = await Promise.all(
      Array.from({ length: 60 }, () =>
        db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, 25, levelFor)),
      ),
    );

    const crossed = results.flatMap(
      (r) => computeLevelTransition(r.totalXpBefore, r.totalXpAfter, config).levelsCrossed,
    );

    // 1500 XP total. No level is announced twice, and none is skipped.
    expect(new Set(crossed).size).toBe(crossed.length);
    const finalLevel = levelFor(1500);
    expect(crossed.sort((a, b) => a - b)).toEqual(
      Array.from({ length: finalLevel }, (_, i) => i + 1),
    );
  });

  it('keeps the denormalised level consistent with total_xp', async () => {
    const { db, repo } = await setup();
    for (const delta of [75, 100, 500, 2000]) {
      await db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, delta, levelFor));
      const row = await repo.get(GUILD, USER);
      expect(row?.level).toBe(levelFor(row!.totalXp));
    }
  });
});

describe.runIf(await postgresAvailable())('XP removal', () => {
  it('subtracts and reports the real before/after', async () => {
    const { db, repo } = await setup();
    await db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, 500, levelFor));

    const result = await db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, -200, levelFor));

    expect(result).toMatchObject({ totalXpBefore: 500, totalXpAfter: 300, appliedDelta: -200 });
  });

  /**
   * The case that breaks the naive `after - delta` shortcut: when the value
   * clamps at zero the applied delta is smaller than the requested one, and the
   * reported "before" must still be the true previous value.
   */
  it('floors at zero and reports the ACTUAL applied delta, not the requested one', async () => {
    const { db, repo } = await setup();
    await db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, 100, levelFor));

    const result = await db.withTransaction((tx) =>
      repo.addXp(tx, GUILD, USER, -999_999, levelFor),
    );

    expect(result.totalXpBefore).toBe(100);
    expect(result.totalXpAfter).toBe(0);
    expect(result.appliedDelta).toBe(-100); // not -999999
  });

  it('never violates the non-negative constraint', async () => {
    const { db, repo } = await setup();
    await db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, 10, levelFor));
    await db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, -50, levelFor));
    expect((await repo.get(GUILD, USER))?.totalXp).toBe(0);
  });
});

describe.runIf(await postgresAvailable())('setTotalXp', () => {
  it('sets an absolute value and reports the transition', async () => {
    const { db, repo } = await setup();
    await db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, 100, levelFor));

    const result = await db.withTransaction((tx) =>
      repo.setTotalXp(tx, GUILD, USER, 5250, levelFor),
    );

    expect(result).toMatchObject({ totalXpBefore: 100, totalXpAfter: 5250 });
    expect((await repo.get(GUILD, USER))?.level).toBe(10);
  });

  it('works for a member who does not exist yet', async () => {
    const { db, repo } = await setup();
    const result = await db.withTransaction((tx) =>
      repo.setTotalXp(tx, GUILD, USER, 1000, levelFor),
    );
    expect(result).toMatchObject({ totalXpBefore: 0, totalXpAfter: 1000, isNewMember: true });
  });
});

describe.runIf(await postgresAvailable())('rank', () => {
  it('is 1-based and ordered by XP descending', async () => {
    const { db, repo } = await setup();
    await db.withTransaction(async (tx) => {
      await repo.addXp(tx, GUILD, USER, 100, levelFor);
      await repo.addXp(tx, GUILD, USER_B, 500, levelFor);
    });

    expect(await repo.rankOf(GUILD, USER_B)).toBe(1);
    expect(await repo.rankOf(GUILD, USER)).toBe(2);
  });

  /** US-20 AC2: rank must not flicker between calls when totals tie. */
  it('breaks ties deterministically by user id, and is stable across calls', async () => {
    const { db, repo } = await setup();
    await db.withTransaction(async (tx) => {
      await repo.addXp(tx, GUILD, USER, 100, levelFor);
      await repo.addXp(tx, GUILD, USER_B, 100, levelFor);
    });

    const first = [await repo.rankOf(GUILD, USER), await repo.rankOf(GUILD, USER_B)];
    const second = [await repo.rankOf(GUILD, USER), await repo.rankOf(GUILD, USER_B)];

    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(2); // distinct ranks, not both "1"
    expect(await repo.rankOf(GUILD, USER)).toBe(1); // lower id wins the tie
  });

  /** US-20 AC3: zero-XP members are unranked, consistently. */
  it('returns null for a member with no XP', async () => {
    const { db, repo } = await setup();
    await db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, 0, levelFor));
    expect(await repo.rankOf(GUILD, USER)).toBeNull();
  });

  it('returns null for a member who has never been seen', async () => {
    const { repo } = await setup();
    expect(await repo.rankOf(GUILD, '999999999999999999')).toBeNull();
  });

  it('excludes zero-XP members from the ranked count', async () => {
    const { db, repo } = await setup();
    await db.withTransaction(async (tx) => {
      await repo.addXp(tx, GUILD, USER, 100, levelFor);
      await repo.addXp(tx, GUILD, USER_B, 0, levelFor);
    });
    expect(await repo.countRanked(GUILD)).toBe(1);
  });
});

describe.runIf(await postgresAvailable())('guild isolation', () => {
  const OTHER = '444444444444444444';

  it('keeps identical user ids in different guilds completely separate', async () => {
    const { db, repo } = await setup();
    await createGuildRepository(db).upsert(OTHER, 'Other Guild');

    await db.withTransaction(async (tx) => {
      await repo.addXp(tx, GUILD, USER, 100, levelFor);
      await repo.addXp(tx, OTHER, USER, 900, levelFor);
    });

    expect((await repo.get(GUILD, USER))?.totalXp).toBe(100);
    expect((await repo.get(OTHER, USER))?.totalXp).toBe(900);
    expect(await repo.rankOf(GUILD, USER)).toBe(1);
    expect(await repo.rankOf(OTHER, USER)).toBe(1);
  });

  it('a guild-wide reset touches only that guild', async () => {
    const { db, repo } = await setup();
    await createGuildRepository(db).upsert(OTHER, 'Other Guild');
    await db.withTransaction(async (tx) => {
      await repo.addXp(tx, GUILD, USER, 100, levelFor);
      await repo.addXp(tx, OTHER, USER, 900, levelFor);
    });

    await repo.resetGuild(GUILD);

    expect((await repo.get(GUILD, USER))?.totalXp).toBe(0);
    expect((await repo.get(OTHER, USER))?.totalXp).toBe(900);
  });

  it('deleting a guild cascades its member rows away', async () => {
    const { db, repo } = await setup();
    await db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, 100, levelFor));

    await db.query('DELETE FROM guild WHERE guild_id = $1', [GUILD]);

    expect(await repo.get(GUILD, USER)).toBeNull();
  });
});

describe.runIf(await postgresAvailable())('reset semantics (ADR-014)', () => {
  it('clears XP but PRESERVES statistics', async () => {
    const { db, repo } = await setup();
    await db.withTransaction(async (tx) => {
      await repo.addXp(tx, GUILD, USER, 500, levelFor);
      await bumpStats(tx, GUILD, USER, { messagesCounted: 42, voiceSeconds: 3600 });
    });

    await repo.reset(GUILD, USER);

    const row = await repo.get(GUILD, USER);
    expect(row?.totalXp).toBe(0);
    expect(row?.level).toBe(0);

    const { rows } = await db.query<{ messages_counted: string; voice_seconds: string }>(
      'SELECT messages_counted, voice_seconds FROM member_stats WHERE guild_id=$1 AND user_id=$2',
      [GUILD, USER],
    );
    expect(rows[0]?.messages_counted).toBe('42');
    expect(rows[0]?.voice_seconds).toBe('3600');
  });

  it('keeps the row and its name snapshot so leaderboards still render', async () => {
    const { db, repo } = await setup();
    await db.withTransaction((tx) =>
      repo.addXp(tx, GUILD, USER, 100, levelFor, { displayName: 'Gary' }),
    );

    await repo.reset(GUILD, USER);

    expect((await repo.get(GUILD, USER))?.displayName).toBe('Gary');
  });
});

describe.runIf(await postgresAvailable())('identity snapshots', () => {
  it('stores a display name so departed members are not raw snowflakes', async () => {
    const { db, repo } = await setup();
    await db.withTransaction((tx) =>
      repo.addXp(tx, GUILD, USER, 10, levelFor, { displayName: 'Gary', avatarHash: 'abc' }),
    );
    expect((await repo.get(GUILD, USER))?.displayName).toBe('Gary');
  });

  it('updates the snapshot on rename', async () => {
    const { db, repo } = await setup();
    await db.withTransaction((tx) =>
      repo.addXp(tx, GUILD, USER, 10, levelFor, { displayName: 'Old' }),
    );
    await db.withTransaction((tx) =>
      repo.addXp(tx, GUILD, USER, 10, levelFor, { displayName: 'New' }),
    );
    expect((await repo.get(GUILD, USER))?.displayName).toBe('New');
  });

  it('does not erase a known name when an award carries none', async () => {
    const { db, repo } = await setup();
    await db.withTransaction((tx) =>
      repo.addXp(tx, GUILD, USER, 10, levelFor, { displayName: 'Gary' }),
    );
    await db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, 10, levelFor));
    expect((await repo.get(GUILD, USER))?.displayName).toBe('Gary');
  });

  it('tracks departure without deleting anything', async () => {
    const { db, repo } = await setup();
    await db.withTransaction((tx) => repo.addXp(tx, GUILD, USER, 10, levelFor));
    await repo.markDeparted(GUILD, USER, true);
    expect((await repo.get(GUILD, USER))?.isDeparted).toBe(true);
    expect((await repo.get(GUILD, USER))?.totalXp).toBe(10);
  });
});

describe.runIf(await postgresAvailable())('period buckets (ADR-006)', () => {
  const WEEK_A = new Date('2026-08-31T00:00:00Z');
  const WEEK_B = new Date('2026-09-07T00:00:00Z');

  it('accumulates within a period', async () => {
    const { db } = await setup();
    await db.withTransaction(async (tx) => {
      await bumpPeriodXp(tx, GUILD, USER, 'week', WEEK_A, 20);
      await bumpPeriodXp(tx, GUILD, USER, 'week', WEEK_A, 30);
    });

    const { rows } = await db.query<{ xp: string }>(
      `SELECT xp FROM member_period_xp WHERE guild_id=$1 AND user_id=$2 AND period_start=$3`,
      [GUILD, USER, WEEK_A],
    );
    expect(rows[0]?.xp).toBe('50');
  });

  /**
   * The whole point: crossing the boundary writes to a NEW ROW. No job runs,
   * nothing is deleted, and last week's total is still there.
   */
  it('a new period is a new row — the old one is untouched', async () => {
    const { db } = await setup();
    await db.withTransaction((tx) => bumpPeriodXp(tx, GUILD, USER, 'week', WEEK_A, 100));
    await db.withTransaction((tx) => bumpPeriodXp(tx, GUILD, USER, 'week', WEEK_B, 25));

    const { rows } = await db.query<{ period_start: Date; xp: string }>(
      `SELECT period_start, xp FROM member_period_xp
       WHERE guild_id=$1 AND user_id=$2 ORDER BY period_start`,
      [GUILD, USER],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.xp).toBe('100');
    expect(rows[1]?.xp).toBe('25');
  });

  it('weekly and monthly buckets are independent', async () => {
    const { db } = await setup();
    await db.withTransaction(async (tx) => {
      await bumpPeriodXp(tx, GUILD, USER, 'week', WEEK_A, 40);
      await bumpPeriodXp(tx, GUILD, USER, 'month', new Date('2026-08-01T00:00:00Z'), 40);
    });

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM member_period_xp WHERE guild_id=$1`,
      [GUILD],
    );
    expect(rows[0]?.count).toBe('2');
  });

  /** US-34 AC1: resetting the weekly board must never touch lifetime XP. */
  it('period XP is entirely separate from lifetime XP', async () => {
    const { db, repo } = await setup();
    await db.withTransaction(async (tx) => {
      await repo.addXp(tx, GUILD, USER, 500, levelFor);
      await bumpPeriodXp(tx, GUILD, USER, 'week', WEEK_A, 500);
    });

    await db.query('DELETE FROM member_period_xp WHERE guild_id = $1', [GUILD]);

    expect((await repo.get(GUILD, USER))?.totalXp).toBe(500);
  });
});

describe.runIf(await postgresAvailable())('transactional integrity', () => {
  it('rolls XP, stats and period buckets back together on failure', async () => {
    const { db, repo } = await setup();

    await expect(
      db.withTransaction(async (tx) => {
        await repo.addXp(tx, GUILD, USER, 100, levelFor);
        await bumpStats(tx, GUILD, USER, { messagesCounted: 1 });
        await bumpPeriodXp(tx, GUILD, USER, 'week', new Date('2026-08-31T00:00:00Z'), 100);
        throw new Error('side effect exploded');
      }),
    ).rejects.toThrow('side effect exploded');

    expect(await repo.get(GUILD, USER)).toBeNull();
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM member_period_xp WHERE guild_id = $1`,
      [GUILD],
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe.runIf(await postgresAvailable())('curve changes', () => {
  /** ADR-001's payoff: changing the curve re-levels everyone with no migration. */
  it('re-levels a guild without touching anyone total XP', async () => {
    const { db, repo } = await setup();
    await db.withTransaction(async (tx) => {
      await repo.addXp(tx, GUILD, USER, 5250, levelFor);
      await repo.addXp(tx, GUILD, USER_B, 1000, levelFor);
    });
    expect((await repo.get(GUILD, USER))?.level).toBe(10);

    const flat = new LevelCurve({ ...DEFAULT_LEVELING_CONFIG.curve, type: 'flat' });
    const updated = await repo.relevelGuild(GUILD, (xp) => flat.levelFromTotalXp(xp));

    expect(updated).toBe(2);
    expect((await repo.get(GUILD, USER))?.level).toBe(5); // 5250 / 1000
    expect((await repo.get(GUILD, USER))?.totalXp).toBe(5250); // unchanged
    expect((await repo.get(GUILD, USER_B))?.level).toBe(1);
  });
});
