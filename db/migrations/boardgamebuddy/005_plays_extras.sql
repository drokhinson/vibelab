-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy 005 — Plays extras: per-player score, photo, expansions used
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds optional richer per-play data: a numeric score per player, a single
-- photo URL on the play, and a junction table linking each play to the
-- expansion games that were used. All new fields are optional so existing
-- rows remain valid and existing API consumers keep working.

-- Per-player numeric score. Nullable so plays logged before this migration
-- (and plays where the user only cares about the winner flag) keep working.
ALTER TABLE public.boardgamebuddy_play_players
  ADD COLUMN IF NOT EXISTS score INTEGER;

-- Single optional photo URL per play, pointing into the new
-- boardgamebuddy-plays storage bucket below.
ALTER TABLE public.boardgamebuddy_plays
  ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- Many-to-many: which expansion games were used during this play. Both sides
-- ON DELETE CASCADE so deleting either the play or the expansion-game cleans
-- up the join row. Primary key is the pair so the same expansion can't be
-- listed twice on the same play.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_expansions (
  play_id           UUID NOT NULL REFERENCES public.boardgamebuddy_plays(id) ON DELETE CASCADE,
  expansion_game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  PRIMARY KEY (play_id, expansion_game_id)
);
CREATE INDEX IF NOT EXISTS idx_bgb_play_expansions_play
  ON public.boardgamebuddy_play_expansions(play_id);
ALTER TABLE public.boardgamebuddy_play_expansions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_play_expansions TO boardgamebuddy_role;

-- Public Supabase Storage bucket for play photos. Mirrors the games bucket
-- (migration 001): public, 5 MiB cap, image MIMEs only.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'boardgamebuddy-plays',
    'boardgamebuddy-plays',
    true,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;
