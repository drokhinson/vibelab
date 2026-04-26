-- Drop bgg_rank and bgg_rating from boardgamebuddy_games. The data was stale
-- (rank was never populated by import_bgg_game()) and is no longer surfaced
-- in the UI.
DROP INDEX IF EXISTS public.idx_bgb_games_rank;
ALTER TABLE public.boardgamebuddy_games
  DROP COLUMN IF EXISTS bgg_rank,
  DROP COLUMN IF EXISTS bgg_rating;
