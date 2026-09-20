-- ─────────────────────────────────────────────────────────────────────────────
-- 049_account_deletion_handover.sql — the behavioural half of migration 049
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY THIS FILE EXISTS. api/tests/ drives the deletion service against a fake
-- PostgREST; there is no Postgres in that suite, so the part of this feature
-- that decides WHO INHERITS A PLAY has no test there and cannot have one. This
-- is that test. It seeds seven plays covering every branch of
-- bgb_delete_account_rows, runs it, and asserts the outcome.
--
-- SAFE TO RUN ANYWHERE, including production: the whole thing is one
-- transaction that ends in ROLLBACK. Nothing it writes survives, and the one
-- destructive call it makes is scoped to a uuid it invented two statements
-- earlier. It still writes WAL, so prefer a scratch database — but a
-- misfire cannot cost you an account.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/049_account_deletion_handover.sql
--
-- Every check is an ASSERT inside one DO block, so the first failure raises
-- with the name of the property that broke and nothing further runs. Silence
-- plus "ALL 049 CHECKS PASSED" is a pass.
--
-- Standing up a throwaway database to run it against, from this repo's own
-- snapshot, needs four Supabase-isms the snapshot references and a local
-- cluster does not have:
--
--   CREATE ROLE anon; CREATE ROLE authenticated;
--   CREATE ROLE service_role; CREATE ROLE boardgamebuddy_role;
--   CREATE SCHEMA auth;  CREATE TABLE auth.users (id UUID PRIMARY KEY);
--   CREATE SCHEMA extensions; CREATE EXTENSION pg_trgm SCHEMA extensions;
--   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
--     AS $$ SELECT NULL::uuid $$;
--
-- then db/schema/boardgamebuddy.sql, then db/migrations/049_*.sql.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $test$
DECLARE
  a_id   CONSTANT uuid := gen_random_uuid();   -- the account being deleted
  b_id   CONSTANT uuid := gen_random_uuid();   -- seated first, usually the heir
  c_id   CONSTANT uuid := gen_random_uuid();   -- seated later
  game   CONSTANT uuid := gen_random_uuid();
  p1     CONSTANT uuid := gen_random_uuid();   -- two accounts seated → B
  p2     CONSTANT uuid := gen_random_uuid();   -- A alone → deleted
  p3     CONSTANT uuid := gen_random_uuid();   -- A + a ghost → deleted
  p4     CONSTANT uuid := gen_random_uuid();   -- BGA collision on B → C
  p4b    CONSTANT uuid := gen_random_uuid();   -- B's own row for that table
  p5     CONSTANT uuid := gen_random_uuid();   -- B's play, A seated → untouched
  p6     CONSTANT uuid := gen_random_uuid();   -- photo under A's prefix → B
  p7     CONSTANT uuid := gen_random_uuid();   -- A's seat has NO display name
  p8     CONSTANT uuid := gen_random_uuid();   -- every candidate collides → gone
  p8b    CONSTANT uuid := gen_random_uuid();   -- B's own row for that table
  res    jsonb;
  owner_of uuid;
  n      int;
  txt    text;
  ts     timestamptz;
BEGIN
  INSERT INTO boardgamebuddy_profiles (id, display_name, username) VALUES
    (a_id, 'Dave', 'dave_' || left(a_id::text, 8)),
    (b_id, 'Bella','bella_' || left(b_id::text, 8)),
    (c_id, 'Cara', 'cara_' || left(c_id::text, 8));
  INSERT INTO boardgamebuddy_games (id, name) VALUES (game, 'Test Game');

  INSERT INTO boardgamebuddy_plays (id, user_id, game_id, game_name, played_at) VALUES
    (p1, a_id, game, 'Test Game', DATE '2026-01-01'),
    (p2, a_id, game, 'Test Game', DATE '2026-01-02'),
    (p3, a_id, game, 'Test Game', DATE '2026-01-03'),
    (p5, b_id, game, 'Test Game', DATE '2026-01-05'),
    (p7, b_id, game, 'Test Game', DATE '2026-01-07');
  INSERT INTO boardgamebuddy_plays (id, user_id, game_id, game_name, played_at, bga_table_id) VALUES
    (p4b, b_id, game, 'Test Game', DATE '2026-01-04', 987654321),
    (p4,  a_id, game, 'Test Game', DATE '2026-01-04', 987654321),
    -- p8 is p4 with the fallback removed: B is the ONLY other account seated,
    -- and B already holds this table. No candidate survives the collision
    -- guard, so there is nobody to pass it to and the cascade takes it.
    (p8b, b_id, game, 'Test Game', DATE '2026-01-08', 123456789),
    (p8,  a_id, game, 'Test Game', DATE '2026-01-08', 123456789);
  INSERT INTO boardgamebuddy_plays (id, user_id, game_id, game_name, played_at, photo_url) VALUES
    (p6, a_id, game, 'Test Game', DATE '2026-01-06',
     'https://img.bgbuddy.app/' || a_id::text || '/deadbeef.jpg');

  INSERT INTO boardgamebuddy_play_players (play_id, player_user_id, player_display_name, linked_at) VALUES
    (p1, a_id, 'Dave',  '2026-01-01 10:00Z'),
    (p1, b_id, 'Bella', '2026-01-01 10:01Z'),   -- earliest non-A seat
    (p1, c_id, 'Cara',  '2026-01-01 10:02Z'),
    (p2, a_id, 'Dave',  '2026-01-02 10:00Z'),
    (p3, a_id, 'Dave',  '2026-01-03 10:00Z'),
    (p3, NULL, 'Ghost', '2026-01-03 10:01Z'),   -- a ghost is not an heir
    (p4, b_id, 'Bella', '2026-01-04 10:00Z'),   -- earliest, but collides
    (p4, c_id, 'Cara',  '2026-01-04 10:05Z'),
    (p5, b_id, 'Bella', '2026-01-05 10:00Z'),
    (p5, a_id, 'Dave',  '2026-01-05 10:01Z'),
    (p6, b_id, 'Bella', '2026-01-06 10:00Z'),
    (p7, b_id, 'Bella', '2026-01-07 10:00Z'),
    (p7, a_id, NULL,    '2026-01-07 10:01Z'),   -- the identity-CHECK landmine
    (p8, a_id, 'Dave',  '2026-01-08 10:00Z'),
    (p8, b_id, 'Bella', '2026-01-08 10:01Z');   -- the only heir, and it collides

  -- ── the act ────────────────────────────────────────────────────────────────
  res := bgb_delete_account_rows(a_id);

  -- ── 1. the counts ──────────────────────────────────────────────────────────
  ASSERT (res->>'plays_reassigned')::int = 3,
    'expected 3 plays handed over, got ' || COALESCE(res->>'plays_reassigned','?');
  ASSERT (res->>'plays_deleted')::int = 3,
    'expected 3 plays deleted, got ' || COALESCE(res->>'plays_deleted','?');
  ASSERT (res->>'photos_unlinked')::int = 1,
    'expected 1 photo unlinked, got ' || COALESCE(res->>'photos_unlinked','?');
  ASSERT (res->>'names_backfilled')::int = 1,
    'expected 1 name backfilled, got ' || COALESCE(res->>'names_backfilled','?');

  -- ── 2. the heir is the EARLIEST SEATED account ─────────────────────────────
  SELECT user_id INTO owner_of FROM boardgamebuddy_plays WHERE id = p1;
  ASSERT owner_of = b_id, 'p1 should have gone to the earliest-seated account';

  SELECT inherited_from_name INTO txt FROM boardgamebuddy_plays WHERE id = p1;
  ASSERT txt = 'Dave', 'p1 should name the account it came from, got ' || COALESCE(txt,'NULL');

  -- ── 3. a colliding heir is SKIPPED, not fatal ──────────────────────────────
  -- B already holds a play for BGA table 987654321, so handing p4 to B would
  -- violate (user_id, bga_table_id) and abort the whole deletion. C inherits.
  SELECT user_id INTO owner_of FROM boardgamebuddy_plays WHERE id = p4;
  ASSERT owner_of = c_id,
    'p4 must skip the colliding earliest-seated account and go to the next one';
  ASSERT EXISTS (SELECT 1 FROM boardgamebuddy_plays WHERE id = p4b AND user_id = b_id),
    'the heir''s own colliding play must be left alone';

  -- ── 4. a play nobody else was at is still deleted ──────────────────────────
  ASSERT NOT EXISTS (SELECT 1 FROM boardgamebuddy_plays WHERE id = p2),
    'a play with only the deleted account seated must not survive';
  ASSERT NOT EXISTS (SELECT 1 FROM boardgamebuddy_plays WHERE id = p3),
    'a ghost is not an account and must not keep a play alive';

  -- The other way to have nobody to pass to: the only seated account is one
  -- the play cannot legally move to. "No candidate" and "no other player" have
  -- to end the same way, or a collision would silently keep a play alive under
  -- a deleted account's id.
  ASSERT NOT EXISTS (SELECT 1 FROM boardgamebuddy_plays WHERE id = p8),
    'a play whose every candidate heir collides must fall through to the cascade';
  ASSERT EXISTS (SELECT 1 FROM boardgamebuddy_plays WHERE id = p8b AND user_id = b_id),
    'and the heir''s own colliding play must still be left alone';

  -- ── 5. the photo link is cleared, not left dangling ────────────────────────
  SELECT photo_url INTO txt FROM boardgamebuddy_plays WHERE id = p6;
  ASSERT txt IS NULL,
    'a surviving play must not point at an object the purge deleted';

  -- ── 6. somebody else's play is untouched, and the seat becomes a ghost ─────
  SELECT user_id INTO owner_of FROM boardgamebuddy_plays WHERE id = p5;
  ASSERT owner_of = b_id, 'a play the deleted account merely sat at must not move';
  SELECT inherited_at INTO ts FROM boardgamebuddy_plays WHERE id = p5;
  ASSERT ts IS NULL, 'a play that did not change hands must not be stamped';

  SELECT count(*) INTO n
    FROM boardgamebuddy_play_players
   WHERE play_id = p5 AND player_user_id IS NULL AND player_display_name = 'Dave';
  ASSERT n = 1, 'the deleted account''s seat must survive as a NAMED ghost';

  -- ── 7. the identity-CHECK landmine ─────────────────────────────────────────
  -- Without the backfill this seat would go (NULL, NULL) under the FK's SET
  -- NULL, Postgres re-checks the CHECK on that update, and the whole DELETE
  -- raises — account deletion 500s permanently for anyone holding such a row.
  SELECT player_display_name INTO txt
    FROM boardgamebuddy_play_players
   WHERE play_id = p7 AND player_user_id IS NULL;
  ASSERT txt = 'Dave',
    'a nameless seat must be given the account''s name before the FK nulls it';

  -- ── 8. the account itself is gone ──────────────────────────────────────────
  ASSERT NOT EXISTS (SELECT 1 FROM boardgamebuddy_profiles WHERE id = a_id),
    'the profile row must be deleted in the same transaction';

  -- ── 9. the heir is told ────────────────────────────────────────────────────
  SELECT count(*) INTO n
    FROM bgb_notifications(b_id, 50, NULL, NULL)
   WHERE kind = 'play_inherited';
  ASSERT n = 2, 'B inherited p1 and p6 and should have two notifications, got ' || n;

  SELECT actor_display_name INTO txt
    FROM bgb_notifications(b_id, 50, NULL, NULL)
   WHERE kind = 'play_inherited' LIMIT 1;
  ASSERT txt = 'Dave',
    'the notification must name the deleted account, got ' || COALESCE(txt,'NULL');

  SELECT actor_id::text INTO txt
    FROM bgb_notifications(b_id, 50, NULL, NULL)
   WHERE kind = 'play_inherited' LIMIT 1;
  ASSERT txt IS NULL,
    'play_inherited has no actor id — the profile it would name is gone';

  -- ── 10. THE OTHER KINDS STILL NAME THEIR ACTOR ─────────────────────────────
  -- 049 rewrote the final SELECT's actor_display_name into
  -- COALESCE(pr.display_name, m.act_name) so the new arm could carry a name
  -- for an account that no longer exists. Every other kind still has a live
  -- profile behind actor_id and must still read from the join, not the
  -- coalesce — and act_name is NULL on those arms, so a regression here shows
  -- up as a nameless buddy row rather than as an error.
  INSERT INTO boardgamebuddy_buddy_edges (user_a, user_b, status, requested_by)
    VALUES (LEAST(b_id, c_id), GREATEST(b_id, c_id), 'pending', c_id);

  SELECT actor_display_name INTO txt
    FROM bgb_notifications(b_id, 50, NULL, NULL)
   WHERE kind = 'buddy_request' LIMIT 1;
  ASSERT txt = 'Cara',
    'a buddy_request must still take its actor from the profile join, got '
    || COALESCE(txt, 'NULL');

  -- ── 11. the watermark still governs the bell ───────────────────────────────
  UPDATE boardgamebuddy_profiles SET link_notifications_seen_at = now()
   WHERE id = b_id;
  SELECT count(*) INTO n
    FROM bgb_notifications(b_id, 50, NULL, NULL)
   WHERE kind = 'play_inherited' AND is_unread;
  ASSERT n = 0, 'a read handover must stop counting as unread';

  -- ── 12. idempotent: the caller retries this after a partial failure ────────
  res := bgb_delete_account_rows(a_id);
  ASSERT (res->>'plays_reassigned')::int = 0
     AND (res->>'plays_deleted')::int = 0,
    're-running on an already-deleted account must be a no-op, not an error';

  RAISE NOTICE 'ALL 049 CHECKS PASSED';
END
$test$;

ROLLBACK;
