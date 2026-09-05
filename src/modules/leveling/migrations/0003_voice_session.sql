-- Voice sessions (spec `04` §8.2; roadmap M9).
--
-- Voice is the ONLY stateful, time-based XP source, and the only one that can
-- lose data across a restart. Everything in this table exists to bound that
-- loss to a single tick.
--
-- The crediting strategy is ADR-004: periodic ticks plus an end-of-session
-- flush. `last_credited_at` is a WATERMARK — everything before it is paid for —
-- so a crash costs at most the un-credited remainder, and a restart resumes by
-- moving the watermark to now rather than by crediting the downtime (we cannot
-- prove anyone was active during it, and paying for it would reward crashes).

CREATE TABLE voice_session (
  id                       BIGSERIAL PRIMARY KEY,
  guild_id                 BIGINT      NOT NULL REFERENCES guild(guild_id) ON DELETE CASCADE,
  user_id                  BIGINT      NOT NULL,
  channel_id               BIGINT      NOT NULL,

  started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Everything before this instant has been credited. Advancing it is what
  -- makes crediting idempotent under a retry.
  last_credited_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ELIGIBLE time, not wall-clock, and it survives a channel move — otherwise
  -- hopping channels every two hours defeats anti-AFK, which is the obvious
  -- exploit (spec `04` §8.5).
  accrued_eligible_seconds BIGINT      NOT NULL DEFAULT 0 CHECK (accrued_eligible_seconds >= 0),
  credited_xp              BIGINT      NOT NULL DEFAULT 0 CHECK (credited_xp >= 0),

  is_eligible              BOOLEAN     NOT NULL DEFAULT false,
  ineligible_since         TIMESTAMPTZ,

  -- Updated every tick. A session whose heartbeat has stopped is an orphan
  -- left behind by a crash, and the sweep closes it.
  last_heartbeat_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at                 TIMESTAMPTZ
);

-- EXACTLY ONE OPEN SESSION PER MEMBER, enforced by the database rather than by
-- application care. Two open sessions would double-credit every tick, and the
-- race that creates them (a rapid leave/join, or a reconnect racing the
-- reconciler) is precisely the case application-level checking gets wrong.
CREATE UNIQUE INDEX voice_session_one_open
  ON voice_session (guild_id, user_id) WHERE ended_at IS NULL;

-- Eligibility depends on OTHER members' states, so a single VOICE_STATE_UPDATE
-- re-evaluates every session in the affected channel. This index serves that.
CREATE INDEX voice_session_channel_idx
  ON voice_session (guild_id, channel_id) WHERE ended_at IS NULL;

-- The tick job's scan, and the orphan sweep.
CREATE INDEX voice_session_open_idx
  ON voice_session (last_credited_at) WHERE ended_at IS NULL;

-- Retention: closed sessions are purged by age (M10).
CREATE INDEX voice_session_ended_idx ON voice_session (ended_at) WHERE ended_at IS NOT NULL;
