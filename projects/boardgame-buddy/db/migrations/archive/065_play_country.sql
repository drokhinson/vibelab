-- 065_play_country.sql — where a play happened, at country granularity.
--
-- The point is the question "what gets played in Germany?" — popularity by
-- country/region. That view does not exist yet and is not worth building for
-- the current user count, but the data can only be collected forwards: a play
-- logged today with no country is a play that can never be counted later. So
-- the column lands now and starts filling; the aggregate is a later migration
-- reading a year of real rows instead of an empty table.
--
-- GRANULARITY IS THE WHOLE DESIGN. Country, not coordinates, not a place name.
-- It is the coarsest thing that answers the question, it needs no location
-- permission (the client reads it from the device's IANA timezone — see
-- web/domain/geo.js), and it cannot identify where anybody lives. A finer
-- column would be a privacy liability collected years before anything reads it.
--
-- ON THE PLAY, NOT THE PROFILE. A profile country would answer "where does the
-- owner live", which is a different and worse question: it re-labels a decade
-- of history every time someone moves, and it cannot see a convention weekend
-- abroad. A play is an event and its location is a fact about that event, so
-- it is stored on the event.
--
-- ON boardgamebuddy_plays, NOT boardgamebuddy_play_sessions. The lobby row is
-- a transient short-code coordination record — it expires, it is abandoned, it
-- is deleted, and it does not exist at all for a solo or offline log. The play
-- is the permanent record every read path already goes through, and
-- bgb_finalize_session writes one via bgb_log_play, so putting the column here
-- captures the hosted cascade, the offline outbox flush and the native app on
-- one code path.
--
-- NULLABLE FOREVER. Every pre-existing row has no country and none can be
-- invented for it; a client that cannot resolve one (locked-down browser, an
-- unknown timezone) sends nothing rather than a guess. Any future aggregate
-- filters on NOT NULL and reports its own coverage.

BEGIN;


-- ── 1. Column ────────────────────────────────────────────────────────────────
-- TEXT + CHECK rather than CHAR(2): CHAR pads and compares padded, and the
-- regex is what actually guarantees the shape. Uppercase is enforced here so
-- a future GROUP BY country_code cannot split "gb" from "GB" — every writer
-- normalizes, and this is the backstop that makes that non-optional.
ALTER TABLE public.boardgamebuddy_plays
  ADD COLUMN IF NOT EXISTS country_code TEXT;

DO $$
BEGIN
  ALTER TABLE public.boardgamebuddy_plays
    ADD CONSTRAINT bgb_plays_country_code_chk
    CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END;
$$;

COMMENT ON COLUMN public.boardgamebuddy_plays.country_code IS
  'ISO 3166-1 alpha-2 country where the play happened, uppercase. Resolved by '
  'the client from the device timezone (or picked by the host in Settle Up); '
  'NULL when unknown, and NULL on every row predating migration 065. Feeds a '
  'future popularity-by-country view and nothing today.';


-- ── 2. Index for the aggregate this column exists for ───────────────────────
-- (country_code, game_id) is the shape of every question in scope: "top games
-- in X", "which countries play Y". Partial on NOT NULL, because for a long
-- while most rows will be NULL and none of them are ever an answer.
CREATE INDEX IF NOT EXISTS idx_bgb_plays_country_game
  ON public.boardgamebuddy_plays (country_code, game_id)
  WHERE country_code IS NOT NULL;


-- ── 3. bgb_log_play — accept and normalize the country ──────────────────────
-- 048's body verbatim, plus: v_country resolved from the payload, written on
-- the INSERT, and echoed in the response envelope. Normalization is upper() +
-- the same regex the CHECK enforces, and anything that fails it becomes NULL
-- rather than an error: a play must never fail to save because a client sent a
-- junk locale string. bgb_finalize_session calls this function, so the hosted
-- cascade inherits the column for free.
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
  v_client_key  UUID;
  v_existing    UUID;
  v_country     TEXT;
BEGIN
  -- Empty string and absent both mean "no key" — the client omits the field
  -- entirely for live writes, but a serializer that emits "" must not be read
  -- as a key shared by every unkeyed play.
  v_client_key := NULLIF(p_payload->>'client_key', '')::UUID;

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
      game_name, game_thumbnail_url, client_key, country_code
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
      v_country
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
  -- would read back as "gb" while the row holds "GB".
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
    'country_code',    v_country,
    'logged_by_id',    p_user,
    'logged_by_name',  COALESCE(v_logged_name, ''),
    'is_own',          true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.bgb_log_play(UUID, JSONB) TO boardgamebuddy_role;


-- ── 4. bgb_plays_page — carry the column into the History tab ───────────────
-- 039's body verbatim plus one key. Without it a play would show its country
-- on the response to its own POST and then lose it on the next page load,
-- which is exactly the kind of "is this even being recorded?" doubt the column
-- is being added early to avoid.
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
      'country_code', pg.country_code,
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
