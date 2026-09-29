-- ─────────────────────────────────────────────────────────────────────────────
-- rank_deferrals.sql — when a "Rank after next play" deferral lapses
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY THIS FILE EXISTS. api/tests/test_game_ranks.py fakes
-- bgb_rank_deferrals_active, so it proves the queue reads the answer and
-- nothing about the answer. The rule lives only here: a deferral holds until a
-- play the player can see (logged or seated) was created after the stamp AND
-- played on or after its date. An import of old plays must not lapse it, and
-- nobody else's plays may.
--
-- SAFE TO RUN ANYWHERE: one transaction ending in ROLLBACK, touching only rows
-- it inserted under uuids it invented. now() is fixed inside a transaction, so
-- every timestamp here is written out explicitly.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/rank_deferrals.sql
--
-- Needs boardgamebuddy_rank_deferrals and bgb_rank_deferrals_active. Silence
-- plus "ALL RANK-DEFERRALS CHECKS PASSED" is a pass.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
DECLARE
  u  uuid := 'aaaaaaaa-0000-0000-0000-000000000058';
  u2 uuid := 'bbbbbbbb-0000-0000-0000-000000000058';
  g  uuid[] := ARRAY[
    'a0000000-0000-0000-0000-000000000581'::uuid, 'a0000000-0000-0000-0000-000000000582',
    'a0000000-0000-0000-0000-000000000583', 'a0000000-0000-0000-0000-000000000584'];
  stamp timestamptz := '2026-06-10 12:00:00+00';
  p  uuid;
  active jsonb;
BEGIN
  INSERT INTO boardgamebuddy_profiles (id, username, display_name)
  VALUES (u, 'defer_test_058', 'Defer Test'), (u2, 'defer_test_058b', 'Defer Test B');
  FOR i IN 1..4 LOOP
    INSERT INTO boardgamebuddy_games (id, name) VALUES (g[i], 'D' || i);
  END LOOP;

  INSERT INTO boardgamebuddy_rank_deferrals (user_id, game_id, deferred_at)
  VALUES (u, g[1], stamp), (u, g[2], stamp), (u, g[3], stamp), (u2, g[1], stamp);

  -- A play from before the stamp does nothing.
  INSERT INTO boardgamebuddy_plays (user_id, game_id, game_name, played_at, created_at)
  VALUES (u, g[1], 'D1', '2026-06-01', stamp - interval '1 day');
  active := bgb_rank_deferrals_active(u);
  ASSERT active @> to_jsonb(ARRAY[g[1], g[2], g[3]]) AND jsonb_array_length(active) = 3,
    'all three active before any new play: ' || active;

  -- G1: a new play logged by the player lapses it.
  INSERT INTO boardgamebuddy_plays (user_id, game_id, game_name, played_at, created_at)
  VALUES (u, g[1], 'D1', '2026-06-11', stamp + interval '1 day');

  -- G2: an import written after the stamp, of a play from before it, does not.
  INSERT INTO boardgamebuddy_plays (user_id, game_id, game_name, played_at, created_at, imported_at)
  VALUES (u, g[2], 'D2', '2026-05-20', stamp + interval '1 hour', stamp + interval '1 hour');

  -- G3: a play somebody else logged, with the player seated, lapses it.
  INSERT INTO boardgamebuddy_plays (user_id, game_id, game_name, played_at, created_at)
  VALUES (u2, g[3], 'D3', '2026-06-10', stamp + interval '2 hours')
  RETURNING id INTO p;
  INSERT INTO boardgamebuddy_play_players (play_id, player_user_id, player_display_name)
  VALUES (p, u, 'Defer Test');

  active := bgb_rank_deferrals_active(u);
  ASSERT active = to_jsonb(ARRAY[g[2]]), 'only the import-only game stays parked: ' || active;

  -- u2's deferral of G1 is untouched by u's play of it (u2 was not seated).
  active := bgb_rank_deferrals_active(u2);
  ASSERT active = to_jsonb(ARRAY[g[1]]), 'another player''s deferral holds: ' || active;

  -- G4 was never deferred and never appears.
  ASSERT NOT (bgb_rank_deferrals_active(u) @> to_jsonb(ARRAY[g[4]])), 'undeferred game absent';

  -- Nobody deferred anything: an empty array, not NULL.
  ASSERT bgb_rank_deferrals_active('ffffffff-0000-0000-0000-000000000058') = '[]'::jsonb,
    'empty is []';

  RAISE NOTICE 'ALL RANK-DEFERRALS CHECKS PASSED';
END;
$$;

ROLLBACK;
