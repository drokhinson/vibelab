-- 044_cleanup.sql — drop database objects with no reader anywhere in the
-- backend, the web app, the native app, or another SQL function.
--
-- Scope note: this migration removes only objects that are read by NOTHING.
-- Several write-only columns were deliberately LEFT IN PLACE because they hold
-- captured user data or diagnostics rather than dead code — see the comment at
-- the bottom of this file.
--
-- Everything here is guarded with IF EXISTS so the migration is replayable.

BEGIN;

-- ── 1. Legacy table ──────────────────────────────────────────────────────────
-- boardgamebuddy_guides is the flat guide table from the original prototype,
-- superseded by guide_chapters / user_chapters in migration 018. Its own
-- comment in 001_baseline.sql promised a follow-up drop 43 migrations ago.
-- Zero references in any .py, .js or SQL function body.
DROP INDEX IF EXISTS public.idx_bgb_guides_game;
DROP TABLE IF EXISTS public.boardgamebuddy_guides;


-- ── 2. Columns with no writer AND no reader ──────────────────────────────────
-- Never referenced outside their own DDL.
ALTER TABLE public.boardgamebuddy_user_chapters   DROP COLUMN IF EXISTS display_order;
ALTER TABLE public.boardgamebuddy_user_expansions DROP COLUMN IF EXISTS enabled_at;
-- The two live-score writers (web/domain/live-scores.js, app realtime/liveScores.js)
-- upsert only (session_id, player_user_id, round_index, score), so on an update
-- this went stale — and both readers select the same four columns, never this one.
ALTER TABLE public.boardgamebuddy_play_session_scores DROP COLUMN IF EXISTS updated_at;


-- ── 3. Denormalized play columns nothing reads ───────────────────────────────
-- Migration 020 cached four game_* columns on each play row to avoid a JOIN.
-- game_name and game_thumbnail_url are read (bgb_plays_page, bgb_feed_plays'
-- search filter). game_image_url and game_play_mode never were: every SQL
-- reference to game_image_url is bgb_feed_plays' OUTPUT column, fed from the
-- boardgamebuddy_games JOIN, and every game_play_mode read is c.game_play_mode
-- on collections. Both were pure write amplification on every play insert.
ALTER TABLE public.boardgamebuddy_plays DROP COLUMN IF EXISTS game_image_url;
ALTER TABLE public.boardgamebuddy_plays DROP COLUMN IF EXISTS game_play_mode;


-- ── 4. Redundant indexes ─────────────────────────────────────────────────────
-- Duplicates of a constraint that already indexes the same leading columns.
DROP INDEX IF EXISTS public.idx_bgb_games_bgg_id;             -- games.bgg_id is already UNIQUE (001)
DROP INDEX IF EXISTS public.idx_bgb_play_expansions_play;     -- PK (play_id, expansion_game_id) leads with play_id
DROP INDEX IF EXISTS public.idx_bgb_user_expansions_user;     -- PK (user_id, expansion_game_id) leads with user_id

-- Strict prefix of idx_bgb_chapters_game_type (game_id, chapter_type), added
-- by 018; chapter_routes filters on game_id with an optional chapter_type, and
-- the composite serves both.
DROP INDEX IF EXISTS public.idx_bgb_chapters_game;

-- A to_tsvector GIN index with zero full-text queries in the codebase. 039
-- said so explicitly ("existing to_tsvector GIN cannot serve them") and added
-- idx_bgb_games_name_trgm instead; search now goes through
-- boardgamebuddy_search_games -> ILIKE -> the trigram index.
DROP INDEX IF EXISTS public.idx_bgb_games_name;

-- Nothing filters on (code, phase). Every code lookup is code + status='open',
-- served by the partial unique idx_bgb_play_sessions_open_code; phase is only
-- read off an already-fetched row or filtered after status in
-- bgb_joinable_sessions.
DROP INDEX IF EXISTS public.idx_bgb_play_sessions_code_phase;


-- ── 5. bgb_log_play — stop writing what section 3 dropped ────────────────────
-- Also drops its boardgamebuddy_buddies roster insert. That roster existed
-- only to feed GET /plays/filter-options, an endpoint no client ever called
-- and which was removed alongside this migration. The table itself stays: it
-- still records free-text ghost players for plays.
CREATE OR REPLACE FUNCTION public.bgb_log_play(
  p_user    UUID,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_game        RECORD;
  v_mode        TEXT;
  v_play        RECORD;
  v_logged_name TEXT;
  v_players     JSONB;
  v_expansions  JSONB;
BEGIN
  SELECT g.id, g.name, g.thumbnail_url, g.play_mode
    INTO v_game
    FROM boardgamebuddy_games g
   WHERE g.id = (p_payload->>'game_id')::UUID;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'game_not_found');
  END IF;

  -- Explicit override wins; otherwise inherit the game's intrinsic mode.
  -- Mirrors log_play's `effective_mode`.
  v_mode := COALESCE(
    NULLIF(p_payload->>'play_mode', ''),
    v_game.play_mode,
    'competitive'
  );

  -- game_name / game_thumbnail_url are the surviving denormalized columns
  -- from migration 020 — the same set game_routes.play_denormalized_from_game()
  -- supplies. game_image_url and game_play_mode were dropped in 044: nothing
  -- ever read them off the play row.
  INSERT INTO boardgamebuddy_plays (
    user_id, game_id, played_at, notes, photo_url, play_mode,
    game_name, game_thumbnail_url
  )
  VALUES (
    p_user,
    v_game.id,
    (p_payload->>'played_at')::DATE,
    p_payload->>'notes',
    p_payload->>'photo_url',
    v_mode,
    v_game.name,
    v_game.thumbnail_url
  )
  RETURNING id, created_at INTO v_play;

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
  --
  -- A linked account's display name and avatar win over the typed label;
  -- ghosts fall back to the typed name. Same precedence as
  -- play_routes._fetch_players.
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

  RETURN jsonb_build_object(
    'id',              v_play.id,
    'game_id',         v_game.id,
    'game_name',       v_game.name,
    'game_thumbnail',  v_game.thumbnail_url,
    'played_at',       (p_payload->>'played_at')::DATE,
    'notes',           p_payload->>'notes',
    'players',         v_players,
    'photo_url',       p_payload->>'photo_url',
    'expansions',      v_expansions,
    'created_at',      v_play.created_at,
    'play_mode',       v_mode,
    'logged_by_id',    p_user,
    'logged_by_name',  COALESCE(v_logged_name, ''),
    'is_own',          true
  );
END;
$$;

COMMIT;


-- ── Deliberately NOT dropped ─────────────────────────────────────────────────
-- These columns are written but never read, so a mechanical audit flags them.
-- They are captured data and diagnostics rather than dead code, and dropping
-- them would destroy information the app already collects:
--
--   collections.bgg_private_comment / bgg_acquired_from / bgg_acquisition_date
--   collections.bgg_purchase_price / bgg_purchase_currency
--   collections.bgg_inventory_location / bgg_quantity
--       Imported from BGG's <privateinfo> on every sync. The import half of
--       the feature is built; only the display half is missing.
--
--   profiles.bgg_last_login_at
--       Observability for the BGG session-refresh path.
--
--   bgg_pending_imports.error_message
--       Written on every failed import. bgb_bgg_sync_status counts errors but
--       does not surface the message; it is what makes a failed sync
--       diagnosable at all.
--
-- Also left alone: boardgamebuddy_user_expansions (live — the per-user toggle
-- endpoint and bgb_game_detail_bundle both use it, despite stale comments in
-- STRUCTURE.md and db/schema saying otherwise) and bgb_game_summary (called
-- only from inside bgb_session_bundle and bgb_joinable_sessions, so it is
-- invisible to a .rpc() grep).
