import type { Database, Queryable } from '../db/pool.js';

/**
 * Guild lifecycle persistence.
 *
 * Every write here is an UPSERT because `GUILD_CREATE` fires on every reconnect,
 * not only on a real join. Handling it any other way produces duplicate-key
 * errors on the first network blip.
 *
 * The critical distinction this module encodes: `GUILD_DELETE` with
 * `unavailable: true` is a DISCORD OUTAGE, not a removal. Treating it as a
 * removal would mark healthy guilds inactive — and, once the retention job
 * exists, eventually delete a live server's XP because Discord had a bad
 * afternoon. `markInactive` is only ever called for a genuine removal.
 */

export interface GuildRow {
  readonly guildId: string;
  readonly nameSnapshot: string | null;
  readonly isActive: boolean;
  readonly joinedAt: Date;
  readonly leftAt: Date | null;
}

export interface GuildRepository {
  upsert(guildId: string, name: string | null): Promise<GuildRow>;
  markInactive(guildId: string): Promise<void>;
  get(guildId: string): Promise<GuildRow | null>;
  countActive(): Promise<number>;
  listActiveIds(): Promise<string[]>;
}

interface RawGuild {
  guild_id: string;
  name_snapshot: string | null;
  is_active: boolean;
  joined_at: Date;
  left_at: Date | null;
}

const toRow = (r: RawGuild): GuildRow => ({
  guildId: r.guild_id,
  nameSnapshot: r.name_snapshot,
  isActive: r.is_active,
  joinedAt: r.joined_at,
  leftAt: r.left_at,
});

export function createGuildRepository(db: Database | Queryable): GuildRepository {
  return {
    /**
     * Idempotent across reconnects. Re-joining a guild within the retention
     * window restores it (is_active back to true, left_at cleared) with all its
     * data intact — the whole point of soft-deleting on removal.
     */
    async upsert(guildId, name) {
      const { rows } = await db.query<RawGuild>(
        `INSERT INTO guild (guild_id, name_snapshot, is_active, left_at)
         VALUES ($1, $2, true, NULL)
         ON CONFLICT (guild_id) DO UPDATE
           SET name_snapshot = EXCLUDED.name_snapshot,
               is_active     = true,
               left_at       = NULL,
               updated_at    = now()
         RETURNING guild_id, name_snapshot, is_active, joined_at, left_at`,
        [guildId, name],
      );
      const row = rows[0];
      if (!row) throw new Error(`guild upsert returned no row for ${guildId}`);
      return toRow(row);
    },

    /** Soft delete. Data is retained until the retention job (default 30 days). */
    async markInactive(guildId) {
      await db.query(
        `UPDATE guild SET is_active = false, left_at = now(), updated_at = now()
         WHERE guild_id = $1`,
        [guildId],
      );
    },

    async get(guildId) {
      const { rows } = await db.query<RawGuild>(
        `SELECT guild_id, name_snapshot, is_active, joined_at, left_at
         FROM guild WHERE guild_id = $1`,
        [guildId],
      );
      const row = rows[0];
      return row ? toRow(row) : null;
    },

    async listActiveIds() {
      const { rows } = await db.query<{ guild_id: string }>(
        `SELECT guild_id FROM guild WHERE is_active`,
      );
      return rows.map((r) => r.guild_id);
    },

    async countActive() {
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM guild WHERE is_active`,
      );
      return Number(rows[0]?.count ?? 0);
    },
  };
}
