-- 051_games_browse_index.sql — an ordered index for the Game Explorer's
-- "All BgB Games" browse.
--
-- GET /games pages the catalog with `is_expansion = false` (the explorer sends
-- it on every request), ORDER BY created_at DESC, LIMIT 9. Nothing served that:
-- the live index set on boardgamebuddy_games is the PK, the implicit unique on
-- bgg_id, idx_bgb_games_base_bgg (partial on is_expansion = TRUE — i.e. exactly
-- the rows this browse excludes) and idx_bgb_games_name_trgm (only useful for
-- the name search the explorer never sends). So every page was a sequential
-- scan plus a sort, and PostgREST's count="exact" meant the scan could not
-- stop early.
--
-- The partial predicate absorbs the explorer's constant, and the ordered
-- columns let LIMIT 9 walk the index and stop.
--
-- Honest scope: the catalog is small today — 002_seed.sql inserts 23 rows and
-- everything else arrives one game at a time via import/BGG sync — so at a few
-- thousand rows a seq scan is already sub-millisecond and this index is not
-- what makes the explorer feel faster. Removing the second round trip per page
-- (include_expansion_counts=false) and unblocking the event loop are. This is
-- cheap insurance for when the catalog reaches the "top 1000 + expansions"
-- scale the docs describe.
--
-- `id` mirrors the tiebreaker added to the query in the same change: created_at
-- is nullable and bulk imports share a transaction timestamp, so ties are
-- normal and the sort needs a deterministic second key or pages can repeat and
-- skip rows.
--
-- No schema change; index only. CONCURRENTLY is deliberately NOT used — it
-- cannot run inside a transaction block, and this table is small enough that a
-- brief lock is a non-event.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_bgb_games_browse
  ON public.boardgamebuddy_games (created_at DESC, id DESC)
  WHERE is_expansion = false;

COMMIT;
