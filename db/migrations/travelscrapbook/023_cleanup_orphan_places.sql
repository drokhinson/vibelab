-- 023_cleanup_orphan_places.sql
--
-- One-time cleanup of orphaned place rows — places that no scrap references.
--
-- Why they exist: until the "delete a place completely" fix, DELETE /scraps/:id
-- removed only the scrap and left the canonical travelscrapbook_places row
-- behind. Because travelscrapbook_community_places reads the places table
-- DIRECTLY (no join to scraps), those ghost rows kept surfacing in the
-- Community "master list" and inflating saved_by_count, even though nobody had
-- them saved anymore. A place can also be orphaned if enrichment crashed after
-- creating the place row but before inserting its scrap.
--
-- Every live place carries exactly one scrap per user (creation always makes the
-- pair; community-save reuses the existing scrap), so "no scrap references this
-- place" == dead data. travelscrapbook_place_sources rows cascade away with the
-- place (ON DELETE CASCADE); the underlying sources (capture history) are left
-- intact. This is data-only — no schema change.
--
-- Preview first (optional): how many rows will go, and where they'd have shown.
--   SELECT count(*) AS orphan_places,
--          count(*) FILTER (WHERE lat IS NOT NULL) AS visible_in_community,
--          count(*) FILTER (WHERE lat IS NULL)     AS invisible_everywhere
--   FROM public.travelscrapbook_places p
--   WHERE NOT EXISTS (
--     SELECT 1 FROM public.travelscrapbook_scraps s WHERE s.place_id = p.id
--   );

DELETE FROM public.travelscrapbook_places p
WHERE NOT EXISTS (
  SELECT 1 FROM public.travelscrapbook_scraps s WHERE s.place_id = p.id
);
