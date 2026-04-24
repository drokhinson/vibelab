-- Migration 040 — BoardgameBuddy: per-user chunk hiding + default type order fix
--
-- 1. Swap default display_order so the guide renders in the user-requested sequence:
--    setup → player_turn → scoring → card_reference → tips.
-- 2. Add is_hidden flag to per-user selections so swipe-left can hide a chunk
--    without deleting it from the library. Chunks without a selection row
--    render at the default type order; rows with is_hidden=true are filtered
--    out of the guide and listed in the "Hidden chunks" panel.

UPDATE public.boardgamebuddy_chunk_types SET display_order = 30 WHERE id = 'scoring';
UPDATE public.boardgamebuddy_chunk_types SET display_order = 40 WHERE id = 'card_reference';

ALTER TABLE public.boardgamebuddy_guide_selections
  ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_bgb_selections_user_game_hidden
  ON public.boardgamebuddy_guide_selections(user_id, game_id, is_hidden);
