import type { Database } from '../../../../platform/db/pool.js';
import type { ReactionAwardRepository } from '../../ports/reactions.js';

export type { ReactionAwardRepository, ReactionKey } from '../../ports/reactions.js';

/**
 * Durable reaction dedup. See `ports/reactions.ts` for why this is persisted
 * while the other sources' idempotency is not.
 */
export function createReactionAwardRepository(db: Database): ReactionAwardRepository {
  return {
    async claim(key, messageAuthorId) {
      // The primary key IS the rule. `DO NOTHING` plus a rowCount check is one
      // round trip and is atomic against a double-click; a SELECT-then-INSERT
      // would lose that race, which is the only race this table exists for.
      const result = await db.query(
        `INSERT INTO reaction_award (guild_id, message_id, reactor_id, emoji, message_author_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (guild_id, message_id, reactor_id, emoji) DO NOTHING`,
        [key.guildId, key.messageId, key.reactorId, key.emoji, messageAuthorId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async countReactors(guildId, messageId) {
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(DISTINCT reactor_id)::text AS count
         FROM reaction_award WHERE guild_id = $1 AND message_id = $2`,
        [guildId, messageId],
      );
      return Number(rows[0]?.count ?? 0);
    },

    async forget(key) {
      await db.query(
        `DELETE FROM reaction_award
         WHERE guild_id = $1 AND message_id = $2 AND reactor_id = $3 AND emoji = $4`,
        [key.guildId, key.messageId, key.reactorId, key.emoji],
      );
    },
  };
}
