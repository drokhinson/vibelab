-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Feed plays now expose the full participant set
--
-- The feed groups same-day plays from the same buddy-set into a single
-- "session" card on the client (e.g. "You and Sam played 3 games"). To do
-- that, the FE needs the participants per play. Adding two aggregate
-- columns to bgb_feed_plays — driven by the same boardgamebuddy_play_players
-- table the existing `winners` / `counts` CTEs already join — keeps the
-- feed in a single round trip.
--
--   player_user_ids       UUID[]  — sorted, distinct, registered users only.
--                                   This is the canonical grouping key.
--   player_display_names  TEXT[]  — sorted, full participant roster
--                                   (registered users use their profile
--                                   display_name; ghost rows use the
--                                   free-text player_display_name).
--                                   Used for header rendering.
--
-- Signature change → DROP + CREATE (CREATE OR REPLACE can't widen the
-- RETURNS TABLE).
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.bgb_feed_plays(UUID, DATE, TIMESTAMPTZ, INT);

CREATE FUNCTION public.bgb_feed_plays(
  viewer            UUID,
  before_played_at  DATE        DEFAULT NULL,
  before_created_at TIMESTAMPTZ DEFAULT NULL,
  lim               INT         DEFAULT 20
)
RETURNS TABLE (
  play_id               UUID,
  play_user_id          UUID,
  play_user_name        TEXT,
  play_user_avatar      TEXT,
  game_id               UUID,
  game_name             TEXT,
  game_image_url        TEXT,
  game_thumbnail_url    TEXT,
  played_at             DATE,
  created_at            TIMESTAMPTZ,
  notes                 TEXT,
  photo_url             TEXT,
  play_mode             TEXT,
  winner_display_name   TEXT,
  participant_count     INT,
  player_user_ids       UUID[],
  player_display_names  TEXT[]
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
  participants AS (
    SELECT
      pp.play_id,
      -- Sorted, distinct, NULLs filtered — the grouping key on the client.
      -- Ghost players (no player_user_id) are excluded here so groups key
      -- only by registered identity. They still appear in
      -- player_display_names below so the header reads correctly.
      array_agg(DISTINCT pp.player_user_id ORDER BY pp.player_user_id)
        FILTER (WHERE pp.player_user_id IS NOT NULL) AS player_user_ids,
      -- Resolved roster (registered → profile.display_name, ghost →
      -- pp.player_display_name). Sorted so the array is stable for
      -- equality checks and renders deterministically.
      array_agg(
        COALESCE(prof.display_name, pp.player_display_name)
        ORDER BY COALESCE(prof.display_name, pp.player_display_name)
      ) FILTER (
        WHERE COALESCE(prof.display_name, pp.player_display_name) IS NOT NULL
      ) AS player_display_names,
      COUNT(*)::INT AS participant_count
    FROM public.boardgamebuddy_play_players pp
    LEFT JOIN public.boardgamebuddy_profiles prof ON prof.id = pp.player_user_id
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
    COALESCE(part.participant_count, 0),
    COALESCE(part.player_user_ids, ARRAY[]::UUID[]),
    COALESCE(part.player_display_names, ARRAY[]::TEXT[])
  FROM public.boardgamebuddy_plays p
  JOIN visible v          ON v.uid = p.user_id
  JOIN public.boardgamebuddy_profiles prof ON prof.id = p.user_id
  JOIN public.boardgamebuddy_games g       ON g.id = p.game_id
  LEFT JOIN participants part ON part.play_id = p.id
  WHERE (
    before_played_at IS NULL
    OR before_created_at IS NULL
    OR (p.played_at, p.created_at) < (before_played_at, before_created_at)
  )
  ORDER BY p.played_at DESC, p.created_at DESC, p.id
  LIMIT lim;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_feed_plays(UUID, DATE, TIMESTAMPTZ, INT) TO boardgamebuddy_role;
