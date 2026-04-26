-- BoardgameBuddy: first-class expansion linking + per-user toggle.
--
-- Each expansion is its own row in boardgamebuddy_games (with its own bgg_id).
-- The new columns flag the row as an expansion and remember which base game
-- (by base_game_bgg_id) it extends. base_game_bgg_id is intentionally NOT a
-- foreign key: an expansion may be imported before its base game, and the
-- integer-bgg-id link still works once both rows exist.

ALTER TABLE public.boardgamebuddy_games
  ADD COLUMN IF NOT EXISTS is_expansion BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS base_game_bgg_id INTEGER,
  ADD COLUMN IF NOT EXISTS expansion_color TEXT;

CREATE INDEX IF NOT EXISTS idx_bgb_games_base_bgg
  ON public.boardgamebuddy_games(base_game_bgg_id)
  WHERE is_expansion = true;

-- Per-user toggle. Row presence = enabled; absence = disabled (default).
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_user_expansions (
  user_id            UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  expansion_game_id  UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  enabled_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, expansion_game_id)
);
ALTER TABLE public.boardgamebuddy_user_expansions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_bgb_user_expansions_user
  ON public.boardgamebuddy_user_expansions(user_id);
