-- ─────────────────────────────────────────────────────────────────────────────
-- 059_good_games_received.sql — how many "Good game"s a player has been given
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The Profile hub prints a "Good games" counter above the Recent plays card.
-- This is the number behind it.
--
-- bgb_good_games_received counts TAPS, not rows. One tap on a feed session
-- footer writes a row per play in that night, all sharing a reaction_group_id
-- (boardgamebuddy_play_reactions), so counting rows would turn one "good game" on a three-game night into
-- three. Counting distinct reaction_group_id gives one per tap.
--
-- A play counts as the player's when they logged it or sit in its roster — the
-- bgb_play_stats rule. Their own reactions are left out: the write path already
-- refuses a reaction on a play the caller logged, but a player seated in
-- someone else's play can react to it, and that is not a good game they got.
--
-- Deploy order: none. The API reads this through a soft call and the counter
-- stays hidden until the function exists.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION public.bgb_good_games_received(p_user uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH mine AS (
    SELECT p.id FROM boardgamebuddy_plays p WHERE p.user_id = p_user
    UNION
    SELECT pp.play_id FROM boardgamebuddy_play_players pp
     WHERE pp.player_user_id = p_user
  )
  SELECT COUNT(DISTINCT r.reaction_group_id)::int
  FROM mine m
  JOIN boardgamebuddy_play_reactions r ON r.play_id = m.id
  WHERE r.user_id <> p_user;
$function$;

-- Naming PUBLIC alone does not close this: Supabase grants anon and
-- authenticated their own EXECUTE.
REVOKE EXECUTE ON FUNCTION public.bgb_good_games_received(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.bgb_good_games_received(uuid) TO service_role;
GRANT  EXECUTE ON FUNCTION public.bgb_good_games_received(uuid) TO boardgamebuddy_role;

COMMENT ON FUNCTION public.bgb_good_games_received(uuid) IS
  'How many "Good game" taps other people have given plays p_user logged or sat in. Distinct reaction_group_id, so a tap covering a whole night counts once. Called by GET /profile/bundle and GET /bootstrap.';

COMMIT;
