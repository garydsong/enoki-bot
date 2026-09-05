import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { createGuildRepository } from '../../src/platform/guilds/guildRepository.js';
import {
  createAuditRepository,
  createConfigRepository,
  createRuleRepository,
} from '../../src/modules/leveling/infrastructure/repositories/configRepository.js';
import { createConfigCache } from '../../src/modules/leveling/infrastructure/cache/configCache.js';
import {
  findSetting,
  parseSettingValue,
  SETTINGS,
} from '../../src/modules/leveling/application/settings/registry.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';

const CORE = join(import.meta.dirname, '..', '..', 'migrations');
const LEVELING = join(import.meta.dirname, '..', '..', 'src', 'modules', 'leveling', 'migrations');

const GUILD = '111111111111111111';
const ACTOR = '999999999999999999';
const ROLE = '444444444444444444';
const CHANNEL = '555555555555555555';

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
    config: createConfigRepository(temp.db),
    rules: createRuleRepository(temp.db),
    audit: createAuditRepository(temp.db),
  };
}

describe.runIf(await postgresAvailable())('the setting registry against the real schema', () => {
  /**
   * THE HIGHEST-VALUE TEST IN THIS FILE.
   *
   * `ConfigRepository.update` interpolates a column name into SQL. A registry
   * entry naming a column that does not exist is therefore not a type error, not
   * a lint error, and not visible in any unit test — it is a runtime SQL failure
   * the first time an admin touches that setting, in production, on a value they
   * cared about. Asking the database itself closes that gap.
   */
  it('names a real column for every single setting', async () => {
    const { db } = await setup();

    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'`,
    );
    const existing = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));

    const missing = SETTINGS.filter((setting) => {
      const table = setting.source ? 'xp_source_config' : 'leveling_config';
      return !existing.has(`${table}.${setting.column}`);
    }).map((s) => `${s.key} -> ${setting_table(s.source)}.${s.column}`);

    expect(missing).toEqual([]);
  });

  it('accepts a write for every setting, using each one’s own parser', async () => {
    // Not just "the column exists" but "the value we would store is accepted by
    // its CHECK constraint and its type". A registry min/max that disagrees with
    // the schema fails here rather than in front of an admin.
    const { config } = await setup();
    await config.ensure(GUILD);

    for (const setting of SETTINGS) {
      const sample = sampleFor(setting.kind, setting);
      const parsed = parseSettingValue(setting, sample);
      expect(parsed.ok, `${setting.key} could not parse its own sample "${sample}"`).toBe(true);
      if (!parsed.ok) continue;

      if (setting.source) {
        await config.updateSource(GUILD, setting.source, { [setting.column]: parsed.value });
      } else {
        await config.update(GUILD, { [setting.column]: parsed.value }, ACTOR);
      }
    }

    // And the whole lot still assembles into a usable domain object.
    const loaded = await config.load(GUILD);
    expect(loaded.config.curve.type).toBeTruthy();
  });
});

function setting_table(source: string | undefined): string {
  return source ? 'xp_source_config' : 'leveling_config';
}

function sampleFor(
  kind: string,
  setting: { key: string; min?: number; max?: number; choices?: readonly string[] },
): string {
  switch (kind) {
    case 'boolean':
      return 'on';
    case 'choice':
      return setting.choices?.[0] ?? 'x';
    case 'integer':
      return String(setting.min ?? 1);
    case 'channel':
      return CHANNEL;
    case 'decimal':
      return '1.5';
    case 'string':
    default:
      // The two string settings with their own parsers need their own shapes.
      if (setting.key === 'periods.timezone') return 'America/New_York';
      if (setting.key === 'levelup.color') return '#5865F2';
      return 'hello {user.mention}';
  }
}

describe.runIf(await postgresAvailable())('guild configuration', () => {
  it('creates a config row and default source rows on first load', async () => {
    const { config } = await setup();

    const loaded = await config.load(GUILD);

    // Leveling ships OFF: a bot that starts awarding XP the moment it joins has
    // made a decision the server owner never made.
    expect(loaded.config.enabled).toBe(false);
    expect(loaded.config.sources.message.enabled).toBe(true);
    expect(loaded.config.sources.message.cooldownSeconds).toBe(60);
    expect(loaded.version).toBe(1);
  });

  it('is idempotent — loading twice does not duplicate source rows', async () => {
    const { db, config } = await setup();
    await config.load(GUILD);
    await config.load(GUILD);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM xp_source_config WHERE guild_id = $1`,
      [GUILD],
    );
    expect(Number(rows[0]?.count)).toBe(4);
  });

  it('bumps the version on every write, including a source write', async () => {
    const { config } = await setup();
    const before = (await config.load(GUILD)).version;

    await config.update(GUILD, { enabled: true }, ACTOR);
    const afterConfig = await config.version(GUILD);
    expect(afterConfig).toBe(before + 1);

    // Source rows live in another table but are part of the same cached object,
    // so they must move the same version or the cache goes stale.
    await config.updateSource(GUILD, 'message', { cooldown_seconds: 30 });
    expect(await config.version(GUILD)).toBe(before + 2);
  });

  it('records who made the change', async () => {
    const { db, config } = await setup();
    await config.update(GUILD, { enabled: true }, ACTOR);

    const { rows } = await db.query<{ updated_by: string }>(
      `SELECT updated_by FROM leveling_config WHERE guild_id = $1`,
      [GUILD],
    );
    expect(rows[0]?.updated_by).toBe(ACTOR);
  });

  it('resets configuration without touching member XP', async () => {
    const { db, config } = await setup();
    await db.query(
      `INSERT INTO member_xp (guild_id, user_id, total_xp, level) VALUES ($1, $2, 500, 3)`,
      [GUILD, '777777777777777777'],
    );
    await config.update(GUILD, { enabled: true });

    await config.resetToDefaults(GUILD);

    expect((await config.load(GUILD)).config.enabled).toBe(false);
    const { rows } = await db.query<{ total_xp: string }>(
      `SELECT total_xp FROM member_xp WHERE guild_id = $1`,
      [GUILD],
    );
    expect(rows[0]?.total_xp).toBe('500');
  });

  it('maps a stored channel snowflake back as a string, not a number', async () => {
    // A snowflake exceeds Number.MAX_SAFE_INTEGER. Routing one through a JS
    // number silently changes the id, and the level-up message goes nowhere.
    const { config } = await setup();
    const big = '1234567890123456789';
    await config.update(GUILD, { levelup_channel_id: big, levelup_mode: 'fixed_channel' });

    const loaded = await config.load(GUILD);
    expect(loaded.config.notifications.channelId).toBe(big);
  });
});

describe.runIf(await postgresAvailable())('rules and rewards', () => {
  it('stores a restriction and returns it in the assembled config', async () => {
    const { config, rules } = await setup();
    await config.ensure(GUILD);

    await rules.addRule(
      GUILD,
      { kind: 'restrict_deny', targetType: 'channel', targetId: CHANNEL },
      ACTOR,
    );

    const loaded = await config.load(GUILD);
    expect(loaded.config.rules).toHaveLength(1);
    expect(loaded.config.rules[0]).toMatchObject({
      kind: 'restrict_deny',
      targetType: 'channel',
      targetId: CHANNEL,
    });
  });

  it('updates rather than duplicating when the same target is added twice', async () => {
    const { config, rules } = await setup();
    await config.ensure(GUILD);

    await rules.addRule(GUILD, {
      kind: 'boost',
      targetType: 'role',
      targetId: ROLE,
      bonusBps: 2500,
    });
    await rules.addRule(GUILD, {
      kind: 'boost',
      targetType: 'role',
      targetId: ROLE,
      bonusBps: 5000,
    });

    const loaded = await config.load(GUILD);
    expect(loaded.config.rules).toHaveLength(1);
    expect(loaded.config.rules[0]?.bonusBps).toBe(5000);
  });

  it('lets a target be both denied and boosted, because the engine resolves it', async () => {
    // They are different `kind`s, so the unique index must not collide. The
    // pipeline is what decides that the restriction wins.
    const { config, rules } = await setup();
    await config.ensure(GUILD);

    await rules.addRule(GUILD, { kind: 'restrict_deny', targetType: 'role', targetId: ROLE });
    await rules.addRule(GUILD, {
      kind: 'boost',
      targetType: 'role',
      targetId: ROLE,
      bonusBps: 5000,
    });

    expect((await config.load(GUILD)).config.rules).toHaveLength(2);
  });

  it('hides a broken reward from the engine but keeps it for the admin', async () => {
    const { config, rules } = await setup();
    await config.ensure(GUILD);
    await rules.addReward(GUILD, 5, ROLE, ACTOR);

    expect((await config.load(GUILD)).config.rewards).toHaveLength(1);

    await rules.markRewardBroken(GUILD, ROLE, 'hierarchy');

    // Gone from the engine's view...
    expect((await config.load(GUILD)).config.rewards).toHaveLength(0);
    // ...but still listed, with the reason, so it can be fixed.
    const listed = await rules.listRewards(GUILD);
    expect(listed).toEqual([{ level: 5, roleId: ROLE, brokenReason: 'hierarchy' }]);
  });

  it('un-breaks a reward when the admin re-adds it', async () => {
    const { config, rules } = await setup();
    await config.ensure(GUILD);
    await rules.addReward(GUILD, 5, ROLE);
    await rules.markRewardBroken(GUILD, ROLE, 'role_deleted');

    await rules.addReward(GUILD, 5, ROLE);

    expect((await rules.listRewards(GUILD))[0]?.brokenReason).toBeNull();
  });

  it('removes every reward at a level when no role is named', async () => {
    const { config, rules } = await setup();
    await config.ensure(GUILD);
    await rules.addReward(GUILD, 5, ROLE);
    await rules.addReward(GUILD, 5, '888888888888888888');

    expect(await rules.removeReward(GUILD, 5)).toBe(2);
    expect(await rules.listRewards(GUILD)).toHaveLength(0);
  });
});

describe.runIf(await postgresAvailable())('the configuration cache', () => {
  it('serves from memory and reloads only when the version moves', async () => {
    const { config } = await setup();
    const cache = createConfigCache({ repository: config, ttlMs: 0 });

    await cache.get(GUILD);
    expect(cache.stats.misses).toBe(1);

    // TTL of zero forces a revalidation every time — but an unchanged version
    // must not cause a full reload.
    await cache.get(GUILD);
    expect(cache.stats.revalidations).toBe(1);
    expect(cache.stats.misses).toBe(1);

    await config.update(GUILD, { enabled: true });
    const after = await cache.get(GUILD);
    expect(after.enabled).toBe(true);
  });

  it('serves stale data until invalidated when the TTL has not expired', async () => {
    // This is the exact reason `invalidate()` must be called on the write path
    // rather than relying on the version check.
    const { config } = await setup();
    const cache = createConfigCache({ repository: config, ttlMs: 600_000 });

    expect((await cache.get(GUILD)).enabled).toBe(false);
    await config.update(GUILD, { enabled: true });
    expect((await cache.get(GUILD)).enabled).toBe(false);

    cache.invalidate(GUILD);
    expect((await cache.get(GUILD)).enabled).toBe(true);
  });
});

describe.runIf(await postgresAvailable())('the audit log', () => {
  it('records an entry and reads it back newest first', async () => {
    const { audit } = await setup();

    await audit.record(GUILD, { actorId: ACTOR, action: 'xp.add', targetUserId: '1', after: { totalXp: 100 } });
    await audit.record(GUILD, { actorId: ACTOR, action: 'config.set:enabled' });

    const recent = await audit.recent(GUILD);
    expect(recent[0]?.action).toBe('config.set:enabled');
    expect(recent[1]?.after).toEqual({ totalXp: 100 });
  });

  it('truncates an over-long reason rather than failing the write', async () => {
    // The CHECK constraint caps it at 200. An admin pasting an essay must not
    // cause the XP change itself to error.
    const { audit } = await setup();
    await audit.record(GUILD, { action: 'xp.add', reason: 'x'.repeat(500) });

    const recent = await audit.recent(GUILD);
    expect(recent[0]?.reason).toHaveLength(200);
  });

  it('accepts a settings key with a colon in the action name', async () => {
    const { audit } = await setup();
    const setting = findSetting('curve.type');
    await audit.record(GUILD, { action: `config.set:${setting?.key ?? ''}` });
    expect((await audit.recent(GUILD))[0]?.action).toBe('config.set:curve.type');
  });
});
