-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — baseline: tables
--
-- Run on an empty database in this order: 001_baseline_tables.sql (this file),
--   002_baseline_functions_play.sql, 003_baseline_functions_social.sql,
--   004_seed.sql
-- then every later NNN_*.sql in this directory, in number order.
--
-- Generated on 2026-09-29 by .claude/skills/squash-migrations/squash.py from
-- the 58 migrations in archive/2026-09-28/ and 059_good_games_received.sql and
-- 060_comments_describe_current_schema.sql: they were replayed into an empty
-- database and these files were read back out of its catalog. A database built
-- from them diffs clean against that replay.
--
-- FRESH-DB ONLY. Production reaches this state through the migrations it was
-- generated from. Never run these files there.
--
-- Needs these first, for the cross-app tables it reads:
-- _shared/001_analytics.sql, _shared/004_api_logs.sql,
-- _shared/005_api_sessions.sql, _shared/006_drop_api_sessions.sql.
--
-- 39 tables in foreign-key order, each with its indexes, RLS switch,
-- grants and comments.
-- Then the 7 RLS policies, preceded by the function they call.
--
-- Grants are the difference from Supabase's defaults, which give anon,
-- authenticated and service_role everything on a new table or function (and
-- EXECUTE to PUBLIC). An object with no GRANT/REVOKE lines keeps them.
-- ─────────────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────────────
-- Roles and extensions
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'boardgamebuddy_role') THEN
    CREATE ROLE boardgamebuddy_role LOGIN PASSWORD 'change-me-via-shared-003' NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO boardgamebuddy_role;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;


-- ─────────────────────────────────────────────────────────────────────────────
-- Tables (39)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── boardgamebuddy_achievement_groups ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_achievement_groups (
  id            text NOT NULL,
  label         text NOT NULL,
  blurb         text NOT NULL,
  display_order integer NOT NULL,
  CONSTRAINT boardgamebuddy_achievement_groups_pkey PRIMARY KEY (id)
);
ALTER TABLE public.boardgamebuddy_achievement_groups ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_achievement_groups TO boardgamebuddy_role;

-- ── boardgamebuddy_achievements ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_achievements (
  id            text NOT NULL,
  group_id      text NOT NULL,
  name          text NOT NULL,
  tagline       text NOT NULL,
  requirement   text NOT NULL,
  metric        text NOT NULL,
  threshold     integer NOT NULL,
  icon          text NOT NULL,
  display_order integer NOT NULL,
  CONSTRAINT boardgamebuddy_achievements_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_achievements_metric_chk CHECK ((metric = ANY (ARRAY['plays_logged'::text, 'wins'::text, 'biggest_table'::text, 'two_player_games'::text, 'buddies'::text, 'guide_chapters'::text, 'chapters_borrowed'::text, 'plays_with_notes'::text, 'bgg_linked'::text, 'app_installed'::text, 'countries'::text, 'continents'::text, 'plays_with_grid'::text, 'grid_adopters'::text, 'team_wins'::text, 'coop_wins'::text]))),
  CONSTRAINT boardgamebuddy_achievements_threshold_check CHECK ((threshold > 0)),
  CONSTRAINT boardgamebuddy_achievements_group_id_fkey FOREIGN KEY (group_id) REFERENCES boardgamebuddy_achievement_groups(id)
);
CREATE INDEX IF NOT EXISTS idx_bgb_achievements_order ON public.boardgamebuddy_achievements USING btree (display_order);
ALTER TABLE public.boardgamebuddy_achievements ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_achievements TO boardgamebuddy_role;

-- ── boardgamebuddy_affiliate_partners ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_affiliate_partners (
  id               text NOT NULL,
  label            text NOT NULL,
  url_template     text NOT NULL,
  wrapper_template text,
  tracking_tag     text,
  disclosure       text,
  notes            text,
  display_order    integer DEFAULT 0 NOT NULL,
  enabled          boolean DEFAULT false NOT NULL,
  created_at       timestamp with time zone DEFAULT now() NOT NULL,
  updated_at       timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_affiliate_partners_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_affiliate_partners_id_slug_chk CHECK ((id ~ '^[a-z0-9][a-z0-9-]{1,40}$'::text))
);
ALTER TABLE public.boardgamebuddy_affiliate_partners ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_affiliate_partners TO boardgamebuddy_role;
COMMENT ON TABLE public.boardgamebuddy_affiliate_partners IS 'A partner renders only when enabled AND it has a tracking_tag or a wrapper_template.';
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.url_template IS 'Store URL with {query} (the game name, URL-encoded) and optionally {tag} (tracking_tag).';
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.wrapper_template IS 'Optional network redirect around the store URL; {url} is that URL, percent-encoded.';

-- ── boardgamebuddy_bgg_hot_snapshots ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_bgg_hot_snapshots (
  captured_at    timestamp with time zone NOT NULL,
  bgg_id         integer NOT NULL,
  rank           integer NOT NULL,
  name           text NOT NULL,
  year_published integer,
  thumbnail_url  text,
  CONSTRAINT boardgamebuddy_bgg_hot_snapshots_pkey PRIMARY KEY (captured_at, bgg_id)
);
CREATE INDEX IF NOT EXISTS idx_bgb_hot_snapshots_bgg_captured ON public.boardgamebuddy_bgg_hot_snapshots USING btree (bgg_id, captured_at DESC);
ALTER TABLE public.boardgamebuddy_bgg_hot_snapshots ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_bgg_hot_snapshots TO boardgamebuddy_role;
COMMENT ON TABLE public.boardgamebuddy_bgg_hot_snapshots IS 'BGG''s hot list, one row per (refresh, game). captured_at identifies the refresh: every row of one run shares it.';

-- ── boardgamebuddy_bgg_thumb_cache ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_bgg_thumb_cache (
  bgg_id        integer NOT NULL,
  thumbnail_url text,
  fetched_at    timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_bgg_thumb_cache_pkey PRIMARY KEY (bgg_id)
);
ALTER TABLE public.boardgamebuddy_bgg_thumb_cache ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.boardgamebuddy_bgg_thumb_cache IS 'Thumbnails for BGG search results. A game here is not in the catalog.';

-- ── boardgamebuddy_chapter_types ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_chapter_types (
  id            text NOT NULL,
  label         text NOT NULL,
  icon          text,
  display_order integer DEFAULT 0,
  CONSTRAINT boardgamebuddy_chunk_types_pkey PRIMARY KEY (id)
);
ALTER TABLE public.boardgamebuddy_chapter_types ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_chapter_types TO boardgamebuddy_role;

-- ── boardgamebuddy_countries ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_countries (
  code      text NOT NULL,
  continent text NOT NULL,
  CONSTRAINT boardgamebuddy_countries_pkey PRIMARY KEY (code),
  CONSTRAINT boardgamebuddy_countries_code_check CHECK ((code ~ '^[A-Z]{2}$'::text)),
  CONSTRAINT boardgamebuddy_countries_continent_check CHECK ((continent = ANY (ARRAY['AF'::text, 'AN'::text, 'AS'::text, 'EU'::text, 'NA'::text, 'OC'::text, 'SA'::text])))
);
ALTER TABLE public.boardgamebuddy_countries ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_countries TO boardgamebuddy_role;

-- ── boardgamebuddy_feedback_topics ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_feedback_topics (
  id            text NOT NULL,
  label         text NOT NULL,
  icon          text,
  display_order integer DEFAULT 0,
  CONSTRAINT boardgamebuddy_feedback_topics_pkey PRIMARY KEY (id)
);
ALTER TABLE public.boardgamebuddy_feedback_topics ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_feedback_topics TO boardgamebuddy_role;

-- ── boardgamebuddy_feedback_types ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_feedback_types (
  id            text NOT NULL,
  label         text NOT NULL,
  icon          text,
  display_order integer DEFAULT 0,
  CONSTRAINT boardgamebuddy_feedback_types_pkey PRIMARY KEY (id)
);
ALTER TABLE public.boardgamebuddy_feedback_types ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_feedback_types TO boardgamebuddy_role;

-- ── boardgamebuddy_games ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_games (
  id                   uuid DEFAULT gen_random_uuid() NOT NULL,
  bgg_id               integer,
  name                 text NOT NULL,
  year_published       integer,
  min_players          integer,
  max_players          integer,
  playing_time         integer,
  description          text,
  image_url            text,
  thumbnail_url        text,
  categories           text[] DEFAULT '{}'::text[],
  mechanics            text[] DEFAULT '{}'::text[],
  theme_color          text,
  is_expansion         boolean DEFAULT false NOT NULL,
  base_game_bgg_id     integer,
  expansion_color      text,
  rulebook_url         text,
  created_at           timestamp with time zone DEFAULT now(),
  play_mode            text DEFAULT 'competitive'::text NOT NULL,
  bgg_rating           numeric(4,2),
  bgg_rank             integer,
  bgg_weight           numeric(4,2),
  bgg_owned_count      integer,
  bgg_stats_synced_at  timestamp with time zone,
  publishers           text[],
  bgg_meta_synced_at   timestamp with time zone,
  bgg_image_url        text,
  bgg_thumbnail_url    text,
  bgg_images_synced_at timestamp with time zone,
  bgg_family           text,
  CONSTRAINT boardgamebuddy_games_pkey PRIMARY KEY (id),
  CONSTRAINT boardgamebuddy_games_bgg_id_key UNIQUE (bgg_id),
  CONSTRAINT boardgamebuddy_games_play_mode_check CHECK ((play_mode = ANY (ARRAY['competitive'::text, 'coop'::text, 'team'::text])))
);
CREATE INDEX IF NOT EXISTS idx_bgb_games_base_bgg ON public.boardgamebuddy_games USING btree (base_game_bgg_id) WHERE (is_expansion = true);
CREATE INDEX IF NOT EXISTS idx_bgb_games_browse ON public.boardgamebuddy_games USING btree (created_at DESC, id DESC) WHERE (is_expansion = false);
CREATE INDEX IF NOT EXISTS idx_bgb_games_browse_alpha ON public.boardgamebuddy_games USING btree (name, id DESC) WHERE (is_expansion = false);
CREATE INDEX IF NOT EXISTS idx_bgb_games_images_synced ON public.boardgamebuddy_games USING btree (bgg_images_synced_at NULLS FIRST) WHERE (bgg_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bgb_games_mechanics_gin ON public.boardgamebuddy_games USING gin (mechanics) WHERE (is_expansion = false);
CREATE INDEX IF NOT EXISTS idx_bgb_games_meta_synced ON public.boardgamebuddy_games USING btree (bgg_meta_synced_at NULLS FIRST) WHERE (bgg_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bgb_games_name_trgm ON public.boardgamebuddy_games USING gin (name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_bgb_games_stats_synced ON public.boardgamebuddy_games USING btree (bgg_stats_synced_at NULLS FIRST) WHERE (bgg_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bgb_games_year_rank ON public.boardgamebuddy_games USING btree (year_published DESC, bgg_rank) WHERE (is_expansion = false);
ALTER TABLE public.boardgamebuddy_games ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_games TO boardgamebuddy_role;
COMMENT ON COLUMN public.boardgamebuddy_games.rulebook_url IS 'Unused: nothing reads or writes it. A game''s rulebook link is an approved layout=''rulebook_link'' chapter. Kept only because many RPCs select it.';
COMMENT ON COLUMN public.boardgamebuddy_games.publishers IS '''{}'' = BGG credits no publisher; NULL = not read from BGG yet. Readers treat both as an empty list.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_meta_synced_at IS 'Last read of the game''s BGG record. NULL with a non-null bgg_id = queued for the metadata backfill.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_images_synced_at IS 'Last read of the game''s BGG image URLs. NULL with a non-null bgg_id = queued for the image-links backfill.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_family IS 'The BGG family rank list the game ranks highest in (strategygames, familygames, …). Decides the category it is ranked in.';

-- ── boardgamebuddy_affiliate_clicks ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_affiliate_clicks (
  id         uuid DEFAULT gen_random_uuid() NOT NULL,
  partner_id text NOT NULL,
  game_id    uuid,
  surface    text NOT NULL,
  clicked_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_affiliate_clicks_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_affiliate_clicks_surface_chk CHECK ((surface = ANY (ARRAY['game_detail'::text, 'discover'::text]))),
  CONSTRAINT bgb_affiliate_clicks_game_fkey FOREIGN KEY (game_id) REFERENCES boardgamebuddy_games(id) ON DELETE SET NULL,
  CONSTRAINT bgb_affiliate_clicks_partner_fkey FOREIGN KEY (partner_id) REFERENCES boardgamebuddy_affiliate_partners(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bgb_affiliate_clicks_game ON public.boardgamebuddy_affiliate_clicks USING btree (game_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_bgb_affiliate_clicks_partner ON public.boardgamebuddy_affiliate_clicks USING btree (partner_id, clicked_at DESC);
ALTER TABLE public.boardgamebuddy_affiliate_clicks ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_affiliate_clicks TO boardgamebuddy_role;
COMMENT ON TABLE public.boardgamebuddy_affiliate_clicks IS 'One row per tap on a partner link. No user column, by design: usage records carry no account identifier.';

-- ── boardgamebuddy_profiles ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_profiles (
  id                         uuid NOT NULL,
  display_name               text NOT NULL,
  is_admin                   boolean DEFAULT false NOT NULL,
  bgg_username               text,
  created_at                 timestamp with time zone DEFAULT now(),
  bgg_password_enc           text,
  bgg_session_id             text,
  bgg_session_expires_at     timestamp with time zone,
  bgg_session_user_cookie    text,
  bgg_session_pass_cookie    text,
  bgg_last_login_at          timestamp with time zone,
  username                   text NOT NULL,
  bgg_last_sync_started_at   timestamp with time zone,
  avatar                     jsonb,
  needs_setup                boolean DEFAULT true NOT NULL,
  app_installed_at           timestamp with time zone,
  bgg_last_push_started_at   timestamp with time zone,
  bgg_last_check_started_at  timestamp with time zone,
  link_notifications_seen_at timestamp with time zone,
  push_tier                  text DEFAULT 'none'::text NOT NULL,
  release_notices_seen_at    timestamp with time zone DEFAULT now() NOT NULL,
  bga_username               text,
  bga_player_id              text,
  bga_password_enc           text,
  bga_session_cookies        jsonb,
  bga_session_expires_at     timestamp with time zone,
  bga_last_login_at          timestamp with time zone,
  bga_last_import_at         timestamp with time zone,
  CONSTRAINT boardgamebuddy_profiles_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_profiles_username_format CHECK ((username ~ '^[a-z0-9_]{3,30}$'::text)),
  CONSTRAINT boardgamebuddy_profiles_push_tier_check CHECK ((push_tier = ANY (ARRAY['none'::text, 'actionable'::text, 'all'::text])))
);
CREATE UNIQUE INDEX IF NOT EXISTS bgb_profiles_username_uk ON public.boardgamebuddy_profiles USING btree (username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_profiles_bga_username ON public.boardgamebuddy_profiles USING btree (lower(bga_username)) WHERE (bga_username IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_profiles_bgg_username ON public.boardgamebuddy_profiles USING btree (bgg_username) WHERE (bgg_username IS NOT NULL);
ALTER TABLE public.boardgamebuddy_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_profiles TO boardgamebuddy_role;
COMMENT ON COLUMN public.boardgamebuddy_profiles.avatar IS 'Badge config {icon, iconColor, bgColor}; icon is "initials" or an icon key. NULL = the default badge.';
COMMENT ON COLUMN public.boardgamebuddy_profiles.link_notifications_seen_at IS 'Read watermark for the whole notification bell (play links, buddy requests, accepted requests), despite the name.';
COMMENT ON COLUMN public.boardgamebuddy_profiles.push_tier IS 'none | actionable | all. Each tier includes the one before it.';
COMMENT ON COLUMN public.boardgamebuddy_profiles.bga_password_enc IS 'Encrypted with BGA_CREDENTIAL_KEY, a key separate from the BGG one.';

-- ── boardgamebuddy_bga_player_links ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_bga_player_links (
  id                  uuid DEFAULT gen_random_uuid() NOT NULL,
  owner_id            uuid NOT NULL,
  bga_handle          text NOT NULL,
  player_user_id      uuid,
  player_display_name text,
  created_at          timestamp with time zone DEFAULT now() NOT NULL,
  updated_at          timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_bga_player_links_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_bga_links_identity_chk CHECK (((player_user_id IS NOT NULL) OR (NULLIF(btrim(COALESCE(player_display_name, ''::text)), ''::text) IS NOT NULL))),
  CONSTRAINT bgb_bga_links_owner_fkey FOREIGN KEY (owner_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE,
  CONSTRAINT bgb_bga_links_player_fkey FOREIGN KEY (player_user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_bga_links_owner_handle ON public.boardgamebuddy_bga_player_links USING btree (owner_id, lower(bga_handle));
ALTER TABLE public.boardgamebuddy_bga_player_links ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_bga_player_links TO boardgamebuddy_role;
COMMENT ON TABLE public.boardgamebuddy_bga_player_links IS 'A Board Game Arena handle mapped by the owner to a person, used to pre-seat that handle on later imports.';

-- ── boardgamebuddy_bgg_pending_imports ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_bgg_pending_imports (
  id            uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id       uuid NOT NULL,
  bgg_id        integer NOT NULL,
  kind          text NOT NULL,
  payload       jsonb NOT NULL,
  status        text DEFAULT 'pending'::text NOT NULL,
  error_message text,
  attempts      integer DEFAULT 0 NOT NULL,
  created_at    timestamp with time zone DEFAULT now() NOT NULL,
  completed_at  timestamp with time zone,
  CONSTRAINT boardgamebuddy_bgg_pending_imports_pkey PRIMARY KEY (id),
  CONSTRAINT boardgamebuddy_bgg_pending_imports_kind_check CHECK ((kind = ANY (ARRAY['collection'::text, 'play'::text, 'catalog'::text]))),
  CONSTRAINT boardgamebuddy_bgg_pending_imports_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text, 'error'::text]))),
  CONSTRAINT boardgamebuddy_bgg_pending_imports_user_id_fkey FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_bgg_pending_unique ON public.boardgamebuddy_bgg_pending_imports USING btree (user_id, bgg_id, kind);
CREATE INDEX IF NOT EXISTS idx_bgb_bgg_pending_user_status ON public.boardgamebuddy_bgg_pending_imports USING btree (user_id, status) WHERE (status = 'pending'::text);
CREATE INDEX IF NOT EXISTS idx_bgb_pending_imports_user_created ON public.boardgamebuddy_bgg_pending_imports USING btree (user_id, created_at);
ALTER TABLE public.boardgamebuddy_bgg_pending_imports ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_bgg_pending_imports TO boardgamebuddy_role;

-- ── boardgamebuddy_bgg_push_queue ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_bgg_push_queue (
  id            uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id       uuid NOT NULL,
  bgg_id        integer NOT NULL,
  game_name     text NOT NULL,
  bgg_collid    bigint,
  change        text NOT NULL,
  target_status text,
  payload       jsonb NOT NULL,
  status        text DEFAULT 'pending'::text NOT NULL,
  attempts      integer DEFAULT 0 NOT NULL,
  error_message text,
  created_at    timestamp with time zone DEFAULT now() NOT NULL,
  completed_at  timestamp with time zone,
  CONSTRAINT boardgamebuddy_bgg_push_queue_pkey PRIMARY KEY (id),
  CONSTRAINT boardgamebuddy_bgg_push_queue_user_id_bgg_id_key UNIQUE (user_id, bgg_id),
  CONSTRAINT bgb_push_change_status CHECK ((((change = ANY (ARRAY['add'::text, 'update'::text])) AND (target_status IS NOT NULL)) OR ((change = 'clear'::text) AND (target_status IS NULL)))),
  CONSTRAINT boardgamebuddy_bgg_push_queue_change_check CHECK ((change = ANY (ARRAY['add'::text, 'update'::text, 'clear'::text]))),
  CONSTRAINT boardgamebuddy_bgg_push_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text, 'error'::text]))),
  CONSTRAINT boardgamebuddy_bgg_push_queue_target_status_check CHECK ((target_status = ANY (ARRAY['owned'::text, 'wishlist'::text, 'prev_owned'::text]))),
  CONSTRAINT boardgamebuddy_bgg_push_queue_user_id_fkey FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bgb_push_queue_user_created ON public.boardgamebuddy_bgg_push_queue USING btree (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bgb_push_queue_user_pending ON public.boardgamebuddy_bgg_push_queue USING btree (user_id, status) WHERE (status = 'pending'::text);
ALTER TABLE public.boardgamebuddy_bgg_push_queue ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_bgg_push_queue TO boardgamebuddy_role;

-- ── boardgamebuddy_buddies ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_buddies (
  id         uuid DEFAULT gen_random_uuid() NOT NULL,
  owner_id   uuid NOT NULL,
  name       text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT boardgamebuddy_buddies_pkey PRIMARY KEY (id),
  CONSTRAINT boardgamebuddy_buddies_owner_id_name_key UNIQUE (owner_id, name),
  CONSTRAINT boardgamebuddy_buddies_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
ALTER TABLE public.boardgamebuddy_buddies ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_buddies TO boardgamebuddy_role;

-- ── boardgamebuddy_buddy_edges ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_buddy_edges (
  id           uuid DEFAULT gen_random_uuid() NOT NULL,
  user_a       uuid NOT NULL,
  user_b       uuid NOT NULL,
  status       text NOT NULL,
  requested_by uuid NOT NULL,
  created_at   timestamp with time zone DEFAULT now() NOT NULL,
  accepted_at  timestamp with time zone,
  accepted_by  uuid,
  alias_by_a   text,
  alias_by_b   text,
  CONSTRAINT boardgamebuddy_buddy_edges_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_buddy_edges_canonical CHECK ((user_a < user_b)),
  CONSTRAINT boardgamebuddy_buddy_edges_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'blocked'::text]))),
  CONSTRAINT boardgamebuddy_buddy_edges_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES boardgamebuddy_profiles(id) ON DELETE SET NULL,
  CONSTRAINT boardgamebuddy_buddy_edges_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_buddy_edges_user_a_fkey FOREIGN KEY (user_a) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_buddy_edges_user_b_fkey FOREIGN KEY (user_b) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_buddy_edges_pair ON public.boardgamebuddy_buddy_edges USING btree (user_a, user_b);
CREATE INDEX IF NOT EXISTS idx_bgb_buddy_edges_user_a ON public.boardgamebuddy_buddy_edges USING btree (user_a, status);
CREATE INDEX IF NOT EXISTS idx_bgb_buddy_edges_user_b ON public.boardgamebuddy_buddy_edges USING btree (user_b, status);
ALTER TABLE public.boardgamebuddy_buddy_edges ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_buddy_edges TO boardgamebuddy_role;
COMMENT ON COLUMN public.boardgamebuddy_buddy_edges.alias_by_a IS 'Private nickname user_a gave user_b. Shown only to user_a.';
COMMENT ON COLUMN public.boardgamebuddy_buddy_edges.alias_by_b IS 'Private nickname user_b gave user_a. Shown only to user_b.';

-- ── boardgamebuddy_buddy_suggestion_dismissals ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_buddy_suggestion_dismissals (
  user_id           uuid NOT NULL,
  dismissed_user_id uuid NOT NULL,
  created_at        timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_buddy_suggestion_dismissals_pkey PRIMARY KEY (user_id, dismissed_user_id),
  CONSTRAINT bgb_suggestion_dismissals_not_self CHECK ((user_id <> dismissed_user_id)),
  CONSTRAINT bgb_suggestion_dismissals_dismissed_fkey FOREIGN KEY (dismissed_user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE,
  CONSTRAINT bgb_suggestion_dismissals_user_fkey FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
ALTER TABLE public.boardgamebuddy_buddy_suggestion_dismissals ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_buddy_suggestion_dismissals TO boardgamebuddy_role;

-- ── boardgamebuddy_collections ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_collections (
  id                     uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id                uuid NOT NULL,
  game_id                uuid NOT NULL,
  status                 text NOT NULL,
  added_at               timestamp with time zone DEFAULT now(),
  bgg_private_comment    text,
  bgg_acquired_from      text,
  bgg_acquisition_date   date,
  bgg_purchase_price     numeric(10,2),
  bgg_purchase_currency  text,
  bgg_inventory_location text,
  bgg_quantity           integer,
  game_name              text NOT NULL,
  game_thumbnail_url     text,
  game_year_published    integer,
  game_min_players       smallint,
  game_max_players       smallint,
  game_playing_time      smallint,
  game_is_expansion      boolean,
  game_base_game_bgg_id  integer,
  game_expansion_color   text,
  game_play_mode         text,
  game_bgg_id            integer,
  game_theme_color       text,
  played_before_at       timestamp with time zone,
  CONSTRAINT boardgamebuddy_collections_pkey PRIMARY KEY (id),
  CONSTRAINT boardgamebuddy_collections_user_id_game_id_key UNIQUE (user_id, game_id),
  CONSTRAINT boardgamebuddy_collections_status_check CHECK ((status = ANY (ARRAY['owned'::text, 'wishlist'::text, 'prev_owned'::text, 'played'::text]))),
  CONSTRAINT boardgamebuddy_collections_game_id_fkey FOREIGN KEY (game_id) REFERENCES boardgamebuddy_games(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_collections_user_id_fkey FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bgb_collections_game_user ON public.boardgamebuddy_collections USING btree (game_id, user_id);
CREATE INDEX IF NOT EXISTS idx_bgb_collections_user_status ON public.boardgamebuddy_collections USING btree (user_id, status, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_bgb_collections_user_status_name ON public.boardgamebuddy_collections USING btree (user_id, status, game_name);
ALTER TABLE public.boardgamebuddy_collections ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_collections TO boardgamebuddy_role;
COMMENT ON COLUMN public.boardgamebuddy_collections.played_before_at IS 'The played mark: played somewhere without logging it here. Never counted as a play. A game on no shelf carries it on a status ''played'' row.';

-- ── boardgamebuddy_feedback ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_feedback (
  id            uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id       uuid NOT NULL,
  feedback_type text NOT NULL,
  topic         text NOT NULL,
  body          text NOT NULL,
  status        text DEFAULT 'open'::text NOT NULL,
  resolved_by   uuid,
  resolved_at   timestamp with time zone,
  created_at    timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_feedback_pkey PRIMARY KEY (id),
  CONSTRAINT boardgamebuddy_feedback_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text]))),
  CONSTRAINT boardgamebuddy_feedback_feedback_type_fkey FOREIGN KEY (feedback_type) REFERENCES boardgamebuddy_feedback_types(id),
  CONSTRAINT boardgamebuddy_feedback_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES boardgamebuddy_profiles(id) ON DELETE SET NULL,
  CONSTRAINT boardgamebuddy_feedback_topic_fkey FOREIGN KEY (topic) REFERENCES boardgamebuddy_feedback_topics(id),
  CONSTRAINT boardgamebuddy_feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bgb_feedback_status_created ON public.boardgamebuddy_feedback USING btree (status, created_at DESC);
ALTER TABLE public.boardgamebuddy_feedback ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_feedback TO boardgamebuddy_role;

-- ── boardgamebuddy_feedback_likes ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_feedback_likes (
  feedback_id uuid NOT NULL,
  user_id     uuid NOT NULL,
  created_at  timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_feedback_likes_pkey PRIMARY KEY (feedback_id, user_id),
  CONSTRAINT boardgamebuddy_feedback_likes_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES boardgamebuddy_feedback(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_feedback_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
ALTER TABLE public.boardgamebuddy_feedback_likes ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_feedback_likes TO boardgamebuddy_role;

-- ── boardgamebuddy_game_ranks ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_game_ranks (
  user_id   uuid NOT NULL,
  game_id   uuid NOT NULL,
  category  text NOT NULL,
  tier      text NOT NULL,
  position  integer NOT NULL,
  ranked_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_game_ranks_pkey PRIMARY KEY (user_id, game_id),
  CONSTRAINT bgb_game_ranks_position_chk CHECK (("position" >= 0)),
  CONSTRAINT bgb_game_ranks_tier_chk CHECK ((tier = ANY (ARRAY['love'::text, 'good'::text, 'not'::text]))),
  CONSTRAINT boardgamebuddy_game_ranks_game_fkey FOREIGN KEY (game_id) REFERENCES boardgamebuddy_games(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_game_ranks_user_fkey FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bgb_game_ranks_list ON public.boardgamebuddy_game_ranks USING btree (user_id, category, tier, "position");
ALTER TABLE public.boardgamebuddy_game_ranks ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_game_ranks TO boardgamebuddy_role;
COMMENT ON TABLE public.boardgamebuddy_game_ranks IS 'Per player and category: tier love | good | not, position dense from 0 within a tier. Write only through bgb_rank_game / bgb_unrank_game.';

-- ── boardgamebuddy_ghost_claims ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_ghost_claims (
  id                 uuid DEFAULT gen_random_uuid() NOT NULL,
  owner_id           uuid NOT NULL,
  ghost_name_key     text NOT NULL,
  ghost_display_name text NOT NULL,
  claimant_id        uuid NOT NULL,
  status             text NOT NULL,
  rows_merged        integer,
  reject_count       integer DEFAULT 0 NOT NULL,
  created_at         timestamp with time zone DEFAULT now() NOT NULL,
  resolved_at        timestamp with time zone,
  CONSTRAINT boardgamebuddy_ghost_claims_pkey PRIMARY KEY (id),
  CONSTRAINT uq_bgb_ghost_claims_triple UNIQUE (owner_id, ghost_name_key, claimant_id),
  CONSTRAINT bgb_ghost_claims_key_normalized CHECK (((ghost_name_key = lower(btrim(ghost_name_key))) AND (ghost_name_key <> ''::text))),
  CONSTRAINT bgb_ghost_claims_not_self CHECK ((owner_id <> claimant_id)),
  CONSTRAINT boardgamebuddy_ghost_claims_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'dismissed'::text, 'superseded'::text]))),
  CONSTRAINT boardgamebuddy_ghost_claims_claimant_id_fkey FOREIGN KEY (claimant_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_ghost_claims_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bgb_ghost_claims_claimant ON public.boardgamebuddy_ghost_claims USING btree (claimant_id, status);
CREATE INDEX IF NOT EXISTS idx_bgb_ghost_claims_owner_pending ON public.boardgamebuddy_ghost_claims USING btree (owner_id) WHERE (status = 'pending'::text);
ALTER TABLE public.boardgamebuddy_ghost_claims ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_ghost_claims TO boardgamebuddy_role;

-- ── boardgamebuddy_guide_chapters ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_guide_chapters (
  id                uuid DEFAULT gen_random_uuid() NOT NULL,
  game_id           uuid NOT NULL,
  chapter_type      text NOT NULL,
  title             text NOT NULL,
  created_by        uuid,
  layout            text DEFAULT 'text'::text NOT NULL,
  content           text NOT NULL,
  created_at        timestamp with time zone DEFAULT now(),
  updated_at        timestamp with time zone DEFAULT now(),
  grid              jsonb,
  link_url          text,
  moderation_status text,
  moderated_by      uuid,
  moderated_at      timestamp with time zone,
  CONSTRAINT boardgamebuddy_guide_chunks_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_chapters_grid_mode CHECK (((grid IS NULL) OR ((grid -> 'mode'::text) IS NULL) OR (jsonb_typeof((grid -> 'mode'::text)) = 'null'::text) OR ((grid ->> 'mode'::text) = ANY (ARRAY['add_on'::text, 'replace'::text])))),
  CONSTRAINT bgb_chapters_grid_shape CHECK ((((layout = 'text'::text) AND (grid IS NULL)) OR ((layout = 'rulebook_link'::text) AND (grid IS NULL)) OR ((layout = 'scoring_grid'::text) AND (jsonb_typeof((grid -> 'rows'::text)) = 'array'::text) AND ((jsonb_array_length((grid -> 'rows'::text)) >= 1) AND (jsonb_array_length((grid -> 'rows'::text)) <= 24))))),
  CONSTRAINT bgb_chapters_link_shape CHECK ((((layout = 'rulebook_link'::text) AND (link_url IS NOT NULL) AND (link_url ~* '^https?://[^[:space:]]+$'::text) AND (moderation_status IS NOT NULL) AND (moderation_status = ANY (ARRAY['unlisted'::text, 'pending'::text, 'approved'::text, 'denied'::text]))) OR ((layout <> 'rulebook_link'::text) AND (link_url IS NULL) AND (moderation_status IS NULL)))),
  CONSTRAINT boardgamebuddy_guide_chunks_layout_check CHECK ((layout = ANY (ARRAY['text'::text, 'scoring_grid'::text, 'rulebook_link'::text]))),
  CONSTRAINT bgb_chapters_moderated_by_fkey FOREIGN KEY (moderated_by) REFERENCES boardgamebuddy_profiles(id) ON DELETE SET NULL,
  CONSTRAINT boardgamebuddy_guide_chunks_chunk_type_fkey FOREIGN KEY (chapter_type) REFERENCES boardgamebuddy_chapter_types(id),
  CONSTRAINT boardgamebuddy_guide_chunks_created_by_fkey FOREIGN KEY (created_by) REFERENCES boardgamebuddy_profiles(id) ON DELETE SET NULL,
  CONSTRAINT boardgamebuddy_guide_chunks_game_id_fkey FOREIGN KEY (game_id) REFERENCES boardgamebuddy_games(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bgb_chapters_game_type ON public.boardgamebuddy_guide_chapters USING btree (game_id, chapter_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_chapters_rulebook_author ON public.boardgamebuddy_guide_chapters USING btree (game_id, created_by) WHERE (layout = 'rulebook_link'::text);
CREATE INDEX IF NOT EXISTS idx_bgb_chapters_rulebook_status ON public.boardgamebuddy_guide_chapters USING btree (moderation_status, created_at) WHERE (layout = 'rulebook_link'::text);
CREATE INDEX IF NOT EXISTS idx_bgb_chapters_scoring_grid ON public.boardgamebuddy_guide_chapters USING btree (game_id) WHERE (layout = 'scoring_grid'::text);
ALTER TABLE public.boardgamebuddy_guide_chapters ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_guide_chapters TO boardgamebuddy_role;
COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.grid IS 'Rows of a layout=''scoring_grid'' chapter: {"v":1,"mode":…,"rows":[{"label":…,"color":…,"note":…}]}. color is a palette slug, never a hex.';
COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.moderation_status IS 'Rulebook links only. approved: everyone sees it; unlisted and pending: the author and their accepted buddies; denied: the author. pending also means it is in the admin queue.';

-- ── boardgamebuddy_chapter_reports ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_chapter_reports (
  id          uuid DEFAULT gen_random_uuid() NOT NULL,
  chapter_id  uuid NOT NULL,
  reporter_id uuid NOT NULL,
  reason      text,
  status      text DEFAULT 'open'::text NOT NULL,
  resolved_by uuid,
  resolved_at timestamp with time zone,
  created_at  timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_chapter_reports_pkey PRIMARY KEY (id),
  CONSTRAINT boardgamebuddy_chapter_reports_chapter_id_reporter_id_key UNIQUE (chapter_id, reporter_id),
  CONSTRAINT boardgamebuddy_chapter_reports_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text]))),
  CONSTRAINT boardgamebuddy_chapter_reports_chapter_id_fkey FOREIGN KEY (chapter_id) REFERENCES boardgamebuddy_guide_chapters(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_chapter_reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_chapter_reports_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES boardgamebuddy_profiles(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_bgb_chapter_reports_status ON public.boardgamebuddy_chapter_reports USING btree (status, created_at);
ALTER TABLE public.boardgamebuddy_chapter_reports ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_chapter_reports TO boardgamebuddy_role;

-- ── boardgamebuddy_plays ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_plays (
  id                  uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id             uuid NOT NULL,
  game_id             uuid NOT NULL,
  played_at           date DEFAULT CURRENT_DATE NOT NULL,
  notes               text,
  bgg_play_id         bigint,
  created_at          timestamp with time zone DEFAULT now(),
  photo_url           text,
  play_mode           text DEFAULT 'competitive'::text NOT NULL,
  game_name           text NOT NULL,
  game_thumbnail_url  text,
  client_key          uuid,
  country_code        text,
  import_group_id     uuid,
  import_batch_id     uuid,
  imported_at         timestamp with time zone,
  scoring_template    jsonb,
  bga_table_id        bigint,
  inherited_at        timestamp with time zone,
  inherited_from_name text,
  CONSTRAINT boardgamebuddy_plays_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_plays_country_code_chk CHECK (((country_code IS NULL) OR (country_code ~ '^[A-Z]{2}$'::text))),
  CONSTRAINT boardgamebuddy_plays_play_mode_check CHECK ((play_mode = ANY (ARRAY['competitive'::text, 'coop'::text, 'team'::text]))),
  CONSTRAINT boardgamebuddy_plays_game_id_fkey FOREIGN KEY (game_id) REFERENCES boardgamebuddy_games(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_plays_user_id_fkey FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_plays_client_key ON public.boardgamebuddy_plays USING btree (user_id, client_key) WHERE (client_key IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_country_game ON public.boardgamebuddy_plays USING btree (country_code, game_id) WHERE (country_code IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_game_played ON public.boardgamebuddy_plays USING btree (game_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_import_batch ON public.boardgamebuddy_plays USING btree (user_id, import_batch_id) WHERE (import_batch_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_import_group ON public.boardgamebuddy_plays USING btree (import_group_id, id) WHERE (import_group_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_inherited ON public.boardgamebuddy_plays USING btree (user_id, inherited_at DESC) WHERE (inherited_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_played_at ON public.boardgamebuddy_plays USING btree (played_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_plays_user_bga_table ON public.boardgamebuddy_plays USING btree (user_id, bga_table_id) WHERE (bga_table_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_plays_user_bgg_play ON public.boardgamebuddy_plays USING btree (user_id, bgg_play_id) WHERE (bgg_play_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bgb_plays_user_played ON public.boardgamebuddy_plays USING btree (user_id, played_at DESC, created_at DESC);
ALTER TABLE public.boardgamebuddy_plays ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_plays TO boardgamebuddy_role;
COMMENT ON COLUMN public.boardgamebuddy_plays.client_key IS 'Client-generated idempotency key for plays queued offline.';
COMMENT ON COLUMN public.boardgamebuddy_plays.scoring_template IS 'Snapshot of the scoring grid the play was scored with. Deliberately not a foreign key: editing or deleting the chapter never relabels an old play.';
COMMENT ON COLUMN public.boardgamebuddy_plays.inherited_at IS 'Set when the play passed to its current owner because the account that logged it was deleted. When set, user_id is not the author.';

-- ── boardgamebuddy_play_expansions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_expansions (
  play_id           uuid NOT NULL,
  expansion_game_id uuid NOT NULL,
  CONSTRAINT boardgamebuddy_play_expansions_pkey PRIMARY KEY (play_id, expansion_game_id),
  CONSTRAINT boardgamebuddy_play_expansions_expansion_game_id_fkey FOREIGN KEY (expansion_game_id) REFERENCES boardgamebuddy_games(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_play_expansions_play_id_fkey FOREIGN KEY (play_id) REFERENCES boardgamebuddy_plays(id) ON DELETE CASCADE
);
ALTER TABLE public.boardgamebuddy_play_expansions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_play_expansions TO boardgamebuddy_role;

-- ── boardgamebuddy_play_players ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_players (
  id                  uuid DEFAULT gen_random_uuid() NOT NULL,
  play_id             uuid NOT NULL,
  is_winner           boolean DEFAULT false,
  score               integer,
  player_user_id      uuid,
  player_display_name text,
  round_scores        jsonb,
  linked_at           timestamp with time zone DEFAULT now() NOT NULL,
  team                text,
  CONSTRAINT boardgamebuddy_play_players_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_play_players_identity_chk CHECK (((player_user_id IS NOT NULL) OR (player_display_name IS NOT NULL))),
  CONSTRAINT bgb_play_players_team_len_chk CHECK (((team IS NULL) OR (char_length(team) <= 16))),
  CONSTRAINT boardgamebuddy_play_players_play_id_fkey FOREIGN KEY (play_id) REFERENCES boardgamebuddy_plays(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_play_players_player_user_id_fkey FOREIGN KEY (player_user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_bgb_play_players_display_name_trgm ON public.boardgamebuddy_play_players USING gin (player_display_name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_bgb_play_players_play ON public.boardgamebuddy_play_players USING btree (play_id);
CREATE INDEX IF NOT EXISTS idx_bgb_play_players_user_linked ON public.boardgamebuddy_play_players USING btree (player_user_id, linked_at DESC) WHERE (player_user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bgb_play_players_user_play ON public.boardgamebuddy_play_players USING btree (player_user_id, play_id) WHERE (player_user_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bgb_play_players_play_user ON public.boardgamebuddy_play_players USING btree (play_id, player_user_id) WHERE (player_user_id IS NOT NULL);
ALTER TABLE public.boardgamebuddy_play_players ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_play_players TO boardgamebuddy_role;
COMMENT ON COLUMN public.boardgamebuddy_play_players.round_scores IS 'Per-round scores as a JSON array of nullable ints; score holds the total.';
COMMENT ON COLUMN public.boardgamebuddy_play_players.team IS 'Free-text side, as the host typed it. Compared case-insensitively after trimming.';

-- ── boardgamebuddy_play_reactions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_reactions (
  play_id           uuid NOT NULL,
  user_id           uuid NOT NULL,
  reaction_group_id uuid DEFAULT gen_random_uuid() NOT NULL,
  created_at        timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_play_reactions_pkey PRIMARY KEY (play_id, user_id),
  CONSTRAINT boardgamebuddy_play_reactions_play_id_fkey FOREIGN KEY (play_id) REFERENCES boardgamebuddy_plays(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_play_reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bgb_play_reactions_group ON public.boardgamebuddy_play_reactions USING btree (reaction_group_id);
CREATE INDEX IF NOT EXISTS idx_bgb_play_reactions_user ON public.boardgamebuddy_play_reactions USING btree (user_id);
ALTER TABLE public.boardgamebuddy_play_reactions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_play_reactions TO boardgamebuddy_role;
COMMENT ON TABLE public.boardgamebuddy_play_reactions IS 'One tap on a night''s footer writes a row for every play of that night, all sharing one reaction_group_id.';

-- ── boardgamebuddy_play_sessions ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_sessions (
  id                uuid DEFAULT gen_random_uuid() NOT NULL,
  code              text NOT NULL,
  host_user_id      uuid NOT NULL,
  game_id           uuid,
  status            text DEFAULT 'open'::text NOT NULL,
  finalized_play_id uuid,
  created_at        timestamp with time zone DEFAULT now() NOT NULL,
  expires_at        timestamp with time zone DEFAULT (now() + '02:00:00'::interval) NOT NULL,
  finalized_at      timestamp with time zone,
  phase             text DEFAULT 'gather'::text NOT NULL,
  scoring_template  jsonb,
  play_mode         text,
  CONSTRAINT boardgamebuddy_play_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_play_sessions_play_mode_chk CHECK (((play_mode IS NULL) OR (play_mode = ANY (ARRAY['competitive'::text, 'coop'::text, 'team'::text])))),
  CONSTRAINT boardgamebuddy_play_sessions_phase_check CHECK ((phase = ANY (ARRAY['gather'::text, 'play'::text, 'settle'::text, 'finalized'::text, 'abandoned'::text]))),
  CONSTRAINT boardgamebuddy_play_sessions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'finalized'::text, 'abandoned'::text]))),
  CONSTRAINT boardgamebuddy_play_sessions_finalized_play_id_fkey FOREIGN KEY (finalized_play_id) REFERENCES boardgamebuddy_plays(id) ON DELETE SET NULL,
  CONSTRAINT boardgamebuddy_play_sessions_game_id_fkey FOREIGN KEY (game_id) REFERENCES boardgamebuddy_games(id) ON DELETE SET NULL,
  CONSTRAINT boardgamebuddy_play_sessions_host_user_id_fkey FOREIGN KEY (host_user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bgb_play_sessions_expires ON public.boardgamebuddy_play_sessions USING btree (expires_at) WHERE (status = 'open'::text);
CREATE INDEX IF NOT EXISTS idx_bgb_play_sessions_host ON public.boardgamebuddy_play_sessions USING btree (host_user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_play_sessions_open_code ON public.boardgamebuddy_play_sessions USING btree (code) WHERE (status = 'open'::text);
ALTER TABLE public.boardgamebuddy_play_sessions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_play_sessions TO boardgamebuddy_role;
COMMENT ON COLUMN public.boardgamebuddy_play_sessions.play_mode IS 'How this table is being scored (competitive | coop | team); NULL = competitive. Can differ from boardgamebuddy_games.play_mode, which is what the box suggests.';

-- ── boardgamebuddy_play_session_participants ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_session_participants (
  id           uuid DEFAULT gen_random_uuid() NOT NULL,
  session_id   uuid NOT NULL,
  user_id      uuid,
  display_name text NOT NULL,
  joined_at    timestamp with time zone DEFAULT now() NOT NULL,
  position     smallint,
  team         text,
  CONSTRAINT boardgamebuddy_play_session_participants_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_play_session_participants_team_len_chk CHECK (((team IS NULL) OR (char_length(team) <= 16))),
  CONSTRAINT boardgamebuddy_play_session_participants_session_id_fkey FOREIGN KEY (session_id) REFERENCES boardgamebuddy_play_sessions(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_play_session_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_play_session_guest_unique ON public.boardgamebuddy_play_session_participants USING btree (session_id, lower(display_name)) WHERE (user_id IS NULL);
CREATE INDEX IF NOT EXISTS idx_bgb_play_session_participants_session ON public.boardgamebuddy_play_session_participants USING btree (session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_play_session_user_unique ON public.boardgamebuddy_play_session_participants USING btree (session_id, user_id) WHERE (user_id IS NOT NULL);
ALTER TABLE public.boardgamebuddy_play_session_participants ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_play_session_participants TO boardgamebuddy_role;
COMMENT ON COLUMN public.boardgamebuddy_play_session_participants.team IS 'Free-text side, as the host typed it. Compared case-insensitively after trimming.';

-- ── boardgamebuddy_play_session_scores ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_session_scores (
  session_id     uuid NOT NULL,
  round_index    smallint NOT NULL,
  score          integer,
  participant_id uuid NOT NULL,
  CONSTRAINT boardgamebuddy_play_session_scores_pkey PRIMARY KEY (session_id, participant_id, round_index),
  CONSTRAINT boardgamebuddy_play_session_scores_round_index_check CHECK (((round_index >= 0) AND (round_index < 64))),
  CONSTRAINT boardgamebuddy_play_session_scores_participant_id_fkey FOREIGN KEY (participant_id) REFERENCES boardgamebuddy_play_session_participants(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_play_session_scores_session_id_fkey FOREIGN KEY (session_id) REFERENCES boardgamebuddy_play_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bgb_play_session_scores_session ON public.boardgamebuddy_play_session_scores USING btree (session_id, round_index);
ALTER TABLE public.boardgamebuddy_play_session_scores ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_play_session_scores TO boardgamebuddy_role;

-- ── boardgamebuddy_play_session_viewers ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_session_viewers (
  session_id    uuid NOT NULL,
  user_id       uuid NOT NULL,
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_play_session_viewers_pkey PRIMARY KEY (session_id, user_id),
  CONSTRAINT boardgamebuddy_play_session_viewers_session_id_fkey FOREIGN KEY (session_id) REFERENCES boardgamebuddy_play_sessions(id) ON DELETE CASCADE
);
ALTER TABLE public.boardgamebuddy_play_session_viewers ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_play_session_viewers TO boardgamebuddy_role;

-- ── boardgamebuddy_push_subscriptions ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_push_subscriptions (
  id              uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id         uuid NOT NULL,
  endpoint        text NOT NULL,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  user_agent      text,
  created_at      timestamp with time zone DEFAULT now() NOT NULL,
  last_success_at timestamp with time zone,
  failure_count   integer DEFAULT 0 NOT NULL,
  CONSTRAINT boardgamebuddy_push_subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT boardgamebuddy_push_subscriptions_endpoint_key UNIQUE (endpoint),
  CONSTRAINT boardgamebuddy_push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bgb_push_subs_user ON public.boardgamebuddy_push_subscriptions USING btree (user_id);
ALTER TABLE public.boardgamebuddy_push_subscriptions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_push_subscriptions TO boardgamebuddy_role;

-- ── boardgamebuddy_rank_deferrals ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_rank_deferrals (
  user_id     uuid NOT NULL,
  game_id     uuid NOT NULL,
  deferred_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_rank_deferrals_pkey PRIMARY KEY (user_id, game_id),
  CONSTRAINT boardgamebuddy_rank_deferrals_game_fkey FOREIGN KEY (game_id) REFERENCES boardgamebuddy_games(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_rank_deferrals_user_fkey FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
ALTER TABLE public.boardgamebuddy_rank_deferrals ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_rank_deferrals TO boardgamebuddy_role;
COMMENT ON TABLE public.boardgamebuddy_rank_deferrals IS 'Games a player chose to rank after their next play. bgb_rank_deferrals_active says which still hold.';

-- ── boardgamebuddy_release_notices ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_release_notices (
  id           uuid DEFAULT gen_random_uuid() NOT NULL,
  title        text NOT NULL,
  body_md      text NOT NULL,
  link_route   text,
  link_label   text,
  published_at timestamp with time zone,
  created_by   uuid,
  created_at   timestamp with time zone DEFAULT now() NOT NULL,
  updated_at   timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_release_notices_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_release_notices_created_by_fkey FOREIGN KEY (created_by) REFERENCES boardgamebuddy_profiles(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_bgb_release_notices_published ON public.boardgamebuddy_release_notices USING btree (published_at DESC) WHERE (published_at IS NOT NULL);
ALTER TABLE public.boardgamebuddy_release_notices ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_release_notices TO boardgamebuddy_role;
COMMENT ON COLUMN public.boardgamebuddy_release_notices.published_at IS 'NULL = draft.';

-- ── boardgamebuddy_user_achievements ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_user_achievements (
  user_id        uuid NOT NULL,
  achievement_id text NOT NULL,
  unlocked_at    timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_user_achievements_pkey PRIMARY KEY (user_id, achievement_id),
  CONSTRAINT boardgamebuddy_user_achievements_achievement_id_fkey FOREIGN KEY (achievement_id) REFERENCES boardgamebuddy_achievements(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_user_achievements_user_id_fkey FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
ALTER TABLE public.boardgamebuddy_user_achievements ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_user_achievements TO boardgamebuddy_role;

-- ── boardgamebuddy_user_chapters ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_user_chapters (
  id         uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id    uuid NOT NULL,
  game_id    uuid NOT NULL,
  chapter_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  state      text DEFAULT 'kept'::text NOT NULL,
  CONSTRAINT boardgamebuddy_guide_selections_pkey PRIMARY KEY (id),
  CONSTRAINT boardgamebuddy_guide_selections_user_id_chunk_id_key UNIQUE (user_id, chapter_id),
  CONSTRAINT bgb_user_chapters_state_chk CHECK ((state = ANY (ARRAY['kept'::text, 'disliked'::text]))),
  CONSTRAINT boardgamebuddy_guide_selections_chunk_id_fkey FOREIGN KEY (chapter_id) REFERENCES boardgamebuddy_guide_chapters(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_guide_selections_game_id_fkey FOREIGN KEY (game_id) REFERENCES boardgamebuddy_games(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_guide_selections_user_id_fkey FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bgb_user_chapters_chapter ON public.boardgamebuddy_user_chapters USING btree (chapter_id);
CREATE INDEX IF NOT EXISTS idx_bgb_user_chapters_disliked ON public.boardgamebuddy_user_chapters USING btree (user_id, game_id) WHERE (state = 'disliked'::text);
CREATE INDEX IF NOT EXISTS idx_bgb_user_chapters_user_game ON public.boardgamebuddy_user_chapters USING btree (user_id, game_id);
ALTER TABLE public.boardgamebuddy_user_chapters ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_user_chapters TO boardgamebuddy_role;
COMMENT ON COLUMN public.boardgamebuddy_user_chapters.state IS 'kept = in the viewer''s guide; disliked = turned down, and left out of their chapter pool.';

-- ── boardgamebuddy_user_expansions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_user_expansions (
  user_id           uuid NOT NULL,
  expansion_game_id uuid NOT NULL,
  CONSTRAINT boardgamebuddy_user_expansions_pkey PRIMARY KEY (user_id, expansion_game_id),
  CONSTRAINT boardgamebuddy_user_expansions_expansion_game_id_fkey FOREIGN KEY (expansion_game_id) REFERENCES boardgamebuddy_games(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_user_expansions_user_id_fkey FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
ALTER TABLE public.boardgamebuddy_user_expansions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_user_expansions TO boardgamebuddy_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Functions the policies call
-- ─────────────────────────────────────────────────────────────────────────────
-- bgb_app_uid()
CREATE OR REPLACE FUNCTION public.bgb_app_uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
           WHEN coalesce(auth.jwt() ->> 'app_uid', '') ~*
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN (auth.jwt() ->> 'app_uid')::uuid
           WHEN coalesce(auth.jwt() ->> 'sub', '') ~*
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN (auth.jwt() ->> 'sub')::uuid
           ELSE NULL
         END
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_app_uid() TO boardgamebuddy_role;
COMMENT ON FUNCTION public.bgb_app_uid() IS 'The UUID the app knows the caller by: the app_uid JWT claim, else a UUID-shaped sub, else NULL.';


-- ─────────────────────────────────────────────────────────────────────────────
-- Row-level security policies (7)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS bgb_play_sessions_select ON public.boardgamebuddy_play_sessions;
CREATE POLICY bgb_play_sessions_select ON public.boardgamebuddy_play_sessions
  FOR SELECT TO authenticated
  USING (((host_user_id = ( SELECT bgb_app_uid() AS bgb_app_uid)) OR (EXISTS ( SELECT 1
   FROM boardgamebuddy_play_session_participants p
  WHERE ((p.session_id = boardgamebuddy_play_sessions.id) AND (p.user_id = ( SELECT bgb_app_uid() AS bgb_app_uid))))) OR (EXISTS ( SELECT 1
   FROM boardgamebuddy_play_session_viewers v
  WHERE ((v.session_id = boardgamebuddy_play_sessions.id) AND (v.user_id = ( SELECT bgb_app_uid() AS bgb_app_uid)))))));

DROP POLICY IF EXISTS bgb_play_session_participants_select_self ON public.boardgamebuddy_play_session_participants;
CREATE POLICY bgb_play_session_participants_select_self ON public.boardgamebuddy_play_session_participants
  FOR SELECT TO authenticated
  USING ((user_id = ( SELECT bgb_app_uid() AS bgb_app_uid)));

DROP POLICY IF EXISTS bgb_session_scores_delete ON public.boardgamebuddy_play_session_scores;
CREATE POLICY bgb_session_scores_delete ON public.boardgamebuddy_play_session_scores
  FOR DELETE TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM boardgamebuddy_play_sessions s
  WHERE ((s.id = boardgamebuddy_play_session_scores.session_id) AND (s.phase = 'play'::text) AND (s.host_user_id = ( SELECT bgb_app_uid() AS bgb_app_uid))))));

DROP POLICY IF EXISTS bgb_session_scores_insert ON public.boardgamebuddy_play_session_scores;
CREATE POLICY bgb_session_scores_insert ON public.boardgamebuddy_play_session_scores
  FOR INSERT TO authenticated
  WITH CHECK ((EXISTS ( SELECT 1
   FROM boardgamebuddy_play_sessions s
  WHERE ((s.id = boardgamebuddy_play_session_scores.session_id) AND (s.phase = 'play'::text) AND (s.host_user_id = ( SELECT bgb_app_uid() AS bgb_app_uid))))));

DROP POLICY IF EXISTS bgb_session_scores_select ON public.boardgamebuddy_play_session_scores;
CREATE POLICY bgb_session_scores_select ON public.boardgamebuddy_play_session_scores
  FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM boardgamebuddy_play_sessions s
  WHERE ((s.id = boardgamebuddy_play_session_scores.session_id) AND ((s.host_user_id = ( SELECT bgb_app_uid() AS bgb_app_uid)) OR (EXISTS ( SELECT 1
           FROM boardgamebuddy_play_session_participants p
          WHERE ((p.session_id = s.id) AND (p.user_id = ( SELECT bgb_app_uid() AS bgb_app_uid))))) OR (EXISTS ( SELECT 1
           FROM boardgamebuddy_play_session_viewers v
          WHERE ((v.session_id = s.id) AND (v.user_id = ( SELECT bgb_app_uid() AS bgb_app_uid))))))))));

DROP POLICY IF EXISTS bgb_session_scores_update ON public.boardgamebuddy_play_session_scores;
CREATE POLICY bgb_session_scores_update ON public.boardgamebuddy_play_session_scores
  FOR UPDATE TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM boardgamebuddy_play_sessions s
  WHERE ((s.id = boardgamebuddy_play_session_scores.session_id) AND (s.phase = 'play'::text) AND (s.host_user_id = ( SELECT bgb_app_uid() AS bgb_app_uid))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM boardgamebuddy_play_sessions s
  WHERE ((s.id = boardgamebuddy_play_session_scores.session_id) AND (s.phase = 'play'::text) AND (s.host_user_id = ( SELECT bgb_app_uid() AS bgb_app_uid))))));

DROP POLICY IF EXISTS bgb_play_session_viewers_select_self ON public.boardgamebuddy_play_session_viewers;
CREATE POLICY bgb_play_session_viewers_select_self ON public.boardgamebuddy_play_session_viewers
  FOR SELECT TO authenticated
  USING ((user_id = ( SELECT bgb_app_uid() AS bgb_app_uid)));


-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime publication
-- ─────────────────────────────────────────────────────────────────────────────
-- Guarded: a plain Postgres database has no supabase_realtime publication.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                        AND tablename = 'boardgamebuddy_play_session_scores') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.boardgamebuddy_play_session_scores;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                        AND tablename = 'boardgamebuddy_play_sessions') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.boardgamebuddy_play_sessions;
  END IF;
END $$;
