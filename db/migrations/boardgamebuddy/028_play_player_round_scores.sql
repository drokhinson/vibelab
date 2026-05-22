-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Persist per-round score breakdown on play_players
--
-- The play-logging screen has long captured per-round scores in a grid
-- (rounds × players), but PlaySession.toPlayCreate() summed the rounds
-- into a single per-player total and threw the breakdown away. The
-- play-detail popup now wants to render the same grid (view + edit),
-- so we keep the array alongside the final score.
--
-- One JSONB column on boardgamebuddy_play_players, per player, holding
-- the array `[5, 8, null, 12]` (one slot per round). NULL when no
-- rounds were tracked. The existing `score` column still carries the
-- final total — kept in step on save so aggregates / sorts don't need
-- to crack the JSON open.
--
-- Gating rule (frontend): rounds are persisted only when there were
-- more than one of them. Single-round / no-round plays leave the
-- column NULL.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_play_players
  ADD COLUMN IF NOT EXISTS round_scores JSONB;

COMMENT ON COLUMN public.boardgamebuddy_play_players.round_scores IS
  'Per-round score breakdown as a JSON array of nullable ints, e.g. [5, 8, null, 12]. NULL when no rounds were tracked (<= 1 round). The `score` column still holds the final total for backward compatibility and quick aggregation.';
