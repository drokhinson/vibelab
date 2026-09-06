-- 017_reaction_notifications.sql — the bell learns to say "somebody said good game".
--
-- 016 shipped the reaction and deliberately stopped short of the notification:
-- it gave every tap a shared reaction_group_id "so the write can be read back
-- as one act", named the future consumer, and left it. This is that consumer.
-- A fourth kind joins play_link / buddy_request / buddy_accepted on the same
-- feed, the same cursor and the same watermark, and — like all three of them —
-- it is DERIVED. There is still no events table.
--
-- Two things had to be settled first.
--
-- THE RECIPIENT PROBLEM, AND WHY A COLUMN RATHER THAN A JOIN.
-- boardgamebuddy_play_reactions is (play_id, user_id, reaction_group_id,
-- created_at). The recipient of a reaction — the person whose play it is — is
-- not on the row, it is plays.user_id. And an index cannot be (recipient, time)
-- while the recipient lives in another table, which leaves exactly two shapes
-- and both are wrong for the read this feeds:
--
--   * drive from boardgamebuddy_plays (user_id, played_at DESC) and probe the
--     reactions PK once per play → O(plays you have ever logged) probes, almost
--     all returning nothing. For the 214-play importer this feature exists for,
--     that is ~214 index lookups. On EVERY app boot, because
--     bgb_notifications_unread rides the /bootstrap gather.
--   * index reactions.created_at and scan forward from the watermark → one
--     user's badge now costs a share of EVERYBODY's recent reactions, and gets
--     monotonically worse the longer someone stays away.
--
-- 010 set the bar for this function and stated it plainly: "an account that has
-- read everything scans zero index entries instead of every seat it owns."
-- Neither shape clears it. So the recipient moves onto the row, and
-- idx_bgb_play_reactions_owner_created becomes the exact recipient-side twin of
-- idx_bgb_play_players_user_linked — which is what lets the reaction arm below
-- be the same narrow-scan → top-N → aggregate-the-page pipeline as the play
-- arm rather than a special case.
--
-- WHY THE COPY CANNOT DRIFT. play_owner_id duplicates plays.user_id, which this
-- repo normally refuses on the same grounds notification_service gives for
-- having no events table. The difference is that a "you were linked" row is an
-- EVENT four write paths must each remember to emit, whereas this is a
-- materialized join key on a row that already had to be written anyway:
--
--   * no write path in this codebase updates plays.user_id. A play's logger is
--     its logger forever — there is no transfer-ownership feature and no
--     re-logger — so the value it copies is immutable by construction, not by
--     discipline.
--   * it is NOT NULL, so a write path that forgets it fails loudly at the
--     insert rather than silently emptying somebody's bell.
--   * there is precedent of exactly this class: plays.game_name and
--     plays.game_thumbnail_url are denormalized from the catalog (020), and the
--     play arm below already COALESCEs over them.
--
-- It is written by reaction_service.add, not by a trigger. That service's
-- _reactable_owners already selects plays.user_id — it reads it to drop the
-- caller's own plays and then threw it away — so the write path pays nothing
-- extra, and this schema has zero triggers today. Introducing the first one for
-- a value already in hand would be the bigger convention break.
--
-- A CORRECTION TO 016. It added idx_bgb_play_reactions_group "for the future
-- notification arm, which groups a night's rows back into one entry", and that
-- turns out not to be how this works: the owner-scoped range scan already
-- yields every row of a group that belongs to the viewer, which is exactly the
-- membership the entry describes — there is no probe by group id anywhere
-- below. The index is harmless and stays, but do not go looking for its caller.
--
-- WHAT THE FEED GAINS, AND THE ONE OVERLOAD TO KNOW ABOUT. A reaction row
-- reuses the play block (play_ids / group_count / game_count / played_from /
-- played_to / game_*) rather than adding output columns — which is what keeps
-- both functions a CREATE OR REPLACE. On a play_link row group_count means
-- "plays you would be removed from" and drives the unlink bar's count; on a
-- reaction row it means "plays of yours they said good game to". That is safe
-- only because a reaction row is not selectable — notifications-view.js gives
-- it no pick button, so it can never enter the selection the unlink reads. If
-- you ever make one selectable, this is the thing that breaks.


-- ── The recipient, on the row ────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_play_reactions
  ADD COLUMN IF NOT EXISTS play_owner_id UUID;

-- Backfill. Every existing row has a play (the FK is ON DELETE CASCADE), so
-- this leaves nothing NULL and the SET NOT NULL below cannot fail.
UPDATE public.boardgamebuddy_play_reactions r
   SET play_owner_id = p.user_id
  FROM public.boardgamebuddy_plays p
 WHERE p.id = r.play_id
   AND r.play_owner_id IS DISTINCT FROM p.user_id;

ALTER TABLE public.boardgamebuddy_play_reactions
  ALTER COLUMN play_owner_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'boardgamebuddy_play_reactions_play_owner_id_fkey'
  ) THEN
    ALTER TABLE public.boardgamebuddy_play_reactions
      ADD CONSTRAINT boardgamebuddy_play_reactions_play_owner_id_fkey
      FOREIGN KEY (play_owner_id)
      REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE;
  END IF;
END
$$;

COMMENT ON COLUMN public.boardgamebuddy_play_reactions.play_owner_id IS
  'The recipient: a copy of plays.user_id, so "who reacted to MY plays" is a range scan rather than one probe per play the viewer has ever logged. Immutable because no write path updates plays.user_id. Written by reaction_service.add — see migration 017.';

-- The narrow scan for BOTH functions below, and a deliberate mirror of
-- idx_bgb_play_players_user_linked (player_user_id, linked_at DESC): same
-- shape, same job, so the reaction arm reads like the play arm.
CREATE INDEX IF NOT EXISTS idx_bgb_play_reactions_owner_created
  ON public.boardgamebuddy_play_reactions USING btree (play_owner_id, created_at DESC);

ANALYZE public.boardgamebuddy_play_reactions;


-- ── bgb_notifications_unread ─────────────────────────────────────────────────
-- One more term, and it is 010's own equivalence restated for a second source:
--
--   an entry is unread  ⇔  MAX(created_at) over its members > watermark
--                       ⇔  SOME member has created_at > watermark
--
-- so grouping only the members newer than the watermark yields the same key set
-- and therefore the same count, while `r.created_at > v_seen` becomes an index
-- condition on idx_bgb_play_reactions_owner_created. The property 010 was
-- protecting is preserved for the new arm too: an account that has read
-- everything scans zero index entries here as well.
--
-- GROUP BY (reaction_group_id, user_id) matches rx_page_keys in the list
-- function exactly — reaction ENTRIES, not reaction rows — so a one-tap
-- three-game night is 1 in the badge and one line in the rail. That is the same
-- "the badge and the rail cannot drift apart" invariant 009 argued for the play
-- term, and it holds for the same reason: same source, same filter, same key.
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
      -- Reaction ENTRIES (migration 017). `user_id <> p_viewer` is belt and
      -- braces — reaction_service already refuses to write a row against your
      -- own play — but it is the read-side twin of the play term's
      -- `p.user_id <> p_viewer`, and the feed must not be able to announce an
      -- act the viewer performed even if a row ever leaks in.
    + (SELECT COUNT(*)::int FROM (
         SELECT 1
         FROM boardgamebuddy_play_reactions r
         WHERE r.play_owner_id = p_viewer
           AND r.user_id <> p_viewer
           AND r.created_at > v_seen
         GROUP BY r.reaction_group_id, r.user_id
       ) rx)
    INTO v_n;

  RETURN v_n;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_notifications_unread(p_viewer uuid) TO boardgamebuddy_role;


-- ── bgb_notifications ────────────────────────────────────────────────────────
-- Same pipeline as 010, plus a fourth arm built to the same pattern:
--
--   rx_seats(narrow) → rx_page_keys(cheap, LIMIT) → rx_members → rx_entries
--
-- WHY ADDING AN ARM IS STILL THE SAME ANSWER. 010's argument generalizes
-- verbatim: the final SELECT takes the top v_lim of the union, so an entry of
-- ANY kind can only appear there if it is among the top v_lim entries OF ITS
-- OWN KIND by that same ordering. Adding a source can only push other rows out
-- of the page, never pull a lower one in. Each arm's page_keys computes exactly
-- its own top-v_lim set on the identical expressions, so no candidate is lost.
--
-- THE ONE THING THE NEW ARM DOES DIFFERENTLY, AND IT MATTERS. The play arm's
-- entry_key IS its grouping key (`k` already carries its 'b:'/'g:'/'a:' prefix),
-- so 010's HAVING can compare `s.k` directly. A reaction's grouping key is a
-- bare uuid and its entry_key is 'rx:' || that — so the HAVING below must
-- compare the PREFIXED form, because the cursor it is filtering against is the
-- ekey the final ORDER BY sorts on and the client sent back. Comparing the bare
-- uuid would drop rows at every occurred_at tie on a page boundary, which is
-- precisely the bug 009's timestamp-only cursor had and 009 fixed by making the
-- cursor a tuple.
--
-- Grouping is (reaction_group_id, user_id). The group id alone would be enough
-- today — one tap, one actor — but the pair is what the row actually claims
-- ("X said good game"), and it costs nothing to be honest about it. No owner in
-- the GROUP BY: every row reaching rx_seats is already owned by p_viewer. A
-- group CAN span owners, because a night's plays may have several loggers; this
-- scan sees only the viewer's slice of it, which is exactly the slice the row
-- should be describing.
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
   -- 'play_link' | 'buddy_request' | 'buddy_accepted' | 'reaction'
   kind text,
   occurred_at timestamptz,
   is_unread boolean,
   actor_id uuid,
   actor_display_name text,
   actor_username text,
   actor_avatar jsonb,
   -- play_link and reaction; NULL on both buddy kinds. play_group and
   -- import_batch_id are additionally NULL on a reaction row — see the header
   -- for what group_count means there, which is NOT what it means on a
   -- play_link row.
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
   -- buddy_request / buddy_accepted only; NULL on play_link and reaction. The
   -- id the client posts to /buddies/{id}/accept and /buddies/{id}/reject, so a
   -- row can be answered where it is read.
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
  -- ── The reaction arm (migration 017) ──────────────────────────────────────
  -- Same four stages as the play arm above, for the same reason: without the
  -- narrow first pass, "who reacted to my plays" is one probe per play the
  -- viewer has ever logged. play_owner_id is what makes
  -- idx_bgb_play_reactions_owner_created a (recipient, time DESC) range scan.
  rx_seats AS (
    SELECT r.play_id           AS p_id,
           r.created_at        AS c_at,
           r.user_id           AS a_id,
           r.reaction_group_id AS k
    FROM boardgamebuddy_play_reactions r
    WHERE r.play_owner_id = p_viewer
      -- You do not congratulate yourself. The read-side twin of the play arm's
      -- `p.user_id <> p_viewer`; reaction_service already refuses to write such
      -- a row, and this makes the feed unable to show one regardless.
      AND r.user_id <> p_viewer
  ),
  rx_page_keys AS (
    -- The cursor compares the PREFIXED key, not the bare uuid: 'rx:' || k is
    -- what the final ORDER BY sorts on and what the client sends back. See the
    -- header — comparing the bare uuid drops rows at every tie on a boundary.
    SELECT s.k AS k, s.a_id AS a_id, MAX(s.c_at) AS c_at
    FROM rx_seats s
    GROUP BY s.k, s.a_id
    HAVING p_before IS NULL
        OR (MAX(s.c_at), 'rx:' || s.k::text) < (p_before, COALESCE(p_before_key, ''))
    ORDER BY MAX(s.c_at) DESC, ('rx:' || s.k::text) DESC
    LIMIT v_lim
  ),
  rx_members AS (
    SELECT pk.k AS k, pk.a_id AS a_id, s.c_at AS c_at,
           p.id AS p_id, p.game_id AS g_id, p.played_at AS p_at,
           p.game_name AS g_name, p.game_thumbnail_url AS g_thumb
    FROM rx_seats s
    JOIN rx_page_keys pk ON pk.k = s.k AND pk.a_id = s.a_id
    JOIN boardgamebuddy_plays p ON p.id = s.p_id
  ),
  rx_entries AS (
    SELECT m.k AS k, m.a_id AS a_id,
           MAX(m.c_at)                    AS c_at,
           COUNT(*)::int                  AS n_plays,
           COUNT(DISTINCT m.g_id)::int    AS n_games,
           MIN(m.p_at)                    AS from_at,
           MAX(m.p_at)                    AS to_at,
           array_agg(m.p_id ORDER BY m.p_at DESC NULLS LAST, m.p_id) AS ids,
           (array_agg(m.p_id    ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep,
           (array_agg(m.g_id    ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep_game,
           (array_agg(m.g_name  ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep_name,
           (array_agg(m.g_thumb ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep_thumb
    FROM rx_members m
    GROUP BY m.k, m.a_id
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
  -- Somebody said good game to plays of yours. play_group stays NULL: it is the
  -- PlayLinkGroup enum and says how a LINK was collapsed, which is a different
  -- fact from "collapsed on one tap's reaction_group_id" — and NULL is also
  -- what keeps the client's batch-unlink branch blind to these rows.
  -- import_batch_id is NULL by construction: it exists so an unlink can name a
  -- whole import in one field, and there is nothing to unlink from here. These
  -- are the viewer's OWN plays.
  reaction_rows AS (
    SELECT 'rx:' || e.k::text                    AS ekey,
           'reaction'::text                      AS nkind,
           e.c_at                                AS occ,
           e.a_id                                AS act_id,
           NULL::text                            AS pgroup,
           e.rep                                 AS rep_play,
           e.ids                                 AS rep_plays,
           e.n_plays                             AS n_plays,
           e.n_games                             AS n_games,
           e.from_at                             AS from_at,
           e.to_at                               AS to_at,
           e.rep_game                            AS rep_game,
           COALESCE(e.rep_name, g.name)          AS rep_name,
           COALESCE(e.rep_thumb, g.thumbnail_url) AS rep_thumb,
           NULL::uuid                            AS rep_batch,
           NULL::uuid                            AS e_id
    FROM rx_entries e
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
    UNION ALL SELECT * FROM reaction_rows
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
  -- into the gap. Still applied here over the whole union — page_keys and
  -- rx_page_keys have already applied the identical predicate to their own
  -- arms, which is a redundancy on those two and the only filter the two buddy
  -- arms get.
  WHERE p_before IS NULL
     OR (m.occ, m.ekey) < (p_before, COALESCE(p_before_key, ''))
  ORDER BY m.occ DESC, m.ekey DESC
  LIMIT v_lim;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_notifications(p_viewer uuid, p_limit int, p_before timestamptz, p_before_key text) TO boardgamebuddy_role;
