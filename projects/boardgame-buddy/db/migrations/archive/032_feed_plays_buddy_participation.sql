-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Feed plays: surface plays any buddy (or self) attended
--
-- Iterating on 031: previously the feed surfaced a play only when its
-- top-level logger (boardgamebuddy_plays.user_id) was in the viewer's
-- visibility set (self + accepted buddies), with an extra branch for
-- "viewer was tagged as a participant." That missed the case where a
-- buddy was at a game logged by someone the viewer doesn't follow — the
-- buddy clearly played, but the play never appeared in the viewer's feed.
--
-- New rule, as requested: a play is visible iff at least one of its
-- play_players rows references the viewer OR an accepted buddy of the
-- viewer. The legacy "logger in visible" branch is kept as a safety net
-- in case a historical play row exists where the logger isn't in
-- play_players.
--
-- Roster filter is unchanged from 031: real-account participants who are
-- buddies / self are always shown; non-buddy participants are shown only
-- on plays the viewer was personally at (they were there, they're allowed
-- to know who else was at the table).
--
-- Index used: idx_bgb_play_players_user_play (migration 019) makes
-- "find plays a given user appeared in" index-only for each member of
-- the visible set.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.bgb_feed_plays(UUID, DATE, TIMESTAMPTZ, INT);

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
  play_user_avatar     JSONB,
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
  participant_count    INT,
  participants         JSONB
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
  -- Plays the viewer themselves attended — used to widen the roster
  -- filter so non-buddy participants are exposed on cards for plays
  -- the viewer was at.
  viewer_was_at AS (
    SELECT DISTINCT pp.play_id
    FROM public.boardgamebuddy_play_players pp
    WHERE pp.player_user_id = viewer
  ),
  -- Plays where at least one visible user (viewer or any accepted buddy)
  -- appears in play_players. This is the new "main" visibility branch.
  attended AS (
    SELECT DISTINCT pp.play_id
    FROM public.boardgamebuddy_play_players pp
    WHERE pp.player_user_id IN (SELECT uid FROM visible)
  ),
  -- Final candidate set: legacy "logger ∈ visible" UNION attended. The
  -- legacy branch is technically subsumed by `attended` when the logger
  -- is always tagged as a participant (the standard log_play flow does
  -- this), but we keep it as a belt-and-suspenders cover for any
  -- historical rows where it isn't.
  visible_plays AS (
    SELECT p.id
    FROM public.boardgamebuddy_plays p
    JOIN visible v ON v.uid = p.user_id
    UNION
    SELECT play_id FROM attended
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
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'user_id',      pp.player_user_id::text,
            'display_name', COALESCE(prof.display_name, pp.player_display_name)
          )
          ORDER BY COALESCE(prof.display_name, pp.player_display_name)
        ) FILTER (
          WHERE pp.player_user_id IS NOT NULL
            AND (
              pp.player_user_id IN (SELECT uid FROM visible)
              OR pp.play_id IN (SELECT play_id FROM viewer_was_at)
            )
        ),
        '[]'::jsonb
      ) AS participants,
      COUNT(*)::INT AS participant_count
    FROM public.boardgamebuddy_play_players pp
    LEFT JOIN public.boardgamebuddy_profiles prof ON prof.id = pp.player_user_id
    GROUP BY pp.play_id
  )
  SELECT
    p.id,
    p.user_id,
    prof.display_name,
    prof.avatar,
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
    COALESCE(part.participants, '[]'::jsonb)
  FROM public.boardgamebuddy_plays p
  JOIN visible_plays vp                    ON vp.id = p.id
  JOIN public.boardgamebuddy_profiles prof ON prof.id = p.user_id
  JOIN public.boardgamebuddy_games g       ON g.id = p.game_id
  LEFT JOIN participants part              ON part.play_id = p.id
  WHERE (
    before_played_at IS NULL
    OR before_created_at IS NULL
    OR (p.played_at, p.created_at) < (before_played_at, before_created_at)
  )
  ORDER BY p.played_at DESC, p.created_at DESC, p.id
  LIMIT lim;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_feed_plays(UUID, DATE, TIMESTAMPTZ, INT) TO boardgamebuddy_role;
