import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/db/migrator.js';
import { createGuildRepository } from '../../src/platform/guilds/guildRepository.js';
import { reconcileGuilds, type GuildSnapshot } from '../../src/platform/guilds/reconcile.js';
import { createTempDatabase, postgresAvailable, silentLogger, type TempDatabase } from './helpers/db.js';

const CORE = join(import.meta.dirname, '..', '..', 'migrations');

const A = '111111111111111111';
const B = '222222222222222222';
const C = '333333333333333333';

const snap = (id: string, name = `Guild ${id.slice(0, 3)}`, available = true): GuildSnapshot => ({
  id,
  name,
  available,
});

let temp: TempDatabase | null = null;
afterEach(async () => {
  await temp?.drop();
  temp = null;
});

async function repo() {
  temp = await createTempDatabase();
  await runMigrations(temp.db, [CORE], silentLogger);
  return createGuildRepository(temp.db);
}

/**
 * REGRESSION SUITE for a real M1 bug found by running the bot.
 *
 * discord.js emits `guildCreate` only once `client.ws.status === Status.Ready`.
 * Guilds the bot is already in arrive during the initial sync, BEFORE that — so
 * the event never fires for them, and relying on it alone meant those guilds
 * never got a row. Every guild-scoped table cascades from `guild`, so the first
 * write for such a guild would have failed on a foreign key, one milestone
 * later and far from the cause.
 */
describe.runIf(await postgresAvailable())('startup guild reconciliation', () => {
  it('creates rows for guilds the bot was ALREADY in (the bug)', async () => {
    const guilds = await repo();

    const result = await reconcileGuilds(guilds, [snap(A), snap(B)], silentLogger);

    expect(result.seen).toBe(2);
    expect(result.upserted).toBe(2);
    expect(await guilds.countActive()).toBe(2);
    expect((await guilds.get(A))?.isActive).toBe(true);
  });

  it('is idempotent across restarts', async () => {
    const guilds = await repo();
    const snapshot = [snap(A), snap(B)];

    await reconcileGuilds(guilds, snapshot, silentLogger);
    const joinedAt = (await guilds.get(A))?.joinedAt;
    await reconcileGuilds(guilds, snapshot, silentLogger);
    await reconcileGuilds(guilds, snapshot, silentLogger);

    expect(await guilds.countActive()).toBe(2);
    expect((await guilds.get(A))?.joinedAt.getTime()).toBe(joinedAt?.getTime());
  });

  it('picks up a guild JOINED while the bot was offline', async () => {
    const guilds = await repo();
    await reconcileGuilds(guilds, [snap(A)], silentLogger);

    // Bot was down; someone invited it to B. No guildCreate was ever received.
    await reconcileGuilds(guilds, [snap(A), snap(B)], silentLogger);

    expect(await guilds.countActive()).toBe(2);
    expect((await guilds.get(B))?.isActive).toBe(true);
  });

  it('marks a guild REMOVED while the bot was offline as inactive', async () => {
    const guilds = await repo();
    await reconcileGuilds(guilds, [snap(A), snap(B)], silentLogger);

    // Bot was down; it was kicked from B. No GUILD_DELETE was ever received.
    const result = await reconcileGuilds(guilds, [snap(A)], silentLogger);

    expect(result.markedInactive).toEqual([B]);
    expect((await guilds.get(B))?.isActive).toBe(false);
    expect(await guilds.countActive()).toBe(1);
  });

  it('retains the departed guild row rather than deleting it', async () => {
    const guilds = await repo();
    await reconcileGuilds(guilds, [snap(A, 'Keep My Data')], silentLogger);
    await reconcileGuilds(guilds, [], silentLogger);

    const row = await guilds.get(A);
    expect(row).not.toBeNull();
    expect(row?.nameSnapshot).toBe('Keep My Data');
    expect(row?.leftAt).toBeInstanceOf(Date);
  });

  it('restores a guild that was rejoined after being marked inactive', async () => {
    const guilds = await repo();
    await reconcileGuilds(guilds, [snap(A)], silentLogger);
    await reconcileGuilds(guilds, [], silentLogger);
    expect((await guilds.get(A))?.isActive).toBe(false);

    await reconcileGuilds(guilds, [snap(A)], silentLogger);

    const row = await guilds.get(A);
    expect(row?.isActive).toBe(true);
    expect(row?.leftAt).toBeNull();
  });

  /**
   * THE DANGEROUS CASE. An unavailable guild is still in the gateway's
   * snapshot, so a Discord outage must NOT be mistaken for a removal — that
   * would eventually delete a live server's data because Discord had a bad
   * afternoon.
   */
  it('does NOT mark an unavailable guild inactive during a Discord outage', async () => {
    const guilds = await repo();
    await reconcileGuilds(guilds, [snap(A), snap(B)], silentLogger);

    const result = await reconcileGuilds(
      guilds,
      [snap(A), snap(B, 'Guild 222', false)],
      silentLogger,
    );

    expect(result.markedInactive).toEqual([]);
    expect((await guilds.get(B))?.isActive).toBe(true);
  });

  it('updates name snapshots for renamed guilds', async () => {
    const guilds = await repo();
    await reconcileGuilds(guilds, [snap(A, 'Old Name')], silentLogger);
    await reconcileGuilds(guilds, [snap(A, 'New Name')], silentLogger);
    expect((await guilds.get(A))?.nameSnapshot).toBe('New Name');
  });

  it('handles an empty snapshot on a fresh database', async () => {
    const guilds = await repo();
    const result = await reconcileGuilds(guilds, [], silentLogger);
    expect(result).toMatchObject({ seen: 0, upserted: 0, markedInactive: [] });
  });

  it('handles many guilds at once', async () => {
    const guilds = await repo();
    const many = Array.from({ length: 40 }, (_, i) =>
      snap(String(100000000000000000n + BigInt(i))),
    );

    const result = await reconcileGuilds(guilds, many, silentLogger);

    expect(result.upserted).toBe(40);
    expect(await guilds.countActive()).toBe(40);
  });

  it('reconciles a mixed picture in one pass: kept, joined and departed', async () => {
    const guilds = await repo();
    await reconcileGuilds(guilds, [snap(A), snap(B)], silentLogger);

    const result = await reconcileGuilds(guilds, [snap(A), snap(C)], silentLogger);

    expect(result.markedInactive).toEqual([B]);
    expect((await guilds.get(A))?.isActive).toBe(true);
    expect((await guilds.get(B))?.isActive).toBe(false);
    expect((await guilds.get(C))?.isActive).toBe(true);
  });
});
