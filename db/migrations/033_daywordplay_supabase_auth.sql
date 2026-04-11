-- ─────────────────────────────────────────────────────────────────────────────
-- 033 — Day Word Play: migrate from custom auth to Supabase Auth
--
-- Drops all daywordplay tables and rebuilds with daywordplay_profiles
-- linked to auth.users via ON DELETE CASCADE.
--
-- WARNING: This migration deletes all existing user + game data.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Drop all user-owned tables (order matters for FK deps)
DROP TABLE IF EXISTS public.daywordplay_join_requests CASCADE;
DROP TABLE IF EXISTS public.daywordplay_proposed_words CASCADE;
DROP TABLE IF EXISTS public.daywordplay_bookmarks CASCADE;
DROP TABLE IF EXISTS public.daywordplay_votes CASCADE;
DROP TABLE IF EXISTS public.daywordplay_sentences CASCADE;
DROP TABLE IF EXISTS public.daywordplay_daily_words CASCADE;
DROP TABLE IF EXISTS public.daywordplay_group_members CASCADE;
DROP TABLE IF EXISTS public.daywordplay_groups CASCADE;
DROP TABLE IF EXISTS public.daywordplay_users CASCADE;

-- 2. Create profile table linked to Supabase Auth
CREATE TABLE public.daywordplay_profiles (
  id            UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username      TEXT        UNIQUE NOT NULL,
  display_name  TEXT,
  email         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.daywordplay_profiles ENABLE ROW LEVEL SECURITY;

-- 3. Recreate groups (created_by now references profiles)
CREATE TABLE public.daywordplay_groups (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  code       CHAR(4)     UNIQUE NOT NULL,
  created_by UUID        REFERENCES public.daywordplay_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.daywordplay_groups ENABLE ROW LEVEL SECURITY;

-- 4. Recreate group_members
CREATE TABLE public.daywordplay_group_members (
  id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id  UUID        NOT NULL REFERENCES public.daywordplay_groups(id) ON DELETE CASCADE,
  user_id   UUID        NOT NULL REFERENCES public.daywordplay_profiles(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, user_id)
);
ALTER TABLE public.daywordplay_group_members ENABLE ROW LEVEL SECURITY;

-- 5. Words table stays the same (no user FK), but we need to keep it
-- daywordplay_words is NOT dropped — it's reference data with seed words.

-- 6. Recreate daily_words
CREATE TABLE public.daywordplay_daily_words (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      UUID        NOT NULL REFERENCES public.daywordplay_groups(id) ON DELETE CASCADE,
  word_id       UUID        NOT NULL REFERENCES public.daywordplay_words(id) ON DELETE CASCADE,
  assigned_date DATE        NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, assigned_date)
);
ALTER TABLE public.daywordplay_daily_words ENABLE ROW LEVEL SECURITY;

-- 7. Recreate sentences
CREATE TABLE public.daywordplay_sentences (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      UUID        NOT NULL REFERENCES public.daywordplay_groups(id) ON DELETE CASCADE,
  word_id       UUID        NOT NULL REFERENCES public.daywordplay_words(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES public.daywordplay_profiles(id) ON DELETE CASCADE,
  sentence      TEXT        NOT NULL,
  assigned_date DATE        NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, user_id, assigned_date)
);
ALTER TABLE public.daywordplay_sentences ENABLE ROW LEVEL SECURITY;

-- 8. Recreate votes
CREATE TABLE public.daywordplay_votes (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sentence_id   UUID        NOT NULL REFERENCES public.daywordplay_sentences(id) ON DELETE CASCADE,
  voter_user_id UUID        NOT NULL REFERENCES public.daywordplay_profiles(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(voter_user_id, sentence_id)
);
ALTER TABLE public.daywordplay_votes ENABLE ROW LEVEL SECURITY;

-- 9. Recreate bookmarks
CREATE TABLE public.daywordplay_bookmarks (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES public.daywordplay_profiles(id) ON DELETE CASCADE,
  word_id    UUID        NOT NULL REFERENCES public.daywordplay_words(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, word_id)
);
ALTER TABLE public.daywordplay_bookmarks ENABLE ROW LEVEL SECURITY;

-- 10. Recreate proposed_words
CREATE TABLE public.daywordplay_proposed_words (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  word           TEXT        NOT NULL,
  part_of_speech TEXT        NOT NULL,
  definition     TEXT        NOT NULL,
  etymology      TEXT,
  proposed_by    UUID        REFERENCES public.daywordplay_profiles(id) ON DELETE SET NULL,
  status         TEXT        NOT NULL DEFAULT 'pending',
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.daywordplay_proposed_words ENABLE ROW LEVEL SECURITY;

-- 11. Recreate join_requests
CREATE TABLE public.daywordplay_join_requests (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID        NOT NULL REFERENCES public.daywordplay_groups(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES public.daywordplay_profiles(id) ON DELETE CASCADE,
  status      TEXT        NOT NULL DEFAULT 'pending',
  reviewed_by UUID        REFERENCES public.daywordplay_profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, user_id)
);
ALTER TABLE public.daywordplay_join_requests ENABLE ROW LEVEL SECURITY;

-- 12. Re-add word index
CREATE INDEX ON public.daywordplay_words USING btree (word);
