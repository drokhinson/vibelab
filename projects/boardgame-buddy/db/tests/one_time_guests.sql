-- ─────────────────────────────────────────────────────────────────────────────
-- one_time_guests.sql — a one-time guest is one seat on one play
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Dana logs two plays. The first seats one-time guests "Player 1" and
-- "Player 2" and an ordinary guest Jo; the second seats another one-time
-- "Player 1". Checks:
--
--   1. The flag is written for guests only, and only when asked for.
--   2. Dana's ghost list holds Jo and no one-time guest.
--   3. Sam (Dana's buddy) looks up "Player 1" on the first play and gets a key
--      scoped to that play, covering one seat.
--   4. Claiming with that key and Dana accepting moves exactly that seat: the
--      second night's "Player 1" and the first night's "Player 2" stay guests.
--   5. Merge / rename by name never touches a one-time guest.
--
-- SAFE TO RUN ANYWHERE: one transaction ending in ROLLBACK, touching only rows
-- it inserted under uuids it invented.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/one_time_guests.sql
--
-- Needs migration 065. Silence plus "ALL ONE-TIME-GUEST CHECKS PASSED" is a
-- pass.
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
  key1   text;
  n      int;
BEGIN
  INSERT INTO boardgamebuddy_profiles (id, display_name, username) VALUES
    (dana, 'Dana', 'dana_' || left(dana::text, 8)),
    (sam,  'Sam',  'sam_'  || left(sam::text, 8));
  INSERT INTO boardgamebuddy_games (id, name) VALUES (game, 'Test Catan');
  INSERT INTO boardgamebuddy_buddy_edges (user_a, user_b, status, requested_by)
  VALUES (LEAST(dana, sam), GREATEST(dana, sam), 'accepted', dana);

  -- ── 1. the write ───────────────────────────────────────────────────────────
  res := bgb_log_play(dana, jsonb_build_object(
    'game_id', game, 'played_at', '2026-09-27',
    'players', jsonb_build_array(
      jsonb_build_object('user_id', dana, 'name', 'Dana', 'score', 10, 'one_time', true),
      jsonb_build_object('name', 'Player 1', 'score', 8, 'one_time', true),
      jsonb_build_object('name', 'Player 2', 'score', 7, 'one_time', true),
      jsonb_build_object('name', 'Jo', 'score', 6)
    )));
  play1 := (res->>'id')::uuid;
  ASSERT play1 IS NOT NULL, 'bgb_log_play failed: ' || res::text;

  res := bgb_log_play(dana, jsonb_build_object(
    'game_id', game, 'played_at', '2026-09-28',
    'players', jsonb_build_array(
      jsonb_build_object('user_id', dana, 'name', 'Dana', 'score', 3),
      jsonb_build_object('name', 'Player 1', 'score', 2, 'one_time', true)
    )));
  play2 := (res->>'id')::uuid;
  ASSERT play2 IS NOT NULL, 'bgb_log_play failed: ' || res::text;

  SELECT count(*) INTO n FROM boardgamebuddy_play_players
   WHERE play_id IN (play1, play2) AND one_time;
  ASSERT n = 3, 'three one-time guests should be written, got ' || n;
  ASSERT NOT (SELECT one_time FROM boardgamebuddy_play_players
               WHERE play_id = play1 AND player_user_id = dana),
    'an account seat is never one-time';
  ASSERT NOT (SELECT one_time FROM boardgamebuddy_play_players
               WHERE play_id = play1 AND player_display_name = 'Jo'),
    'a guest is one-time only when asked';

  -- ── 2. the ghost list ──────────────────────────────────────────────────────
  res := bgb_play_partners(dana)->'ghosts';
  ASSERT res::text ILIKE '%"Jo"%', 'Jo should be on the ghost list: ' || res::text;
  ASSERT NOT (res::text ILIKE '%Player %'), 'a one-time guest must not be on the ghost list: ' || res::text;

  -- ── 3. the lookup ──────────────────────────────────────────────────────────
  res := bgb_ghost_claim_detail(sam, play1, 'Player 1');
  key1 := res->>'ghost_name_key';
  ASSERT key1 = 'play:' || play1::text || ':player 1', 'the key should be play-scoped, got ' || res::text;
  ASSERT (res->>'play_count')::int = 1, 'the claim should cover one seat, got ' || res::text;
  ASSERT (res->>'can_claim')::boolean, 'Sam should be able to claim it: ' || res::text;
  ASSERT res->>'ghost_display_name' = 'Player 1', 'the sheet should still say Player 1';

  res := bgb_ghost_claim_detail(sam, play1, 'Jo');
  ASSERT res->>'ghost_name_key' = 'jo', 'an ordinary ghost keeps its name key';

  -- ── 4. claim and accept ────────────────────────────────────────────────────
  res := bgb_create_ghost_claim(sam, dana, key1);
  ASSERT res->>'id' IS NOT NULL, 'claim failed: ' || res::text;
  ASSERT res->>'ghost_display_name' = 'Player 1', 'the claim should carry the seat''s name';
  ASSERT (SELECT (c->>'play_count')::int FROM jsonb_array_elements(bgb_ghost_claims(dana)->'incoming') c) = 1,
    'Dana''s incoming claim should count one play';

  res := bgb_accept_ghost_claim(dana, (res->>'id')::uuid);
  ASSERT (res->>'updated')::int = 1, 'accept should move one seat, got ' || res::text;
  SELECT count(*) INTO n FROM boardgamebuddy_play_players
   WHERE play_id = play1 AND player_user_id = sam;
  ASSERT n = 1, 'Sam should hold the first night''s Player 1';
  SELECT count(*) INTO n FROM boardgamebuddy_play_players
   WHERE player_user_id IS NULL AND one_time
     AND ((play_id = play2 AND player_display_name = 'Player 1')
       OR (play_id = play1 AND player_display_name = 'Player 2'));
  ASSERT n = 2, 'the other one-time guests should be untouched, got ' || n;

  -- ── 5. merge and rename act on the ghost list only ─────────────────────────
  res := bgb_merge_ghosts(dana, 'Player 1', 'Jo');
  ASSERT (res->>'updated')::int = 0, 'merge must not reach a one-time guest, got ' || res::text;

  RAISE NOTICE 'ALL ONE-TIME-GUEST CHECKS PASSED';
END;
$test$;

ROLLBACK;
