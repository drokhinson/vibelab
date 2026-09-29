-- ─────────────────────────────────────────────────────────────────────────────
-- 057_played_mark.sql — the played mark, on the Played shelf and beyond
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY THIS FILE EXISTS. api/tests/test_played_mark.py pins what the API
-- decides; which games land on the Played shelf is decided in SQL, in three
-- functions that each widen the same set (bgb_collection_shelf,
-- bgb_collection_page, bgb_profile_bundle), plus the status map's marks, the
-- shelf items' played_before and search. This checks all of them against one
-- fixture:
--
--   Owned Game          owned, no plays          → Owned shelf only
--   Logged Game         no row, 2 plays          → Played, 2 plays
--   Marked Game         'played' row, no plays   → Played, 0 plays, listed last
--   Marked And Logged   'played' row, 1 play     → Played ONCE, 1 play
--   Owned And Logged    owned, 1 play            → Owned shelf only
--   Owned Marked        owned + mark, no plays   → Owned shelf, played_before
--
-- SAFE TO RUN ANYWHERE: one transaction ending in ROLLBACK, touching only rows
-- it inserted under uuids it invented.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/057_played_mark.sql
--
-- Needs migration 057 applied. Silence plus "ALL 057 CHECKS PASSED" is a pass.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
DECLARE
  u  uuid := 'aaaaaaaa-0000-0000-0000-000000000057';
  g1 uuid := 'a0000000-0000-0000-0000-000000000571';  -- Owned Game
  g2 uuid := 'a0000000-0000-0000-0000-000000000572';  -- Logged Game
  g3 uuid := 'a0000000-0000-0000-0000-000000000573';  -- Marked Game
  g4 uuid := 'a0000000-0000-0000-0000-000000000574';  -- Marked And Logged
  g5 uuid := 'a0000000-0000-0000-0000-000000000575';  -- Owned And Logged
  g6 uuid := 'a0000000-0000-0000-0000-000000000576';  -- Owned Marked
  r jsonb;
  v_names text;
BEGIN
  INSERT INTO boardgamebuddy_profiles (id, username, display_name)
  VALUES (u, 'played_mark_057', 'Played Mark Test');
  INSERT INTO boardgamebuddy_games (id, name) VALUES
    (g1, 'Owned Game'), (g2, 'Logged Game'), (g3, 'Marked Game'),
    (g4, 'Marked And Logged'), (g5, 'Owned And Logged'), (g6, 'Owned Marked');
  INSERT INTO boardgamebuddy_collections (user_id, game_id, status, game_name, played_before_at) VALUES
    (u, g1, 'owned',  'Owned Game',        NULL),
    (u, g3, 'played', 'Marked Game',       now()),
    (u, g4, 'played', 'Marked And Logged', now()),
    (u, g5, 'owned',  'Owned And Logged',  NULL),
    (u, g6, 'owned',  'Owned Marked',      now());
  INSERT INTO boardgamebuddy_plays (user_id, game_id, game_name, played_at) VALUES
    (u, g2, 'Logged Game',       '2026-09-01'),
    (u, g2, 'Logged Game',       '2026-09-05'),
    (u, g4, 'Marked And Logged', '2026-08-01'),
    (u, g5, 'Owned And Logged',  '2026-07-01');

  -- The shelf: every played game once, marks last, plays counted only from plays.
  r := bgb_collection_shelf(u, u, 'played');
  SELECT string_agg((i->'game'->>'name') || ':' || (i->>'play_count'), ', ' ORDER BY ord)
    INTO v_names FROM jsonb_array_elements(r->'items') WITH ORDINALITY AS t(i, ord);
  IF v_names IS DISTINCT FROM 'Logged Game:2, Marked And Logged:1, Marked Game:0' THEN
    RAISE EXCEPTION 'shelf played: got %', v_names;
  END IF;
  IF (r->>'total')::int <> 3 THEN RAISE EXCEPTION 'shelf played total: %', r->>'total'; END IF;
  -- A mark with no play has no play date, so its added_at is the row's, in
  -- the ISO form the API's datetime field parses.
  IF (SELECT i->>'added_at' FROM jsonb_array_elements(r->'items') i
      WHERE i->'game'->>'name' = 'Marked Game') !~ '^\d{4}-\d\d-\d\dT' THEN
    RAISE EXCEPTION 'marked added_at is not ISO: %', r;
  END IF;

  -- A marked game carries played_before on its shelf item; the others do not.
  IF (SELECT string_agg(i->'game'->>'name', ', ' ORDER BY i->'game'->>'name')
        FROM jsonb_array_elements(r->'items') i WHERE (i->>'played_before')::boolean)
     IS DISTINCT FROM 'Marked And Logged, Marked Game' THEN
    RAISE EXCEPTION 'played shelf played_before: %', r;
  END IF;

  -- The owned shelf does not see a 'played' row, and a mark on an owned row
  -- leaves the game there, flagged.
  r := bgb_collection_shelf(u, u, 'owned');
  IF (r->>'total')::int <> 3 THEN RAISE EXCEPTION 'shelf owned total: %', r->>'total'; END IF;
  IF (SELECT string_agg(i->'game'->>'name', ', ') FROM jsonb_array_elements(r->'items') i
      WHERE (i->>'played_before')::boolean) IS DISTINCT FROM 'Owned Marked' THEN
    RAISE EXCEPTION 'owned shelf played_before: %', r;
  END IF;

  -- The paginated grid agrees with the shelf.
  r := bgb_collection_page(u, u, 'played');
  SELECT string_agg(i->'game'->>'name', ', ' ORDER BY ord)
    INTO v_names FROM jsonb_array_elements(r->'items') WITH ORDINALITY AS t(i, ord);
  IF v_names IS DISTINCT FROM 'Logged Game, Marked And Logged, Marked Game' THEN
    RAISE EXCEPTION 'page played: got %', v_names;
  END IF;

  -- The profile bundle's first page and count agree too, marks last.
  r := bgb_profile_bundle(u, u);
  IF (r->>'played_total')::int <> 3 THEN RAISE EXCEPTION 'bundle played_total: %', r->>'played_total'; END IF;
  SELECT string_agg(i->'game'->>'name', ', ' ORDER BY ord)
    INTO v_names FROM jsonb_array_elements(r->'played_page') WITH ORDINALITY AS t(i, ord);
  IF v_names IS DISTINCT FROM 'Logged Game, Marked And Logged, Marked Game' THEN
    RAISE EXCEPTION 'bundle played_page: got %', v_names;
  END IF;
  IF (r->>'owned_total')::int <> 3 THEN RAISE EXCEPTION 'bundle owned_total: %', r->>'owned_total'; END IF;

  -- The status map reads 'played' for plays and mark-only rows alike, and a
  -- shelf status for a marked owned game; the marks list is what tells them
  -- apart, whatever the status.
  r := bgb_collection_status_map(u);
  IF r->'status_map'->>g3::text <> 'played' OR r->'status_map'->>g2::text <> 'played' THEN
    RAISE EXCEPTION 'status map: %', r;
  END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM jsonb_array_elements_text(r->'played_marks') x)
       IS DISTINCT FROM ARRAY[g3::text, g4::text, g6::text] THEN
    RAISE EXCEPTION 'played_marks: %', r->'played_marks';
  END IF;

  -- Search: a mark-only game is a catalog hit, exactly like a logged-only one.
  IF (SELECT row(in_collection, collection_status)::text FROM boardgamebuddy_search_games(u, 'Marked Game', 5) WHERE id = g3)
     IS DISTINCT FROM
     (SELECT row(in_collection, collection_status)::text FROM boardgamebuddy_search_games(u, 'Logged Game', 5) WHERE id = g2) THEN
    RAISE EXCEPTION 'search treats a mark unlike a logged game';
  END IF;
  IF (SELECT in_collection FROM boardgamebuddy_search_games(u, 'Marked Game', 5) WHERE id = g3) THEN
    RAISE EXCEPTION 'search: a mark-only game reads as in the collection';
  END IF;

  -- The status CHECK admits 'played' and still refuses a stranger.
  BEGIN
    INSERT INTO boardgamebuddy_collections (user_id, game_id, status, game_name)
    VALUES (u, g2, 'lent_out', 'Logged Game');
    RAISE EXCEPTION 'status CHECK let an unknown status through';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE 'ALL 057 CHECKS PASSED';
END $$;

ROLLBACK;
