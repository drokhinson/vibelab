-- Drop pronunciation column from words and proposed_words tables
-- Pronunciation was never widely used and has been removed from all UI/API surfaces.

ALTER TABLE public.daywordplay_words
  DROP COLUMN IF EXISTS pronunciation;

ALTER TABLE public.daywordplay_proposed_words
  DROP COLUMN IF EXISTS pronunciation;
