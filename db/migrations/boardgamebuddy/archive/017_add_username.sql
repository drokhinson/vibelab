-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — add stable `username` handle to profiles
--
-- Until now we surfaced a single `display_name` for every user. Settings
-- conflated identity with how the name is presented, and buddy search
-- couldn't fall back to anything when a user renamed themselves to
-- something ambiguous like "Dad".
--
-- This migration adds an immutable, lowercased handle:
--   - `username` is unique, non-null, 3–30 chars, [a-z0-9_]
--   - Backfilled from auth.users.email's local-part, alnum + underscore
--     only, lowercased
--   - Collisions get a numeric suffix (2, 3, …) ordered by created_at
--   - Empty/missing email falls back to "user_" || first 8 chars of UUID
--   - Future user-facing settings will treat it as readonly; new signups
--     pick it up from email on first auth (see dependencies.py).
--
-- The FE Settings page surfaces this handle next to (readonly) the
-- display_name field, and the profile-search endpoint matches on both
-- columns so people can find each other by handle when display names
-- collide.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_profiles
  ADD COLUMN IF NOT EXISTS username TEXT;

-- Step 1: seed `username` from the auth email local-part.
UPDATE public.boardgamebuddy_profiles AS p
SET username = LOWER(
  REGEXP_REPLACE(
    SPLIT_PART(COALESCE(u.email, ''), '@', 1),
    '[^a-zA-Z0-9_]',
    '',
    'g'
  )
)
FROM auth.users AS u
WHERE u.id = p.id
  AND p.username IS NULL;

-- Step 2: anyone we couldn't seed (empty email / fully stripped) falls
-- back to a UUID-prefixed handle so the NOT NULL constraint can hold.
UPDATE public.boardgamebuddy_profiles
SET username = 'user_' || SUBSTRING(id::text FROM 1 FOR 8)
WHERE username IS NULL OR LENGTH(username) = 0;

-- Step 3: dedupe collisions with a numeric suffix. ROW_NUMBER orders by
-- created_at so the oldest profile keeps the bare handle.
WITH numbered AS (
  SELECT
    id,
    username,
    ROW_NUMBER() OVER (PARTITION BY username ORDER BY created_at, id) AS rn
  FROM public.boardgamebuddy_profiles
)
UPDATE public.boardgamebuddy_profiles AS p
SET username = n.username || n.rn::text
FROM numbered AS n
WHERE n.id = p.id
  AND n.rn > 1;

-- Step 4: pad anything still under 3 chars so the length CHECK below holds.
UPDATE public.boardgamebuddy_profiles
SET username = RPAD(username, 3, '0')
WHERE LENGTH(username) < 3;

-- Step 5: lock the column down.
ALTER TABLE public.boardgamebuddy_profiles
  ALTER COLUMN username SET NOT NULL,
  ADD CONSTRAINT bgb_profiles_username_format
    CHECK (username ~ '^[a-z0-9_]{3,30}$');

CREATE UNIQUE INDEX IF NOT EXISTS bgb_profiles_username_uk
  ON public.boardgamebuddy_profiles (username);
