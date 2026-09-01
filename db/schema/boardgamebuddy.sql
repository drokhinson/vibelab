-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — current schema snapshot
-- Last updated: migration 073 (BgB->BGG push queue, profiles.bgg_last_push_
--               started_at, pending_imports.kind gains 'catalog'), on top of
--               migration 046 (session write RPCs; drops the redundant
--               (code, phase) index), plus the two catalog-browse indexes from
--               051 and 060, the achievement objects from 062 (the catalog,
--               its groups, the per-user unlock rows and
--               profiles.app_installed_at), plays.country_code from 065 and the
--               country→continent lookup from 068, and the ghost-claim table
--               from 069, folded in below. Migrations 047-059 are NOT yet
--               reflected here — read them directly until someone catches this
--               snapshot up.
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
  -- Expansion linkage (folded into 001_baseline). is_expansion flags the row; when true,
  -- base_game_bgg_id stores the parent's BGG id (kept as a soft reference, not
  -- a FK, so expansions can be imported before their base game). expansion_color
  -- is auto-assigned at import time and used for the toggle/dot UI.
  is_expansion BOOLEAN NOT NULL DEFAULT false,
  base_game_bgg_id INTEGER,
  expansion_color TEXT,
  -- Official rulebook URL (folded into 001_baseline). Promoted from a `chunk_type='rulebook'`
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
  -- Linked BoardGameGeek username for collection/plays sync (folded into 001_baseline).
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
  -- Same idea for the outbound direction (migration 073). GET
  -- /bgg/push/status counts push-queue rows with created_at >= this to
  -- report session-scoped progress.
  bgg_last_push_started_at TIMESTAMPTZ,
  -- First time this account was seen running as an installed PWA (migration
  -- 062). The one achievement fact nothing in the database could derive; set
  -- by POST /achievements/installed and read only by bgb_sync_achievements.
  app_installed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  -- Migration 010 tightened this from ('owned','played','wishlist'); migration
  -- 069 added 'prev_owned'.
  --
  -- 'prev_owned' is a game you sold, gifted or donated. It is a SUBSET OF
  -- OWNED for display — bgb_collection_shelf('owned') and bgb_profile_bundle's
  -- owned_page return it alongside 'owned' rows, and the client renders it
  -- dimmed with a "Prev. owned" stamp — and NOT OWNED for counting: every
  -- `status = 'owned'` predicate elsewhere in this schema (owned_games,
  -- owned_expansions, the expansion_counts blocks, bgb_user_stats_detail's
  -- Shelf of Shame) deliberately excludes it. That asymmetry is the whole
  -- reason this is a third status value rather than a flag on the owned row.
  status TEXT NOT NULL CHECK (status IN ('owned', 'wishlist', 'prev_owned')),
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
  -- Migration 059. Set when the owner hand-marks an owned game as played
  -- before they joined BoardgameBuddy, so a pre-account favourite can leave
  -- the Shelf of Shame without a fabricated play. Read ONLY by the 'shelf'
  -- block of bgb_user_stats_detail — it is not a play, and no status map,
  -- bundle or play count sees it.
  played_before_at TIMESTAMPTZ,
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

-- Free-text ghost players only. Mutual friendship lives in
-- boardgamebuddy_buddy_edges; migration 013 dropped this table's
-- linked_user_id, so nothing here participates in the friend graph.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_buddies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
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

-- Ghost account claims (migration 070). A ghost player is not an entity — it
-- is a play_players row with player_user_id NULL — so a claim is keyed by the
-- only thing that identifies one: its owner (whoever logged the play) plus the
-- normalized name. Consent runs claimant → owner, the opposite direction from
-- bgb_link_ghost, and accepting runs that same merge.
--
-- Deliberately unlike boardgamebuddy_buddy_edges in two ways: no requested_by
-- (direction is structural — claimant_id asks, owner_id answers), and a FULL
-- unique on the triple rather than a partial unique on 'pending', so status
-- mutates in place and rejections cannot stack into a nag.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_ghost_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  -- lower(btrim(player_display_name)) — the key bgb_link_ghost_rows matches on.
  ghost_name_key TEXT NOT NULL,
  -- Original casing, denormalized: a sent request keeps reading the way it was
  -- sent even after the owner renames or deletes the underlying rows.
  ghost_display_name TEXT NOT NULL,
  claimant_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  --   pending / accepted / rejected / dismissed ("not me", claimant-side) /
  --   superseded (another claimant's accept took the ghost)
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'accepted', 'rejected', 'dismissed', 'superseded')),
  rows_merged INT,          -- how many play_players rows the accept moved
  reject_count INT NOT NULL DEFAULT 0,  -- two strikes, then no more asking
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT bgb_ghost_claims_not_self CHECK (owner_id <> claimant_id),
  CONSTRAINT bgb_ghost_claims_key_normalized
    CHECK (ghost_name_key = lower(btrim(ghost_name_key)) AND ghost_name_key <> ''),
  CONSTRAINT uq_bgb_ghost_claims_triple UNIQUE (owner_id, ghost_name_key, claimant_id)
);
ALTER TABLE public.boardgamebuddy_ghost_claims ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_ghost_claims TO boardgamebuddy_role;
CREATE INDEX IF NOT EXISTS idx_bgb_ghost_claims_owner_pending
  ON public.boardgamebuddy_ghost_claims (owner_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_bgb_ghost_claims_claimant
  ON public.boardgamebuddy_ghost_claims (claimant_id, status);

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_plays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  played_at DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  -- BGG play_id when this row was imported from BoardGameGeek (folded into 001_baseline).
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
  -- import; caching name/thumbnail here turns every play list into a
  -- single-table read. migration 044 dropped game_image_url and
  -- game_play_mode from this table — nothing ever read them off a play row.
  game_name TEXT NOT NULL,
  game_thumbnail_url TEXT,
  -- Client-generated idempotency key for offline-queued plays (migration 048).
  -- The web app's outbox (web/domain/outbox.js) stamps one UUID per queued
  -- play and re-sends it on every flush attempt, so a retry after a lost
  -- response returns the original play instead of writing a duplicate. NULL
  -- for every live write — two identical online POSTs really are two plays.
  client_key UUID,
  -- ISO 3166-1 alpha-2 country where the play happened (migration 065), upper
  -- case, NULL when unknown and on every row logged before 060. Resolved by
  -- the client from the device's IANA timezone (web/domain/geo.js) or picked
  -- by the host in Settle Up — country granularity only, so it needs no
  -- location permission and cannot say where anyone lives. Exists to feed a
  -- future popularity-by-country/region view; nothing reads it today.
  country_code TEXT
    CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.boardgamebuddy_plays ENABLE ROW LEVEL SECURITY;

-- Players in a logged play. After migration 009, plays reference real
-- profiles directly (player_user_id) or a free-text name (player_display_name).
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  play_id UUID NOT NULL REFERENCES public.boardgamebuddy_plays(id) ON DELETE CASCADE,
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

-- Per-user expansion toggle. LIVE: written and deleted by the toggle endpoint
-- in expansion_routes, read there and joined inside bgb_game_detail_bundle.
-- (An earlier note here called it unused — it is not.)
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_user_expansions (
  user_id            UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  expansion_game_id  UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, expansion_game_id)
);
ALTER TABLE public.boardgamebuddy_user_expansions ENABLE ROW LEVEL SECURITY;

-- BGG-import staging (folded into 001_baseline). When a user runs "Sync from BGG" and we
-- encounter a bgg_id we don't yet have in boardgamebuddy_games, we drop the
-- intended collection-status / play-record here and a background worker drains
-- the queue after fetching each missing game from the BGG XML API.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_bgg_pending_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  bgg_id INTEGER NOT NULL,
  -- 'catalog' (migration 073) materializes the GAME only and writes no
  -- collection row: POST /bgg/check queues it so a game on the user's BGG
  -- shelf that BgB has never seen can be listed by name in the comparison.
  -- A shelf row here would silently reverse the mirror.
  kind TEXT NOT NULL CHECK (kind IN ('collection', 'play', 'catalog')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'error')),
  error_message TEXT,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
ALTER TABLE public.boardgamebuddy_bgg_pending_imports ENABLE ROW LEVEL SECURITY;

-- Outbound queue for BgB -> BGG (migration 073). One planned change per game
-- per user, drained by a BackgroundTask at one BGG write per throttle tick.
-- State lives here rather than in memory so a Railway restart mid-push resumes
-- instead of replaying what already landed.
--
-- Deliberately NOT kind='push' on bgg_bgg_pending_imports: bgb_bgg_sync_status
-- counts every row for the user with no kind filter, so a queued push would
-- inflate the IMPORT poll's pending_count and pin that poll open forever.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_bgg_push_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  bgg_id INTEGER NOT NULL,
  -- Denormalized at plan time so the status RPC never joins games — and so a
  -- 'clear' row, which by definition has no local game, still has a name.
  game_name TEXT NOT NULL,
  -- BGG's collection-row id. NULL is the ONLY case that creates a row on BGG
  -- rather than editing one, and the payload branches on this rather than on
  -- `change`: a game flagged only fortrade is invisible to the status sweep,
  -- so an 'add' can still turn out to have an existing row. Sending no collid
  -- for one of those would duplicate it and orphan the user's rating.
  bgg_collid BIGINT,
  change TEXT NOT NULL CHECK (change IN ('add', 'update', 'clear')),
  target_status TEXT CHECK (target_status IN ('owned', 'wishlist', 'prev_owned')),
  -- The complete form field set, frozen at plan time: the flags BgB owns at
  -- their target values PLUS every other <status> attribute echoed back
  -- verbatim. Frozen so the worker never re-reads BGG, and so a shelf edit
  -- mid-push cannot produce a half-old, half-new write set.
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'error')),
  attempts INT NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT bgb_push_change_status CHECK (
    (change IN ('add', 'update') AND target_status IS NOT NULL) OR
    (change = 'clear' AND target_status IS NULL)
  ),
  UNIQUE (user_id, bgg_id)
);
ALTER TABLE public.boardgamebuddy_bgg_push_queue ENABLE ROW LEVEL SECURITY;

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
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Host-assigned column order, 0-based (migration 056). The participants
  -- array's order IS the scoring grid's column order on every surface, so this
  -- is what carries a row the host dragged in Gather through to the
  -- spectators' mirror. NULL = never ordered; bgb_session_bundle sorts
  -- (position NULLS LAST, joined_at), which puts a joiner who arrived after a
  -- reorder at the end — where the host's own lobby poll appends them locally.
  -- bgb_create_session seats the host at 0 and bgb_add_participant at max+1.
  position SMALLINT
);
ALTER TABLE public.boardgamebuddy_play_session_participants ENABLE ROW LEVEL SECURITY;

-- Per-participant, per-round live scores during the Play phase (migration 026;
-- re-keyed from player_user_id to participant_id by migration 053). The host's
-- browser writes directly via anon key and everybody else reads: RLS limits
-- writes to the host of the session, and only while phase='play'. Keying by
-- participant rather than user is what lets a guest's column stream too —
-- guests have a roster row but no account.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_session_scores (
  session_id     UUID NOT NULL REFERENCES public.boardgamebuddy_play_sessions(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES public.boardgamebuddy_play_session_participants(id) ON DELETE CASCADE,
  round_index    SMALLINT NOT NULL CHECK (round_index >= 0 AND round_index < 64),
  score          INTEGER,
  PRIMARY KEY (session_id, participant_id, round_index)
);
ALTER TABLE public.boardgamebuddy_play_session_scores ENABLE ROW LEVEL SECURITY;

-- Per-user "this chapter is in my guide" rows (migration 018, renamed
-- from boardgamebuddy_guide_selections). Presence = in guide, absence =
-- not. Ordering is by created_at.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_user_chapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  chapter_id UUID NOT NULL REFERENCES public.boardgamebuddy_guide_chapters(id) ON DELETE CASCADE,
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

-- Achievement catalog (migration 062, extended by 068). Three objects: the five
-- section headings, the nineteen badges, and one row per badge a user has
-- earned.
-- The catalog is DATA, not a Python dict, so retuning a tier or rewording a
-- badge is an UPDATE rather than a deploy. `metric` names a key of the JSONB
-- blob bgb_sync_achievements computes; `icon` is a sprite slug resolving to
-- web/assets/sprites/achievements/bgb-ach-<icon>.svg.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_achievement_groups (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  blurb         TEXT NOT NULL,
  display_order INT  NOT NULL
);
ALTER TABLE public.boardgamebuddy_achievement_groups ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_achievements (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES public.boardgamebuddy_achievement_groups(id),
  name          TEXT NOT NULL,
  tagline       TEXT NOT NULL,
  requirement   TEXT NOT NULL,
  -- Migration 068 dropped 062's inline (server-named) constraint and re-added
  -- it under a name of our own, with 'countries' and 'continents' appended.
  metric        TEXT NOT NULL CONSTRAINT bgb_achievements_metric_chk CHECK (metric IN (
                  'plays_logged', 'wins', 'biggest_table', 'two_player_games',
                  'buddies', 'guide_chapters', 'chapters_borrowed',
                  'plays_with_notes', 'bgg_linked', 'app_installed',
                  'countries', 'continents')),
  threshold     INT  NOT NULL CHECK (threshold > 0),
  icon          TEXT NOT NULL,
  display_order INT  NOT NULL
);
ALTER TABLE public.boardgamebuddy_achievements ENABLE ROW LEVEL SECURITY;

-- Written once, when a badge is first earned. Exists ONLY to pin the unlock
-- date — and to make the badge permanent: deleting a play afterwards does not
-- take back the evening it belonged to.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_user_achievements (
  user_id        UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL REFERENCES public.boardgamebuddy_achievements(id) ON DELETE CASCADE,
  unlocked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, achievement_id)
);
ALTER TABLE public.boardgamebuddy_user_achievements ENABLE ROW LEVEL SECURITY;

-- Country → continent (migration 068), the lookup behind the Globe Trotter
-- badge. Seeded with all 247 codes web/domain/geo-data.js can produce, so no
-- country the app can detect or offer is missing a continent. Transcontinental
-- countries get one continent each (RU→EU, TR/CY/AM/AZ/GE/KZ→AS, EG→AF) —
-- see the migration for why. No continent NAME column: nothing prints one yet.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_countries (
  code      TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
  continent TEXT NOT NULL CHECK (continent IN ('AF','AN','AS','EU','NA','OC','SA'))
);
ALTER TABLE public.boardgamebuddy_countries ENABLE ROW LEVEL SECURITY;

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS bgb_profiles_username_uk ON public.boardgamebuddy_profiles(username);
-- Composite indexes (migration 019) — supersede the single-column variants.
CREATE INDEX IF NOT EXISTS idx_bgb_collections_user_status
  ON public.boardgamebuddy_collections (user_id, status, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_bgb_collections_game_user
  ON public.boardgamebuddy_collections (game_id, user_id);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_user_played
  ON public.boardgamebuddy_plays (user_id, played_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_game_played
  ON public.boardgamebuddy_plays (game_id, played_at DESC);
-- Migration 043: bgb_hot_games ranges on played_at alone; neither composite
-- above leads with it, so it was seq-scanning the plays table per /feed.
CREATE INDEX IF NOT EXISTS idx_bgb_plays_played_at
  ON public.boardgamebuddy_plays (played_at DESC);
-- Phase 2 (migration 020): alphabetical shelf sort.
CREATE INDEX IF NOT EXISTS idx_bgb_collections_user_status_name
  ON public.boardgamebuddy_collections (user_id, status, game_name);
CREATE INDEX IF NOT EXISTS idx_bgb_chapters_game_type
  ON public.boardgamebuddy_guide_chapters(game_id, chapter_type);
CREATE INDEX IF NOT EXISTS idx_bgb_user_chapters_user_game
  ON public.boardgamebuddy_user_chapters(user_id, game_id);
CREATE INDEX IF NOT EXISTS idx_bgb_user_chapters_chapter
  ON public.boardgamebuddy_user_chapters(chapter_id);
CREATE INDEX IF NOT EXISTS idx_bgb_chapter_reports_status
  ON public.boardgamebuddy_chapter_reports(status, created_at);
-- Achievements (migration 062): the catalog is always read in screen order.
CREATE INDEX IF NOT EXISTS idx_bgb_achievements_order
  ON public.boardgamebuddy_achievements (display_order);
-- Expansions (folded into 001_baseline): fast lookup of a base game's expansions by bgg_id.
CREATE INDEX IF NOT EXISTS idx_bgb_games_base_bgg
  ON public.boardgamebuddy_games(base_game_bgg_id)
  WHERE is_expansion = true;
-- Buddies linking (migration 043): one linked-row per (owner, target) and a
-- fast lookup for "plays where I'm a linked buddy".
-- BGG link (folded into 001_baseline): unique linked username + dedup on imported plays
-- + queue indices on the pending-imports table.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_profiles_bgg_username
  ON public.boardgamebuddy_profiles (bgg_username)
  WHERE bgg_username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_plays_user_bgg_play
  ON public.boardgamebuddy_plays (user_id, bgg_play_id)
  WHERE bgg_play_id IS NOT NULL;
-- Offline outbox idempotency (migration 048). Partial so the unlimited NULLs
-- from live writes don't collide; bgb_log_play returns the existing play
-- instead of inserting when the key is already stored.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_plays_client_key
  ON public.boardgamebuddy_plays (user_id, client_key)
  WHERE client_key IS NOT NULL;
-- Popularity by country (migration 065). (country_code, game_id) is the shape
-- of every question the column exists for — "top games in X", "which countries
-- play Y". Partial because most rows will be NULL for a long while and a NULL
-- is never an answer.
CREATE INDEX IF NOT EXISTS idx_bgb_plays_country_game
  ON public.boardgamebuddy_plays (country_code, game_id)
  WHERE country_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bgb_bgg_pending_user_status
  ON public.boardgamebuddy_bgg_pending_imports (user_id, status)
  WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_bgg_pending_unique
  ON public.boardgamebuddy_bgg_pending_imports (user_id, bgg_id, kind);

-- Push queue (migration 073): the worker's pending scan, and the status RPC's
-- session window.
CREATE INDEX IF NOT EXISTS idx_bgb_push_queue_user_pending
  ON public.boardgamebuddy_bgg_push_queue (user_id, status)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_bgb_push_queue_user_created
  ON public.boardgamebuddy_bgg_push_queue (user_id, created_at);
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
-- Play sessions (migration 011, phase added in 026). 026 also created
-- idx_bgb_play_sessions_code_phase (code, phase); migration 046 drops it —
-- every session lookup filters (code, status='open'), which the partial
-- unique index below serves, so it was write amplification on a table each
-- host tap writes to.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_play_sessions_open_code
  ON public.boardgamebuddy_play_sessions (code)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_bgb_play_sessions_host
  ON public.boardgamebuddy_play_sessions (host_user_id, status);
-- Migration 043: bgb_joinable_sessions filters expires_at > now() over the
-- open sessions; partial because that's the only status it looks at.
CREATE INDEX IF NOT EXISTS idx_bgb_play_sessions_expires
  ON public.boardgamebuddy_play_sessions (expires_at)
  WHERE status = 'open';
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

-- Catalog browse, one ordered index per sort axis GET /games offers. Both
-- carry the `is_expansion = false` predicate the browse callers always send,
-- and both end in `id DESC` because neither leading column is unique —
-- created_at is nullable and bulk imports share a transaction timestamp; two
-- printings of one game share a name.
--   created_at DESC (migration 051) — `sort=newest`, the default: the Game
--     Explorer's "All BgB Games" grid.
--   name ASC (migration 060) — `sort=alphabetical`: the Add Games catalog
--     scroll, which pages the whole catalog end to end.
CREATE INDEX IF NOT EXISTS idx_bgb_games_browse
  ON public.boardgamebuddy_games (created_at DESC, id DESC)
  WHERE is_expansion = false;
CREATE INDEX IF NOT EXISTS idx_bgb_games_browse_alpha
  ON public.boardgamebuddy_games (name ASC, id DESC)
  WHERE is_expansion = false;

-- ─────────────────────────────────────────────────────────────────────────────
-- Objects the migrations create that this snapshot used to omit
-- ─────────────────────────────────────────────────────────────────────────────

-- Extensions. Both live in the `extensions` schema on Supabase, which is why
-- the trigram opclasses above are schema-qualified.
--   pg_trgm   (migration 039) — backs the substring-search indexes.
--   pgcrypto  (migration 036) — created for gen_random_bytes, then abandoned by
--             038 in favour of uuid_send(gen_random_uuid()). Retained because
--             the extension is shared across every app in this database.

-- Row-level security policies (migration 026). Only these three exist; every
-- other table has RLS enabled with no policy, because the backend uses the
-- service-role key and bypasses RLS entirely. These three are what let the
-- browser's anon key drive the live-scoring / phase Realtime path directly.
--   bgb_play_sessions_select   ON boardgamebuddy_play_sessions
--   bgb_session_scores_select  ON boardgamebuddy_play_session_scores
--   bgb_session_scores_write   ON boardgamebuddy_play_session_scores
--                              (narrowed to host-only by migration 053)

-- Data API grants (migration 034). Required for the two tables the frontend
-- reaches directly through supabase-js; RLS authorises the rows, but the
-- table-level grant is what makes them visible to PostgREST at all.
--   GRANT SELECT               ON boardgamebuddy_play_sessions       TO authenticated;
--   GRANT SELECT, INSERT, UPDATE
--                              ON boardgamebuddy_play_session_scores TO authenticated;
--   GRANT DELETE               ON boardgamebuddy_play_session_scores TO authenticated;
--                              (migration 053 — removeRoundAt() deletes the
--                               round tail and rewrites it; 034 never granted
--                               DELETE, so that half silently 403'd)

-- Project role grants. Every migration issues
--   GRANT SELECT ON public.boardgamebuddy_<table> TO boardgamebuddy_role;
-- for the tables it creates (see db/migrations/README.md). The role itself is
-- created in db/migrations/_shared/003_project_roles.sql.

-- Named constraint declared inline above as an anonymous CHECK:
--   bgb_profiles_username_format  CHECK (username ~ '^[a-z0-9_]{3,30}$')  (migration 017)
