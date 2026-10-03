-- ─────────────────────────────────────────────────────────────────────────────
-- 068_accepted_seat_saved_read.sql — a seat you accepted is not news to you
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Somebody who accepts their seat in a live game (by joining it, or by
-- answering "Accept" on the spectator screen) watched the game happen. The
-- play the host saves still seats them, and the notification tray would show
-- that play as a new, unread "seated you" entry. It is saved read instead.
--
-- Read state is one watermark per account (profiles.link_notifications_seen_at),
-- and moving it would mark everything older read too, so the fact is stored
-- on the seat:
--
-- 1. boardgamebuddy_play_players.seen_at: set when a seat is saved already
--    read. NULL is every other seat, which is read once the watermark passes
--    its linked_at, as before.
-- 2. bgb_log_play stamps it on the lobby seats bgb_finalize_session passes as
--    accepted (the logger's own seat is never in the feed).
-- 3. bgb_notifications reports such an entry with is_unread false, and
--    bgb_notifications_unread leaves it out of the bell's count.
--
-- Deploy order: this migration first, then API. The API's play edit reads and
-- re-writes the column so an edit keeps the seat read; an API running before
-- the column exists would fail that read.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Column ────────────────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_play_players
  ADD COLUMN IF NOT EXISTS seen_at timestamp with time zone;

COMMENT ON COLUMN public.boardgamebuddy_play_players.seen_at IS
  'Set when this seat was saved already read by its account (a lobby seat it accepted). Such a seat is never unread in bgb_notifications.';

-- ── 2. bgb_log_play stamps accepted lobby seats ──────────────────────────────

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
    score, round_scores, team, one_time, seen_at
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
    COALESCE(pl.one_time, false) AND pl.user_id IS NULL,
    -- A lobby seat its account accepted is one they saw happen, so the play it
    -- lands in is saved already read in their notifications.
    CASE WHEN pl.user_id <> p_user AND pl.user_id = ANY(v_accepted)
         THEN now() END
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

-- ── 3. The feed and the bell's count skip seats saved read ──────────────────

CREATE OR REPLACE FUNCTION public.bgb_notifications(p_viewer uuid, p_limit integer DEFAULT 20, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_key text DEFAULT NULL::text)
 RETURNS TABLE(entry_key text, kind text, occurred_at timestamp with time zone, is_unread boolean, actor_id uuid, actor_display_name text, actor_username text, actor_avatar jsonb, play_group text, play_id uuid, play_ids uuid[], group_count integer, game_count integer, played_from date, played_to date, game_id uuid, game_name text, game_thumbnail_url text, import_batch_id uuid, edge_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_seen TIMESTAMPTZ;
  v_lim  INT := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
BEGIN
  SELECT pr.link_notifications_seen_at INTO v_seen
  FROM boardgamebuddy_profiles pr WHERE pr.id = p_viewer;

  RETURN QUERY
  WITH seats AS (
    -- The viewer's own seats on plays SOMEBODY ELSE logged, carrying their
    -- grouping key and nothing more. This is also the whole visibility rule:
    -- every row is a play the viewer is a player in, so there is nothing to
    -- leak and no buddy-graph check to run.
    --
    -- to_char at UTC rather than l_at::text: the key is the
    -- paging tiebreak and travels to the client and back, so it has to mean the
    -- same thing on both ends of that trip regardless of the session's TimeZone
    -- and DateStyle.
    SELECT pp.play_id   AS p_id,
           pp.linked_at AS l_at,
           p.user_id    AS o_id,
           -- Unread: after the watermark, and not a seat saved already read.
           (pp.seen_at IS NULL
            AND pp.linked_at > COALESCE(v_seen, '-infinity'::timestamptz)) AS u,
           CASE
             WHEN p.import_batch_id IS NOT NULL THEN 'b:' || p.import_batch_id::text
             WHEN p.import_group_id IS NOT NULL THEN 'g:' || p.import_group_id::text
             ELSE 'a:' || p.user_id::text || ':'
                  || to_char(pp.linked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
           END AS k,
           CASE
             WHEN p.import_batch_id IS NOT NULL THEN 'batch'
             WHEN p.import_group_id IS NOT NULL THEN 'run'
             ELSE 'act'
           END AS kd
    FROM boardgamebuddy_play_players pp
    JOIN boardgamebuddy_plays p ON p.id = pp.play_id
    WHERE pp.player_user_id = p_viewer
      AND p.user_id <> p_viewer
  ),
  page_keys AS (
    -- Which entries are on this page. MAX is the only aggregate here, and the
    -- ORDER BY / LIMIT are the ones the final SELECT would have applied anyway
    -- — just applied before the expensive work instead of after it.
    SELECT s.k AS k, s.kd AS kd, s.o_id AS o_id, MAX(s.l_at) AS l_at
    FROM seats s
    GROUP BY s.k, s.kd, s.o_id
    HAVING p_before IS NULL
        OR (MAX(s.l_at), s.k) < (p_before, COALESCE(p_before_key, ''))
    ORDER BY MAX(s.l_at) DESC, s.k DESC
    LIMIT v_lim
  ),
  members AS (
    -- Every seat belonging to a chosen entry, now with the wide columns. The
    -- join to plays is by primary key and runs for these rows only.
    SELECT pk.k AS k, pk.kd AS kd, pk.o_id AS o_id, s.l_at AS l_at, s.u AS u,
           p.id AS p_id, p.game_id AS g_id, p.played_at AS p_at,
           p.game_name AS g_name, p.game_thumbnail_url AS g_thumb,
           p.import_batch_id AS b_id
    FROM seats s
    JOIN page_keys pk ON pk.k = s.k AND pk.kd = s.kd AND pk.o_id = s.o_id
    JOIN boardgamebuddy_plays p ON p.id = s.p_id
  ),
  entries AS (
    SELECT m.k AS k, m.kd AS kd, m.o_id AS o_id,
           MAX(m.l_at)                    AS l_at,
           bool_or(m.u)                   AS u,
           COUNT(*)::int                  AS n_plays,
           COUNT(DISTINCT m.g_id)::int    AS n_games,
           MIN(m.p_at)                    AS from_at,
           MAX(m.p_at)                    AS to_at,
           array_agg(m.p_id ORDER BY m.p_at DESC NULLS LAST, m.p_id) AS ids,
           -- No MIN()/MAX() aggregate exists for uuid, so the representative is
           -- picked by ordering rather than aggregated. It is the most recent
           -- play in the entry — the one the card names and opens.
           (array_agg(m.p_id    ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep,
           (array_agg(m.g_id    ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep_game,
           (array_agg(m.g_name  ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep_name,
           (array_agg(m.g_thumb ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep_thumb,
           (array_agg(m.b_id    ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep_batch
    FROM members m
    GROUP BY m.k, m.kd, m.o_id
  ),
  -- Each source is normalised to the SAME wide row inside its own CTE, so the
  -- NULL casts are written once per branch rather than smeared through a union
  -- of bare SELECTs, and the cursor, the order and the limit are applied
  -- exactly once at the end over the merge.
  play_rows AS (
    SELECT e.k                                   AS ekey,
           'play_link'::text                     AS nkind,
           e.l_at                                AS occ,
           e.u                                   AS unr,
           e.o_id                                AS act_id,
           NULL::text                            AS act_name,
           e.kd                                  AS pgroup,
           e.rep                                 AS rep_play,
           e.ids                                 AS rep_plays,
           e.n_plays                             AS n_plays,
           e.n_games                             AS n_games,
           e.from_at                             AS from_at,
           e.to_at                               AS to_at,
           e.rep_game                            AS rep_game,
           -- game_name / game_thumbnail_url are denormalized and null on
           -- older rows, so fall back to the catalog
           -- the same way bgb_collection_shelf does.
           COALESCE(e.rep_name, g.name)          AS rep_name,
           COALESCE(e.rep_thumb, g.thumbnail_url) AS rep_thumb,
           e.rep_batch                           AS rep_batch,
           NULL::uuid                            AS e_id
    FROM entries e
    LEFT JOIN boardgamebuddy_games g ON g.id = e.rep_game
  ),
  -- Somebody asked to be your buddy and you have not answered. Accept flips the
  -- edge to 'accepted' and both Decline and Cancel DELETE it, so this row
  -- leaves the feed the instant it is acted on, from either side and with no
  -- bookkeeping — the same self-healing the play source gets from being derived.
  request_rows AS (
    SELECT 'req:' || be.id::text  AS ekey,
           'buddy_request'::text  AS nkind,
           be.created_at          AS occ,
           be.created_at > COALESCE(v_seen, '-infinity'::timestamptz) AS unr,
           be.requested_by        AS act_id,
           NULL::text   AS act_name,
           NULL::text   AS pgroup,    NULL::uuid AS rep_play,
           NULL::uuid[] AS rep_plays,  NULL::int  AS n_plays,
           NULL::int    AS n_games,    NULL::date AS from_at,
           NULL::date   AS to_at,      NULL::uuid AS rep_game,
           NULL::text   AS rep_name,   NULL::text AS rep_thumb,
           NULL::uuid   AS rep_batch,
           be.id                  AS e_id
    FROM boardgamebuddy_buddy_edges be
    WHERE be.status = 'pending'
      AND be.requested_by <> p_viewer
      AND (be.user_a = p_viewer OR be.user_b = p_viewer)
  ),
  -- Somebody said yes. Keyed on accepted_by, never on requested_by: a QR
  -- scan writes an edge born accepted with requested_by = the scanner, so a
  -- requested_by rule would tell the scanner about a request they never sent.
  -- `accepted_by <> p_viewer` is what stops the feed announcing an act the
  -- viewer performed themselves.
  accepted_rows AS (
    SELECT 'acc:' || be.id::text  AS ekey,
           'buddy_accepted'::text AS nkind,
           be.accepted_at         AS occ,
           be.accepted_at > COALESCE(v_seen, '-infinity'::timestamptz) AS unr,
           be.accepted_by         AS act_id,
           NULL::text   AS act_name,
           NULL::text   AS pgroup,    NULL::uuid AS rep_play,
           NULL::uuid[] AS rep_plays,  NULL::int  AS n_plays,
           NULL::int    AS n_games,    NULL::date AS from_at,
           NULL::date   AS to_at,      NULL::uuid AS rep_game,
           NULL::text   AS rep_name,   NULL::text AS rep_thumb,
           NULL::uuid   AS rep_batch,
           be.id                  AS e_id
    FROM boardgamebuddy_buddy_edges be
    WHERE be.status = 'accepted'
      AND be.accepted_at IS NOT NULL
      AND be.accepted_by IS NOT NULL
      AND be.accepted_by <> p_viewer
      AND (be.user_a = p_viewer OR be.user_b = p_viewer)
  ),
  -- A play that passed to the viewer because the account that logged it was
  -- deleted. The fourth kind, and the only one with no actor to join to
  -- — the person IS the actor and their profile row is gone, which is the
  -- whole event. So the name rides up the union in act_name and the final
  -- SELECT coalesces it against the join that is going to miss. That is what
  -- keeps RETURNS TABLE unchanged and this a REPLACE rather than a DROP.
  --
  -- One row per play and no grouping, deliberately: the import groupings that
  -- play_link uses answer "these twelve arrived together", and a handover is
  -- not a batch — the plays it moves need have nothing to do with each other
  -- beyond the person who is gone.
  inherited_rows AS (
    SELECT 'inh:' || p.id::text     AS ekey,
           'play_inherited'::text   AS nkind,
           p.inherited_at           AS occ,
           p.inherited_at > COALESCE(v_seen, '-infinity'::timestamptz) AS unr,
           NULL::uuid               AS act_id,
           p.inherited_from_name    AS act_name,
           NULL::text               AS pgroup,
           p.id                     AS rep_play,
           ARRAY[p.id]::uuid[]      AS rep_plays,
           1::int                   AS n_plays,
           1::int                   AS n_games,
           p.played_at              AS from_at,
           p.played_at              AS to_at,
           p.game_id                AS rep_game,
           -- Same catalog fallback play_rows uses: the denormalized pair is
           -- null on older rows.
           COALESCE(p.game_name, g.name)                    AS rep_name,
           COALESCE(p.game_thumbnail_url, g.thumbnail_url)  AS rep_thumb,
           NULL::uuid               AS rep_batch,
           NULL::uuid               AS e_id
    FROM boardgamebuddy_plays p
    LEFT JOIN boardgamebuddy_games g ON g.id = p.game_id
    WHERE p.user_id = p_viewer
      AND p.inherited_at IS NOT NULL
  ),
  merged AS (
    SELECT * FROM play_rows
    UNION ALL SELECT * FROM request_rows
    UNION ALL SELECT * FROM accepted_rows
    UNION ALL SELECT * FROM inherited_rows
  )
  SELECT m.ekey, m.nkind, m.occ, m.unr,
         -- The coalesce is for play_inherited alone: every other kind has a
         -- live profile behind act_id, and that arm has no act_id at all.
         m.act_id, COALESCE(pr.display_name, m.act_name), pr.username, pr.avatar,
         m.pgroup, m.rep_play, m.rep_plays, m.n_plays, m.n_games,
         m.from_at, m.to_at, m.rep_game, m.rep_name, m.rep_thumb, m.rep_batch,
         m.e_id
  FROM merged m
  LEFT JOIN boardgamebuddy_profiles pr ON pr.id = m.act_id
  -- Keyset, not OFFSET: rows vanish from under the cursor as the user unlinks
  -- and as requests are answered, and an offset would skip whatever slid up
  -- into the gap. Still applied here over the whole union — page_keys has
  -- already applied the identical predicate to the play arm, which is a
  -- redundancy on that arm and the only filter the two buddy arms get.
  WHERE p_before IS NULL
     OR (m.occ, m.ekey) < (p_before, COALESCE(p_before_key, ''))
  ORDER BY m.occ DESC, m.ekey DESC
  LIMIT v_lim;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_notifications(p_viewer uuid, p_limit integer, p_before timestamp with time zone, p_before_key text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_notifications(p_viewer uuid, p_limit integer, p_before timestamp with time zone, p_before_key text) TO boardgamebuddy_role;

CREATE OR REPLACE FUNCTION public.bgb_notifications_unread(p_viewer uuid)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_seen TIMESTAMPTZ;
  v_n    INT;
BEGIN
  SELECT pr.link_notifications_seen_at INTO v_seen
  FROM boardgamebuddy_profiles pr WHERE pr.id = p_viewer;
  -- Both a NULL column and a missing profile row mean "has read nothing".
  v_seen := COALESCE(v_seen, '-infinity'::timestamptz);

  SELECT
      -- Play ENTRIES, not plays: a badge reading 214 over a list showing one
      -- row is a bug that only appears on the accounts that most need this
      -- feature. Same key expression bgb_notifications groups by, below.
      (SELECT COUNT(*)::int FROM (
         SELECT 1
         FROM boardgamebuddy_play_players pp
         JOIN boardgamebuddy_plays p ON p.id = pp.play_id
         WHERE pp.player_user_id = p_viewer
           AND pp.linked_at > v_seen
           AND pp.seen_at IS NULL
           AND p.user_id <> p_viewer
         GROUP BY CASE
                    WHEN p.import_batch_id IS NOT NULL THEN 'b:' || p.import_batch_id::text
                    WHEN p.import_group_id IS NOT NULL THEN 'g:' || p.import_group_id::text
                    ELSE 'a:' || p.user_id::text || ':'
                         || to_char(pp.linked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
                  END
       ) e)
      -- The two buddy terms are plain row counts: an edge is already one row
      -- per event. One account's pending and accepted sets are small, which is
      -- why they have no index of their own.
    + (SELECT COUNT(*)::int
         FROM boardgamebuddy_buddy_edges be
        WHERE be.status = 'pending'
          AND be.requested_by <> p_viewer
          AND (be.user_a = p_viewer OR be.user_b = p_viewer)
          AND be.created_at > v_seen)
    + (SELECT COUNT(*)::int
         FROM boardgamebuddy_buddy_edges be
        WHERE be.status = 'accepted'
          AND be.accepted_at IS NOT NULL
          AND be.accepted_by IS NOT NULL
          AND be.accepted_by <> p_viewer
          AND (be.user_a = p_viewer OR be.user_b = p_viewer)
          AND be.accepted_at > v_seen)
      -- A play handed over by a deleted account. One row per play, no
      -- grouping: a handover is not a batch and two of them are two events.
      -- Rides idx_bgb_plays_inherited, so an account that has never inherited
      -- anything — which is almost all of them — scans nothing.
    + (SELECT COUNT(*)::int
         FROM boardgamebuddy_plays p
        WHERE p.user_id = p_viewer
          AND p.inherited_at IS NOT NULL
          AND p.inherited_at > v_seen)
    INTO v_n;

  RETURN v_n;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_notifications_unread(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_notifications_unread(p_viewer uuid) TO boardgamebuddy_role;

COMMIT;
