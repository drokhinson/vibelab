-- 008_scrap_rating.sql — one global priority rating per scrap.
--
-- Replaces the binary is_favorite heart with a 4-level rating on the scrap
-- itself (same value set as trip vibes). The per-member vibe rows in
-- travelscrapbook_scrap_vibes are KEPT — they remain the group-consensus
-- store on shared trips; a scrap's rating is its owner's own take, visible
-- from the Wander List and every trip surface.
--
-- Depends on: 004 (places/scraps restructure), 007 (scrap_vibes).
-- Run those first if they haven't been applied yet.

ALTER TABLE public.travelscrapbook_scraps
  ADD COLUMN rating TEXT
    CHECK (rating IS NULL OR rating IN ('booked', 'must_do', 'interested', 'could_skip'));

-- Backfill 1: the owner's existing vibe on their own scrap becomes the
-- scrap's global rating.
UPDATE public.travelscrapbook_scraps s
SET rating = v.level
FROM public.travelscrapbook_scrap_vibes v
WHERE v.scrap_id = s.id
  AND v.user_id = s.user_id;

-- Backfill 2: favorited scraps with no vibe become must-dos (the heart is a
-- strict subset of the rating).
UPDATE public.travelscrapbook_scraps
SET rating = 'must_do'
WHERE rating IS NULL
  AND is_favorite;

ALTER TABLE public.travelscrapbook_scraps
  DROP COLUMN is_favorite;
