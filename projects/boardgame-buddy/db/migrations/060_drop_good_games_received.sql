-- ─────────────────────────────────────────────────────────────────────────────
-- 060_drop_good_games_received.sql — remove bgb_good_games_received
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Nothing calls bgb_good_games_received (059): the Profile hub has no Good
-- games counter, and a player's good games are read off their own sessions on
-- the feed, from the counts bgb_feed_plays already carries.
--
-- IF EXISTS, so this is safe whether or not 059 was run.
--
-- Deploy order: after the API. The API that shipped with 059 reads the function
-- through a soft call, so running this first only hides that counter early.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.bgb_good_games_received(uuid);
