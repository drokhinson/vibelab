-- 043_bga_import.sql — Board Game Arena as a play-import source.
--
-- WHY. The play importer (/settings/import) reads notes and photos, and its
-- source picker has carried a disabled "Board Game Arena — coming soon" row
-- since the wizard shipped. People who play on BGA already have a complete,
-- dated, scored play history in an account they own; this is the schema behind
-- bringing it over.
--
-- FOUR PIECES.
--
-- 1. bga_* on boardgamebuddy_profiles — the linked account. Deliberately NOT a
--    column-for-column copy of the bgg_* set: BGG got three named cookie
--    columns (bgg_session_id / _user_cookie / _pass_cookie) because its cookie
--    names were known in advance. BGA has no public API and no documented
--    cookie set, so one bga_session_cookies JSONB holds whatever the login
--    actually returns. Three named columns here would bake in a guess and cost
--    a migration to undo the first time it was wrong.
--
-- 2. bga_table_id on boardgamebuddy_plays, with a partial unique index on
--    (user_id, bga_table_id) — the twin of idx_bgb_plays_user_bgg_play. This is
--    what makes "import any NEW plays" mean anything: a BGA table is imported
--    at most once per account, so a second run offers only what is genuinely
--    new, and the importer can skip fetching detail for tables it already has.
--
-- 3. boardgamebuddy_bga_player_links — handle → person, remembered per owner.
--    A table rather than a column, because a BGA handle most often maps to a
--    GHOST, and a ghost has no row anywhere: boardgamebuddy_buddies is only the
--    explicitly-named ghost-buddy roster, and a play ghost is free text in
--    boardgamebuddy_play_players.player_display_name. There is nothing to hang
--    a column on. This is the whole payoff of the importer's matching step —
--    the first import is work, the second is a glance.
--
-- 4. bgb_log_play, replaced — it is the function that actually writes a play
--    (bgb_import_plays owns no insert logic, it loops into this), so the new
--    column's write and its dedupe both live here.
--
-- WRITTEN BY the /bga/* routes and POST /plays/import.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The linked BGA account
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_profiles
  ADD COLUMN IF NOT EXISTS bga_username           TEXT,
  ADD COLUMN IF NOT EXISTS bga_player_id          TEXT,
  ADD COLUMN IF NOT EXISTS bga_password_enc       TEXT,
  ADD COLUMN IF NOT EXISTS bga_session_cookies    JSONB,
  ADD COLUMN IF NOT EXISTS bga_session_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bga_last_login_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bga_last_import_at     TIMESTAMPTZ;

COMMENT ON COLUMN public.boardgamebuddy_profiles.bga_password_enc IS
  'Fernet-encrypted BGA password, keyed by BGA_CREDENTIAL_KEY. Its own key, not BGG_CREDENTIAL_KEY: rotating one must not force a re-link of the other. Rotating THIS one forces every BGA re-link.';

COMMENT ON COLUMN public.boardgamebuddy_profiles.bga_session_cookies IS
  'Opaque BGA session cookies, whatever names the login returns. Never carried by a response model and never logged.';

-- lower(), where idx_bgb_profiles_bgg_username indexes the bare column. The
-- cross-account match ("this BGA handle belongs to an account here") is
-- case-insensitive, and an index that does not agree with the lookup is an
-- index the lookup cannot use.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_profiles_bga_username
  ON public.boardgamebuddy_profiles USING btree (lower(bga_username))
  WHERE (bga_username IS NOT NULL);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The imported table's id, and the dedupe that hangs off it
-- ─────────────────────────────────────────────────────────────────────────────

-- BIGINT, matching bgg_play_id's choice — BGA table ids are already past 5e8.
ALTER TABLE public.boardgamebuddy_plays
  ADD COLUMN IF NOT EXISTS bga_table_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_plays_user_bga_table
  ON public.boardgamebuddy_plays USING btree (user_id, bga_table_id)
  WHERE (bga_table_id IS NOT NULL);

COMMENT ON COLUMN public.boardgamebuddy_plays.bga_table_id IS
  'The Board Game Arena table this play was imported from (migration 043). NULL for every other origin. Unique per user, which is what makes a re-import offer only new tables.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Remembered handle → person
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_bga_player_links (
  id                  UUID DEFAULT gen_random_uuid() NOT NULL,
  owner_id            UUID NOT NULL,
  bga_handle          TEXT NOT NULL,
  -- An account seat, OR a ghost's spelling. Mirrors
  -- boardgamebuddy_play_players' identity CHECK deliberately: one link row
  -- resolves to either kind of seat with no branching at the call site, and
  -- the display name is what survives the FK's ON DELETE SET NULL.
  player_user_id      UUID,
  player_display_name TEXT,
  created_at          TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at          TIMESTAMPTZ DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_bga_player_links_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_bga_links_owner_fkey FOREIGN KEY (owner_id)
    REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE,
  CONSTRAINT bgb_bga_links_player_fkey FOREIGN KEY (player_user_id)
    REFERENCES boardgamebuddy_profiles(id) ON DELETE SET NULL,
  CONSTRAINT bgb_bga_links_identity_chk CHECK (
    (player_user_id IS NOT NULL)
    OR (NULLIF(btrim(COALESCE(player_display_name, '')), '') IS NOT NULL))
);

ALTER TABLE public.boardgamebuddy_bga_player_links ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_bga_player_links TO boardgamebuddy_role;

-- Owner-scoped and case-insensitive: your reading of a handle is yours, and
-- BGA handles are not case-sensitive to their owner.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_bga_links_owner_handle
  ON public.boardgamebuddy_bga_player_links USING btree (owner_id, lower(bga_handle));

COMMENT ON TABLE public.boardgamebuddy_bga_player_links IS
  'Board Game Arena handle → the person the owner says it is (migration 043). Written by the import wizard when a handle is resolved by hand, read on the next import to pre-seat it. No API-role grant: only the service role touches it.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. bgb_log_play — the 023 function, plus bga_table_id
-- ─────────────────────────────────────────────────────────────────────────────
-- Four changes and nothing else:
--
--   a. v_bga_table, read the same NULLIF way as every other optional key.
--   b. A pre-check beside the client_key one, returning the same duplicate
--      envelope. This is the one the importer actually hits: it filters known
--      tables client-side, so reaching here means a concurrent import or a
--      stale draft, and either way the right answer is "you already have it".
--   c. bga_table_id in the INSERT.
--   d. The unique_violation handler WIDENED. It resolved the winner's id by
--      client_key alone, which was correct while client_key was the only
--      unique index a play could violate. With idx_bgb_plays_user_bga_table
--      there are two, and a BGA play carries a client_key of its own — but a
--      caller that sends only the table id would otherwise get
--      {"duplicate": true, "id": null}: a silent wrong answer rather than an
--      error. Resolve on whichever key the caller actually supplied.
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
  v_roster      JSONB;
  v_players     JSONB;
  v_expansions  JSONB;
  v_client_key  UUID;
  v_existing    UUID;
  v_country     TEXT;
  v_group       UUID;
  v_batch       UUID;
  v_template    JSONB;
  v_bga_table   BIGINT;
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

  -- Migration 040. The BGA table this play came from, if any.
  v_bga_table := NULLIF(p_payload->>'bga_table_id', '')::BIGINT;

  IF v_client_key IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.client_key = v_client_key;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- Migration 040. Same envelope, different key: a table already imported is
  -- not a failure, it is the answer "you already have this one".
  IF v_bga_table IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.bga_table_id = v_bga_table;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- Migration 023. The roster gate, before anything is written.
  SELECT COALESCE(jsonb_agg(kept.seat ORDER BY kept.ord), '[]'::JSONB)
    INTO v_roster
    FROM (
      SELECT s.seat, s.ord
        FROM jsonb_array_elements(COALESCE(p_payload->'players', '[]'::JSONB))
               WITH ORDINALITY AS s(seat, ord)
       WHERE NULLIF(btrim(COALESCE(s.seat->>'user_id', '')), '') IS NOT NULL
          OR NULLIF(btrim(COALESCE(s.seat->>'name', '')), '') IS NOT NULL
    ) kept;

  IF jsonb_array_length(v_roster) = 0 THEN
    RETURN jsonb_build_object('error', 'no_players');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_roster) AS s(seat)
     WHERE NULLIF(btrim(COALESCE(s.seat->>'user_id', '')), '') IS NOT NULL
     GROUP BY NULLIF(btrim(s.seat->>'user_id'), '')::UUID
    HAVING count(*) > 1
  ) THEN
    RETURN jsonb_build_object('error', 'duplicate_player');
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
      import_group_id, import_batch_id, imported_at, scoring_template,
      bga_table_id
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
      v_template,
      v_bga_table
    )
    RETURNING id, created_at INTO v_play;
  EXCEPTION WHEN unique_violation THEN
    -- Lost the race against a concurrent flush of the same queued play, or
    -- against a concurrent import of the same BGA table. The winner's row is
    -- the canonical one; hand its id back on the same duplicate envelope the
    -- pre-checks use.
    --
    -- Both keys, not just client_key (migration 043): there are two unique
    -- indexes a play can violate now, and resolving on the wrong one returns
    -- id: null — a wrong answer that raises nothing and looks like success.
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user
       AND ((v_client_key IS NOT NULL AND p.client_key   = v_client_key)
         OR (v_bga_table IS NOT NULL AND p.bga_table_id = v_bga_table));
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
  FROM jsonb_to_recordset(v_roster)
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

  -- Response blocks are built from the NORMALIZED roster (plus the profile/game
  -- joins they need), not by reading the rows back — the values are identical
  -- and WITH ORDINALITY keeps the player list in the order the host entered it,
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
           jsonb_to_recordset(v_roster)
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

-- Re-stated after every CREATE OR REPLACE: Supabase grants anon and
-- authenticated their own ACL entries, so revoking PUBLIC alone is not enough
-- (.claude/rules/database-supabase.md).
REVOKE EXECUTE ON FUNCTION public.bgb_log_play(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.bgb_log_play(uuid, jsonb) TO service_role;

COMMIT;
