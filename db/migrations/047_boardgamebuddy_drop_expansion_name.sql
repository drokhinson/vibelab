-- Drop expansion_name from guide chunks. Expansions are now tracked via a
-- separate game entry (is_expansion = true) rather than chunk metadata.
ALTER TABLE public.boardgamebuddy_guide_chunks
  DROP COLUMN IF EXISTS expansion_name;
