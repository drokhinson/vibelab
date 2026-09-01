-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Mutual buddy graph
-- Introduces a single canonical edge per (user_a, user_b) pair, replacing the
-- legacy one-way "owner_id links linked_user_id" model.
--
-- The legacy boardgamebuddy_buddies table stays around — it still holds
-- free-text ghost players (non-account participants in a play). The
-- linked_user_id column gets dropped in migration 013 once play_players has
-- migrated off buddy_id.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_buddy_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  user_b UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'blocked')),
  requested_by UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  CONSTRAINT bgb_buddy_edges_canonical CHECK (user_a < user_b)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_buddy_edges_pair
  ON public.boardgamebuddy_buddy_edges (user_a, user_b);
CREATE INDEX IF NOT EXISTS idx_bgb_buddy_edges_user_a
  ON public.boardgamebuddy_buddy_edges (user_a, status);
CREATE INDEX IF NOT EXISTS idx_bgb_buddy_edges_user_b
  ON public.boardgamebuddy_buddy_edges (user_b, status);
ALTER TABLE public.boardgamebuddy_buddy_edges ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_buddy_edges TO boardgamebuddy_role;

-- Backfill from legacy boardgamebuddy_buddies. Pre-existing links were one-way,
-- and product intent in the legacy model was "owner endorses linked_user". We
-- promote any such link to an accepted mutual edge; if the reverse link also
-- exists it deduplicates via the unique pair index.
INSERT INTO public.boardgamebuddy_buddy_edges (user_a, user_b, status, requested_by, created_at, accepted_at)
SELECT
  LEAST(b.owner_id, b.linked_user_id)    AS user_a,
  GREATEST(b.owner_id, b.linked_user_id) AS user_b,
  'accepted'                              AS status,
  b.owner_id                              AS requested_by,
  COALESCE(b.created_at, now())           AS created_at,
  COALESCE(b.created_at, now())           AS accepted_at
FROM public.boardgamebuddy_buddies b
WHERE b.linked_user_id IS NOT NULL
  AND b.owner_id <> b.linked_user_id
ON CONFLICT (user_a, user_b) DO NOTHING;
