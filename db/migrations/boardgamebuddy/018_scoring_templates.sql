-- 018_scoring_templates.sql — a scoring grid is a chapter, and a play keeps a copy.
--
-- The scoring table has always been generic: rows are R1, R2, R3… and the host
-- taps "+ Round" for another. That is right for a trick-taking game and wrong
-- for a point-salad one. Everdell scores Cards / Prosperity / Events / Journey
-- / Basic Points; Arboretum scores one row per tree species, each with its own
-- colour on the physical scorepad. Today that means remembering which of R1-R7
-- was "Events" for every player, and then losing the meaning entirely once the
-- play lands in the feed.
--
-- A scoring grid is reference material about a game, which is exactly what the
-- reference guide already holds. So it is authored, shared, browsed and adopted
-- through the chapter machinery that exists.
--
-- WHY A LAYOUT AND NOT A 7TH CHAPTER TYPE. The scroll groups a user's guide by
-- chapter_type with one header per type, so a 7th type would split their
-- scoring material into two sections both called "scoring". And
-- services/chapter_ai.py keys its prompt on the type, so reusing 'scoring'
-- leaves the AI path untouched. `layout` was declared as an extension point
-- from the start (it has always been TEXT with a CHECK pinning it to one
-- value); this is that point being used.
--
-- WHY A TYPED `grid` COLUMN AND NOT JSON IN `content`. `content` is
-- ILIKE-searched by the chapter pool, so a JSON document there would make
-- "blue", "rows" and "label" match every grid ever written; it is sliced into
-- the moderation preview, so an admin triaging a report would read
-- `{"v":1,"rows":[{"label":"Basic Ca…`; and it is fed to renderMarkdown on
-- three surfaces. `content` instead keeps a GENERATED plain-text mirror of the
-- rows (one "- Label" bullet each, rewritten on every save, never hand-edited),
-- which fixes all three at once and leaves any not-yet-updated surface
-- rendering something sensible.
--
-- WHY NOT A ROWS TABLE. The rows are never queried independently — every read
-- and every write handles the whole document — and _CHAPTER_SELECT serves five
-- endpoints that would each grow a join. The project already stores leaf
-- documents as JSONB (profiles.avatar, play_players.round_scores).
--
-- WHY A PLAY SNAPSHOTS ITS TEMPLATE RATHER THAN REFERENCING IT. See the
-- COMMENT ON COLUMN below; it is the load-bearing decision in this migration.
--
-- NO NEW TABLES, so no new ENABLE ROW LEVEL SECURITY and no new GRANT SELECT:
-- the columns added below inherit the RLS and the grants their tables already
-- carry. That absence is deliberate, not an oversight.


-- ── Chapters: widen the layout vocabulary ────────────────────────────────────
-- The constraint keeps its chunks-era name (the tables were renamed in
-- archive/018 but the constraints were not) so db/schema/ diffs by one line.

ALTER TABLE public.boardgamebuddy_guide_chapters
  DROP CONSTRAINT IF EXISTS boardgamebuddy_guide_chunks_layout_check;

ALTER TABLE public.boardgamebuddy_guide_chapters
  ADD CONSTRAINT boardgamebuddy_guide_chunks_layout_check
  CHECK (layout = ANY (ARRAY['text'::text, 'scoring_grid'::text]));


-- ── Chapters: the typed body ─────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_guide_chapters
  ADD COLUMN IF NOT EXISTS grid JSONB;

COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.grid IS
  'Row definitions for a layout=''scoring_grid'' chapter: {"v":1,"rows":[{"label":…,"color":…,"note":…}]}. '
  '`color` is a SLUG from a fixed palette (neutral|gold|green|blue|rust|purple), never a hex — the grid '
  'lands on the cream scorepad, and only a fixed palette can be guaranteed legible there in both themes. '
  'NULL for layout=''text''; see the bgb_chapters_grid_shape constraint.';

-- Layout and body move together or not at all. The 24-row ceiling is not
-- arbitrary: boardgamebuddy_play_session_scores.round_index is CHECK'd 0..63,
-- and template rows occupy the low indexes, so 24 leaves 40 rounds of headroom
-- for the extras a scorer appends before a live-scores write starts failing
-- (and those writes are all fire-and-forget, so it would fail SILENTLY).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bgb_chapters_grid_shape'
  ) THEN
    ALTER TABLE public.boardgamebuddy_guide_chapters
      ADD CONSTRAINT bgb_chapters_grid_shape CHECK (
        (layout = 'text' AND grid IS NULL)
        OR (
          layout = 'scoring_grid'
          AND jsonb_typeof(grid -> 'rows') = 'array'
          AND jsonb_array_length(grid -> 'rows') BETWEEN 1 AND 24
        )
      );
  END IF;
END $$;

-- Drives the "this game has templates you haven't added" notice. Partial
-- because grid chapters are a small minority of the table.
CREATE INDEX IF NOT EXISTS idx_bgb_chapters_scoring_grid
  ON public.boardgamebuddy_guide_chapters (game_id)
  WHERE layout = 'scoring_grid';


-- ── Plays: the snapshot ──────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_plays
  ADD COLUMN IF NOT EXISTS scoring_template JSONB;

COMMENT ON COLUMN public.boardgamebuddy_plays.scoring_template IS
  'Denormalised snapshot of the scoring-grid chapter this play was scored with: '
  '{"v":1,"chapter_id":…,"title":…,"rows":[…]}. NOT a foreign key, on purpose. '
  'The chapter is community-owned, editable by its author and deletable by author or admin, so a play '
  'holding only an id would render bare R1..Rn the moment a moderator cleared the chapter, and would '
  'silently RELABEL a two-year-old play if the author reordered its rows — labels that stop describing '
  'the numbers under them is precisely the failure widgets/round-score-grid.js is written to prevent. '
  'ON DELETE SET NULL loses the labels and CASCADE deletes plays, so neither constraint tells the truth. '
  'chapter_id rides INSIDE the document as provenance: a bare uuid column would imply an integrity the '
  'database is not enforcing. Same reasoning as game_name / game_thumbnail_url on this table.';


-- ── Sessions: the live mirror ────────────────────────────────────────────────
-- Spectators size their grid from the live-scores round indexes and have no
-- local draft, so the labels have to reach them through the session row.

ALTER TABLE public.boardgamebuddy_play_sessions
  ADD COLUMN IF NOT EXISTS scoring_template JSONB;

COMMENT ON COLUMN public.boardgamebuddy_play_sessions.scoring_template IS
  'The template the host applied to this live grid, same shape as '
  'boardgamebuddy_plays.scoring_template. Copied onto the play at finalize.';


-- ── RPCs ─────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE needs the whole body, so each of these is its predecessor
-- copied forward with the scoring_template lines added. Sources are named above
-- each one.
--
-- bgb_feed_plays is deliberately NOT here. It is a ~270-line RETURNS TABLE
-- function whose new OUT column would force a DROP + full re-CREATE, and the
-- only thing it buys is removing a one-frame R1 -> label swap when the
-- play-detail popup opens from a feed card (the popup revalidates through
-- GET /plays/{id}, which reads the column directly). Its own commit, later.

-- bgb_log_play
--   from 007_play_import_batches.sql, + scoring_template on the insert and the
--   returned envelope. This covers BOTH write paths: bgb_finalize_session calls
--   bgb_log_play with the same payload shape.
CREATE OR REPLACE FUNCTION public.bgb_log_play(p_user uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_game        RECORD;
  v_mode        TEXT;
  v_play        RECORD;
  v_logged_name TEXT;
  v_players     JSONB;
  v_expansions  JSONB;
  v_client_key  UUID;
  v_existing    UUID;
  v_country     TEXT;
  v_group       UUID;
  v_batch       UUID;
  v_template    JSONB;
BEGIN
  -- Empty string and absent both mean "no key" — the client omits the field
  -- entirely for live writes, but a serializer that emits "" must not be read
  -- as a key shared by every unkeyed play.
  v_client_key := NULLIF(p_payload->>'client_key', '')::UUID;

  -- Migration 005. Set only by the Settings play importer, and only on plays
  -- it judged identical to at least one other in the same import: same game,
  -- same date, same players, same winner, and no score or note on either. The
  -- feed and the plays log show one card per group; every counter still sees
  -- the individual rows, which is the whole reason this is a tag rather than
  -- a row multiplier.
  v_group := NULLIF(p_payload->>'import_group_id', '')::UUID;

  -- Migration 007. One id per IMPORT, where the group above is one per RUN.
  -- Both are set only by the importer; a live log has neither, and neither is
  -- read by anything that counts plays.
  v_batch := NULLIF(p_payload->>'import_batch_id', '')::UUID;

  -- Migration 018. The scoring grid this play was scored on, snapshotted.
  -- jsonb 'null' and absent both mean "no template": the client sends an
  -- explicit null for a play scored on the plain R1..Rn grid.
  v_template := NULLIF(p_payload->'scoring_template', 'null'::jsonb);

  IF v_client_key IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.client_key = v_client_key;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- Migration 060. Unresolvable / malformed becomes NULL — "we don't know
  -- where this was played" is a legitimate row and a rejected save is not.
  v_country := upper(NULLIF(btrim(COALESCE(p_payload->>'country_code', '')), ''));
  IF v_country IS NOT NULL AND v_country !~ '^[A-Z]{2}$' THEN
    v_country := NULL;
  END IF;

  SELECT g.id, g.name, g.thumbnail_url, g.play_mode
    INTO v_game
    FROM boardgamebuddy_games g
   WHERE g.id = (p_payload->>'game_id')::UUID;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'game_not_found');
  END IF;

  -- Explicit override wins; otherwise inherit the game's intrinsic mode.
  v_mode := COALESCE(
    NULLIF(p_payload->>'play_mode', ''),
    v_game.play_mode,
    'competitive'
  );

  BEGIN
    INSERT INTO boardgamebuddy_plays (
      user_id, game_id, played_at, notes, photo_url, play_mode,
      game_name, game_thumbnail_url, client_key, country_code,
      import_group_id, import_batch_id, imported_at, scoring_template
    )
    VALUES (
      p_user,
      v_game.id,
      (p_payload->>'played_at')::DATE,
      p_payload->>'notes',
      p_payload->>'photo_url',
      v_mode,
      v_game.name,
      v_game.thumbnail_url,
      v_client_key,
      v_country,
      v_group,
      v_batch,
      -- Stamped server-side, and only for an import: a client clock is the one
      -- thing here nobody should have to trust, and the Settings list orders by
      -- this value.
      CASE WHEN v_batch IS NULL THEN NULL ELSE now() END,
      v_template
    )
    RETURNING id, created_at INTO v_play;
  EXCEPTION WHEN unique_violation THEN
    -- Lost the race against a concurrent flush of the same queued play. The
    -- winner's row is the canonical one; hand its id back on the same
    -- duplicate envelope the pre-check uses.
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.client_key = v_client_key;
    RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
  END;

  INSERT INTO boardgamebuddy_play_players (
    play_id, player_user_id, player_display_name, is_winner, score, round_scores
  )
  SELECT
    v_play.id,
    pl.user_id,
    pl.name,
    COALESCE(pl.is_winner, false),
    pl.score,
    pl.round_scores
  FROM jsonb_to_recordset(COALESCE(p_payload->'players', '[]'::JSONB))
         AS pl(name TEXT, is_winner BOOLEAN, score INTEGER,
               user_id UUID, round_scores JSONB);

  -- DISTINCT guards the (play_id, expansion_game_id) primary key against a
  -- payload that repeats an id.
  INSERT INTO boardgamebuddy_play_expansions (play_id, expansion_game_id)
  SELECT DISTINCT v_play.id, eid::UUID
    FROM jsonb_array_elements_text(
           COALESCE(p_payload->'expansion_ids', '[]'::JSONB)
         ) AS eid
   WHERE COALESCE(eid, '') <> '';

  SELECT pr.display_name INTO v_logged_name
    FROM boardgamebuddy_profiles pr
   WHERE pr.id = p_user;

  -- Response blocks are built from the payload (plus the profile/game joins
  -- they need), not by reading the rows back — the values are identical and
  -- WITH ORDINALITY keeps the player list in the order the host entered it,
  -- which a RETURNING or a re-SELECT wouldn't guarantee.
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'user_id',      pl.user_id,
             'name',         COALESCE(prof.display_name, pl.name, 'Unknown'),
             'avatar',       prof.avatar,
             'is_winner',    COALESCE(pl.is_winner, false),
             'score',        pl.score,
             'round_scores', pl.round_scores
           ) ORDER BY pl.ord
         ), '[]'::JSONB)
    INTO v_players
    FROM ROWS FROM (
           jsonb_to_recordset(COALESCE(p_payload->'players', '[]'::JSONB))
             AS (name TEXT, is_winner BOOLEAN, score INTEGER,
                 user_id UUID, round_scores JSONB)
         ) WITH ORDINALITY AS pl(name, is_winner, score, user_id, round_scores, ord)
    LEFT JOIN boardgamebuddy_profiles prof ON prof.id = pl.user_id;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'expansion_game_id', eg.id,
             'name',              eg.name,
             'color',             eg.expansion_color
           ) ORDER BY eg.name
         ), '[]'::JSONB)
    INTO v_expansions
    FROM (
      SELECT DISTINCT eid::UUID AS id
        FROM jsonb_array_elements_text(
               COALESCE(p_payload->'expansion_ids', '[]'::JSONB)
             ) AS eid
       WHERE COALESCE(eid, '') <> ''
    ) picked
    JOIN boardgamebuddy_games eg ON eg.id = picked.id;

  -- country_code is echoed from the NORMALIZED local, not from the payload:
  -- the client has to see the value that actually landed, or a "gb" it sent
  -- would read back as "gb" while the row holds "GB". scoring_template is
  -- echoed from its local for the same reason (an absent key vs. an explicit
  -- null must read back identically).
  RETURN jsonb_build_object(
    'id',               v_play.id,
    'game_id',          v_game.id,
    'game_name',        v_game.name,
    'game_thumbnail',   v_game.thumbnail_url,
    'played_at',        (p_payload->>'played_at')::DATE,
    'notes',            p_payload->>'notes',
    'players',          v_players,
    'photo_url',        p_payload->>'photo_url',
    'expansions',       v_expansions,
    'created_at',       v_play.created_at,
    'play_mode',        v_mode,
    'country_code',     v_country,
    'scoring_template', v_template,
    'group_count',      1,
    'logged_by_id',     p_user,
    'logged_by_name',   COALESCE(v_logged_name, ''),
    'is_own',           true
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_log_play(p_user uuid, p_payload jsonb) TO boardgamebuddy_role;


-- bgb_session_bundle
--   from 003_rpcs.sql, + scoring_template on the session block so the
--   spectator's read-only mirror can label its rows.
CREATE OR REPLACE FUNCTION public.bgb_session_bundle(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session JSONB;
  v_game_id UUID;
  v_phase TEXT;
  v_participants JSONB;
  v_scores JSONB := '[]'::jsonb;
BEGIN
  SELECT jsonb_build_object(
           'id', s.id,
           'code', s.code,
           'status', s.status,
           'phase', COALESCE(s.phase, 'gather'),
           'host_user_id', s.host_user_id,
           'game_id', s.game_id,
           'created_at', s.created_at,
           'expires_at', s.expires_at,
           'finalized_play_id', s.finalized_play_id,
           'scoring_template', s.scoring_template
         ),
         s.game_id,
         COALESCE(s.phase, 'gather')
    INTO v_session, v_game_id, v_phase
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
         ) ORDER BY pp.position NULLS LAST, pp.joined_at), '[]'::jsonb)
    INTO v_participants
    FROM boardgamebuddy_play_session_participants pp
    LEFT JOIN boardgamebuddy_profiles pr ON pr.id = pp.user_id
    WHERE pp.session_id = p_session_id;

  IF v_phase = 'play' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'participant_id', sc.participant_id,
             'round_index', sc.round_index,
             'score', sc.score
           ) ORDER BY sc.round_index), '[]'::jsonb)
      INTO v_scores
      FROM boardgamebuddy_play_session_scores sc
      WHERE sc.session_id = p_session_id;
  END IF;

  RETURN v_session || jsonb_build_object(
    'participants', v_participants,
    'game', bgb_game_summary(v_game_id),
    'scores', v_scores
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_session_bundle(p_session_id uuid) TO boardgamebuddy_role;


-- bgb_set_session_scoring
--   New in 018. Host-only, through the same bgb_session_gate every other
--   session write uses. p_template NULL (or jsonb 'null') clears the template,
--   which is what "stop using this grid" sends; clearing is non-destructive —
--   the rows and their scores stay, only the labels go.
CREATE OR REPLACE FUNCTION public.bgb_set_session_scoring(p_host uuid, p_code text, p_template jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate JSONB;
  v_session UUID;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, FALSE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  UPDATE boardgamebuddy_play_sessions
     SET scoring_template = NULLIF(p_template, 'null'::jsonb)
   WHERE id = v_session;

  RETURN bgb_session_bundle(v_session);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_set_session_scoring(p_host uuid, p_code text, p_template jsonb) TO boardgamebuddy_role;


-- bgb_plays_page
--   from 005_play_import_groups.sql, + scoring_template on each card so the
--   plays log seeds the play-detail popup with its labels already in place.
CREATE OR REPLACE FUNCTION public.bgb_plays_page(p_target uuid, p_page integer DEFAULT 1, p_per_page integer DEFAULT 20, p_game uuid DEFAULT NULL::uuid, p_buddy uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_own_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- Migration 005. One row per imported run, same representative rule as
      -- bgb_feed_plays. It sits in `filtered` rather than in `page` so
      -- `counted` totals CARDS — a pager reading 106 over a six-row list would
      -- send the reader to five empty pages.
      AND (
        p.import_group_id IS NULL
        OR p.id = (SELECT q.id
                     FROM boardgamebuddy_plays q
                    WHERE q.import_group_id = p.import_group_id
                    ORDER BY q.id
                    LIMIT 1)
      )
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
      'country_code', pg.country_code,
      'scoring_template', pg.scoring_template,
      'group_count', CASE WHEN pg.import_group_id IS NULL THEN 1
                          ELSE (SELECT COUNT(*)::INT
                                  FROM boardgamebuddy_plays q
                                 WHERE q.import_group_id = pg.import_group_id)
                     END,
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
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_plays_page(p_target uuid, p_page integer, p_per_page integer, p_game uuid, p_buddy uuid, p_search text, p_own_only boolean) TO boardgamebuddy_role;
