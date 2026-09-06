-- 014_ghost_claim_proxy.sql
--
-- Three things, one shape of change.
--
-- 1. PROXY CLAIMS. Until now a ghost claim could only ever say "that ghost is
--    me". But the person best placed to recognise a ghost is often not the
--    ghost: I see "Dave" on a friend's play, I know Dave has an account, and
--    Dave cannot see that play at all — he isn't in it, which is exactly why he
--    is a ghost on it. So a claim now records WHO ASKED (`requested_by`)
--    separately from WHO THE PLAYS WOULD GO TO (`claimant_id`), and the two can
--    differ when the asker and the target are accepted buddies.
--
-- 2. CLAIMS ON THE BELL. bgb_notifications had three arms and none of them was
--    a ghost claim, so a host's only signal was a dot on the Profile tab. Two
--    more arms fix that, for the host and for the person being claimed for.
--    No events table: claims already store created_at and mutate status in
--    place, so a `status = 'pending'` arm self-heals exactly the way the
--    buddy_request arm does — answering the claim empties the feed with no
--    bookkeeping.
--
-- 3. CANCEL BECOMES AN RPC. It was the one ghost-claim write done as a plain
--    PostgREST read-check-delete in the service layer. Two parties can now
--    withdraw a claim — the asker and the person it was raised for — and that
--    authorization rule belongs beside its siblings, not in Python.
--
-- What deliberately does NOT change: bgb_link_ghost_rows. Accepting a claim
-- still merges EVERY play the owner logged under that name, all or nothing.
-- The blast radius is now confirmed in the UI before the merge rather than
-- reported in a toast after it, which is a client change, not a server one.


-- ── Schema ────────────────────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_ghost_claims
  ADD COLUMN IF NOT EXISTS requested_by   UUID,
  ADD COLUMN IF NOT EXISTS origin_play_id UUID;

-- Every claim that already exists was raised by the claimant themselves.
UPDATE public.boardgamebuddy_ghost_claims
   SET requested_by = claimant_id
 WHERE requested_by IS NULL;

ALTER TABLE public.boardgamebuddy_ghost_claims
  ALTER COLUMN requested_by SET NOT NULL;

DO $$
BEGIN
  -- CASCADE rather than SET NULL, unlike origin_play_id below: a claim whose
  -- asker no longer exists has no story to tell and no row to render.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'boardgamebuddy_ghost_claims_requested_by_fkey') THEN
    ALTER TABLE public.boardgamebuddy_ghost_claims
      ADD CONSTRAINT boardgamebuddy_ghost_claims_requested_by_fkey
        FOREIGN KEY (requested_by) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE;
  END IF;
  -- The play the claim was raised from, so the claimed-for user's notification
  -- can name the game. SET NULL and nullable: plays get deleted, and every row
  -- that predates this migration has none. The notification arm LEFT JOINs it
  -- and reads correctly without one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'boardgamebuddy_ghost_claims_origin_play_fkey') THEN
    ALTER TABLE public.boardgamebuddy_ghost_claims
      ADD CONSTRAINT boardgamebuddy_ghost_claims_origin_play_fkey
        FOREIGN KEY (origin_play_id) REFERENCES boardgamebuddy_plays(id) ON DELETE SET NULL;
  END IF;
END $$;

-- "Asks I made" is now keyed on requested_by, not claimant_id — see
-- bgb_ghost_claims below for why that re-keying is load-bearing.
CREATE INDEX IF NOT EXISTS idx_bgb_ghost_claims_requested_by
  ON public.boardgamebuddy_ghost_claims USING btree (requested_by, status);

-- uq_bgb_ghost_claims_triple (owner_id, ghost_name_key, claimant_id) is
-- deliberately UNCHANGED. A claim's identity is still "this ghost is that
-- account"; who asked is a property of the row, not part of what makes it
-- unique. Two people asking for the same person is one ask, which is what the
-- takeover branch in bgb_create_ghost_claim relies on.

-- RLS is already enabled on the table and boardgamebuddy_role already holds
-- SELECT on it; new columns inherit both, so there is nothing to grant.


-- ── bgb_create_ghost_claim ────────────────────────────────────────────────────
-- Signature change, so the old form has to go: position 1 used to be the
-- claimant and is now the requester. Leaving the 3-arg version resolvable would
-- mean a stale caller silently raising claims with the wrong person as target.
DROP FUNCTION IF EXISTS public.bgb_create_ghost_claim(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.bgb_create_ghost_claim(
  p_requester    uuid,
  p_owner        uuid,
  p_display_name text,
  p_claimant     uuid DEFAULT NULL,
  p_play_id      uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key       TEXT := lower(btrim(COALESCE(p_display_name, '')));
  -- NULL means "for myself", which keeps every existing self-claim call site
  -- passing three arguments and meaning exactly what it did before.
  v_claimant  UUID := COALESCE(p_claimant, p_requester);
  v_proxy     BOOLEAN := COALESCE(p_claimant, p_requester) <> p_requester;
  v_sum       JSONB;
  v_sum_cl    JSONB;
  v_collides  BOOLEAN;
  v_claim     RECORD;
  v_has_claim BOOLEAN := false;
  v_id        UUID;
  v_out       JSONB;
BEGIN
  IF v_key = '' THEN
    RETURN jsonb_build_object('error', 'display_name_required');
  END IF;
  IF p_owner = v_claimant THEN
    -- The target's own roster. POST /ghost-players/link is the tool for that.
    RETURN jsonb_build_object('error', 'own_roster');
  END IF;

  IF v_proxy THEN
    IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_profiles WHERE id = v_claimant) THEN
      RETURN jsonb_build_object('error', 'claim_not_found');
    END IF;
    -- The host proxy-claiming on their OWN ghost needs nobody's approval:
    -- bgb_link_ghost does it outright. Routing it through an approval queue
    -- would leave them waiting on themselves.
    IF p_owner = p_requester THEN
      RETURN jsonb_build_object('error', 'own_roster');
    END IF;
    -- Buddies only. Pointing a stranger's account at a stranger's ghost is a
    -- way to spam two people at once with a request neither asked for, and the
    -- edge is the smallest honest proof that the asker knows who this is.
    -- The table is canonical (user_a < user_b), so match the unordered pair.
    --
    -- Checked at CREATE time ONLY. A later unfriend must not void a claim
    -- already raised: the host is still the one who decides, and voiding it
    -- would make unfriending a way to cancel a third party's pending request.
    IF NOT EXISTS (
      SELECT 1 FROM boardgamebuddy_buddy_edges be
       WHERE be.status = 'accepted'
         AND ((be.user_a = p_requester AND be.user_b = v_claimant)
           OR (be.user_a = v_claimant  AND be.user_b = p_requester))
    ) THEN
      RETURN jsonb_build_object('error', 'not_buddies');
    END IF;
    -- A proxy claim MUST name the play it was raised from: the claimed-for
    -- user's notification says "for Wingspan", and that is the only thing
    -- telling them which of a stranger's plays this is even about. Owner-scoped
    -- so the row cannot name a game this owner never logged.
    IF p_play_id IS NULL THEN
      RETURN jsonb_build_object('error', 'play_required');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM boardgamebuddy_plays WHERE id = p_play_id AND user_id = p_owner
    ) THEN
      RETURN jsonb_build_object('error', 'claim_not_found');
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_profiles WHERE id = p_owner) THEN
    RETURN jsonb_build_object('error', 'claim_not_found');
  END IF;

  SELECT * INTO v_claim
    FROM boardgamebuddy_ghost_claims
   WHERE owner_id = p_owner AND ghost_name_key = v_key AND claimant_id = v_claimant
     FOR UPDATE;
  v_has_claim := FOUND;

  -- Checked BEFORE the ghost lookup, and only for this claimant: once a claim
  -- is accepted the ghost rows no longer exist (they are the claimant's own
  -- rows now), so an exists-first order would answer a re-tap with the
  -- technically-true but useless "ghost_gone" instead of "that is already
  -- linked".
  IF v_has_claim AND v_claim.status = 'accepted' THEN
    RETURN jsonb_build_object('error', 'already_linked');
  END IF;

  -- The summary answers two questions about two DIFFERENT people, and a proxy
  -- claim is where they come apart:
  --   `visible`  belongs to the REQUESTER. They are the one looking at the
  --              ghost, and the target very often cannot see the play at all —
  --              that is the whole reason proxy claiming exists.
  --   `collides` belongs to the CLAIMANT. The merge must not seat one person
  --              twice at one table, and it is the claimant who would be
  --              seated.
  -- A self-claim asks both of one person, which is the single call this used
  -- to make.
  v_sum := bgb_ghost_summary(p_requester, p_owner, v_key);

  IF NOT (v_sum->>'exists')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'ghost_gone');
  END IF;
  IF NOT (v_sum->>'visible')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'not_visible');
  END IF;

  IF v_proxy THEN
    v_sum_cl := bgb_ghost_summary(v_claimant, p_owner, v_key);
    v_collides := (v_sum_cl->>'collides')::BOOLEAN;
  ELSE
    v_collides := (v_sum->>'collides')::BOOLEAN;
  END IF;
  IF v_collides THEN
    RETURN jsonb_build_object('error', 'already_seated');
  END IF;

  IF v_has_claim THEN
    IF v_claim.status = 'pending' THEN
      -- Idempotent, matching buddy_service.send_request: asking twice is one
      -- ask. But if the person themselves is now asking over a friend's proxy
      -- ask, they take the row over — they outrank a friend speaking for them,
      -- and the host's row should stop saying "Sam asked" once Dave has spoken
      -- for himself. reject_count is untouched either way: two strikes stick.
      v_id := v_claim.id;
      IF NOT v_proxy AND v_claim.requested_by <> p_requester THEN
        UPDATE boardgamebuddy_ghost_claims
           SET requested_by   = p_requester,
               origin_play_id = COALESCE(p_play_id, origin_play_id)
         WHERE id = v_claim.id;
      END IF;
    ELSIF v_claim.reject_count >= 2 THEN
      -- A proxy is not a way around the two-strike limit either.
      RETURN jsonb_build_object('error', 'declined_twice');
    ELSIF v_claim.status = 'dismissed' AND v_proxy THEN
      -- "That isn't me" is only sayable by the person it is about, and it has
      -- to stick against a buddy re-raising it a second later. The target can
      -- still change their own mind: a SELF claim falls through to the re-ask
      -- below and reopens their own dismissed row.
      RETURN jsonb_build_object('error', 'target_declined');
    ELSE
      -- rejected (once), dismissed, or superseded: re-ask is allowed. The
      -- strike counter is NOT reset — that is what makes two strikes stick.
      UPDATE boardgamebuddy_ghost_claims
         SET status = 'pending',
             resolved_at = NULL,
             created_at = now(),
             requested_by = p_requester,
             origin_play_id = COALESCE(p_play_id, origin_play_id),
             ghost_display_name = COALESCE(v_sum->>'ghost_display_name', ghost_display_name)
       WHERE id = v_claim.id
       RETURNING id INTO v_id;
    END IF;
  ELSE
    INSERT INTO boardgamebuddy_ghost_claims
           (owner_id, ghost_name_key, ghost_display_name, claimant_id, status,
            requested_by, origin_play_id)
    VALUES (p_owner, v_key,
            COALESCE(v_sum->>'ghost_display_name', btrim(p_display_name)),
            v_claimant, 'pending', p_requester, p_play_id)
    RETURNING id INTO v_id;
  END IF;

  SELECT jsonb_build_object(
           'id',                        c.id,
           'direction',                 'outgoing',
           'other_user_id',             ow.id,
           'other_display_name',        ow.display_name,
           'other_username',            ow.username,
           'other_avatar',              ow.avatar,
           'ghost_display_name',        c.ghost_display_name,
           'play_count',                (v_sum->>'play_count')::INT,
           'last_played_at',            v_sum->'last_played_at',
           'created_at',                c.created_at,
           'requested_by',              c.requested_by,
           'requested_by_display_name', rq.display_name,
           'requested_by_avatar',       rq.avatar,
           'claimant_user_id',          cl.id,
           'claimant_display_name',     cl.display_name,
           'claimant_avatar',           cl.avatar,
           'is_proxy',                  c.requested_by <> c.claimant_id
         )
    INTO v_out
    FROM boardgamebuddy_ghost_claims c
    JOIN boardgamebuddy_profiles ow ON ow.id = c.owner_id
    JOIN boardgamebuddy_profiles cl ON cl.id = c.claimant_id
    JOIN boardgamebuddy_profiles rq ON rq.id = c.requested_by
   WHERE c.id = v_id;

  RETURN v_out;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_create_ghost_claim(uuid, uuid, text, uuid, uuid) TO boardgamebuddy_role;


-- ── bgb_accept_ghost_claim ────────────────────────────────────────────────────
-- The merge, the ghost_gone retirement and the supersede cascade are unchanged.
-- The cascade is already right for proxy claims: it retires every OTHER pending
-- claim on the same (owner, ghost_name_key) whoever raised it, and those rows
-- now point at seats that are no longer ghosts.
CREATE OR REPLACE FUNCTION public.bgb_accept_ghost_claim(p_owner uuid, p_claim_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_claim   RECORD;
  v_sum     JSONB;
  v_updated INT;
  v_out     JSONB;
BEGIN
  SELECT * INTO v_claim
    FROM boardgamebuddy_ghost_claims
   WHERE id = p_claim_id
     FOR UPDATE;

  -- 404 rather than 403 for a non-owner: do not confirm the claim exists.
  -- Same rule as buddy_service.reject_request.
  IF NOT FOUND OR v_claim.owner_id <> p_owner THEN
    RETURN jsonb_build_object('error', 'claim_not_found');
  END IF;
  IF v_claim.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'not_pending');
  END IF;

  -- Still the CLAIMANT's collision, not the asker's: they are who gets seated.
  v_sum := bgb_ghost_summary(v_claim.claimant_id, v_claim.owner_id, v_claim.ghost_name_key);
  IF (v_sum->>'collides')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'already_seated');
  END IF;

  v_updated := bgb_link_ghost_rows(v_claim.owner_id, v_claim.ghost_name_key, v_claim.claimant_id);

  IF v_updated = 0 THEN
    -- The ghost was renamed or its plays deleted between request and accept.
    -- The claim can never succeed now; retire it rather than leaving an
    -- Accept button that only ever errors.
    UPDATE boardgamebuddy_ghost_claims
       SET status = 'superseded', resolved_at = now()
     WHERE id = v_claim.id;
    RETURN jsonb_build_object('error', 'ghost_gone');
  END IF;

  UPDATE boardgamebuddy_ghost_claims
     SET status = 'accepted', resolved_at = now(), rows_merged = v_updated
   WHERE id = v_claim.id;

  -- Anyone else waiting on this same ghost is now waiting on rows that no
  -- longer exist. Retire their claims too, or the owner is left with Accept
  -- buttons that can only return ghost_gone.
  UPDATE boardgamebuddy_ghost_claims
     SET status = 'superseded', resolved_at = now()
   WHERE owner_id = v_claim.owner_id
     AND ghost_name_key = v_claim.ghost_name_key
     AND id <> v_claim.id
     AND status = 'pending';

  SELECT jsonb_build_object(
           'id',                        c.id,
           'direction',                 'incoming',
           'other_user_id',             cl.id,
           'other_display_name',        cl.display_name,
           'other_username',            cl.username,
           'other_avatar',              cl.avatar,
           'ghost_display_name',        c.ghost_display_name,
           'play_count',                c.rows_merged,
           'last_played_at',            NULL::DATE,
           'created_at',                c.created_at,
           'requested_by',              c.requested_by,
           'requested_by_display_name', rq.display_name,
           'requested_by_avatar',       rq.avatar,
           'claimant_user_id',          cl.id,
           'claimant_display_name',     cl.display_name,
           'claimant_avatar',           cl.avatar,
           'is_proxy',                  c.requested_by <> c.claimant_id
         )
    INTO v_out
    FROM boardgamebuddy_ghost_claims c
    JOIN boardgamebuddy_profiles cl ON cl.id = c.claimant_id
    JOIN boardgamebuddy_profiles rq ON rq.id = c.requested_by
   WHERE c.id = v_claim.id;

  RETURN jsonb_build_object('updated', v_updated, 'claim', v_out);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_accept_ghost_claim(p_owner uuid, p_claim_id uuid) TO boardgamebuddy_role;


-- ── bgb_cancel_ghost_claim ────────────────────────────────────────────────────
-- New. Cancel used to be a plain PostgREST read-check-delete in
-- ghost_claim_service, authorized against claimant_id alone. Two parties can
-- withdraw a claim now — the person who ASKED, and the person it was raised FOR
-- — so the rule moves here beside accept and reject rather than being the one
-- ghost-claim authorization decision made in Python.
--
-- Two actors, two DIFFERENT meanings, which is the other reason this cannot
-- stay a delete in Python:
--
--   the ASKER withdraws  → DELETE, exactly as today. Withdrawing your own ask
--                          is not a decline and must not burn a strike.
--   the TARGET says no   → 'dismissed'. NOT a delete: a delete would let the
--                          same buddy re-raise it a second later, and "that
--                          isn't me" has to stick. requested_by moves to the
--                          claimant so the row records who settled it — and so
--                          the target stays free to change their mind, since a
--                          self-claim reopens their own dismissed row.
--
-- The asker is checked FIRST, so a self-claim — where both branches name the
-- same person — keeps today's delete behaviour exactly.
CREATE OR REPLACE FUNCTION public.bgb_cancel_ghost_claim(p_viewer uuid, p_claim_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_claim RECORD;
BEGIN
  SELECT * INTO v_claim
    FROM boardgamebuddy_ghost_claims
   WHERE id = p_claim_id
     FOR UPDATE;

  -- 404 for a stranger, same reasoning as accept: do not confirm it exists.
  -- The OWNER is deliberately not on this list — their answers are accept and
  -- reject, and letting them settle it here instead would lose the strike.
  IF NOT FOUND
     OR (v_claim.requested_by <> p_viewer AND v_claim.claimant_id <> p_viewer) THEN
    RETURN jsonb_build_object('error', 'claim_not_found');
  END IF;
  IF v_claim.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'not_pending');
  END IF;

  IF v_claim.requested_by = p_viewer THEN
    DELETE FROM boardgamebuddy_ghost_claims WHERE id = v_claim.id;
    RETURN jsonb_build_object('cancelled', true, 'kind', 'withdrawn');
  END IF;

  UPDATE boardgamebuddy_ghost_claims
     SET status = 'dismissed',
         resolved_at = now(),
         requested_by = claimant_id
   WHERE id = v_claim.id;
  RETURN jsonb_build_object('cancelled', true, 'kind', 'declined');
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_cancel_ghost_claim(p_viewer uuid, p_claim_id uuid) TO boardgamebuddy_role;


-- ── bgb_dismiss_ghost_claim ───────────────────────────────────────────────────
-- Re-emitted for ONE reason: it INSERTs a claim row, and requested_by is now
-- NOT NULL, so the old body would fail outright on every "Not me" tap. The
-- logic is otherwise byte-for-byte 003's — Postgres has no partial function
-- edit, so the whole thing has to come along.
--
-- requested_by = p_claimant because a dismissal is always the claimant
-- speaking about themselves; that is what "Not me" means. It matches what
-- bgb_cancel_ghost_claim writes when the target declines a proxy claim, so the
-- two routes to a dismissed row leave it in the same state.
CREATE OR REPLACE FUNCTION public.bgb_dismiss_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key TEXT := lower(btrim(COALESCE(p_display_name, '')));
  v_sum JSONB;
BEGIN
  IF v_key = '' THEN
    RETURN jsonb_build_object('error', 'display_name_required');
  END IF;
  IF p_owner = p_claimant THEN
    RETURN jsonb_build_object('error', 'own_roster');
  END IF;

  v_sum := bgb_ghost_summary(p_claimant, p_owner, v_key);

  INSERT INTO boardgamebuddy_ghost_claims
         (owner_id, ghost_name_key, ghost_display_name, claimant_id, status,
          resolved_at, requested_by)
  VALUES (p_owner, v_key,
          COALESCE(v_sum->>'ghost_display_name', btrim(p_display_name)),
          p_claimant, 'dismissed', now(), p_claimant)
  ON CONFLICT (owner_id, ghost_name_key, claimant_id) DO UPDATE
     SET status = 'dismissed', resolved_at = now(),
         requested_by = EXCLUDED.requested_by
   -- An accepted link is not a suggestion and must not be trampled by a
   -- stale "Not me" tap on a list rendered before the accept landed.
   WHERE boardgamebuddy_ghost_claims.status <> 'accepted';

  RETURN jsonb_build_object('dismissed', true);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_dismiss_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text) TO boardgamebuddy_role;


-- ── bgb_ghost_claims ──────────────────────────────────────────────────────────
-- Three lists now, and the middle one is re-keyed.
--
--   incoming  owner_id = viewer          — claims to answer (unchanged)
--   outgoing  requested_by = viewer      — asks I MADE. Was claimant_id, which
--                                          is wrong the moment the two differ:
--                                          a claim I raised for Dave would have
--                                          appeared in DAVE's sent list, with
--                                          the Cancel button, and never in mine.
--   for_me    claimant_id = viewer       — asks somebody made FOR me. Disjoint
--             AND requested_by <> me      from outgoing by construction.
CREATE OR REPLACE FUNCTION public.bgb_ghost_claims(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_incoming JSONB;
  v_outgoing JSONB;
  v_for_me   JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(x ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_incoming
    FROM (
      SELECT jsonb_build_object(
               'id',                        c.id,
               'direction',                 'incoming',
               'other_user_id',             cl.id,
               'other_display_name',        cl.display_name,
               'other_username',            cl.username,
               'other_avatar',              cl.avatar,
               'ghost_display_name',        c.ghost_display_name,
               'play_count',                COALESCE(st.play_count, 0),
               'last_played_at',            st.last_played_at,
               'created_at',                c.created_at,
               'requested_by',              c.requested_by,
               'requested_by_display_name', rq.display_name,
               'requested_by_avatar',       rq.avatar,
               'claimant_user_id',          cl.id,
               'claimant_display_name',     cl.display_name,
               'claimant_avatar',           cl.avatar,
               'is_proxy',                  c.requested_by <> c.claimant_id
             ) AS x,
             c.created_at
        FROM boardgamebuddy_ghost_claims c
        JOIN boardgamebuddy_profiles cl ON cl.id = c.claimant_id
        JOIN boardgamebuddy_profiles rq ON rq.id = c.requested_by
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::INT AS play_count, MAX(p.played_at) AS last_played_at
            FROM boardgamebuddy_plays p
            JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
           WHERE p.user_id = c.owner_id
             AND pp.player_user_id IS NULL
             AND lower(btrim(COALESCE(pp.player_display_name, ''))) = c.ghost_name_key
        ) st ON TRUE
       WHERE c.owner_id = p_viewer AND c.status = 'pending'
    ) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_outgoing
    FROM (
      SELECT jsonb_build_object(
               'id',                        c.id,
               'direction',                 'outgoing',
               'other_user_id',             ow.id,
               'other_display_name',        ow.display_name,
               'other_username',            ow.username,
               'other_avatar',              ow.avatar,
               'ghost_display_name',        c.ghost_display_name,
               'play_count',                COALESCE(st.play_count, 0),
               'last_played_at',            st.last_played_at,
               'created_at',                c.created_at,
               'requested_by',              c.requested_by,
               'requested_by_display_name', rq.display_name,
               'requested_by_avatar',       rq.avatar,
               'claimant_user_id',          cl.id,
               'claimant_display_name',     cl.display_name,
               'claimant_avatar',           cl.avatar,
               'is_proxy',                  c.requested_by <> c.claimant_id
             ) AS x,
             c.created_at
        FROM boardgamebuddy_ghost_claims c
        JOIN boardgamebuddy_profiles ow ON ow.id = c.owner_id
        JOIN boardgamebuddy_profiles cl ON cl.id = c.claimant_id
        JOIN boardgamebuddy_profiles rq ON rq.id = c.requested_by
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::INT AS play_count, MAX(p.played_at) AS last_played_at
            FROM boardgamebuddy_plays p
            JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
           WHERE p.user_id = c.owner_id
             AND pp.player_user_id IS NULL
             AND lower(btrim(COALESCE(pp.player_display_name, ''))) = c.ghost_name_key
        ) st ON TRUE
       WHERE c.requested_by = p_viewer AND c.status = 'pending'
    ) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_for_me
    FROM (
      SELECT jsonb_build_object(
               'id',                        c.id,
               'direction',                 'for_me',
               -- The far side of THIS row is the host: they are who has to say
               -- yes, and the only name worth reading on a row I did not raise.
               'other_user_id',             ow.id,
               'other_display_name',        ow.display_name,
               'other_username',            ow.username,
               'other_avatar',              ow.avatar,
               'ghost_display_name',        c.ghost_display_name,
               'play_count',                COALESCE(st.play_count, 0),
               'last_played_at',            st.last_played_at,
               'created_at',                c.created_at,
               'requested_by',              c.requested_by,
               'requested_by_display_name', rq.display_name,
               'requested_by_avatar',       rq.avatar,
               'claimant_user_id',          c.claimant_id,
               'claimant_display_name',     NULL::TEXT,
               'claimant_avatar',           NULL::JSONB,
               'is_proxy',                  true
             ) AS x,
             c.created_at
        FROM boardgamebuddy_ghost_claims c
        JOIN boardgamebuddy_profiles ow ON ow.id = c.owner_id
        JOIN boardgamebuddy_profiles rq ON rq.id = c.requested_by
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::INT AS play_count, MAX(p.played_at) AS last_played_at
            FROM boardgamebuddy_plays p
            JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
           WHERE p.user_id = c.owner_id
             AND pp.player_user_id IS NULL
             AND lower(btrim(COALESCE(pp.player_display_name, ''))) = c.ghost_name_key
        ) st ON TRUE
       WHERE c.claimant_id = p_viewer
         AND c.requested_by <> c.claimant_id
         AND c.status = 'pending'
    ) s;

  RETURN jsonb_build_object(
    'incoming', v_incoming,
    'outgoing', v_outgoing,
    'for_me',   v_for_me
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claims(p_viewer uuid) TO boardgamebuddy_role;


-- ── bgb_ghost_claim_detail ────────────────────────────────────────────────────
-- One field added: can_claim_for_buddy. It is deliberately NOT gated on
-- `collides`. A viewer who already sits on the play cannot claim it for
-- themselves — that ghost is somebody else — but they are often the best placed
-- person alive to say WHICH somebody else, so the proxy affordance survives the
-- block that kills the self one.
--
-- Per-buddy blocking is not precomputed: it depends on which buddy, and
-- bgb_create_ghost_claim answers it authoritatively for the one that gets
-- picked.
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
    'owner_user_id',       v_owner,
    'owner_display_name',  v_owner_row.display_name,
    'owner_username',      v_owner_row.username,
    'owner_avatar',        v_owner_row.avatar,
    'ghost_display_name',  v_sum->>'ghost_display_name',
    'ghost_name_key',      v_key,
    'play_count',          (v_sum->>'play_count')::INT,
    'last_played_at',      v_sum->'last_played_at',
    'last_game_name',      v_sum->>'last_game_name',
    'match_score',         NULL::NUMERIC,
    'claim_status',        CASE WHEN v_has_claim THEN v_claim.status ELSE NULL END,
    'claim_id',            CASE WHEN v_has_claim THEN v_claim.id ELSE NULL END,
    'can_claim',           v_reason IS NULL,
    'blocked_reason',      v_reason,
    'can_claim_for_buddy', v_owner <> p_viewer
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claim_detail(p_viewer uuid, p_play_id uuid, p_display_name text) TO boardgamebuddy_role;


-- ── bgb_notifications_unread ──────────────────────────────────────────────────
-- Two terms added, matching the two new arms of bgb_notifications below exactly
-- — same WHERE, plus the watermark. 010's rule still holds: the badge and the
-- rail have to be the same question asked twice, or they drift.
--
-- Both predicates are plain column comparisons over indexes that already exist
-- (idx_bgb_ghost_claims_owner_pending, idx_bgb_ghost_claims_claimant), so this
-- costs the badge nothing on an account with no claims — which is nearly all of
-- them, nearly all the time.
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
      -- A claim waiting on MY answer.
    + (SELECT COUNT(*)::int
         FROM boardgamebuddy_ghost_claims gc
        WHERE gc.owner_id = p_viewer
          AND gc.status = 'pending'
          AND gc.requested_by <> p_viewer
          AND gc.created_at > v_seen)
      -- A claim somebody raised FOR me, still waiting on the host.
    + (SELECT COUNT(*)::int
         FROM boardgamebuddy_ghost_claims gc
        WHERE gc.claimant_id = p_viewer
          AND gc.requested_by <> gc.claimant_id
          AND gc.status = 'pending'
          AND gc.created_at > v_seen)
    INTO v_n;

  RETURN v_n;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_notifications_unread(p_viewer uuid) TO boardgamebuddy_role;


-- ── bgb_notifications ─────────────────────────────────────────────────────────
-- Five arms now. The pipeline, the grouping, the cursor and the keyset order
-- are all 010's and unchanged; what is new is two CTEs over
-- boardgamebuddy_ghost_claims and three columns to carry what they say.
--
-- WHY NO EVENTS TABLE, AGAIN. A claim already stores created_at and already
-- mutates status in place. `status = 'pending'` is therefore the same kind of
-- source the buddy arms use: answering the claim — accept, reject, or a cancel
-- that deletes the row — takes it out of the feed for BOTH parties with no
-- bookkeeping and no way for the two to disagree.
--
-- Every CTE column is still aliased away from the RETURNS TABLE names: plpgsql
-- puts each output column in scope as a variable, so a bare `play_id` or `kind`
-- inside the query is ambiguous and fails at runtime rather than at create
-- time. Keep that discipline if you edit this.
DROP FUNCTION IF EXISTS public.bgb_notifications(uuid, int, timestamptz, text);

CREATE OR REPLACE FUNCTION public.bgb_notifications(
  p_viewer     uuid,
  p_limit      int         DEFAULT 20,
  p_before     timestamptz DEFAULT NULL,
  p_before_key text        DEFAULT NULL
)
 RETURNS TABLE (
   entry_key text,
   kind text,                    -- 'play_link' | 'buddy_request' | 'buddy_accepted'
                                 -- | 'ghost_claim' | 'ghost_claim_proxy'
   occurred_at timestamptz,
   is_unread boolean,
   actor_id uuid,
   actor_display_name text,
   actor_username text,
   actor_avatar jsonb,
   -- play_link only, EXCEPT play_id/game_name/game_thumbnail_url, which
   -- ghost_claim_proxy reuses for the play the claim was raised from — that is
   -- what lets its row carry the game's art and name the game.
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
   -- buddy_request / buddy_accepted only. The id the client posts to
   -- /buddies/{id}/accept and /buddies/{id}/reject, so a row can be answered
   -- where it is read.
   edge_id uuid,
   -- ghost_claim / ghost_claim_proxy only. Same idea as edge_id: the id the
   -- client posts to /ghost-claims/{id}/accept|reject|cancel.
   claim_id uuid,
   ghost_display_name text,      -- free text somebody else typed; escape it
   -- The OTHER person the row's sentence names, and which person that is
   -- differs by arm: on ghost_claim it is the claimant ("Sam says 'Dave' is
   -- Dave Smith"), on ghost_claim_proxy it is the host ("Sam asked Alice to
   -- link you"). The renderer knows which it got because it dispatched on kind.
   subject_display_name text
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
           NULL::uuid                            AS e_id,
           NULL::uuid                            AS c_id,
           NULL::text                            AS gname,
           NULL::text                            AS subj
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
           be.id                  AS e_id,
           NULL::uuid   AS c_id,      NULL::text AS gname,
           NULL::text   AS subj
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
           be.id                  AS e_id,
           NULL::uuid   AS c_id,      NULL::text AS gname,
           NULL::text   AS subj
    FROM boardgamebuddy_buddy_edges be
    WHERE be.status = 'accepted'
      AND be.accepted_at IS NOT NULL
      AND be.accepted_by IS NOT NULL
      AND be.accepted_by <> p_viewer
      AND (be.user_a = p_viewer OR be.user_b = p_viewer)
  ),
  -- TO THE HOST: somebody wants one of your ghosts linked to an account. Covers
  -- self-claims and proxy claims alike — the row tells them apart by whether
  -- the actor IS the subject, which is the same fact `is_proxy` carries
  -- elsewhere.
  --
  -- n_plays is the ghost's live play count, and it is the number the host's
  -- accept confirmation quotes back at them. It is the count at READ time; the
  -- truth is whatever rows_merged comes back as, which is why the confirmation
  -- says "every play", not "exactly seven".
  --
  -- rep_plays stays NULL: it drives the unlink tick-box, and a claim is not
  -- something you unlink yourself from.
  ghost_claim_rows AS (
    SELECT 'gc:' || gc.id::text   AS ekey,
           'ghost_claim'::text    AS nkind,
           gc.created_at          AS occ,
           gc.requested_by        AS act_id,
           NULL::text   AS pgroup,    NULL::uuid AS rep_play,
           NULL::uuid[] AS rep_plays,
           COALESCE(st.n, 0)      AS n_plays,
           NULL::int    AS n_games,    NULL::date AS from_at,
           NULL::date   AS to_at,      NULL::uuid AS rep_game,
           NULL::text   AS rep_name,   NULL::text AS rep_thumb,
           NULL::uuid   AS rep_batch,
           NULL::uuid   AS e_id,
           gc.id                  AS c_id,
           gc.ghost_display_name  AS gname,
           -- Who the plays would go to — and NULL on a self-claim, where the
           -- actor and the subject are one person and naming them twice in one
           -- sentence reads as two people. Its presence is therefore also how
           -- the renderer tells a proxy row from a self one, without having to
           -- compare two display names for equality.
           CASE WHEN gc.requested_by = gc.claimant_id THEN NULL
                ELSE cl.display_name END       AS subj
    FROM boardgamebuddy_ghost_claims gc
    JOIN boardgamebuddy_profiles cl ON cl.id = gc.claimant_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS n
        FROM boardgamebuddy_plays p
        JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
       WHERE p.user_id = gc.owner_id
         AND pp.player_user_id IS NULL
         AND lower(btrim(COALESCE(pp.player_display_name, ''))) = gc.ghost_name_key
    ) st ON TRUE
    WHERE gc.owner_id = p_viewer
      AND gc.status = 'pending'
      -- Never announce an act the viewer performed themselves. The table's
      -- owner<>claimant CHECK plus create's own_roster guard already make this
      -- unreachable; it is here so a future caller cannot make it reachable
      -- quietly.
      AND gc.requested_by <> p_viewer
  ),
  -- TO THE PERSON CLAIMED FOR: a buddy asked on your behalf. Informational plus
  -- a way out — only the HOST can say yes, so this row's one action is to call
  -- it off.
  --
  -- It reuses rep_play / rep_name / rep_thumb for the play the claim was raised
  -- from rather than adding parallel columns, which is what lets the row carry
  -- the game's art and say which game. LEFT JOIN, because origin_play_id is
  -- NULL on every row predating this migration and on any play since deleted —
  -- the row then reads without a game and is still correct.
  ghost_claim_proxy_rows AS (
    SELECT 'gcp:' || gc.id::text      AS ekey,
           'ghost_claim_proxy'::text  AS nkind,
           gc.created_at              AS occ,
           gc.requested_by            AS act_id,
           'act'::text  AS pgroup,
           gc.origin_play_id          AS rep_play,
           NULL::uuid[] AS rep_plays,
           COALESCE(st.n, 0)          AS n_plays,
           NULL::int    AS n_games,
           p.played_at                AS from_at,
           p.played_at                AS to_at,
           p.game_id                  AS rep_game,
           COALESCE(p.game_name, g.name)                   AS rep_name,
           COALESCE(p.game_thumbnail_url, g.thumbnail_url) AS rep_thumb,
           NULL::uuid   AS rep_batch,
           NULL::uuid   AS e_id,
           gc.id                      AS c_id,
           gc.ghost_display_name      AS gname,
           ow.display_name            AS subj   -- whose plays they are
    FROM boardgamebuddy_ghost_claims gc
    JOIN boardgamebuddy_profiles ow ON ow.id = gc.owner_id
    LEFT JOIN boardgamebuddy_plays p ON p.id = gc.origin_play_id
    LEFT JOIN boardgamebuddy_games g ON g.id = p.game_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS n
        FROM boardgamebuddy_plays p2
        JOIN boardgamebuddy_play_players pp ON pp.play_id = p2.id
       WHERE p2.user_id = gc.owner_id
         AND pp.player_user_id IS NULL
         AND lower(btrim(COALESCE(pp.player_display_name, ''))) = gc.ghost_name_key
    ) st ON TRUE
    WHERE gc.claimant_id = p_viewer
      AND gc.requested_by <> gc.claimant_id
      AND gc.status = 'pending'
  ),
  merged AS (
    SELECT * FROM play_rows
    UNION ALL SELECT * FROM request_rows
    UNION ALL SELECT * FROM accepted_rows
    UNION ALL SELECT * FROM ghost_claim_rows
    UNION ALL SELECT * FROM ghost_claim_proxy_rows
  )
  SELECT m.ekey, m.nkind, m.occ,
         (m.occ > COALESCE(v_seen, '-infinity'::timestamptz)),
         m.act_id, pr.display_name, pr.username, pr.avatar,
         m.pgroup, m.rep_play, m.rep_plays, m.n_plays, m.n_games,
         m.from_at, m.to_at, m.rep_game, m.rep_name, m.rep_thumb, m.rep_batch,
         m.e_id, m.c_id, m.gname, m.subj
  FROM merged m
  LEFT JOIN boardgamebuddy_profiles pr ON pr.id = m.act_id
  -- Keyset, not OFFSET: rows vanish from under the cursor as the user unlinks
  -- and as requests are answered, and an offset would skip whatever slid up
  -- into the gap. Still applied here over the whole union — page_keys has
  -- already applied the identical predicate to the play arm, which is a
  -- redundancy on that arm and the only filter the four other arms get.
  WHERE p_before IS NULL
     OR (m.occ, m.ekey) < (p_before, COALESCE(p_before_key, ''))
  ORDER BY m.occ DESC, m.ekey DESC
  LIMIT v_lim;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_notifications(p_viewer uuid, p_limit int, p_before timestamptz, p_before_key text) TO boardgamebuddy_role;
