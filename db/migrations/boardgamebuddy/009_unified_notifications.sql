-- 009_unified_notifications.sql — the bell stops being about plays only.
--
-- 008 built a notifications screen for exactly one signal: "somebody put me in
-- a play". Two other things happen TO a boardgamebuddy account and were told to
-- the user nowhere near it — somebody sends you a buddy request (a dot on the
-- Profile tab, three taps away), and somebody accepts a request YOU sent (no
-- signal at all, ever). The one screen called Notifications carried neither.
--
-- This migration merges all three into one derived feed, one cursor, one unread
-- count.
--
-- STILL NO EVENTS TABLE, for 008's reason and one more. 008's argument was that
-- a "you were linked" row duplicates a fact play_players already holds, written
-- by four separate play-write paths and correct only if all four remember. The
-- buddy half is the same shape and stronger: boardgamebuddy_buddy_edges already
-- carries created_at (the ask) and accepted_at (the answer) on one row, so both
-- notifications are a WHERE clause away, they self-heal when an edge is
-- deleted, and an answered request leaves the pending list by construction —
-- which is what lets the client's inline Accept / Decline just drop the row.
--
--   play_link       play_players seat on a play someone else logged  → linked_at
--   buddy_request   edge status='pending',  requested_by <> viewer   → created_at
--   buddy_accepted  edge status='accepted', accepted_by  <> viewer   → accepted_at
--
-- 'blocked' edges match neither predicate, so blocking a pair removes both its
-- rows from the feed by construction. There is no exclusion clause to keep in
-- sync — that is the whole rule.
--
-- WHAT IS NOT RENAMED: boardgamebuddy_profiles.link_notifications_seen_at. It
-- is the watermark for the whole bell now rather than for plays alone, and the
-- honest name would be notifications_seen_at — but the rename buys nothing a
-- comment cannot, and it would change a key inside bgb_bootstrap's current_user
-- blob (built as to_jsonb(p.*)) for no reader's benefit. The COMMENT below is
-- the rename.
COMMENT ON COLUMN public.boardgamebuddy_profiles.link_notifications_seen_at IS
  'Read watermark for the WHOLE notification bell — plays you were seated in, '
  'buddy requests received, and requests of yours that were accepted — not just '
  'link notifications, despite the name. Written by '
  'bgb_mark_link_notifications_seen; read by bgb_notifications and '
  'bgb_notifications_unread (migration 009).';


-- ── accepted_by: who said yes ────────────────────────────────────────────────
-- The cheap answer is to derive the acceptor as "whichever party is not
-- requested_by" and add no column. It is wrong, and it is wrong on the path
-- this feature would embarrass itself on first.
--
-- buddy_qr_service.add_buddy_mutually writes an edge that is BORN accepted:
-- status='accepted', requested_by=<the scanner>, accepted_at=now, in one
-- INSERT. Nobody ever sent a request. Under a requested_by rule the scanner is
-- told "X accepted your buddy request" for a request they never sent, while the
-- person whose code was scanned — the only one who actually learned something —
-- is told nothing at all.
--
-- One nullable column fixes both directions and removes requested_by from the
-- rule entirely:
--
--   request path   A asks, B accepts   accepted_by = B  → A is told, B is not
--   QR path        S scans O's code    accepted_by = S  → O is told, S is not
--
-- Three writers set it, all with the acting viewer: buddy_service._accept_edge,
-- and both accept paths in buddy_qr_service (the born-accepted INSERT and
-- _resolve_existing's promotion of a pending edge).
ALTER TABLE public.boardgamebuddy_buddy_edges
  ADD COLUMN IF NOT EXISTS accepted_by UUID
  REFERENCES public.boardgamebuddy_profiles(id) ON DELETE SET NULL;

-- Backfill only where the data can support the claim.
--
-- An edge whose accepted_at differs from its created_at went through the
-- request path, so the acceptor is the party that is not the requester. An edge
-- where the two are equal was born accepted by a QR scan — there was no
-- acceptance, and inventing one would put a sentence on the screen that never
-- happened. Those stay NULL and simply never produce a notification.
--
-- Either way this is history, and history is already forgiven: the watermark
-- 008 backfilled to now() means nothing here can light the bell. It only
-- decides what the LIST says about the past.
UPDATE public.boardgamebuddy_buddy_edges
   SET accepted_by = CASE WHEN requested_by = user_a THEN user_b ELSE user_a END
 WHERE status = 'accepted'
   AND accepted_by IS NULL
   AND accepted_at IS NOT NULL
   AND accepted_at IS DISTINCT FROM created_at;


-- ── No new indexes, deliberately ─────────────────────────────────────────────
-- Both buddy sources filter (user_a = viewer OR user_b = viewer) AND status,
-- which is exactly what idx_bgb_buddy_edges_user_a (user_a, status) and
-- idx_bgb_buddy_edges_user_b (user_b, status) already cover via a BitmapOr.
-- What they do not give is created_at / accepted_at order — and one account's
-- pending and accepted sets are small enough that sorting them is free, whereas
-- two more partial indexes would cost every write on the buddy graph. If this
-- ever needs index-order scans, the shape is (user_a, created_at DESC) WHERE
-- status = 'pending' plus its user_b twin, AND the two branches below must be
-- split into separate UNION ALL arms — a single OR can never produce index
-- order. Not earned yet.


-- ── bgb_notifications ────────────────────────────────────────────────────────
-- One page of the merged feed, newest first.
--
-- The play_link half is 008's bgb_link_notifications pipeline unchanged — seats
-- → keyed → entries — grouping a whole imported batch, a run of identical
-- plays, or one retroactive ghost-link into a SINGLE row, so a 214-play import
-- is one line with one tick box rather than 214 lines. That grouping is the
-- difference between the screen being usable and being the same chore in a new
-- place. None of it applies to a buddy edge, which is already one row per event.
--
-- THE PERSON COLUMN IS actor_*, NOT 008's owner_*. On a play row they own the
-- play; on a buddy row they own nothing, they did something. One name for
-- "whoever this is about" is what lets one LEFT JOIN after the union serve all
-- three kinds, and what lets the client render an avatar without branching on
-- kind first. `kind` is likewise now the NOTIFICATION kind; 008's
-- batch/run/act moves to play_group.
--
-- Every CTE column is aliased away from the RETURNS TABLE names on purpose:
-- plpgsql puts each output column in scope as a variable, so a bare `play_id`
-- or `kind` inside the query is ambiguous and fails at runtime rather than at
-- create time. 008 has the same discipline; keep it if you edit this.
--
-- ── The cursor is a TUPLE, which 008's was not ───────────────────────────────
-- 008 ordered on (l_at DESC, k) but paged on l_at < p_before alone, so a tie at
-- a page boundary silently dropped every row sharing that timestamp. It was
-- nearly unreachable there because the `act` key CONTAINS the timestamp, so
-- equal-timestamp play rows collapsed into one entry instead of tying. Three
-- sources feeding one ordering removes that accident. Hence (occurred_at,
-- entry_key) < (p_before, p_before_key), and hence entry_key DESC rather than
-- 008's ASC: a row-wise comparison only matches the ordering when both columns
-- sort the same way. A client that sends only a timestamp gets COALESCE(…, '')
-- and therefore exactly 008's behaviour.
CREATE OR REPLACE FUNCTION public.bgb_notifications(
  p_viewer     uuid,
  p_limit      int         DEFAULT 20,
  p_before     timestamptz DEFAULT NULL,
  p_before_key text        DEFAULT NULL
)
 RETURNS TABLE (
   entry_key text,
   kind text,                    -- 'play_link' | 'buddy_request' | 'buddy_accepted'
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
    -- The viewer's own seats on plays SOMEBODY ELSE logged. This is the whole
    -- visibility rule: every row is a play the viewer is a player in, so there
    -- is nothing to leak and no buddy-graph check to run.
    SELECT pp.linked_at AS l_at,
           p.id AS p_id, p.user_id AS o_id, p.game_id AS g_id,
           p.played_at AS p_at, p.game_name AS g_name,
           p.game_thumbnail_url AS g_thumb,
           p.import_batch_id AS b_id, p.import_group_id AS r_id
    FROM boardgamebuddy_play_players pp
    JOIN boardgamebuddy_plays p ON p.id = pp.play_id
    WHERE pp.player_user_id = p_viewer
      AND p.user_id <> p_viewer
  ),
  keyed AS (
    -- to_char at UTC rather than 008's l_at::text. The key was grouping-only
    -- there, so a rendering that follows the session's TimeZone and DateStyle
    -- was harmless. It is the paging tiebreak now and travels to the client
    -- and back, so it has to mean the same thing on both ends of that trip.
    SELECT s.*,
           CASE
             WHEN s.b_id IS NOT NULL THEN 'b:' || s.b_id::text
             WHEN s.r_id IS NOT NULL THEN 'g:' || s.r_id::text
             ELSE 'a:' || s.o_id::text || ':'
                  || to_char(s.l_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
           END AS k,
           CASE
             WHEN s.b_id IS NOT NULL THEN 'batch'
             WHEN s.r_id IS NOT NULL THEN 'run'
             ELSE 'act'
           END AS kd
    FROM seats s
  ),
  entries AS (
    SELECT k.k, k.kd, k.o_id,
           MAX(k.l_at)                    AS l_at,
           COUNT(*)::int                  AS n_plays,
           COUNT(DISTINCT k.g_id)::int    AS n_games,
           MIN(k.p_at)                    AS from_at,
           MAX(k.p_at)                    AS to_at,
           array_agg(k.p_id ORDER BY k.p_at DESC NULLS LAST, k.p_id) AS ids,
           -- No MIN()/MAX() aggregate exists for uuid, so the representative is
           -- picked by ordering rather than aggregated. It is the most recent
           -- play in the entry — the one the card names and opens.
           (array_agg(k.p_id    ORDER BY k.p_at DESC NULLS LAST, k.p_id))[1] AS rep,
           (array_agg(k.g_id    ORDER BY k.p_at DESC NULLS LAST, k.p_id))[1] AS rep_game,
           (array_agg(k.g_name  ORDER BY k.p_at DESC NULLS LAST, k.p_id))[1] AS rep_name,
           (array_agg(k.g_thumb ORDER BY k.p_at DESC NULLS LAST, k.p_id))[1] AS rep_thumb,
           (array_agg(k.b_id    ORDER BY k.p_at DESC NULLS LAST, k.p_id))[1] AS rep_batch
    FROM keyed k
    GROUP BY k.k, k.kd, k.o_id
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
  -- Somebody said yes. Keyed on accepted_by, never on requested_by: see the
  -- column's rationale above for why the QR path makes that distinction load-
  -- bearing rather than pedantic. `accepted_by <> p_viewer` is what stops the
  -- feed announcing an act the viewer performed themselves.
  accepted_rows AS (
    SELECT 'acc:' || be.id::text  AS ekey,
           'buddy_accepted'::text AS nkind,
           be.accepted_at         AS occ,
           be.accepted_by         AS act_id,
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
  merged AS (
    SELECT * FROM play_rows
    UNION ALL SELECT * FROM request_rows
    UNION ALL SELECT * FROM accepted_rows
  )
  SELECT m.ekey, m.nkind, m.occ,
         (m.occ > COALESCE(v_seen, '-infinity'::timestamptz)),
         m.act_id, pr.display_name, pr.username, pr.avatar,
         m.pgroup, m.rep_play, m.rep_plays, m.n_plays, m.n_games,
         m.from_at, m.to_at, m.rep_game, m.rep_name, m.rep_thumb, m.rep_batch,
         m.e_id
  FROM merged m
  LEFT JOIN boardgamebuddy_profiles pr ON pr.id = m.act_id
  -- Keyset, not OFFSET: rows vanish from under the cursor as the user unlinks
  -- and as requests are answered, and an offset would skip whatever slid up
  -- into the gap.
  WHERE p_before IS NULL
     OR (m.occ, m.ekey) < (p_before, COALESCE(p_before_key, ''))
  ORDER BY m.occ DESC, m.ekey DESC
  LIMIT v_lim;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_notifications(p_viewer uuid, p_limit int, p_before timestamptz, p_before_key text) TO boardgamebuddy_role;


-- ── bgb_notifications_unread ─────────────────────────────────────────────────
-- The bell's count: the same three sources against the same watermark, summed.
--
-- The play term counts ENTRIES on exactly the key bgb_notifications groups by —
-- a badge reading 214 over a list showing one row is a bug that only appears on
-- the accounts that most need this feature. The two buddy terms are plain row
-- counts, because a buddy edge is already one row per event.
--
-- It is written as GROUP BY … HAVING MAX(linked_at) > seen rather than as 008's
-- COUNT(DISTINCT key) … WHERE linked_at > seen. The two are equivalent — "some
-- member row is newer than the watermark" and "the newest member row is newer"
-- say the same thing, verified against batches whose members straddle the
-- watermark — so this is not a fix. It is written this way because the list
-- computes is_unread from MAX(linked_at) per entry, and the count now computes
-- it from the same expression rather than from a second one that happens to
-- agree. The badge and the rail cannot drift apart under a later edit.
--
-- ON 008's BACKFILL: it set link_notifications_seen_at = now() for every
-- account that existed then, so buddy requests and acceptances older than that
-- deploy are LISTED but not UNREAD. 009 does not re-backfill and does not
-- change that. It is the same forgiveness 008 applied to play history and it is
-- right for the same reason — opening the app to a badge of forty for things
-- resolved months ago is not a notification, it is noise, and it teaches people
-- to ignore the dot. Nothing is hidden: every one of those rows is on screen.
CREATE OR REPLACE FUNCTION public.bgb_notifications_unread(p_viewer uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH w AS (
    SELECT COALESCE(
             (SELECT pr.link_notifications_seen_at
                FROM boardgamebuddy_profiles pr WHERE pr.id = p_viewer),
             '-infinity'::timestamptz) AS at
  ),
  plays AS (
    SELECT COUNT(*)::int AS n FROM (
      SELECT CASE
               WHEN p.import_batch_id IS NOT NULL THEN 'b:' || p.import_batch_id::text
               WHEN p.import_group_id IS NOT NULL THEN 'g:' || p.import_group_id::text
               ELSE 'a:' || p.user_id::text || ':'
                    || to_char(pp.linked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
             END AS k
      FROM boardgamebuddy_play_players pp
      JOIN boardgamebuddy_plays p ON p.id = pp.play_id
      WHERE pp.player_user_id = p_viewer
        AND p.user_id <> p_viewer
      GROUP BY 1
      HAVING MAX(pp.linked_at) > (SELECT at FROM w)
    ) e
  ),
  reqs AS (
    SELECT COUNT(*)::int AS n
    FROM boardgamebuddy_buddy_edges be
    WHERE be.status = 'pending'
      AND be.requested_by <> p_viewer
      AND (be.user_a = p_viewer OR be.user_b = p_viewer)
      AND be.created_at > (SELECT at FROM w)
  ),
  accs AS (
    SELECT COUNT(*)::int AS n
    FROM boardgamebuddy_buddy_edges be
    WHERE be.status = 'accepted'
      AND be.accepted_at IS NOT NULL
      AND be.accepted_by IS NOT NULL
      AND be.accepted_by <> p_viewer
      AND (be.user_a = p_viewer OR be.user_b = p_viewer)
      AND be.accepted_at > (SELECT at FROM w)
  )
  SELECT (SELECT n FROM plays) + (SELECT n FROM reqs) + (SELECT n FROM accs);
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_notifications_unread(p_viewer uuid) TO boardgamebuddy_role;


-- ── Retire the play-only pair ────────────────────────────────────────────────
-- Dropped rather than left in place. bgb_notifications necessarily contains a
-- COPY of 008's seats → keyed → entries pipeline; if the old function survives,
-- two definitions of the same grouping key exist and have to be edited together
-- forever. 008 already shows what happens when that discipline slips — the
-- list/count divergence fixed above shipped inside a single migration.
--
-- bgb_mark_link_notifications_seen STAYS. It writes the watermark and never
-- knew which kinds it covered, so it needed no change to cover three.
--
-- DEPLOY ORDER. Migrations here are applied by hand, so the new backend needs
-- bgb_notifications to exist before it serves a request and the old backend
-- needs bgb_link_notifications until it stops. Either run this whole file and
-- accept the few minutes in which the old backend's /link-notifications 500s
-- (which is what was done), or run everything above this line, deploy, and come
-- back for the two DROPs.
DROP FUNCTION IF EXISTS public.bgb_link_notifications(uuid, int, timestamptz);
DROP FUNCTION IF EXISTS public.bgb_link_notifications_unread(uuid);
