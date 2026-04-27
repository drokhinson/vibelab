-- BoardgameBuddy: promote the rulebook URL from a chunk to a column on the
-- games table. Previously stored as `chunk_type='rulebook'` rows in
-- boardgamebuddy_guide_chunks; the URL is per-game metadata, not customizable
-- reference content, so it belongs on the game row.

-- 1. Add column.
ALTER TABLE public.boardgamebuddy_games
  ADD COLUMN IF NOT EXISTS rulebook_url TEXT;

-- 2. Backfill from existing rulebook chunks. DISTINCT ON keeps the earliest
--    chunk per game when multiple exist.
UPDATE public.boardgamebuddy_games g
SET rulebook_url = sub.content
FROM (
  SELECT DISTINCT ON (game_id) game_id, content
  FROM public.boardgamebuddy_guide_chunks
  WHERE chunk_type = 'rulebook'
    AND content IS NOT NULL
    AND length(trim(content)) > 0
  ORDER BY game_id, created_at ASC
) sub
WHERE g.id = sub.game_id
  AND g.rulebook_url IS NULL;

-- 3. Delete legacy rulebook chunks. Cascades to boardgamebuddy_guide_selections.
DELETE FROM public.boardgamebuddy_guide_chunks WHERE chunk_type = 'rulebook';

-- 4. Drop the lookup row so future imports can't reintroduce the type.
DELETE FROM public.boardgamebuddy_chunk_types WHERE id = 'rulebook';
