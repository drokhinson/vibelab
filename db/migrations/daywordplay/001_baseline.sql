-- ─────────────────────────────────────────────────────────────────────────────
-- daywordplay — consolidated baseline
-- Replaces legacy db/migrations/{017,027,028,030,031}_daywordplay_*.sql.
-- FRESH-DB ONLY. Production is already at this state. Do not run on existing DB.
--
-- Run order: this file, then 002_seed.sql, then db/migrations/_shared/.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Project role ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daywordplay_role') THEN
    CREATE ROLE daywordplay_role LOGIN PASSWORD 'change-me-via-shared-003' NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO daywordplay_role;


-- ── Users (recovery_hash dropped by old migration 026 — never implemented) ───
CREATE TABLE IF NOT EXISTS public.daywordplay_users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT        UNIQUE NOT NULL,
  display_name  TEXT,
  email         TEXT,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.daywordplay_users ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.daywordplay_users TO daywordplay_role;


-- ── Groups (4-letter join code) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.daywordplay_groups (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  code       CHAR(4)     UNIQUE NOT NULL,
  created_by UUID        REFERENCES public.daywordplay_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_daywordplay_groups_code
  ON public.daywordplay_groups(code);
ALTER TABLE public.daywordplay_groups ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.daywordplay_groups TO daywordplay_role;

CREATE TABLE IF NOT EXISTS public.daywordplay_group_members (
  id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id  UUID        NOT NULL REFERENCES public.daywordplay_groups(id) ON DELETE CASCADE,
  user_id   UUID        NOT NULL REFERENCES public.daywordplay_users(id)  ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_daywordplay_group_members_user
  ON public.daywordplay_group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_daywordplay_group_members_group
  ON public.daywordplay_group_members(group_id);
ALTER TABLE public.daywordplay_group_members ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.daywordplay_group_members TO daywordplay_role;


-- ── Words (pronunciation column dropped by old migration 030) ────────────────
CREATE TABLE IF NOT EXISTS public.daywordplay_words (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  word           TEXT        NOT NULL,
  part_of_speech TEXT        NOT NULL,
  definition     TEXT        NOT NULL,
  etymology      TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_daywordplay_words_word
  ON public.daywordplay_words USING btree (word);
ALTER TABLE public.daywordplay_words ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.daywordplay_words TO daywordplay_role;


-- ── Daily word assignment (lazy-assigned on first request of the day) ────────
CREATE TABLE IF NOT EXISTS public.daywordplay_daily_words (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      UUID        NOT NULL REFERENCES public.daywordplay_groups(id) ON DELETE CASCADE,
  word_id       UUID        NOT NULL REFERENCES public.daywordplay_words(id)  ON DELETE CASCADE,
  assigned_date DATE        NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, assigned_date)
);
CREATE INDEX IF NOT EXISTS idx_daywordplay_daily_words_lookup
  ON public.daywordplay_daily_words(group_id, assigned_date);
ALTER TABLE public.daywordplay_daily_words ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.daywordplay_daily_words TO daywordplay_role;


-- ── Sentences (one per user per group per day) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.daywordplay_sentences (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      UUID        NOT NULL REFERENCES public.daywordplay_groups(id) ON DELETE CASCADE,
  word_id       UUID        NOT NULL REFERENCES public.daywordplay_words(id)  ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES public.daywordplay_users(id)  ON DELETE CASCADE,
  sentence      TEXT        NOT NULL,
  assigned_date DATE        NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, user_id, assigned_date)
);
CREATE INDEX IF NOT EXISTS idx_daywordplay_sentences_date
  ON public.daywordplay_sentences(group_id, assigned_date);
ALTER TABLE public.daywordplay_sentences ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.daywordplay_sentences TO daywordplay_role;


-- ── Votes (one per voter per sentence; "no self-vote" enforced in app) ───────
CREATE TABLE IF NOT EXISTS public.daywordplay_votes (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sentence_id   UUID        NOT NULL REFERENCES public.daywordplay_sentences(id) ON DELETE CASCADE,
  voter_user_id UUID        NOT NULL REFERENCES public.daywordplay_users(id)     ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(voter_user_id, sentence_id)
);
CREATE INDEX IF NOT EXISTS idx_daywordplay_votes_sentence
  ON public.daywordplay_votes(sentence_id);
ALTER TABLE public.daywordplay_votes ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.daywordplay_votes TO daywordplay_role;


-- ── Bookmarks (user's personal word dictionary) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.daywordplay_bookmarks (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES public.daywordplay_users(id) ON DELETE CASCADE,
  word_id    UUID        NOT NULL REFERENCES public.daywordplay_words(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, word_id)
);
CREATE INDEX IF NOT EXISTS idx_daywordplay_bookmarks_user
  ON public.daywordplay_bookmarks(user_id);
ALTER TABLE public.daywordplay_bookmarks ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.daywordplay_bookmarks TO daywordplay_role;


-- ── Proposed words (community submissions awaiting admin review) ─────────────
CREATE TABLE IF NOT EXISTS public.daywordplay_proposed_words (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  word           TEXT        NOT NULL,
  part_of_speech TEXT        NOT NULL,
  definition     TEXT        NOT NULL,
  etymology      TEXT,
  proposed_by    UUID        REFERENCES public.daywordplay_users(id) ON DELETE SET NULL,
  status         TEXT        NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS daywordplay_proposed_words_status_idx
  ON public.daywordplay_proposed_words(status);
ALTER TABLE public.daywordplay_proposed_words ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.daywordplay_proposed_words TO daywordplay_role;


-- ── Join requests (users requesting to join a group without the code) ────────
CREATE TABLE IF NOT EXISTS public.daywordplay_join_requests (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID        NOT NULL REFERENCES public.daywordplay_groups(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES public.daywordplay_users(id)  ON DELETE CASCADE,
  status      TEXT        NOT NULL DEFAULT 'pending',  -- pending | approved | denied
  reviewed_by UUID        REFERENCES public.daywordplay_users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_daywordplay_join_requests_group
  ON public.daywordplay_join_requests(group_id);
CREATE INDEX IF NOT EXISTS idx_daywordplay_join_requests_user
  ON public.daywordplay_join_requests(user_id);
ALTER TABLE public.daywordplay_join_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.daywordplay_join_requests TO daywordplay_role;
