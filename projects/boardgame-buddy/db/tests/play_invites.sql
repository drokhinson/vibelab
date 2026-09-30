-- ─────────────────────────────────────────────────────────────────────────────
-- play_invites.sql — a seat in somebody else's play is an invite
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Dana logs a play seating herself, Sam, Priya and a guest named Jo. Checks:
--
--   1. Sam's and Priya's seats are invites; Dana's counts at once.
--   2. An invite counts for nobody: Sam's stats are empty and the seat is not
--      a ghost on Dana's side.
--   3. Everyone sees Sam on the roster, marked pending, and Sam sees the play
--      in the feed and one entry in "Needs an answer".
--   4. Accepting moves the seat to player_user_id and it counts.
--   5. Declining (bgb_ghost_out_of_plays) leaves a guest named Priya.
--   6. A lobby seat accepted during the game is saved as counted, one left
--      unanswered is saved as an invite, and one declined is saved as a guest.
--   7. bgb_link_ghost invites the account it links, unless it is the caller.
--
-- SAFE TO RUN ANYWHERE: one transaction ending in ROLLBACK, touching only rows
-- it inserted under uuids it invented.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/play_invites.sql
--
-- Needs boardgamebuddy_play_players.pending_user_id and the functions that
-- read it. Silence plus "ALL PLAY-INVITE CHECKS PASSED" is a pass.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $test$
DECLARE
  dana   CONSTANT uuid := gen_random_uuid();
  sam    CONSTANT uuid := gen_random_uuid();
  priya  CONSTANT uuid := gen_random_uuid();
  jo     CONSTANT uuid := gen_random_uuid();
  game   CONSTANT uuid := gen_random_uuid();
  sess   CONSTANT uuid := gen_random_uuid();
  code   CONSTANT text := 'T' || upper(left(replace(gen_random_uuid()::text, '-', ''), 5));
  play1  uuid;
  play2  uuid;
  res    jsonb;
  n      int;
  txt    text;
BEGIN
  INSERT INTO boardgamebuddy_profiles (id, display_name, username) VALUES
    (dana,  'Dana',  'dana_'  || left(dana::text, 8)),
    (sam,   'Sam',   'sam_'   || left(sam::text, 8)),
    (priya, 'Priya', 'priya_' || left(priya::text, 8)),
    (jo,    'Jo',    'jo_'    || left(jo::text, 8));
  INSERT INTO boardgamebuddy_games (id, name) VALUES (game, 'Test Catan');
  INSERT INTO boardgamebuddy_buddy_edges (user_a, user_b, status, requested_by)
  VALUES (LEAST(dana, sam), GREATEST(dana, sam), 'accepted', dana);

  -- ── 1. the write ───────────────────────────────────────────────────────────
  res := bgb_log_play(dana, jsonb_build_object(
    'game_id', game, 'played_at', '2026-09-27',
    'players', jsonb_build_array(
      jsonb_build_object('user_id', dana,  'name', 'Dana',  'score', 10, 'is_winner', true),
      jsonb_build_object('user_id', sam,   'score', 8),
      jsonb_build_object('user_id', priya, 'name', 'Priya', 'score', 7),
      jsonb_build_object('name', 'Jo', 'score', 6)
    )));
  play1 := (res->>'id')::uuid;
  ASSERT play1 IS NOT NULL, 'bgb_log_play failed: ' || res::text;

  SELECT count(*) INTO n FROM boardgamebuddy_play_players
   WHERE play_id = play1 AND player_user_id = dana AND pending_user_id IS NULL;
  ASSERT n = 1, 'the logger''s seat should count at once';

  SELECT count(*) INTO n FROM boardgamebuddy_play_players
   WHERE play_id = play1 AND player_user_id IS NULL AND pending_user_id IN (sam, priya);
  ASSERT n = 2, 'Sam and Priya should be invited, got ' || n;

  SELECT player_display_name INTO txt FROM boardgamebuddy_play_players
   WHERE play_id = play1 AND pending_user_id = sam;
  ASSERT txt = 'Sam', 'an invite with no name should carry the profile name, got ' || COALESCE(txt, 'NULL');

  ASSERT (SELECT bool_and((p->>'pending')::boolean = (p->>'user_id' IN (sam::text, priya::text)))
            FROM jsonb_array_elements(res->'players') p WHERE p->>'user_id' IS NOT NULL),
    'the response should mark exactly the invited seats pending';

  -- ── 2. an invite counts for nobody ─────────────────────────────────────────
  ASSERT (SELECT total_plays FROM bgb_user_stats(sam)) = 0, 'an invite must not count for Sam';
  ASSERT (SELECT total_plays FROM bgb_user_stats(dana)) = 1, 'the play must count for Dana';
  ASSERT NOT ((bgb_play_partners(dana)->'ghosts')::text ILIKE '%Sam%'), 'an invite is not a ghost';
  ASSERT NOT ((bgb_play_partners(dana)->'recent')::text ILIKE '%' || sam::text || '%'), 'an invite is not a played-with partner';

  -- ── 3. the roster and the bell ─────────────────────────────────────────────
  SELECT f.players INTO res FROM bgb_feed_plays(sam) f WHERE f.play_id = play1;
  ASSERT res IS NOT NULL, 'Sam should see the play in the feed';
  ASSERT (SELECT (p->>'pending')::boolean FROM jsonb_array_elements(res) p
           WHERE p->>'user_id' = sam::text), 'the feed roster should show Sam, pending';

  SELECT count(*) INTO n FROM bgb_play_invites(sam) i WHERE play1 = ANY(i.play_ids);
  ASSERT n = 1, 'Sam should have one invite entry, got ' || n;
  ASSERT bgb_notifications_pending(sam) = 1, 'the bell should count one answer owed';
  SELECT count(*) INTO n FROM bgb_notifications(sam) x WHERE x.play_id = play1;
  ASSERT n = 0, 'an unanswered invite is not an answered play_link row';

  -- ── 4. accept ──────────────────────────────────────────────────────────────
  ASSERT bgb_accept_play_invites(sam, ARRAY[play1]) = 1, 'accept should move one seat';
  ASSERT (SELECT total_plays FROM bgb_user_stats(sam)) = 1, 'the accepted play should count';
  ASSERT bgb_notifications_pending(sam) = 0, 'nothing should be owed after accepting';
  SELECT count(*) INTO n FROM bgb_notifications(sam) x WHERE x.play_id = play1;
  ASSERT n = 1, 'the answered play should be an ordinary play_link row';

  -- ── 5. decline ─────────────────────────────────────────────────────────────
  ASSERT bgb_ghost_out_of_plays(priya, ARRAY[play1]) = 1, 'decline should move one seat';
  SELECT count(*) INTO n FROM boardgamebuddy_play_players
   WHERE play_id = play1 AND player_user_id IS NULL AND pending_user_id IS NULL
     AND player_display_name = 'Priya' AND score = 7;
  ASSERT n = 1, 'a declined seat should stay as a guest named Priya';

  -- ── 6. a live game ─────────────────────────────────────────────────────────
  INSERT INTO boardgamebuddy_play_sessions (id, code, host_user_id, game_id)
  VALUES (sess, code, dana, game);
  INSERT INTO boardgamebuddy_play_session_participants (session_id, user_id, display_name, position, accepted_at)
  VALUES (sess, dana, 'Dana', 0, now()),
         (sess, sam,  'Sam',  1, NULL),
         (sess, priya,'Priya',2, NULL),
         (sess, jo,   'Jo',   3, NULL);

  res := bgb_answer_session_seat(code, sam, true);
  ASSERT (SELECT (p->>'accepted')::boolean FROM jsonb_array_elements(res->'participants') p
           WHERE p->>'user_id' = sam::text), 'Sam''s lobby seat should read accepted';
  res := bgb_answer_session_seat(code, jo, false);
  ASSERT (SELECT (p->>'declined')::boolean FROM jsonb_array_elements(res->'participants') p
           WHERE p->>'user_id' = jo::text), '"Not me" should mark Jo''s lobby seat declined';

  res := bgb_finalize_session(dana, code, jsonb_build_object(
    'game_id', game, 'played_at', '2026-09-28',
    'players', jsonb_build_array(
      jsonb_build_object('user_id', dana,  'name', 'Dana',  'score', 3),
      jsonb_build_object('user_id', sam,   'name', 'Sam',   'score', 2),
      jsonb_build_object('user_id', priya, 'name', 'Priya', 'score', 1),
      jsonb_build_object('user_id', jo, 'name', 'Jo', 'score', 0)
    )));
  play2 := (res->>'id')::uuid;
  ASSERT play2 IS NOT NULL, 'finalize failed: ' || res::text;
  SELECT count(*) INTO n FROM boardgamebuddy_play_players
   WHERE play_id = play2 AND player_user_id = sam;
  ASSERT n = 1, 'a seat accepted during the game should be saved as counted';
  SELECT count(*) INTO n FROM boardgamebuddy_play_players
   WHERE play_id = play2 AND pending_user_id = priya;
  ASSERT n = 1, 'a seat not answered during the game should be saved as an invite';
  SELECT count(*) INTO n FROM boardgamebuddy_play_players
   WHERE play_id = play2 AND player_user_id IS NULL AND pending_user_id IS NULL
     AND player_display_name = 'Jo';
  ASSERT n = 1, 'a seat declined during the game should be saved as a guest';

  -- ── 7. linking a ghost ─────────────────────────────────────────────────────
  res := bgb_link_ghost(dana, 'Jo', jo);
  ASSERT (res->>'updated')::int = 2, 'linking Jo should invite both seats, got ' || res::text;
  SELECT count(*) INTO n FROM boardgamebuddy_play_players
   WHERE pending_user_id = jo AND player_user_id IS NULL;
  ASSERT n = 2, 'a linked ghost should be an invite';
  ASSERT (SELECT total_plays FROM bgb_user_stats(jo)) = 0, 'a linked ghost should not count yet';

  RAISE NOTICE 'ALL PLAY-INVITE CHECKS PASSED';
END;
$test$;

ROLLBACK;
