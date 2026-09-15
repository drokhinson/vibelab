-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Feed plays: restrict participants to viewer + buddies
--
-- Iterating on 024: the feed groups same-day plays by participant set, but
-- the user only wants buddy / self IDs to count toward the grouping key
-- and only buddy / self names to appear in the session header. Non-buddy
-- registered users and ghost-name rows are invisible at the section level.
--
-- Shape change: drop the two parallel arrays from 024
-- (player_user_ids UUID[], player_display_names TEXT[]) and replace them
-- with a single `participants jsonb` column carrying paired
-- {user_id, display_name} objects, sorted by display name, so the
-- frontend can map names to user_ids for click-through navigation.
--
-- The buddy filter reuses the existing `visible` CTE (viewer + accepted
-- buddies) — same set that already gates which plays the viewer sees,
-- now also gating which participant identities show up on each card.
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
  winners AS (
    SELECT
      pp.play_id,
      COALESCE(prof.display_name, pp.player_display_name) AS winner_name
    FROM public.boardgamebuddy_play_players pp
    LEFT JOIN public.boardgamebuddy_profiles prof ON prof.id = pp.player_user_id
    WHERE pp.is_winner = true
  ),
  participants AS (
    -- Aggregated player roster + count per play. The roster is filtered
    -- to the viewer's buddy circle (self + accepted buddies); ghosts and
    -- non-buddy registered users are excluded so the frontend session
    -- header reads "You and Sam played 3 games" without leaking anyone
    -- the viewer isn't connected to. `participant_count` stays unfiltered
    -- since the card front still wants the true player count.
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
            AND pp.player_user_id IN (SELECT uid FROM visible)
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
    COALESCE(part.participants, '[]'::jsonb)
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
