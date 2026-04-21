-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — drop legacy `played` collection rows
--
-- The "played" shelf in the closet is now derived from boardgamebuddy_plays
-- rather than from a status='played' collection entry. Users can no longer
-- select "played" as a collection status; logging a play automatically
-- surfaces a game on the Played shelf via the backend.
--
-- Play history itself (boardgamebuddy_plays) is preserved.
-- ─────────────────────────────────────────────────────────────────────────────

DELETE FROM public.boardgamebuddy_collections WHERE status = 'played';
