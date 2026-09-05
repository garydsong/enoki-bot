import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { createGuildRepository } from '../../src/platform/guilds/guildRepository.js';
import {
  createConfigRepository,
  createRuleRepository,
} from '../../src/modules/leveling/infrastructure/repositories/configRepository.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';

const CORE = join(import.meta.dirname, '..', '..', 'migrations');
const LEVELING = join(import.meta.dirname, '..', '..', 'src', 'modules', 'leveling', 'migrations');

const GUILD = '111111111111111111';
const OTHER_GUILD = '999999999999999999';
const ROLE = '444444444444444444';

let temp: TempDatabase | null = null;
afterEach(async () => {
  await temp?.drop();
  temp = null;
});

async function setup() {
  temp = await createTempDatabase();
  await runMigrations(temp.db, [CORE, LEVELING], silentLogger);
  const guilds = createGuildRepository(temp.db);
  await guilds.upsert(GUILD, 'Test Guild');
  await guilds.upsert(OTHER_GUILD, 'Other Guild');
  const config = createConfigRepository(temp.db);
  await config.ensure(GUILD);
  await config.ensure(OTHER_GUILD);
  return { db: temp.db, config, rules: createRuleRepository(temp.db) };
}

describe.runIf(await postgresAvailable())('recording a broken reward', () => {
  it('notifies on the first breakage and then goes quiet', async () => {
    // A broken reward is rediscovered on EVERY level-up in the guild. Without
    // the throttle the warning fires once per message, which is the failure
    // mode where the alerting is worse than the fault.
    const { rules } = await setup();
    await rules.addReward(GUILD, 5, ROLE);

    const first = await rules.markRewardBroken(GUILD, ROLE, 'hierarchy');
    expect(first).toEqual({ notify: true, firstSeen: true });

    const second = await rules.markRewardBroken(GUILD, ROLE, 'hierarchy');
    expect(second.notify).toBe(false);
    expect(second.firstSeen).toBe(false);

    const third = await rules.markRewardBroken(GUILD, ROLE, 'hierarchy');
    expect(third.notify).toBe(false);
  });

  it('notifies again once the throttle window has passed', async () => {
    const { rules } = await setup();
    await rules.addReward(GUILD, 5, ROLE);
    await rules.markRewardBroken(GUILD, ROLE, 'hierarchy');

    // A zero-hour window is "always due", which is how the caller would ask for
    // an immediate re-notification.
    expect((await rules.markRewardBroken(GUILD, ROLE, 'hierarchy', 0)).notify).toBe(true);
  });

  it('does nothing for a role that is not a reward here', async () => {
    const { rules } = await setup();
    const record = await rules.markRewardBroken(GUILD, ROLE, 'role_deleted');
    expect(record).toEqual({ notify: false, firstSeen: false });
  });

  it('bumps the config version, because the engine’s view just changed', async () => {
    const { config, rules } = await setup();
    await rules.addReward(GUILD, 5, ROLE);
    const before = await config.version(GUILD);

    await rules.markRewardBroken(GUILD, ROLE, 'hierarchy');

    expect(await config.version(GUILD)).toBeGreaterThan(before);
  });

  it('never touches another guild’s identical role id', async () => {
    const { rules } = await setup();
    await rules.addReward(GUILD, 5, ROLE);
    await rules.addReward(OTHER_GUILD, 5, ROLE);

    await rules.markRewardBroken(GUILD, ROLE, 'hierarchy');

    expect((await rules.listRewards(OTHER_GUILD))[0]?.brokenReason).toBeNull();
  });
});

describe.runIf(await postgresAvailable())('self-healing', () => {
  it('clears the breakage and puts the reward back in the engine’s view', async () => {
    // Reconciliation cannot do this itself: it only sees the rules the engine
    // offers, and a broken one is by definition not among them. Without the
    // health job a fixed hierarchy stays dead until the admin re-adds the rule.
    const { config, rules } = await setup();
    await rules.addReward(GUILD, 5, ROLE);
    await rules.markRewardBroken(GUILD, ROLE, 'hierarchy');

    expect((await config.load(GUILD)).config.rewards).toHaveLength(0);

    expect(await rules.clearRewardBroken(GUILD, ROLE)).toBe(1);

    expect((await config.load(GUILD)).config.rewards).toHaveLength(1);
    expect((await rules.listRewards(GUILD))[0]?.brokenReason).toBeNull();
  });

  it('clears the notification stamp too, so a future breakage is reported', async () => {
    const { rules } = await setup();
    await rules.addReward(GUILD, 5, ROLE);
    await rules.markRewardBroken(GUILD, ROLE, 'hierarchy');
    await rules.clearRewardBroken(GUILD, ROLE);

    expect((await rules.markRewardBroken(GUILD, ROLE, 'hierarchy')).notify).toBe(true);
  });

  it('is a no-op on a reward that is not broken', async () => {
    const { rules } = await setup();
    await rules.addReward(GUILD, 5, ROLE);
    expect(await rules.clearRewardBroken(GUILD, ROLE)).toBe(0);
  });

  it('lists exactly the guilds needing a re-check', async () => {
    const { rules } = await setup();
    await rules.addReward(GUILD, 5, ROLE);
    await rules.addReward(OTHER_GUILD, 5, ROLE);

    expect(await rules.guildsWithBrokenRewards()).toEqual([]);

    await rules.markRewardBroken(GUILD, ROLE, 'role_deleted');
    expect(await rules.guildsWithBrokenRewards()).toEqual([GUILD]);

    await rules.clearRewardBroken(GUILD, ROLE);
    expect(await rules.guildsWithBrokenRewards()).toEqual([]);
  });

  it('accepts the unassignable reason added for @everyone', async () => {
    const { rules } = await setup();
    await rules.addReward(GUILD, 5, GUILD);
    await rules.markRewardBroken(GUILD, GUILD, 'unassignable');
    expect((await rules.listRewards(GUILD))[0]?.brokenReason).toBe('unassignable');
  });
});
