-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — current schema snapshot
-- Last updated: migration 038
-- FOR REFERENCE ONLY — apply changes via db/migrations/
--
-- Note: status='played' on boardgamebuddy_collections is no longer written by
-- the app (migration 038). The CHECK still allows it for backward compat, but
-- the Played shelf in the closet is derived server-side from
-- boardgamebuddy_plays.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bgg_id INTEGER UNIQUE,
  name TEXT NOT NULL,
  year_published INTEGER,
  min_players INTEGER,
  max_players INTEGER,
  playing_time INTEGER,
  description TEXT,
  image_url TEXT,
  thumbnail_url TEXT,
  bgg_rank INTEGER,
  bgg_rating NUMERIC(4,2),
  categories TEXT[] DEFAULT '{}',
  mechanics TEXT[] DEFAULT '{}',
  theme_color TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_games ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('owned', 'played', 'wishlist')),
  added_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, game_id)
);
ALTER TABLE public.boardgamebuddy_collections ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_buddies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  linked_user_id UUID REFERENCES public.boardgamebuddy_profiles(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(owner_id, name)
);
ALTER TABLE public.boardgamebuddy_buddies ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_plays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  played_at DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_plays ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  play_id UUID NOT NULL REFERENCES public.boardgamebuddy_plays(id) ON DELETE CASCADE,
  buddy_id UUID NOT NULL REFERENCES public.boardgamebuddy_buddies(id),
  is_winner BOOLEAN DEFAULT false
);
ALTER TABLE public.boardgamebuddy_play_players ENABLE ROW LEVEL SECURITY;

-- Legacy single-row guide table. Retained during rollout of the chunk system
-- (migration 034); will be dropped in a follow-up migration.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_guides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  quick_setup TEXT,
  player_guide TEXT,
  rulebook_url TEXT,
  contributed_by UUID REFERENCES public.boardgamebuddy_profiles(id),
  is_official BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_guides ENABLE ROW LEVEL SECURITY;

-- Chunked guide system (migration 034)
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_chunk_types (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  icon TEXT,
  display_order INT DEFAULT 0
);
ALTER TABLE public.boardgamebuddy_chunk_types ENABLE ROW LEVEL SECURITY;

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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_bgb_games_bgg_id ON public.boardgamebuddy_games(bgg_id);
CREATE INDEX IF NOT EXISTS idx_bgb_games_name ON public.boardgamebuddy_games USING gin(to_tsvector('english', name));
CREATE INDEX IF NOT EXISTS idx_bgb_games_rank ON public.boardgamebuddy_games(bgg_rank);
CREATE INDEX IF NOT EXISTS idx_bgb_collections_user ON public.boardgamebuddy_collections(user_id);
CREATE INDEX IF NOT EXISTS idx_bgb_collections_game ON public.boardgamebuddy_collections(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_user ON public.boardgamebuddy_plays(user_id);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_game ON public.boardgamebuddy_plays(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_guides_game ON public.boardgamebuddy_guides(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_chunks_game ON public.boardgamebuddy_guide_chunks(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_selections_user_game
  ON public.boardgamebuddy_guide_selections(user_id, game_id);
