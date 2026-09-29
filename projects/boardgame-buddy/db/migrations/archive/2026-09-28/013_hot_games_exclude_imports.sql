-- 013_hot_games_exclude_imports.sql — "Hot this week" counts plays, not paperwork.
--
-- The Feed's Hot this week rail ranks games by how many plays they got in the
-- last seven days. Migrations 005 and 007 added the Settings play importer,
-- which writes one row per play in a pasted note — deliberately, because that
-- is what keeps every counter honest. But the counter this rail wants is not
-- "how much history got typed in", it is "what is everybody playing right
-- now", and one person emptying a notebook of 106 games of Carcassonne into
-- the app on a Tuesday takes the top slot away from every game that was
-- actually on a table this week.
--
-- 005 and 007 both note that a nullable column cannot change an existing
-- COUNT, and left the 20 read functions alone on that basis. This is the one
-- place where that is the wrong answer: the rail is a popularity signal, and a
-- backfill is not popularity.
--
-- WHAT COUNTS AS AN IMPORT: both import columns, not just one.
--   * import_batch_id — one per paste (007). Every row the importer writes
--     carries it, including the one-offs in the paste that never got grouped.
--   * import_group_id — a run of identical plays inside an import (005).
--     Redundant for anything imported after 007 shipped, and NOT redundant for
--     rows written in between: those carry a group id and no batch id, and
--     dropping this half of the predicate would leave exactly the 106-play
--     runs that motivated 005 still counted here.
--
-- WHAT IS NOT EXCLUDED: BGG sync (bgg_play_id). A synced play is a play the
-- user really logged, on BGG instead of here, and the sync is how those users'
-- normal week reaches this app at all — excluding it would blank the rail for
-- them rather than de-noise it. Revisit only if a first sync of a long history
-- turns out to distort the window in practice; a backfill mostly lands outside
-- the seven days by construction.
--
-- No index change. The predicate is a filter on rows already fetched by
-- idx_bgb_plays_played_at (see archive/043), and both columns are NULL on
-- essentially every row, so it removes work rather than adding any.

-- ── bgb_hot_games ─────────────────────────────────────────────────────────────
-- Re-emitted from 003_rpcs.sql:515 with the two IS NULL predicates added;
-- signature, return type and ordering are unchanged, so CREATE OR REPLACE
-- keeps the existing grant. It is restated below anyway, since a future
-- DROP-and-recreate of this function would otherwise silently lose it.
--
-- Games whose only plays in the window were imported disappear from the rail
-- entirely rather than showing a zero: the rows are gone before the GROUP BY,
-- so the group never forms. That is the intent — a game nobody played this
-- week does not belong on a list of what is hot this week.
CREATE OR REPLACE FUNCTION public.bgb_hot_games(window_days integer DEFAULT 7, lim integer DEFAULT 10)
 RETURNS TABLE(game_id uuid, play_count bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.game_id, COUNT(*)::BIGINT AS play_count
  FROM public.boardgamebuddy_plays p
  WHERE p.played_at >= (CURRENT_DATE - (window_days || ' days')::INTERVAL)
    AND p.import_batch_id IS NULL
    AND p.import_group_id IS NULL
  GROUP BY p.game_id
  ORDER BY play_count DESC, p.game_id
  LIMIT lim;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_hot_games(window_days integer, lim integer) TO boardgamebuddy_role;
