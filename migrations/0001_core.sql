-- Core platform schema (spec `06` §2.1, §2.13; roadmap M1).
--
-- Guild isolation is structural, not conventional: `guild` is the root of every
-- guild-scoped tree, and every table a module adds later cascades from it. That
-- makes purging a guild one statement and makes it impossible to have an orphan
-- row belonging to nobody.

-- ---------------------------------------------------------------------------
-- guild — presence and lifecycle
-- ---------------------------------------------------------------------------
CREATE TABLE guild (
  guild_id       BIGINT      PRIMARY KEY,
  name_snapshot  TEXT,
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at        TIMESTAMPTZ,
  -- false while the bot is removed. Data is RETAINED until the retention job
  -- (default 30 days) so an accidental kick is recoverable.
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Job scans iterate active guilds; partial index keeps that cheap once a
-- long-lived deployment accumulates departed guilds.
CREATE INDEX guild_active_idx ON guild (guild_id) WHERE is_active;

COMMENT ON COLUMN guild.is_active IS
  'False when the bot was removed. NEVER set from GUILD_DELETE with unavailable=true — that is a Discord outage, not a removal.';

-- ---------------------------------------------------------------------------
-- job_run — background job bookkeeping, idempotency and single-flight
-- ---------------------------------------------------------------------------
-- Insert-before-act gives free idempotency: the highlights poster (M13) inserts
-- (guild, period) before posting, so a restart mid-post cannot double-post.
CREATE TABLE job_run (
  job_name    TEXT        NOT NULL,
  scope_key   TEXT        NOT NULL DEFAULT '',
  status      TEXT        NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error       TEXT,
  PRIMARY KEY (job_name, scope_key)
);

-- "When did each job last succeed?" — the query behind /level debug health.
-- A silently stopped tick job is the worst failure mode in this system
-- (voice XP just stops, with no error anywhere), so this index exists to make
-- that question cheap to ask.
CREATE INDEX job_run_last_success_idx
  ON job_run (job_name, finished_at DESC)
  WHERE status = 'succeeded';

-- ---------------------------------------------------------------------------
-- platform_kv — small bookkeeping values that do not warrant their own table
-- ---------------------------------------------------------------------------
-- Currently only the registered command-set hash, so a restart does not
-- re-upload an unchanged command set (Discord allows 200 global command
-- creates per day; a dev restart loop exhausts that quickly).
CREATE TABLE platform_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
