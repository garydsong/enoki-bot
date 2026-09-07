import type { Database } from '../../../../platform/db/pool.js';
import type { CardConfigRepository } from '../../ports/cards.js';

export type { CardConfigRepository, MemberCardConfig } from '../../ports/cards.js';

/**
 * Per-member card overrides.
 *
 * NULL means INHERIT, which is why "reset to the server default" is a delete
 * rather than a sentinel value — there is no way to store "explicitly the same
 * as the guild", and no reason to want one.
 */
export function createCardConfigRepository(db: Database): CardConfigRepository {
  return {
    async get(guildId, userId) {
      const { rows } = await db.query<{
        accent_color: number | null;
        background_url: string | null;
      }>(
        `SELECT accent_color, background_url FROM member_card_config
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId],
      );
      const row = rows[0];
      if (!row) return null;
      return { accentColor: row.accent_color, backgroundUrl: row.background_url };
    },

    async set(guildId, userId, config) {
      await db.query(
        `INSERT INTO member_card_config (guild_id, user_id, accent_color, background_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (guild_id, user_id)
         DO UPDATE SET accent_color = EXCLUDED.accent_color,
                       background_url = EXCLUDED.background_url,
                       updated_at = now()`,
        [guildId, userId, config.accentColor, config.backgroundUrl],
      );
    },

    async clear(guildId, userId) {
      await db.query(`DELETE FROM member_card_config WHERE guild_id = $1 AND user_id = $2`, [
        guildId,
        userId,
      ]);
    },
  };
}
