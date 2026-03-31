-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — schema
-- Migration 032
-- ─────────────────────────────────────────────────────────────────────────────

-- Games catalog (seeded from BoardGameGeek, expandable via live search)
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

-- User profiles (linked to Supabase Auth)
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_profiles ENABLE ROW LEVEL SECURITY;

-- User collections: owned / played / wishlist
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('owned', 'played', 'wishlist')),
  added_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, game_id)
);
ALTER TABLE public.boardgamebuddy_collections ENABLE ROW LEVEL SECURITY;

-- Game buddies (people you play with)
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_buddies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  linked_user_id UUID REFERENCES public.boardgamebuddy_profiles(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(owner_id, name)
);
ALTER TABLE public.boardgamebuddy_buddies ENABLE ROW LEVEL SECURITY;

-- Play log
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_plays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  played_at DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_plays ENABLE ROW LEVEL SECURITY;

-- Players in a play session
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  play_id UUID NOT NULL REFERENCES public.boardgamebuddy_plays(id) ON DELETE CASCADE,
  buddy_id UUID NOT NULL REFERENCES public.boardgamebuddy_buddies(id),
  is_winner BOOLEAN DEFAULT false
);
ALTER TABLE public.boardgamebuddy_play_players ENABLE ROW LEVEL SECURITY;

-- Quick reference guides
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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_bgb_games_bgg_id ON public.boardgamebuddy_games(bgg_id);
CREATE INDEX IF NOT EXISTS idx_bgb_games_name ON public.boardgamebuddy_games USING gin(to_tsvector('english', name));
CREATE INDEX IF NOT EXISTS idx_bgb_games_rank ON public.boardgamebuddy_games(bgg_rank);
CREATE INDEX IF NOT EXISTS idx_bgb_collections_user ON public.boardgamebuddy_collections(user_id);
CREATE INDEX IF NOT EXISTS idx_bgb_collections_game ON public.boardgamebuddy_collections(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_user ON public.boardgamebuddy_plays(user_id);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_game ON public.boardgamebuddy_plays(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_guides_game ON public.boardgamebuddy_guides(game_id);
