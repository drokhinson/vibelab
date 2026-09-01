-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Feed order by played_at desc, then created_at desc
-- The feed is a play journal, so the date the play actually happened is the
-- primary axis. Upload time is the tiebreaker for same-day plays.
--
-- Signature change requires DROP + CREATE; CREATE OR REPLACE can't swap
-- parameter lists. The single TIMESTAMPTZ cursor from migration 012 is
-- replaced with the (played_at, created_at) pair for tuple comparison.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.bgb_feed_plays(UUID, TIMESTAMPTZ, INT);

CREATE FUNCTION public.bgb_feed_plays(
  viewer            UUID,
  before_played_at  DATE        DEFAULT NULL,
  before_created_at TIMESTAMPTZ DEFAULT NULL,
  lim               INT         DEFAULT 20
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
  WHERE (
    before_played_at IS NULL
    OR before_created_at IS NULL
    OR (p.played_at, p.created_at) < (before_played_at, before_created_at)
  )
  ORDER BY p.played_at DESC, p.created_at DESC, p.id
  LIMIT lim;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_feed_plays(UUID, DATE, TIMESTAMPTZ, INT) TO boardgamebuddy_role;
