-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — in-progress (unsaved) play sessions
--
-- One row per user (PK = user_id) so the FE never has to track a draft id —
-- there's at most one active session at a time. Per-round scores are kept
-- here as JSONB while the user is mid-game; on save the draft row is
-- deleted and only the winner is persisted to boardgamebuddy_play_players.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_drafts (
  user_id     UUID PRIMARY KEY REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id     UUID REFERENCES public.boardgamebuddy_games(id) ON DELETE SET NULL,
  played_at   DATE,
  notes       TEXT,
  -- players: [{name, is_winner_override (nullable bool), round_scores:[num,...]}]
  players     JSONB NOT NULL DEFAULT '[]'::jsonb,
  round_count INT   NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.boardgamebuddy_play_drafts ENABLE ROW LEVEL SECURITY;
