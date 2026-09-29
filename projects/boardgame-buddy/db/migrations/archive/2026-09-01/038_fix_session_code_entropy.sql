-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — HOTFIX: session code generation broken on Supabase
--
-- 036's bgb_create_session called gen_random_bytes() (pgcrypto) under
-- SET search_path = public. On Supabase, pgcrypto lives in the `extensions`
-- schema (036's CREATE EXTENSION IF NOT EXISTS no-opped because it was
-- already installed there), so the unqualified call fails at runtime with
-- "function gen_random_bytes(integer) does not exist" → POST /sessions
-- 500s → the host's Gather screen renders with no session code.
--
-- Fix: derive code entropy from uuid_send(gen_random_uuid()) — both core
-- Postgres, no extension, schema-proof. A v4 UUID carries 122 random bits;
-- bytes 0-4 are fully random (the version/variant bits live in bytes 6
-- and 8), so five bytes mod 32 give five uniform Crockford chars per
-- attempt.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION public.bgb_create_session(
  p_host UUID,
  p_host_display_name TEXT,
  p_game UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Crockford base32, mirrors PLAY_SESSION_CODE_ALPHABET / _LENGTH in
  -- shared-backend/routes/boardgame_buddy/constants.py — keep in step.
  v_alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_code_len CONSTANT INT := 5;
  v_max_attempts CONSTANT INT := 6;
  v_bytes BYTEA;
  v_code TEXT;
  v_session_id UUID;
BEGIN
  -- The Log Play tab always opens a fresh session on entry to Gather; a
  -- host who navigated away would otherwise leave orphan open rows.
  UPDATE boardgamebuddy_play_sessions
     SET status = 'abandoned', phase = 'abandoned'
   WHERE host_user_id = p_host
     AND status = 'open';

  FOR attempt IN 1..v_max_attempts LOOP
    -- One v4 UUID per attempt as the entropy source. 256 % 32 = 0, so a
    -- random byte mod 32 is uniform over the alphabet.
    v_bytes := uuid_send(gen_random_uuid());
    v_code := '';
    FOR i IN 1..v_code_len LOOP
      v_code := v_code
        || substr(v_alphabet, 1 + (get_byte(v_bytes, i - 1) % 32), 1);
    END LOOP;
    BEGIN
      INSERT INTO boardgamebuddy_play_sessions
        (code, host_user_id, game_id, status, phase)
      VALUES (v_code, p_host, p_game, 'open', 'gather')
      RETURNING id INTO v_session_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_session_id := NULL;
    END;
  END LOOP;

  IF v_session_id IS NULL THEN
    RETURN jsonb_build_object('error', 'code_allocation_failed');
  END IF;

  INSERT INTO boardgamebuddy_play_session_participants
    (session_id, user_id, display_name)
  VALUES (v_session_id, p_host, p_host_display_name);

  RETURN bgb_session_bundle(v_session_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_create_session(UUID, TEXT, UUID) TO boardgamebuddy_role;

COMMIT;
