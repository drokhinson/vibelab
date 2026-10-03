-- ─────────────────────────────────────────────────────────────────────────────
-- 066_revisit_daily_shuffle.sql — the dormant shelf is a daily random draw
-- ─────────────────────────────────────────────────────────────────────────────
--
-- bgb_dormant_collection picks from every owned game the user has not logged
-- in BoardgameBuddy within `days_since` days: never logged, or last logged
-- before the cutoff. Only plays logged in the app count; an imported play
-- (import_batch_id or import_group_id set) neither keeps a game off the list
-- nor sets its last_played_at. Every candidate is equally likely: the order
-- is md5(game_id || CURRENT_DATE), so the draw is stable for a day and
-- reshuffles at the next UTC midnight.
--
-- Deploy order: either. The signature is unchanged; the API only changes the
-- window it asks for.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION public.bgb_dormant_collection(uid uuid, days_since integer DEFAULT 60, lim integer DEFAULT 5)
 RETURNS TABLE(game_id uuid, last_played_at date)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH owned AS (
    SELECT
      c.game_id,
      (
        SELECT MAX(p.played_at)
        FROM public.boardgamebuddy_plays p
        WHERE p.game_id = c.game_id
          AND p.import_batch_id IS NULL
          AND p.import_group_id IS NULL
          AND (
            p.user_id = uid
            OR EXISTS (
                 SELECT 1 FROM public.boardgamebuddy_play_players pp
                 WHERE pp.play_id = p.id AND pp.player_user_id = uid
               )
          )
      ) AS last_played_at
    FROM public.boardgamebuddy_collections c
    WHERE c.user_id = uid
      AND c.status = 'owned'
  )
  SELECT o.game_id, o.last_played_at
  FROM owned o
  WHERE o.last_played_at IS NULL
     OR o.last_played_at < CURRENT_DATE - days_since
  ORDER BY md5(o.game_id::text || CURRENT_DATE::text), o.game_id
  LIMIT lim;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_dormant_collection(uid uuid, days_since integer, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_dormant_collection(uid uuid, days_since integer, lim integer) TO boardgamebuddy_role;

COMMIT;
