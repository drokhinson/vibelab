-- BoardgameBuddy — explicit `is_default` flag on guide chunks.
--
-- Until now, the implicit signal for "default/curated" chunks was
-- `created_by IS NULL` (set on seed/admin imports). That broke down once
-- community chunks could be promoted to defaults. This migration adds an
-- explicit boolean and backfills it from the existing seed signal.
--
-- The frontend now shows ONLY is_default=true chunks when a user has no
-- selection rows; once they hide/reorder/unhide anything the full library
-- becomes available via the Hidden / available chunks panel.

ALTER TABLE public.boardgamebuddy_guide_chunks
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

UPDATE public.boardgamebuddy_guide_chunks
  SET is_default = true
  WHERE created_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_bgb_chunks_game_default
  ON public.boardgamebuddy_guide_chunks (game_id, is_default);
