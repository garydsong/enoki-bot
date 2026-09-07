-- Render `/leaderboard` as an image too (spec `05` §3).
--
-- A separate switch from `cards_enabled`, because the two have genuinely
-- different costs: a rank card fetches one avatar, a board page fetches up to
-- twenty-five. A server on a slow link may want the rank card and not the
-- board.
--
-- It defaults to TRUE and is gated behind `cards_enabled`, so the effect of
-- turning cards on is that everything looks the same — which is the point of
-- having asked for it. Turning it off leaves the embed board with image rank
-- cards, which is a deliberate choice rather than an accident.

ALTER TABLE leveling_config
  ADD COLUMN card_leaderboard_enabled BOOLEAN NOT NULL DEFAULT true;
