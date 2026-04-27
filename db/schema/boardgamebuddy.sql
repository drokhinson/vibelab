-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — current schema snapshot
-- Last updated: migration 048
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
  categories TEXT[] DEFAULT '{}',
  mechanics TEXT[] DEFAULT '{}',
  theme_color TEXT,
  -- Expansion linkage (migration 046). is_expansion flags the row; when true,
  -- base_game_bgg_id stores the parent's BGG id (kept as a soft reference, not
  -- a FK, so expansions can be imported before their base game). expansion_color
  -- is auto-assigned at import time and used for the toggle/dot UI.
  is_expansion BOOLEAN NOT NULL DEFAULT false,
  base_game_bgg_id INTEGER,
  expansion_color TEXT,
  -- Official rulebook URL (migration 048). Promoted from a `chunk_type='rulebook'`
  -- row to a per-game column so it can be fetched alongside the game and isn't
  -- subject to the chunk system's hide/reorder/customize flow.
  rulebook_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_games ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_profiles ENABLE ROW LEVEL SECURITY;

-- Review queue for guide bundles uploaded by non-admin users (migration 039).
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_pending_guides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_name TEXT NOT NULL,
  bgg_id INTEGER,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  bundle JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_notes TEXT,
  reviewed_by UUID REFERENCES public.boardgamebuddy_profiles(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_pending_guides ENABLE ROW LEVEL SECURITY;

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

-- In-progress play session (migration 042). One row per user (PK = user_id).
-- Per-round scores live here as JSONB while the user is mid-game; on save
-- the draft is deleted and only the winner is persisted to play_players.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_drafts (
  user_id     UUID PRIMARY KEY REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id     UUID REFERENCES public.boardgamebuddy_games(id) ON DELETE SET NULL,
  played_at   DATE,
  notes       TEXT,
  players     JSONB NOT NULL DEFAULT '[]'::jsonb,
  round_count INT   NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_play_drafts ENABLE ROW LEVEL SECURITY;

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
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_guide_chunks ENABLE ROW LEVEL SECURITY;

-- Per-user expansion toggle (migration 046). Row presence = enabled; absence
-- = disabled (default). When an expansion is enabled, its default chunks are
-- merged into the base game's reference guide for that user.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_user_expansions (
  user_id            UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  expansion_game_id  UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  enabled_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, expansion_game_id)
);
ALTER TABLE public.boardgamebuddy_user_expansions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_guide_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  chunk_id UUID NOT NULL REFERENCES public.boardgamebuddy_guide_chunks(id) ON DELETE CASCADE,
  display_order INT NOT NULL DEFAULT 0,
  is_hidden BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, chunk_id)
);
ALTER TABLE public.boardgamebuddy_guide_selections ENABLE ROW LEVEL SECURITY;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_bgb_games_bgg_id ON public.boardgamebuddy_games(bgg_id);
CREATE INDEX IF NOT EXISTS idx_bgb_games_name ON public.boardgamebuddy_games USING gin(to_tsvector('english', name));
CREATE INDEX IF NOT EXISTS idx_bgb_collections_user ON public.boardgamebuddy_collections(user_id);
CREATE INDEX IF NOT EXISTS idx_bgb_collections_game ON public.boardgamebuddy_collections(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_user ON public.boardgamebuddy_plays(user_id);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_game ON public.boardgamebuddy_plays(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_guides_game ON public.boardgamebuddy_guides(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_chunks_game ON public.boardgamebuddy_guide_chunks(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_chunks_game_default
  ON public.boardgamebuddy_guide_chunks(game_id, is_default);
CREATE INDEX IF NOT EXISTS idx_bgb_selections_user_game
  ON public.boardgamebuddy_guide_selections(user_id, game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_selections_user_game_hidden
  ON public.boardgamebuddy_guide_selections(user_id, game_id, is_hidden);
CREATE INDEX IF NOT EXISTS idx_bgb_pending_guides_status
  ON public.boardgamebuddy_pending_guides(status);
CREATE INDEX IF NOT EXISTS idx_bgb_pending_guides_uploader
  ON public.boardgamebuddy_pending_guides(uploader_id);
-- Expansions (migration 046): fast lookup of a base game's expansions by bgg_id.
CREATE INDEX IF NOT EXISTS idx_bgb_games_base_bgg
  ON public.boardgamebuddy_games(base_game_bgg_id)
  WHERE is_expansion = true;
CREATE INDEX IF NOT EXISTS idx_bgb_user_expansions_user
  ON public.boardgamebuddy_user_expansions(user_id);
-- Buddies linking (migration 043): one linked-row per (owner, target) and a
-- fast lookup for "plays where I'm a linked buddy".
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_buddies_owner_linked
  ON public.boardgamebuddy_buddies (owner_id, linked_user_id)
  WHERE linked_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bgb_buddies_linked_user
  ON public.boardgamebuddy_buddies (linked_user_id)
  WHERE linked_user_id IS NOT NULL;
