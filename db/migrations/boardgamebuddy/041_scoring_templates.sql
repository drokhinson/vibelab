-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — named scoring rows + per-game scoring templates
--
-- Adds the ability to name each scoring row (instead of the generic "R{n}")
-- and to save a named row-set as a reusable, community-shared TEMPLATE tied to
-- a game (e.g. Isle of Cats' components). Templates are authored through the
-- existing reference-guide builder as a new chapter type, so the whole
-- browse / adopt (user_chapters) machinery is reused unchanged.
--
-- Storage model (deliberately minimal, back-compat safe):
--   * New chapter type `scoring_template` (a lookup ROW, not an enum — the
--     builder/display iterate chapter_types dynamically, so no code change is
--     needed for it to appear as a chip/pill).
--   * Row data rides in the EXISTING guide_chapters.content TEXT column as JSON
--     ({"rows":["Cats","Rare Treasures", …]}); layout='scoring_template' flags
--     the structured variant so renderers branch. The layout CHECK is widened
--     to admit it — _CHAPTER_SELECT and every chapter endpoint are unchanged
--     because content stays opaque to them.
--   * play_sessions / plays get a nullable scoring_template_id FK (ON DELETE
--     SET NULL so deleting a template never orphans history — labels fall back
--     to "R{n}"). plays also gets a round_labels JSONB snapshot of the names
--     actually used, so an edited/deleted template can't corrupt a logged play
--     and per-play ad-hoc renames are preserved.
--
-- Column additions inherit the existing table-level GRANT SELECT to
-- boardgamebuddy_role automatically; no new grants required. No Data-API grant
-- either — these columns are written only by the FastAPI backend
-- (play_session_scores still carries just round_index for the live path).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. New chapter type ──────────────────────────────────────────────────────
INSERT INTO public.boardgamebuddy_chapter_types (id, label, icon, display_order) VALUES
  ('scoring_template', 'Scoring Templates', 'table', 35)
ON CONFLICT (id) DO NOTHING;

-- ── 2. Allow the structured layout on guide chapters ─────────────────────────
-- The original CHECK was an inline single-column constraint on the table's
-- ORIGINAL name (boardgamebuddy_guide_chunks, baseline migration 034), so
-- Postgres auto-named it boardgamebuddy_guide_chunks_layout_check. The 018
-- table RENAME does NOT rename constraints, so that old name is still the live
-- one. Drop both candidate names defensively, then re-add under the current
-- table name.
ALTER TABLE public.boardgamebuddy_guide_chapters
  DROP CONSTRAINT IF EXISTS boardgamebuddy_guide_chunks_layout_check;
ALTER TABLE public.boardgamebuddy_guide_chapters
  DROP CONSTRAINT IF EXISTS boardgamebuddy_guide_chapters_layout_check;
ALTER TABLE public.boardgamebuddy_guide_chapters
  ADD CONSTRAINT boardgamebuddy_guide_chapters_layout_check
  CHECK (layout IN ('text', 'scoring_template'));

-- ── 3. Template reference + per-play label snapshot ──────────────────────────
ALTER TABLE public.boardgamebuddy_play_sessions
  ADD COLUMN IF NOT EXISTS scoring_template_id UUID
    REFERENCES public.boardgamebuddy_guide_chapters(id) ON DELETE SET NULL;

ALTER TABLE public.boardgamebuddy_plays
  ADD COLUMN IF NOT EXISTS scoring_template_id UUID
    REFERENCES public.boardgamebuddy_guide_chapters(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS round_labels JSONB;

COMMENT ON COLUMN public.boardgamebuddy_plays.round_labels IS
  'Per-play snapshot of the scoring-row names actually used, positional and '
  'parallel to play_players.round_scores. NULL for generic-round / legacy '
  'plays (renders "R{n}"). Authoritative for display; scoring_template_id is '
  'provenance/re-adopt only.';

-- ── 4. Surface scoring_template_id in the session bundle ─────────────────────
-- Single builder shared by get/create/join; adding the key here covers every
-- session read path (joiners resolve the row names from this id).
CREATE OR REPLACE FUNCTION public.bgb_session_bundle(p_session_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session JSONB;
  v_game_id UUID;
  v_participants JSONB;
  v_game JSONB;
BEGIN
  SELECT jsonb_build_object(
           'id', s.id,
           'code', s.code,
           'status', s.status,
           'phase', COALESCE(s.phase, 'gather'),
           'host_user_id', s.host_user_id,
           'game_id', s.game_id,
           'scoring_template_id', s.scoring_template_id,
           'created_at', s.created_at,
           'expires_at', s.expires_at,
           'finalized_play_id', s.finalized_play_id
         ),
         s.game_id
    INTO v_session, v_game_id
    FROM boardgamebuddy_play_sessions s
    WHERE s.id = p_session_id;

  IF v_session IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', pp.id,
           'user_id', pp.user_id,
           'display_name', pp.display_name,
           'joined_at', pp.joined_at,
           'avatar', pr.avatar
         ) ORDER BY pp.joined_at), '[]'::jsonb)
    INTO v_participants
    FROM boardgamebuddy_play_session_participants pp
    LEFT JOIN boardgamebuddy_profiles pr ON pr.id = pp.user_id
    WHERE pp.session_id = p_session_id;

  IF v_game_id IS NOT NULL THEN
    SELECT jsonb_build_object(
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
             'is_expansion', COALESCE(g.is_expansion, false),
             'base_game_bgg_id', g.base_game_bgg_id,
             'expansion_color', g.expansion_color,
             'rulebook_url', g.rulebook_url,
             'play_mode', COALESCE(g.play_mode, 'competitive')
           )
      INTO v_game
      FROM boardgamebuddy_games g
      WHERE g.id = v_game_id;
  END IF;

  RETURN v_session
      || jsonb_build_object('participants', v_participants, 'game', v_game);
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_session_bundle(UUID) TO boardgamebuddy_role;

-- ── 5. Surface scoring_template_id + round_labels in the plays page bundle ───
CREATE OR REPLACE FUNCTION public.bgb_plays_page(
  p_target UUID,
  p_page INT DEFAULT 1,
  p_per_page INT DEFAULT 20,
  p_game UUID DEFAULT NULL,
  p_buddy UUID DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_own_only BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_search TEXT := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_total BIGINT;
  v_plays JSONB;
BEGIN
  WITH filtered AS (
    SELECT p.*
    FROM boardgamebuddy_plays p
    WHERE (
        p.user_id = p_target
        OR (NOT p_own_only AND EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = p_target))
      )
      AND (p_own_only IS FALSE OR p.user_id = p_target)
      AND (p_game IS NULL OR p.game_id = p_game)
      AND (p_buddy IS NULL OR EXISTS (
            SELECT 1 FROM boardgamebuddy_play_players pp
            WHERE pp.play_id = p.id AND pp.player_user_id = p_buddy))
      AND (v_search IS NULL
           OR p.game_name ILIKE '%' || v_search || '%'
           OR EXISTS (
                SELECT 1 FROM boardgamebuddy_play_players pp
                WHERE pp.play_id = p.id
                  AND pp.player_display_name ILIKE '%' || v_search || '%'))
  ),
  counted AS (SELECT count(*) AS total FROM filtered),
  page AS (
    SELECT f.*
    FROM filtered f
    ORDER BY f.played_at DESC, f.created_at DESC
    LIMIT p_per_page OFFSET GREATEST(p_page - 1, 0) * p_per_page
  )
  SELECT
    (SELECT total FROM counted),
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', pg.id,
      'game_id', pg.game_id,
      'game_name', pg.game_name,
      'game_thumbnail', pg.game_thumbnail_url,
      'played_at', pg.played_at,
      'notes', pg.notes,
      'photo_url', pg.photo_url,
      'created_at', pg.created_at,
      'play_mode', COALESCE(pg.play_mode, 'competitive'),
      'scoring_template_id', pg.scoring_template_id,
      'round_labels', pg.round_labels,
      'logged_by_id', pg.user_id,
      'logged_by_name', COALESCE(lp.display_name, 'Unknown'),
      'is_own', (pg.user_id = p_target),
      'players', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'user_id', pp.player_user_id,
          'name', COALESCE(ppr.display_name, pp.player_display_name, 'Unknown'),
          'avatar', ppr.avatar,
          'is_winner', COALESCE(pp.is_winner, false),
          'score', pp.score,
          'round_scores', pp.round_scores
        ))
        FROM boardgamebuddy_play_players pp
        LEFT JOIN boardgamebuddy_profiles ppr ON ppr.id = pp.player_user_id
        WHERE pp.play_id = pg.id
      ), '[]'::jsonb),
      'expansions', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'expansion_game_id', pe.expansion_game_id,
          'name', COALESCE(eg.name, 'Unknown'),
          'color', eg.expansion_color
        ))
        FROM boardgamebuddy_play_expansions pe
        LEFT JOIN boardgamebuddy_games eg ON eg.id = pe.expansion_game_id
        WHERE pe.play_id = pg.id
      ), '[]'::jsonb)
    ) ORDER BY pg.played_at DESC, pg.created_at DESC), '[]'::jsonb)
    INTO v_total, v_plays
  FROM page pg
  LEFT JOIN boardgamebuddy_profiles lp ON lp.id = pg.user_id;

  RETURN jsonb_build_object('plays', v_plays, 'total', COALESCE(v_total, 0));
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_plays_page(UUID, INT, INT, UUID, UUID, TEXT, BOOLEAN) TO boardgamebuddy_role;

COMMIT;
