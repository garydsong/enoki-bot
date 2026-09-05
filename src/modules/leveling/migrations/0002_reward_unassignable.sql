-- Add 'unassignable' to the reward-breakage reasons.
--
-- @everyone is a role Discord will never grant or remove — every member already
-- has it — but it is neither deleted, nor managed by an integration, nor above
-- the bot in the hierarchy (it sits at position 0). It needs a reason of its own
-- so `/level reward list` can explain it accurately.
--
-- This is a NEW migration rather than an edit to 0001 on purpose: 0001 has been
-- applied, its checksum is recorded, and editing it would abort boot with
-- "migration has changed since it was applied" — which is the guard working.

ALTER TABLE role_reward DROP CONSTRAINT IF EXISTS role_reward_broken_reason_check;

ALTER TABLE role_reward ADD CONSTRAINT role_reward_broken_reason_check
  CHECK (broken_reason IS NULL OR broken_reason IN (
    'role_deleted', 'hierarchy', 'missing_permission', 'managed', 'unassignable'
  ));

-- @everyone could have been stored as a reward before this was rejected at the
-- command. Its role id is always the guild id, so these are identifiable and
-- are marked broken rather than deleted — the admin chose to configure
-- something, and silently discarding it is hostile.
UPDATE role_reward
   SET broken_reason = 'unassignable'
 WHERE role_id = guild_id AND broken_reason IS NULL;
