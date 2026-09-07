-- Durable reaction dedup (spec `04` §7.2; roadmap M11).
--
-- THIS TABLE IS THE ANTI-FARMING PRIMITIVE, and it is the reason reaction
-- idempotency is persisted while message and voice idempotency are not
-- (ADR-010). Removing a reaction and adding it back is a two-click loop anyone
-- can run forever; an in-memory dedup window would simply set the price of
-- farming at "wait ten minutes". So the record survives restarts, and the
-- primary key IS the rule: one award per (message, reactor, emoji), ever.
--
-- The emoji is part of the key on purpose. Reacting with a second, different
-- emoji is a genuinely distinct act, and treating it as a duplicate would make
-- the first reaction on a message the only one that ever counted.

CREATE TABLE reaction_award (
  guild_id          BIGINT      NOT NULL REFERENCES guild(guild_id) ON DELETE CASCADE,
  message_id        BIGINT      NOT NULL,
  reactor_id        BIGINT      NOT NULL,
  -- Unicode codepoints, or `name:id` for a custom emoji. TEXT because a custom
  -- emoji id and a unicode sequence are not the same shape.
  emoji             TEXT        NOT NULL,
  -- Who received it. Nullable: an uncached message whose author could not be
  -- fetched still records the dedup, so the farm loop stays closed even when
  -- the receive side could not be credited.
  message_author_id BIGINT,
  awarded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (guild_id, message_id, reactor_id, emoji)
);

-- The per-message distinct-reactor cap counts against this.
CREATE INDEX reaction_award_message_idx ON reaction_award (guild_id, message_id);
-- Retention.
CREATE INDEX reaction_award_age_idx ON reaction_award (awarded_at);
