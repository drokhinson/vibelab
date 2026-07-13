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
  -- Customizable badge config (migration 029): JSONB
  -- { icon: "initials"|<key>, iconColor: "#hex", bgColor: "#hex" }.
  -- NULL = BGB default (brown badge + gold initials), rendered client-side.
  avatar JSONB,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  -- First-time onboarding gate (migration 030). TRUE for brand-new
  -- accounts; cleared on the first successful POST /profile so the
  -- "Create your profile" modal only fires until they save.
  needs_setup BOOLEAN NOT NULL DEFAULT true,
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
  -- Stamp set at the start of POST /bgg/sync. GET /bgg/sync/status counts
  -- pending-import rows whose created_at >= this value to report
  -- session-scoped progress (Imported X of Y). Added in migration 027.
  bgg_last_sync_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_profiles ENABLE ROW LEVEL SECURITY;

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
  -- Denormalized game fields (migration 020) so the shelf can render +
  -- filter without joining boardgamebuddy_games. Games are immutable post-
  -- import; admin re-host paths call _sync_denormalized_game_fields to
  -- propagate any updates.
  game_name TEXT NOT NULL,
  game_thumbnail_url TEXT,
  game_year_published INTEGER,
  game_min_players SMALLINT,
  game_max_players SMALLINT,
  game_playing_time SMALLINT,
  game_is_expansion BOOLEAN,
  game_base_game_bgg_id INTEGER,
  game_expansion_color TEXT,
  game_play_mode TEXT,
  game_bgg_id INTEGER,
  game_theme_color TEXT,
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
  -- Denormalized game fields (migration 020). Games are immutable after BGG
  -- import; caching name/image/play_mode here turns every play list into a
  -- single-table read. game_play_mode is the game's intrinsic mode, distinct
  -- from play_mode above (which is what the user actually played).
  game_name TEXT NOT NULL,
  game_thumbnail_url TEXT,
  game_image_url TEXT,
  game_play_mode TEXT,
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
  -- Per-round score breakdown (migration 028). NULL when no rounds were
  -- tracked (<= 1 round). When populated, `score` is the sum of this
  -- array (the popup edit form keeps the two in step on save).
  round_scores JSONB,
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

-- Chapter system (migration 018 renamed from chunks). Each user builds
-- their own reference guide for each game by picking chapters from the
-- shared pool or authoring new ones. There is no curated default set.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_chapter_types (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  icon TEXT,
  display_order INT DEFAULT 0
);
ALTER TABLE public.boardgamebuddy_chapter_types ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_guide_chapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  chapter_type TEXT NOT NULL REFERENCES public.boardgamebuddy_chapter_types(id),
  title TEXT NOT NULL,
  created_by UUID REFERENCES public.boardgamebuddy_profiles(id) ON DELETE SET NULL,
  layout TEXT NOT NULL DEFAULT 'text' CHECK (layout IN ('text')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_guide_chapters ENABLE ROW LEVEL SECURITY;

-- Per-user expansion toggle (migration 046). Retained for now; the new
-- chapter system no longer consumes it (each game has its own guide).
-- Drop in a follow-up once confirmed unused.
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
  -- Host-driven cursor through the three-screen flow (migration 026). Drives
  -- realtime phase fanout to joiners — `status` still gates expiry/finalize.
  phase TEXT NOT NULL DEFAULT 'gather'
    CHECK (phase IN ('gather', 'play', 'settle', 'finalized', 'abandoned')),
  finalized_play_id UUID REFERENCES public.boardgamebuddy_plays(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '2 hours'),
  finalized_at TIMESTAMPTZ
);
ALTER TABLE public.boardgamebuddy_play_sessions ENABLE ROW LEVEL SECURITY;
-- Migration 026 adds a SELECT policy so authed joiners' anon-key Realtime
-- subscriptions can resolve phase updates (host + participants only).

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_session_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.boardgamebuddy_play_sessions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_play_session_participants ENABLE ROW LEVEL SECURITY;

-- Per-player, per-round live scores during the Play phase (migration 026).
-- Browser writes directly via anon key; RLS limits each row to (host of the
-- session) OR (player_user_id = auth.uid()), and only while phase='play'.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_session_scores (
  session_id     UUID NOT NULL REFERENCES public.boardgamebuddy_play_sessions(id) ON DELETE CASCADE,
  player_user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  round_index    SMALLINT NOT NULL CHECK (round_index >= 0 AND round_index < 64),
  score          INTEGER,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, player_user_id, round_index)
);
ALTER TABLE public.boardgamebuddy_play_session_scores ENABLE ROW LEVEL SECURITY;

-- Per-user "this chapter is in my guide" rows (migration 018, renamed
-- from boardgamebuddy_guide_selections). Presence = in guide, absence =
-- not. display_order is kept for a future reorder UI; V1 sorts by
-- created_at.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_user_chapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  chapter_id UUID NOT NULL REFERENCES public.boardgamebuddy_guide_chapters(id) ON DELETE CASCADE,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, chapter_id)
);
ALTER TABLE public.boardgamebuddy_user_chapters ENABLE ROW LEVEL SECURITY;

-- Chapter moderation reports (migration 018). Any user can report a
-- chapter; admins resolve (no-action) or delete the chapter outright.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_chapter_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id  UUID NOT NULL REFERENCES public.boardgamebuddy_guide_chapters(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'resolved')),
  resolved_by UUID REFERENCES public.boardgamebuddy_profiles(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chapter_id, reporter_id)
);
ALTER TABLE public.boardgamebuddy_chapter_reports ENABLE ROW LEVEL SECURITY;

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS bgb_profiles_username_uk ON public.boardgamebuddy_profiles(username);
CREATE INDEX IF NOT EXISTS idx_bgb_games_bgg_id ON public.boardgamebuddy_games(bgg_id);
CREATE INDEX IF NOT EXISTS idx_bgb_games_name ON public.boardgamebuddy_games USING gin(to_tsvector('english', name));
-- Composite indexes (migration 019) — supersede the single-column variants.
CREATE INDEX IF NOT EXISTS idx_bgb_collections_user_status
  ON public.boardgamebuddy_collections (user_id, status, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_bgb_collections_game_user
  ON public.boardgamebuddy_collections (game_id, user_id);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_user_played
  ON public.boardgamebuddy_plays (user_id, played_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_game_played
  ON public.boardgamebuddy_plays (game_id, played_at DESC);
-- Phase 2 (migration 020): alphabetical shelf sort.
CREATE INDEX IF NOT EXISTS idx_bgb_collections_user_status_name
  ON public.boardgamebuddy_collections (user_id, status, game_name);
CREATE INDEX IF NOT EXISTS idx_bgb_play_expansions_play
  ON public.boardgamebuddy_play_expansions(play_id);
CREATE INDEX IF NOT EXISTS idx_bgb_guides_game ON public.boardgamebuddy_guides(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_chapters_game ON public.boardgamebuddy_guide_chapters(game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_chapters_game_type
  ON public.boardgamebuddy_guide_chapters(game_id, chapter_type);
CREATE INDEX IF NOT EXISTS idx_bgb_user_chapters_user_game
  ON public.boardgamebuddy_user_chapters(user_id, game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_user_chapters_chapter
  ON public.boardgamebuddy_user_chapters(chapter_id);
CREATE INDEX IF NOT EXISTS idx_bgb_chapter_reports_status
  ON public.boardgamebuddy_chapter_reports(status, created_at);
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
-- play_players decoupling (migration 009 → 019).
-- Migration 019 replaced the (player_user_id) index with the composite
-- (player_user_id, play_id) so "find plays I appeared in" is index-only.
CREATE INDEX IF NOT EXISTS idx_bgb_play_players_user_play
  ON public.boardgamebuddy_play_players (player_user_id, play_id)
  WHERE player_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bgb_play_players_play
  ON public.boardgamebuddy_play_players (play_id);
-- Play sessions (migration 011, phase added in 026).
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_play_sessions_open_code
  ON public.boardgamebuddy_play_sessions (code)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_bgb_play_sessions_host
  ON public.boardgamebuddy_play_sessions (host_user_id, status);
CREATE INDEX IF NOT EXISTS idx_bgb_play_sessions_code_phase
  ON public.boardgamebuddy_play_sessions (code, phase);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_play_session_user_unique
  ON public.boardgamebuddy_play_session_participants (session_id, user_id)
  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_play_session_guest_unique
  ON public.boardgamebuddy_play_session_participants (session_id, lower(display_name))
  WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_bgb_play_session_participants_session
  ON public.boardgamebuddy_play_session_participants (session_id);
-- Live scoring (migration 026).
CREATE INDEX IF NOT EXISTS idx_bgb_play_session_scores_session
  ON public.boardgamebuddy_play_session_scores (session_id, round_index);

-- Trigram substring-search indexes (migration 039). pg_trgm lives in the
-- `extensions` schema on Supabase — opclass is schema-qualified on purpose.
CREATE INDEX IF NOT EXISTS idx_bgb_games_name_trgm
  ON public.boardgamebuddy_games
  USING gin (name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_bgb_play_players_display_name_trgm
  ON public.boardgamebuddy_play_players
  USING gin (player_display_name extensions.gin_trgm_ops);
-- Sync-status session roll-up predicate (migration 039).
CREATE INDEX IF NOT EXISTS idx_bgb_pending_imports_user_created
  ON public.boardgamebuddy_bgg_pending_imports (user_id, created_at);
