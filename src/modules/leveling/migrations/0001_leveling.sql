-- Leveling module schema (spec `06`; roadmap M3).
--
-- GUILD ISOLATION IS STRUCTURAL, NOT CONVENTIONAL. Every table here has
-- guild_id as the first column of its primary key and cascades from `guild`,
-- so a row cannot exist without belonging to exactly one guild, and purging a
-- guild is a single DELETE.
--
-- Snowflakes are BIGINT (decision A9): they are 64-bit integers, they sort
-- correctly, and the index is half the size of TEXT. node-postgres returns
-- int8 as a STRING, which is exactly what we want — a snowflake exceeds
-- Number.MAX_SAFE_INTEGER, so parsing them as JS numbers silently corrupts IDs.
--
-- XP is BIGINT too: INT overflows at ~2.1 billion, which a long-lived guild
-- with a high multiplier can plausibly approach.

-- ---------------------------------------------------------------------------
-- guild_leveling_config — every scalar setting, one row per guild
-- ---------------------------------------------------------------------------
-- One wide row rather than a key/value table: the hot path reads the WHOLE
-- config on every message, and a KV table would need an aggregate for that
-- while pushing all typing into the application. The cost is a migration per
-- new setting, which is a feature (settings get reviewed), not a bug.
CREATE TABLE leveling_config (
  guild_id                      BIGINT PRIMARY KEY REFERENCES guild(guild_id) ON DELETE CASCADE,

  enabled                       BOOLEAN     NOT NULL DEFAULT false,

  -- curve ------------------------------------------------------------------
  curve_type                    TEXT        NOT NULL DEFAULT 'linear'
                                  CHECK (curve_type IN ('linear', 'exponential', 'flat')),
  curve_multiplier_bps          INT         NOT NULL DEFAULT 10000 CHECK (curve_multiplier_bps > 0),
  max_level                     INT         CHECK (max_level IS NULL OR max_level >= 0),
  hard_cap_xp                   BOOLEAN     NOT NULL DEFAULT false,

  -- notifications ----------------------------------------------------------
  levelup_mode                  TEXT        NOT NULL DEFAULT 'source_channel'
                                  CHECK (levelup_mode IN ('source_channel', 'fixed_channel', 'disabled')),
  levelup_channel_id            BIGINT,
  levelup_template              TEXT        NOT NULL DEFAULT '{user.mention} has reached level **{user.level}**. GG!',
  levelup_use_embed             BOOLEAN     NOT NULL DEFAULT false,
  levelup_embed_color           INT,
  levelup_delete_after_seconds  INT         CHECK (levelup_delete_after_seconds IS NULL OR levelup_delete_after_seconds > 0),
  levelup_only_on_reward_levels BOOLEAN     NOT NULL DEFAULT false,

  -- rewards ----------------------------------------------------------------
  reward_stacking               TEXT        NOT NULL DEFAULT 'stack'
                                  CHECK (reward_stacking IN ('stack', 'highest')),
  remove_on_level_down          BOOLEAN     NOT NULL DEFAULT true,
  reconcile_on_rank_command     BOOLEAN     NOT NULL DEFAULT false,
  max_roles_per_level           INT         NOT NULL DEFAULT 5 CHECK (max_roles_per_level > 0),

  -- boosters ---------------------------------------------------------------
  booster_stacking              TEXT        NOT NULL DEFAULT 'stack'
                                  CHECK (booster_stacking IN ('stack', 'highest')),
  max_multiplier_bps            INT         NOT NULL DEFAULT 100000 CHECK (max_multiplier_bps > 0),
  effort_enabled                BOOLEAN     NOT NULL DEFAULT false,
  effort_chars_per_xp           INT         NOT NULL DEFAULT 50 CHECK (effort_chars_per_xp > 0),
  effort_length_cap             INT         NOT NULL DEFAULT 10 CHECK (effort_length_cap >= 0),
  effort_attachment_xp          INT         NOT NULL DEFAULT 5 CHECK (effort_attachment_xp >= 0),

  -- contexts ---------------------------------------------------------------
  xp_in_threads                 BOOLEAN     NOT NULL DEFAULT true,
  xp_in_forum_posts             BOOLEAN     NOT NULL DEFAULT true,
  xp_in_voice_text              BOOLEAN     NOT NULL DEFAULT true,
  min_message_length            INT         NOT NULL DEFAULT 0 CHECK (min_message_length >= 0),

  -- voice (M9) -------------------------------------------------------------
  voice_min_members             INT         NOT NULL DEFAULT 1 CHECK (voice_min_members >= 0),
  voice_require_unmuted         BOOLEAN     NOT NULL DEFAULT true,
  voice_require_undeafened      BOOLEAN     NOT NULL DEFAULT true,
  voice_server_mute_inactive    BOOLEAN     NOT NULL DEFAULT true,
  voice_ignore_afk_channel      BOOLEAN     NOT NULL DEFAULT true,
  voice_ignore_bots_in_count    BOOLEAN     NOT NULL DEFAULT true,
  voice_tick_seconds            INT         NOT NULL DEFAULT 180 CHECK (voice_tick_seconds > 0),
  anti_afk_enabled              BOOLEAN     NOT NULL DEFAULT true,
  anti_afk_after_minutes        INT         NOT NULL DEFAULT 120 CHECK (anti_afk_after_minutes >= 0),
  anti_afk_decay_per_hour_bps   INT         NOT NULL DEFAULT 2500 CHECK (anti_afk_decay_per_hour_bps BETWEEN 0 AND 10000),
  anti_afk_floor_bps            INT         NOT NULL DEFAULT 1000 CHECK (anti_afk_floor_bps BETWEEN 0 AND 10000),

  -- periods ----------------------------------------------------------------
  timezone                      TEXT        NOT NULL DEFAULT 'UTC',
  week_start_day                TEXT        NOT NULL DEFAULT 'monday'
                                  CHECK (week_start_day IN ('monday','tuesday','wednesday','thursday','friday','saturday','sunday')),

  -- leaderboard ------------------------------------------------------------
  leaderboard_page_size         INT         NOT NULL DEFAULT 10 CHECK (leaderboard_page_size BETWEEN 1 AND 25),
  hide_departed_members         BOOLEAN     NOT NULL DEFAULT false,
  auto_reset_on_leave           BOOLEAN     NOT NULL DEFAULT false,

  -- administration ---------------------------------------------------------
  manual_xp_level_limit         INT         NOT NULL DEFAULT 100 CHECK (manual_xp_level_limit >= 0),
  manual_grant_max              BIGINT      NOT NULL DEFAULT 1000000 CHECK (manual_grant_max > 0),
  xp_command_owner_only         BOOLEAN     NOT NULL DEFAULT false,
  disable_resets                BOOLEAN     NOT NULL DEFAULT false,
  min_account_age_days          INT         NOT NULL DEFAULT 0 CHECK (min_account_age_days >= 0),
  min_member_age_hours          INT         NOT NULL DEFAULT 0 CHECK (min_member_age_hours >= 0),
  allow_self_reactions          BOOLEAN     NOT NULL DEFAULT false,

  -- meta -------------------------------------------------------------------
  -- Bumped on every write. The in-memory cache keys on it, which makes
  -- invalidation a comparison rather than a protocol.
  config_version                BIGINT      NOT NULL DEFAULT 1,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                    BIGINT
);

-- ---------------------------------------------------------------------------
-- xp_source_config — per-source tuning
-- ---------------------------------------------------------------------------
-- Separate from the wide config row because sources are a SET that will grow:
-- a future thread_create or event_attendance source adds a row, not a
-- migration of four more columns.
CREATE TABLE xp_source_config (
  guild_id            BIGINT NOT NULL REFERENCES guild(guild_id) ON DELETE CASCADE,
  source              TEXT   NOT NULL
                        CHECK (source IN ('message', 'voice', 'reaction_add', 'reaction_receive')),
  enabled             BOOLEAN NOT NULL DEFAULT false,
  min_xp              INT     NOT NULL CHECK (min_xp >= 0),
  max_xp              INT     NOT NULL CHECK (max_xp >= 0),
  cooldown_seconds    INT     NOT NULL DEFAULT 60 CHECK (cooldown_seconds >= 0),
  per_event_cap       INT     NOT NULL DEFAULT 500 CHECK (per_event_cap > 0),
  message_mode        TEXT    CHECK (message_mode IS NULL OR message_mode IN ('random', 'per_word')),
  reaction_max_per_message      INT DEFAULT 3 CHECK (reaction_max_per_message IS NULL OR reaction_max_per_message > 0),
  reaction_max_message_age_days INT CHECK (reaction_max_message_age_days IS NULL OR reaction_max_message_age_days > 0),
  PRIMARY KEY (guild_id, source),
  CONSTRAINT xp_source_range CHECK (min_xp <= max_xp)
);

-- ---------------------------------------------------------------------------
-- xp_rule — restrictions AND boosters, unified
-- ---------------------------------------------------------------------------
-- One table because they share targeting semantics entirely: one resolution
-- function, one cache, one contradiction check ("this role is both no-XP and a
-- booster"). See spec `04` §3.1.
CREATE TABLE xp_rule (
  id            BIGSERIAL PRIMARY KEY,
  guild_id      BIGINT      NOT NULL REFERENCES guild(guild_id) ON DELETE CASCADE,
  kind          TEXT        NOT NULL CHECK (kind IN ('restrict_deny', 'restrict_only', 'boost')),
  target_type   TEXT        NOT NULL CHECK (target_type IN ('channel','category','role','user','source','guild')),
  -- Snowflake, or a source name for target_type='source', or NULL for 'guild'.
  target_id     TEXT,
  bonus_bps     INT,
  source_scope  TEXT        CHECK (source_scope IS NULL OR source_scope IN ('message','voice','reaction_add','reaction_receive')),
  expires_at    TIMESTAMPTZ,
  note          TEXT,
  created_by    BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A boost without a bonus is meaningless; a restriction with one is confusing.
  CONSTRAINT xp_rule_bonus_only_on_boost
    CHECK ((kind = 'boost' AND bonus_bps IS NOT NULL) OR (kind <> 'boost' AND bonus_bps IS NULL))
);

-- One rule per target per kind per scope. A duplicate add updates instead.
-- COALESCE on the nullable columns because NULL never equals NULL in a unique
-- index, which would otherwise permit unlimited duplicate guild-wide rules.
CREATE UNIQUE INDEX xp_rule_unique_target
  ON xp_rule (guild_id, kind, target_type, COALESCE(target_id, ''), COALESCE(source_scope, ''));

-- The hot path loads a guild's ENTIRE rule set into memory (tens of rows, not
-- thousands), so this index serves that one query.
CREATE INDEX xp_rule_guild_idx ON xp_rule (guild_id, kind);
CREATE INDEX xp_rule_expiry_idx ON xp_rule (expires_at) WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- role_reward
-- ---------------------------------------------------------------------------
CREATE TABLE role_reward (
  id                  BIGSERIAL PRIMARY KEY,
  guild_id            BIGINT      NOT NULL REFERENCES guild(guild_id) ON DELETE CASCADE,
  rule_type           TEXT        NOT NULL DEFAULT 'exact' CHECK (rule_type IN ('exact', 'recurring')),
  level               INT         CHECK (level IS NULL OR level >= 0),
  every_n             INT         CHECK (every_n IS NULL OR every_n > 0),
  start_level         INT         CHECK (start_level IS NULL OR start_level >= 0),
  role_id             BIGINT      NOT NULL,
  -- Set when Discord refuses the role. The rule is KEPT: the admin may recreate
  -- a deleted role, and silently discarding configuration is hostile.
  broken_reason       TEXT        CHECK (broken_reason IS NULL OR broken_reason IN ('role_deleted','hierarchy','missing_permission','managed')),
  broken_notified_at  TIMESTAMPTZ,
  created_by          BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT role_reward_shape CHECK (
    (rule_type = 'exact'     AND level IS NOT NULL AND every_n IS NULL AND start_level IS NULL) OR
    (rule_type = 'recurring' AND level IS NULL     AND every_n IS NOT NULL AND start_level IS NOT NULL)
  )
);

CREATE UNIQUE INDEX role_reward_unique_exact
  ON role_reward (guild_id, level, role_id) WHERE rule_type = 'exact';
CREATE UNIQUE INDEX role_reward_unique_recurring
  ON role_reward (guild_id, every_n, start_level, role_id) WHERE rule_type = 'recurring';
CREATE INDEX role_reward_guild_idx ON role_reward (guild_id, level);
CREATE INDEX role_reward_broken_idx ON role_reward (guild_id) WHERE broken_reason IS NOT NULL;

-- ---------------------------------------------------------------------------
-- member_xp — THE CENTRAL TABLE
-- ---------------------------------------------------------------------------
CREATE TABLE member_xp (
  guild_id      BIGINT      NOT NULL REFERENCES guild(guild_id) ON DELETE CASCADE,
  user_id       BIGINT      NOT NULL,

  -- CANONICAL (ADR-001). Level, within-level progress and rank are all derived
  -- from this one number, which is why changing the curve is free and why level
  -- can never disagree with XP.
  total_xp      BIGINT      NOT NULL DEFAULT 0 CHECK (total_xp >= 0),

  -- A DENORMALISED CACHE, written in the same statement as total_xp and never
  -- independently mutable. It exists so SQL can sort and filter by level; it is
  -- not a second source of truth. (It cannot be a generated column: the curve
  -- lives in guild configuration, not in SQL.)
  level         INT         NOT NULL DEFAULT 0,

  -- Snapshots, so a member who has LEFT still renders on the leaderboard as a
  -- name rather than a raw snowflake.
  display_name  TEXT,
  avatar_hash   TEXT,
  is_departed   BOOLEAN     NOT NULL DEFAULT false,

  last_xp_at    TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (guild_id, user_id)
);

-- Rank counting and lifetime-leaderboard keyset pagination. The tie-break
-- (user_id ASC) is PART OF THE INDEX because it is part of the ordering: it is
-- what makes a member's rank stable between calls instead of flickering when
-- two people share a total.
CREATE INDEX member_xp_leaderboard_idx ON member_xp (guild_id, total_xp DESC, user_id ASC);
CREATE INDEX member_xp_level_idx       ON member_xp (guild_id, level DESC, total_xp DESC);

-- ---------------------------------------------------------------------------
-- member_stats — activity counters, deliberately separate from XP
-- ---------------------------------------------------------------------------
-- Separate because `/xp reset` clears XP but PRESERVES statistics by default
-- (ADR-014): XP is a score, statistics are a record of what happened. Also
-- keeps three leaderboard sort columns off member_xp's indexes.
CREATE TABLE member_stats (
  guild_id           BIGINT      NOT NULL REFERENCES guild(guild_id) ON DELETE CASCADE,
  user_id            BIGINT      NOT NULL,
  messages_counted   BIGINT      NOT NULL DEFAULT 0,  -- XP-earning messages, not all messages
  voice_seconds      BIGINT      NOT NULL DEFAULT 0,
  reactions_given    BIGINT      NOT NULL DEFAULT 0,
  reactions_received BIGINT      NOT NULL DEFAULT 0,
  levelups_count     BIGINT      NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX member_stats_voice_idx     ON member_stats (guild_id, voice_seconds DESC, user_id ASC);
CREATE INDEX member_stats_reactions_idx ON member_stats (guild_id, reactions_received DESC, user_id ASC);
CREATE INDEX member_stats_messages_idx  ON member_stats (guild_id, messages_counted DESC, user_id ASC);

-- ---------------------------------------------------------------------------
-- member_period_xp — weekly/monthly buckets (ADR-006)
-- ---------------------------------------------------------------------------
-- THE CENTRAL IDEA: a "reset" is not an operation. XP is written into a bucket
-- keyed by the period it falls in, so when the clock crosses local midnight the
-- key changes and writes land in a new row. No reset job exists, nothing is
-- ever deleted, downtime at the boundary has zero consequence, and last week's
-- board is still queryable.
CREATE TABLE member_period_xp (
  guild_id     BIGINT      NOT NULL REFERENCES guild(guild_id) ON DELETE CASCADE,
  user_id      BIGINT      NOT NULL,
  period_type  TEXT        NOT NULL CHECK (period_type IN ('week', 'month')),
  -- The UTC instant at which this period began, computed in the GUILD's zone.
  period_start TIMESTAMPTZ NOT NULL,
  xp           BIGINT      NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id, period_type, period_start)
);

-- Note the column order differs from the primary key: the PK serves the upsert
-- (which knows the user), this serves the leaderboard (which does not).
CREATE INDEX member_period_xp_board_idx
  ON member_period_xp (guild_id, period_type, period_start, xp DESC, user_id ASC);

-- ---------------------------------------------------------------------------
-- audit_log — who did what
-- ---------------------------------------------------------------------------
-- Manual XP is the main admin-abuse vector, and an admin with Manage Server can
-- already do far worse than inflate a friend's level. The answer is
-- transparency rather than prevention.
CREATE TABLE audit_log (
  id             BIGSERIAL PRIMARY KEY,
  guild_id       BIGINT      NOT NULL REFERENCES guild(guild_id) ON DELETE CASCADE,
  actor_id       BIGINT,                     -- NULL for system actions
  action         TEXT        NOT NULL,
  target_user_id BIGINT,
  before         JSONB,                      -- small values only; NEVER message content
  after          JSONB,
  reason         TEXT        CHECK (reason IS NULL OR length(reason) <= 200),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_guild_idx  ON audit_log (guild_id, created_at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (guild_id, target_user_id, created_at DESC);
