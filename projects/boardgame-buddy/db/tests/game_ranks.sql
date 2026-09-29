-- ─────────────────────────────────────────────────────────────────────────────
-- 056_game_ranks.sql — the position arithmetic in bgb_rank_game /
--                      bgb_unrank_game
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY THIS FILE EXISTS. api/tests/test_game_ranks.py drives the service against
-- a fake that re-implements these two functions in Python, so it proves the
-- service calls them correctly and nothing about the SQL. The property that
-- matters lives only here: positions inside one (user, category, tier) stay
-- DENSE, 0..n-1, through inserts, moves across tiers, moves within a tier,
-- stale indexes and removals. A hole or a collision would show up as two
-- games both claiming "#3", or as a gap the client's binary search never
-- lands in.
--
-- SAFE TO RUN ANYWHERE: one transaction ending in ROLLBACK, touching only rows
-- it inserted under uuids it invented.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/056_game_ranks.sql
--
-- Needs migration 056 applied (the table and both functions). Silence plus
-- "ALL 056 CHECKS PASSED" is a pass.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
DECLARE
  u  uuid := 'aaaaaaaa-0000-0000-0000-000000000056';
  u2 uuid := 'bbbbbbbb-0000-0000-0000-000000000056';
  g  uuid[] := ARRAY[
    'a0000000-0000-0000-0000-000000000561'::uuid, 'a0000000-0000-0000-0000-000000000562',
    'a0000000-0000-0000-0000-000000000563', 'a0000000-0000-0000-0000-000000000564',
    'a0000000-0000-0000-0000-000000000565'];
  r  jsonb;
  v_order text;
BEGIN
  INSERT INTO boardgamebuddy_profiles (id, username, display_name)
  VALUES (u, 'rank_test_056', 'Rank Test'), (u2, 'rank_test_056b', 'Rank Test B');
  FOR i IN 1..5 LOOP
    INSERT INTO boardgamebuddy_games (id, name) VALUES (g[i], 'G' || i);
  END LOOP;

  -- Empty tier: any index lands at 0.
  r := bgb_rank_game(u, g[1], 'family', 'love', 7);
  ASSERT r->>'position' = '0', 'first insert clamps to 0: ' || r;

  -- Insert at the front, then the end, then the middle.
  PERFORM bgb_rank_game(u, g[2], 'family', 'love', 0);   -- G2 G1
  PERFORM bgb_rank_game(u, g[3], 'family', 'love', 2);   -- G2 G1 G3
  PERFORM bgb_rank_game(u, g[4], 'family', 'love', 1);   -- G2 G4 G1 G3

  SELECT string_agg(gm.name, ' ' ORDER BY gr.position) INTO v_order
    FROM boardgamebuddy_game_ranks gr JOIN boardgamebuddy_games gm ON gm.id = gr.game_id
   WHERE gr.user_id = u AND gr.category = 'family' AND gr.tier = 'love';
  ASSERT v_order = 'G2 G4 G1 G3', 'insert order: ' || v_order;

  -- A stale index past the end clamps rather than leaving a hole.
  r := bgb_rank_game(u, g[5], 'family', 'love', 99);
  ASSERT r->>'position' = '4', 'stale index clamps to the end: ' || r;

  -- Move within the tier (G5 to the front): the row is removed first, so the
  -- index is into the list WITHOUT it.
  PERFORM bgb_rank_game(u, g[5], 'family', 'love', 0);
  SELECT string_agg(gm.name, ' ' ORDER BY gr.position) INTO v_order
    FROM boardgamebuddy_game_ranks gr JOIN boardgamebuddy_games gm ON gm.id = gr.game_id
   WHERE gr.user_id = u AND gr.category = 'family' AND gr.tier = 'love';
  ASSERT v_order = 'G5 G2 G4 G1 G3', 'move within tier: ' || v_order;

  -- Move across tiers closes the gap it leaves.
  PERFORM bgb_rank_game(u, g[4], 'family', 'not', 0);
  SELECT string_agg(gm.name || ':' || gr.position, ' ' ORDER BY gr.position) INTO v_order
    FROM boardgamebuddy_game_ranks gr JOIN boardgamebuddy_games gm ON gm.id = gr.game_id
   WHERE gr.user_id = u AND gr.category = 'family' AND gr.tier = 'love';
  ASSERT v_order = 'G5:0 G2:1 G1:2 G3:3', 'love tier after move-out: ' || v_order;

  -- Removal closes the gap too; removing twice is a no-op, not an error.
  r := bgb_unrank_game(u, g[2]);
  ASSERT (r->>'removed')::boolean, 'remove reports removed';
  r := bgb_unrank_game(u, g[2]);
  ASSERT NOT (r->>'removed')::boolean, 'second remove reports not removed';
  SELECT string_agg(gm.name || ':' || gr.position, ' ' ORDER BY gr.position) INTO v_order
    FROM boardgamebuddy_game_ranks gr JOIN boardgamebuddy_games gm ON gm.id = gr.game_id
   WHERE gr.user_id = u AND gr.category = 'family' AND gr.tier = 'love';
  ASSERT v_order = 'G5:0 G1:1 G3:2', 'love tier after remove: ' || v_order;

  -- Another user's ranking is untouched by all of it.
  PERFORM bgb_rank_game(u2, g[1], 'family', 'love', 0);
  PERFORM bgb_rank_game(u, g[3], 'family', 'love', 0);
  ASSERT (SELECT position FROM boardgamebuddy_game_ranks WHERE user_id = u2 AND game_id = g[1]) = 0,
    'other user unaffected';

  -- Gate errors come back as envelopes, not exceptions.
  r := bgb_rank_game(u, g[1], 'family', 'meh', 0);
  ASSERT r->>'error' = 'invalid_tier', 'bad tier: ' || r;
  r := bgb_rank_game(u, 'ffffffff-0000-0000-0000-000000000056', 'family', 'love', 0);
  ASSERT r->>'error' = 'game_not_found', 'unknown game: ' || r;

  -- Dense everywhere: in every (user, category, tier), positions are exactly 0..n-1.
  ASSERT NOT EXISTS (
    SELECT 1 FROM (
      SELECT user_id, category, tier, count(*) AS n, max(position) AS mx, count(DISTINCT position) AS d
        FROM boardgamebuddy_game_ranks WHERE user_id IN (u, u2)
       GROUP BY 1, 2, 3
    ) t WHERE t.mx <> t.n - 1 OR t.d <> t.n
  ), 'positions are dense';

  RAISE NOTICE 'ALL 056 CHECKS PASSED';
END;
$$;

ROLLBACK;
