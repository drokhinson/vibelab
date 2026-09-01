-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy 003 — per-user BGG authentication + private collection fields
--
-- Adds the session/credential columns that let us authenticate xmlapi2 calls
-- as the linked BGG user (cookies obtained via POST /login/api/v1) instead of
-- relying on the shared registration token. Also extends collections with the
-- private fields BGG only returns to the authenticated owner of a collection
-- (showprivate=1).
--
-- Backwards compatibility: existing rows have bgg_username set but no encrypted
-- password. The backend treats that combination as auth_state="relink_required"
-- and prompts the user to re-link with their password. Nothing is destroyed.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Profile credentials/session ──────────────────────────────────────────────
ALTER TABLE public.boardgamebuddy_profiles
  -- Fernet-encrypted BGG password. Encrypted at rest with BGG_CREDENTIAL_KEY
  -- so the backend can silently re-login when the SessionID cookie expires.
  ADD COLUMN IF NOT EXISTS bgg_password_enc TEXT,
  -- Latest SessionID cookie value returned by POST /login/api/v1 plus the
  -- companion bggusername / bggpassword cookies BGG sets on login.
  ADD COLUMN IF NOT EXISTS bgg_session_id TEXT,
  ADD COLUMN IF NOT EXISTS bgg_session_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bgg_session_user_cookie TEXT,
  ADD COLUMN IF NOT EXISTS bgg_session_pass_cookie TEXT,
  ADD COLUMN IF NOT EXISTS bgg_last_login_at TIMESTAMPTZ;


-- ── Collection — private fields (only readable when authenticated as owner) ──
-- BGG returns these inside <privateinfo .../> on /collection?showprivate=1.
-- Numeric prices fit in NUMERIC(10,2) (max $99,999,999.99).
ALTER TABLE public.boardgamebuddy_collections
  ADD COLUMN IF NOT EXISTS bgg_private_comment   TEXT,
  ADD COLUMN IF NOT EXISTS bgg_acquired_from     TEXT,
  ADD COLUMN IF NOT EXISTS bgg_acquisition_date  DATE,
  ADD COLUMN IF NOT EXISTS bgg_purchase_price    NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS bgg_purchase_currency TEXT,
  ADD COLUMN IF NOT EXISTS bgg_inventory_location TEXT,
  ADD COLUMN IF NOT EXISTS bgg_quantity          INTEGER;
