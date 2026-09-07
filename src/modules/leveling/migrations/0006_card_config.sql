-- Rank card personalisation (spec `05` §3; roadmap M14).
--
-- Two levels, member over guild: a server sets a house style, a member may
-- override parts of it. Both are OPTIONAL — a null means "inherit", which is
-- what makes "reset to the server default" a DELETE rather than a special value.

ALTER TABLE leveling_config
  ADD COLUMN cards_enabled       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN card_accent_color   INT,
  -- Background images are fetched at render time, so the URL is a REMOTE FETCH
  -- TARGET chosen by a user. Only Discord's own CDN is accepted (validated in
  -- code, not here) — see `cardRenderer.ts` for why that is the whole SSRF
  -- defence rather than one layer of it.
  ADD COLUMN card_background_url TEXT,
  ADD COLUMN card_allow_member_customisation BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE member_card_config (
  guild_id       BIGINT      NOT NULL REFERENCES guild(guild_id) ON DELETE CASCADE,
  user_id        BIGINT      NOT NULL,
  -- NULL means inherit from the guild. That is why this is a nullable column
  -- rather than a sentinel: "reset" is simply setting it back to NULL.
  accent_color   INT,
  background_url TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
