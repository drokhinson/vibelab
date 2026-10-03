-- ─────────────────────────────────────────────────────────────────────────────
-- accepted_seat_saved_read.sql — a seat you accepted keeps a clear tray clear
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Dana saves a live game in which Sam and Priya accepted their seats. Sam had
-- read everything; Priya had an unread play from earlier. Checks:
--
--   1. Sam's watermark moves up, so the new play is read and his bell is 0.
--   2. Priya's watermark does not move: both plays are unread, and her bell
--      counts 2.
--   3. Dana, the logger, is left alone.
--
-- SAFE TO RUN ANYWHERE: one transaction ending in ROLLBACK, touching only rows
-- it inserted under uuids it invented.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/accepted_seat_saved_read.sql
--
-- Silence plus "ALL ACCEPTED-SEAT CHECKS PASSED" is a pass.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $test$
DECLARE
  dana   CONSTANT uuid := gen_random_uuid();
  sam    CONSTANT uuid := gen_random_uuid();
  priya  CONSTANT uuid := gen_random_uuid();
  game   CONSTANT uuid := gen_random_uuid();
  play1  uuid;
  play2  uuid;
  res    jsonb;
  n      int;
  ok     boolean;
BEGIN
  INSERT INTO boardgamebuddy_profiles (id, display_name, username) VALUES
    (dana,  'Dana',  'dana_'  || left(dana::text, 8)),
    (sam,   'Sam',   'sam_'   || left(sam::text, 8)),
    (priya, 'Priya', 'priya_' || left(priya::text, 8));
  INSERT INTO boardgamebuddy_games (id, name) VALUES (game, 'Test Catan');

  -- An earlier play seating Priya, accepted from the bell and never read.
  res := bgb_log_play(dana, jsonb_build_object(
    'game_id', game, 'played_at', '2026-09-27',
    'players', jsonb_build_array(
      jsonb_build_object('user_id', dana,  'name', 'Dana',  'score', 10, 'is_winner', true),
      jsonb_build_object('user_id', priya, 'name', 'Priya', 'score', 8))));
  play1 := (res->>'id')::uuid;
  PERFORM bgb_accept_play_invites(priya, ARRAY[play1]);
  -- One transaction has one now(), and the feed groups a logger's seats by
  -- linked_at, so the earlier play is moved a day back to stay its own entry.
  UPDATE boardgamebuddy_play_players SET linked_at = linked_at - interval '1 day'
   WHERE play_id = play1;
  ASSERT bgb_notifications_unread(priya) = 1, 'setup: Priya should have one unread';
  ASSERT bgb_notifications_unread(sam) = 0, 'setup: Sam should have none';

  res := bgb_log_play(dana, jsonb_build_object(
    'game_id', game, 'played_at', '2026-09-28',
    'accepted_user_ids', jsonb_build_array(sam, priya),
    'players', jsonb_build_array(
      jsonb_build_object('user_id', dana,  'name', 'Dana',  'score', 10, 'is_winner', true),
      jsonb_build_object('user_id', sam,   'name', 'Sam',   'score', 8),
      jsonb_build_object('user_id', priya, 'name', 'Priya', 'score', 7))));
  play2 := (res->>'id')::uuid;
  ASSERT play2 IS NOT NULL, 'bgb_log_play failed: ' || res::text;

  -- ── 1. a clear tray stays clear ───────────────────────────────────────────
  SELECT is_unread INTO ok FROM bgb_notifications(sam) WHERE play_id = play2;
  ASSERT ok IS FALSE, 'Sam''s new play should arrive read';
  n := bgb_notifications_unread(sam);
  ASSERT n = 0, 'Sam''s bell should stay at 0, got ' || n;

  -- ── 2. a tray with unread items is left as it was ─────────────────────────
  ASSERT (SELECT link_notifications_seen_at IS NULL FROM boardgamebuddy_profiles WHERE id = priya),
    'Priya''s watermark should not move';
  SELECT is_unread INTO ok FROM bgb_notifications(priya) WHERE play_id = play2;
  ASSERT ok IS TRUE, 'Priya''s new play should be unread';
  n := bgb_notifications_unread(priya);
  ASSERT n = 2, 'Priya''s bell should count 2, got ' || n;

  -- ── 3. the logger ─────────────────────────────────────────────────────────
  ASSERT (SELECT link_notifications_seen_at IS NULL FROM boardgamebuddy_profiles WHERE id = dana),
    'the logger''s watermark should not move';

  RAISE NOTICE 'ALL ACCEPTED-SEAT CHECKS PASSED';
END;
$test$;

ROLLBACK;
