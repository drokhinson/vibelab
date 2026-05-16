-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — current schema snapshot
-- Last updated: post-008..012 (OOP/Strava redesign). 013 cleanup applied
-- after the new frontend cuts over.
-- FOR REFERENCE ONLY — apply changes via db/migrations/
--
-- Note: the legacy boardgamebuddy_buddies table is now strictly for free-text
-- ghost-player nicknames. Mutual friendship lives in
-- boardgamebuddy_buddy_edges. play_players references real profiles directly
-- (player_user_id / player_display_name).
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
  -- Scoring style for the play-logging UI (migration 006). Derived from BGG
  -- mechanics at import time via derive_play_mode(): "Cooperative Game" →
  -- 'coop', "Team-Based Game" → 'team', otherwise 'competitive'. Drives
  -- whether the session bubble shows per-player scoring, a single all-win/
  -- all-lose toggle, or a team picker.
  play_mode TEXT NOT NULL DEFAULT 'competitive'
    CHECK (play_mode IN ('competitive', 'coop', 'team')),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_games ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  -- Stable, lowercased handle (migration 017). Backfilled from the auth
  -- email's local-part with `[a-z0-9_]{3,30}` enforcement + uniqueness.
  -- Readonly in the user-facing UI; new signups derive it on first auth.
  username TEXT NOT NULL
    CHECK (username ~ '^[a-z0-9_]{3,30}$'),
  avatar_url TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  -- Linked BoardGameGeek username for collection/plays sync (migration 062).
  -- Unique only when non-null so multiple unlinked profiles can coexist.
  bgg_username TEXT,
  -- Per-user BGG authentication (migration 003). The user logs in with their
  -- BGG password at link time; we store it Fernet-encrypted with
  -- BGG_CREDENTIAL_KEY and exchange it via POST /login/api/v1 for a SessionID
  -- cookie. Subsequent xmlapi2 calls are authenticated AS that user (instead
  -- of using the shared BGG_API_TOKEN), which is the only way to read private
  -- collection fields (showprivate=1) and to act on the user's behalf.
  -- bgg_password_enc null + bgg_username set = legacy public-only link;
  -- backend surfaces auth_state="relink_required" and the FE re-prompts.
  bgg_password_enc TEXT,
  bgg_session_id TEXT,
  bgg_session_expires_at TIMESTAMPTZ,
  bgg_session_user_cookie TEXT,
  bgg_session_pass_cookie TEXT,
  bgg_last_login_at TIMESTAMPTZ,
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
  -- migration 010 tightened this from ('owned','played','wishlist').
  status TEXT NOT NULL CHECK (status IN ('owned', 'wishlist')),
  added_at TIMESTAMPTZ DEFAULT now(),
  -- Private fields from BGG /collection?showprivate=1 (migration 003).
  -- Populated only when the BGG sync request was authenticated as the
  -- collection's owner via the user's per-account session cookies.
  bgg_private_comment TEXT,
  bgg_acquired_from TEXT,
  bgg_acquisition_date DATE,
  bgg_purchase_price NUMERIC(10, 2),
  bgg_purchase_currency TEXT,
  bgg_inventory_location TEXT,
  bgg_quantity INTEGER,
  UNIQUE(user_id, game_id)
);
ALTER TABLE public.boardgamebuddy_collections ENABLE ROW LEVEL SECURITY;

-- Free-text ghost players only. Mutual friendship now lives in
-- boardgamebuddy_buddy_edges. linked_user_id is retained during the
-- redesign rollout and dropped in migration 013.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_buddies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  linked_user_id UUID REFERENCES public.boardgamebuddy_profiles(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(owner_id, name)
);
ALTER TABLE public.boardgamebuddy_buddies ENABLE ROW LEVEL SECURITY;

-- Mutual friendship graph (migration 008). One canonical row per
-- (user_a, user_b) pair, user_a < user_b. status pending→accepted; accepted
-- edges are what Feed / Profile / Buddies all read.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_buddy_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  user_b UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'blocked')),
  requested_by UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  CONSTRAINT bgb_buddy_edges_canonical CHECK (user_a < user_b)
);
ALTER TABLE public.boardgamebuddy_buddy_edges ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_plays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  played_at DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  -- BGG play_id when this row was imported from BoardGameGeek (migration 062).
  -- Unique per (user_id, bgg_play_id) so resync is idempotent.
  bgg_play_id BIGINT,
  -- Optional photo URL into the boardgamebuddy-plays storage bucket (005).
  photo_url TEXT,
  -- Per-play scoring style (migration 007). Defaults to the game's
  -- play_mode on insert via the FE; the user can override per session
  -- (e.g. play a normally-competitive game in team mode for fun).
  play_mode TEXT NOT NULL DEFAULT 'competitive'
    CHECK (play_mode IN ('competitive', 'coop', 'team')),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_plays ENABLE ROW LEVEL SECURITY;

-- Players in a logged play. After migration 009, plays reference real
-- profiles directly (player_user_id) or a free-text name (player_display_name).
-- buddy_id is retained during the redesign rollout and dropped in migration 013.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  play_id UUID NOT NULL REFERENCES public.boardgamebuddy_plays(id) ON DELETE CASCADE,
  buddy_id UUID REFERENCES public.boardgamebuddy_buddies(id),
  player_user_id UUID REFERENCES public.boardgamebuddy_profiles(id) ON DELETE SET NULL,
  player_display_name TEXT,
  is_winner BOOLEAN DEFAULT false,
  -- Optional numeric score per player (migration 005). NULL = legacy plays.
  score INTEGER,
  CONSTRAINT bgb_play_players_identity_chk
    CHECK (player_user_id IS NOT NULL OR player_display_name IS NOT NULL)
);
ALTER TABLE public.boardgamebuddy_play_players ENABLE ROW LEVEL SECURITY;

-- Which expansion games were used during a play (migration 005).
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_expansions (
  play_id           UUID NOT NULL REFERENCES public.boardgamebuddy_plays(id) ON DELETE CASCADE,
  expansion_game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  PRIMARY KEY (play_id, expansion_game_id)
);
ALTER TABLE public.boardgamebuddy_play_expansions ENABLE ROW LEVEL SECURITY;

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

-- BGG-import staging (migration 062). When a user runs "Sync from BGG" and we
-- encounter a bgg_id we don't yet have in boardgamebuddy_games, we drop the
-- intended collection-status / play-record here and a background worker drains
-- the queue after fetching each missing game from the BGG XML API.
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
ALTER TABLE public.boardgamebuddy_bgg_pending_imports ENABLE ROW LEVEL SECURITY;

-- Short-code play-session lobby (migration 011). Host creates a session with
-- a code; other phones join, then the host finalizes into a single play.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  host_user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id UUID REFERENCES public.boardgamebuddy_games(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'finalized', 'abandoned')),
  finalized_play_id UUID REFERENCES public.boardgamebuddy_plays(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '2 hours'),
  finalized_at TIMESTAMPTZ
);
ALTER TABLE public.boardgamebuddy_play_sessions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_session_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.boardgamebuddy_play_sessions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_play_session_participants ENABLE ROW LEVEL SECURITY;

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
CREATE UNIQUE INDEX IF NOT EXISTS bgb_profiles_username_uk ON public.boardgamebuddy_profiles(username);
CREATE INDEX IF NOT EXISTS idx_bgb_games_bgg_id ON public.boardgamebuddy_games(bgg_id);
CREATE INDEX IF NOT EXISTS idx_bgb_games_name ON public.boardgamebuddy_games USING gin(to_tsvector('english', name));
CREATE INDEX IF NOT EXISTS idx_bgb_collections_user ON public.boardgamebuddy_collections(user_id);
CREATE INDEX IF NOT EXISTS idx_bgb_collections_game ON public.boardgamebuddy_collections(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_user ON public.boardgamebuddy_plays(user_id);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_game ON public.boardgamebuddy_plays(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_play_expansions_play
  ON public.boardgamebuddy_play_expansions(play_id);
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
-- BGG link (migration 062): unique linked username + dedup on imported plays
-- + queue indices on the pending-imports table.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_profiles_bgg_username
  ON public.boardgamebuddy_profiles (bgg_username)
  WHERE bgg_username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_plays_user_bgg_play
  ON public.boardgamebuddy_plays (user_id, bgg_play_id)
  WHERE bgg_play_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bgb_bgg_pending_user_status
  ON public.boardgamebuddy_bgg_pending_imports (user_id, status)
  WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_bgg_pending_unique
  ON public.boardgamebuddy_bgg_pending_imports (user_id, bgg_id, kind);
-- Mutual buddy edges (migration 008).
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_buddy_edges_pair
  ON public.boardgamebuddy_buddy_edges (user_a, user_b);
CREATE INDEX IF NOT EXISTS idx_bgb_buddy_edges_user_a
  ON public.boardgamebuddy_buddy_edges (user_a, status);
CREATE INDEX IF NOT EXISTS idx_bgb_buddy_edges_user_b
  ON public.boardgamebuddy_buddy_edges (user_b, status);
-- play_players decoupling (migration 009).
CREATE INDEX IF NOT EXISTS idx_bgb_play_players_user
  ON public.boardgamebuddy_play_players (player_user_id)
  WHERE player_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bgb_play_players_play
  ON public.boardgamebuddy_play_players (play_id);
-- Play sessions (migration 011).
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_play_sessions_open_code
  ON public.boardgamebuddy_play_sessions (code)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_bgb_play_sessions_host
  ON public.boardgamebuddy_play_sessions (host_user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_play_session_user_unique
  ON public.boardgamebuddy_play_session_participants (session_id, user_id)
  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_play_session_guest_unique
  ON public.boardgamebuddy_play_session_participants (session_id, lower(display_name))
  WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_bgb_play_session_participants_session
  ON public.boardgamebuddy_play_session_participants (session_id);
