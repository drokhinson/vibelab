-- ─────────────────────────────────────────────────────────────────────────────
-- 023 — Every play has somebody at the table, and nobody at it twice
-- ─────────────────────────────────────────────────────────────────────────────
-- Two things an import could produce that a live log never could:
--
--   1. A play with an EMPTY ROSTER. The Gather step refuses to advance without
--      a player (views/play-flow-view.js:_advanceToPlay), but all three
--      importers wrote whatever roster they happened to have — the notes
--      importer's `importable()` asked only for a matched game, the photo
--      importer's said so in as many words ("a play with nobody at it still
--      imports"), and a BGG play whose <players> element is absent — which is
--      most of them, since BGG never required one — imported as a play with no
--      seats at all. The result is a card in the feed with an empty scoreboard,
--      a play that counts towards nobody's record, and a row that no ghost can
--      ever be claimed off.
--
--   2. ONE ACCOUNT SEATED TWICE. The notes importer maps each distinct name the
--      note used onto a person, and two spellings of one buddy ("Jas" and
--      "Jasmine") are exactly what that step exists to resolve — its own help
--      text promises "point them at the same buddy … and they'll land as one
--      player". The review list honoured that (rowKeyFor keys a seat on the
--      ACCOUNT), but the write did not: toPayload emitted one seat per name.
--      So a two-player game imported with Jasmine in it twice, once winning.
--      The photo importer had the same hole from the other direction — it
--      deduped picks by display name, which two rows of one account can differ
--      in.
--
-- The ghost-linking paths have always known this was possible and guarded it
-- themselves: bgb_ghost_summary computes `collides` and both bgb_link_ghost and
-- bgb_accept_ghost_claim refuse a merge that would double-seat someone, with a
-- comment saying the check is the only thing stopping it. It no longer is.
--
-- WHAT THIS FILE DOES, in the order it has to happen:
--
--   • Folds the duplicate account seats that already exist into one seat each,
--     because the unique index below cannot be built over them.
--   • Seats the play's OWNER on every play that has no seats at all. Not an
--     invention: boardgamebuddy_plays.user_id already says whose play it is,
--     and bgb_user_stats already counts it as theirs (my_plays unions on
--     p.user_id). This writes down on the scoreboard what the play row already
--     claims, and moves no counter — win_count reads is_winner seats, and these
--     land with is_winner false and no score, which play-card.js reads as
--     "nobody said" rather than as a loss.
--   • Adds the unique index, so a repeat is a database error from here on
--     whatever writes it.
--   • Re-emits bgb_log_play with both invariants checked BEFORE it inserts
--     anything, so the two importers that go through it (notes, photo — and
--     every live write and lobby finalize) get a per-play error envelope
--     instead of a half-written play.
--
-- The BGG importer does not go through bgb_log_play — it writes the plays and
-- players tables directly, in bulk — so it is fixed in Python, in
-- bgg_link_routes._player_rows: BGG's own duplicates collapse and a play BGG
-- has no roster for is seated with the syncing account, which is the same rule
-- the backfill above applies to the rows already stored.


-- ─────────────────────────────────────────────────────────────────────────────
-- Repair 1 — fold duplicate account seats
-- ─────────────────────────────────────────────────────────────────────────────
-- The surviving seat is the one that says the most: a round breakdown over a
-- bare total, a total over neither, and among equals the one seated first. It
-- then absorbs the others' outcome — winning on any of the duplicate seats is
-- winning, and a score on any of them is the score the play recorded.
-- One statement, because both halves must read the same snapshot: the fold
-- ranks the seats and the delete removes everything the ranking did not keep,
-- and a two-statement version would re-rank rows the first statement had just
-- rewritten.
WITH ranked AS (
  SELECT
    pp.id,
    pp.play_id,
    pp.player_user_id,
    pp.is_winner,
    pp.score,
    row_number() OVER (
      PARTITION BY pp.play_id, pp.player_user_id
      ORDER BY (pp.round_scores IS NOT NULL) DESC,
               (pp.score IS NOT NULL) DESC,
               pp.linked_at,
               pp.id
    ) AS seat_no,
    count(*) OVER (PARTITION BY pp.play_id, pp.player_user_id) AS seats
  FROM public.boardgamebuddy_play_players pp
  WHERE pp.player_user_id IS NOT NULL
),
folded AS (
  SELECT
    play_id,
    player_user_id,
    bool_or(COALESCE(is_winner, false)) AS is_winner,
    max(score)                          AS score
  FROM ranked
  WHERE seats > 1
  GROUP BY play_id, player_user_id
),
gone AS (
  DELETE FROM public.boardgamebuddy_play_players pp
   USING ranked r
   WHERE pp.id = r.id
     AND r.seat_no > 1
  RETURNING pp.id
)
UPDATE public.boardgamebuddy_play_players pp
   SET is_winner = f.is_winner,
       score     = COALESCE(pp.score, f.score)
  FROM ranked r
  JOIN folded f
    ON f.play_id = r.play_id
   AND f.player_user_id = r.player_user_id
 WHERE pp.id = r.id
   AND r.seat_no = 1;


-- ─────────────────────────────────────────────────────────────────────────────
-- Repair 2 — seat the owner on plays that have nobody at all
-- ─────────────────────────────────────────────────────────────────────────────
-- player_user_id AND player_display_name, both: the id is what makes the seat
-- theirs to every counter and every join, and the name is what the scoreboard
-- prints for a profile that has since been deleted (the FK is ON DELETE SET
-- NULL, and the identity CHECK needs one of the two to survive).
--
-- linked_at is left at its default of now(), which is what it means: the seat
-- appeared today. Backdating it to the play would ring the notifications bell
-- for however many years of imported plays this touches.
INSERT INTO public.boardgamebuddy_play_players (
  play_id, player_user_id, player_display_name, is_winner, score
)
SELECT
  p.id,
  p.user_id,
  COALESCE(NULLIF(btrim(pr.display_name), ''), 'Me'),
  false,
  NULL
FROM public.boardgamebuddy_plays p
LEFT JOIN public.boardgamebuddy_profiles pr ON pr.id = p.user_id
WHERE NOT EXISTS (
  SELECT 1
    FROM public.boardgamebuddy_play_players pp
   WHERE pp.play_id = p.id
);


-- ─────────────────────────────────────────────────────────────────────────────
-- The constraint
-- ─────────────────────────────────────────────────────────────────────────────
-- Partial on the same predicate as idx_bgb_play_players_user_play: ghost seats
-- carry a NULL here and are deliberately NOT covered. Two ghosts of the same
-- name at one table is a real answer — two Daves — and the place to notice that
-- two spellings meant one person is the importer's mapping step, which now
-- collapses them before the write. An account is not a spelling.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bgb_play_players_play_user
  ON public.boardgamebuddy_play_players USING btree (play_id, player_user_id)
  WHERE player_user_id IS NOT NULL;

COMMENT ON INDEX public.uq_bgb_play_players_play_user IS
  'One account, one seat, per play (migration 023). Ghost seats (player_user_id NULL) are outside the predicate — two same-named ghosts at one table is a legitimate roster.';


-- ─────────────────────────────────────────────────────────────────────────────
-- bgb_log_play — the same function as 018, plus the roster gate
-- ─────────────────────────────────────────────────────────────────────────────
-- The roster is normalized ONCE into v_roster and then used for both the insert
-- and the echoed response, so the seats the caller is told about are the seats
-- that landed. Normalizing means dropping seats that name nobody: `name` is a
-- TEXT column and "" is not NULL, so a blank seat passes the identity CHECK and
-- puts an anonymous row on the scoreboard.
--
-- Both failures return an error envelope rather than raising, matching
-- game_not_found: bgb_import_plays counts an envelope as one failed play and
-- lands the other forty-nine, where an exception would take the whole chunk
-- down over one bad row. Both are checked before the INSERT, so a rejected play
-- leaves nothing behind.
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

  IF v_client_key IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.client_key = v_client_key;
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
      import_group_id, import_batch_id, imported_at, scoring_template
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
      v_template
    )
    RETURNING id, created_at INTO v_play;
  EXCEPTION WHEN unique_violation THEN
    -- Lost the race against a concurrent flush of the same queued play. The
    -- winner's row is the canonical one; hand its id back on the same
    -- duplicate envelope the pre-check uses.
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.client_key = v_client_key;
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
GRANT EXECUTE ON FUNCTION public.bgb_log_play(p_user uuid, p_payload jsonb) TO boardgamebuddy_role;
