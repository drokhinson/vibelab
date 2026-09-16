-- 060_games_alphabetical_index.sql — the alphabetical twin of 051's browse
-- index, for the Add Games catalog scroll.
--
-- GET /games grew a `sort` param in the same change. `newest` is unchanged and
-- still served by idx_bgb_games_browse (created_at DESC, id DESC); the new
-- `alphabetical` value orders by `name ASC, id DESC` under the same
-- `is_expansion = false` predicate the caller always sends, and nothing served
-- that: idx_bgb_games_name_trgm is a GIN trigram index, which answers
-- `name ILIKE '%q%'` and cannot produce a sorted walk.
--
-- Add Games pages the whole catalog 30 rows at a time with count="exact", so
-- without this every batch is a sequential scan plus a full sort of the
-- catalog — and unlike the explorer's single 3×3 page, a user scrolling this
-- screen asks for that repeatedly, once per batch, walking deeper each time.
--
-- Same honest scope as 051: the catalog is small today (002_seed.sql inserts
-- 23 rows, everything since arrives one game at a time via import / BGG sync),
-- so a seq scan is already sub-millisecond and this is cheap insurance for the
-- "top 1000 + expansions" scale the docs describe. It is worth landing with
-- the feature rather than after it, because this is the first endpoint caller
-- that pages the catalog end to end.
--
-- `id DESC` mirrors the query's tiebreaker: two printings of one game share a
-- name, so ties are normal on this axis just as they are on created_at, and
-- without a deterministic second key paginated calls repeat and skip rows.
--
-- No schema change; index only. CONCURRENTLY is deliberately NOT used — it
-- cannot run inside a transaction block, and this table is small enough that a
-- brief lock is a non-event.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_bgb_games_browse_alpha
  ON public.boardgamebuddy_games (name ASC, id DESC)
  WHERE is_expansion = false;

COMMIT;
