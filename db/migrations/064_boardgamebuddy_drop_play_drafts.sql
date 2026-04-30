-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — drop the in-progress play session table.
--
-- Sessions are now purely in-memory in the FE: reloading the page loses any
-- unsaved play. Only the explicit Save action writes to boardgamebuddy_plays.
-- The associated /plays/draft endpoints have been removed.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.boardgamebuddy_play_drafts;
