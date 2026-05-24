-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Feed plays: include plays where the viewer was tagged
--
-- Iterating on 025/029: previously the feed showed only plays whose
-- top-level logger (`boardgamebuddy_plays.user_id`) was the viewer or one of
-- their accepted buddies. That meant a play where the viewer was a
-- participant — but the host was not yet a buddy — never surfaced, even
-- though the viewer was clearly at the game.
--
-- This recreate expands the visibility set so a play is shown when:
--   1. the viewer is the logger (already covered),
--   2. the logger is an accepted buddy of the viewer (already covered), OR
--   3. the viewer appears in boardgamebuddy_play_players for that play (new).
--
-- The participant roster filter is also widened: when the viewer was at a
-- play, show every real-account participant on the card (not only buddies).
-- They were there — they're allowed to see who else was at the table. For
-- plays the viewer wasn't part of (a buddy logged it), the buddies-only
-- roster filter from 025 is preserved.
--
-- The (player_user_id, play_id) index added in migration 019 — comment
-- explicitly states "find plays I appeared in is index-only" — makes the
-- new branch cheap.
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
  -- Plays the viewer was tagged in as a participant. Used both to expand
  -- the visibility set AND to widen the displayed roster for those plays.
  viewer_was_at AS (
    SELECT DISTINCT pp.play_id
    FROM public.boardgamebuddy_play_players pp
    WHERE pp.player_user_id = viewer
  ),
  -- Final set of play IDs the viewer should see in their feed.
  visible_plays AS (
    SELECT p.id
    FROM public.boardgamebuddy_plays p
    JOIN visible v ON v.uid = p.user_id
    UNION
    SELECT vwa.play_id
    FROM viewer_was_at vwa
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
    -- Aggregated player roster + count per play. The roster shows every
    -- real-account participant when the viewer was at this play (since they
    -- were there); otherwise it's restricted to viewer + accepted buddies so
    -- the buddy logger's other guests stay private. `participant_count`
    -- stays unfiltered.
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
