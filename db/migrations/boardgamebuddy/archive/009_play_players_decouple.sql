-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Decouple play_players from boardgamebuddy_buddies
-- Adds direct player_user_id + player_display_name columns so plays can
-- reference a real profile OR record a free-text ghost player without going
-- through the legacy per-owner buddy table.
--
-- buddy_id stays nullable during the transition; it gets dropped in 013 once
-- the FE has cut over.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_play_players
  ADD COLUMN IF NOT EXISTS player_user_id UUID REFERENCES public.boardgamebuddy_profiles(id) ON DELETE SET NULL;

ALTER TABLE public.boardgamebuddy_play_players
  ADD COLUMN IF NOT EXISTS player_display_name TEXT;

ALTER TABLE public.boardgamebuddy_play_players
  ALTER COLUMN buddy_id DROP NOT NULL;

-- Backfill: for each existing play_players row, copy the linked user (if any)
-- and the buddy name into the new columns.
UPDATE public.boardgamebuddy_play_players pp
SET
  player_user_id      = b.linked_user_id,
  player_display_name = b.name
FROM public.boardgamebuddy_buddies b
WHERE pp.buddy_id = b.id
  AND (pp.player_user_id IS NULL AND pp.player_display_name IS NULL);

-- Every row must identify the player somehow (real account or free-text name).
ALTER TABLE public.boardgamebuddy_play_players
  DROP CONSTRAINT IF EXISTS bgb_play_players_identity_chk;
ALTER TABLE public.boardgamebuddy_play_players
  ADD CONSTRAINT bgb_play_players_identity_chk
  CHECK (player_user_id IS NOT NULL OR player_display_name IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_bgb_play_players_user
  ON public.boardgamebuddy_play_players (player_user_id)
  WHERE player_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bgb_play_players_play
  ON public.boardgamebuddy_play_players (play_id);
