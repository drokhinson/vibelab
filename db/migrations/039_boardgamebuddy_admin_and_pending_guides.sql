-- Migration 039 — BoardgameBuddy: admin flag on profiles + pending guide submissions
--
-- Adds an is_admin flag to profiles (granted by exchanging ADMIN_API_KEY at runtime),
-- and a review queue for guide bundles uploaded by non-admin users.

ALTER TABLE public.boardgamebuddy_profiles
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_pending_guides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_name TEXT NOT NULL,
  bgg_id INTEGER,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  bundle JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_notes TEXT,
  reviewed_by UUID REFERENCES public.boardgamebuddy_profiles(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.boardgamebuddy_pending_guides ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_bgb_pending_guides_status
  ON public.boardgamebuddy_pending_guides(status);
CREATE INDEX IF NOT EXISTS idx_bgb_pending_guides_uploader
  ON public.boardgamebuddy_pending_guides(uploader_id);
