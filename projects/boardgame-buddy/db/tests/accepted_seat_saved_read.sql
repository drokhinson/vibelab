-- ─────────────────────────────────────────────────────────────────────────────
-- accepted_seat_saved_read.sql — a lobby seat you accepted is saved read
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Dana logs two plays seating Sam. The first is an ordinary log, so Sam's seat
-- is an invite; Sam accepts it from the bell. The second comes from a live
-- game where Sam accepted his seat in the lobby. Checks:
--
--   1. The lobby-accepted seat is stamped seen_at; Dana's own seat and the
--      invite Sam accepted later are not.
--   2. In Sam's feed the lobby-accepted play is read and the other is unread,
--      with his read watermark untouched.
--   3. Sam's bell counts one unread entry, not two.
--
-- SAFE TO RUN ANYWHERE: one transaction ending in ROLLBACK, touching only rows
-- it inserted under uuids it invented.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/accepted_seat_saved_read.sql
--
-- Needs boardgamebuddy_play_players.seen_at and the functions that read it.
-- Silence plus "ALL ACCEPTED-SEAT CHECKS PASSED" is a pass.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $test$
DECLARE
  dana   CONSTANT uuid := gen_random_uuid();
  sam    CONSTANT uuid := gen_random_uuid();
  game   CONSTANT uuid := gen_random_uuid();
  play1  uuid;
  play2  uuid;
  res    jsonb;
  n      int;
  ok     boolean;
BEGIN
  INSERT INTO boardgamebuddy_profiles (id, display_name, username) VALUES
    (dana, 'Dana', 'dana_' || left(dana::text, 8)),
    (sam,  'Sam',  'sam_'  || left(sam::text, 8));
  INSERT INTO boardgamebuddy_games (id, name) VALUES (game, 'Test Catan');

  res := bgb_log_play(dana, jsonb_build_object(
    'game_id', game, 'played_at', '2026-09-27',
    'players', jsonb_build_array(
      jsonb_build_object('user_id', dana, 'name', 'Dana', 'score', 10, 'is_winner', true),
      jsonb_build_object('user_id', sam,  'name', 'Sam',  'score', 8))));
  play1 := (res->>'id')::uuid;
  PERFORM bgb_accept_play_invites(sam, ARRAY[play1]);
  -- One transaction has one now(), and the feed groups a logger's seats by
  -- linked_at, so the first play is moved a day back to stay its own entry.
  UPDATE boardgamebuddy_play_players SET linked_at = linked_at - interval '1 day'
   WHERE play_id = play1;

  res := bgb_log_play(dana, jsonb_build_object(
    'game_id', game, 'played_at', '2026-09-28',
    'accepted_user_ids', jsonb_build_array(sam),
    'players', jsonb_build_array(
      jsonb_build_object('user_id', dana, 'name', 'Dana', 'score', 10, 'is_winner', true),
      jsonb_build_object('user_id', sam,  'name', 'Sam',  'score', 8))));
  play2 := (res->>'id')::uuid;
  ASSERT play2 IS NOT NULL, 'bgb_log_play failed: ' || res::text;

  -- ── 1. the stamp ───────────────────────────────────────────────────────────
  SELECT count(*) INTO n FROM boardgamebuddy_play_players
   WHERE play_id = play2 AND player_user_id = sam AND seen_at IS NOT NULL;
  ASSERT n = 1, 'the lobby-accepted seat should be saved read';
  SELECT count(*) INTO n FROM boardgamebuddy_play_players
   WHERE seen_at IS NOT NULL AND play_id IN (play1, play2) AND player_user_id = dana;
  ASSERT n = 0, 'the logger''s own seat should not be stamped';
  SELECT count(*) INTO n FROM boardgamebuddy_play_players
   WHERE play_id = play1 AND player_user_id = sam AND seen_at IS NOT NULL;
  ASSERT n = 0, 'an invite accepted from the bell should not be stamped';

  -- ── 2. the feed ────────────────────────────────────────────────────────────
  SELECT is_unread INTO ok FROM bgb_notifications(sam) WHERE play_id = play2;
  ASSERT ok IS FALSE, 'the lobby-accepted play should be read in the feed';
  SELECT is_unread INTO ok FROM bgb_notifications(sam) WHERE play_id = play1;
  ASSERT ok IS TRUE, 'the other play should still be unread';
  ASSERT (SELECT link_notifications_seen_at IS NULL FROM boardgamebuddy_profiles WHERE id = sam),
    'the read watermark should not move';

  -- ── 3. the bell ────────────────────────────────────────────────────────────
  n := bgb_notifications_unread(sam);
  ASSERT n = 1, 'the bell should count one unread entry, got ' || n;

  RAISE NOTICE 'ALL ACCEPTED-SEAT CHECKS PASSED';
END;
$test$;

ROLLBACK;
