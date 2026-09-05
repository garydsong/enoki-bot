import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { createGuildRepository } from '../../src/platform/guilds/guildRepository.js';
import { createKvRepository } from '../../src/platform/state/kvRepository.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';

const CORE = join(import.meta.dirname, '..', '..', 'migrations');
const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';

let temp: TempDatabase | null = null;
afterEach(async () => {
  await temp?.drop();
  temp = null;
});

async function migrated() {
  temp = await createTempDatabase();
  await runMigrations(temp.db, [CORE], silentLogger);
  return temp.db;
}

describe.runIf(await postgresAvailable())('guild lifecycle', () => {
  it('creates a guild on first sight', async () => {
    const repo = createGuildRepository(await migrated());
    const row = await repo.upsert(GUILD_A, 'Test Server');

    expect(row.guildId).toBe(GUILD_A);
    expect(row.nameSnapshot).toBe('Test Server');
    expect(row.isActive).toBe(true);
    expect(row.leftAt).toBeNull();
  });

  /**
   * GUILD_CREATE fires on EVERY reconnect, not only a real join. If this were
   * an INSERT, the first network blip would produce a duplicate-key error storm.
   */
  it('is idempotent across reconnects', async () => {
    const repo = createGuildRepository(await migrated());

    const first = await repo.upsert(GUILD_A, 'Test Server');
    for (let i = 0; i < 5; i++) await repo.upsert(GUILD_A, 'Test Server');

    expect(await repo.countActive()).toBe(1);
    const again = await repo.get(GUILD_A);
    expect(again?.joinedAt.getTime()).toBe(first.joinedAt.getTime());
  });

  it('updates the name snapshot when a guild is renamed', async () => {
    const repo = createGuildRepository(await migrated());
    await repo.upsert(GUILD_A, 'Old Name');
    await repo.upsert(GUILD_A, 'New Name');
    expect((await repo.get(GUILD_A))?.nameSnapshot).toBe('New Name');
  });

  it('soft-deletes on removal, retaining the row', async () => {
    const repo = createGuildRepository(await migrated());
    await repo.upsert(GUILD_A, 'Test Server');
    await repo.markInactive(GUILD_A);

    const row = await repo.get(GUILD_A);
    expect(row).not.toBeNull();
    expect(row?.isActive).toBe(false);
    expect(row?.leftAt).toBeInstanceOf(Date);
    expect(await repo.countActive()).toBe(0);
  });

  /** US-12: rejoining within the retention window restores everything. */
  it('restores a guild on rejoin', async () => {
    const repo = createGuildRepository(await migrated());
    await repo.upsert(GUILD_A, 'Test Server');
    await repo.markInactive(GUILD_A);

    const rejoined = await repo.upsert(GUILD_A, 'Test Server');
    expect(rejoined.isActive).toBe(true);
    expect(rejoined.leftAt).toBeNull();
    expect(await repo.countActive()).toBe(1);
  });

  it('keeps guilds isolated from one another', async () => {
    const repo = createGuildRepository(await migrated());
    await repo.upsert(GUILD_A, 'Alpha');
    await repo.upsert(GUILD_B, 'Beta');
    await repo.markInactive(GUILD_A);

    expect((await repo.get(GUILD_A))?.isActive).toBe(false);
    expect((await repo.get(GUILD_B))?.isActive).toBe(true);
    expect(await repo.countActive()).toBe(1);
  });

  it('returns null for a guild it has never seen', async () => {
    const repo = createGuildRepository(await migrated());
    expect(await repo.get('999999999999999999')).toBeNull();
  });

  /**
   * Snowflakes are BIGINT in the schema and strings in the application
   * (decision A9). node-postgres returns int8 as a string, which is exactly
   * right — parsing them as JS numbers would silently corrupt IDs above
   * Number.MAX_SAFE_INTEGER.
   */
  it('round-trips a large snowflake without precision loss', async () => {
    const repo = createGuildRepository(await migrated());
    const big = '1545460676426993754'; // > Number.MAX_SAFE_INTEGER
    await repo.upsert(big, 'Big');

    const row = await repo.get(big);
    expect(row?.guildId).toBe(big);
    expect(typeof row?.guildId).toBe('string');
    expect(Number(big).toString()).not.toBe(big); // proves the hazard is real
  });
});

describe.runIf(await postgresAvailable())('platform kv', () => {
  it('stores and reads a value', async () => {
    const kv = createKvRepository(await migrated());
    expect(await kv.get('commands:global')).toBeNull();
    await kv.set('commands:global', 'abc123');
    expect(await kv.get('commands:global')).toBe('abc123');
  });

  it('overwrites on repeat set', async () => {
    const kv = createKvRepository(await migrated());
    await kv.set('k', 'one');
    await kv.set('k', 'two');
    expect(await kv.get('k')).toBe('two');
  });
});

describe.runIf(await postgresAvailable())('transactions', () => {
  it('commits on success', async () => {
    const db = await migrated();
    await db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO guild (guild_id, name_snapshot) VALUES ($1, $2)`,
        [GUILD_A, 'Committed'],
      );
    });
    expect((await createGuildRepository(db).get(GUILD_A))?.nameSnapshot).toBe('Committed');
  });

  it('rolls back everything on failure', async () => {
    const db = await migrated();
    await expect(
      db.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO guild (guild_id, name_snapshot) VALUES ($1, $2)`, [
          GUILD_A,
          'Should vanish',
        ]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await createGuildRepository(db).get(GUILD_A)).toBeNull();
  });

  it('releases the connection back to the pool even on failure', async () => {
    const db = await migrated();
    for (let i = 0; i < 30; i++) {
      await db.withTransaction(async () => {
        throw new Error('fail');
      }).catch(() => {});
    }
    // If connections leaked, the pool (max 10) would now be exhausted.
    expect(await db.ping()).toBe(true);
  });
});
