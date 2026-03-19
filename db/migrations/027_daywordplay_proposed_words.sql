-- ─────────────────────────────────────────────────────────────────────────────
-- Day Word Play — proposed words table (community submissions pending admin review)
-- Migration 027
-- ─────────────────────────────────────────────────────────────────────────────

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

CREATE INDEX IF NOT EXISTS daywordplay_proposed_words_status_idx
  ON public.daywordplay_proposed_words (status);
