-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — chunked guides
-- Replaces the flat boardgamebuddy_guides table with a library of reusable
-- chunks plus per-user selections that assemble into a personal guide.
-- ─────────────────────────────────────────────────────────────────────────────

-- Lookup of chunk types (extend by inserting new rows, no redeploy needed).
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_chunk_types (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  icon TEXT,
  display_order INT DEFAULT 0
);
ALTER TABLE public.boardgamebuddy_chunk_types ENABLE ROW LEVEL SECURITY;

INSERT INTO public.boardgamebuddy_chunk_types (id, label, icon, display_order) VALUES
  ('setup',          'Setup',          'settings',  10),
  ('player_turn',    'Player Turn',    'gamepad-2', 20),
  ('card_reference', 'Card Reference', 'layers',    30),
  ('scoring',        'Scoring',        'trophy',    40),
  ('tips',           'Tips & Tricks',  'lightbulb', 50),
  ('variant',        'Variants',       'shuffle',   60),
  ('rulebook',       'Rulebook Link',  'file-text', 70)
ON CONFLICT (id) DO NOTHING;

-- Library of chunks — any authenticated user can add one.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_guide_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  chunk_type TEXT NOT NULL REFERENCES public.boardgamebuddy_chunk_types(id),
  title TEXT NOT NULL,
  created_by UUID REFERENCES public.boardgamebuddy_profiles(id) ON DELETE SET NULL,
  layout TEXT NOT NULL DEFAULT 'text' CHECK (layout IN ('text')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_guide_chunks ENABLE ROW LEVEL SECURITY;

-- Per-user selection: which chunks make up my guide for a game, in what order.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_guide_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  chunk_id UUID NOT NULL REFERENCES public.boardgamebuddy_guide_chunks(id) ON DELETE CASCADE,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, chunk_id)
);
ALTER TABLE public.boardgamebuddy_guide_selections ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_bgb_chunks_game
  ON public.boardgamebuddy_guide_chunks(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_selections_user_game
  ON public.boardgamebuddy_guide_selections(user_id, game_id);

-- Backfill existing flat guides into chunks so seeded content survives.
INSERT INTO public.boardgamebuddy_guide_chunks (game_id, chunk_type, title, created_by, content)
SELECT game_id, 'setup',       'Quick Setup',    contributed_by, quick_setup
  FROM public.boardgamebuddy_guides WHERE quick_setup IS NOT NULL
UNION ALL
SELECT game_id, 'player_turn', 'Player Guide',   contributed_by, player_guide
  FROM public.boardgamebuddy_guides WHERE player_guide IS NOT NULL
UNION ALL
SELECT game_id, 'rulebook',    'Rulebook (PDF)', contributed_by, rulebook_url
  FROM public.boardgamebuddy_guides WHERE rulebook_url IS NOT NULL;

-- Keep boardgamebuddy_guides in place for one release; drop in a follow-up
-- migration once frontend + backend are fully cut over.
