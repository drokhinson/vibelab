-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Feed, stats, suggestions RPCs
-- All RPCs SECURITY DEFINER + SET search_path = public. They take the viewer's
-- user_id as an explicit argument; auth/authorization is enforced by the
-- backend service layer (the API uses the service role key which bypasses RLS).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── bgb_hot_games ────────────────────────────────────────────────────────────
-- Top-N most-played games in the last `window_days` across all users. Used by
-- the Feed's "Hot Games" card.
CREATE OR REPLACE FUNCTION public.bgb_hot_games(window_days INT DEFAULT 7, lim INT DEFAULT 10)
RETURNS TABLE (
  game_id    UUID,
  play_count BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.game_id, COUNT(*)::BIGINT AS play_count
  FROM public.boardgamebuddy_plays p
  WHERE p.played_at >= (CURRENT_DATE - (window_days || ' days')::INTERVAL)
  GROUP BY p.game_id
  ORDER BY play_count DESC, p.game_id
  LIMIT lim;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_hot_games(INT, INT) TO boardgamebuddy_role;


-- ── bgb_user_stats ───────────────────────────────────────────────────────────
-- Per-user Strava-style stats card. Hours is approximated from
-- game.playing_time (minutes); falls back to 0 when unknown.
CREATE OR REPLACE FUNCTION public.bgb_user_stats(uid UUID)
RETURNS TABLE (
  total_plays    BIGINT,
  unique_games   BIGINT,
  win_count      BIGINT,
  last_played_at DATE,
  hours_played   NUMERIC
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
  )
  SELECT
    COUNT(*)::BIGINT                                                              AS total_plays,
    COUNT(DISTINCT mp.game_id)::BIGINT                                            AS unique_games,
    (SELECT COUNT(*)::BIGINT
       FROM public.boardgamebuddy_play_players pp
       WHERE pp.player_user_id = uid AND pp.is_winner = true)                     AS win_count,
    MAX(mp.played_at)                                                             AS last_played_at,
    COALESCE(SUM(g.playing_time), 0)::NUMERIC / 60.0                              AS hours_played
  FROM my_plays mp
  LEFT JOIN public.boardgamebuddy_games g ON g.id = mp.game_id;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_user_stats(UUID) TO boardgamebuddy_role;


-- ── bgb_feed_plays ───────────────────────────────────────────────────────────
-- Returns plays visible to `viewer` (own + accepted-buddy plays), pre-joined
-- with game name/image and the winner's display name. Used by the Feed view's
-- main timeline. Cursor pagination via `before` timestamp.
CREATE OR REPLACE FUNCTION public.bgb_feed_plays(
  viewer  UUID,
  before  TIMESTAMPTZ DEFAULT NULL,
  lim     INT DEFAULT 20
)
RETURNS TABLE (
  play_id              UUID,
  play_user_id         UUID,
  play_user_name       TEXT,
  play_user_avatar     TEXT,
  game_id              UUID,
  game_name            TEXT,
  game_image_url       TEXT,
  game_thumbnail_url   TEXT,
  played_at            DATE,
  created_at           TIMESTAMPTZ,
  notes                TEXT,
  photo_url            TEXT,
  play_mode            TEXT,
  winner_display_name  TEXT,
  participant_count    INT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH visible AS (
    SELECT viewer AS uid
    UNION
    SELECT CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END AS uid
    FROM public.boardgamebuddy_buddy_edges be
    WHERE be.status = 'accepted'
      AND viewer IN (be.user_a, be.user_b)
  ),
  winners AS (
    SELECT
      pp.play_id,
      COALESCE(prof.display_name, pp.player_display_name) AS winner_name
    FROM public.boardgamebuddy_play_players pp
    LEFT JOIN public.boardgamebuddy_profiles prof ON prof.id = pp.player_user_id
    WHERE pp.is_winner = true
  ),
  counts AS (
    SELECT pp.play_id, COUNT(*)::INT AS participant_count
    FROM public.boardgamebuddy_play_players pp
    GROUP BY pp.play_id
  )
  SELECT
    p.id,
    p.user_id,
    prof.display_name,
    prof.avatar_url,
    g.id,
    g.name,
    g.image_url,
    g.thumbnail_url,
    p.played_at,
    p.created_at,
    p.notes,
    p.photo_url,
    p.play_mode,
    (SELECT string_agg(w.winner_name, ', ' ORDER BY w.winner_name)
       FROM winners w WHERE w.play_id = p.id),
    COALESCE(c.participant_count, 0)
  FROM public.boardgamebuddy_plays p
  JOIN visible v          ON v.uid = p.user_id
  JOIN public.boardgamebuddy_profiles prof ON prof.id = p.user_id
  JOIN public.boardgamebuddy_games g       ON g.id = p.game_id
  LEFT JOIN counts c      ON c.play_id = p.id
  WHERE (before IS NULL OR p.created_at < before)
  ORDER BY p.created_at DESC, p.id
  LIMIT lim;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_feed_plays(UUID, TIMESTAMPTZ, INT) TO boardgamebuddy_role;


-- ── bgb_dormant_collection ───────────────────────────────────────────────────
-- "Featured from your collection" card: owned games this user hasn't logged
-- in N days. Used to nudge dusty shelves.
CREATE OR REPLACE FUNCTION public.bgb_dormant_collection(
  uid         UUID,
  days_since  INT DEFAULT 60,
  lim         INT DEFAULT 5
)
RETURNS TABLE (
  game_id        UUID,
  last_played_at DATE
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.game_id,
    MAX(p.played_at) AS last_played_at
  FROM public.boardgamebuddy_collections c
  LEFT JOIN public.boardgamebuddy_plays p
    ON p.game_id = c.game_id AND p.user_id = uid
  WHERE c.user_id = uid
    AND c.status = 'owned'
  GROUP BY c.game_id
  HAVING MAX(p.played_at) IS NULL
      OR MAX(p.played_at) < (CURRENT_DATE - (days_since || ' days')::INTERVAL)
  ORDER BY last_played_at NULLS FIRST, c.game_id
  LIMIT lim;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_dormant_collection(UUID, INT, INT) TO boardgamebuddy_role;


-- ── bgb_suggested_buddies ────────────────────────────────────────────────────
-- Friends-of-friends-style suggestion: users who share at least one accepted
-- buddy with `uid` but aren't yet connected to them. Excludes self.
CREATE OR REPLACE FUNCTION public.bgb_suggested_buddies(uid UUID, lim INT DEFAULT 10)
RETURNS TABLE (
  user_id        UUID,
  mutual_count   BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH my_buddies AS (
    SELECT CASE WHEN be.user_a = uid THEN be.user_b ELSE be.user_a END AS friend_id
    FROM public.boardgamebuddy_buddy_edges be
    WHERE be.status = 'accepted'
      AND uid IN (be.user_a, be.user_b)
  ),
  fof AS (
    SELECT
      CASE WHEN be.user_a = mb.friend_id THEN be.user_b ELSE be.user_a END AS candidate,
      mb.friend_id
    FROM my_buddies mb
    JOIN public.boardgamebuddy_buddy_edges be
      ON be.status = 'accepted'
     AND mb.friend_id IN (be.user_a, be.user_b)
  )
  SELECT fof.candidate, COUNT(DISTINCT fof.friend_id)::BIGINT AS mutual_count
  FROM fof
  WHERE fof.candidate <> uid
    AND fof.candidate NOT IN (SELECT friend_id FROM my_buddies)
  GROUP BY fof.candidate
  ORDER BY mutual_count DESC, fof.candidate
  LIMIT lim;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_suggested_buddies(UUID, INT) TO boardgamebuddy_role;
