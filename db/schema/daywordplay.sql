-- ─────────────────────────────────────────────────────────────────────────────
-- Day Word Play — current schema snapshot
-- Last updated: migration 027
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.daywordplay_users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT        UNIQUE NOT NULL,
  display_name  TEXT,
  email         TEXT,
  password_hash TEXT        NOT NULL,
  -- recovery_hash dropped in migration 026 (recovery flow never implemented)
  created_at    TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.daywordplay_users ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.daywordplay_groups (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  code       CHAR(4)     UNIQUE NOT NULL,
  created_by UUID        REFERENCES public.daywordplay_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.daywordplay_groups ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.daywordplay_group_members (
  id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id  UUID        NOT NULL REFERENCES public.daywordplay_groups(id) ON DELETE CASCADE,
  user_id   UUID        NOT NULL REFERENCES public.daywordplay_users(id)  ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, user_id)
);
ALTER TABLE public.daywordplay_group_members ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.daywordplay_words (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  word           TEXT        NOT NULL,
  part_of_speech TEXT        NOT NULL,
  definition     TEXT        NOT NULL,
  pronunciation  TEXT,
  etymology      TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.daywordplay_words ENABLE ROW LEVEL SECURITY;

-- Lazy-assigned on first request of the day for a group
CREATE TABLE IF NOT EXISTS public.daywordplay_daily_words (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      UUID        NOT NULL REFERENCES public.daywordplay_groups(id) ON DELETE CASCADE,
  word_id       UUID        NOT NULL REFERENCES public.daywordplay_words(id)  ON DELETE CASCADE,
  assigned_date DATE        NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, assigned_date)
);
ALTER TABLE public.daywordplay_daily_words ENABLE ROW LEVEL SECURITY;

-- One sentence per user per group per day
CREATE TABLE IF NOT EXISTS public.daywordplay_sentences (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      UUID        NOT NULL REFERENCES public.daywordplay_groups(id)  ON DELETE CASCADE,
  word_id       UUID        NOT NULL REFERENCES public.daywordplay_words(id)   ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES public.daywordplay_users(id)   ON DELETE CASCADE,
  sentence      TEXT        NOT NULL,
  assigned_date DATE        NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, user_id, assigned_date)
);
ALTER TABLE public.daywordplay_sentences ENABLE ROW LEVEL SECURITY;

-- One vote per voter per sentence; cannot vote for own sentence (enforced in app)
CREATE TABLE IF NOT EXISTS public.daywordplay_votes (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sentence_id   UUID        NOT NULL REFERENCES public.daywordplay_sentences(id) ON DELETE CASCADE,
  voter_user_id UUID        NOT NULL REFERENCES public.daywordplay_users(id)     ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(voter_user_id, sentence_id)
);
ALTER TABLE public.daywordplay_votes ENABLE ROW LEVEL SECURITY;

-- User's personal word dictionary (bookmarked words)
CREATE TABLE IF NOT EXISTS public.daywordplay_bookmarks (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES public.daywordplay_users(id) ON DELETE CASCADE,
  word_id    UUID        NOT NULL REFERENCES public.daywordplay_words(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, word_id)
);
ALTER TABLE public.daywordplay_bookmarks ENABLE ROW LEVEL SECURITY;

-- Community word proposals (pending admin review before entering rotation)
CREATE TABLE IF NOT EXISTS public.daywordplay_proposed_words (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  word           TEXT        NOT NULL,
  part_of_speech TEXT        NOT NULL,
  definition     TEXT        NOT NULL,
  pronunciation  TEXT,
  etymology      TEXT,
  proposed_by    UUID        REFERENCES public.daywordplay_users(id) ON DELETE SET NULL,
  status         TEXT        NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.daywordplay_proposed_words ENABLE ROW LEVEL SECURITY;
