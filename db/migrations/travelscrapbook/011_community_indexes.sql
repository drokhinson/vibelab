-- 011_community_indexes.sql — cross-user aggregation keys for the community
-- place pool. Places stay per-user rows; the pool is a read-time aggregation
-- grouped by OSM identity (or normalized name + country as the fallback), so
-- both grouping keys get indexes. No new tables → no RLS/grant changes.
--
-- Depends on: 004 (places table). Run 004 first if it hasn't been applied.

CREATE INDEX IF NOT EXISTS idx_travelscrapbook_places_osm
  ON public.travelscrapbook_places (osm_type, osm_id)
  WHERE osm_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_travelscrapbook_places_name_norm
  ON public.travelscrapbook_places (name_normalized);
