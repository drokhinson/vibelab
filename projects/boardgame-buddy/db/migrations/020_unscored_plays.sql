-- ─────────────────────────────────────────────────────────────────────────────
-- 020 — Plays that recorded no outcome are not losses
-- ─────────────────────────────────────────────────────────────────────────────
-- A play logged without touching the scoring grid stores a roster where every
-- seat has is_winner = false and score IS NULL. Nothing there says "nobody
-- won" — it says "nobody said". Both stats RPCs read the absence as a result:
-- the play landed in career.rated_plays, in the per-game denominator and in
-- the shared-record denominator with zero wins against it, so it dragged the
-- win rate down as a loss. The feed card had the same bug and rendered
-- "We lost" (fixed in web/ui/play-card.js, same commit).
--
-- The rule, applied identically in both functions here and on the client:
--
--     A play's outcome is UNRECORDED when no seat is flagged is_winner AND no
--     seat carries a score.
--
-- Such a play stays a play — total_plays, unique_games, the podium, the
-- heatmap, table sizes and taste all still count it. It is only kept out of
-- the ratios, where a denominator implies a result.
--
-- Two things follow, both shipped alongside this migration:
--   * The client stops rolling a blank grid up to 0 (an all-blank round array
--     summed to zero, which made an unscored play look scored). The backfill
--     at the foot of this file repairs the rows that already landed.
--   * A co-op table that did not beat the game now records a deliberate 0, so
--     a genuine co-op loss — whose roster is otherwise shaped exactly like an
--     unrecorded play — still counts. personal_bests excludes co-op below so
--     that stamped zero cannot become somebody's "record".
--
-- Both functions return JSONB with unchanged signatures, so CREATE OR REPLACE
-- is enough — no DROP, no return-type churn.
--
-- bgb_user_stats(uid) is deliberately untouched: its win_count is a raw count
-- of winning seats, not a ratio, and an unrecorded play contributes zero to it
-- already. Same for the achievement counters in bgb_achievement_metrics.


-- ─────────────────────────────────────────────────────────────────────────────
-- bgb_user_stats_detail — the Stats spoke (/profile/stats)
-- ─────────────────────────────────────────────────────────────────────────────
-- Re-emitted from 003_rpcs.sql with a `decided` flag on the `mine` CTE, and
-- every ratio filtered by it: career.rated_plays, the new per-game
-- decided_plays, the nemesis opponent set and the co-op record. games[] gains
-- decided_plays alongside the existing plays and scored_plays (that last one
-- means "plays with a winner score" and is a different question — do not
-- confuse the two).
CREATE OR REPLACE FUNCTION public.bgb_user_stats_detail(uid uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
         pp.is_winner, pp.score, pp.round_scores,
         -- Did this play record an outcome at all? A play where NO seat is
         -- flagged a winner and NO seat carries a score says nothing about how
         -- it went — it is not a loss, it is a blank. It is still a play (it
         -- counts in total_plays, the heatmap, the podium, table sizes), but a
         -- win-rate denominator that swallows it reports losses nobody had.
         -- Read over the whole roster, not just my own seat: a play someone
         -- else won is decided for me too.
         EXISTS (
           SELECT 1 FROM public.boardgamebuddy_play_players d
            WHERE d.play_id = mp.id
              AND (d.is_winner OR d.score IS NOT NULL)
         ) AS decided
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
    -- The ring's denominator. `plays` above stays the honest play count (it
    -- includes plays I logged but sat out, and plays with no result); this is
    -- the subset that can be won or lost, so wins + losses adds up to it.
    (SELECT COUNT(*)::INT FROM mine m
      WHERE m.game_id = bg.game_id AND m.decided)                         AS decided_plays,
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
    AND m.decided
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
      -- A co-op loss records a deliberate 0 (see the FE's _stampCoopLoss), and
      -- "your personal best at Pandemic: 0" is not a record anybody set.
      AND COALESCE(m.play_mode, 'competitive') <> 'coop'
    ORDER BY m.score DESC, m.played_at DESC
    LIMIT 1
  ) b ON true
  ORDER BY bg.plays DESC, bg.name
  LIMIT 5
)

SELECT jsonb_build_object(
  -- career.win_rate is left to the caller: it divides rated_wins by
  -- rated_plays, never win_count by total_plays. A co-op win is the table
  -- beating the game and belongs in its own block; a play I logged but sat
  -- out has no result at all; and neither does a play nobody won and nobody
  -- scored, which is what `decided` filters out of every ratio below.
  'career', jsonb_build_object(
    'total_plays',     (SELECT COUNT(*)::INT FROM my_plays),
    'unique_games',    (SELECT COUNT(DISTINCT game_id)::INT FROM my_plays),
    'win_count',       (SELECT COUNT(*)::INT FROM mine WHERE is_winner),
    'rated_plays',     (SELECT COUNT(*)::INT FROM mine WHERE COALESCE(play_mode, 'competitive') <> 'coop' AND decided),
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
  --
  -- 'played' counts a game the viewer has plays for OR has hand-marked as
  -- played before they joined (played_before_at). The mark is deliberately
  -- scoped to THIS block: it creates no play row, so every other aggregate on
  -- this screen — the podium, the rhythm heatmap, personal bests, career
  -- totals — is untouched by it, and so is the collection's status map.
  --
  -- 'games' is the list the Stats spoke's shelf sheet renders: every owned
  -- base game with NO logged plays, marked or not. A game with real plays is
  -- not a shelf-of-shame candidate and has no mark to undo, so it never needs
  -- to be in here. Capped, because a BGG import can be four figures.
  'shelf', (
    WITH owned_base AS (
      SELECT c.game_id, c.game_name, c.game_thumbnail_url, c.game_year_published,
             c.played_before_at,
             EXISTS (SELECT 1 FROM my_plays mp WHERE mp.game_id = c.game_id) AS has_plays
      FROM public.boardgamebuddy_collections c
      JOIN public.boardgamebuddy_games g ON g.id = c.game_id
      WHERE c.user_id = uid AND c.status = 'owned'
        AND COALESCE(g.is_expansion, false) = false
    )
    SELECT jsonb_build_object(
      'owned',    COUNT(*)::INT,
      'played',   COUNT(*) FILTER (WHERE has_plays OR played_before_at IS NOT NULL)::INT,
      'unplayed', COUNT(*) FILTER (WHERE NOT has_plays AND played_before_at IS NULL)::INT,
      'marked',   COUNT(*) FILTER (WHERE NOT has_plays AND played_before_at IS NOT NULL)::INT,
      'games', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'game_id',        t.game_id,
                 'name',           t.game_name,
                 'thumbnail_url',  t.game_thumbnail_url,
                 'year_published', t.game_year_published,
                 'played_before',  t.played_before_at IS NOT NULL
               ) ORDER BY t.game_name)
        FROM (
          SELECT * FROM owned_base WHERE NOT has_plays
          ORDER BY game_name LIMIT 300
        ) t
      ), '[]'::JSONB),
      'games_truncated',
        (SELECT COUNT(*) FROM owned_base WHERE NOT has_plays) > 300
    )
    FROM owned_base
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
    FROM mine WHERE play_mode = 'coop' AND decided
  ),

  'personal_bests', COALESCE((SELECT jsonb_agg(to_jsonb(br) ORDER BY br.plays DESC, br.name)
                               FROM best_rows br), '[]'::JSONB)
);
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_user_stats_detail(uid uuid) TO boardgamebuddy_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- bgb_profile_bundle — a buddy's profile, including the shared record
-- ─────────────────────────────────────────────────────────────────────────────
-- Re-emitted from 011_profile_bundle_visibility_union.sql with one added EXISTS
-- on the `shared` CTE. Everything else in this 560-line function is verbatim.
CREATE OR REPLACE FUNCTION public.bgb_profile_bundle(viewer uuid, target uuid, col_per_page integer DEFAULT 12, plays_per_page integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_stats JSONB;
  v_owned_page JSONB;
  v_owned_total BIGINT;
  v_owned_parted_total BIGINT;
  v_wishlist_page JSONB;
  v_wishlist_total BIGINT;
  v_played_page JSONB;
  v_played_total BIGINT;
  v_recent_plays JSONB;
  v_recent_plays_total BIGINT;
  v_status_map JSONB;
  v_expansion_counts JSONB;
  v_buddies JSONB;
  v_buddy_incoming JSONB;
  v_buddy_outgoing JSONB;
  v_ghost_claims_incoming JSONB;
  v_together JSONB;
  v_top_games JSONB;
  v_is_self BOOLEAN := (viewer = target);
  v_is_buddy BOOLEAN := false;
BEGIN
  -- Edges are canonical (user_a < user_b), so match the pair either way round.
  IF NOT v_is_self THEN
    SELECT EXISTS (
      SELECT 1 FROM boardgamebuddy_buddy_edges be
      WHERE be.status = 'accepted'
        AND ((be.user_a = viewer AND be.user_b = target)
          OR (be.user_a = target AND be.user_b = viewer))
    ) INTO v_is_buddy;
  END IF;

  SELECT jsonb_build_object(
    'total_plays', COALESCE(s.total_plays, 0),
    'unique_games', COALESCE(s.unique_games, 0),
    'win_count', COALESCE(s.win_count, 0),
    'last_played_at', s.last_played_at,
    'hours_played', COALESCE(s.hours_played, 0)::FLOAT,
    'owned_games', COALESCE(s.owned_games, 0),
    'owned_expansions', COALESCE(s.owned_expansions, 0),
    'favorite_game', CASE
      WHEN s.favorite_game_id IS NOT NULL THEN jsonb_build_object(
        'game_id', s.favorite_game_id,
        'name', s.favorite_game_name,
        'play_count', COALESCE(s.favorite_play_count, 0)
      )
      ELSE NULL
    END
  ) INTO v_stats
  FROM bgb_user_stats(target) s;
  v_stats := COALESCE(v_stats, jsonb_build_object(
    'total_plays', 0, 'unique_games', 0, 'win_count', 0,
    'last_played_at', NULL, 'hours_played', 0,
    'owned_games', 0, 'owned_expansions', 0, 'favorite_game', NULL
  ));

  -- owned_total is games you actually OWN, so it keeps the bare 'owned'
  -- predicate: a prev_owned row (sold, gifted, donated — 069) is on the Owned
  -- shelf for display only and is counted separately, in owned_parted_total.
  -- owned_page below returns BOTH, because it is the Collection spoke's
  -- first-frame seed and has to hold the same rows bgb_collection_shelf will.
  SELECT
    COUNT(*) FILTER (WHERE c.status = 'owned'),
    COUNT(*) FILTER (WHERE c.status = 'prev_owned')
    INTO v_owned_total, v_owned_parted_total
    FROM boardgamebuddy_collections c
    WHERE c.user_id = target AND c.status IN ('owned', 'prev_owned')
      AND COALESCE(c.game_is_expansion, false) = false;

  SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY sort_order_a DESC NULLS LAST, sort_order_b DESC), '[]'::jsonb)
    INTO v_owned_page
    FROM (
      SELECT
        ps.last_played_at AS sort_order_a,
        c.added_at AS sort_order_b,
        jsonb_build_object(
          'id', c.id,
          'game_id', c.game_id,
          'status', c.status,
          'added_at', c.added_at,
          'last_played_at', ps.last_played_at,
          'play_count', COALESCE(ps.play_count, 0),
          'game', jsonb_build_object(
            'id', c.game_id,
            'bgg_id', c.game_bgg_id,
            'name', c.game_name,
            'year_published', c.game_year_published,
            'min_players', c.game_min_players,
            'max_players', c.game_max_players,
            'playing_time', c.game_playing_time,
            'thumbnail_url', c.game_thumbnail_url,
            'image_url', gi.image_url,
            'theme_color', c.game_theme_color,
            'is_expansion', COALESCE(c.game_is_expansion, false),
            'base_game_bgg_id', c.game_base_game_bgg_id,
            'expansion_color', c.game_expansion_color,
            'play_mode', COALESCE(c.game_play_mode, 'competitive'),
            'expansion_count', 0
          ),
          'expansions', '[]'::jsonb
        ) AS row_jsonb
      FROM boardgamebuddy_collections c
      LEFT JOIN boardgamebuddy_games gi ON gi.id = c.game_id
      -- image_url only — see the header. Every other game field stays denorm.
      LEFT JOIN LATERAL (
        SELECT MAX(p.played_at) AS last_played_at, COUNT(*)::INT AS play_count
        FROM boardgamebuddy_plays p
        WHERE p.game_id = c.game_id
          AND (
            p.user_id = target
            OR EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = target
            )
          )
      ) ps ON true
      WHERE c.user_id = target AND c.status IN ('owned', 'prev_owned')
        AND COALESCE(c.game_is_expansion, false) = false
      ORDER BY ps.last_played_at DESC NULLS LAST, c.added_at DESC
      LIMIT col_per_page
    ) p;

  SELECT COUNT(*) INTO v_wishlist_total
    FROM boardgamebuddy_collections c
    WHERE c.user_id = target AND c.status = 'wishlist'
      AND COALESCE(c.game_is_expansion, false) = false;

  SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY added_at DESC), '[]'::jsonb)
    INTO v_wishlist_page
    FROM (
      SELECT
        c.added_at,
        jsonb_build_object(
          'id', c.id,
          'game_id', c.game_id,
          'status', c.status,
          'added_at', c.added_at,
          'last_played_at', ps.last_played_at,
          'play_count', COALESCE(ps.play_count, 0),
          'game', jsonb_build_object(
            'id', c.game_id,
            'bgg_id', c.game_bgg_id,
            'name', c.game_name,
            'year_published', c.game_year_published,
            'min_players', c.game_min_players,
            'max_players', c.game_max_players,
            'playing_time', c.game_playing_time,
            'thumbnail_url', c.game_thumbnail_url,
            'image_url', gi.image_url,
            'theme_color', c.game_theme_color,
            'is_expansion', COALESCE(c.game_is_expansion, false),
            'base_game_bgg_id', c.game_base_game_bgg_id,
            'expansion_color', c.game_expansion_color,
            'play_mode', COALESCE(c.game_play_mode, 'competitive'),
            'expansion_count', 0
          ),
          'expansions', '[]'::jsonb
        ) AS row_jsonb
      FROM boardgamebuddy_collections c
      LEFT JOIN boardgamebuddy_games gi ON gi.id = c.game_id
      -- image_url only — see the header. Every other game field stays denorm.
      LEFT JOIN LATERAL (
        SELECT MAX(p.played_at) AS last_played_at, COUNT(*)::INT AS play_count
        FROM boardgamebuddy_plays p
        WHERE p.game_id = c.game_id
          AND (
            p.user_id = target
            OR EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = target
            )
          )
      ) ps ON true
      WHERE c.user_id = target AND c.status = 'wishlist'
        AND COALESCE(c.game_is_expansion, false) = false
      ORDER BY c.added_at DESC
      LIMIT col_per_page
    ) p;

  WITH played_games AS (
    -- EXISTS, not a LEFT JOIN onto play_players: the join fans one play out
    -- to one row per participant, so COUNT(*) over it multiplied every play
    -- the target logged by its player count. Matches bgb_play_stats (039).
    SELECT
      mp.game_id,
      MAX(mp.played_at) AS last_played_at,
      COUNT(*)::INT AS play_count
    FROM (
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
      UNION
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE pp.player_user_id = target
    ) mp
    GROUP BY mp.game_id
  ),
  played_not_owned AS (
    SELECT pg.*
    FROM played_games pg
    WHERE NOT EXISTS (
      SELECT 1 FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.game_id = pg.game_id
    )
  )
  SELECT COUNT(*) INTO v_played_total
    FROM played_not_owned pno
    JOIN boardgamebuddy_games g ON g.id = pno.game_id
    WHERE g.is_expansion = false;

  WITH played_games AS (
    -- EXISTS, not a LEFT JOIN onto play_players: the join fans one play out
    -- to one row per participant, so COUNT(*) over it multiplied every play
    -- the target logged by its player count. Matches bgb_play_stats (039).
    SELECT
      mp.game_id,
      MAX(mp.played_at) AS last_played_at,
      COUNT(*)::INT AS play_count
    FROM (
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
      UNION
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE pp.player_user_id = target
    ) mp
    GROUP BY mp.game_id
  ),
  played_not_owned AS (
    SELECT pg.*
    FROM played_games pg
    WHERE NOT EXISTS (
      SELECT 1 FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.game_id = pg.game_id
    )
  )
  SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY sort_order DESC), '[]'::jsonb)
    INTO v_played_page
    FROM (
      SELECT
        pno.last_played_at AS sort_order,
        jsonb_build_object(
          'id', 'derived-' || pno.game_id::text,
          'game_id', pno.game_id,
          'status', 'played',
          'added_at', (pno.last_played_at::text || 'T00:00:00+00:00'),
          'last_played_at', pno.last_played_at,
          'play_count', pno.play_count,
          'game', jsonb_build_object(
            'id', g.id,
            'bgg_id', g.bgg_id,
            'name', g.name,
            'year_published', g.year_published,
            'min_players', g.min_players,
            'max_players', g.max_players,
            'playing_time', g.playing_time,
            'thumbnail_url', g.thumbnail_url,
            'image_url', g.image_url,
            'theme_color', g.theme_color,
            'is_expansion', g.is_expansion,
            'base_game_bgg_id', g.base_game_bgg_id,
            'expansion_color', g.expansion_color,
            'play_mode', g.play_mode,
            'expansion_count', 0
          ),
          'expansions', '[]'::jsonb
        ) AS row_jsonb
      FROM played_not_owned pno
      JOIN boardgamebuddy_games g ON g.id = pno.game_id
      WHERE g.is_expansion = false
      ORDER BY pno.last_played_at DESC
      LIMIT col_per_page
    ) p;

  -- The total is a general stat and stays visible to everyone; only the log
  -- below it is buddies-only.
  SELECT COUNT(*) INTO v_recent_plays_total
    FROM (
      SELECT p.id
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
      UNION
      SELECT p.id
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE pp.player_user_id = target
    ) mp;

  IF v_is_self OR v_is_buddy THEN
    SELECT COALESCE(jsonb_agg(play_row ORDER BY played_at DESC, created_at DESC), '[]'::jsonb)
      INTO v_recent_plays
      FROM (
        SELECT
          p.played_at, p.created_at,
          jsonb_build_object(
            'id', p.id,
            'game_id', p.game_id,
            'game_name', p.game_name,
            'game_thumbnail', p.game_thumbnail_url,
            'played_at', p.played_at,
            'notes', p.notes,
            'photo_url', p.photo_url,
            'play_mode', COALESCE(p.play_mode, 'competitive'),
            'created_at', p.created_at,
            'logged_by_id', p.user_id,
            'logged_by_name', COALESCE(pr.display_name, 'Unknown'),
            'is_own', p.user_id = viewer,
            'players', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'user_id', pp.player_user_id,
                'name', COALESCE(pp_pr.display_name, pp.player_display_name, 'Unknown'),
                'is_winner', COALESCE(pp.is_winner, false),
                'score', pp.score,
                'avatar', pp_pr.avatar
              ) ORDER BY pp.id)
              FROM boardgamebuddy_play_players pp
              LEFT JOIN boardgamebuddy_profiles pp_pr ON pp_pr.id = pp.player_user_id
              WHERE pp.play_id = p.id
            ), '[]'::jsonb),
            'expansions', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'expansion_game_id', pe.expansion_game_id,
                'name', eg.name,
                'color', eg.expansion_color
              ))
              FROM boardgamebuddy_play_expansions pe
              JOIN boardgamebuddy_games eg ON eg.id = pe.expansion_game_id
              WHERE pe.play_id = p.id
            ), '[]'::jsonb)
          ) AS play_row
        FROM (
          SELECT p.id, p.played_at, p.created_at
          FROM boardgamebuddy_plays p
          WHERE p.user_id = target
          UNION
          SELECT p.id, p.played_at, p.created_at
          FROM boardgamebuddy_plays p
          JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
          WHERE pp.player_user_id = target
          ORDER BY played_at DESC, created_at DESC
          LIMIT plays_per_page
        ) mp
        JOIN boardgamebuddy_plays p ON p.id = mp.id
        LEFT JOIN boardgamebuddy_profiles pr ON pr.id = p.user_id
        ORDER BY p.played_at DESC, p.created_at DESC
      ) r;
  ELSE
    -- NULL, not '[]': an empty array is the honest answer for "this person has
    -- never logged a play", and the screen says exactly that under it. A
    -- stranger must not be told that.
    v_recent_plays := NULL;
  END IF;

  -- No status filter, so prev_owned (069) reaches the map unaided — which is
  -- what the status tag and its picker sheet read to know which row to check.
  SELECT COALESCE(jsonb_object_agg(game_id, status), '{}'::jsonb)
    INTO v_status_map
    FROM (
      SELECT c.game_id, c.status
      FROM boardgamebuddy_collections c
      WHERE c.user_id = viewer
      UNION ALL
      SELECT DISTINCT p.game_id, 'played'::TEXT AS status
      FROM boardgamebuddy_plays p
      LEFT JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE (p.user_id = viewer OR pp.player_user_id = viewer)
        AND NOT EXISTS (
          SELECT 1 FROM boardgamebuddy_collections c2
          WHERE c2.user_id = viewer AND c2.game_id = p.game_id
        )
    ) m;

  -- Owned-only on purpose (069): an expansion you sold is no longer clutter on
  -- the base game's shelf. Mirrors bgb_collection_status_map's block exactly.
  SELECT COALESCE(jsonb_object_agg(base_bgg, cnt), '{}'::jsonb)
    INTO v_expansion_counts
    FROM (
      SELECT c.game_base_game_bgg_id AS base_bgg, COUNT(*)::INT AS cnt
      FROM boardgamebuddy_collections c
      WHERE c.user_id = viewer
        AND c.status = 'owned'
        AND COALESCE(c.game_is_expansion, false) = true
        AND c.game_base_game_bgg_id IS NOT NULL
      GROUP BY c.game_base_game_bgg_id
    ) e;

  -- ── Buddy-only blocks ──────────────────────────────────────────────────
  IF v_is_buddy THEN
    -- Shared record. Both sides must have a player row on the play — see the
    -- header on why the logger alone does not count and why co-op is out.
    -- GROUP BY p.id collapses the two joins back to one row per play, so a
    -- duplicated participant row cannot inflate the count.
    WITH shared AS (
      SELECT
        p.id AS play_id,
        p.played_at,
        COALESCE(BOOL_OR(vp.is_winner), false) AS you_won,
        COALESCE(BOOL_OR(tp.is_winner), false) AS they_won
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players vp
        ON vp.play_id = p.id AND vp.player_user_id = viewer
      JOIN boardgamebuddy_play_players tp
        ON tp.play_id = p.id AND tp.player_user_id = target
      WHERE COALESCE(p.play_mode, 'competitive') <> 'coop'
        -- Only plays that recorded a result. shared_plays is the denominator
        -- your_wins and their_wins are read against, so a play nobody won and
        -- nobody scored would show up as a game you both somehow lost.
        AND EXISTS (
          SELECT 1 FROM boardgamebuddy_play_players d
           WHERE d.play_id = p.id AND (d.is_winner OR d.score IS NOT NULL)
        )
      GROUP BY p.id, p.played_at
    )
    SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE jsonb_build_object(
      'shared_plays', COUNT(*)::INT,
      'your_wins', COUNT(*) FILTER (WHERE you_won)::INT,
      'their_wins', COUNT(*) FILTER (WHERE they_won)::INT,
      'last_played_at', MAX(played_at)
    ) END INTO v_together FROM shared;

    -- Target's three most-played games, over the same "logged it or sat at the
    -- table" set every other block here uses. Name and thumbnail come off the
    -- denormalized play columns (020), with boardgamebuddy_games filling in
    -- full-size art the plays table never carried.
    SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY plays DESC, name), '[]'::jsonb)
      INTO v_top_games
      FROM (
        SELECT
          tg.plays,
          tg.name,
          jsonb_build_object(
            'game_id', tg.game_id,
            'name', tg.name,
            'thumbnail_url', COALESCE(g.thumbnail_url, tg.thumbnail_url),
            'image_url', g.image_url,
            'play_count', tg.plays,
            'last_played_at', tg.last_played_at
          ) AS row_jsonb
        FROM (
          SELECT
            mp.game_id,
            MAX(mp.game_name) AS name,
            MAX(mp.game_thumbnail_url) AS thumbnail_url,
            MAX(mp.played_at) AS last_played_at,
            COUNT(*)::INT AS plays
          FROM (
            SELECT p.id, p.game_id, p.game_name, p.game_thumbnail_url, p.played_at
            FROM boardgamebuddy_plays p
            WHERE p.user_id = target
            UNION
            SELECT p.id, p.game_id, p.game_name, p.game_thumbnail_url, p.played_at
            FROM boardgamebuddy_plays p
            JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
            WHERE pp.player_user_id = target
          ) mp
          GROUP BY mp.game_id
          ORDER BY plays DESC, name
          LIMIT 3
        ) tg
        LEFT JOIN boardgamebuddy_games g ON g.id = tg.game_id
      ) t;
  ELSE
    v_together := NULL;
    v_top_games := NULL;
  END IF;

  IF v_is_self THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', be.id,
      'other_user_id', CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END,
      'other_display_name', pr.display_name,
      'other_avatar', pr.avatar,
      'accepted_at', be.accepted_at,
      'created_at', be.created_at
    ) ORDER BY pr.display_name), '[]'::jsonb)
      INTO v_buddies
      FROM boardgamebuddy_buddy_edges be
      JOIN boardgamebuddy_profiles pr
        ON pr.id = (CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END)
      WHERE (be.user_a = viewer OR be.user_b = viewer) AND be.status = 'accepted';

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', be.id,
      'direction', 'incoming',
      'other_user_id', CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END,
      'other_display_name', pr.display_name,
      'other_avatar', pr.avatar,
      'created_at', be.created_at
    ) ORDER BY be.created_at DESC), '[]'::jsonb)
      INTO v_buddy_incoming
      FROM boardgamebuddy_buddy_edges be
      JOIN boardgamebuddy_profiles pr
        ON pr.id = (CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END)
      WHERE (be.user_a = viewer OR be.user_b = viewer)
        AND be.status = 'pending'
        AND be.requested_by <> viewer;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', be.id,
      'direction', 'outgoing',
      'other_user_id', CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END,
      'other_display_name', pr.display_name,
      'other_avatar', pr.avatar,
      'created_at', be.created_at
    ) ORDER BY be.created_at DESC), '[]'::jsonb)
      INTO v_buddy_outgoing
      FROM boardgamebuddy_buddy_edges be
      JOIN boardgamebuddy_profiles pr
        ON pr.id = (CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END)
      WHERE (be.user_a = viewer OR be.user_b = viewer)
        AND be.status = 'pending'
        AND be.requested_by = viewer;

    -- Ghost claims waiting on the viewer (migration 070). Same shape and same
    -- reason as buddy_requests_incoming: the Profile tab's dot and the Buddies
    -- card's count both have to be right on FIRST PAINT, and /bootstrap
    -- already carries this bundle. A separate fetch would put a round trip on
    -- the app's slowest path to publish one integer.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', gc.id,
      'direction', 'incoming',
      'other_user_id', pr.id,
      'other_display_name', pr.display_name,
      'other_avatar', pr.avatar,
      'ghost_display_name', gc.ghost_display_name,
      'created_at', gc.created_at
    ) ORDER BY gc.created_at DESC), '[]'::jsonb)
      INTO v_ghost_claims_incoming
      FROM boardgamebuddy_ghost_claims gc
      JOIN boardgamebuddy_profiles pr ON pr.id = gc.claimant_id
     WHERE gc.owner_id = viewer AND gc.status = 'pending';
  ELSE
    v_buddies := NULL;
    v_buddy_incoming := NULL;
    v_buddy_outgoing := NULL;
    v_ghost_claims_incoming := NULL;
  END IF;

  RETURN jsonb_build_object(
    'is_buddy', v_is_buddy,
    'stats', v_stats,
    'owned_page', v_owned_page,
    'owned_total', v_owned_total,
    'owned_parted_total', v_owned_parted_total,
    'wishlist_page', v_wishlist_page,
    'wishlist_total', v_wishlist_total,
    'played_page', v_played_page,
    'played_total', v_played_total,
    'recent_plays', v_recent_plays,
    'recent_plays_total', v_recent_plays_total,
    'together', v_together,
    'top_games', v_top_games,
    'status_map', v_status_map,
    'expansion_counts', v_expansion_counts,
    'buddies', v_buddies,
    'buddy_requests_incoming', v_buddy_incoming,
    'buddy_requests_outgoing', v_buddy_outgoing,
    'ghost_claims_incoming', v_ghost_claims_incoming
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_profile_bundle(viewer uuid, target uuid, col_per_page integer, plays_per_page integer) TO boardgamebuddy_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill — repair the zeroes the blank-grid rollup already wrote
-- ─────────────────────────────────────────────────────────────────────────────
-- Before this change, tapping "Add round" and typing nothing saved every seat
-- with score = 0 (web/domain/play-session.js summed blank cells, and the
-- backend's PlayerEntry validator re-derived the same 0 from an all-NULL round
-- array). Those rows read as scored, so the fix above would not reach them.
--
-- The predicate is narrow on purpose — all three conditions together are the
-- shape only the bug produces:
--   * nobody on the play is flagged a winner, AND
--   * every seat sits on exactly 0 (one real score anywhere and it is a real
--     scoreline, so the play is left alone), AND
--   * no round was ever typed into.
--
-- A table that genuinely all scored 0 and crowned nobody is indistinguishable
-- from the bug by construction, and it recorded no outcome either way.
--
-- Co-op is excluded, and that exclusion is load-bearing rather than cautious.
-- A deliberate co-op loss stamps exactly this shape — no winner, every seat on
-- 0, no rounds — so without the carve-out a second run of this migration would
-- erase the losses the first run's code started recording. It is also the
-- honest reading of the history: under the old code a co-op play with no
-- winner always displayed "We lost", so leaving those rows scored preserves
-- what the user has been looking at all along.
--
-- Run the SELECT first and check the number before applying the UPDATE:
--
--   SELECT COUNT(*) FROM public.boardgamebuddy_play_players pp
--    WHERE pp.score = 0
--      AND EXISTS (SELECT 1 FROM public.boardgamebuddy_plays p
--                   WHERE p.id = pp.play_id
--                     AND COALESCE(p.play_mode,'competitive') <> 'coop')
--      AND NOT EXISTS (SELECT 1 FROM public.boardgamebuddy_play_players w
--                       WHERE w.play_id = pp.play_id AND w.is_winner)
--      AND NOT EXISTS (SELECT 1 FROM public.boardgamebuddy_play_players s
--                       WHERE s.play_id = pp.play_id AND s.score IS DISTINCT FROM 0)
--      AND (pp.round_scores IS NULL
--           OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pp.round_scores) e
--                           WHERE jsonb_typeof(e.value) <> 'null'));

UPDATE public.boardgamebuddy_play_players pp
   SET score = NULL
 WHERE pp.score = 0
   AND EXISTS (SELECT 1 FROM public.boardgamebuddy_plays p
                WHERE p.id = pp.play_id
                  AND COALESCE(p.play_mode,'competitive') <> 'coop')
   AND NOT EXISTS (SELECT 1 FROM public.boardgamebuddy_play_players w
                    WHERE w.play_id = pp.play_id AND w.is_winner)
   AND NOT EXISTS (SELECT 1 FROM public.boardgamebuddy_play_players s
                    WHERE s.play_id = pp.play_id AND s.score IS DISTINCT FROM 0)
   AND (pp.round_scores IS NULL
        OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pp.round_scores) e
                        WHERE jsonb_typeof(e.value) <> 'null'));
