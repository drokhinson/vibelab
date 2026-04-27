-- BoardgameBuddy — explicit `approved` flag on guide chunks + link to pending row.
--
-- Until now, non-admin guide submissions were stored only as JSONB on
-- boardgamebuddy_pending_guides.bundle and the chunks were materialized only
-- after admin approval. That meant the uploader couldn't see their own
-- contribution until review. This migration:
--
--  1. Adds an `approved` boolean (default true so existing chunks stay live).
--  2. Adds a `pending_guide_id` FK so we can find/flip/delete a submission's
--     chunks as a unit.
--
-- Backend now inserts chunks at submit-time with approved=false; the chunk
-- listing endpoints filter so only the uploader sees their own unapproved
-- rows. On approve, the rows flip to approved=true (and optionally
-- is_default=true for chunks the admin promotes). On reject, the rows are
-- deleted (the pending audit row stays).

ALTER TABLE public.boardgamebuddy_guide_chunks
  ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS pending_guide_id UUID
    REFERENCES public.boardgamebuddy_pending_guides(id) ON DELETE SET NULL;

-- Belt-and-suspenders backfill (the DEFAULT covers new rows, this covers any
-- pre-existing NULLs from a partial deploy).
UPDATE public.boardgamebuddy_guide_chunks
  SET approved = true
  WHERE approved IS NULL;

CREATE INDEX IF NOT EXISTS idx_bgb_chunks_pending_guide
  ON public.boardgamebuddy_guide_chunks(pending_guide_id);

-- Hot path: "show me my own pending chunks for this game".
CREATE INDEX IF NOT EXISTS idx_bgb_chunks_unapproved_creator
  ON public.boardgamebuddy_guide_chunks(created_by, game_id)
  WHERE approved = false;
