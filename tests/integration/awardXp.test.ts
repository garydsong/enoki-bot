import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { createGuildRepository } from '../../src/platform/guilds/guildRepository.js';
import { XpAwarder, type XpAwardedEvent } from '../../src/modules/leveling/application/awardXp.js';
import { createMemberXpRepository } from '../../src/modules/leveling/infrastructure/repositories/memberXpRepository.js';
import { createCooldownStore } from '../../src/modules/leveling/infrastructure/cache/cooldownStore.js';
import { DEFAULT_LEVELING_CONFIG } from '../../src/modules/leveling/domain/support/defaults.js';
import { LevelCurve } from '../../src/modules/leveling/domain/curve/curve.js';
import { currentPeriodStart } from '../../src/modules/leveling/domain/periods/calendar.js';
import type {
  Clock,
  GuildLevelingConfig,
  MemberContext,
  Rng,
  XpCandidate,
} from '../../src/modules/leveling/domain/types.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';

/**
 * THE AWARD USE CASE, END TO END against a real database.
 *
 * The unit tests prove the engine decides correctly; these prove the decision
 * is persisted correctly, that the level transition reported to effects matches
 * what was committed, and that a failing effect cannot undo an award.
 */

const CORE = join(import.meta.dirname, '..', '..', 'migrations');
const LEVELING = join(import.meta.dirname, '..', '..', 'src', 'modules', 'leveling', 'migrations');

const GUILD = '111111111111111111';
const USER = '222222222222222222';
const NOW = Date.UTC(2026, 4, 20, 12, 0, 0);

const config: GuildLevelingConfig = { ...DEFAULT_LEVELING_CONFIG, enabled: true };
const curve = new LevelCurve(config.curve);

const clock: Clock = { now: () => NOW };
/** Deterministic: always the midpoint of the range, so amounts are exact. */
const rng: Rng = { intBetween: (min, max) => Math.floor((min + max) / 2) };

let temp: TempDatabase | null = null;
afterEach(async () => {
  await temp?.drop();
  temp = null;
});

async function setup() {
  temp = await createTempDatabase();
  await runMigrations(temp.db, [CORE, LEVELING], silentLogger);
  await createGuildRepository(temp.db).upsert(GUILD, 'Test Guild');

  const memberXp = createMemberXpRepository(temp.db);
  const cooldowns = createCooldownStore({ now: () => NOW, sweepIntervalMs: 0 });
  const awarder = new XpAwarder({
    db: temp.db,
    memberXp,
    cooldowns,
    clock,
    rng,
    log: silentLogger,
  });

  return { db: temp.db, memberXp, cooldowns, awarder };
}

let sequence = 0;
const candidate = (over: Partial<XpCandidate> = {}): XpCandidate => ({
  source: 'message',
  occurredAt: NOW,
  idempotencyKey: `msg:${++sequence}`,
  location: {
    channelId: '333333333333333333',
    parentChannelId: null,
    categoryId: null,
    isThread: false,
    isForumPost: false,
    isVoiceText: false,
  },
  ...over,
});

const member = (over: Partial<MemberContext> = {}): MemberContext => ({
  userId: USER,
  roleIds: [],
  isBot: false,
  isWebhook: false,
  isSelf: false,
  isIgnored: false,
  currentTotalXp: 0,
  currentLevel: 0,
  ...over,
});

describe.runIf(await postgresAvailable())('awarding XP', () => {
  it('persists the award and reports the transition', async () => {
    const { awarder, memberXp } = await setup();

    const outcome = await awarder.award({
      guildId: GUILD,
      userId: USER,
      candidate: candidate(),
      member: member(),
      config,
      identity: { displayName: 'Gary' },
    });

    expect(outcome.awarded).toBe(true);
    if (!outcome.awarded) return;

    // The midpoint of the default 15–25 range.
    expect(outcome.event.xpAwarded).toBe(20);
    expect(outcome.event.totalXpBefore).toBe(0);
    expect(outcome.event.totalXpAfter).toBe(20);

    const row = await memberXp.get(GUILD, USER);
    expect(row?.totalXp).toBe(20);
    expect(row?.displayName).toBe('Gary');
    expect(row?.level).toBe(curve.levelFromTotalXp(20));
  });

  it('writes statistics and BOTH period buckets in the same transaction', async () => {
    const { db, awarder } = await setup();

    await awarder.award({
      guildId: GUILD,
      userId: USER,
      candidate: candidate(),
      member: member(),
      config,
      statDelta: { messagesCounted: 1 },
    });

    const stats = await db.query<{ messages_counted: string }>(
      `SELECT messages_counted FROM member_stats WHERE guild_id = $1 AND user_id = $2`,
      [GUILD, USER],
    );
    expect(stats.rows[0]?.messages_counted).toBe('1');

    const buckets = await db.query<{ period_type: string; xp: string }>(
      `SELECT period_type, xp FROM member_period_xp
       WHERE guild_id = $1 AND user_id = $2 ORDER BY period_type`,
      [GUILD, USER],
    );
    expect(buckets.rows.map((r) => r.period_type)).toEqual(['month', 'week']);
    expect(buckets.rows.every((r) => r.xp === '20')).toBe(true);
  });

  it('writes into the bucket for the guild’s own timezone', async () => {
    // ADR-006: the boundary is LOCAL midnight, so the stored instant must be
    // the one the calendar module computes, not a UTC week start.
    const { db, awarder } = await setup();
    const tokyo: GuildLevelingConfig = { ...config, timezone: 'Asia/Tokyo' };

    await awarder.award({
      guildId: GUILD,
      userId: USER,
      candidate: candidate(),
      member: member(),
      config: tokyo,
    });

    const expected = new Date(currentPeriodStart(NOW, 'week', 'Asia/Tokyo', 'monday'));
    const { rows } = await db.query<{ period_start: Date }>(
      `SELECT period_start FROM member_period_xp
       WHERE guild_id = $1 AND period_type = 'week'`,
      [GUILD],
    );
    expect(rows[0]?.period_start.toISOString()).toBe(expected.toISOString());
  });

  it('refuses a second award inside the cooldown', async () => {
    const { awarder } = await setup();

    const first = await awarder.award({
      guildId: GUILD,
      userId: USER,
      candidate: candidate(),
      member: member(),
      config,
    });
    const second = await awarder.award({
      guildId: GUILD,
      userId: USER,
      candidate: candidate(),
      member: member(),
      config,
    });

    expect(first.awarded).toBe(true);
    expect(second.awarded).toBe(false);
    expect(second.decision.denyReason).toBe('on_cooldown');
  });

  it('ignores a redelivered event with the same idempotency key', async () => {
    // Gateway resumes replay events. Without this, a reconnect hands out free XP.
    const { awarder, memberXp } = await setup();
    const key = 'msg:duplicate';

    await awarder.award({
      guildId: GUILD,
      userId: USER,
      candidate: candidate({ idempotencyKey: key }),
      member: member(),
      config: { ...config, sources: { ...config.sources, message: { ...config.sources.message, cooldownSeconds: 0 } } },
    });
    const replay = await awarder.award({
      guildId: GUILD,
      userId: USER,
      candidate: candidate({ idempotencyKey: key }),
      member: member(),
      config: { ...config, sources: { ...config.sources, message: { ...config.sources.message, cooldownSeconds: 0 } } },
    });

    expect(replay.awarded).toBe(false);
    expect(replay.decision.denyReason).toBe('duplicate_event');
    expect((await memberXp.get(GUILD, USER))?.totalXp).toBe(20);
  });

  it('does not touch the database when the engine denies', async () => {
    const { awarder, memberXp } = await setup();

    const outcome = await awarder.award({
      guildId: GUILD,
      userId: USER,
      candidate: candidate(),
      member: member(),
      config: { ...config, enabled: false },
    });

    expect(outcome.awarded).toBe(false);
    expect(await memberXp.get(GUILD, USER)).toBeNull();
  });

  it('does not consume the cooldown when the engine denies', async () => {
    // Otherwise a member in a no-XP channel would burn the cooldown they need
    // in the channel next door.
    const { awarder, cooldowns } = await setup();

    await awarder.award({
      guildId: GUILD,
      userId: USER,
      candidate: candidate(),
      member: member(),
      config: { ...config, enabled: false },
    });

    expect(cooldowns.size).toBe(0);
  });
});

describe.runIf(await postgresAvailable())('effects', () => {
  it('reports a level-up exactly once, naming the destination level', async () => {
    const { awarder } = await setup();
    const events: XpAwardedEvent[] = [];
    awarder.on((event) => {
      events.push(event);
    });

    // Enough to cross several levels in one grant.
    await awarder.awardManual({
      guildId: GUILD,
      userId: USER,
      delta: curve.totalXpToReach(5),
      config,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.leveledUp).toBe(true);
    expect(events[0]?.levelAfter).toBe(5);
    // All five levels are reported for reward resolution, even though only one
    // announcement is made.
    expect(events[0]?.levelsCrossed).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps the XP when an effect throws', async () => {
    // NFR-8: a failing level-up message must never roll back an earned award.
    const { awarder, memberXp } = await setup();
    awarder.on(() => {
      throw new Error('discord is on fire');
    });

    const outcome = await awarder.award({
      guildId: GUILD,
      userId: USER,
      candidate: candidate(),
      member: member(),
      config,
    });

    expect(outcome.awarded).toBe(true);
    expect((await memberXp.get(GUILD, USER))?.totalXp).toBe(20);
  });

  it('runs later effects even after an earlier one fails', async () => {
    const { awarder } = await setup();
    let reached = false;
    awarder.on(() => {
      throw new Error('first effect failed');
    });
    awarder.on(() => {
      reached = true;
    });

    await awarder.award({
      guildId: GUILD,
      userId: USER,
      candidate: candidate(),
      member: member(),
      config,
    });

    expect(reached).toBe(true);
  });
});

describe.runIf(await postgresAvailable())('manual administration', () => {
  it('adds XP without going through the gates', async () => {
    const { awarder, memberXp } = await setup();

    // Leveling disabled, member is a "bot" — manual grants are an explicit
    // administrative act and are not subject to earning rules.
    const event = await awarder.awardManual({
      guildId: GUILD,
      userId: USER,
      delta: 500,
      config: { ...config, enabled: false },
    });

    expect(event.totalXpAfter).toBe(500);
    expect((await memberXp.get(GUILD, USER))?.totalXp).toBe(500);
  });

  it('clamps a removal at zero rather than going negative', async () => {
    const { awarder } = await setup();
    await awarder.awardManual({ guildId: GUILD, userId: USER, delta: 100, config });

    const event = await awarder.awardManual({
      guildId: GUILD,
      userId: USER,
      delta: -5000,
      config,
    });

    expect(event.totalXpAfter).toBe(0);
    expect(event.xpAwarded).toBe(-100);
  });

  it('sets an absolute total and reports the level change', async () => {
    const { awarder, memberXp } = await setup();
    await awarder.awardManual({ guildId: GUILD, userId: USER, delta: 5000, config });

    const event = await awarder.awardManual({
      guildId: GUILD,
      userId: USER,
      delta: 0,
      setAbsolute: 100,
      config,
    });

    expect(event.totalXpAfter).toBe(100);
    expect(event.leveledDown).toBe(true);
    expect((await memberXp.get(GUILD, USER))?.totalXp).toBe(100);
  });

  it('marks a silent grant so the notifier stays quiet', async () => {
    const { awarder } = await setup();
    const events: XpAwardedEvent[] = [];
    awarder.on((event) => {
      events.push(event);
    });

    await awarder.awardManual({
      guildId: GUILD,
      userId: USER,
      delta: curve.totalXpToReach(3),
      config,
      silent: true,
    });

    expect(events[0]?.leveledUp).toBe(true);
    expect(events[0]?.silent).toBe(true);
  });
});
