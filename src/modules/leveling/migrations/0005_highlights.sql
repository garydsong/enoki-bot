-- Periodic Highlights and the first-place role (spec `05`; roadmap M13).
--
-- The weekly and monthly XP buckets have been written since M3 and the boards
-- have read them since M6. All that is added here is the configuration for
-- POSTING a summary when a period ends, plus a role for the current leader.

ALTER TABLE leveling_config
  ADD COLUMN highlights_enabled  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN highlights_channel_id BIGINT,
  ADD COLUMN highlights_weekly   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN highlights_monthly  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN highlights_size     INT     NOT NULL DEFAULT 5
    CHECK (highlights_size BETWEEN 1 AND 25),
  -- Granted to whoever tops the WEEKLY board, and taken back when they lose it.
  -- Reconciled like any other reward: a desired set of exactly one member.
  ADD COLUMN first_place_role_id BIGINT,
  -- How long after a period ends a Highlights post is still worth making.
  -- Beyond this the period is marked done WITHOUT posting: returning from two
  -- weeks of downtime and announcing a fortnight-old board is noise, and
  -- announcing all of them at once is worse.
  ADD COLUMN highlights_grace_hours INT NOT NULL DEFAULT 48
    CHECK (highlights_grace_hours BETWEEN 1 AND 720);
