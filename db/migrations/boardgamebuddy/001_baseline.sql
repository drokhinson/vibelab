-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — consolidated baseline
-- Replaces legacy db/migrations/{032..048,062,064}_boardgamebuddy_*.sql
-- (data-only migrations 033 + 035 + 036 are folded into 002_seed.sql).
-- FRESH-DB ONLY. Production is already at this state. Do not run on existing DB.
--
-- Excluded from baseline because they were added and later dropped:
--   * boardgamebuddy_play_drafts        — added in 042, dropped in 064.
--   * boardgamebuddy_games.bgg_rank     — added in 032, dropped in 044.
--   * boardgamebuddy_games.bgg_rating   — added in 032, dropped in 044.
--   * boardgamebuddy_guide_chunks.expansion_name — added in 041, dropped in 047.
--   * The 'rulebook' chunk_types row + all rulebook chunks — promoted to a
--     boardgamebuddy_games.rulebook_url column in 048.
--
-- Note: status='played' on boardgamebuddy_collections is no longer written by
-- the app (migration 038 deleted existing rows). The CHECK still allows it
-- for backward compat; the Played shelf is now derived from
-- boardgamebuddy_plays.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Project role ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'boardgamebuddy_role') THEN
    CREATE ROLE boardgamebuddy_role LOGIN PASSWORD 'change-me-via-shared-003' NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO boardgamebuddy_role;


-- ── Games catalog ────────────────────────────────────────────────────────────
-- Folds in the expansion linkage columns (migration 046) and the per-game
-- rulebook_url metadata (migration 048). bgg_rank + bgg_rating from the
-- original 032 schema were dropped in 044 and are NOT carried forward.
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
CREATE INDEX IF NOT EXISTS idx_bgb_games_bgg_id ON public.boardgamebuddy_games(bgg_id);
CREATE INDEX IF NOT EXISTS idx_bgb_games_name ON public.boardgamebuddy_games USING gin(to_tsvector('english', name));
-- Expansions (migration 046): fast lookup of a base game's expansions by bgg_id.
CREATE INDEX IF NOT EXISTS idx_bgb_games_base_bgg
  ON public.boardgamebuddy_games(base_game_bgg_id)
  WHERE is_expansion = true;
ALTER TABLE public.boardgamebuddy_games ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_games TO boardgamebuddy_role;


-- ── Profiles (linked to Supabase Auth) ───────────────────────────────────────
-- Folds in is_admin (migration 039) and bgg_username (migration 062).
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  -- Linked BoardGameGeek username for collection/plays sync (migration 062).
  -- Unique only when non-null so multiple unlinked profiles can coexist.
  bgg_username TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
-- BGG link (migration 062): unique linked username (when set).
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_profiles_bgg_username
  ON public.boardgamebuddy_profiles (bgg_username)
  WHERE bgg_username IS NOT NULL;
ALTER TABLE public.boardgamebuddy_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_profiles TO boardgamebuddy_role;


-- ── Pending guide submissions (migration 039) ────────────────────────────────
-- Review queue for guide bundles uploaded by non-admin users.
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
CREATE INDEX IF NOT EXISTS idx_bgb_pending_guides_status
  ON public.boardgamebuddy_pending_guides(status);
CREATE INDEX IF NOT EXISTS idx_bgb_pending_guides_uploader
  ON public.boardgamebuddy_pending_guides(uploader_id);
ALTER TABLE public.boardgamebuddy_pending_guides ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_pending_guides TO boardgamebuddy_role;


-- ── Collections ──────────────────────────────────────────────────────────────
-- status CHECK retains 'played' for backward compat; migration 038 deleted
-- existing 'played' rows and the app no longer writes the status. The Played
-- shelf is derived server-side from boardgamebuddy_plays.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('owned', 'played', 'wishlist')),
  added_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, game_id)
);
CREATE INDEX IF NOT EXISTS idx_bgb_collections_user ON public.boardgamebuddy_collections(user_id);
CREATE INDEX IF NOT EXISTS idx_bgb_collections_game ON public.boardgamebuddy_collections(game_id);
ALTER TABLE public.boardgamebuddy_collections ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_collections TO boardgamebuddy_role;


-- ── Buddies (people you play with) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_buddies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  linked_user_id UUID REFERENCES public.boardgamebuddy_profiles(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(owner_id, name)
);
-- Buddies linking (migration 043): one linked-row per (owner, target) and a
-- fast lookup for "plays where I'm a linked buddy".
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_buddies_owner_linked
  ON public.boardgamebuddy_buddies (owner_id, linked_user_id)
  WHERE linked_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bgb_buddies_linked_user
  ON public.boardgamebuddy_buddies (linked_user_id)
  WHERE linked_user_id IS NOT NULL;
ALTER TABLE public.boardgamebuddy_buddies ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_buddies TO boardgamebuddy_role;


-- ── Plays ────────────────────────────────────────────────────────────────────
-- Folds in bgg_play_id (migration 062) for BGG resync idempotency.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_plays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  played_at DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  -- BGG play_id when this row was imported from BoardGameGeek (migration 062).
  -- Unique per (user_id, bgg_play_id) so resync is idempotent.
  bgg_play_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_user ON public.boardgamebuddy_plays(user_id);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_game ON public.boardgamebuddy_plays(game_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_plays_user_bgg_play
  ON public.boardgamebuddy_plays (user_id, bgg_play_id)
  WHERE bgg_play_id IS NOT NULL;
ALTER TABLE public.boardgamebuddy_plays ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_plays TO boardgamebuddy_role;


-- ── Play players ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  play_id UUID NOT NULL REFERENCES public.boardgamebuddy_plays(id) ON DELETE CASCADE,
  buddy_id UUID NOT NULL REFERENCES public.boardgamebuddy_buddies(id),
  is_winner BOOLEAN DEFAULT false
);
ALTER TABLE public.boardgamebuddy_play_players ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_play_players TO boardgamebuddy_role;


-- ── Legacy flat guides (kept during chunk-system rollout) ────────────────────
-- The chunk system (migration 034) is the live path; this table is retained
-- for historical reads and will be dropped in a follow-up migration.
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
CREATE INDEX IF NOT EXISTS idx_bgb_guides_game ON public.boardgamebuddy_guides(game_id);
ALTER TABLE public.boardgamebuddy_guides ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_guides TO boardgamebuddy_role;


-- ── Chunk types lookup (migration 034) ───────────────────────────────────────
-- The 'rulebook' type was added in 034 and removed in 048 (rulebook URL is now
-- a column on boardgamebuddy_games). Default display_order values reflect the
-- 040 reordering: setup → player_turn → scoring → card_reference → tips → variant.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_chunk_types (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  icon TEXT,
  display_order INT DEFAULT 0
);
ALTER TABLE public.boardgamebuddy_chunk_types ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_chunk_types TO boardgamebuddy_role;

INSERT INTO public.boardgamebuddy_chunk_types (id, label, icon, display_order) VALUES
  ('setup',          'Setup',          'settings',  10),
  ('player_turn',    'Player Turn',    'gamepad-2', 20),
  ('scoring',        'Scoring',        'trophy',    30),
  ('card_reference', 'Card Reference', 'layers',    40),
  ('tips',           'Tips & Tricks',  'lightbulb', 50),
  ('variant',        'Variants',       'shuffle',   60)
ON CONFLICT (id) DO NOTHING;


-- ── Guide chunks (migration 034) ─────────────────────────────────────────────
-- Folds in is_default (migration 045). expansion_name (added in 041, dropped
-- in 047) is intentionally NOT carried forward.
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
CREATE INDEX IF NOT EXISTS idx_bgb_chunks_game
  ON public.boardgamebuddy_guide_chunks(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_chunks_game_default
  ON public.boardgamebuddy_guide_chunks (game_id, is_default);
ALTER TABLE public.boardgamebuddy_guide_chunks ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_guide_chunks TO boardgamebuddy_role;


-- ── User expansion toggles (migration 046) ───────────────────────────────────
-- Row presence = enabled; absence = disabled (default). When an expansion is
-- enabled, its default chunks are merged into the base game's reference guide
-- for that user.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_user_expansions (
  user_id            UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  expansion_game_id  UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  enabled_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, expansion_game_id)
);
CREATE INDEX IF NOT EXISTS idx_bgb_user_expansions_user
  ON public.boardgamebuddy_user_expansions(user_id);
ALTER TABLE public.boardgamebuddy_user_expansions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_user_expansions TO boardgamebuddy_role;


-- ── BGG-import staging (migration 062) ───────────────────────────────────────
-- When a user runs "Sync from BGG" and we encounter a bgg_id we don't yet have
-- in boardgamebuddy_games, we drop the intended collection-status / play-record
-- here and a background worker drains the queue after fetching each missing
-- game from the BGG XML API.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_bgg_pending_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  bgg_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('collection', 'play')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'error')),
  error_message TEXT,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bgb_bgg_pending_user_status
  ON public.boardgamebuddy_bgg_pending_imports (user_id, status)
  WHERE status = 'pending';
-- One pending row per (user, bgg_id, kind) so re-running sync upserts cleanly
-- instead of stacking duplicate work.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_bgg_pending_unique
  ON public.boardgamebuddy_bgg_pending_imports (user_id, bgg_id, kind)
  WHERE status = 'pending';
ALTER TABLE public.boardgamebuddy_bgg_pending_imports ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_bgg_pending_imports TO boardgamebuddy_role;


-- ── Per-user guide selections (migration 034 + 040) ──────────────────────────
-- Folds in is_hidden (migration 040): chunks with no selection row render at
-- the default type order; rows with is_hidden=true are filtered out and
-- listed in the "Hidden chunks" panel.
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
CREATE INDEX IF NOT EXISTS idx_bgb_selections_user_game
  ON public.boardgamebuddy_guide_selections(user_id, game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_selections_user_game_hidden
  ON public.boardgamebuddy_guide_selections(user_id, game_id, is_hidden);
ALTER TABLE public.boardgamebuddy_guide_selections ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_guide_selections TO boardgamebuddy_role;


-- ── Storage bucket (migration 037) ───────────────────────────────────────────
-- Public Supabase Storage bucket for re-hosting BoardGameGeek images. Images
-- are downloaded at import time and stored here permanently, eliminating
-- runtime dependency on the BGG CDN.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'boardgamebuddy-games',
    'boardgamebuddy-games',
    true,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;
