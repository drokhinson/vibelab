-- 008_link_notifications.sql — tell people when they are seated in someone
-- else's play, and let them get out of it in bulk.
--
-- Anyone can put your account in a play they log. Until now that write was
-- silent AND one-sided: nothing told you it happened, and the only way out was
-- POST /plays/{id}/leave, one play at a time, on a play you had to stumble
-- across in your own feed first. A note import that seats you in 58 games is
-- therefore 58 separate acts of undo, preceded by a search.
--
-- WHAT IS NOT HERE, DELIBERATELY: an events table. A "you were linked" row
-- would be a second source of truth about a fact play_players already holds,
-- written by four separate play-write paths (live save, offline flush, note
-- importer, BGG sync) and correct only if all four remember. The list is
-- derived instead — plays where the viewer is a player and someone else is the
-- logger — which self-heals when a play is deleted and empties itself when the
-- viewer unlinks.
--
-- What CANNOT be derived is two timestamps, so those are the only new state:
-- when a seat was linked, and how far the viewer has read.

-- ── linked_at: when the seat happened ────────────────────────────────────────
-- The cheap answer is to date a seat by boardgamebuddy_plays.created_at and add
-- no column. It is wrong for the single case this feature most exists for.
-- bgb_link_ghost — the Buddies screen's "this nickname is Julia's account" —
-- stamps player_user_id onto play_players rows of plays that ALREADY EXIST,
-- often years old. That is the purest form of "I can link someone to a game and
-- they don't know about it", and a created_at watermark would never ring for
-- it, because the play was created long before the link was.
--
-- Nullable → backfill → default → NOT NULL, in that order, so the table is
-- rewritten once. No writer needs changing: DEFAULT now() covers every insert
-- path, bgb_log_play and bgb_import_plays included (session finalize routes
-- through bgb_log_play).
ALTER TABLE public.boardgamebuddy_play_players
  ADD COLUMN IF NOT EXISTS linked_at TIMESTAMPTZ;

UPDATE public.boardgamebuddy_play_players pp
   SET linked_at = COALESCE(p.created_at, now())
  FROM public.boardgamebuddy_plays p
 WHERE p.id = pp.play_id AND pp.linked_at IS NULL;

ALTER TABLE public.boardgamebuddy_play_players
  ALTER COLUMN linked_at SET DEFAULT now();

UPDATE public.boardgamebuddy_play_players
   SET linked_at = now() WHERE linked_at IS NULL;

ALTER TABLE public.boardgamebuddy_play_players
  ALTER COLUMN linked_at SET NOT NULL;

-- The driving index for every read below: the viewer's own seats, newest
-- first. Partial on the same predicate as idx_bgb_play_players_user_play,
-- which stays — that one serves point lookups by (user, play), this one serves
-- the ordered scan.
CREATE INDEX IF NOT EXISTS idx_bgb_play_players_user_linked
  ON public.boardgamebuddy_play_players USING btree (player_user_id, linked_at DESC)
  WHERE player_user_id IS NOT NULL;


-- ── The read watermark ───────────────────────────────────────────────────────
-- Backfilled to now() for EXISTING accounts, deliberately. The list is derived,
-- so everyone's whole history is on the screen either way and nothing is
-- hidden — this only decides whether the bell is lit on the deploy that ships
-- it. An account with a BGG-synced history would otherwise light up with four
-- hundred unread on first launch, which is not a notification, it is noise, and
-- it teaches people to ignore the dot before the feature has said anything.
-- New signups stay NULL and read as '-infinity': they have no history to
-- forgive.
ALTER TABLE public.boardgamebuddy_profiles
  ADD COLUMN IF NOT EXISTS link_notifications_seen_at TIMESTAMPTZ;

UPDATE public.boardgamebuddy_profiles
   SET link_notifications_seen_at = now()
 WHERE link_notifications_seen_at IS NULL;


-- ── bgb_link_ghost: an owner-initiated link is news ──────────────────────────
-- Re-emitted to stamp linked_at on the rows it is about to move, so the
-- retroactive link described above actually rings.
--
-- The stamp goes BEFORE the merge, under the merge's own predicate
-- (player_user_id IS NULL + name key + owner's plays), which is what makes it
-- touch exactly the rows that are about to change and nothing else. Doing it
-- afterwards would have to match on player_user_id = p_target and would sweep
-- up rows that were already linked to that account under that name, re-ringing
-- for links the owner made months ago.
--
-- bgb_link_ghost_rows itself is left alone on purpose, and so is its other
-- caller, bgb_accept_ghost_claim: that path runs when the CLAIMANT asked to be
-- linked and the owner said yes. Notifying someone about a merge they
-- themselves requested is noise, and putting the stamp in the shared helper
-- would have meant a signature change, a DROP + CREATE, and re-emitting both
-- callers to say "not you".
CREATE OR REPLACE FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key TEXT := lower(btrim(COALESCE(p_display_name, '')));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_profiles WHERE id = p_target) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- One statement, so every row moved by one act of linking shares one
  -- timestamp — which is also what lets the notification list collapse a
  -- retroactive link across forty old plays into a single entry.
  UPDATE boardgamebuddy_play_players pp
     SET linked_at = now()
   WHERE pp.player_user_id IS NULL
     AND lower(btrim(COALESCE(pp.player_display_name, ''))) = v_key
     AND pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_viewer
         );

  RETURN jsonb_build_object(
    'updated',
    bgb_link_ghost_rows(p_viewer, v_key, p_target)
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid) TO boardgamebuddy_role;


-- ── bgb_link_notifications ───────────────────────────────────────────────────
-- One row per ENTRY, newest first, keyset-paged on linked_at.
--
-- An entry is not a play. Grouping is three tiers, in priority order, and each
-- exists because a real linking act produces rows the tier above it cannot
-- collapse:
--
--   batch   import_batch_id  — one paste of a note. Collapsing only runs (the
--                              way the feed does) is not enough here: an import
--                              of 214 DISTINCT plays has 214 different runs,
--                              and the multi-select this screen exists for
--                              would still face 214 rows.
--   run     import_group_id  — a run of identical plays inside a 005-era import
--                              that predates batch ids.
--   act     (owner, linked_at) — everything else. One UPDATE stamps one now(),
--                              so a retroactive bgb_link_ghost across forty old
--                              plays is forty rows sharing one timestamp, and
--                              collapses to one entry. Individually logged
--                              plays have distinct timestamps and stay separate,
--                              which is what you want — those are forty
--                              different evenings, not one act.
--
-- WHAT THIS DELIBERATELY DOES NOT RETURN: the roster, notes, photo or scores.
-- This screen necessarily shows plays logged by people the viewer may not be
-- buddies with — you cannot decide whether to unlink from something you cannot
-- see — which is wider than the feed's accepted-edge rule. It is held to the
-- minimum that supports the decision: who linked you, what game, when, how
-- many. Handing over a stranger's guest list is not part of that.
CREATE OR REPLACE FUNCTION public.bgb_link_notifications(
  p_viewer uuid,
  p_limit int DEFAULT 20,
  p_before timestamptz DEFAULT NULL
)
 RETURNS TABLE (
   entry_key text,
   kind text,
   play_id uuid,
   play_ids uuid[],
   group_count int,
   game_count int,
   played_from date,
   played_to date,
   linked_at timestamptz,
   game_id uuid,
   game_name text,
   game_thumbnail_url text,
   owner_id uuid,
   owner_display_name text,
   owner_username text,
   owner_avatar jsonb,
   import_batch_id uuid,
   is_unread boolean
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
    SELECT s.*,
           CASE
             WHEN s.b_id IS NOT NULL THEN 'b:' || s.b_id::text
             WHEN s.r_id IS NOT NULL THEN 'g:' || s.r_id::text
             ELSE 'a:' || s.o_id::text || ':' || s.l_at::text
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
           (array_agg(k.p_id   ORDER BY k.p_at DESC NULLS LAST, k.p_id))[1] AS rep,
           (array_agg(k.g_id   ORDER BY k.p_at DESC NULLS LAST, k.p_id))[1] AS rep_game,
           (array_agg(k.g_name ORDER BY k.p_at DESC NULLS LAST, k.p_id))[1] AS rep_name,
           (array_agg(k.g_thumb ORDER BY k.p_at DESC NULLS LAST, k.p_id))[1] AS rep_thumb,
           (array_agg(k.b_id   ORDER BY k.p_at DESC NULLS LAST, k.p_id))[1] AS rep_batch
    FROM keyed k
    GROUP BY k.k, k.kd, k.o_id
  )
  SELECT e.k, e.kd, e.rep, e.ids, e.n_plays, e.n_games,
         e.from_at, e.to_at, e.l_at,
         e.rep_game,
         -- game_name / game_thumbnail_url are denormalized (migration 020) and
         -- null on rows written before it, so fall back to the catalog the same
         -- way bgb_collection_shelf does.
         COALESCE(e.rep_name, g.name),
         COALESCE(e.rep_thumb, g.thumbnail_url),
         e.o_id, pr.display_name, pr.username, pr.avatar,
         e.rep_batch,
         (e.l_at > COALESCE(v_seen, '-infinity'::timestamptz))
  FROM entries e
  LEFT JOIN boardgamebuddy_profiles pr ON pr.id = e.o_id
  LEFT JOIN boardgamebuddy_games g ON g.id = e.rep_game
  -- Keyset, not OFFSET: rows vanish from under the cursor as the user unlinks,
  -- and an offset would skip whatever slid up into the gap.
  WHERE p_before IS NULL OR e.l_at < p_before
  ORDER BY e.l_at DESC, e.k
  LIMIT v_lim;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_link_notifications(p_viewer uuid, p_limit int, p_before timestamptz) TO boardgamebuddy_role;


-- ── bgb_link_notifications_unread ────────────────────────────────────────────
-- The bell's count. Counts ENTRIES on exactly the key the list groups by — a
-- badge reading 214 over a list showing one row is a bug that only appears on
-- the accounts that most need this feature.
CREATE OR REPLACE FUNCTION public.bgb_link_notifications_unread(p_viewer uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COUNT(DISTINCT
           CASE
             WHEN p.import_batch_id IS NOT NULL THEN 'b:' || p.import_batch_id::text
             WHEN p.import_group_id IS NOT NULL THEN 'g:' || p.import_group_id::text
             ELSE 'a:' || p.user_id::text || ':' || pp.linked_at::text
           END)::int
  FROM boardgamebuddy_play_players pp
  JOIN boardgamebuddy_plays p ON p.id = pp.play_id
  WHERE pp.player_user_id = p_viewer
    AND p.user_id <> p_viewer
    AND pp.linked_at > COALESCE(
          (SELECT pr.link_notifications_seen_at
             FROM boardgamebuddy_profiles pr WHERE pr.id = p_viewer),
          '-infinity'::timestamptz);
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_link_notifications_unread(p_viewer uuid) TO boardgamebuddy_role;


-- ── bgb_mark_link_notifications_seen ─────────────────────────────────────────
-- Monotonic, and takes the watermark the CLIENT read rather than now(): a link
-- landing between the list request and this call would otherwise be marked seen
-- without ever having been shown. GREATEST also makes a stale retry harmless.
CREATE OR REPLACE FUNCTION public.bgb_mark_link_notifications_seen(
  p_viewer uuid,
  p_through timestamptz DEFAULT NULL
)
 RETURNS timestamptz
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_through TIMESTAMPTZ := COALESCE(p_through, now());
  v_result  TIMESTAMPTZ;
BEGIN
  UPDATE boardgamebuddy_profiles
     SET link_notifications_seen_at =
           GREATEST(COALESCE(link_notifications_seen_at, '-infinity'::timestamptz), v_through)
   WHERE id = p_viewer
   RETURNING link_notifications_seen_at INTO v_result;
  RETURN v_result;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_mark_link_notifications_seen(p_viewer uuid, p_through timestamptz) TO boardgamebuddy_role;


-- ── bgb_ghost_out_of_plays ───────────────────────────────────────────────────
-- The bulk inverse of bgb_link_ghost_rows: the caller's seat on each named play
-- becomes a ghost carrying their name, owned implicitly by whoever logged the
-- play. The play survives; the caller leaves their own history.
--
-- This is now the ONE implementation of that write. played_with_service's
-- ghost_out_of_play() used to do it as two PostgREST calls with the display
-- name supplied by the client; both problems go away here — it is one
-- statement, so the identity-check backfill and the null-out cannot be
-- interleaved by a concurrent write, and v_name is read from the profile rather
-- than trusted from the caller.
--
-- Takes plays, runs and batches, because that is what the screen selects: a
-- batch entry is one tick that must unlink 214 plays without the client having
-- to hold 214 ids. An id of any kind that is not the caller's matches zero rows
-- and contributes 0 — the same "report 0 rather than 403" contract
-- bgb_delete_import_batch established, and for the same reason: saying "not
-- yours" would confirm the batch exists.
--
-- Two guards in the WHERE, both load-bearing:
--   pp.player_user_id = p_viewer   a caller can only ever move their own seat
--   p.user_id <> p_viewer          never a play the caller logged (they should
--                                  edit or delete that, and nulling their own
--                                  seat would orphan the play from its author)
CREATE OR REPLACE FUNCTION public.bgb_ghost_out_of_plays(
  p_viewer uuid,
  p_play_ids uuid[] DEFAULT '{}',
  p_group_ids uuid[] DEFAULT '{}',
  p_batch_ids uuid[] DEFAULT '{}'
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name    TEXT;
  v_plays   UUID[] := COALESCE(p_play_ids,  '{}'::uuid[]);
  v_groups  UUID[] := COALESCE(p_group_ids, '{}'::uuid[]);
  v_batches UUID[] := COALESCE(p_batch_ids, '{}'::uuid[]);
  v_updated INT;
BEGIN
  IF array_length(v_plays, 1) IS NULL
     AND array_length(v_groups, 1) IS NULL
     AND array_length(v_batches, 1) IS NULL THEN
    RETURN 0;
  END IF;

  SELECT display_name INTO v_name
  FROM boardgamebuddy_profiles WHERE id = p_viewer;

  -- The COALESCE is a defensive backfill: bgb_play_players_identity_chk needs
  -- one of (player_user_id, player_display_name), so nulling the first on a row
  -- that never carried the second would abort the whole statement. Rows written
  -- by _write_play_players always carry a name, so this normally changes
  -- nothing — but "normally" is not a constraint. NULLIF catches a name that is
  -- present but blank, which the CHECK accepts and a reader would not.
  UPDATE boardgamebuddy_play_players pp
     SET player_display_name =
           COALESCE(NULLIF(btrim(COALESCE(pp.player_display_name, '')), ''), v_name, 'Player'),
         player_user_id = NULL
    FROM boardgamebuddy_plays p
   WHERE p.id = pp.play_id
     AND pp.player_user_id = p_viewer
     AND p.user_id <> p_viewer
     AND (
           p.id = ANY(v_plays)
        OR (p.import_group_id IS NOT NULL AND p.import_group_id = ANY(v_groups))
        OR (p.import_batch_id IS NOT NULL AND p.import_batch_id = ANY(v_batches))
     );

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_out_of_plays(p_viewer uuid, p_play_ids uuid[], p_group_ids uuid[], p_batch_ids uuid[]) TO boardgamebuddy_role;
