-- ─────────────────────────────────────────────────────────────────────────────
-- 049_account_deletion_handover.sql — one person's deletion stops rewriting
--                                     everybody else's history
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Deleting an account CASCADEs boardgamebuddy_plays.user_id, and play_players
-- cascades off play_id. So deleting the person who LOGGED a game night deletes
-- the night — and with it the seat of every other BoardgameBuddy account who
-- was at that table. They lose a play, a win, a "played with" edge and
-- achievement progress, for an act they had no part in. (Their earned badges
-- survive: bgb_sync_achievements reads the unlock row, not the metric. So the
-- badge stays while the bar underneath it drops below the threshold, which
-- reads as a bug in the badge.)
--
-- THE SEAT HALF OF THIS IS ALREADY SOLVED, and that is the shape of the fix.
-- play_players.player_user_id is ON DELETE SET NULL, not CASCADE; every writer
-- puts player_display_name on every seat including real accounts
-- (_write_play_players calls player_user_id "the one key that IS conditional");
-- and every reader is already COALESCE(profile.display_name,
-- pp.player_display_name). So a deleted account's seat on SOMEBODY ELSE'S play
-- already degrades into a named ghost, with no code anywhere to change.
--
-- What has no such fallback is plays.user_id. A play needs an author — the
-- feed's card is built on an INNER JOIN to the logger's profile
-- (bgb_feed_plays), the edit/delete gates are `plays.user_id = caller`, and
-- bgb_link_ghost_rows scopes itself by it. NULLing it would drop the play out
-- of every feed while its seats sat there intact, which is a stranger failure
-- than deleting it.
--
-- So the play is HANDED OVER rather than orphaned: it passes to another
-- BoardgameBuddy account that was at that table. Nothing else about the row
-- changes. A play with no other account seated is the deleted person's own
-- data and still goes.
--
-- ── WHO INHERITS ─────────────────────────────────────────────────────────────
--
-- The seated account with the earliest play_players.linked_at, tie-broken on
-- the uid so the choice is deterministic and a re-run picks the same person.
-- linked_at already means "when this person was seated", so this reads as the
-- longest-standing participant rather than an arbitrary pick.
--
-- ── WHAT THE HEIR GAINS, STATED PLAINLY ──────────────────────────────────────
--
-- Edit and delete rights over a record they did not write, because
-- plays.user_id is the ONLY ownership gate there is. The play enters their own
-- log (bgb_plays_page's p_own_only filters on it), two logger-only achievement
-- metrics tick up for notes they did not write (plays_with_notes,
-- plays_with_grid), and they inherit the deleted person's ghost roster on that
-- play. That is a real transfer of authority and it is why inherited_at exists
-- and why the notification below exists: the alternative was doing all of it
-- silently.
--
-- ── THE COLLISION THAT WOULD ABORT THE WHOLE DELETE ──────────────────────────
--
-- Three unique indexes on plays are per-owner: (user_id, client_key),
-- (user_id, bgg_play_id) and (user_id, bga_table_id). Handing a play to an
-- account that already holds a row on the same key is a unique violation, and
-- since this all runs in one transaction that violation aborts the ACCOUNT
-- DELETION — the user is told their deletion failed, forever, and nothing says
-- why.
--
-- This is not hypothetical. bga_table_id is the case: two people at Board Game
-- Arena table 12345 who both import it each get a play carrying 12345, so A's
-- play cannot move to B. The fix is not to drop the key — it is that a
-- colliding heir is simply not a candidate. The play goes to the next seated
-- account instead, and only if EVERY candidate collides does it fall through
-- to the cascade. Which is the right answer anyway: an heir who already holds
-- a row for the same BGA table already has that night in their history.
--
-- ── THE LATENT BUG THIS ALSO FIXES ───────────────────────────────────────────
--
-- bgb_play_players_identity_chk demands player_user_id IS NOT NULL OR
-- player_display_name IS NOT NULL. bgg_link_routes can write a seat with an
-- account id and a NULL name (`"player_display_name": owner_name or None`).
-- When that account is deleted the FK's SET NULL leaves the row with neither,
-- and a CHECK is evaluated on a referential-action UPDATE — so the DELETE
-- raises and account deletion 500s, for a row written years earlier by an
-- unrelated code path.
--
-- bgb_ghost_out_of_plays has carried the guard for this since 008, for the
-- by-hand version of the same act. The backfill below is the same expression,
-- and it runs BEFORE the profile delete, which is the only time it can.
--
-- ── WHAT THIS DELIBERATELY DOES NOT TOUCH ────────────────────────────────────
--
-- Live sessions. play_sessions.host_user_id stays NOT NULL / CASCADE. A
-- session expires two hours after it is opened and finalizes into a play, and
-- the play is the thing worth keeping; a lobby whose host deleted their account
-- mid-game is not a scenario worth the RLS surgery. Note that the policies on
-- the live-scoring tables are host-only and browser-direct, so a NULL host
-- would fail them closed while bgb_session_gate's `host_user_id <> p_host`
-- would evaluate NULL and fail OPEN — every caller a host. Leaving CASCADE
-- alone avoids both.
--
-- The deleted person's seats stay claimable. They are ordinary ghosts now, so
-- another account can claim the name through bgb_link_ghost_rows and absorb
-- those seats. Marking them would take a column and a branch in
-- player-row-action.js; it was considered and declined.
--
-- ── WHICH FUNCTIONS THIS RE-EMITS ────────────────────────────────────────────
--
-- Two, both copied from their CURRENT definition, which is 010 and not 009 —
-- 048's header is the standing warning about getting this wrong: CREATE OR
-- REPLACE is happy to install a function that has quietly lost a feature, and
-- nothing raises.
--
--   bgb_notifications        ← 010_notifications_perf.sql  (fourth arm)
--   bgb_notifications_unread ← 010_notifications_perf.sql  (fourth term)
--
-- Both keep their signatures exactly, so both are a plain CREATE OR REPLACE.
-- The new kind carries the former owner's name in actor_display_name rather
-- than in a column of its own — the actor IS the deleted person, they simply
-- have no profile row to join to any more, so the final SELECT coalesces the
-- join's NULL against a name carried up through the union. That is what keeps
-- RETURNS TABLE unchanged and this migration a replace rather than a drop.
--
-- Re-runnable: every statement is IF NOT EXISTS, CREATE OR REPLACE, or an
-- UPDATE guarded on the state it changes.


-- ── 1. The two columns ───────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_plays
  ADD COLUMN IF NOT EXISTS inherited_at TIMESTAMPTZ;

ALTER TABLE public.boardgamebuddy_plays
  ADD COLUMN IF NOT EXISTS inherited_from_name TEXT;

COMMENT ON COLUMN public.boardgamebuddy_plays.inherited_at IS
  'When this play changed hands because its logger deleted their account '
  '(migration 049). NULL on every play whose author still owns it, which is '
  'almost all of them. Two jobs: it drives the play_inherited notification, '
  'and it is the standing audit trail for "the current owner did not write '
  'this" — worth knowing before trusting plays.user_id as authorship.';

COMMENT ON COLUMN public.boardgamebuddy_plays.inherited_from_name IS
  'The display name of the account this play came from, captured at deletion '
  '(migration 049). Denormalized because the profile it names is gone by the '
  'time anything reads this — there is nothing left to join to. Carried into '
  'bgb_notifications as actor_display_name.';

-- Partial, and on (user_id, inherited_at DESC) because both notification
-- functions ask exactly that: this viewer's inherited plays, newest first, or
-- newer than a watermark. The predicate keeps it to the handful of rows that
-- have ever changed hands rather than one entry per play in the database.
CREATE INDEX IF NOT EXISTS idx_bgb_plays_inherited
  ON public.boardgamebuddy_plays USING btree (user_id, inherited_at DESC)
  WHERE (inherited_at IS NOT NULL);


-- ── 2. The deletion itself ───────────────────────────────────────────────────
--
-- ONE FUNCTION, ONE TRANSACTION, and that is the point of it existing at all.
-- The API used to delete the profile row directly. Doing the handover from
-- Python would mean several round trips with no transaction around them, and
-- a failure between "reassigned the plays" and "deleted the profile" would
-- leave plays owned by other people while the account they were taken from is
-- still signed in and still holds them in its own log. Here, either all of it
-- lands or none of it does.
--
-- The photo unlink is in here rather than in the caller for the same reason,
-- even though the caller is what actually deletes the objects: the URL has to
-- stop pointing at a deleted file in the same breath as the play survives.
--
-- IDEMPOTENT. The caller retries this after a partial failure, and a second
-- run finds no profile, matches nothing, deletes nothing and returns zeros.
CREATE OR REPLACE FUNCTION public.bgb_delete_account_rows(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name        TEXT;
  v_photos      INT := 0;
  v_names       INT := 0;
  v_reassigned  INT := 0;
  v_deleted     INT := 0;
BEGIN
  SELECT pr.display_name INTO v_name
  FROM boardgamebuddy_profiles pr WHERE pr.id = p_user;

  -- (a) Unlink photos whose objects the caller has already removed.
  --
  -- Matched on the URL rather than on user_id, and NOT restricted to this
  -- account's plays. The plays layout is `{user_id}/{uuid4hex}.{ext}`, which
  -- appears identically inside both the R2 and the Supabase Storage public
  -- URL, so this is exactly the set of objects that just went. Only the
  -- owner-gated PATCH can attach one, so in practice they are all on this
  -- account's own plays — but a row that pointed at a deleted object from
  -- anywhere else is a broken image either way, and matching the URL costs
  -- one scan of a small table and cannot be wrong. It also makes this
  -- statement independent of the reassignment below, so their order is free.
  --
  -- A uuid contains only hex and hyphens: no `%`, and no `_`, which is the
  -- LIKE wildcard that would otherwise need escaping here.
  UPDATE boardgamebuddy_plays
     SET photo_url = NULL
   WHERE photo_url LIKE '%/' || p_user::text || '/%';
  GET DIAGNOSTICS v_photos = ROW_COUNT;

  -- (b) Give every nameless seat of theirs a name, BEFORE anything nulls the
  -- account off it. See the header: without this the FK's SET NULL can leave a
  -- row failing bgb_play_players_identity_chk and abort the whole delete.
  -- Same expression as bgb_ghost_out_of_plays, including the 'Player' floor
  -- for an account whose own display_name is somehow blank.
  UPDATE boardgamebuddy_play_players pp
     SET player_display_name =
           COALESCE(NULLIF(btrim(COALESCE(v_name, '')), ''), 'Player')
   WHERE pp.player_user_id = p_user
     AND btrim(COALESCE(pp.player_display_name, '')) = '';
  GET DIAGNOSTICS v_names = ROW_COUNT;

  -- (c) Hand over every play that somebody else was also at.
  WITH candidates AS (
    SELECT p.id           AS play_id,
           pp.player_user_id AS heir,
           pp.linked_at   AS seated_at
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
     WHERE p.user_id = p_user
       AND pp.player_user_id IS NOT NULL
       AND pp.player_user_id <> p_user
       -- Not a candidate if the play would collide with one this account
       -- already holds on any of the three per-owner unique keys. See the
       -- header: BGA tables are the real case, and an heir who already has a
       -- row for the same table already has that night.
       AND NOT EXISTS (
             SELECT 1
               FROM boardgamebuddy_plays x
              WHERE x.user_id = pp.player_user_id
                AND (
                      (p.bgg_play_id  IS NOT NULL AND x.bgg_play_id  = p.bgg_play_id)
                   OR (p.bga_table_id IS NOT NULL AND x.bga_table_id = p.bga_table_id)
                   OR (p.client_key   IS NOT NULL AND x.client_key   = p.client_key)
                )
           )
  ),
  heirs AS (
    -- Earliest seated wins; the uid breaks the tie so a re-run picks the same
    -- person. DISTINCT ON needs the leading ORDER BY column to be the group.
    SELECT DISTINCT ON (c.play_id) c.play_id AS play_id, c.heir AS heir
      FROM candidates c
     ORDER BY c.play_id, c.seated_at ASC, c.heir ASC
  )
  UPDATE boardgamebuddy_plays p
     SET user_id             = h.heir,
         inherited_at        = now(),
         inherited_from_name = COALESCE(NULLIF(btrim(COALESCE(v_name, '')), ''), 'Player')
    FROM heirs h
   WHERE p.id = h.play_id;
  GET DIAGNOSTICS v_reassigned = ROW_COUNT;

  -- (d) Whatever is left was theirs alone, and goes with them.
  SELECT COUNT(*)::int INTO v_deleted
    FROM boardgamebuddy_plays WHERE user_id = p_user;

  -- (e) The profile, and every cascade hanging off it: collections, the
  -- remaining plays, buddies, buddy edges, sessions and participants,
  -- achievements, push subscriptions, pending imports, feedback, BGA links.
  -- Seats on the plays handed over in (c) are NOT among them — they take the
  -- FK's SET NULL and become named ghosts. Guide chapters they authored keep
  -- their text under a NULL created_by.
  DELETE FROM boardgamebuddy_profiles WHERE id = p_user;

  RETURN jsonb_build_object(
    'plays_reassigned', v_reassigned,
    'plays_deleted',    v_deleted,
    'photos_unlinked',  v_photos,
    'names_backfilled', v_names
  );
END;
$function$;

-- THE REVOKE IS NOT BOILERPLATE ON THIS ONE. A SECURITY DEFINER function is
-- published by PostgREST at /rest/v1/rpc/bgb_delete_account_rows and runs as
-- its owner, and the anon key that reaches it ships inside our frontend
-- bundle. Left at the CREATE-time default, this function — which takes the
-- account to destroy as its only argument — would let anybody delete
-- anybody's account by uuid. Naming PUBLIC alone is not enough: Supabase's
-- default privileges give anon and authenticated their own direct ACL
-- entries, which a FROM PUBLIC revoke leaves behind (see 028).
GRANT  EXECUTE ON FUNCTION public.bgb_delete_account_rows(p_user uuid) TO boardgamebuddy_role;
REVOKE EXECUTE ON FUNCTION public.bgb_delete_account_rows(p_user uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.bgb_delete_account_rows(p_user uuid) TO service_role;


-- ── 3. The bell learns a fourth kind ─────────────────────────────────────────
--
-- Both re-emitted from 010, which is their CURRENT definition — 009 defines
-- them too and is superseded. The diff in each is additive: one UNION ALL arm
-- and one summand.

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
      -- 009's reason for giving them no index of their own — that still holds.
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
      -- A play handed over by a deleted account (049). One row per play, no
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
GRANT  EXECUTE ON FUNCTION public.bgb_notifications_unread(p_viewer uuid) TO boardgamebuddy_role;
REVOKE EXECUTE ON FUNCTION public.bgb_notifications_unread(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.bgb_notifications_unread(p_viewer uuid) TO service_role;


CREATE OR REPLACE FUNCTION public.bgb_notifications(
  p_viewer     uuid,
  p_limit      int         DEFAULT 20,
  p_before     timestamptz DEFAULT NULL,
  p_before_key text        DEFAULT NULL
)
 RETURNS TABLE (
   entry_key text,
   kind text,                    -- 'play_link' | 'buddy_request' | 'buddy_accepted' | 'play_inherited'
   occurred_at timestamptz,
   is_unread boolean,
   actor_id uuid,
   actor_display_name text,
   actor_username text,
   actor_avatar jsonb,
   -- play_link only; NULL on both buddy kinds.
   play_group text,              -- 'batch' | 'run' | 'act'
   play_id uuid,
   play_ids uuid[],
   group_count int,
   game_count int,
   played_from date,
   played_to date,
   game_id uuid,
   game_name text,
   game_thumbnail_url text,
   import_batch_id uuid,
   -- buddy_request / buddy_accepted only; NULL on play_link. The id the client
   -- posts to /buddies/{id}/accept and /buddies/{id}/reject, so a row can be
   -- answered where it is read.
   edge_id uuid
 )
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
    -- to_char at UTC rather than l_at::text, unchanged from 009: the key is the
    -- paging tiebreak and travels to the client and back, so it has to mean the
    -- same thing on both ends of that trip regardless of the session's TimeZone
    -- and DateStyle.
    SELECT pp.play_id   AS p_id,
           pp.linked_at AS l_at,
           p.user_id    AS o_id,
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
    SELECT pk.k AS k, pk.kd AS kd, pk.o_id AS o_id, s.l_at AS l_at,
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
           -- game_name / game_thumbnail_url are denormalized (migration 020)
           -- and null on rows written before it, so fall back to the catalog
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
  -- Somebody said yes. Keyed on accepted_by, never on requested_by: see 009's
  -- rationale for that column for why the QR path makes the distinction
  -- load-bearing rather than pedantic. `accepted_by <> p_viewer` is what stops
  -- the feed announcing an act the viewer performed themselves.
  accepted_rows AS (
    SELECT 'acc:' || be.id::text  AS ekey,
           'buddy_accepted'::text AS nkind,
           be.accepted_at         AS occ,
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
  -- deleted (049). The fourth kind, and the only one with no actor to join to
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
           -- null on rows written before migration 020.
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
  SELECT m.ekey, m.nkind, m.occ,
         (m.occ > COALESCE(v_seen, '-infinity'::timestamptz)),
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
GRANT  EXECUTE ON FUNCTION public.bgb_notifications(p_viewer uuid, p_limit int, p_before timestamptz, p_before_key text) TO boardgamebuddy_role;
REVOKE EXECUTE ON FUNCTION public.bgb_notifications(p_viewer uuid, p_limit int, p_before timestamptz, p_before_key text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.bgb_notifications(p_viewer uuid, p_limit int, p_before timestamptz, p_before_key text) TO service_role;
