import type { GuildRepository } from './guildRepository.js';
import type { Logger } from '../logging/logger.js';

/**
 * STARTUP GUILD RECONCILIATION.
 *
 * This exists because of a discord.js behaviour that is easy to miss and
 * silently corrupts state: `guildCreate` is emitted ONLY when
 * `client.ws.status === Status.Ready`. Guilds the bot is already in arrive
 * during the initial sync, BEFORE that status is set, so the event never fires
 * for them.
 *
 * Relying on `guildCreate` alone therefore means a guild row is created only
 * for guilds joined while the process happens to be running. Every guild the
 * bot was already in stays absent from the database forever — and since every
 * guild-scoped table cascades from `guild`, the first write for that guild
 * fails on a foreign key. The symptom would appear one milestone later, far
 * from the cause.
 *
 * Reconciling on ready also fixes the offline cases the event stream cannot
 * cover by definition: a guild joined while the bot was down (no event), and a
 * guild the bot was removed from while it was down (no GUILD_DELETE).
 */

export interface GuildSnapshot {
  readonly id: string;
  readonly name: string;
  /** discord.js marks a guild unavailable during a Discord outage. */
  readonly available: boolean;
}

export interface ReconcileResult {
  readonly seen: number;
  readonly upserted: number;
  readonly markedInactive: string[];
}

export async function reconcileGuilds(
  repo: GuildRepository,
  snapshot: readonly GuildSnapshot[],
  log: Logger,
): Promise<ReconcileResult> {
  const present = new Set(snapshot.map((g) => g.id));

  let upserted = 0;
  for (const guild of snapshot) {
    await repo.upsert(guild.id, guild.name);
    upserted++;
  }

  // A guild in the database but NOT in the gateway's snapshot means the bot was
  // removed while offline. Note this uses cache PRESENCE, not availability: an
  // unavailable guild is still in the snapshot, so a Discord outage cannot be
  // mistaken for a removal.
  const active = await repo.listActiveIds();
  const departed = active.filter((id) => !present.has(id));

  for (const id of departed) {
    await repo.markInactive(id);
    log.info({ guildId: id }, 'removed from this guild while offline; data retained');
  }

  return { seen: snapshot.length, upserted, markedInactive: departed };
}
