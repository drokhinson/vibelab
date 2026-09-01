-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — rebuild reference guide as user-owned "chapters"
--
-- Rename chunks → chapters across all tables/columns, drop the admin
-- curation pipeline (is_default flag, pending-guides review queue), flip
-- the selections-table semantics so presence = "in my guide" (no
-- per-user hide), and add a reports table for community moderation.
--
-- Legacy admin-seeded content (created_by IS NULL) is hard-deleted —
-- the new model has no curated default set; chapters that survive are
-- the ones actually authored by real users. Browse pool is whatever's
-- left after that wipe.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Wipe legacy admin-curated content. Real user contributions
--    (created_by IS NOT NULL) are preserved in the new pool.
DELETE FROM public.boardgamebuddy_guide_chunks WHERE created_by IS NULL;

-- 2. Drop the admin review queue.
DROP TABLE IF EXISTS public.boardgamebuddy_pending_guides CASCADE;

-- 3. Table renames.
ALTER TABLE public.boardgamebuddy_chunk_types      RENAME TO boardgamebuddy_chapter_types;
ALTER TABLE public.boardgamebuddy_guide_chunks     RENAME TO boardgamebuddy_guide_chapters;
ALTER TABLE public.boardgamebuddy_guide_selections RENAME TO boardgamebuddy_user_chapters;

-- 4. Column renames.
ALTER TABLE public.boardgamebuddy_guide_chapters RENAME COLUMN chunk_type TO chapter_type;
ALTER TABLE public.boardgamebuddy_user_chapters  RENAME COLUMN chunk_id   TO chapter_id;

-- 5. Drop now-meaningless curation + hide flags.
--    is_default: no curated default set anymore (all chapters are pool-equivalent).
--    is_hidden:  row presence in user_chapters means "in my guide"; absence means "not".
ALTER TABLE public.boardgamebuddy_guide_chapters DROP COLUMN is_default;
DROP INDEX  IF EXISTS public.idx_bgb_selections_user_game_hidden;
DROP INDEX  IF EXISTS public.idx_bgb_chunks_game_default;
ALTER TABLE public.boardgamebuddy_user_chapters  DROP COLUMN is_hidden;

-- 6. Index hygiene.
ALTER INDEX IF EXISTS idx_bgb_chunks_game          RENAME TO idx_bgb_chapters_game;
ALTER INDEX IF EXISTS idx_bgb_selections_user_game RENAME TO idx_bgb_user_chapters_user_game;
CREATE INDEX IF NOT EXISTS idx_bgb_chapters_game_type
  ON public.boardgamebuddy_guide_chapters (game_id, chapter_type);
CREATE INDEX IF NOT EXISTS idx_bgb_user_chapters_chapter
  ON public.boardgamebuddy_user_chapters (chapter_id);

-- 7. NEW: chapter reports table. One report per (chapter, reporter).
--    Admin acts by either resolving (status='resolved') or deleting the
--    chapter outright (cascade removes the report).
CREATE TABLE public.boardgamebuddy_chapter_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id  UUID NOT NULL REFERENCES public.boardgamebuddy_guide_chapters(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'resolved')),
  resolved_by UUID REFERENCES public.boardgamebuddy_profiles(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chapter_id, reporter_id)
);
ALTER TABLE public.boardgamebuddy_chapter_reports ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_bgb_chapter_reports_status
  ON public.boardgamebuddy_chapter_reports (status, created_at);

-- 8. Re-grant on renamed + new tables. The per-app read-only role keeps
--    its access through the rename (Postgres preserves grants on RENAME
--    but be explicit so future audits see the intent).
GRANT SELECT ON public.boardgamebuddy_chapter_types    TO boardgamebuddy_role;
GRANT SELECT ON public.boardgamebuddy_guide_chapters   TO boardgamebuddy_role;
GRANT SELECT ON public.boardgamebuddy_user_chapters    TO boardgamebuddy_role;
GRANT SELECT ON public.boardgamebuddy_chapter_reports  TO boardgamebuddy_role;

COMMIT;
