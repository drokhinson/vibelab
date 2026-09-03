-- 010_notifications_perf.sql — the bell answers without reading your whole history.
--
-- Nothing about WHAT the notification feed contains changes here. 009's three
-- sources, its grouping, its tuple cursor and its watermark all stand. What
-- changes is how much of the account both functions touch to produce twenty
-- rows and one integer, because as written each of them reads every seat the
-- viewer has ever held.
--
-- The two are not equally bad, and the cheap one is the one that hurts:
--
--   bgb_notifications_unread runs on EVERY app boot (the /bootstrap gather) and
--   is what lights the dot. It grouped the viewer's entire seat history and
--   then threw away every group with HAVING MAX(linked_at) > watermark. An
--   account that has read everything paid a full scan to be told "zero".
--
--   bgb_notifications runs when the bell is opened. It ran array_agg (four of
--   them, each with its own ORDER BY), COUNT(DISTINCT), and a join to the game
--   catalog over EVERY entry the account has, then LIMIT 20 discarded almost
--   all of it. On the accounts this screen exists for — the ones somebody has
--   imported two hundred plays into — that is the difference between a screen
--   that opens and a screen the user watches a spinner on.
--
-- Both fixes are rewrites of the same shape: do the narrow, index-driven pass
-- FIRST, and let the expensive work see only the rows that survive it. Neither
-- changes a single output value; both are equivalences, argued below.
--
-- NO NEW INDEXES, and this time because the right one is already there.
-- idx_bgb_play_players_user_linked is (player_user_id, linked_at DESC) partial
-- on player_user_id IS NOT NULL — exactly the range scan both rewrites now ask
-- for. 008 built it for the list's ordering; the unread count simply never used
-- it, because its predicate was on an aggregate rather than on a column.


-- ── bgb_notifications_unread ─────────────────────────────────────────────────
-- The watermark moves from HAVING to WHERE. That is the whole change, and it is
-- an equivalence rather than a fix:
--
--   an entry is unread  ⇔  MAX(linked_at) over its members > watermark
--                       ⇔  SOME member has linked_at > watermark
--
-- so grouping ONLY the members newer than the watermark yields exactly the same
-- set of keys, and its cardinality is exactly the same count. What differs is
-- that `pp.linked_at > v_seen` is a plain column predicate the planner can push
-- into idx_bgb_play_players_user_linked, so the common case — an account that
-- has read everything — scans zero index entries instead of every seat it owns.
-- Only rows newer than the watermark are ever touched, which is the only thing
-- the answer depends on.
--
-- 009's comment on this function argued for HAVING MAX(...) on the grounds that
-- it is the same expression the list's is_unread column uses, so the badge and
-- the rail cannot drift apart under a later edit. That argument is preserved,
-- not discarded: the equivalence above is the reason the two still agree, and
-- it is written out here so the next editor has it. Both remain "is any member
-- of this entry newer than the watermark".
--
-- The watermark is read into a variable rather than left as an inline
-- sub-select, which is why this becomes plpgsql. An InitPlan would very likely
-- be folded into the index condition anyway, but "very likely" is not a
-- guarantee, and this function's whole point is now that the predicate IS the
-- index condition.
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
    INTO v_n;

  RETURN v_n;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_notifications_unread(p_viewer uuid) TO boardgamebuddy_role;


-- ── bgb_notifications ────────────────────────────────────────────────────────
-- Same feed, same grouping, same cursor. The pipeline gains one stage:
--
--   009:  seats → keyed → entries(HEAVY, all of them) → union → order → limit
--   010:  seats(narrow) → page_keys(cheap, LIMIT) → members → entries(HEAVY, ≤20)
--                                                → union → order → limit
--
-- WHY THIS IS THE SAME ANSWER. The final SELECT takes the top v_lim of the
-- union by (occ, ekey) DESC. A play entry can only appear there if it is among
-- the top v_lim PLAY entries by that same ordering — adding the buddy arms can
-- only push play rows out, never pull a lower one in. page_keys computes
-- exactly that top-v_lim set, ordered and cursor-filtered on the identical
-- expressions, so every play entry the old query could have returned is still a
-- candidate and no other is.
--
-- The cursor lives in page_keys' HAVING rather than in its WHERE, and that
-- placement is load-bearing. An entry's occurred_at is MAX(linked_at) over its
-- members, so filtering MEMBERS by linked_at < p_before would silently shrink
-- group_count on any entry that straddles the boundary — the tick box would
-- then offer to remove the user from fewer plays than the row names. Filtering
-- GROUPS on MAX(...) is the same predicate the old query applied after the fact.
--
-- `seats` is deliberately narrow — key, kind, owner, timestamp, play id, and
-- nothing else. It is referenced twice so Postgres materializes it, and the
-- whole point is that the tuplestore holds five small columns per seat rather
-- than game names and thumbnail URLs for a history nobody asked to see. The
-- wide columns are fetched in `members`, by primary key, for the handful of
-- plays that actually made the page.
--
-- Every CTE column is still aliased away from the RETURNS TABLE names: plpgsql
-- puts each output column in scope as a variable, so a bare `play_id` or `kind`
-- inside the query is ambiguous and fails at runtime rather than at create
-- time. Keep that discipline if you edit this.
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
  -- Somebody said yes. Keyed on accepted_by, never on requested_by: see 009's
  -- rationale for that column for why the QR path makes the distinction
  -- load-bearing rather than pedantic. `accepted_by <> p_viewer` is what stops
  -- the feed announcing an act the viewer performed themselves.
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
  -- into the gap. Still applied here over the whole union — page_keys has
  -- already applied the identical predicate to the play arm, which is a
  -- redundancy on that arm and the only filter the two buddy arms get.
  WHERE p_before IS NULL
     OR (m.occ, m.ekey) < (p_before, COALESCE(p_before_key, ''))
  ORDER BY m.occ DESC, m.ekey DESC
  LIMIT v_lim;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_notifications(p_viewer uuid, p_limit int, p_before timestamptz, p_before_key text) TO boardgamebuddy_role;
