-- 058_user_stats_detail.sql — one JSONB RPC behind the whole Stats spoke.
--
-- The Profile hub's four stat tiles collapse into a single "Your stats" card
-- that routes to a dedicated Stats screen (/profile/stats). That screen wants a
-- dozen aggregates bgb_user_stats never computed: a most-played podium, a
-- per-game win/score breakdown, a nemesis, a 26-week play heatmap, the unplayed
-- shelf, table-size distribution, category taste, comebacks, the co-op record
-- and personal bests.
--
-- Composed as ONE function returning JSONB rather than a dozen endpoints, for
-- the same reason bgb_profile_bundle exists: every block reads the same "my
-- plays" set, so computing them together costs one pass instead of twelve round
-- trips, and the FE caches one entry. It is a single SQL statement rather than
-- a plpgsql body filling temp tables: `my_plays` is referenced more than once,
-- which makes Postgres materialize it exactly once (PG12+), and a pure SQL
-- STABLE function is safe to run inside the read-only transaction PostgREST
-- opens for non-volatile RPCs — CREATE TEMP TABLE would not be.
--
-- VISIBILITY RULE. "My plays" is the rule migration 045 settled on everywhere
-- else: a play counts for a user when they LOGGED it or when they appear on it
-- as a participant. Blocks that need a per-player row (wins, scores, comebacks,
-- the co-op record) are necessarily narrower — they can only speak for plays
-- where the user is an actual participant — so the payload reports those
-- denominators separately (career.rated_plays) instead of dividing by a total
-- the numerator cannot reach.
--
-- No schema change; no existing function is touched.

BEGIN;

CREATE OR REPLACE FUNCTION public.bgb_user_stats_detail(uid UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
WITH
-- ── The play set every block below reads ──────────────────────────────────
my_plays AS (
  SELECT p.id, p.game_id, p.played_at, p.play_mode, p.game_name
  FROM public.boardgamebuddy_plays p
  WHERE p.user_id = uid
  UNION
  SELECT p.id, p.game_id, p.played_at, p.play_mode, p.game_name
  FROM public.boardgamebuddy_plays p
  JOIN public.boardgamebuddy_play_players pp ON pp.play_id = p.id
  WHERE pp.player_user_id = uid
),
-- My own player row on each of those plays. The gap between this and my_plays
-- is the one the header comment describes: a play I logged but sat out has no
-- row here, so it has no result, no score and no side in a co-op record.
mine AS (
  SELECT mp.id AS play_id, mp.game_id, mp.played_at, mp.play_mode,
         pp.is_winner, pp.score, pp.round_scores
  FROM my_plays mp
  JOIN public.boardgamebuddy_play_players pp
    ON pp.play_id = mp.id AND pp.player_user_id = uid
),
by_game AS (
  SELECT mp.game_id,
         COALESCE(MAX(g.name), MAX(mp.game_name))    AS name,
         MAX(g.thumbnail_url)                        AS thumbnail_url,
         COALESCE(MAX(g.play_mode), 'competitive')   AS play_mode,
         COUNT(*)::INT                               AS plays,
         MAX(mp.played_at)                           AS last_played_at
  FROM my_plays mp
  LEFT JOIN public.boardgamebuddy_games g ON g.id = mp.game_id
  GROUP BY mp.game_id
),

-- ── Per-game breakdown (drives the picker) ────────────────────────────────
-- avg_winning_score averages the WINNER's score across my plays of that game —
-- the bar to clear, carried alongside my own average rather than in place of
-- it. Both are NULL when nobody logged a score (co-op games, and any table that
-- just called a winner), which is what the screen's "no scores" state reads.
winner_scores AS (
  SELECT mp.game_id, w.play_id, w.score
  FROM public.boardgamebuddy_play_players w
  JOIN my_plays mp ON mp.id = w.play_id
  WHERE w.is_winner AND w.score IS NOT NULL
),
game_rows AS (
  SELECT
    bg.game_id, bg.name, bg.thumbnail_url, bg.play_mode, bg.plays, bg.last_played_at,
    (SELECT COUNT(*)::INT FROM mine m
      WHERE m.game_id = bg.game_id AND m.is_winner)                       AS wins,
    (SELECT COUNT(DISTINCT ws.play_id)::INT FROM winner_scores ws
      WHERE ws.game_id = bg.game_id)                                      AS scored_plays,
    (SELECT ROUND(AVG(ws.score))::INT FROM winner_scores ws
      WHERE ws.game_id = bg.game_id)                                      AS avg_winning_score,
    (SELECT ROUND(AVG(m.score))::INT FROM mine m
      WHERE m.game_id = bg.game_id AND m.score IS NOT NULL)               AS your_avg_score,
    (SELECT MAX(m.score) FROM mine m WHERE m.game_id = bg.game_id)        AS your_best_score
  FROM by_game bg
  ORDER BY bg.plays DESC, bg.name
  LIMIT 100
),

-- ── Nemesis ───────────────────────────────────────────────────────────────
-- The account that has beaten me most across COMPETITIVE plays we both sat in.
-- Ranked by their wins, then by how often we've played; a 3-play floor keeps
-- one lucky evening from crowning anyone. Ghost players (no player_user_id)
-- can't be a nemesis — there is no profile to name or badge.
--
-- Co-op plays are excluded, and not just because "who beat whom" is meaningless
-- when you are on the same side: in co-op EVERY seat at the table wins or loses
-- together, so counting them made your_wins and their_wins both fire on the
-- same play. That double-count is visible, not academic — the screen draws
-- you/them/someone-else as one split bar, and with co-op folded in the segments
-- summed past the total.
opponents AS (
  SELECT o.play_id, o.player_user_id, o.is_winner
  FROM public.boardgamebuddy_play_players o
  JOIN mine m ON m.play_id = o.play_id
  WHERE o.player_user_id IS NOT NULL
    AND o.player_user_id <> uid
    AND COALESCE(m.play_mode, 'competitive') <> 'coop'
),
nemesis_row AS (
  SELECT
    op.player_user_id                                    AS user_id,
    pr.display_name,
    pr.avatar,
    COUNT(DISTINCT op.play_id)::INT                      AS shared_plays,
    COUNT(*) FILTER (WHERE op.is_winner)::INT            AS their_wins,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM mine m2 WHERE m2.play_id = op.play_id AND m2.is_winner
    ))::INT                                              AS your_wins
  FROM opponents op
  JOIN public.boardgamebuddy_profiles pr ON pr.id = op.player_user_id
  GROUP BY op.player_user_id, pr.display_name, pr.avatar
  HAVING COUNT(DISTINCT op.play_id) >= 3
  ORDER BY their_wins DESC, shared_plays DESC
  LIMIT 1
),

-- ── Play rhythm ───────────────────────────────────────────────────────────
-- 26 weeks of buckets for the heatmap, plus streaks over ALL history — the
-- longest streak predates the window more often than not.
week_buckets AS (
  SELECT date_trunc('week', mp.played_at)::DATE AS wk, COUNT(*)::INT AS n
  FROM my_plays mp
  GROUP BY 1
),
heat AS (
  SELECT s.wk::DATE AS wk, COALESCE(wb.n, 0) AS n
  FROM generate_series(
         date_trunc('week', CURRENT_DATE) - INTERVAL '25 weeks',
         date_trunc('week', CURRENT_DATE),
         INTERVAL '1 week') AS s(wk)
  LEFT JOIN week_buckets wb ON wb.wk = s.wk::DATE
),
-- Gaps-and-islands: consecutive weeks share (wk - row_number * 7).
streak_runs AS (
  SELECT COUNT(*)::INT AS len, MAX(wk) AS last_wk
  FROM (
    SELECT wk, wk - (ROW_NUMBER() OVER (ORDER BY wk))::INT * 7 AS grp
    FROM week_buckets
  ) g
  GROUP BY grp
),
weekday AS (
  SELECT EXTRACT(DOW FROM mp.played_at)::INT AS dow, COUNT(*)::INT AS plays
  FROM my_plays mp
  GROUP BY 1
  ORDER BY 2 DESC, 1
  LIMIT 1
),

-- ── Table size ────────────────────────────────────────────────────────────
-- Buckets cap at 5+; the tail past six players is one thin bar nobody reads.
-- Plays with no roster at all (a bare BGG import) are excluded so they can't
-- drag the average toward zero.
roster AS (
  SELECT mp.id AS play_id,
         (SELECT COUNT(*)::INT FROM public.boardgamebuddy_play_players pp
           WHERE pp.play_id = mp.id) AS n
  FROM my_plays mp
),

-- ── Comeback kid ──────────────────────────────────────────────────────────
-- Plays I won after trailing at the halfway round. Only computable because
-- round_scores stores the round-by-round breakdown; every other surface in the
-- app can see a play's result but not its shape.
tracked AS (
  SELECT pp.play_id, pp.player_user_id, pp.is_winner, pp.round_scores,
         jsonb_array_length(pp.round_scores) AS n
  FROM public.boardgamebuddy_play_players pp
  JOIN my_plays mp ON mp.id = pp.play_id
  WHERE pp.round_scores IS NOT NULL
    AND jsonb_typeof(pp.round_scores) = 'array'
    AND jsonb_array_length(pp.round_scores) >= 2
),
half AS (
  -- Cumulative score through the midpoint. A round cell holds null until it is
  -- entered, so anything that isn't a JSON number counts as zero rather than
  -- failing the whole call on a cast.
  SELECT t.play_id, t.player_user_id, t.is_winner,
         (SELECT COALESCE(SUM(CASE WHEN jsonb_typeof(e.value) = 'number'
                                   THEN (e.value #>> '{}')::NUMERIC
                                   ELSE 0 END), 0)
            FROM jsonb_array_elements(t.round_scores) WITH ORDINALITY AS e(value, idx)
           WHERE e.idx <= GREATEST(1, t.n / 2)) AS half_score
  FROM tracked t
),
half_lead AS (
  SELECT play_id, MAX(half_score) AS best_half FROM half GROUP BY play_id
),

-- ── Personal bests ────────────────────────────────────────────────────────
-- Ordered by how much I play the game, not by score: 168 at Brass and 94 at
-- Wingspan are not comparable numbers, so the useful ordering is "the records
-- you would actually try to beat".
best_rows AS (
  SELECT bg.game_id, bg.name, bg.plays, b.score, b.played_at
  FROM by_game bg
  JOIN LATERAL (
    SELECT m.score, m.played_at
    FROM mine m
    WHERE m.game_id = bg.game_id AND m.score IS NOT NULL
    ORDER BY m.score DESC, m.played_at DESC
    LIMIT 1
  ) b ON true
  ORDER BY bg.plays DESC, bg.name
  LIMIT 5
)

SELECT jsonb_build_object(
  -- career.win_rate is left to the caller: it divides rated_wins by
  -- rated_plays, never win_count by total_plays. A co-op win is the table
  -- beating the game and belongs in its own block, and a play I logged but sat
  -- out has no result at all.
  'career', jsonb_build_object(
    'total_plays',     (SELECT COUNT(*)::INT FROM my_plays),
    'unique_games',    (SELECT COUNT(DISTINCT game_id)::INT FROM my_plays),
    'win_count',       (SELECT COUNT(*)::INT FROM mine WHERE is_winner),
    'rated_plays',     (SELECT COUNT(*)::INT FROM mine WHERE COALESCE(play_mode, 'competitive') <> 'coop'),
    'rated_wins',      (SELECT COUNT(*)::INT FROM mine WHERE COALESCE(play_mode, 'competitive') <> 'coop' AND is_winner),
    'first_played_at', (SELECT MIN(played_at) FROM my_plays),
    'last_played_at',  (SELECT MAX(played_at) FROM my_plays),
    'hours_played',    COALESCE((
      SELECT ROUND(SUM(g.playing_time)::NUMERIC / 60.0)
      FROM my_plays mp LEFT JOIN public.boardgamebuddy_games g ON g.id = mp.game_id
    ), 0)::FLOAT
  ),

  'podium', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'game_id', game_id, 'name', name,
             'thumbnail_url', thumbnail_url, 'plays', plays)
             ORDER BY plays DESC, name)
    FROM (SELECT * FROM game_rows ORDER BY plays DESC, name LIMIT 3) p
  ), '[]'::JSONB),

  'games', COALESCE((SELECT jsonb_agg(to_jsonb(gr) ORDER BY gr.plays DESC, gr.name)
                       FROM game_rows gr), '[]'::JSONB),

  'nemesis', (SELECT to_jsonb(n) FROM nemesis_row n),

  'rhythm', jsonb_build_object(
    'weeks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('week_start', wk, 'plays', n) ORDER BY wk)
      FROM heat
    ), '[]'::JSONB),
    'longest_streak_weeks', COALESCE((SELECT MAX(len) FROM streak_runs), 0),
    -- The run that is still alive must reach this week or last week. Requiring
    -- the current week would reset every streak each Monday morning, before
    -- that week's game night has happened.
    'current_streak_weeks', COALESCE((
      SELECT MAX(len) FROM streak_runs
      WHERE last_wk >= (date_trunc('week', CURRENT_DATE)::DATE - 7)
    ), 0),
    'busiest_weekday', (SELECT to_jsonb(w) FROM weekday w)
  ),

  -- Owned BASE games only, matching what bgb_user_stats calls owned_games — an
  -- unplayed expansion is not a guilt trip, it is a box on a shelf.
  'shelf', (
    SELECT jsonb_build_object(
      'owned',    COUNT(*)::INT,
      'played',   COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM my_plays mp WHERE mp.game_id = c.game_id))::INT,
      'unplayed', COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM my_plays mp WHERE mp.game_id = c.game_id))::INT
    )
    FROM public.boardgamebuddy_collections c
    JOIN public.boardgamebuddy_games g ON g.id = c.game_id
    WHERE c.user_id = uid AND c.status = 'owned'
      AND COALESCE(g.is_expansion, false) = false
  ),

  'table_size', jsonb_build_object(
    'avg', (SELECT ROUND(AVG(n)::NUMERIC, 1)::FLOAT FROM roster WHERE n > 0),
    'buckets', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('size', size, 'plays', plays) ORDER BY size)
      FROM (
        SELECT LEAST(n, 5) AS size, COUNT(*)::INT AS plays
        FROM roster WHERE n > 0 GROUP BY 1
      ) b
    ), '[]'::JSONB)
  ),

  -- Weighted by plays, not by what is on the shelf: this answers "what do you
  -- actually put on the table", which the collection cannot.
  'taste', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('name', cat, 'plays', n) ORDER BY n DESC, cat)
    FROM (
      SELECT cat, COUNT(*)::INT AS n
      FROM my_plays mp
      JOIN public.boardgamebuddy_games g ON g.id = mp.game_id
      CROSS JOIN LATERAL unnest(COALESCE(g.categories, '{}')) AS cat
      WHERE cat IS NOT NULL AND cat <> ''
      GROUP BY cat
      ORDER BY n DESC, cat
      LIMIT 6
    ) q
  ), '[]'::JSONB),

  'comeback', jsonb_build_object(
    'wins_from_behind', (
      SELECT COUNT(*)::INT
      FROM half h JOIN half_lead hl ON hl.play_id = h.play_id
      WHERE h.player_user_id = uid AND h.is_winner AND h.half_score < hl.best_half
    ),
    'tracked_plays', (
      SELECT COUNT(DISTINCT h.play_id)::INT FROM half h WHERE h.player_user_id = uid
    )
  ),

  -- Kept out of the competitive win rate on purpose: folding co-op in would
  -- quietly inflate a number people read as head-to-head.
  'coop', (
    SELECT jsonb_build_object(
      'wins',   COUNT(*) FILTER (WHERE is_winner)::INT,
      'losses', COUNT(*) FILTER (WHERE NOT COALESCE(is_winner, false))::INT
    )
    FROM mine WHERE play_mode = 'coop'
  ),

  'personal_bests', COALESCE((SELECT jsonb_agg(to_jsonb(br) ORDER BY br.plays DESC, br.name)
                               FROM best_rows br), '[]'::JSONB)
);
$fn$;

GRANT EXECUTE ON FUNCTION public.bgb_user_stats_detail(UUID) TO boardgamebuddy_role;

COMMIT;
