import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { createGuildRepository } from '../../src/platform/guilds/guildRepository.js';
import {
  createLeaderboardService,
  getRankSnapshot,
} from '../../src/modules/leveling/application/queries/leaderboard.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';
import { LevelCurve } from '../../src/modules/leveling/domain/curve/curve.js';
import { currentPeriodStart } from '../../src/modules/leveling/domain/periods/calendar.js';
import type { Database } from '../../src/platform/db/pool.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';

const CORE = join(import.meta.dirname, '..', '..', 'migrations');
const LEVELING = join(import.meta.dirname, '..', '..', 'src', 'modules', 'leveling', 'migrations');

const GUILD = '111111111111111111';
const config = { ...DEFAULT_LEVELING_CONFIG, enabled: true };
const curve = new LevelCurve(config.curve);

/** Snowflakes are BIGINT, so the ids must be numeric and ordered predictably. */
const user = (n: number): string => String(100000000000000000n + BigInt(n));

let temp: TempDatabase | null = null;
afterEach(async () => {
  await temp?.drop();
  temp = null;
});

async function setup(): Promise<Database> {
  temp = await createTempDatabase();
  await runMigrations(temp.db, [CORE, LEVELING], silentLogger);
  await createGuildRepository(temp.db).upsert(GUILD, 'Test Guild');
  return temp.db;
}

async function seed(
  db: Database,
  members: readonly { id: string; xp: number; name?: string; departed?: boolean }[],
): Promise<void> {
  for (const member of members) {
    await db.query(
      `INSERT INTO member_xp (guild_id, user_id, total_xp, level, display_name, is_departed)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        GUILD,
        member.id,
        member.xp,
        curve.levelFromTotalXp(member.xp),
        member.name ?? `member ${member.id.slice(-2)}`,
        member.departed ?? false,
      ],
    );
  }
}

describe.runIf(await postgresAvailable())('leaderboard ordering', () => {
  it('ranks by XP descending', async () => {
    const db = await setup();
    await seed(db, [
      { id: user(1), xp: 100 },
      { id: user(2), xp: 300 },
      { id: user(3), xp: 200 },
    ]);

    const page = await createLeaderboardService(db).page({ guildId: GUILD, metric: 'xp', config });

    expect(page.entries.map((e) => e.value)).toEqual([300, 200, 100]);
    expect(page.entries.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(page.totalRanked).toBe(3);
  });

  it('breaks ties by user id ascending, so a rank never flickers', async () => {
    // Without a deterministic tie-break, two members on the same total swap
    // places between calls and both report "my rank keeps changing".
    const db = await setup();
    await seed(db, [
      { id: user(3), xp: 500 },
      { id: user(1), xp: 500 },
      { id: user(2), xp: 500 },
    ]);

    const page = await createLeaderboardService(db).page({ guildId: GUILD, metric: 'xp', config });
    expect(page.entries.map((e) => e.userId)).toEqual([user(1), user(2), user(3)]);
  });

  it('excludes members with zero XP from the board and the count', async () => {
    const db = await setup();
    await seed(db, [
      { id: user(1), xp: 0 },
      { id: user(2), xp: 50 },
    ]);

    const page = await createLeaderboardService(db).page({ guildId: GUILD, metric: 'xp', config });
    expect(page.entries).toHaveLength(1);
    expect(page.totalRanked).toBe(1);
  });

  it('hides departed members only when configured to', async () => {
    const db = await setup();
    await seed(db, [
      { id: user(1), xp: 300, departed: true },
      { id: user(2), xp: 200 },
    ]);
    const boards = createLeaderboardService(db);

    const shown = await boards.page({ guildId: GUILD, metric: 'xp', config });
    expect(shown.entries).toHaveLength(2);
    expect(shown.entries[0]?.isDeparted).toBe(true);

    const hidden = await boards.page({
      guildId: GUILD,
      metric: 'xp',
      config: { ...config, hideDepartedMembers: true },
    });
    expect(hidden.entries).toHaveLength(1);
    expect(hidden.totalRanked).toBe(1);
  });
});

describe.runIf(await postgresAvailable())('pagination', () => {
  it('pages without gaps or repeats across the whole board', async () => {
    const db = await setup();
    await seed(
      db,
      Array.from({ length: 23 }, (_, i) => ({ id: user(i + 1), xp: (i + 1) * 10 })),
    );
    const boards = createLeaderboardService(db);

    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const result = await boards.page({ guildId: GUILD, metric: 'xp', page, pageSize: 10, config });
      expect(result.totalPages).toBe(3);
      seen.push(...result.entries.map((e) => e.userId));
    }

    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
  });

  it('numbers ranks continuously across page boundaries', async () => {
    const db = await setup();
    await seed(
      db,
      Array.from({ length: 12 }, (_, i) => ({ id: user(i + 1), xp: (i + 1) * 10 })),
    );

    const second = await createLeaderboardService(db).page({
      guildId: GUILD,
      metric: 'xp',
      page: 2,
      pageSize: 10,
      config,
    });
    expect(second.entries.map((e) => e.rank)).toEqual([11, 12]);
  });

  it('returns an empty final page rather than failing past the end', async () => {
    const db = await setup();
    await seed(db, [{ id: user(1), xp: 10 }]);

    const page = await createLeaderboardService(db).page({
      guildId: GUILD,
      metric: 'xp',
      page: 99,
      config,
    });
    expect(page.entries).toEqual([]);
    expect(page.totalPages).toBe(1);
  });

  it('clamps an absurd page size instead of trying to render it', async () => {
    const db = await setup();
    await seed(
      db,
      Array.from({ length: 30 }, (_, i) => ({ id: user(i + 1), xp: (i + 1) * 10 })),
    );

    const page = await createLeaderboardService(db).page({
      guildId: GUILD,
      metric: 'xp',
      pageSize: 1000,
      config,
    });
    // Discord embeds have limits; 25 is the ceiling the service enforces.
    expect(page.entries).toHaveLength(25);
  });
});

describe.runIf(await postgresAvailable())('"jump to me" agrees with the board', () => {
  it('lands on the page the member is actually on', async () => {
    const db = await setup();
    await seed(
      db,
      Array.from({ length: 30 }, (_, i) => ({ id: user(i + 1), xp: (i + 1) * 10 })),
    );
    const boards = createLeaderboardService(db);

    // user(1) has the LOWEST xp, so they are last: rank 30, page 3 at size 10.
    const page = await boards.pageOf({
      guildId: GUILD,
      metric: 'xp',
      userId: user(1),
      pageSize: 10,
      config,
    });
    expect(page).toBe(3);

    const result = await boards.page({ guildId: GUILD, metric: 'xp', page: 3, pageSize: 10, config });
    expect(result.entries.some((e) => e.userId === user(1))).toBe(true);
  });

  it('agrees with the page query when departed members are hidden', async () => {
    // The two queries must apply the SAME filters, or "jump to me" sends the
    // member to a page they are not on.
    const db = await setup();
    const hiding = { ...config, hideDepartedMembers: true };
    await seed(db, [
      ...Array.from({ length: 12 }, (_, i) => ({
        id: user(i + 1),
        xp: (i + 1) * 10,
        departed: i % 2 === 0,
      })),
    ]);
    const boards = createLeaderboardService(db);

    const target = user(2); // present, low XP
    const page = await boards.pageOf({
      guildId: GUILD,
      metric: 'xp',
      userId: target,
      pageSize: 3,
      config: hiding,
    });
    expect(page).not.toBeNull();

    const result = await boards.page({
      guildId: GUILD,
      metric: 'xp',
      page: page ?? 1,
      pageSize: 3,
      config: hiding,
    });
    expect(result.entries.some((e) => e.userId === target)).toBe(true);
  });

  it('returns null for someone not on the board', async () => {
    const db = await setup();
    await seed(db, [{ id: user(1), xp: 10 }]);

    const page = await createLeaderboardService(db).pageOf({
      guildId: GUILD,
      metric: 'xp',
      userId: user(99),
      config,
    });
    expect(page).toBeNull();
  });
});

describe.runIf(await postgresAvailable())('every metric', () => {
  it('sorts voice, messages and reactions from member_stats', async () => {
    const db = await setup();
    await seed(db, [
      { id: user(1), xp: 10 },
      { id: user(2), xp: 20 },
    ]);
    await db.query(
      `INSERT INTO member_stats (guild_id, user_id, messages_counted, voice_seconds, reactions_received)
       VALUES ($1, $2, 5, 3600, 1), ($1, $3, 50, 60, 9)`,
      [GUILD, user(1), user(2)],
    );
    const boards = createLeaderboardService(db);

    const voice = await boards.page({ guildId: GUILD, metric: 'voice', config });
    expect(voice.entries[0]?.userId).toBe(user(1));
    // The name and level come from member_xp via the join, so a stats board
    // still shows a person rather than a snowflake.
    expect(voice.entries[0]?.displayName).toBeTruthy();

    const messages = await boards.page({ guildId: GUILD, metric: 'messages', config });
    expect(messages.entries[0]?.userId).toBe(user(2));

    const reactions = await boards.page({ guildId: GUILD, metric: 'reactions', config });
    expect(reactions.entries[0]?.userId).toBe(user(2));
  });

  it('reads the weekly board out of the current period bucket only', async () => {
    const db = await setup();
    await seed(db, [
      { id: user(1), xp: 100 },
      { id: user(2), xp: 100 },
    ]);

    const now = Date.now();
    const thisWeek = new Date(currentPeriodStart(now, 'week', config.timezone, config.weekStartDay));
    const lastWeek = new Date(thisWeek.getTime() - 7 * 86_400_000);

    await db.query(
      `INSERT INTO member_period_xp (guild_id, user_id, period_type, period_start, xp)
       VALUES ($1, $2, 'week', $4, 40), ($1, $3, 'week', $4, 10), ($1, $3, 'week', $5, 9999)`,
      [GUILD, user(1), user(2), thisWeek, lastWeek],
    );

    const weekly = await createLeaderboardService(db).page({
      guildId: GUILD,
      metric: 'weekly',
      config,
      now,
    });

    // ADR-006: last week's 9999 is still stored and simply not selected. The
    // "reset" is the key changing, not a deletion.
    expect(weekly.entries.map((e) => e.value)).toEqual([40, 10]);
  });
});

describe.runIf(await postgresAvailable())('the rank snapshot', () => {
  it('agrees exactly with the member’s position on the board', async () => {
    // THE PROPERTY THAT MATTERS. If /rank and /leaderboard ever disagree, users
    // report it as the bot lying to them — so it is asserted for every member.
    const db = await setup();
    await seed(
      db,
      Array.from({ length: 15 }, (_, i) => ({ id: user(i + 1), xp: ((i % 5) + 1) * 100 })),
    );

    const board = await createLeaderboardService(db).page({
      guildId: GUILD,
      metric: 'xp',
      pageSize: 25,
      config,
    });

    for (const entry of board.entries) {
      const snapshot = await getRankSnapshot(db, GUILD, entry.userId, config);
      expect(snapshot?.rank, `member ${entry.userId}`).toBe(entry.rank);
      expect(snapshot?.rankTotal).toBe(board.totalRanked);
    }
  });

  it('returns null for a member who has never earned anything', async () => {
    const db = await setup();
    expect(await getRankSnapshot(db, GUILD, user(1), config)).toBeNull();
  });

  it('reports a zero-XP member as unranked rather than first', async () => {
    // An aggregate over an empty set still returns a row, which is how a member
    // with no XP once came back as rank 1.
    const db = await setup();
    await seed(db, [{ id: user(1), xp: 0 }]);

    const snapshot = await getRankSnapshot(db, GUILD, user(1), config);
    expect(snapshot?.rank).toBeNull();
    expect(snapshot?.totalXp).toBe(0);
  });

  it('derives level and within-level progress from the stored total', async () => {
    const db = await setup();
    const total = curve.totalXpToReach(4) + 10;
    await seed(db, [{ id: user(1), xp: total }]);

    const snapshot = await getRankSnapshot(db, GUILD, user(1), config);
    expect(snapshot?.level).toBe(4);
    expect(snapshot?.xpIntoLevel).toBe(10);
    expect(snapshot?.progressRatio).toBeGreaterThan(0);
    expect(snapshot?.progressRatio).toBeLessThan(1);
  });
});
