-- ─────────────────────────────────────────────────────────────────────────────
-- 065_one_time_guests.sql — a guest for one play, with no name to remember
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A one-time guest is somebody you will never play with again and who has no
-- account: "Player 1", "Player 2". They are seated like any guest, but:
--
--   - they never join the logger's ghost list (bgb_play_partners), the claim
--     suggestions, or merge / rename / link-by-name;
--   - a claim on one is keyed by its PLAY as well as its name
--     (bgb_ghost_key), so claiming "Player 2" on one night never pulls in the
--     "Player 2" of any other night.
--
-- They stay claimable: the claim sheet looks the seat up from the play it is
-- on, and bgb_ghost_claim_detail hands back the play-scoped key to claim with.
--
-- 1. boardgamebuddy_play_players.one_time, and bgb_ghost_key.
-- 2. bgb_log_play writes the flag from the roster payload.
-- 3. The ghost readers and claim functions key one-time seats by play.
--
-- Deploy order: this migration first, then API, then web. The API's edit path
-- writes and reads the column, so it cannot run ahead of it; the API already
-- running before it sends no `one_time` and its seats take the default.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Column and key ────────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_play_players
  ADD COLUMN IF NOT EXISTS one_time boolean DEFAULT false NOT NULL;

ALTER TABLE public.boardgamebuddy_play_players
  DROP CONSTRAINT IF EXISTS bgb_play_players_one_time_chk;
ALTER TABLE public.boardgamebuddy_play_players
  ADD CONSTRAINT bgb_play_players_one_time_chk
    CHECK (NOT one_time OR player_display_name IS NOT NULL);

COMMENT ON COLUMN public.boardgamebuddy_play_players.one_time IS
  'A guest seated for this play only. Kept off the ghost list; claimed per play (bgb_ghost_key), not across every play carrying the same name.';

-- The handle a ghost is claimed and linked by. An ordinary ghost is its
-- lowercased name across every play its owner logged; a one-time guest is its
-- name on one play. Both satisfy bgb_ghost_claims_key_normalized.
CREATE OR REPLACE FUNCTION public.bgb_ghost_key(p_play uuid, p_name text, p_one_time boolean)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN p_one_time
              THEN 'play:' || p_play::text || ':' || lower(btrim(COALESCE(p_name, '')))
              ELSE lower(btrim(COALESCE(p_name, '')))
         END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_key(p_play uuid, p_name text, p_one_time boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_key(p_play uuid, p_name text, p_one_time boolean) TO boardgamebuddy_role;

-- ── 2. bgb_log_play writes the flag ──────────────────────────────────────────

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
  v_bgg_play_id BIGINT;
  v_accepted    UUID[];
  v_declined    UUID[];
BEGIN
  -- Empty string and absent both mean "no key" — the client omits the field
  -- entirely for live writes, but a serializer that emits "" must not be read
  -- as a key shared by every unkeyed play.
  v_client_key := NULLIF(p_payload->>'client_key', '')::UUID;

  -- Set only by the Settings play importer, and only on plays
  -- it judged identical to at least one other in the same import: same game,
  -- same date, same players, same winner, and no score or note on either. The
  -- feed and the plays log show one card per group; every counter still sees
  -- the individual rows, which is the whole reason this is a tag rather than
  -- a row multiplier.
  v_group := NULLIF(p_payload->>'import_group_id', '')::UUID;

  -- One id per IMPORT, where the group above is one per RUN.
  -- Both are set only by the importer; a live log has neither, and neither is
  -- read by anything that counts plays.
  v_batch := NULLIF(p_payload->>'import_batch_id', '')::UUID;

  -- The scoring grid this play was scored on, snapshotted.
  -- jsonb 'null' and absent both mean "no template": the client sends an
  -- explicit null for a play scored on the plain R1..Rn grid.
  v_template := NULLIF(p_payload->'scoring_template', 'null'::jsonb);

  -- The BGA table this play came from, if any.
  v_bga_table := NULLIF(p_payload->>'bga_table_id', '')::BIGINT;

  -- The BoardGameGeek play this row came from, set only by the
  -- importer's BoardGameGeek source. Same empty-string rule as the two keys
  -- above.
  v_bgg_play_id := NULLIF(p_payload->>'bgg_play_id', '')::BIGINT;

  -- Accounts that already answered: set only by bgb_finalize_session, from
  -- the lobby seats accepted or declined while the game was on. The API never
  -- passes a client's own copy of either key through.
  v_accepted := ARRAY(
    SELECT a::UUID
      FROM jsonb_array_elements_text(
             COALESCE(p_payload->'accepted_user_ids', '[]'::JSONB)) AS a
  );
  v_declined := ARRAY(
    SELECT d::UUID
      FROM jsonb_array_elements_text(
             COALESCE(p_payload->'declined_user_ids', '[]'::JSONB)) AS d
  );

  IF v_client_key IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.client_key = v_client_key;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- Same envelope, different key: a table already imported is
  -- not a failure, it is the answer "you already have this one".
  IF v_bga_table IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.bga_table_id = v_bga_table;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- The third key, and the only one that can see the plays the
  -- RETIRED POST /bgg/sync write path landed: those rows carry a bgg_play_id
  -- and no client_key at all, so nothing derived from the importer's own draft
  -- ids could ever recognise them. This is what makes re-importing from
  -- BoardGameGeek a no-op rather than a duplicate.
  IF v_bgg_play_id IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.bgg_play_id = v_bgg_play_id;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- The roster gate, before anything is written.
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

  -- Unresolvable / malformed becomes NULL — "we don't know
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
      bga_table_id, bgg_play_id
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
      v_bga_table,
      v_bgg_play_id
    )
    RETURNING id, created_at INTO v_play;
  EXCEPTION WHEN unique_violation THEN
    -- Lost the race against a concurrent flush of the same queued play, or
    -- against a concurrent import of the same BGA table. The winner's row is
    -- the canonical one; hand its id back on the same duplicate envelope the
    -- pre-checks use.
    --
    -- EVERY key, not just client_key: there are
    -- three unique indexes a play can violate now, and resolving on the wrong
    -- one returns id: null — a wrong answer that raises nothing and looks like
    -- success. The BGG arm also covers the pending-imports worker still
    -- draining legacy kind='play' rows, which writes a bgg_play_id and no
    -- client_key, so no other arm could resolve that race.
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user
       AND ((v_client_key  IS NOT NULL AND p.client_key   = v_client_key)
         OR (v_bga_table   IS NOT NULL AND p.bga_table_id = v_bga_table)
         OR (v_bgg_play_id IS NOT NULL AND p.bgg_play_id  = v_bgg_play_id));
    RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
  END;

  INSERT INTO boardgamebuddy_play_players (
    play_id, player_user_id, pending_user_id, player_display_name, is_winner,
    score, round_scores, team, one_time
  )
  SELECT
    v_play.id,
    -- The logger's own seat, and a seat accepted in the lobby, count at once.
    -- Every other account is invited: the seat shows on the play, and counts
    -- for that person only once they accept (bgb_accept_play_invites).
    CASE WHEN pl.user_id = p_user OR pl.user_id = ANY(v_accepted)
         THEN pl.user_id END,
    CASE WHEN pl.user_id <> p_user AND NOT (pl.user_id = ANY(v_accepted))
              AND NOT (pl.user_id = ANY(v_declined))
         THEN pl.user_id END,
    -- An invited seat always carries a name, so a decline can leave it as a
    -- guest without tripping bgb_play_players_identity_chk.
    COALESCE(
      NULLIF(btrim(pl.name), ''),
      (SELECT pr.display_name FROM boardgamebuddy_profiles pr WHERE pr.id = pl.user_id),
      CASE WHEN pl.user_id IS NULL THEN pl.name ELSE 'Player' END
    ),
    COALESCE(pl.is_winner, false),
    pl.score,
    pl.round_scores,
    -- '' is the COMMON case, not an edge one: the client seeds every seat with
    -- team:"" and writes "" back when a tag is cleared. Stored as NULL, or
    -- every untagged seat in the app would share one anonymous side.
    NULLIF(btrim(pl.team), ''),
    -- Only a guest can be one-time: an account seat is a person by
    -- definition, and the flag on it would mean nothing.
    COALESCE(pl.one_time, false) AND pl.user_id IS NULL
  FROM jsonb_to_recordset(v_roster)
         AS pl(name TEXT, is_winner BOOLEAN, score NUMERIC,
               user_id UUID, round_scores JSONB, team TEXT,
               one_time BOOLEAN);

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
             'round_scores', pl.round_scores,
             -- Echoed from the same NULLIF the INSERT used, for the reason
             -- country_code is echoed from its normalized local below: the
             -- client has to read back the value that actually landed.
             'team',         NULLIF(btrim(pl.team), ''),
             'pending',      COALESCE(pl.user_id <> p_user
                                      AND NOT (pl.user_id = ANY(v_accepted))
                                      AND NOT (pl.user_id = ANY(v_declined)), false)
           ) ORDER BY pl.ord
         ), '[]'::JSONB)
    INTO v_players
    FROM ROWS FROM (
           jsonb_to_recordset(v_roster)
             AS (name TEXT, is_winner BOOLEAN, score NUMERIC,
                 user_id UUID, round_scores JSONB, team TEXT)
         ) WITH ORDINALITY AS pl(name, is_winner, score, user_id, round_scores,
                                 team, ord)
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
REVOKE EXECUTE ON FUNCTION public.bgb_log_play(p_user uuid, p_payload jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_log_play(p_user uuid, p_payload jsonb) TO boardgamebuddy_role;

-- ── 3. Ghost readers and claims key one-time seats by play ─────────────────

CREATE OR REPLACE FUNCTION public.bgb_ghost_claim_suggestions(p_viewer uuid, p_limit integer DEFAULT 10, p_threshold real DEFAULT 0.35)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_out JSONB;
BEGIN
  WITH me AS (
    SELECT lower(btrim(display_name)) AS dn, username
      FROM boardgamebuddy_profiles
     WHERE id = p_viewer
  ),
  owners AS (
    SELECT CASE WHEN be.user_a = p_viewer THEN be.user_b ELSE be.user_a END AS owner_id
      FROM boardgamebuddy_buddy_edges be
     WHERE be.status = 'accepted'
       AND p_viewer IN (be.user_a, be.user_b)
  ),
  ghost_rows AS (
    SELECT p.user_id AS owner_id,
           lower(btrim(pp.player_display_name)) AS name_key,
           btrim(pp.player_display_name) AS name_raw,
           p.played_at,
           p.game_name,
           EXISTS (
             SELECT 1 FROM boardgamebuddy_play_players s
              WHERE s.play_id = p.id AND s.player_user_id = p_viewer
           ) AS seats_viewer
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
     WHERE p.user_id IN (SELECT owner_id FROM owners)
       AND pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
       -- A one-time guest is claimed from the play it sits on, never
       -- suggested: "Player 2" resembles nobody's name.
       AND NOT pp.one_time
       AND btrim(COALESCE(pp.player_display_name, '')) <> ''
  ),
  grouped AS (
    SELECT owner_id,
           name_key,
           mode() WITHIN GROUP (ORDER BY name_raw) AS ghost_display_name,
           COUNT(*)::INT AS play_count,
           MAX(played_at) AS last_played_at,
           (array_agg(game_name ORDER BY played_at DESC))[1] AS last_game_name,
           bool_or(seats_viewer) AS collides
      FROM ghost_rows
     GROUP BY owner_id, name_key
  ),
  scored AS (
    SELECT g.*, m.score, m.is_match
      FROM grouped g, me, LATERAL (
        SELECT GREATEST(
                 extensions.similarity(g.name_key, me.dn),
                 extensions.similarity(g.name_key, me.username)
               ) AS score,
               (
                    extensions.similarity(g.name_key, me.dn) >= p_threshold
                 OR extensions.similarity(g.name_key, me.username) >= p_threshold
                 OR (
                      char_length(g.name_key) >= 3
                      AND position(' ' IN g.name_key) = 0
                      AND (
                           starts_with(me.dn, g.name_key)
                        OR starts_with(me.username, g.name_key)
                        OR g.name_key = split_part(me.dn, ' ', 1)
                      )
                    )
               ) AS is_match
      ) m
     -- A ghost the viewer is already seated beside is almost certainly not
     -- the viewer. Dropped whole, never partially — see bgb_create_ghost_claim.
     WHERE NOT g.collides
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY s_score DESC, s_count DESC, s_last DESC NULLS LAST), '[]'::jsonb)
    INTO v_out
    FROM (
      SELECT jsonb_build_object(
               'owner_user_id',      s.owner_id,
               'owner_display_name', pr.display_name,
               'owner_username',     pr.username,
               'owner_avatar',       pr.avatar,
               'ghost_display_name', s.ghost_display_name,
               'ghost_name_key',     s.name_key,
               'play_count',         s.play_count,
               'last_played_at',     s.last_played_at,
               'last_game_name',     s.last_game_name,
               'match_score',        round(s.score::numeric, 3),
               'claim_status',       c.status,
               'claim_id',           c.id
             ) AS x,
             s.score AS s_score,
             s.play_count AS s_count,
             s.last_played_at AS s_last
        FROM scored s
        JOIN boardgamebuddy_profiles pr ON pr.id = s.owner_id
        LEFT JOIN boardgamebuddy_ghost_claims c
               ON c.owner_id = s.owner_id
              AND c.ghost_name_key = s.name_key
              AND c.claimant_id = p_viewer
       WHERE s.is_match
         -- A PENDING claim is kept, and surfaced with claim_status so the row
         -- shows a disabled "Requested" chip instead of vanishing out from
         -- under the finger that just tapped it. Every other status means
         -- this ghost is settled and must stop appearing.
         AND (c.id IS NULL OR c.status = 'pending')
       ORDER BY s.score DESC, s.play_count DESC, s.last_played_at DESC NULLS LAST
       LIMIT GREATEST(p_limit, 0)
    ) q;

  RETURN COALESCE(v_out, '[]'::jsonb);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_claim_suggestions(p_viewer uuid, p_limit integer, p_threshold real) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claim_suggestions(p_viewer uuid, p_limit integer, p_threshold real) TO boardgamebuddy_role;


CREATE OR REPLACE FUNCTION public.bgb_ghost_claims(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_incoming JSONB;
  v_outgoing JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(x ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_incoming
    FROM (
      SELECT jsonb_build_object(
               'id',                 c.id,
               'direction',          'incoming',
               'other_user_id',      pr.id,
               'other_display_name', pr.display_name,
               'other_username',     pr.username,
               'other_avatar',       pr.avatar,
               'ghost_display_name', c.ghost_display_name,
               'play_count',         COALESCE(st.play_count, 0),
               'last_played_at',     st.last_played_at,
               'created_at',         c.created_at
             ) AS x,
             c.created_at
        FROM boardgamebuddy_ghost_claims c
        JOIN boardgamebuddy_profiles pr ON pr.id = c.claimant_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::INT AS play_count, MAX(p.played_at) AS last_played_at
            FROM boardgamebuddy_plays p
            JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
           WHERE p.user_id = c.owner_id
             AND pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
             AND bgb_ghost_key(pp.play_id, pp.player_display_name, pp.one_time) = c.ghost_name_key
        ) st ON TRUE
       WHERE c.owner_id = p_viewer AND c.status = 'pending'
    ) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_outgoing
    FROM (
      SELECT jsonb_build_object(
               'id',                 c.id,
               'direction',          'outgoing',
               'other_user_id',      pr.id,
               'other_display_name', pr.display_name,
               'other_username',     pr.username,
               'other_avatar',       pr.avatar,
               'ghost_display_name', c.ghost_display_name,
               'play_count',         COALESCE(st.play_count, 0),
               'last_played_at',     st.last_played_at,
               'created_at',         c.created_at
             ) AS x,
             c.created_at
        FROM boardgamebuddy_ghost_claims c
        JOIN boardgamebuddy_profiles pr ON pr.id = c.owner_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::INT AS play_count, MAX(p.played_at) AS last_played_at
            FROM boardgamebuddy_plays p
            JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
           WHERE p.user_id = c.owner_id
             AND pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
             AND bgb_ghost_key(pp.play_id, pp.player_display_name, pp.one_time) = c.ghost_name_key
        ) st ON TRUE
       WHERE c.claimant_id = p_viewer AND c.status = 'pending'
    ) s;

  RETURN jsonb_build_object('incoming', v_incoming, 'outgoing', v_outgoing);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_claims(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claims(p_viewer uuid) TO boardgamebuddy_role;


CREATE OR REPLACE FUNCTION public.bgb_ghost_summary(p_viewer uuid, p_owner uuid, p_name_key text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH visible AS (
    SELECT p_viewer AS uid
    UNION
    SELECT CASE WHEN be.user_a = p_viewer THEN be.user_b ELSE be.user_a END
      FROM boardgamebuddy_buddy_edges be
     WHERE be.status = 'accepted'
       AND p_viewer IN (be.user_a, be.user_b)
  ),
  g_rows AS (
    SELECT p.played_at,
           p.game_name,
           btrim(pp.player_display_name) AS name_raw,
           EXISTS (
             SELECT 1 FROM boardgamebuddy_play_players s
              WHERE s.play_id = p.id AND s.player_user_id = p_viewer
           ) AS seats_viewer,
           (
             p.user_id IN (SELECT uid FROM visible)
             OR EXISTS (
               SELECT 1 FROM boardgamebuddy_play_players v
                WHERE v.play_id = p.id
                  AND v.player_user_id IN (SELECT uid FROM visible)
             )
           ) AS is_visible
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
     WHERE p.user_id = p_owner
       AND pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
       AND bgb_ghost_key(pp.play_id, pp.player_display_name, pp.one_time) = p_name_key
  )
  SELECT jsonb_build_object(
           'exists',             COUNT(*) > 0,
           'play_count',         COUNT(*)::INT,
           'last_played_at',     MAX(played_at),
           'last_game_name',     (array_agg(game_name ORDER BY played_at DESC))[1],
           'ghost_display_name', mode() WITHIN GROUP (ORDER BY name_raw),
           'collides',           COALESCE(bool_or(seats_viewer), false),
           'visible',            COALESCE(bool_or(is_visible), false)
         )
    FROM g_rows;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_summary(p_viewer uuid, p_owner uuid, p_name_key text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_summary(p_viewer uuid, p_owner uuid, p_name_key text) TO boardgamebuddy_role;


CREATE OR REPLACE FUNCTION public.bgb_link_ghost_rows(p_owner uuid, p_name_key text, p_target uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated INT;
BEGIN
  -- Scoped to plays the owner logged, so a caller can never touch someone
  -- else's roster.
  UPDATE boardgamebuddy_play_players pp
     SET player_user_id = p_target
   WHERE pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_owner
         )
     AND pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
     AND bgb_ghost_key(pp.play_id, pp.player_display_name, pp.one_time) = p_name_key;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_link_ghost_rows(p_owner uuid, p_name_key text, p_target uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_link_ghost_rows(p_owner uuid, p_name_key text, p_target uuid) TO boardgamebuddy_role;


CREATE OR REPLACE FUNCTION public.bgb_merge_ghosts(p_viewer uuid, p_source text, p_target text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated INT;
BEGIN
  UPDATE boardgamebuddy_play_players pp
     SET player_display_name = p_target
   WHERE pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_viewer
         )
     AND pp.player_display_name ILIKE p_source
     AND pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
     -- Merge and rename act on the ghost list, which one-time guests
     -- are not in.
     AND NOT pp.one_time;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_updated);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_merge_ghosts(p_viewer uuid, p_source text, p_target text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_merge_ghosts(p_viewer uuid, p_source text, p_target text) TO boardgamebuddy_role;


CREATE OR REPLACE FUNCTION public.bgb_play_partners(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_accounts JSONB;
  v_pending JSONB;
  v_ghosts JSONB;
  v_recent JSONB;
BEGIN
  -- accounts: accepted mutual edges, from the viewer's side.
  SELECT COALESCE(jsonb_agg(a ORDER BY a_sort), '[]'::jsonb)
    INTO v_accounts
    FROM (
      SELECT jsonb_build_object(
               'id', e.id,
               'other_user_id', pr.id,
               'other_display_name', pr.display_name,
               'other_username', pr.username,
               'other_avatar', pr.avatar,
               -- The viewer's own private alias for this buddy, off
               -- whichever side of the canonical row the viewer sits on. NULL
               -- for the other party by construction — a per-viewer
               -- projection, not a property of the edge.
               'other_alias',
                 CASE WHEN e.user_a = p_viewer THEN e.alias_by_a ELSE e.alias_by_b END,
               'accepted_at', e.accepted_at,
               'created_at', e.created_at
             ) AS a,
             lower(pr.display_name) AS a_sort
        FROM boardgamebuddy_buddy_edges e
        JOIN boardgamebuddy_profiles pr
          ON pr.id = CASE WHEN e.user_a = p_viewer THEN e.user_b ELSE e.user_a END
       WHERE e.status = 'accepted'
         AND (e.user_a = p_viewer OR e.user_b = p_viewer)
    ) s;

  -- pending: live requests either way, newest first — a request
  -- made minutes ago is likelier to be the person in front of you than one
  -- that has been sitting for a fortnight, which is the opposite of the
  -- alphabetical order `accounts` wants (that list is browsed; this one is a
  -- short "oh, them" list at the top of a picker).
  --
  -- A rejected or cancelled request is a DELETED row (buddy_service.reject_request
  -- / cancel_request), not a status, so "pending" here means genuinely waiting.
  -- 'blocked' edges are excluded by the same test.
  SELECT COALESCE(jsonb_agg(q ORDER BY q_sort DESC NULLS LAST, q_name), '[]'::jsonb)
    INTO v_pending
    FROM (
      SELECT jsonb_build_object(
               'id', e.id,
               'other_user_id', pr.id,
               'other_display_name', pr.display_name,
               'other_username', pr.username,
               'other_avatar', pr.avatar,
               'direction',
                 CASE WHEN e.requested_by = p_viewer THEN 'outgoing' ELSE 'incoming' END,
               'created_at', e.created_at
             ) AS q,
             e.created_at AS q_sort,
             lower(pr.display_name) AS q_name
        FROM boardgamebuddy_buddy_edges e
        JOIN boardgamebuddy_profiles pr
          ON pr.id = CASE WHEN e.user_a = p_viewer THEN e.user_b ELSE e.user_a END
       WHERE e.status = 'pending'
         AND (e.user_a = p_viewer OR e.user_b = p_viewer)
    ) s;

  -- ghosts: free-text names from the viewer's OWN plays, grouped
  -- case-sensitively on the trimmed name.
  SELECT COALESCE(jsonb_agg(g ORDER BY g_count DESC, g_sort), '[]'::jsonb)
    INTO v_ghosts
    FROM (
      SELECT jsonb_build_object(
               'display_name', btrim(pp.player_display_name),
               'play_count', COUNT(*),
               'last_played_at', MAX(p.played_at)
             ) AS g,
             COUNT(*) AS g_count,
             lower(btrim(pp.player_display_name)) AS g_sort
        FROM boardgamebuddy_plays p
        JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
       WHERE p.user_id = p_viewer
         AND pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
         -- One-time guests stay off the list: "Player 2" from a
         -- club night is nobody you will pick again.
         AND NOT pp.one_time
         AND btrim(COALESCE(pp.player_display_name, '')) <> ''
       GROUP BY btrim(pp.player_display_name)
    ) s;

  -- recent: real accounts sharing a play with the viewer, ranked by how many.
  -- Visibility matches bgb_play_stats — plays the viewer logged, plus plays
  -- they appear in. Relation flags come from the same pass rather than the
  -- second query _relations_for_viewer used to run.
  WITH visible_plays AS (
    SELECT p.id FROM boardgamebuddy_plays p WHERE p.user_id = p_viewer
    UNION
    SELECT pp.play_id
      FROM boardgamebuddy_play_players pp
     WHERE pp.player_user_id = p_viewer
  ),
  counts AS (
    SELECT pp.player_user_id AS uid, COUNT(*) AS play_count
      FROM boardgamebuddy_play_players pp
      JOIN visible_plays v ON v.id = pp.play_id
     WHERE pp.player_user_id IS NOT NULL
       AND pp.player_user_id <> p_viewer
     GROUP BY pp.player_user_id
  )
  SELECT COALESCE(jsonb_agg(r ORDER BY r_count DESC, r_sort), '[]'::jsonb)
    INTO v_recent
    FROM (
      SELECT jsonb_build_object(
               'user_id', pr.id,
               'display_name', pr.display_name,
               'avatar', pr.avatar,
               'play_count', c.play_count,
               'is_buddy', COALESCE(e.status = 'accepted', FALSE),
               'has_pending_request', COALESCE(e.status = 'pending', FALSE),
               'pending_request_direction',
                 CASE WHEN e.status = 'pending'
                      THEN CASE WHEN e.requested_by = p_viewer THEN 'outgoing' ELSE 'incoming' END
                 END,
               -- The edge id, so the row can cancel an outgoing
               -- request (or accept an incoming one) without first fetching
               -- /buddies/requests to look it up by other_user_id.
               'pending_request_id',
                 CASE WHEN e.status = 'pending' THEN e.id END
             ) AS r,
             c.play_count AS r_count,
             lower(pr.display_name) AS r_sort
        FROM counts c
        -- Inner join: a co-player with no profile row is dropped, as the
        -- Python did when the profile lookup came back empty.
        JOIN boardgamebuddy_profiles pr ON pr.id = c.uid
        LEFT JOIN boardgamebuddy_buddy_edges e
          ON ((e.user_a = p_viewer AND e.user_b = c.uid)
           OR (e.user_b = p_viewer AND e.user_a = c.uid))
         AND e.status IN ('accepted', 'pending')
    ) s;

  RETURN jsonb_build_object(
    'accounts', v_accounts,
    'pending', v_pending,
    'ghosts', v_ghosts,
    'recent', v_recent
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_play_partners(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_play_partners(p_viewer uuid) TO boardgamebuddy_role;


CREATE OR REPLACE FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key     TEXT := lower(btrim(COALESCE(p_display_name, '')));
  v_updated INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_profiles WHERE id = p_target) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- One statement, so every row moved by one act of linking shares one
  -- timestamp — which is also what lets the notification list collapse a
  -- retroactive link across forty old plays into a single entry.
  UPDATE boardgamebuddy_play_players pp
     SET linked_at = now()
   WHERE pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
     AND bgb_ghost_key(pp.play_id, pp.player_display_name, pp.one_time) = v_key
     AND pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_viewer
         );

  -- Linking your own name counts at once. Linking somebody else's is an
  -- invite, the same as seating them in a new play.
  IF p_target = p_viewer THEN
    RETURN jsonb_build_object(
      'updated',
      bgb_link_ghost_rows(p_viewer, v_key, p_target)
    );
  END IF;

  UPDATE boardgamebuddy_play_players pp
     SET pending_user_id = p_target
   WHERE pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_viewer
         )
     AND pp.player_user_id IS NULL
     AND pp.pending_user_id IS NULL
     AND bgb_ghost_key(pp.play_id, pp.player_display_name, pp.one_time) = v_key
     AND NOT EXISTS (
           SELECT 1 FROM boardgamebuddy_play_players o
            WHERE o.play_id = pp.play_id
              AND p_target IN (o.player_user_id, o.pending_user_id)
         );
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object('updated', v_updated);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid) TO boardgamebuddy_role;


CREATE OR REPLACE FUNCTION public.bgb_ghost_claim_detail(p_viewer uuid, p_play_id uuid, p_display_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key    TEXT := lower(btrim(COALESCE(p_display_name, '')));
  v_owner  UUID;
  v_sum    JSONB;
  v_claim  RECORD;
  v_has_claim BOOLEAN := false;
  v_reason TEXT := NULL;
  v_owner_row RECORD;
BEGIN
  IF v_key = '' THEN
    RETURN jsonb_build_object('error', 'display_name_required');
  END IF;

  SELECT user_id INTO v_owner FROM boardgamebuddy_plays WHERE id = p_play_id;
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('error', 'claim_not_found');
  END IF;

  -- A one-time guest's claim is keyed by its play, not by its name alone,
  -- so claiming "Player 2" here never reaches a "Player 2" on another
  -- night. The key this returns is what the sheet sends back to claim.
  SELECT bgb_ghost_key(pp.play_id, pp.player_display_name, pp.one_time)
    INTO v_key
    FROM boardgamebuddy_play_players pp
   WHERE pp.play_id = p_play_id AND pp.one_time
     AND pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
     AND lower(btrim(COALESCE(pp.player_display_name, ''))) = v_key
   LIMIT 1;
  IF NOT FOUND THEN
    v_key := lower(btrim(COALESCE(p_display_name, '')));
  END IF;

  v_sum := bgb_ghost_summary(p_viewer, v_owner, v_key);

  IF NOT (v_sum->>'exists')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'ghost_gone');
  END IF;
  IF NOT (v_sum->>'visible')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'not_visible');
  END IF;

  SELECT * INTO v_claim
    FROM boardgamebuddy_ghost_claims
   WHERE owner_id = v_owner AND ghost_name_key = v_key AND claimant_id = p_viewer;
  -- Latch it: every later SELECT INTO reassigns FOUND.
  v_has_claim := FOUND;

  IF v_owner = p_viewer THEN
    v_reason := 'own_roster';
  ELSIF (v_sum->>'collides')::BOOLEAN THEN
    v_reason := 'already_seated';
  ELSIF v_has_claim AND v_claim.status = 'accepted' THEN
    v_reason := 'already_linked';
  ELSIF v_has_claim AND v_claim.status = 'pending' THEN
    v_reason := 'pending';
  ELSIF v_has_claim AND v_claim.reject_count >= 2 THEN
    v_reason := 'declined_twice';
  END IF;

  SELECT display_name, username, avatar INTO v_owner_row
    FROM boardgamebuddy_profiles WHERE id = v_owner;

  RETURN jsonb_build_object(
    'owner_user_id',      v_owner,
    'owner_display_name', v_owner_row.display_name,
    'owner_username',     v_owner_row.username,
    'owner_avatar',       v_owner_row.avatar,
    'ghost_display_name', v_sum->>'ghost_display_name',
    'ghost_name_key',     v_key,
    'play_count',         (v_sum->>'play_count')::INT,
    'last_played_at',     v_sum->'last_played_at',
    'last_game_name',     v_sum->>'last_game_name',
    'match_score',        NULL::NUMERIC,
    'claim_status',       CASE WHEN v_has_claim THEN v_claim.status ELSE NULL END,
    'claim_id',           CASE WHEN v_has_claim THEN v_claim.id ELSE NULL END,
    'can_claim',          v_reason IS NULL,
    'blocked_reason',     v_reason
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_claim_detail(p_viewer uuid, p_play_id uuid, p_display_name text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claim_detail(p_viewer uuid, p_play_id uuid, p_display_name text) TO boardgamebuddy_role;

COMMIT;
