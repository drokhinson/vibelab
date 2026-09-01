-- 048_play_client_key.sql — idempotency key for play writes.
--
-- Offline mode queues a finished play in the browser's localStorage and posts
-- it on the next online session (web/domain/outbox.js). That queue has to be
-- safe to retry: if the request lands but the response is lost — phone drops
-- signal mid-flush, tab is closed, Railway restarts — the client cannot tell
-- "never arrived" from "arrived, answer lost", so it retries. Without a key
-- the retry writes a second play and the host's history shows the same game
-- twice.
--
-- The client stamps one UUID per queued play and re-sends the same value on
-- every attempt. First write wins; every retry gets the original play back.
--
-- Nullable on purpose: every pre-existing row, and every live (online) write
-- from the host cascade or the native app, carries no key and keeps the
-- current behaviour — two identical POSTs really are two plays, which is
-- correct when a group plays the same game twice in an evening.

BEGIN;


-- ── 1. Column + uniqueness ───────────────────────────────────────────────────
ALTER TABLE public.boardgamebuddy_plays
  ADD COLUMN IF NOT EXISTS client_key UUID;

COMMENT ON COLUMN public.boardgamebuddy_plays.client_key IS
  'Client-generated idempotency key for offline-queued plays. NULL for live writes.';

-- Partial: only keyed rows participate, so the unlimited NULLs from live
-- writes don't collide. Scoped to user_id — two people can never share a
-- generated UUID in practice, but a per-user key keeps one client's bug from
-- being able to block another user's write.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_plays_client_key
  ON public.boardgamebuddy_plays (user_id, client_key)
  WHERE client_key IS NOT NULL;


-- ── 2. bgb_log_play — honour the key ─────────────────────────────────────────
-- Body is 044's version (which dropped the buddies-roster insert and the
-- game_image_url / game_play_mode denormalized columns), plus:
--   * a pre-check that short-circuits a known key,
--   * client_key written on the INSERT,
--   * a unique_violation handler for the concurrent case, where two flushes
--     race past the pre-check and only one INSERT can win.
--
-- The duplicate branch returns {"duplicate": true, "id": <uuid>} rather than
-- rebuilding the response: the payload in hand describes what the caller MEANT
-- to write, and on a retry that can differ from what actually landed. The
-- caller (play_routes.log_play) re-reads the stored row so the client always
-- sees the play that exists, not the one it just tried to write.
--
-- bgb_finalize_session calls this function, so lobby finalizes inherit the
-- guard for free if a client_key is ever supplied on that path.
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
  BEGIN
    INSERT INTO boardgamebuddy_plays (
      user_id, game_id, played_at, notes, photo_url, play_mode,
      game_name, game_thumbnail_url, client_key
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
      v_client_key
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

-- Mirrors 042's grant — CREATE OR REPLACE keeps existing grants, but the
-- explicit line keeps this migration self-contained on a fresh database.
GRANT EXECUTE ON FUNCTION public.bgb_log_play(UUID, JSONB) TO boardgamebuddy_role;

COMMIT;
