import type { Database, Queryable } from '../../../../platform/db/pool.js';
import type { PeriodType } from '../../domain/periods/calendar.js';

/**
 * Member XP persistence — and specifically THE ATOMIC INCREMENT, which is the
 * single most important statement in this system (spec `06` §4).
 *
 * FORBIDDEN, everywhere, forever:
 *
 *     SELECT total_xp ...      -- read
 *     compute newTotal          -- decide
 *     UPDATE SET total_xp = $1  -- write
 *
 * That is the classic lost-update bug. Two messages arriving in the same
 * millisecond both read 100, both write 120, and one award vanishes. It is
 * invisible under light load and constant under real load.
 *
 * Instead the database does the arithmetic, and we ask it what the value was
 * BEFORE and AFTER in one observation. That pair is what makes level-up
 * detection race-free: it is impossible for two concurrent awards to observe
 * the same "before", so it is impossible to announce the same level twice or
 * to miss a level entirely.
 *
 * Getting the OLD value out is the subtle part, and the obvious approaches are
 * both wrong:
 *
 *   - `RETURNING` sees the NEW row, never the old one.
 *   - `after - delta` is wrong the moment the value clamps at zero (XP removal
 *     below the floor applies a smaller delta than requested).
 *   - Self-joining the table in the UPDATE's FROM clause LOOKS right and passes
 *     every sequential test, but is wrong under concurrency: that join reads at
 *     the statement snapshot, while the UPDATE re-reads the latest row version
 *     after blocking on the lock. Concurrent awards then observe the SAME
 *     "before" — measured here at 27 distinct values across 50 awards, which
 *     would announce some levels twice and skip others.
 *
 * So we take an explicit row lock. `SELECT ... FOR UPDATE` serialises awards for
 * ONE member (different members never contend), and the read-then-write between
 * lock and commit is therefore atomic. This IS a read-modify-write — the
 * difference from the broken kind is the lock, which is the whole point.
 *
 * A faster lock-free path exists for the hot case: a positive delta never
 * clamps, so `before = after - delta` is exact and a single upsert suffices.
 * That optimisation is deliberately not taken while write volume is ~1/second;
 * one code path that is obviously correct beats two that are subtly different.
 */

import type { MemberXpRepository, MemberXpRow, StatDelta } from '../../ports/memberXp.js';

export type {
  MemberIdentity,
  MemberXpRepository,
  MemberXpRow,
  StatDelta,
  XpMutationResult,
} from '../../ports/memberXp.js';

interface RawMemberXp {
  guild_id: string;
  user_id: string;
  total_xp: string;
  level: number;
  display_name: string | null;
  avatar_hash: string | null;
  is_departed: boolean;
  last_xp_at: Date | null;
}

const toRow = (r: RawMemberXp): MemberXpRow => ({
  guildId: r.guild_id,
  userId: r.user_id,
  totalXp: Number(r.total_xp),
  level: r.level,
  displayName: r.display_name,
  avatarHash: r.avatar_hash,
  isDeparted: r.is_departed,
  lastXpAt: r.last_xp_at,
});

export function createMemberXpRepository(db: Database): MemberXpRepository {
  return {
    async addXp(tx, guildId, userId, delta, levelFor, identity) {
      // 1. Ensure the row exists. DO NOTHING rather than DO UPDATE so this is a
      //    no-op for an existing member and cannot clobber their snapshots.
      const inserted = await tx.query(
        `INSERT INTO member_xp (guild_id, user_id, total_xp, level, display_name, avatar_hash)
         VALUES ($1, $2, 0, 0, $3, $4)
         ON CONFLICT (guild_id, user_id) DO NOTHING`,
        [guildId, userId, identity?.displayName ?? null, identity?.avatarHash ?? null],
      );

      // 2. LOCK the row. Everything from here to COMMIT is serialised against
      //    other awards for this member, which is what makes the read below
      //    safe to act on.
      const locked = await tx.query<{ total_xp: string }>(
        `SELECT total_xp FROM member_xp WHERE guild_id = $1 AND user_id = $2 FOR UPDATE`,
        [guildId, userId],
      );
      const before = locked.rows[0];
      if (!before) throw new Error(`member_xp row missing for ${guildId}/${userId}`);

      const totalXpBefore = Number(before.total_xp);
      const totalXpAfter = Math.max(0, totalXpBefore + delta);

      // 3. Write the new total AND the derived level together. The level cannot
      //    be computed in SQL — the curve is guild configuration, not a
      //    database function — but because it is written in the same statement
      //    inside the same transaction, no session can ever observe level
      //    disagreeing with total_xp.
      await tx.query(
        `UPDATE member_xp
         SET total_xp     = $3::bigint,
             level        = $4::int,
             display_name = COALESCE($5, display_name),
             avatar_hash  = COALESCE($6, avatar_hash),
             last_xp_at   = now(),
             updated_at   = now()
         WHERE guild_id = $1 AND user_id = $2`,
        [
          guildId,
          userId,
          totalXpAfter,
          levelFor(totalXpAfter),
          identity?.displayName ?? null,
          identity?.avatarHash ?? null,
        ],
      );

      return {
        totalXpBefore,
        totalXpAfter,
        appliedDelta: totalXpAfter - totalXpBefore,
        isNewMember: (inserted.rowCount ?? 0) > 0,
      };
    },

    async setTotalXp(tx, guildId, userId, totalXp, levelFor) {
      const target = Math.max(0, Math.floor(totalXp));
      const inserted = await tx.query(
        `INSERT INTO member_xp (guild_id, user_id, total_xp, level)
         VALUES ($1, $2, 0, 0)
         ON CONFLICT (guild_id, user_id) DO NOTHING`,
        [guildId, userId],
      );

      const locked = await tx.query<{ total_xp: string }>(
        `SELECT total_xp FROM member_xp WHERE guild_id = $1 AND user_id = $2 FOR UPDATE`,
        [guildId, userId],
      );
      const before = locked.rows[0];
      if (!before) throw new Error(`member_xp row missing for ${guildId}/${userId}`);

      await tx.query(
        `UPDATE member_xp SET total_xp = $3::bigint, level = $4::int, updated_at = now()
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId, target, levelFor(target)],
      );

      const totalXpBefore = Number(before.total_xp);
      const totalXpAfter = target;
      return {
        totalXpBefore,
        totalXpAfter,
        appliedDelta: totalXpAfter - totalXpBefore,
        isNewMember: (inserted.rowCount ?? 0) > 0,
      };
    },

    async get(guildId, userId) {
      const { rows } = await db.query<RawMemberXp>(
        `SELECT guild_id, user_id, total_xp, level, display_name, avatar_hash, is_departed, last_xp_at
         FROM member_xp WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId],
      );
      const row = rows[0];
      return row ? toRow(row) : null;
    },

    /**
     * Rank is COMPUTED, never stored (spec `04` §4.4). Storing it would mean
     * rewriting every member of a guild on every award.
     *
     * Ordering is XP descending, then user id ASCENDING — matching
     * member_xp_leaderboard_idx, so rank and the leaderboard can never
     * disagree. "Ahead of me" is therefore: more XP, or the same XP and a
     * LOWER id. Writing that as a plain tuple comparison gets the tie-break
     * backwards, because the second column sorts the other way.
     *
     * The outer row must come from `me`: an aggregate over an empty set still
     * returns one row, so `SELECT count(*)+1 WHERE <no such member>` would
     * cheerfully report rank 1 for someone who does not exist.
     */
    async rankOf(guildId, userId) {
      const { rows } = await db.query<{ rank: string | null }>(
        `SELECT CASE WHEN me.total_xp > 0 THEN (
                  SELECT count(*) + 1
                  FROM member_xp AS o
                  WHERE o.guild_id = me.guild_id
                    AND o.total_xp > 0
                    AND (o.total_xp > me.total_xp
                         OR (o.total_xp = me.total_xp AND o.user_id < me.user_id))
                ) END AS rank
         FROM member_xp AS me
         WHERE me.guild_id = $1 AND me.user_id = $2`,
        [guildId, userId],
      );
      const rank = rows[0]?.rank;
      return rank == null ? null : Number(rank);
    },

    async countRanked(guildId) {
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM member_xp WHERE guild_id = $1 AND total_xp > 0`,
        [guildId],
      );
      return Number(rows[0]?.count ?? 0);
    },

    async markDeparted(guildId, userId, departed) {
      await db.query(
        `UPDATE member_xp SET is_departed = $3, updated_at = now()
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId, departed],
      );
    },

    async reset(guildId, userId) {
      // Keeps the row (and therefore the statistics and name snapshot);
      // only the score is cleared. ADR-014.
      await db.query(
        `UPDATE member_xp SET total_xp = 0, level = 0, updated_at = now()
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId],
      );
    },

    async resetGuild(guildId) {
      const result = await db.query(
        `UPDATE member_xp SET total_xp = 0, level = 0, updated_at = now() WHERE guild_id = $1`,
        [guildId],
      );
      return result.rowCount ?? 0;
    },

    /**
     * Changing the curve re-levels everyone instantly because level is derived
     * — but the denormalised column still has to catch up for SQL sorting.
     * Done in one pass rather than per member.
     */
    async relevelGuild(guildId, levelFor) {
      const { rows } = await db.query<{ user_id: string; total_xp: string }>(
        `SELECT user_id, total_xp FROM member_xp WHERE guild_id = $1`,
        [guildId],
      );
      if (rows.length === 0) return 0;

      const ids = rows.map((r) => r.user_id);
      const levels = rows.map((r) => levelFor(Number(r.total_xp)));

      // One statement rather than one per member: a large guild would
      // otherwise mean thousands of round trips after a curve change.
      await db.query(
        `UPDATE member_xp AS m
         SET level = v.level, updated_at = now()
         FROM (SELECT unnest($2::bigint[]) AS user_id, unnest($3::int[]) AS level) AS v
         WHERE m.guild_id = $1 AND m.user_id = v.user_id`,
        [guildId, ids, levels],
      );
      return rows.length;
    },

    // Delegate to the free functions below, which stay exported because the
    // voice and reaction sources (M9/M11) write statistics inside transactions
    // of their own.
    bumpStats,
    bumpPeriodXp,
  };
}

// ---------------------------------------------------------------------------
// Statistics and period buckets — written in the SAME transaction as the XP
// ---------------------------------------------------------------------------

export async function bumpStats(
  tx: Queryable,
  guildId: string,
  userId: string,
  delta: StatDelta,
): Promise<void> {
  await tx.query(
    `INSERT INTO member_stats (guild_id, user_id, messages_counted, voice_seconds,
                               reactions_given, reactions_received, levelups_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       messages_counted   = member_stats.messages_counted   + EXCLUDED.messages_counted,
       voice_seconds      = member_stats.voice_seconds      + EXCLUDED.voice_seconds,
       reactions_given    = member_stats.reactions_given    + EXCLUDED.reactions_given,
       reactions_received = member_stats.reactions_received + EXCLUDED.reactions_received,
       levelups_count     = member_stats.levelups_count     + EXCLUDED.levelups_count,
       updated_at         = now()`,
    [
      guildId,
      userId,
      delta.messagesCounted ?? 0,
      delta.voiceSeconds ?? 0,
      delta.reactionsGiven ?? 0,
      delta.reactionsReceived ?? 0,
      delta.levelups ?? 0,
    ],
  );
}

/**
 * Add to a period bucket. The "reset" is the caller passing a different
 * `periodStart` once the clock crosses the boundary — no job, no deletion.
 */
export async function bumpPeriodXp(
  tx: Queryable,
  guildId: string,
  userId: string,
  periodType: PeriodType,
  periodStart: Date,
  xp: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO member_period_xp (guild_id, user_id, period_type, period_start, xp)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (guild_id, user_id, period_type, period_start)
     DO UPDATE SET xp = member_period_xp.xp + EXCLUDED.xp, updated_at = now()`,
    [guildId, userId, periodType, periodStart, xp],
  );
}
