-- ─────────────────────────────────────────────────────────────────────────────
-- 028 — Join requests for daywordplay groups
-- Users can request to join a group without the code; a group member approves.
-- ─────────────────────────────────────────────────────────────────────────────

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
ALTER TABLE public.daywordplay_join_requests ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_daywordplay_join_requests_group
  ON public.daywordplay_join_requests(group_id);
CREATE INDEX IF NOT EXISTS idx_daywordplay_join_requests_user
  ON public.daywordplay_join_requests(user_id);
