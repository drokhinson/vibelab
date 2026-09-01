-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — ghost account claims ("is this you?")
--
-- A ghost player is not an entity. It is a boardgamebuddy_play_players row
-- with player_user_id IS NULL and a free-text player_display_name, and its
-- "owner" is implicit: whoever logged the play (boardgamebuddy_plays.user_id).
--
-- Until now the only way to attach a real account to those rows was
-- bgb_link_ghost (migration 050) — owner-initiated, unilateral, scoped to the
-- owner's own plays. There was no path in the other direction. If a buddy
-- logged you as "davo" for two years, that history was invisible to you and
-- you could do nothing about it.
--
-- This migration adds the missing direction. The CLAIMANT asks ("that ghost is
-- me"), the OWNER approves, and approving performs exactly the merge
-- bgb_link_ghost already performs. Consent runs claimant → owner, which is the
-- opposite of every existing ghost RPC, so none of them could be reused as-is.
--
-- ── Two deliberate departures from boardgamebuddy_buddy_edges ────────────────
--
-- The claim table mirrors the buddy-edge request flow (pending → accepted,
-- with reject/cancel) but differs in two ways, both on purpose:
--
--   1. NO requested_by. On a buddy edge that column disambiguates direction
--      across a canonical (user_a < user_b) pair. Here direction is structural
--      — claimant_id asks, owner_id answers — so a requested_by could only
--      ever hold claimant_id. A column that can only hold one value is a lie
--      waiting for someone to trust it. Add it only if owner-initiated invites
--      ("I think this ghost is you") ever ship.
--
--   2. A FULL UNIQUE on (owner_id, ghost_name_key, claimant_id), not a partial
--      unique on status='pending'. The triple IS the relationship; status
--      mutates in place. A partial-pending index would let rejected rows stack,
--      which is the nag path. The full unique plus reject_count gives a
--      two-strike rule in one column. The trade-off is no audit trail of
--      repeated asks — acceptable, and reject_count records the count.
--
-- ── The trigram index does NOT serve the suggestion query ────────────────────
--
-- idx_bgb_play_players_display_name_trgm (migration 039) is a GIN
-- gin_trgm_ops index, and GIN trigram indexes are only usable through the
-- %, <% and <-> operators. Those read pg_trgm.similarity_threshold, a
-- session GUC that can only be set by set_limit(), which is VOLATILE and
-- therefore illegal inside a STABLE function — and PostgREST runs non-volatile
-- RPCs in a READ ONLY transaction. So bgb_ghost_claim_suggestions uses
-- `similarity(a, b) >= threshold`, which is a FILTER, not an index condition.
--
-- That is fine, and it is fine for a specific reason: the candidate set is
-- narrowed FIRST to the viewer's accepted buddies' rosters (tens to low
-- hundreds of ghost rows), then scored. Do not "optimize" this back onto the
-- index — doing so requires set_limit() and breaks STABLE.
--
-- pg_trgm lives in the `extensions` schema (migration 039), so similarity()
-- is fully qualified rather than pulled onto the search_path.
--
-- ── One thing this cannot do ─────────────────────────────────────────────────
--
-- Accepting a claim rewrites plays on the OWNER's device's behalf, but the
-- CLAIMANT's client cannot be invalidated from here — their history silently
-- gains plays and they will see them when their SWR windows expire or on next
-- boot. There is no push channel today.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. The claim table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_ghost_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The ghost's implicit owner: whoever logged the plays the ghost rows sit
  -- on (boardgamebuddy_plays.user_id).
  owner_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  -- lower(btrim(player_display_name)). The match key, and exactly what
  -- bgb_link_ghost_rows matches on, so the rows a claim DESCRIBES are the
  -- rows an accept MOVES.
  ghost_name_key TEXT NOT NULL,
  -- Original casing, for display. Denormalized on purpose: the owner can
  -- rename or delete the underlying rows, and a request already sent has to
  -- keep reading the way it was sent.
  ghost_display_name TEXT NOT NULL,
  claimant_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  --   pending    — waiting on the owner
  --   accepted   — merged; rows_merged records how many
  --   rejected   — owner declined; reject_count is the strike counter
  --   dismissed  — claimant said "not me"; suppresses the suggestion
  --   superseded — another claimant's accept took the ghost out from under it
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'accepted', 'rejected', 'dismissed', 'superseded')),
  -- How many play_players rows the accept actually moved. Audit, and what the
  -- owner's toast says ("12 plays moved over").
  rows_merged INT,
  -- Two strikes. A decline is a real answer; a third ask is nagging.
  reject_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT bgb_ghost_claims_not_self CHECK (owner_id <> claimant_id),
  CONSTRAINT bgb_ghost_claims_key_normalized
    CHECK (ghost_name_key = lower(btrim(ghost_name_key)) AND ghost_name_key <> ''),
  CONSTRAINT uq_bgb_ghost_claims_triple UNIQUE (owner_id, ghost_name_key, claimant_id)
);

ALTER TABLE public.boardgamebuddy_ghost_claims ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_ghost_claims TO boardgamebuddy_role;

-- The owner's incoming list and the profile-bundle count both read exactly
-- this predicate.
CREATE INDEX IF NOT EXISTS idx_bgb_ghost_claims_owner_pending
  ON public.boardgamebuddy_ghost_claims (owner_id) WHERE status = 'pending';
-- The claimant's outgoing list, and the suggestion exclusion join.
CREATE INDEX IF NOT EXISTS idx_bgb_ghost_claims_claimant
  ON public.boardgamebuddy_ghost_claims (claimant_id, status);

-- ── 2. The merge, extracted once ─────────────────────────────────────────────
--
-- bgb_link_ghost (050) and bgb_accept_ghost_claim (below) must move the SAME
-- set of rows, or a claim can describe 12 plays and merge 9. One UPDATE, one
-- place, two callers.

CREATE OR REPLACE FUNCTION public.bgb_link_ghost_rows(
  p_owner UUID,
  p_name_key TEXT,
  p_target UUID
)
RETURNS INT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INT;
BEGIN
  -- Scoped to plays the owner logged, so a caller can never touch someone
  -- else's roster (the invariant migration 050 established).
  UPDATE boardgamebuddy_play_players pp
     SET player_user_id = p_target
   WHERE pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_owner
         )
     AND pp.player_user_id IS NULL
     AND lower(btrim(COALESCE(pp.player_display_name, ''))) = p_name_key;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

-- Signature unchanged, so migration 050's GRANT and
-- played_with_service.link_ghost both survive untouched.
--
-- SEMANTIC CHANGE, deliberate: the match moves from
--   player_display_name ILIKE p_display_name   (case-insensitive, UNTRIMMED)
-- to
--   lower(btrim(...)) = lower(btrim(p_display_name))
-- which is a widening — it now also catches ' Davo '. That is the fix that
-- makes the claim key and the merge agree on one set of rows.
CREATE OR REPLACE FUNCTION public.bgb_link_ghost(
  p_viewer UUID,
  p_display_name TEXT,
  p_target UUID
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_profiles WHERE id = p_target) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object(
    'updated',
    bgb_link_ghost_rows(p_viewer, lower(btrim(COALESCE(p_display_name, ''))), p_target)
  );
END;
$$;

-- ── 3. One ghost, summarized for one viewer ──────────────────────────────────
--
-- Every single-ghost path (the sheet's lookup, creating a claim, accepting
-- one) needs the same four facts, and they must agree: does the ghost still
-- exist, how big is it, can this viewer see it, and would merging seat the
-- viewer twice on one play. Computing them in three places is how they drift.
--
-- `visible` mirrors the FEED's rule (043_feed_perf_and_bootstrap_split.sql):
-- a play is visible when the viewer or any accepted buddy of theirs logged it
-- or appears on it. Anything narrower 403s on a card the user is looking at;
-- anything wider leaks.
--
-- `collides` is the double-seat guard. There is NO unique constraint on
-- (play_id, player_user_id) — see the note on bgb_accept_ghost_claim — so
-- this check is the only thing standing between a merge and the same person
-- appearing twice in one game.
CREATE OR REPLACE FUNCTION public.bgb_ghost_summary(
  p_viewer UUID,
  p_owner UUID,
  p_name_key TEXT
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
       AND pp.player_user_id IS NULL
       AND lower(btrim(COALESCE(pp.player_display_name, ''))) = p_name_key
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
$$;

-- ── 4. "Is this you?" — fuzzy-matched ghosts on the viewer's buddies' rosters ─
--
-- Scope is ACCEPTED BUDDIES ONLY. A proactive suggestion is the app volunteering
-- someone else's roster nickname, so it stays conservative; the sheet's
-- lookup path (bgb_ghost_claim_detail) is deliberately wider, because there
-- the user tapped a specific row they can already see.
--
-- Matching is trigram similarity against display_name and username, plus a
-- prefix/first-name branch, because the load-bearing case is a NICKNAME:
-- "davo" vs "Davo Smith" scores ~0.31 on trigrams alone and would miss.
-- The prefix branch is gated on length >= 3 (so "A" does not match "Amanda")
-- and on the key having no space (a full name is only ever matched by
-- trigram). starts_with() rather than LIKE so a name containing % or _ is
-- not read as a wildcard.
CREATE OR REPLACE FUNCTION public.bgb_ghost_claim_suggestions(
  p_viewer UUID,
  p_limit INT DEFAULT 10,
  p_threshold REAL DEFAULT 0.35
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
       AND pp.player_user_id IS NULL
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
$$;

-- ── 5. One ghost on one play, for the claim sheet ────────────────────────────
--
-- Takes the PLAY id, not the owner id: that is what a tapped scoreboard row
-- has, and it is what the visibility check needs.
--
-- No similarity filter here. The user tapped a specific row; the name matcher
-- does not get a veto over a deliberate act. Everything that WOULD block the
-- claim is returned as blocked_reason so the sheet paints a truthful disabled
-- state instead of a button that 409s.
CREATE OR REPLACE FUNCTION public.bgb_ghost_claim_detail(
  p_viewer UUID,
  p_play_id UUID,
  p_display_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

-- ── 6. Both sides of the request list ────────────────────────────────────────
--
-- An RPC rather than PostgREST + Python because every row needs a LIVE
-- play_count / last_played_at for the ghost, and doing that per claim in
-- Python is the exact N+1 that migrations 047 and 050 exist to remove.
CREATE OR REPLACE FUNCTION public.bgb_ghost_claims(p_viewer UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
             AND pp.player_user_id IS NULL
             AND lower(btrim(COALESCE(pp.player_display_name, ''))) = c.ghost_name_key
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
             AND pp.player_user_id IS NULL
             AND lower(btrim(COALESCE(pp.player_display_name, ''))) = c.ghost_name_key
        ) st ON TRUE
       WHERE c.claimant_id = p_viewer AND c.status = 'pending'
    ) s;

  RETURN jsonb_build_object('incoming', v_incoming, 'outgoing', v_outgoing);
END;
$$;

-- ── 7. Send a claim ──────────────────────────────────────────────────────────
--
-- Validation and upsert in one call so there is no window between "the ghost
-- exists, is visible, and does not collide" and the row that asserts it.
CREATE OR REPLACE FUNCTION public.bgb_create_ghost_claim(
  p_claimant UUID,
  p_owner UUID,
  p_display_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key   TEXT := lower(btrim(COALESCE(p_display_name, '')));
  v_sum   JSONB;
  v_claim RECORD;
  v_has_claim BOOLEAN := false;
  v_id    UUID;
  v_out   JSONB;
BEGIN
  IF v_key = '' THEN
    RETURN jsonb_build_object('error', 'display_name_required');
  END IF;
  IF p_owner = p_claimant THEN
    -- Their own roster. POST /ghost-players/link is the tool for that.
    RETURN jsonb_build_object('error', 'own_roster');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_profiles WHERE id = p_owner) THEN
    RETURN jsonb_build_object('error', 'claim_not_found');
  END IF;

  SELECT * INTO v_claim
    FROM boardgamebuddy_ghost_claims
   WHERE owner_id = p_owner AND ghost_name_key = v_key AND claimant_id = p_claimant
     FOR UPDATE;
  v_has_claim := FOUND;

  -- Checked BEFORE the ghost lookup, and only for this claimant: once a claim
  -- is accepted the ghost rows no longer exist (they are the claimant's own
  -- rows now), so an exists-first order would answer a re-tap with the
  -- technically-true but useless "ghost_gone" instead of "that is already
  -- linked to your account".
  IF v_has_claim AND v_claim.status = 'accepted' THEN
    RETURN jsonb_build_object('error', 'already_linked');
  END IF;

  v_sum := bgb_ghost_summary(p_claimant, p_owner, v_key);

  IF NOT (v_sum->>'exists')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'ghost_gone');
  END IF;
  IF NOT (v_sum->>'visible')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'not_visible');
  END IF;
  IF (v_sum->>'collides')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'already_seated');
  END IF;

  IF v_has_claim THEN
    IF v_claim.status = 'pending' THEN
      -- Idempotent, matching buddy_service.send_request: asking twice is one ask.
      v_id := v_claim.id;
    ELSIF v_claim.reject_count >= 2 THEN
      RETURN jsonb_build_object('error', 'declined_twice');
    ELSE
      -- rejected (once), dismissed, or superseded: re-ask is allowed. The
      -- strike counter is NOT reset — that is what makes two strikes stick.
      UPDATE boardgamebuddy_ghost_claims
         SET status = 'pending',
             resolved_at = NULL,
             created_at = now(),
             ghost_display_name = COALESCE(v_sum->>'ghost_display_name', ghost_display_name)
       WHERE id = v_claim.id
       RETURNING id INTO v_id;
    END IF;
  ELSE
    INSERT INTO boardgamebuddy_ghost_claims
           (owner_id, ghost_name_key, ghost_display_name, claimant_id, status)
    VALUES (p_owner, v_key,
            COALESCE(v_sum->>'ghost_display_name', btrim(p_display_name)),
            p_claimant, 'pending')
    RETURNING id INTO v_id;
  END IF;

  SELECT jsonb_build_object(
           'id',                 c.id,
           'direction',          'outgoing',
           'other_user_id',      pr.id,
           'other_display_name', pr.display_name,
           'other_username',     pr.username,
           'other_avatar',       pr.avatar,
           'ghost_display_name', c.ghost_display_name,
           'play_count',         (v_sum->>'play_count')::INT,
           'last_played_at',     v_sum->'last_played_at',
           'created_at',         c.created_at
         )
    INTO v_out
    FROM boardgamebuddy_ghost_claims c
    JOIN boardgamebuddy_profiles pr ON pr.id = c.owner_id
   WHERE c.id = v_id;

  RETURN v_out;
END;
$$;

-- ── 8. Accept — the merge ────────────────────────────────────────────────────
--
-- NOTE: boardgamebuddy_play_players has NO unique constraint on
-- (play_id, player_user_id) — its only check is bgb_play_players_identity_chk.
-- Nothing in the database stops the same account appearing twice in one game.
-- The collision guard is therefore re-evaluated HERE, not just at request
-- time, because the claimant may have been added to one of these plays in
-- between.
CREATE OR REPLACE FUNCTION public.bgb_accept_ghost_claim(
  p_owner UUID,
  p_claim_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
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
           'id',                 c.id,
           'direction',          'incoming',
           'other_user_id',      pr.id,
           'other_display_name', pr.display_name,
           'other_username',     pr.username,
           'other_avatar',       pr.avatar,
           'ghost_display_name', c.ghost_display_name,
           'play_count',         c.rows_merged,
           'last_played_at',     NULL::DATE,
           'created_at',         c.created_at
         )
    INTO v_out
    FROM boardgamebuddy_ghost_claims c
    JOIN boardgamebuddy_profiles pr ON pr.id = c.claimant_id
   WHERE c.id = v_claim.id;

  RETURN jsonb_build_object('updated', v_updated, 'claim', v_out);
END;
$$;

-- ── 9. Decline ───────────────────────────────────────────────────────────────
--
-- An RPC because reject_count must be incremented from its current value, and
-- PostgREST cannot express `col = col + 1`. Contrast bgb cancel (the claimant
-- withdrawing), which is a plain ownership-checked DELETE and lives in Python:
-- withdrawing your own ask is not a decline and must not burn a strike.
CREATE OR REPLACE FUNCTION public.bgb_reject_ghost_claim(
  p_owner UUID,
  p_claim_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim RECORD;
BEGIN
  SELECT * INTO v_claim
    FROM boardgamebuddy_ghost_claims
   WHERE id = p_claim_id
     FOR UPDATE;

  IF NOT FOUND OR v_claim.owner_id <> p_owner THEN
    RETURN jsonb_build_object('error', 'claim_not_found');
  END IF;
  IF v_claim.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'not_pending');
  END IF;

  UPDATE boardgamebuddy_ghost_claims
     SET status = 'rejected',
         resolved_at = now(),
         reject_count = reject_count + 1
   WHERE id = v_claim.id;

  RETURN jsonb_build_object('rejected', true);
END;
$$;

-- ── 10. "Not me" ─────────────────────────────────────────────────────────────
--
-- The claimant suppressing a suggestion. Keyed by (owner, name) like every
-- other claim operation, and it writes the same row a real claim would, so a
-- later change of mind flips it back to pending without a second row.
CREATE OR REPLACE FUNCTION public.bgb_dismiss_ghost_claim(
  p_claimant UUID,
  p_owner UUID,
  p_display_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
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
         (owner_id, ghost_name_key, ghost_display_name, claimant_id, status, resolved_at)
  VALUES (p_owner, v_key,
          COALESCE(v_sum->>'ghost_display_name', btrim(p_display_name)),
          p_claimant, 'dismissed', now())
  ON CONFLICT (owner_id, ghost_name_key, claimant_id) DO UPDATE
     SET status = 'dismissed', resolved_at = now()
   -- An accepted link is not a suggestion and must not be trampled by a
   -- stale "Not me" tap on a list rendered before the accept landed.
   WHERE boardgamebuddy_ghost_claims.status <> 'accepted';

  RETURN jsonb_build_object('dismissed', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.bgb_link_ghost_rows(UUID, TEXT, UUID) TO boardgamebuddy_role;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_summary(UUID, UUID, TEXT) TO boardgamebuddy_role;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claim_suggestions(UUID, INT, REAL) TO boardgamebuddy_role;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claim_detail(UUID, UUID, TEXT) TO boardgamebuddy_role;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claims(UUID) TO boardgamebuddy_role;
GRANT EXECUTE ON FUNCTION public.bgb_create_ghost_claim(UUID, UUID, TEXT) TO boardgamebuddy_role;
GRANT EXECUTE ON FUNCTION public.bgb_accept_ghost_claim(UUID, UUID) TO boardgamebuddy_role;
GRANT EXECUTE ON FUNCTION public.bgb_reject_ghost_claim(UUID, UUID) TO boardgamebuddy_role;
GRANT EXECUTE ON FUNCTION public.bgb_dismiss_ghost_claim(UUID, UUID, TEXT) TO boardgamebuddy_role;

COMMIT;
