-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Profile stats redesign (Played Games, Owned, Wins, Favorite)
--
-- Replace bgb_user_stats with a wider return so the Profile view can show:
--   - total_plays         (count of play events)
--   - unique_games        ("Played Games" — distinct game_ids in plays)
--   - owned_games         (NEW — count of owned collection rows, EXCLUDING
--                          expansions; the base-game count the user thinks of)
--   - owned_expansions    (NEW — count of owned collection rows that ARE
--                          expansions; surfaced separately on the Profile)
--   - win_count           (existing)
--   - favorite_game       (NEW — most-played game id+name+count)
-- The hours_played / last_played_at fields stay so the older StatsResponse
-- shape keeps working.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.bgb_user_stats(UUID);

CREATE FUNCTION public.bgb_user_stats(uid UUID)
RETURNS TABLE (
  total_plays          BIGINT,
  unique_games         BIGINT,
  win_count            BIGINT,
  last_played_at       DATE,
  hours_played         NUMERIC,
  owned_games          BIGINT,
  owned_expansions     BIGINT,
  favorite_game_id     UUID,
  favorite_game_name   TEXT,
  favorite_play_count  BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH my_plays AS (
    SELECT p.id, p.game_id, p.played_at
    FROM public.boardgamebuddy_plays p
    WHERE p.user_id = uid
    UNION
    SELECT p.id, p.game_id, p.played_at
    FROM public.boardgamebuddy_plays p
    JOIN public.boardgamebuddy_play_players pp ON pp.play_id = p.id
    WHERE pp.player_user_id = uid
  ),
  game_counts AS (
    SELECT game_id, COUNT(*)::BIGINT AS n
    FROM my_plays
    GROUP BY game_id
  ),
  favorite AS (
    SELECT gc.game_id, gc.n, g.name
    FROM game_counts gc
    LEFT JOIN public.boardgamebuddy_games g ON g.id = gc.game_id
    ORDER BY gc.n DESC, g.name
    LIMIT 1
  )
  SELECT
    (SELECT COUNT(*)::BIGINT FROM my_plays)                                      AS total_plays,
    (SELECT COUNT(DISTINCT game_id)::BIGINT FROM my_plays)                       AS unique_games,
    (SELECT COUNT(*)::BIGINT
       FROM public.boardgamebuddy_play_players pp
       WHERE pp.player_user_id = uid AND pp.is_winner = true)                    AS win_count,
    (SELECT MAX(played_at) FROM my_plays)                                        AS last_played_at,
    COALESCE(
      (SELECT SUM(g.playing_time)::NUMERIC / 60.0
         FROM my_plays mp
         LEFT JOIN public.boardgamebuddy_games g ON g.id = mp.game_id),
      0
    )                                                                            AS hours_played,
    -- Owned BASE games only — what the user thinks of as "my games".
    (SELECT COUNT(*)::BIGINT
       FROM public.boardgamebuddy_collections c
       JOIN public.boardgamebuddy_games g ON g.id = c.game_id
       WHERE c.user_id = uid
         AND c.status = 'owned'
         AND COALESCE(g.is_expansion, false) = false)                            AS owned_games,
    -- Owned expansions — surfaced as a secondary counter on the Profile.
    (SELECT COUNT(*)::BIGINT
       FROM public.boardgamebuddy_collections c
       JOIN public.boardgamebuddy_games g ON g.id = c.game_id
       WHERE c.user_id = uid
         AND c.status = 'owned'
         AND g.is_expansion = true)                                              AS owned_expansions,
    (SELECT game_id FROM favorite)                                               AS favorite_game_id,
    (SELECT name     FROM favorite)                                              AS favorite_game_name,
    (SELECT n        FROM favorite)                                              AS favorite_play_count;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_user_stats(UUID) TO boardgamebuddy_role;
