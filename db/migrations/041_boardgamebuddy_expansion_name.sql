-- Add expansion_name to guide chunks so chunks from expansions can be tagged.
-- A NULL value means the chunk belongs to the base game.
ALTER TABLE public.boardgamebuddy_guide_chunks
  ADD COLUMN IF NOT EXISTS expansion_name TEXT;
