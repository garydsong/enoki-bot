import type { Database } from '../../../../platform/db/pool.js';
import type {
  CreditedInterval,
  VoiceSession,
  VoiceSessionRepository,
} from '../../ports/voice.js';

export type { VoiceSession, VoiceSessionRepository } from '../../ports/voice.js';

/**
 * Voice session persistence (spec `04` §8).
 *
 * TWO THINGS CARRY THE CORRECTNESS HERE, and both are in the database rather
 * than in application logic:
 *
 * 1. **The partial unique index** guarantees one open session per member. The
 *    application never checks-then-inserts, because the race that produces a
 *    duplicate — a rapid leave/join, or a reconnect racing the reconciler — is
 *    exactly the one a check-then-insert loses. `open()` is an upsert against
 *    that index.
 *
 * 2. **`claimInterval` reads and advances the watermark in ONE statement.** The
 *    tick job and an end-of-session flush can run concurrently for the same
 *    session; if either could read the watermark, compute, then write it, the
 *    interval would be credited twice. Instead the UPDATE computes the interval
 *    from the row it is already locking and returns it, so the same second can
 *    never be paid for twice however the calls interleave.
 *
 * All timestamps come from the DATABASE's clock (`now()`), not the process's,
 * so a machine with a drifting clock cannot credit time that did not pass.
 */

interface RawSession {
  id: string;
  guild_id: string;
  user_id: string;
  channel_id: string;
  started_at: Date;
  last_credited_at: Date;
  accrued_eligible_seconds: string;
  credited_xp: string;
  is_eligible: boolean;
  ineligible_since: Date | null;
  last_heartbeat_at: Date;
  ended_at: Date | null;
}

const toSession = (r: RawSession): VoiceSession => ({
  id: r.id,
  guildId: r.guild_id,
  userId: r.user_id,
  channelId: r.channel_id,
  startedAt: r.started_at,
  lastCreditedAt: r.last_credited_at,
  accruedEligibleSeconds: Number(r.accrued_eligible_seconds),
  creditedXp: Number(r.credited_xp),
  isEligible: r.is_eligible,
  ineligibleSince: r.ineligible_since,
  lastHeartbeatAt: r.last_heartbeat_at,
  endedAt: r.ended_at,
});

const COLUMN_NAMES = [
  'id',
  'guild_id',
  'user_id',
  'channel_id',
  'started_at',
  'last_credited_at',
  'accrued_eligible_seconds',
  'credited_xp',
  'is_eligible',
  'ineligible_since',
  'last_heartbeat_at',
  'ended_at',
] as const;

const COLUMNS = COLUMN_NAMES.join(', ');
/** Alias-qualified, for the statement that joins a CTE. */
const V_COLUMNS = COLUMN_NAMES.map((c) => `v.${c}`).join(', ');

export function createVoiceSessionRepository(db: Database): VoiceSessionRepository {
  return {
    async open(input) {
      // ON CONFLICT against the partial unique index: a member who is already
      // in a session simply gets it back, with the channel corrected. That is
      // the right answer for a reconnect and for a duplicated gateway event.
      const { rows } = await db.query<RawSession>(
        `INSERT INTO voice_session (guild_id, user_id, channel_id, is_eligible)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (guild_id, user_id) WHERE ended_at IS NULL
         DO UPDATE SET channel_id = EXCLUDED.channel_id,
                       last_heartbeat_at = now()
         RETURNING ${COLUMNS}`,
        [input.guildId, input.userId, input.channelId, input.eligible],
      );

      const row = rows[0];
      if (!row) throw new Error('failed to open a voice session');
      return toSession(row);
    },

    async find(guildId, userId) {
      const { rows } = await db.query<RawSession>(
        `SELECT ${COLUMNS} FROM voice_session
         WHERE guild_id = $1 AND user_id = $2 AND ended_at IS NULL`,
        [guildId, userId],
      );
      return rows[0] ? toSession(rows[0]) : null;
    },

    async openInChannel(guildId, channelId) {
      const { rows } = await db.query<RawSession>(
        `SELECT ${COLUMNS} FROM voice_session
         WHERE guild_id = $1 AND channel_id = $2 AND ended_at IS NULL`,
        [guildId, channelId],
      );
      return rows.map(toSession);
    },

    async openInGuild(guildId) {
      const { rows } = await db.query<RawSession>(
        `SELECT ${COLUMNS} FROM voice_session WHERE guild_id = $1 AND ended_at IS NULL`,
        [guildId],
      );
      return rows.map(toSession);
    },

    async allOpen() {
      const { rows } = await db.query<RawSession>(
        `SELECT ${COLUMNS} FROM voice_session WHERE ended_at IS NULL ORDER BY guild_id`,
      );
      return rows.map(toSession);
    },

    async moveTo(sessionId, channelId) {
      // A MUTATION, not a close-and-reopen: closing would reset the accrued
      // eligible time, and with it the anti-AFK timer.
      await db.query(
        `UPDATE voice_session SET channel_id = $2, last_heartbeat_at = now() WHERE id = $1`,
        [sessionId, channelId],
      );
    },

    /**
     * Read the un-credited interval and advance the watermark atomically.
     *
     * `maxSeconds` caps a single claim, which matters after downtime: a session
     * whose watermark is three hours stale must not pay out three hours of XP
     * in one lump. Startup reconciliation resets the watermark for exactly this
     * reason, and the cap is the belt to that braces.
     */
    async claimInterval(sessionId, maxSeconds) {
      // THE CTE IS NOT DECORATION. `RETURNING` reports the row as it is AFTER
      // the statement's own update, so computing the interval there would
      // measure `now() - now()` and claim zero seconds — silently awarding
      // nothing, forever, with no error anywhere.
      //
      // So the interval is computed in a CTE that reads the row BEFORE the
      // update, under `FOR UPDATE`. The lock is what makes concurrency safe:
      // a second claim blocks, re-reads the row Postgres just updated, sees
      // `now() > last_credited_at` is no longer true, and claims nothing.
      const { rows } = await db.query<RawSession & { claimed_seconds: string }>(
        `WITH claim AS (
           SELECT id,
                  LEAST(
                    EXTRACT(EPOCH FROM (now() - last_credited_at))::bigint,
                    COALESCE($2::bigint, 2147483647)
                  ) AS claimed_seconds
           FROM voice_session
           WHERE id = $1
             AND ended_at IS NULL
             AND is_eligible = true
             AND now() > last_credited_at
           FOR UPDATE
         )
         UPDATE voice_session AS v
         SET last_credited_at = now(),
             last_heartbeat_at = now(),
             accrued_eligible_seconds = v.accrued_eligible_seconds + claim.claimed_seconds
         FROM claim
         WHERE v.id = claim.id
         RETURNING ${V_COLUMNS},
                   claim.claimed_seconds`,
        [sessionId, maxSeconds ?? null],
      );

      const row = rows[0];
      if (!row) return null;

      const eligibleSeconds = Number(row.claimed_seconds);
      if (eligibleSeconds <= 0) return null;

      // `accrued_eligible_seconds` here is already the post-update value, so it
      // includes this claim — no adjustment.
      return { session: toSession(row), eligibleSeconds } satisfies CreditedInterval;
    },

    async setEligibility(sessionId, eligible) {
      // Becoming eligible moves the watermark to now, so the ineligible gap is
      // never credited — that is the whole mechanism, and it is why regaining
      // eligibility needs no separate bookkeeping.
      await db.query(
        `UPDATE voice_session
         SET is_eligible = $2,
             ineligible_since = CASE WHEN $2 THEN NULL ELSE COALESCE(ineligible_since, now()) END,
             last_credited_at = CASE WHEN $2 THEN now() ELSE last_credited_at END,
             last_heartbeat_at = now()
         WHERE id = $1 AND ended_at IS NULL AND is_eligible <> $2`,
        [sessionId, eligible],
      );
    },

    /**
     * The downtime rule, in one statement.
     *
     * The watermark moves to now() REGARDLESS of previous eligibility, because
     * the question "should the gap be credited?" has the same answer either
     * way: no. Expressing this as a sequence of setEligibility calls almost
     * works and is impossible to read.
     */
    async resume(sessionId, channelId, eligible) {
      await db.query(
        `UPDATE voice_session
         SET channel_id = $2,
             is_eligible = $3,
             ineligible_since = CASE WHEN $3 THEN NULL ELSE now() END,
             last_credited_at = now(),
             last_heartbeat_at = now()
         WHERE id = $1 AND ended_at IS NULL`,
        [sessionId, channelId, eligible],
      );
    },

    async recordAward(sessionId, xp) {
      await db.query(`UPDATE voice_session SET credited_xp = credited_xp + $2 WHERE id = $1`, [
        sessionId,
        xp,
      ]);
    },

    async heartbeat(sessionIds) {
      if (sessionIds.length === 0) return;
      await db.query(
        `UPDATE voice_session SET last_heartbeat_at = now() WHERE id = ANY($1::bigint[])`,
        [sessionIds],
      );
    },

    async close(sessionId, endedAt) {
      await db.query(
        `UPDATE voice_session SET ended_at = COALESCE($2, now())
         WHERE id = $1 AND ended_at IS NULL`,
        [sessionId, endedAt ?? null],
      );
    },

    /**
     * Close sessions whose heartbeat stopped.
     *
     * These are the residue of a crash: the member left while the bot was down,
     * so nothing will ever close them, and left alone they would be resumed
     * forever by reconciliation. They are closed at their last PROVEN-present
     * moment rather than at now(), which is the honest timestamp.
     */
    async closeOrphans(olderThanMs) {
      const result = await db.query(
        `UPDATE voice_session SET ended_at = last_heartbeat_at
         WHERE ended_at IS NULL
           AND last_heartbeat_at < now() - make_interval(secs => $1)`,
        [Math.floor(olderThanMs / 1000)],
      );
      return result.rowCount ?? 0;
    },

    async countOpen() {
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM voice_session WHERE ended_at IS NULL`,
      );
      return Number(rows[0]?.count ?? 0);
    },
  };
}
