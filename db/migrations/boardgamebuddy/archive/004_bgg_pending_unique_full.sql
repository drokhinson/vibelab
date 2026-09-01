-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy 004 — make the pending-imports unique constraint usable for upsert
--
-- Background: bgg_link_routes._queue_pending() does
--   sb.table("boardgamebuddy_bgg_pending_imports")
--     .upsert({...}, on_conflict="user_id,bgg_id,kind")
-- which translates to `INSERT ... ON CONFLICT (user_id, bgg_id, kind) DO UPDATE`.
-- Postgres' ON CONFLICT inference does not match *partial* unique indexes when
-- the statement omits a WHERE clause, and PostgREST's upsert never adds one.
-- The original `idx_bgb_bgg_pending_unique` was partial (`WHERE status='pending'`),
-- so the upsert blew up with 42P10 the first time a sync hit a not-yet-cataloged
-- game.
--
-- Fix: replace the partial unique with a full one on (user_id, bgg_id, kind).
-- Semantically, a re-sync now flips a row's status back to 'pending' instead of
-- inserting a sibling alongside the previous 'done'/'error' row. That's fine —
-- materialization is already idempotent (collections upsert on (user, game),
-- plays dedup on (user, bgg_play_id)).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Drop the partial unique. The non-unique helper index `idx_bgb_bgg_pending_user_status`
--    stays — workers still want a fast filtered lookup of pending rows.
DROP INDEX IF EXISTS public.idx_bgb_bgg_pending_unique;

-- 2. Dedup any rows that the partial constraint allowed but a full one wouldn't:
--    keep the most-recently-created row per (user_id, bgg_id, kind), drop the rest.
DELETE FROM public.boardgamebuddy_bgg_pending_imports
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY user_id, bgg_id, kind
        ORDER BY created_at DESC, id DESC
      ) AS rn
    FROM public.boardgamebuddy_bgg_pending_imports
  ) t
  WHERE rn > 1
);

-- 3. Re-create the unique on the same columns, now without the predicate so
--    PostgREST's upsert (`ON CONFLICT (user_id, bgg_id, kind)`) can match it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_bgg_pending_unique
  ON public.boardgamebuddy_bgg_pending_imports (user_id, bgg_id, kind);
