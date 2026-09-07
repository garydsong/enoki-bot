import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Events } from 'discord.js';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { createGuildRepository } from '../../src/platform/guilds/guildRepository.js';
import {
  createAuditRepository,
  createRuleRepository,
} from '../../src/modules/leveling/infrastructure/repositories/configRepository.js';
import { createMemberXpRepository } from '../../src/modules/leveling/infrastructure/repositories/memberXpRepository.js';
import { createMemberLeaveListener } from '../../src/modules/leveling/adapters/listeners/rewardLifecycle.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';
import type { GuildLevelingConfig } from '../../src/modules/leveling/domain/types.js';
import type { ConfigCache } from '../../src/modules/leveling/ports/config.js';
import type { ModuleContext } from '../../src/platform/plugin/types.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';

/**
 * Erasure: `/xp forget` and `auto_reset_on_leave` (MR-7, roadmap M15).
 *
 * A deletion feature is only worth as much as its completeness, so the test
 * that matters most here is the one that asks the DATABASE which tables are
 * keyed on a member and fails when one of them is not being cleaned.
 */

const CORE = join(import.meta.dirname, '..', '..', 'migrations');
const LEVELING = join(import.meta.dirname, '..', '..', 'src', 'modules', 'leveling', 'migrations');

const GUILD = '111111111111111111';
const USER = '222222222222222222';
const OTHER = '333333333333333333';

let temp: TempDatabase | null = null;
afterEach(async () => {
  await temp?.drop();
  temp = null;
});

async function setup() {
  temp = await createTempDatabase();
  await runMigrations(temp.db, [CORE, LEVELING], silentLogger);
  await createGuildRepository(temp.db).upsert(GUILD, 'Test Guild');
  return {
    db: temp.db,
    memberXp: createMemberXpRepository(temp.db),
    audit: createAuditRepository(temp.db),
    rules: createRuleRepository(temp.db),
  };
}

/** Give a member a row in every table that holds member data. */
async function seedEverything(db: TempDatabase['db'], userId: string): Promise<void> {
  await db.query(
    `INSERT INTO member_xp (guild_id, user_id, total_xp, level, display_name)
     VALUES ($1, $2, 4200, 7, 'someone')`,
    [GUILD, userId],
  );
  await db.query(
    `INSERT INTO member_stats (guild_id, user_id, messages_counted, voice_seconds)
     VALUES ($1, $2, 120, 3600)`,
    [GUILD, userId],
  );
  await db.query(
    `INSERT INTO member_period_xp (guild_id, user_id, period_type, period_start, xp)
     VALUES ($1, $2, 'week', now(), 300), ($1, $2, 'month', now(), 900)`,
    [GUILD, userId],
  );
  await db.query(
    `INSERT INTO member_card_config (guild_id, user_id, accent_color) VALUES ($1, $2, 123)`,
    [GUILD, userId],
  );
  await db.query(
    `INSERT INTO voice_session (guild_id, user_id, channel_id) VALUES ($1, $2, $3)`,
    [GUILD, userId, '999999999999999999'],
  );
}

describe.runIf(await postgresAvailable())('forget', () => {
  it('deletes everything stored about the member', async () => {
    const { db, memberXp } = await setup();
    await seedEverything(db, USER);

    const result = await memberXp.forget(GUILD, USER);

    expect(result).toMatchObject({
      xpRows: 1,
      statRows: 1,
      periodRows: 2,
      cardRows: 1,
      voiceRows: 1,
      totalXpErased: 4200,
    });

    for (const table of [
      'member_xp',
      'member_stats',
      'member_period_xp',
      'member_card_config',
      'voice_session',
    ]) {
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE guild_id = $1 AND user_id = $2`,
        [GUILD, USER],
      );
      expect(rows[0]?.count, table).toBe('0');
    }
  });

  it('LEAVES EVERY OTHER MEMBER ALONE', async () => {
    const { db, memberXp } = await setup();
    await seedEverything(db, USER);
    await seedEverything(db, OTHER);

    await memberXp.forget(GUILD, USER);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM member_xp WHERE guild_id = $1`,
      [GUILD],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('KEEPS the reaction dedup keys', async () => {
    // Deliberate, and the reason is anti-farming: those rows hold no XP, no
    // name and no content — only "this message was already counted". Deleting
    // them would let someone erase their data and immediately re-earn every
    // reaction they ever gave.
    const { db, memberXp } = await setup();
    await seedEverything(db, USER);
    await db.query(
      `INSERT INTO reaction_award (guild_id, message_id, reactor_id, emoji)
       VALUES ($1, $2, $3, '👍')`,
      [GUILD, '444444444444444444', USER],
    );

    await memberXp.forget(GUILD, USER);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reaction_award WHERE reactor_id = $1`,
      [USER],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('is a no-op, not an error, for a member with nothing stored', async () => {
    const { memberXp } = await setup();
    const result = await memberXp.forget(GUILD, USER);
    expect(result.xpRows).toBe(0);
    expect(result.totalXpErased).toBe(0);
  });

  /**
   * THE TEST THAT KEEPS THIS FEATURE HONEST.
   *
   * "We delete your data" is a promise, and the way it quietly stops being true
   * is a new table keyed on (guild, member) that nobody adds to `forget`. So
   * rather than listing the tables we know about, this asks the DATABASE which
   * ones exist and fails when one is left behind.
   */
  it('leaves no member-keyed table behind, whatever the schema grows', async () => {
    const { db, memberXp } = await setup();
    await seedEverything(db, USER);

    const { rows: tables } = await db.query<{ table_name: string }>(
      `SELECT c.table_name
       FROM information_schema.columns AS c
       WHERE c.table_schema = 'public' AND c.column_name = 'user_id'
       GROUP BY c.table_name`,
    );

    // The one deliberate exception, explained above and asserted separately so
    // that removing it from this list is a decision rather than an accident.
    const intentionallyKept = new Set(['reaction_award']);
    const shouldBeEmptied = tables
      .map((t) => t.table_name)
      .filter((name) => !intentionallyKept.has(name));

    expect(shouldBeEmptied.length).toBeGreaterThan(3);

    await memberXp.forget(GUILD, USER);

    const leftovers: string[] = [];
    for (const table of shouldBeEmptied) {
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE user_id = $1`,
        [USER],
      );
      if (rows[0]?.count !== '0') leftovers.push(table);
    }

    expect(
      leftovers,
      `forget() left member data in: ${leftovers.join(', ')}. ` +
        'Add the table to MemberXpRepository.forget, or to intentionallyKept with a reason.',
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

function config(over: Partial<GuildLevelingConfig> = {}): GuildLevelingConfig {
  return { ...DEFAULT_LEVELING_CONFIG, enabled: true, ...over };
}

function leaveEvent(userId: string) {
  return { id: userId, user: { bot: false }, guild: { id: GUILD } };
}

describe.runIf(await postgresAvailable())('auto_reset_on_leave', () => {
  async function listenerFor(cfg: GuildLevelingConfig) {
    const { db, memberXp, audit, rules } = await setup();
    const configs: ConfigCache = {
      get: () => Promise.resolve(cfg),
      invalidate: () => {},
      clear: () => {},
      stats: { hits: 0, misses: 0, revalidations: 0 },
    };
    const listener = createMemberLeaveListener({
      reconciler: { reconcile: () => Promise.resolve({ added: [], removed: [], broken: [] }) },
      configs,
      memberXp,
      rules,
      audit,
    });
    return { db, listener, audit };
  }

  it('MARKS rather than deletes by default', async () => {
    // ADR-014: XP survives a leave, so a member who leaves by accident and
    // comes straight back finds their level where they left it.
    const { db, listener } = await listenerFor(config());
    await seedEverything(db, USER);

    await listener.handle({ log: silentLogger } as unknown as ModuleContext, leaveEvent(USER));

    const { rows } = await db.query<{ is_departed: boolean; total_xp: string }>(
      `SELECT is_departed, total_xp FROM member_xp WHERE guild_id = $1 AND user_id = $2`,
      [GUILD, USER],
    );
    expect(rows[0]?.is_departed).toBe(true);
    expect(Number(rows[0]?.total_xp)).toBe(4200);
  });

  it('deletes when the setting is on', async () => {
    const { db, listener } = await listenerFor(config({ autoResetOnLeave: true }));
    await seedEverything(db, USER);

    await listener.handle({ log: silentLogger } as unknown as ModuleContext, leaveEvent(USER));

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM member_xp WHERE guild_id = $1 AND user_id = $2`,
      [GUILD, USER],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('AUDITS THE DELETION WITHOUT RETAINING THE DATA', async () => {
    // The record of the erasure has to outlive the data — "everything I earned
    // is gone" is a support question that needs an answer — but the record is
    // the member's id and the total, not a copy of what was deleted.
    const { db, listener, audit } = await listenerFor(config({ autoResetOnLeave: true }));
    await seedEverything(db, USER);

    await listener.handle({ log: silentLogger } as unknown as ModuleContext, leaveEvent(USER));

    const entries = await audit.search(GUILD, { targetUserId: USER });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('xp.auto_reset_on_leave');
    expect(entries[0]?.actorId).toBeNull();
    expect(entries[0]?.before).toEqual({ totalXp: 4200 });

    // The audit row is all that is left of them.
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM member_stats WHERE user_id = $1`,
      [USER],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('says nothing for a member who had no data', async () => {
    const { listener, audit } = await listenerFor(config({ autoResetOnLeave: true }));
    await listener.handle({ log: silentLogger } as unknown as ModuleContext, leaveEvent(USER));
    expect(await audit.recent(GUILD)).toEqual([]);
  });

  it('ignores bots', async () => {
    const { db, listener } = await listenerFor(config({ autoResetOnLeave: true }));
    await seedEverything(db, USER);

    await listener.handle({ log: silentLogger } as unknown as ModuleContext, {
      id: USER,
      user: { bot: true },
      guild: { id: GUILD },
    });

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM member_xp WHERE user_id = $1`,
      [USER],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('listens for the right event', () => {
    const listener = createMemberLeaveListener({
      reconciler: {} as never,
      configs: {} as never,
      memberXp: {} as never,
      rules: {} as never,
      audit: {} as never,
    });
    expect(listener.event).toBe(Events.GuildMemberRemove);
  });
});
