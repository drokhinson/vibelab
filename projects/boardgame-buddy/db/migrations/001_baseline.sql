-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy 001 — baseline: tables, functions, policies
--
-- The end state of the 58 migrations in archive/2026-09-28/,
-- squashed on 2026-09-28 by .claude/skills/squash-migrations/squash.py: they
-- were replayed into an empty database and this file was read back out of
-- its catalog. A database built from this file and 002_seed.sql diffs clean
-- against that replay (pg_dump of the schema, ACLs, policies and seed rows).
--
-- Left out of the replay as data-only (a no-op on an empty database): 036_r2_photo_urls.sql
--
-- FRESH-DB ONLY. Production is already at this state. Do not run it there.
--
-- Replayed on top of, so run those first: db/migrations/_shared/001_analytics.sql,
--   db/migrations/_shared/004_api_logs.sql,
--   db/migrations/_shared/005_api_sessions.sql,
--   db/migrations/_shared/006_drop_api_sessions.sql
--
-- 39 tables, 72 functions, 7 RLS policies. Tables are in foreign-key
-- order and functions come callees-first, so the file runs top to bottom.
-- Each object names the archived migrations that shaped it; their
-- comments are the design record and are not repeated here.
--
-- Grants are written as the difference from Supabase's defaults, which give
-- anon, authenticated and service_role everything on a new table or function
-- (and EXECUTE to PUBLIC). An object with no GRANT/REVOKE lines keeps them.
-- Function bodies are pg_get_functiondef() output, the server's normalized
-- rendering, not the archive's hand-written text.
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
-- shaped by archive/2026-09-28/: 001_baseline.sql
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
-- shaped by archive/2026-09-28/: 001_baseline.sql,
--   019_scoring_grid_achievements.sql, 034_team_coop_win_achievements.sql
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
-- shaped by archive/2026-09-28/: 046_affiliate_partners.sql
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
COMMENT ON TABLE public.boardgamebuddy_affiliate_partners IS 'Retailers a game page can link to. live = enabled AND (tracking_tag OR wrapper_template): a row with neither credential never renders, enabled or not. Edited only through /affiliate/admin/*; read by GET /affiliate/links.';
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.url_template IS 'The store URL with {query} (the game name, URL-encoded) and optionally {tag} (tracking_tag). Resolved server-side by affiliate_service.build_url.';
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.wrapper_template IS 'Optional network redirect wrapped around the resolved store URL, with {url} = that URL percent-encoded (Impact: https://x.sjv.io/c/A/B/C?u={url}). Counts as a credential for the live rule.';
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.tracking_tag IS 'The value for {tag}. Counts as a credential for the live rule. NULL until the program approves the account.';
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.disclosure IS 'A sentence the program requires beside its links (Amazon''s "As an Amazon Associate…"). Rendered under the pills only while the partner is live.';
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.notes IS 'Operator hint shown in the admin editor: what to paste where. Never rendered to readers.';

-- ── boardgamebuddy_bgg_hot_snapshots ─────────────────────────────────────────
-- shaped by archive/2026-09-28/: 039_bgg_hot_snapshots.sql
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
COMMENT ON TABLE public.boardgamebuddy_bgg_hot_snapshots IS 'BGG /hot?type=boardgame, one row per (run, game). captured_at is the run id — every row of one refresh shares it. Kept 30 days. Read by bgb_bgg_hot_latest(); joined to the catalog by bgg_id at read time, never by a stored game_id.';

-- ── boardgamebuddy_bgg_thumb_cache ───────────────────────────────────────────
-- shaped by archive/2026-09-28/: 054_bgg_image_links.sql
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_bgg_thumb_cache (
  bgg_id        integer NOT NULL,
  thumbnail_url text,
  fetched_at    timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_bgg_thumb_cache_pkey PRIMARY KEY (bgg_id)
);
ALTER TABLE public.boardgamebuddy_bgg_thumb_cache ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.boardgamebuddy_bgg_thumb_cache IS 'BGG thumbnail per bgg_id for BGG search results (migration 054). NULL thumbnail_url = BGG has none. Not a catalog: a game here is not imported. Written and read only by the API (service role).';

-- ── boardgamebuddy_chapter_types ─────────────────────────────────────────────
-- shaped by archive/2026-09-28/: 001_baseline.sql
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
-- shaped by archive/2026-09-28/: 001_baseline.sql
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_countries (
  code      text NOT NULL,
  continent text NOT NULL,
  CONSTRAINT boardgamebuddy_countries_pkey PRIMARY KEY (code),
  CONSTRAINT boardgamebuddy_countries_code_check CHECK ((code ~ '^[A-Z]{2}$'::text)),
  CONSTRAINT boardgamebuddy_countries_continent_check CHECK ((continent = ANY (ARRAY['AF'::text, 'AN'::text, 'AS'::text, 'EU'::text, 'NA'::text, 'OC'::text, 'SA'::text])))
);
ALTER TABLE public.boardgamebuddy_countries ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_countries TO boardgamebuddy_role;
COMMENT ON TABLE public.boardgamebuddy_countries IS 'ISO 3166-1 alpha-2 → continent, for the location achievements (migration 068). The code set is exactly the one web/domain/geo-data.js can produce, so no country the app can detect or offer is missing a continent.';

-- ── boardgamebuddy_feedback_topics ───────────────────────────────────────────
-- shaped by archive/2026-09-28/: 041_dev_feedback.sql
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_feedback_topics (
  id            text NOT NULL,
  label         text NOT NULL,
  icon          text,
  display_order integer DEFAULT 0,
  CONSTRAINT boardgamebuddy_feedback_topics_pkey PRIMARY KEY (id)
);
ALTER TABLE public.boardgamebuddy_feedback_topics ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_feedback_topics TO boardgamebuddy_role;
COMMENT ON TABLE public.boardgamebuddy_feedback_topics IS 'Lookup for boardgamebuddy_feedback.topic — which surface of the app an item is about. Seeded here (041); the set mirrors the bottom nav plus the two header screens. `icon` is a Lucide slug into web/ui/icons.js. Served by GET /feedback-topics.';

-- ── boardgamebuddy_feedback_types ────────────────────────────────────────────
-- shaped by archive/2026-09-28/: 041_dev_feedback.sql
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_feedback_types (
  id            text NOT NULL,
  label         text NOT NULL,
  icon          text,
  display_order integer DEFAULT 0,
  CONSTRAINT boardgamebuddy_feedback_types_pkey PRIMARY KEY (id)
);
ALTER TABLE public.boardgamebuddy_feedback_types ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_feedback_types TO boardgamebuddy_role;
COMMENT ON TABLE public.boardgamebuddy_feedback_types IS 'Lookup for boardgamebuddy_feedback.feedback_type. Seeded here (041). `icon` is a Lucide slug into web/ui/icons.js, never an emoji. Served by GET /feedback-types and denormalised onto every row bgb_feedback_list returns, so the list paints from one call.';

-- ── boardgamebuddy_games ─────────────────────────────────────────────────────
-- shaped by archive/2026-09-28/: 001_baseline.sql, 038_discover.sql,
--   040_game_publishers.sql, 045_bgg_meta_sync.sql, 054_bgg_image_links.sql,
--   056_game_ranks.sql
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
COMMENT ON COLUMN public.boardgamebuddy_games.rulebook_url IS 'LEGACY as of migration 052, and left in place only because forty RPCs and bundles select it. It was the admin-curated rulebook link, written by PATCH /games/admin/{id}/rulebook-url — an endpoint that no longer exists — and every value in it was backfilled into an approved layout=''rulebook_link'' chapter by 052. Nothing in the app reads it any more. Do not wire anything new to it and do not treat it as a second source of truth for a game''s rulebook; the chapters table is the one.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_rating IS 'BGG geek rating (statistics/ratings/bayesaverage), 1..10. NULL = never synced or unrated. Written by POST /games/admin/backfill-stats.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_rank IS 'BGG overall board game rank (statistics/ratings/ranks/rank[@name=boardgame]). NULL = "Not Ranked" or never synced.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_weight IS 'BGG complexity (statistics/ratings/averageweight), 1..5.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_owned_count IS 'How many BGG users list the game as owned (statistics/ratings/owned).';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_stats_synced_at IS 'When the BGG rating/rank/weight last landed (migration 038). No longer a queue marker — 045 moved that to bgg_meta_synced_at — but still written by every sync.';
COMMENT ON COLUMN public.boardgamebuddy_games.publishers IS 'BGG boardgamepublisher links, in BGG''s order. ''{}'' = BGG credits nobody. NULL no longer means "never synced" (045 moved that to bgg_meta_synced_at); readers coerce both to [].';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_meta_synced_at IS 'When POST /games/admin/backfill-metadata last read BGG''s /thing?stats=1 record for this game (migration 045). NULL with a non-null bgg_id IS the backfill queue. Stamped even when BGG had no description or no year, so the queue terminates — the panel keeps listing those rows from the field predicate instead.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_image_url IS 'BoardGameGeek''s own box-art URL (migration 054), recorded next to the re-hosted image_url so the app can switch to serving BGG directly. Written by import, image refresh and POST /games/admin/backfill-image-links.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_thumbnail_url IS 'BoardGameGeek''s own thumbnail URL (migration 054); see bgg_image_url.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_images_synced_at IS 'When BGG''s image URLs were last read for this game (migration 054). NULL with a non-null bgg_id IS the image-links backfill queue. Stamped even when BGG has no art, so the queue terminates.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_family IS 'The BGG family rank list this game ranks highest in, raw (strategygames, familygames, partygames, thematic, wargames, abstracts, childrensgames, cgs). NULL = not synced yet, or BGG files it in none. Decides which category a game is ranked in (migration 056). Written by import, refresh-metadata and backfill-metadata.';

-- ── boardgamebuddy_affiliate_clicks ──────────────────────────────────────────
-- shaped by archive/2026-09-28/: 046_affiliate_partners.sql
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
COMMENT ON TABLE public.boardgamebuddy_affiliate_clicks IS 'One row per tap on a partner pill. No user column, by design: privacy §5 says usage records carry no account identifier. Written by POST /affiliate/click, summarised by GET /affiliate/admin/clicks.';

-- ── boardgamebuddy_profiles ──────────────────────────────────────────────────
-- shaped by archive/2026-09-28/: 001_baseline.sql, 006_bgg_check_session.sql,
--   008_link_notifications.sql, 017_push_notifications.sql,
--   035_drop_profiles_auth_users_fk.sql, 042_release_notices.sql,
--   043_bga_import.sql
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
COMMENT ON COLUMN public.boardgamebuddy_profiles.avatar IS 'Customizable badge config: {icon, iconColor, bgColor}. icon is "initials" or an icon key from the client library. NULL = use BGB default (brown badge + gold initials).';
COMMENT ON COLUMN public.boardgamebuddy_profiles.needs_setup IS 'TRUE for brand-new accounts that have not yet completed the "Create your profile" modal. Cleared by the first successful POST /profile.';
COMMENT ON COLUMN public.boardgamebuddy_profiles.app_installed_at IS 'First time this account was seen running as an installed PWA (migration 062). Drives the "Pocket Buddy" achievement; nothing else reads it.';
COMMENT ON COLUMN public.boardgamebuddy_profiles.bgg_last_check_started_at IS 'Stamped at the top of POST /bgg/check. Anchors the catalog_session_* counters on bgb_bgg_sync_status, which count kind=''catalog'' rows only.';
COMMENT ON COLUMN public.boardgamebuddy_profiles.link_notifications_seen_at IS 'Read watermark for the WHOLE notification bell — plays you were seated in, buddy requests received, and requests of yours that were accepted — not just link notifications, despite the name. Written by bgb_mark_link_notifications_seen; read by bgb_notifications and bgb_notifications_unread (migration 009).';
COMMENT ON COLUMN public.boardgamebuddy_profiles.push_tier IS 'How much this account wants pushed: none | actionable | all. Cumulative — all implies actionable. Mirrored by PushTier in the backend constants; the DB values ARE the enum values. Default none: push is opt-in, and a migration that turned it on for every existing account would be a notification nobody asked for.';
COMMENT ON COLUMN public.boardgamebuddy_profiles.release_notices_seen_at IS 'Watermark: release notices published at or before this are not shown again. NOT NULL DEFAULT now() so a new account starts watermarked at signup and never sees the backlog, and so existing rows were watermarked at migration time. Advanced only by bgb_mark_release_notices_seen; read by bgb_release_notices_unseen.';
COMMENT ON COLUMN public.boardgamebuddy_profiles.bga_password_enc IS 'Fernet-encrypted BGA password, keyed by BGA_CREDENTIAL_KEY. Its own key, not BGG_CREDENTIAL_KEY: rotating one must not force a re-link of the other. Rotating THIS one forces every BGA re-link.';
COMMENT ON COLUMN public.boardgamebuddy_profiles.bga_session_cookies IS 'Opaque BGA session cookies, whatever names the login returns. Never carried by a response model and never logged.';

-- ── boardgamebuddy_bga_player_links ──────────────────────────────────────────
-- shaped by archive/2026-09-28/: 043_bga_import.sql
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
COMMENT ON TABLE public.boardgamebuddy_bga_player_links IS 'Board Game Arena handle → the person the owner says it is (migration 043). Written by the import wizard when a handle is resolved by hand, read on the next import to pre-seat it. No API-role grant: only the service role touches it.';

-- ── boardgamebuddy_bgg_pending_imports ───────────────────────────────────────
-- shaped by archive/2026-09-28/: 001_baseline.sql
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
-- shaped by archive/2026-09-28/: 001_baseline.sql
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
-- shaped by archive/2026-09-28/: 001_baseline.sql
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
-- shaped by archive/2026-09-28/: 001_baseline.sql,
--   009_unified_notifications.sql, 012_buddy_aliases.sql
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
COMMENT ON COLUMN public.boardgamebuddy_buddy_edges.alias_by_a IS 'Private nickname user_a set FOR user_b. Read only when the viewer is user_a; never returned to user_b. NULL = no alias — the endpoint trims and treats empty as a clear, so '''' never reaches the row.';
COMMENT ON COLUMN public.boardgamebuddy_buddy_edges.alias_by_b IS 'Private nickname user_b set FOR user_a. Mirror of alias_by_a; see that column. Which of the pair applies is decided by the viewer, not by the row.';

-- ── boardgamebuddy_buddy_suggestion_dismissals ───────────────────────────────
-- shaped by archive/2026-09-28/: 014_buddy_suggestion_dismissals.sql
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
COMMENT ON TABLE public.boardgamebuddy_buddy_suggestion_dismissals IS 'Per-viewer "stop suggesting this person". Read by the three suggestion RPCs below; never shown to dismissed_user_id and never a block. Cleared when the viewer sends that person a buddy request, so an accidental tap is undone by the act that contradicts it.';

-- ── boardgamebuddy_collections ───────────────────────────────────────────────
-- shaped by archive/2026-09-28/: 001_baseline.sql, 057_played_mark.sql
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
COMMENT ON COLUMN public.boardgamebuddy_collections.played_before_at IS 'The played mark: set when the user says they played this game somewhere they did not log it. On a row of any status, independent of it; a game on no shelf carries it on a status ''played'' row (057). Read by the Played shelf, the status map''s played_marks, the Shelf of Shame block of bgb_user_stats_detail and the rank queue. It is not a play and must never be counted as one.';

-- ── boardgamebuddy_feedback ──────────────────────────────────────────────────
-- shaped by archive/2026-09-28/: 041_dev_feedback.sql
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
COMMENT ON TABLE public.boardgamebuddy_feedback IS 'The Dev feedback board: one row per item a user submitted from Settings → Dev feedback. status=open is what every non-admin sees; resolving hides it from them and leaves it visible to admins under the Resolved filter, which is why resolve is reversible and nothing is deleted. Ordered for display by like count DESC then created_at DESC — see bgb_feedback_list.';
COMMENT ON COLUMN public.boardgamebuddy_feedback.resolved_by IS 'The admin who resolved it. ON DELETE SET NULL rather than CASCADE: a deleted admin account must not take the resolution with it — the item stays resolved, it just stops naming who did it.';

-- ── boardgamebuddy_feedback_likes ────────────────────────────────────────────
-- shaped by archive/2026-09-28/: 041_dev_feedback.sql
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
COMMENT ON TABLE public.boardgamebuddy_feedback_likes IS 'One row per (feedback item, person). The composite PK is both the identity and the idempotency guarantee, so POST /feedback/{id}/like upserts ignore_duplicates and returns 200 rather than 201. Counts are aggregated in bgb_feedback_list, never stored on the item.';

-- ── boardgamebuddy_game_ranks ────────────────────────────────────────────────
-- shaped by archive/2026-09-28/: 056_game_ranks.sql
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
COMMENT ON TABLE public.boardgamebuddy_game_ranks IS 'A player''s ranking of the games they own or have played (migration 056). Per category, tiers love → good → not, position dense 0..n-1 within a tier. Written only through bgb_rank_game / bgb_unrank_game; read by GET /ranks*.';

-- ── boardgamebuddy_ghost_claims ──────────────────────────────────────────────
-- shaped by archive/2026-09-28/: 001_baseline.sql
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
-- shaped by archive/2026-09-28/: 001_baseline.sql, 018_scoring_templates.sql,
--   032_expansion_scoring_modes.sql, 052_rulebook_links.sql,
--   053_rulebook_review_optional.sql
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
COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.grid IS 'Row definitions for a layout=''scoring_grid'' chapter: {"v":1,"mode":…,"rows":[{"label":…,"color":…,"note":…}]}. `color` is a SLUG from a fixed palette (neutral|red|pink|rust|brown|gold|yellow|green|blue|purple), never a hex — the grid lands on the cream scorepad, and only a fixed palette can be guaranteed legible there in both themes. `mode` (migration 032) is add_on|replace on a grid whose game is an EXPANSION — its rows either join the base game''s grid or stand in for it — and NULL/absent on a base game''s own grid, where the question does not arise. The API resolves it (services/chapter_grid.resolve_grid_mode); the bgb_chapters_grid_mode CHECK only pins the value domain, because a CHECK cannot look up whether the chapter''s game is an expansion. NULL for layout=''text''; see the bgb_chapters_grid_shape constraint.';
COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.link_url IS 'The outbound rulebook URL of a layout=''rulebook_link'' chapter. http(s) only, pinned by bgb_chapters_link_shape — this is a link the app sends readers to, so the scheme is not left to the client. NULL for every other layout. `content` carries a generated markdown mirror ("[Rulebook](url)") so the pool''s ILIKE search, the moderation preview and renderMarkdown need no branch; `link_url` is the source of truth and the mirror is derived from it.';
COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.moderation_status IS 'unlisted | pending | approved | denied, on a layout=''rulebook_link'' chapter only (NULL everywhere else). Approved is visible to everyone; unlisted and pending only to the author and their ACCEPTED buddies; denied only to the author and admins. Unlisted and pending differ in ONE respect and it is not visibility: pending is in the admin queue because its author asked for review (migration 053''s toggle), unlisted is not. A link authored by an admin is NOT born approved — as of 053 every author goes through the same gate, and an admin approves their own from the queue like anyone else''s. The rule is applied by routes/services/chapter_rulebook.py on every chapter read path, NOT by RLS — this API is service-role and bypasses RLS, and nothing reads chapters browser-direct. A denial is deliberately not a delete: the row is what stops the same author re-posting the same link past idx_bgb_chapters_rulebook_author.';
COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.moderated_by IS 'The admin whose decision moderation_status records. NULL while unlisted or pending — including on a link an admin wrote themselves, which as of migration 053 is not self-approved on the way in — and NULL on the rows migration 052 backfilled out of boardgamebuddy_games.rulebook_url, which were approved by having been admin-only data in the first place. Naming an admin who never looked at a link would be a lie the audit trail cannot tell apart from a real decision, which is also why re-opening the gate (a changed URL, a withdrawn request) clears this column rather than leaving the last decision''s author on a row nobody has decided.';

-- ── boardgamebuddy_chapter_reports ───────────────────────────────────────────
-- shaped by archive/2026-09-28/: 001_baseline.sql
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
-- shaped by archive/2026-09-28/: 001_baseline.sql, 005_play_import_groups.sql,
--   007_play_import_batches.sql, 018_scoring_templates.sql,
--   043_bga_import.sql, 051_account_deletion_handover.sql
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
COMMENT ON COLUMN public.boardgamebuddy_plays.bgg_play_id IS 'The BoardGameGeek play id this row came from. Written by the importer''s BoardGameGeek source (through bgb_log_play, migration 044) and by the pending-imports worker still draining kind=''play'' rows queued before it. The partial UNIQUE idx_bgb_plays_user_bgg_play is what makes re-importing from BGG a no-op.';
COMMENT ON COLUMN public.boardgamebuddy_plays.client_key IS 'Client-generated idempotency key for offline-queued plays. NULL for live writes.';
COMMENT ON COLUMN public.boardgamebuddy_plays.country_code IS 'ISO 3166-1 alpha-2 country where the play happened, uppercase. Resolved by the client from the device timezone (or picked by the host in Settle Up); NULL when unknown, and NULL on every row predating migration 065. Feeds a future popularity-by-country view and nothing today.';
COMMENT ON COLUMN public.boardgamebuddy_plays.scoring_template IS 'Denormalised snapshot of the scoring grid this play was scored with: {"v":1,"chapter_id":…,"title":…,"rows":[…],"parts":[…]}. NOT a foreign key, on purpose. The chapter is community-owned, editable by its author and deletable by author or admin, so a play holding only an id would render bare R1..Rn the moment a moderator cleared the chapter, and would silently RELABEL a two-year-old play if the author reordered its rows — labels that stop describing the numbers under them is precisely the failure widgets/round-score-grid.js is written to prevent. ON DELETE SET NULL loses the labels and CASCADE deletes plays, so neither constraint tells the truth. chapter_id rides INSIDE the document as provenance: a bare uuid column would imply an integrity the database is not enforcing. Same reasoning as game_name / game_thumbnail_url on this table. `rows` may be COMPOSED from several grids (migration 032) — a base game''s plus each add-on expansion''s, the add-ons appended in ascending BGG id so every client composes the same scorepad — in which case `chapter_id` names the grid that supplied the leading rows and `parts` lists every contributor in row order as {chapter_id,game_id,game_name,mode,row_count}. A row an add-on contributed also carries that expansion''s `source_color` (boardgamebuddy_games.expansion_color), which draws a rule down the RIGHT edge of its header cell — the left edge carries the row''s own palette tint, so the two never collide; the leading grid''s rows carry none. `parts` is absent, and no row carries a source_color, when one grid supplied the whole thing — so a pre-032 snapshot reads exactly as it always did.';
COMMENT ON COLUMN public.boardgamebuddy_plays.bga_table_id IS 'The Board Game Arena table this play was imported from (migration 043). NULL for every other origin. Unique per user, which is what makes a re-import offer only new tables.';
COMMENT ON COLUMN public.boardgamebuddy_plays.inherited_at IS 'When this play changed hands because its logger deleted their account (migration 051). NULL on every play whose author still owns it, which is almost all of them. Two jobs: it drives the play_inherited notification, and it is the standing audit trail for "the current owner did not write this" — worth knowing before trusting plays.user_id as authorship.';
COMMENT ON COLUMN public.boardgamebuddy_plays.inherited_from_name IS 'The display name of the account this play came from, captured at deletion (migration 051). Denormalized because the profile it names is gone by the time anything reads this — there is nothing left to join to. Carried into bgb_notifications as actor_display_name.';

-- ── boardgamebuddy_play_expansions ───────────────────────────────────────────
-- shaped by archive/2026-09-28/: 001_baseline.sql
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
-- shaped by archive/2026-09-28/: 001_baseline.sql, 008_link_notifications.sql,
--   048_play_teams.sql
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
COMMENT ON COLUMN public.boardgamebuddy_play_players.round_scores IS 'Per-round score breakdown as a JSON array of nullable ints, e.g. [5, 8, null, 12]. NULL when no rounds were tracked (<= 1 round). The `score` column still holds the final total for backward compatibility and quick aggregation.';
COMMENT ON COLUMN public.boardgamebuddy_play_players.team IS 'Free-text side this seat played on, as the host typed it (migration 048). NULL for every competitive and co-op play, and for a team play whose sides were never named. Matched case-insensitively after trimming — the same comparison PlaySession.applyTeamTag uses to keep one side''s win flags in step — so "Red" and "red" are one side. No index: it is only ever read as part of a roster already fetched by play_id.';
COMMENT ON INDEX public.uq_bgb_play_players_play_user IS 'One account, one seat, per play (migration 023). Ghost seats (player_user_id NULL) are outside the predicate — two same-named ghosts at one table is a legitimate roster.';

-- ── boardgamebuddy_play_reactions ────────────────────────────────────────────
-- shaped by archive/2026-09-28/: 016_play_reactions.sql
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
COMMENT ON TABLE public.boardgamebuddy_play_reactions IS 'One "good game" from one person to one play. A session footer tap fans out to every play in that night sharing one reaction_group_id, because the feed session is a client-side grouping with no stable id — see migration 016.';

-- ── boardgamebuddy_play_sessions ─────────────────────────────────────────────
-- shaped by archive/2026-09-28/: 001_baseline.sql, 018_scoring_templates.sql,
--   050_session_participant_teams.sql
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
COMMENT ON COLUMN public.boardgamebuddy_play_sessions.scoring_template IS 'The template the host applied to this live grid, same shape as boardgamebuddy_plays.scoring_template — composed parts and all. Copied onto the play at finalize.';
COMMENT ON COLUMN public.boardgamebuddy_play_sessions.play_mode IS 'How the host is scoring this table: competitive / coop / team (migration 050). NULL = never said, read as competitive. Not the same fact as boardgamebuddy_games.play_mode, which is what the BOX suggests; this is what the table actually did, and it is the gate on whether a spectator''s grid merges a side''s seats into one column.';

-- ── boardgamebuddy_play_session_participants ─────────────────────────────────
-- shaped by archive/2026-09-28/: 001_baseline.sql,
--   050_session_participant_teams.sql
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
COMMENT ON COLUMN public.boardgamebuddy_play_session_participants.position IS 'Host-assigned column order, 0-based. NULL = never ordered; see bgb_session_bundle''s (position NULLS LAST, joined_at) sort.';
COMMENT ON COLUMN public.boardgamebuddy_play_session_participants.team IS 'Free-text side this seat is on, as the host typed it (migration 050). NULL means no side — every competitive and co-op lobby, and a team lobby whose sides were never named. Matched case-insensitively after trimming, the same comparison ui/team-colors.js and PlaySession.applyTeamTag use, so "Red" and "red" are one side. The lobby twin of boardgamebuddy_play_players.team (migration 048), which is where the tag lands for good at finalize; this column only has to outlive the session.';

-- ── boardgamebuddy_play_session_scores ───────────────────────────────────────
-- shaped by archive/2026-09-28/: 001_baseline.sql
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
-- shaped by archive/2026-09-28/: 027_session_viewers.sql
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
-- shaped by archive/2026-09-28/: 017_push_notifications.sql
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
COMMENT ON TABLE public.boardgamebuddy_push_subscriptions IS 'One Web Push subscription per browser per account. Written by POST /push/subscriptions, read by services/push_service when fanning a notification out, and deleted on a 404/410 from the push service. No Data API grant: only the service-role backend touches it.';

-- ── boardgamebuddy_rank_deferrals ────────────────────────────────────────────
-- shaped by archive/2026-09-28/: 058_rank_deferrals.sql
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
COMMENT ON TABLE public.boardgamebuddy_rank_deferrals IS 'Unranked games a player chose to rank after their next play (migration 058). Active until a play the player can see is created after deferred_at and played on or after its date — see bgb_rank_deferrals_active. Written by PUT /ranks/games/{id}/defer, deleted when the game is ranked.';

-- ── boardgamebuddy_release_notices ───────────────────────────────────────────
-- shaped by archive/2026-09-28/: 042_release_notices.sql
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
COMMENT ON TABLE public.boardgamebuddy_release_notices IS 'Admin-authored "what''s new" notes shown once per user in a popup on their next visit. Written from /admin/release-notices; read by bgb_release_notices_unseen (the popup) and GET /release-notices (the Settings archive).';
COMMENT ON COLUMN public.boardgamebuddy_release_notices.body_md IS 'Markdown, rendered by web/ui/markdown.js — which escapes first and allows only http(s), mailto and root-relative hrefs. Note that renderer opens every link in a new tab, so an in-app destination belongs in link_route, not in a markdown link here.';
COMMENT ON COLUMN public.boardgamebuddy_release_notices.link_route IS 'Optional router route name for the "take me there" button (web/domain/view.js _routes). Plain TEXT, not an enum: the backend has no route table, so any server-side enum would be a copy that drifts the first time a route is renamed. The admin picker offers only param-free routes and both render paths drop the button when router.pathFor() cannot build a URL, which also covers a route retired after the notice was written.';
COMMENT ON COLUMN public.boardgamebuddy_release_notices.published_at IS 'NULL = draft, never sent. Set by POST /release-notices/admin/{id}/publish and never by the client, because a backdated timestamp would sort behind watermarks users already hold and be invisible to exactly the people it was written for. Republishing moves it forward, so an unpublish/republish cycle re-shows the notice.';
COMMENT ON COLUMN public.boardgamebuddy_release_notices.created_by IS 'ON DELETE SET NULL, not CASCADE: deleting an admin''s account must not delete the notices everyone else is still reading.';

-- ── boardgamebuddy_user_achievements ─────────────────────────────────────────
-- shaped by archive/2026-09-28/: 001_baseline.sql
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
-- shaped by archive/2026-09-28/: 001_baseline.sql, 033_chapter_dislikes.sql
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
COMMENT ON COLUMN public.boardgamebuddy_user_chapters.state IS 'kept = in this viewer''s guide (what a row meant before migration 033). disliked = the inverse: the viewer has turned it down, so it is filtered out of their chapter pool, their pool count and the scoring-template offer, and appears only in the builder''s Disliked section. Per-viewer and one-directional — never shown to the author, never a report, and it changes no count anyone else sees.';

-- ── boardgamebuddy_user_expansions ───────────────────────────────────────────
-- shaped by archive/2026-09-28/: 001_baseline.sql
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
-- Functions (72)
-- ─────────────────────────────────────────────────────────────────────────────

-- bgb_admin_usage_stats(p_exclude_admins boolean)
--   last defined in archive/2026-09-28/055_usage_exclude_admins.sql
CREATE OR REPLACE FUNCTION public.bgb_admin_usage_stats(p_exclude_admins boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH
-- The accounts to leave out: every admin when asked, nobody otherwise.
excluded AS (
  SELECT id FROM boardgamebuddy_profiles WHERE p_exclude_admins AND is_admin
),
excluded_txt AS (
  SELECT id::text AS id FROM excluded
),
-- ── Accounts ────────────────────────────────────────────────────────────────
user_counts AS (
  SELECT jsonb_build_object(
    'total',        COUNT(*) FILTER (WHERE NOT kept_out),
    'new_24h',      COUNT(*) FILTER (WHERE NOT kept_out AND created_at >= now() - interval '24 hours'),
    'new_7d',       COUNT(*) FILTER (WHERE NOT kept_out AND created_at >= now() - interval '7 days'),
    'new_30d',      COUNT(*) FILTER (WHERE NOT kept_out AND created_at >= now() - interval '30 days'),
    -- Always the full count, filtered or not: it is how the screen says how
    -- many accounts the filter left out.
    'admins',       COUNT(*) FILTER (WHERE is_admin),
    'bgg_linked',   COUNT(*) FILTER (WHERE NOT kept_out AND bgg_username IS NOT NULL),
    'first_signup', MIN(created_at) FILTER (WHERE NOT kept_out)
  ) AS j
  FROM (
    SELECT p.*, (p_exclude_admins AND p.is_admin) AS kept_out
    FROM boardgamebuddy_profiles p
  ) prof
),
push AS (
  SELECT COUNT(DISTINCT user_id) AS n FROM boardgamebuddy_push_subscriptions
  WHERE user_id NOT IN (SELECT id FROM excluded)
),
-- ── Active accounts, from the request log ───────────────────────────────────
-- Scoped to this app: api_logs is cross-app.
logs AS (
  SELECT user_id, sent_at
  FROM api_logs
  WHERE app = 'boardgame-buddy' AND user_id IS NOT NULL
    AND user_id::text NOT IN (SELECT id FROM excluded_txt)
),
active AS (
  SELECT jsonb_build_object(
    'dau', COUNT(DISTINCT user_id::text) FILTER (WHERE sent_at >= now() - interval '24 hours'),
    'wau', COUNT(DISTINCT user_id::text) FILTER (WHERE sent_at >= now() - interval '7 days'),
    'mau', COUNT(DISTINCT user_id::text) FILTER (WHERE sent_at >= now() - interval '30 days')
  ) AS j
  FROM logs
),
-- The oldest row in the WHOLE app's log, not just the authenticated slice:
-- it dates the instrumentation, which is what stops a short history reading
-- as low usage.
sample AS (
  SELECT MIN(sent_at) AS oldest FROM api_logs WHERE app = 'boardgame-buddy'
),
-- A row per calendar day for the strip chart. generate_series so a day with
-- nobody on it is a zero rather than a missing bar — a gap would draw as a
-- narrower chart, not as a quiet Tuesday.
days AS (
  SELECT (now()::date - offs) AS day
  FROM generate_series(0, 29) AS g(offs)
),
daily AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object('day', d.day, 'users', c.n) ORDER BY d.day), '[]'::jsonb) AS j
  FROM days d
  LEFT JOIN LATERAL (
    SELECT COUNT(DISTINCT l.user_id::text) AS n
    FROM logs l
    WHERE l.sent_at >= d.day::timestamptz
      AND l.sent_at <  (d.day + 1)::timestamptz
  ) c ON TRUE
),
-- ── Postgres footprint ──────────────────────────────────────────────────────
tbl AS (
  SELECT
    c.relname::text                  AS table_name,
    pg_total_relation_size(c.oid)    AS total_bytes,
    GREATEST(c.reltuples, 0)::bigint AS row_estimate
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND (c.relname LIKE 'boardgamebuddy\_%' OR c.relname IN ('analytics_events', 'api_logs'))
),
db_size AS (
  SELECT jsonb_build_object(
    'total_bytes', COALESCE(SUM(total_bytes), 0),
    'tables', COALESCE(jsonb_agg(
      jsonb_build_object(
        'table_name',   table_name,
        'total_bytes',  total_bytes,
        'row_estimate', row_estimate
      ) ORDER BY total_bytes DESC
    ), '[]'::jsonb)
  ) AS j
  FROM tbl
),
-- ── Screens and the rest of the event mix ───────────────────────────────────
ev AS (
  SELECT event, created_at FROM analytics_events
  WHERE app = 'boardgame-buddy'
    -- metadata.admin is stamped by the client (web/domain/api.js) from 055 on;
    -- older rows have no stamp and are always counted.
    AND NOT (p_exclude_admins AND COALESCE(metadata->>'admin', '') = 'true')
),
ev_rolled AS (
  SELECT
    event,
    COUNT(*)                                                               AS all_time,
    COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')       AS last_30d,
    COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')        AS last_7d,
    COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')      AS last_24h
  FROM ev
  GROUP BY event
),
screens AS (
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      -- The route name, not the raw event: the UI titles it, and 'view:' on
      -- every row is twelve wasted characters of a 480px column.
      'screen',   substring(event from 6),
      'all_time', all_time, 'last_30d', last_30d,
      'last_7d',  last_7d,  'last_24h', last_24h
    ) ORDER BY all_time DESC
  ), '[]'::jsonb) AS j
  FROM ev_rolled WHERE event LIKE 'view:%'
),
event_mix AS (
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'event',    event,
      'all_time', all_time, 'last_30d', last_30d,
      'last_7d',  last_7d,  'last_24h', last_24h
    ) ORDER BY all_time DESC
  ), '[]'::jsonb) AS j
  FROM ev_rolled WHERE event NOT LIKE 'view:%'
),
-- ── What people actually make ───────────────────────────────────────────────
-- One row per feature, each counted over the same four windows, so the UI
-- renders them as one table and the segmented control only switches column.
--
-- EVERY FEATURE NAMES ITS OWN CLOCK COLUMN. Three of these tables have no
-- created_at at all — a session seat has joined_at, a shelf entry added_at, an
-- achievement unlocked_at — and a buddy link's accepted_at is NULL until it is
-- accepted, which is exactly the filter "links made" wants, so it needs no
-- guess at the status vocabulary. Ghost claims are counted as RAISED
-- (created_at) rather than resolved, for the same reason.
--
-- The clock is when somebody used the app, never the domain date: plays are
-- counted by created_at, not played_at, or a play logged today about last
-- Christmas would land in no window anybody is looking at.
--
-- The features list is a VALUES join rather than a GROUP BY alone so a feature
-- nobody has used yet renders as a zero instead of vanishing from the table.
domain_counts AS (
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'feature',  f.feature,
      'all_time', COALESCE(c.all_time, 0), 'last_30d', COALESCE(c.last_30d, 0),
      'last_7d',  COALESCE(c.last_7d, 0),  'last_24h', COALESCE(c.last_24h, 0)
    ) ORDER BY f.ord
  ), '[]'::jsonb) AS j
  FROM (VALUES
    ( 1, 'Plays logged'),
    ( 2, 'Plays with a photo'),
    ( 3, 'Live sessions hosted'),
    ( 4, 'Seats at a live session'),
    ( 5, 'Guide chapters written'),
    ( 6, 'Chapters saved to a guide'),
    ( 7, 'Reactions'),
    ( 8, 'Shelf entries'),
    ( 9, 'Buddy links accepted'),
    (10, 'Ghost claims raised'),
    (11, 'Achievements unlocked'),
    (12, 'Feedback posted'),
    (13, 'Games added to the catalog')
  ) AS f(ord, feature)
  LEFT JOIN (
    SELECT
      ord,
      COUNT(*)                                                             AS all_time,
      COUNT(*) FILTER (WHERE happened_at >= now() - interval '30 days')    AS last_30d,
      COUNT(*) FILTER (WHERE happened_at >= now() - interval '7 days')     AS last_7d,
      COUNT(*) FILTER (WHERE happened_at >= now() - interval '24 hours')   AS last_24h
    FROM (
                SELECT  1 AS ord, created_at  AS happened_at, user_id      AS who FROM boardgamebuddy_plays
      UNION ALL SELECT  2,        created_at,               user_id             FROM boardgamebuddy_plays WHERE photo_url IS NOT NULL
      UNION ALL SELECT  3,        created_at,               host_user_id        FROM boardgamebuddy_play_sessions
      UNION ALL SELECT  4,        joined_at,                user_id             FROM boardgamebuddy_play_session_participants
      UNION ALL SELECT  5,        created_at,               created_by          FROM boardgamebuddy_guide_chapters
      UNION ALL SELECT  6,        created_at,               user_id             FROM boardgamebuddy_user_chapters
      UNION ALL SELECT  7,        created_at,               user_id             FROM boardgamebuddy_play_reactions
      UNION ALL SELECT  8,        added_at,                 user_id             FROM boardgamebuddy_collections
      UNION ALL SELECT  9,        accepted_at,              accepted_by         FROM boardgamebuddy_buddy_edges WHERE accepted_at IS NOT NULL
      UNION ALL SELECT 10,        created_at,               claimant_id         FROM boardgamebuddy_ghost_claims
      UNION ALL SELECT 11,        unlocked_at,              user_id             FROM boardgamebuddy_user_achievements
      UNION ALL SELECT 12,        created_at,               user_id             FROM boardgamebuddy_feedback
      -- No column says who added a game, so the catalog count is never filtered.
      UNION ALL SELECT 13,        created_at,               NULL::uuid          FROM boardgamebuddy_games
    ) src
    -- NULL `who` (a guest seat, an ownerless chapter, a game) is never an
    -- admin, and NOT IN against a NULL would drop it, hence the IS NULL arm.
    WHERE who IS NULL OR who NOT IN (SELECT id FROM excluded)
    GROUP BY ord
  ) c ON c.ord = f.ord
),
-- ── Where plays come from ───────────────────────────────────────────────────
-- Derived, and THE ORDER MATTERS: there is no source column on
-- boardgamebuddy_plays, and a BGG- or BGA-imported play carries an
-- import_batch_id too, so the batch test has to come last or it would swallow
-- both integrations.
origins AS (
  SELECT
    CASE
      WHEN bgg_play_id     IS NOT NULL THEN 1
      WHEN bga_table_id    IS NOT NULL THEN 2
      WHEN import_batch_id IS NOT NULL THEN 3
      ELSE 4
    END AS ord,
    created_at
  FROM boardgamebuddy_plays
  WHERE user_id NOT IN (SELECT id FROM excluded)
),
play_origins AS (
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'origin',   o.origin,
      'all_time', COALESCE(c.all_time, 0), 'last_30d', COALESCE(c.last_30d, 0),
      'last_7d',  COALESCE(c.last_7d, 0),  'last_24h', COALESCE(c.last_24h, 0)
    ) ORDER BY o.ord
  ), '[]'::jsonb) AS j
  FROM (VALUES
    (1, 'BoardGameGeek'),
    (2, 'Board Game Arena'),
    (3, 'Notes or photos import'),
    (4, 'Logged by hand')
  ) AS o(ord, origin)
  LEFT JOIN (
    SELECT ord,
           COUNT(*)                                                           AS all_time,
           COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')    AS last_30d,
           COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')     AS last_7d,
           COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')   AS last_24h
    FROM origins GROUP BY ord
  ) c ON c.ord = o.ord
)
SELECT jsonb_build_object(
  'generated_at',  now(),
  'exclude_admins', p_exclude_admins,
  'users',         (SELECT j FROM user_counts) || jsonb_build_object('push_enabled', (SELECT n FROM push)),
  'active',        (SELECT j FROM active)
                     || jsonb_build_object('daily', (SELECT j FROM daily))
                     || jsonb_build_object('oldest_sample_at', (SELECT oldest FROM sample)),
  'database',      (SELECT j FROM db_size),
  'screens',       (SELECT j FROM screens),
  'events',        (SELECT j FROM event_mix),
  'domain',        (SELECT j FROM domain_counts),
  'play_origins',  (SELECT j FROM play_origins)
);
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_admin_usage_stats(p_exclude_admins boolean) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.bgb_admin_usage_stats(p_exclude_admins boolean) IS 'App-wide usage for the admin Usage spoke: accounts, active accounts (from api_logs), Postgres footprint, screen views, domain counters, play origins. p_exclude_admins leaves out is_admin accounts from every per-account figure. Read by GET /api/v1/boardgame_buddy/admin/usage.';

-- bgb_app_uid()
--   last defined in archive/2026-09-28/037_app_uid_claim.sql
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
COMMENT ON FUNCTION public.bgb_app_uid() IS 'The UUID the app knows this caller by: the app_uid claim, else a UUID-shaped sub, else NULL. See db/migrations/037_app_uid_claim.sql.';

-- bgb_bgg_hot_latest()
--   last defined in archive/2026-09-28/039_bgg_hot_snapshots.sql
CREATE OR REPLACE FUNCTION public.bgb_bgg_hot_latest()
 RETURNS TABLE(bgg_id integer, rank integer, name text, year_published integer, thumbnail_url text, prev_rank integer, rank_delta integer, is_new boolean, captured_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH latest AS (
  SELECT MAX(s.captured_at) AS at FROM public.boardgamebuddy_bgg_hot_snapshots s
),
prev AS (
  SELECT MAX(s.captured_at) AS at
    FROM public.boardgamebuddy_bgg_hot_snapshots s, latest
   WHERE s.captured_at <= latest.at - INTERVAL '20 hours'
)
SELECT cur.bgg_id,
       cur.rank,
       cur.name,
       cur.year_published,
       cur.thumbnail_url,
       p.rank                                            AS prev_rank,
       CASE WHEN p.rank IS NULL THEN NULL ELSE p.rank - cur.rank END AS rank_delta,
       (prev.at IS NOT NULL AND p.rank IS NULL)          AS is_new,
       cur.captured_at
  FROM public.boardgamebuddy_bgg_hot_snapshots cur
  JOIN latest ON cur.captured_at = latest.at
  CROSS JOIN prev
  LEFT JOIN public.boardgamebuddy_bgg_hot_snapshots p
         ON p.captured_at = prev.at AND p.bgg_id = cur.bgg_id
 ORDER BY cur.rank, cur.bgg_id;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_bgg_hot_latest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_bgg_hot_latest() TO boardgamebuddy_role;

-- bgb_bgg_push_status(p_user uuid)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_bgg_push_status(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_username TEXT;
  v_has_creds BOOLEAN;
  v_session_start TIMESTAMPTZ;
  v_pending BIGINT;
  v_errored BIGINT;
  v_last_completed TIMESTAMPTZ;
  v_session_total BIGINT := 0;
  v_session_done BIGINT := 0;
  v_session_errored BIGINT := 0;
  v_names JSONB := '[]'::jsonb;
  v_errors JSONB := '[]'::jsonb;
BEGIN
  -- Same expression as bgb_bgg_sync_status so the route derives auth_state
  -- identically without the encrypted secret crossing the JSONB boundary.
  SELECT pr.bgg_username,
         (COALESCE(pr.bgg_username, '') <> '' AND COALESCE(pr.bgg_password_enc, '') <> ''),
         pr.bgg_last_push_started_at
    INTO v_username, v_has_creds, v_session_start
    FROM boardgamebuddy_profiles pr
    WHERE pr.id = p_user;

  SELECT count(*) FILTER (WHERE status = 'pending'),
         count(*) FILTER (WHERE status = 'error'),
         max(completed_at) FILTER (WHERE status = 'done')
    INTO v_pending, v_errored, v_last_completed
    FROM boardgamebuddy_bgg_push_queue
    WHERE user_id = p_user;

  IF v_session_start IS NOT NULL THEN
    SELECT count(*),
           count(*) FILTER (WHERE status = 'done'),
           count(*) FILTER (WHERE status = 'error')
      INTO v_session_total, v_session_done, v_session_errored
      FROM boardgamebuddy_bgg_push_queue
      WHERE user_id = p_user AND created_at >= v_session_start;

    SELECT COALESCE(jsonb_agg(name ORDER BY completed_at DESC NULLS LAST), '[]'::jsonb)
      INTO v_names
      FROM (
        SELECT game_name AS name, completed_at
        FROM boardgamebuddy_bgg_push_queue
        WHERE user_id = p_user
          AND created_at >= v_session_start
          AND status = 'done'
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 20
      ) done20;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'game_name', game_name, 'message', COALESCE(error_message, 'Unknown error')
           )), '[]'::jsonb)
      INTO v_errors
      FROM (
        SELECT game_name, error_message
        FROM boardgamebuddy_bgg_push_queue
        WHERE user_id = p_user
          AND created_at >= v_session_start
          AND status = 'error'
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 20
      ) err20;
  END IF;

  RETURN jsonb_build_object(
    'bgg_username', v_username,
    'has_credentials', COALESCE(v_has_creds, false),
    'pending_count', COALESCE(v_pending, 0),
    'errored_count', COALESCE(v_errored, 0),
    'last_completed_at', v_last_completed,
    'session_started_at', v_session_start,
    'session_total', COALESCE(v_session_total, 0),
    'session_done', COALESCE(v_session_done, 0),
    'session_errored', COALESCE(v_session_errored, 0),
    'session_game_names', v_names,
    'session_errors', v_errors
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_bgg_push_status(p_user uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_bgg_push_status(p_user uuid) TO boardgamebuddy_role;

-- bgb_bgg_sync_status(p_user uuid)
--   last defined in archive/2026-09-28/006_bgg_check_session.sql
CREATE OR REPLACE FUNCTION public.bgb_bgg_sync_status(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_username TEXT;
  v_has_creds BOOLEAN;
  v_session_start TIMESTAMPTZ;
  v_check_start TIMESTAMPTZ;
  v_pending BIGINT;
  v_errored BIGINT;
  v_last_completed TIMESTAMPTZ;
  v_session_total BIGINT := 0;
  v_session_done BIGINT := 0;
  v_session_errored BIGINT := 0;
  v_names JSONB := '[]'::jsonb;
  v_cat_total BIGINT := 0;
  v_cat_done BIGINT := 0;
  v_cat_errored BIGINT := 0;
  v_cat_names JSONB := '[]'::jsonb;
BEGIN
  SELECT pr.bgg_username,
         (COALESCE(pr.bgg_username, '') <> '' AND COALESCE(pr.bgg_password_enc, '') <> ''),
         pr.bgg_last_sync_started_at,
         pr.bgg_last_check_started_at
    INTO v_username, v_has_creds, v_session_start, v_check_start
    FROM boardgamebuddy_profiles pr
    WHERE pr.id = p_user;

  -- Lifetime counters, unchanged: they back the Settings header copy and are
  -- deliberately NOT the poll's exit condition.
  SELECT count(*) FILTER (WHERE status = 'pending'),
         count(*) FILTER (WHERE status = 'error'),
         max(completed_at) FILTER (WHERE status = 'done')
    INTO v_pending, v_errored, v_last_completed
    FROM boardgamebuddy_bgg_pending_imports
    WHERE user_id = p_user;

  IF v_session_start IS NOT NULL THEN
    WITH roll AS (
      SELECT bgg_id,
             CASE WHEN bool_or(status = 'pending') THEN 'pending'
                  WHEN bool_or(status = 'error') THEN 'error'
                  ELSE 'done' END AS st
      FROM boardgamebuddy_bgg_pending_imports
      WHERE user_id = p_user
        AND created_at >= v_session_start
        AND kind <> 'catalog'          -- migration 006: a check is not an import
        AND bgg_id IS NOT NULL
        AND status IS NOT NULL
      GROUP BY bgg_id
    )
    SELECT count(*),
           count(*) FILTER (WHERE st = 'done'),
           count(*) FILTER (WHERE st = 'error')
      INTO v_session_total, v_session_done, v_session_errored
      FROM roll;

    IF v_session_done > 0 THEN
      WITH roll AS (
        SELECT bgg_id,
               CASE WHEN bool_or(status = 'pending') THEN 'pending'
                    WHEN bool_or(status = 'error') THEN 'error'
                    ELSE 'done' END AS st
        FROM boardgamebuddy_bgg_pending_imports
        WHERE user_id = p_user
          AND created_at >= v_session_start
          AND kind <> 'catalog'
          AND bgg_id IS NOT NULL
          AND status IS NOT NULL
        GROUP BY bgg_id
      ),
      -- Most recent all-time completed_at per session-done bgg_id (the
      -- Python path queried done rows for those ids without the session
      -- filter), newest 20 first.
      latest AS (
        SELECT DISTINCT ON (pi.bgg_id) pi.bgg_id, pi.completed_at
        FROM boardgamebuddy_bgg_pending_imports pi
        JOIN roll r ON r.bgg_id = pi.bgg_id AND r.st = 'done'
        WHERE pi.user_id = p_user AND pi.status = 'done'
        ORDER BY pi.bgg_id, pi.completed_at DESC
      ),
      top20 AS (
        SELECT bgg_id, completed_at
        FROM latest
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 20
      )
      SELECT COALESCE(jsonb_agg(g.name ORDER BY t.completed_at DESC NULLS LAST), '[]'::jsonb)
        INTO v_names
        FROM top20 t
        JOIN boardgamebuddy_games g ON g.bgg_id = t.bgg_id
        WHERE g.name IS NOT NULL;
    END IF;
  END IF;

  -- ── The catalog fill a check kicked off ───────────────────────────────────
  -- No bgg_id roll-up here: a catalog row is one game by construction
  -- (unique on user_id, bgg_id, kind), so count(*) is already per-game.
  IF v_check_start IS NOT NULL THEN
    SELECT count(*),
           count(*) FILTER (WHERE status = 'done'),
           count(*) FILTER (WHERE status = 'error')
      INTO v_cat_total, v_cat_done, v_cat_errored
      FROM boardgamebuddy_bgg_pending_imports
      WHERE user_id = p_user
        AND kind = 'catalog'
        AND created_at >= v_check_start;

    IF v_cat_done > 0 THEN
      SELECT COALESCE(jsonb_agg(g.name ORDER BY t.completed_at DESC NULLS LAST), '[]'::jsonb)
        INTO v_cat_names
        FROM (
          SELECT pi.bgg_id, pi.completed_at
          FROM boardgamebuddy_bgg_pending_imports pi
          WHERE pi.user_id = p_user
            AND pi.kind = 'catalog'
            AND pi.created_at >= v_check_start
            AND pi.status = 'done'
          ORDER BY pi.completed_at DESC NULLS LAST
          LIMIT 20
        ) t
        JOIN boardgamebuddy_games g ON g.bgg_id = t.bgg_id
        WHERE g.name IS NOT NULL;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'bgg_username', v_username,
    'has_credentials', COALESCE(v_has_creds, false),
    'pending_count', COALESCE(v_pending, 0),
    'errored_count', COALESCE(v_errored, 0),
    'last_completed_at', v_last_completed,
    'session_started_at', v_session_start,
    'session_total', COALESCE(v_session_total, 0),
    'session_done', COALESCE(v_session_done, 0),
    'session_errored', COALESCE(v_session_errored, 0),
    'session_game_names', v_names,
    'catalog_session_started_at', v_check_start,
    'catalog_session_total', COALESCE(v_cat_total, 0),
    'catalog_session_done', COALESCE(v_cat_done, 0),
    'catalog_session_errored', COALESCE(v_cat_errored, 0),
    'catalog_session_game_names', v_cat_names
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_bgg_sync_status(p_user uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_bgg_sync_status(p_user uuid) TO boardgamebuddy_role;

-- bgb_collection_page(viewer uuid, target uuid, p_status text, p_search text, p_players integer, p_playtime_min integer, p_playtime_max integer, p_play_mode text, p_exclude_expansions boolean, p_sort text, p_prioritize_exact_players boolean, p_page integer, p_per_page integer)
--   last defined in archive/2026-09-28/057_played_mark.sql
CREATE OR REPLACE FUNCTION public.bgb_collection_page(viewer uuid, target uuid, p_status text DEFAULT 'owned'::text, p_search text DEFAULT NULL::text, p_players integer DEFAULT NULL::integer, p_playtime_min integer DEFAULT NULL::integer, p_playtime_max integer DEFAULT NULL::integer, p_play_mode text DEFAULT NULL::text, p_exclude_expansions boolean DEFAULT true, p_sort text DEFAULT 'last_played'::text, p_prioritize_exact_players boolean DEFAULT false, p_page integer DEFAULT 1, p_per_page integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- A blank search is no search. btrim first so a lone space does not filter
  -- the whole shelf away.
  v_search TEXT := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_excl BOOLEAN := COALESCE(p_exclude_expansions, true);
  -- Clamped to the same bounds FastAPI validates, so a direct caller cannot
  -- ask for a 10,000-row page.
  v_per_page INT := LEAST(GREATEST(COALESCE(p_per_page, 12), 1), 100);
  v_offset INT := GREATEST(COALESCE(p_page, 1) - 1, 0) * LEAST(GREATEST(COALESCE(p_per_page, 12), 1), 100);
  v_sort TEXT := COALESCE(p_sort, 'last_played');
  -- The exact-players bucket is opt-in AND needs a player count to be exact
  -- about; without one it is off, exactly as the Python guard had it.
  v_exact BOOLEAN := COALESCE(p_prioritize_exact_players, false) AND p_players IS NOT NULL;
  -- A game you sold is still on your Owned shelf, dimmed. Has to agree with
  -- bgb_collection_shelf's widening (069) because the client falls back from
  -- one endpoint to the other mid scroll.
  v_statuses TEXT[] := CASE
    WHEN p_status = 'owned' THEN ARRAY['owned', 'prev_owned']
    ELSE ARRAY[p_status]
  END;
  v_total BIGINT := 0;
  v_parted BIGINT := 0;
  v_items JSONB;
BEGIN
  -- A wishlist is private to its owner. Same gate bgb_collection_shelf and
  -- bgb_profile_bundle apply, and IS DISTINCT FROM so a NULL viewer is not a
  -- match. Owned and played shelves are public.
  IF p_status = 'wishlist' AND viewer IS DISTINCT FROM target THEN
    RETURN jsonb_build_object('items', '[]'::jsonb, 'total', 0, 'parted_total', 0);
  END IF;

  IF p_status = 'played' THEN
    -- Played-not-owned: every game the target has a play for that has NO row
    -- on their collection table at all (owned AND wishlist both live there).
    --
    -- This branch ignores p_sort and p_prioritize_exact_players, which is what
    -- the Python did: the shelf is defined by recency, and it returned before
    -- reaching either. Kept rather than quietly widened.
    WITH played_games AS (
      -- EXISTS, never a join onto play_players: a join fans one play out to
      -- one row per participant, which multiplies play_count. Same visibility
      -- rule as bgb_play_stats — logged by them, or seated on it.
      SELECT p.game_id,
             MAX(p.played_at) AS last_played_at,
             COUNT(*)::INT    AS play_count
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
         OR EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = target
            )
      GROUP BY p.game_id
      UNION ALL
      -- Played but never logged here (status 'played', migration 057).
      -- A game with a play is already above, so only the rest join.
      SELECT c.game_id, NULL, 0
      FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.status = 'played'
        AND NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_plays p2
              WHERE p2.game_id = c.game_id
                AND (p2.user_id = target OR EXISTS (
                      SELECT 1 FROM boardgamebuddy_play_players pp2
                      WHERE pp2.play_id = p2.id AND pp2.player_user_id = target))
            )
    ),
    filtered AS (
      SELECT pg.last_played_at, pg.play_count, g.*
      FROM played_games pg
      JOIN boardgamebuddy_games g ON g.id = pg.game_id
      WHERE NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_collections c
              WHERE c.user_id = target AND c.game_id = pg.game_id AND c.status <> 'played'
            )
        AND (NOT v_excl OR NOT g.is_expansion)
        -- A plain case-insensitive substring, not ILIKE: a user who types a %
        -- means a percent sign, not a wildcard.
        AND (v_search IS NULL OR strpos(lower(g.name), lower(v_search)) > 0)
        -- NULL bounds are permissive: a game that does not say how many can
        -- play is never filtered out by a player count.
        AND (p_players IS NULL OR g.max_players IS NULL OR g.max_players >= p_players)
        -- At six or more, the lower bound is dropped entirely, so a big-group
        -- search surfaces everything that can reach the table.
        AND (p_players IS NULL OR p_players >= 6 OR g.min_players IS NULL OR g.min_players <= p_players)
        -- Unknown playtime counts as zero, so a minimum excludes it and a
        -- maximum keeps it.
        AND (p_playtime_min IS NULL OR COALESCE(g.playing_time, 0) >= p_playtime_min)
        AND (p_playtime_max IS NULL OR COALESCE(g.playing_time, 0) <= p_playtime_max)
        AND (p_play_mode IS NULL OR g.play_mode = p_play_mode)
    ),
    page AS (
      SELECT f.*
      FROM filtered f
      ORDER BY f.last_played_at DESC NULLS LAST, f.id
      LIMIT v_per_page OFFSET v_offset
    )
    SELECT
      (SELECT COUNT(*) FROM filtered),
      COALESCE(jsonb_agg(jsonb_build_object(
        -- The synthetic id and date the Python minted. There is no collection
        -- row to take them from, and the client keys tiles on both.
        'id', 'played-' || q.id::TEXT,
        'game_id', q.id,
        'status', 'played',
        'added_at', COALESCE(q.last_played_at::TEXT || 'T00:00:00+00:00', (SELECT to_jsonb(c.added_at) #>> '{}' FROM boardgamebuddy_collections c WHERE c.user_id = target AND c.game_id = q.id)),
        'last_played_at', q.last_played_at,
        'play_count', COALESCE(q.play_count, 0),
        'game', jsonb_build_object(
          'id', q.id,
          'bgg_id', q.bgg_id,
          'name', q.name,
          'year_published', q.year_published,
          'min_players', q.min_players,
          'max_players', q.max_players,
          'playing_time', q.playing_time,
          'thumbnail_url', q.thumbnail_url,
          'image_url', q.image_url,
          'theme_color', q.theme_color,
          'is_expansion', q.is_expansion,
          'base_game_bgg_id', q.base_game_bgg_id,
          'expansion_color', q.expansion_color,
          'rulebook_url', q.rulebook_url,
          'play_mode', q.play_mode,
          'expansion_count', COALESCE(xc.n, 0)
        )
      -- jsonb_agg does not inherit the subquery's order, so the ordering is
      -- restated here as well as on the LIMIT that chose the page.
      ) ORDER BY q.last_played_at DESC NULLS LAST, q.id), '[]'::jsonb)
      INTO v_total, v_items
      FROM page q
      LEFT JOIN LATERAL (
        -- Catalog-wide, not the viewer's own expansions: the tile badge says
        -- how many exist for this game. An expansion scores 0 by the first
        -- predicate. This is the third round trip the endpoint used to make.
        SELECT COUNT(*)::INT AS n
        FROM boardgamebuddy_games e
        WHERE NOT q.is_expansion
          AND q.bgg_id IS NOT NULL
          AND e.is_expansion = true
          AND e.base_game_bgg_id = q.bgg_id
      ) xc ON true;

  ELSE
    -- Owned (widened to prev_owned) and wishlist.
    --
    -- An INNER join, because the Python skipped any collection row whose game
    -- row had gone. The join is also where every filter reads from: the grid
    -- has always filtered on the catalog row rather than the denormalized
    -- game_* columns, and rulebook_url is only on the catalog row.
    WITH filtered AS (
      SELECT c.id AS collection_id, c.status, c.added_at, g.*
      FROM boardgamebuddy_collections c
      JOIN boardgamebuddy_games g ON g.id = c.game_id
      WHERE c.user_id = target
        AND c.status = ANY(v_statuses)
        AND (NOT v_excl OR NOT g.is_expansion)
        AND (v_search IS NULL OR strpos(lower(g.name), lower(v_search)) > 0)
        AND (p_players IS NULL OR g.max_players IS NULL OR g.max_players >= p_players)
        AND (p_players IS NULL OR p_players >= 6 OR g.min_players IS NULL OR g.min_players <= p_players)
        AND (p_playtime_min IS NULL OR COALESCE(g.playing_time, 0) >= p_playtime_min)
        AND (p_playtime_max IS NULL OR COALESCE(g.playing_time, 0) <= p_playtime_max)
        AND (p_play_mode IS NULL OR g.play_mode = p_play_mode)
    ),
    counted AS (
      -- Both counts are over the FILTERED shelf, not the page: the client
      -- subtracts parted_total from a count that describes the whole shelf.
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE f.status = 'prev_owned') AS parted
      FROM filtered f
    ),
    page AS (
      SELECT f.*, ps.last_played_at, ps.play_count
      FROM filtered f
      LEFT JOIN LATERAL (
        -- Same visibility rule as bgb_play_stats. Per surviving row, and
        -- before the LIMIT when the sort reads it — nothing materialises a
        -- last_played_at on the collection row to sort by instead.
        SELECT MAX(p.played_at) AS last_played_at, COUNT(*)::INT AS play_count
        FROM boardgamebuddy_plays p
        WHERE p.game_id = f.id
          AND (
            p.user_id = target
            OR EXISTS (
                 SELECT 1 FROM boardgamebuddy_play_players pp
                 WHERE pp.play_id = p.id AND pp.player_user_id = target
               )
          )
      ) ps ON true
      ORDER BY
        -- Opt-in bucket first, so an exact fit leads without disturbing the
        -- chosen sort inside either bucket.
        CASE WHEN v_exact AND f.max_players = p_players THEN 0 ELSE 1 END,
        CASE WHEN v_sort = 'last_played' THEN ps.last_played_at END DESC NULLS LAST,
        CASE WHEN v_sort = 'alphabetical' THEN lower(f.name) END ASC NULLS LAST,
        CASE WHEN v_sort <> 'alphabetical' THEN f.added_at END DESC NULLS LAST,
        -- DELIBERATELY NOT PARITY. The Python left ties in whatever order
        -- PostgREST returned them, which is a paging hazard: a tied row can
        -- show up on two pages, or on none. A unique key makes the order total.
        f.id
      LIMIT v_per_page OFFSET v_offset
    )
    SELECT
      (SELECT total FROM counted),
      (SELECT parted FROM counted),
      COALESCE(jsonb_agg(jsonb_build_object(
        'id', q.collection_id,
        'game_id', q.id,
        'status', q.status,
        'added_at', q.added_at,
        'last_played_at', q.last_played_at,
        'play_count', COALESCE(q.play_count, 0),
        'game', jsonb_build_object(
          'id', q.id,
          'bgg_id', q.bgg_id,
          'name', q.name,
          'year_published', q.year_published,
          'min_players', q.min_players,
          'max_players', q.max_players,
          'playing_time', q.playing_time,
          'thumbnail_url', q.thumbnail_url,
          'image_url', q.image_url,
          'theme_color', q.theme_color,
          'is_expansion', q.is_expansion,
          'base_game_bgg_id', q.base_game_bgg_id,
          'expansion_color', q.expansion_color,
          'rulebook_url', q.rulebook_url,
          'play_mode', q.play_mode,
          'expansion_count', COALESCE(xc.n, 0)
        )
      ) ORDER BY
        CASE WHEN v_exact AND q.max_players = p_players THEN 0 ELSE 1 END,
        CASE WHEN v_sort = 'last_played' THEN q.last_played_at END DESC NULLS LAST,
        CASE WHEN v_sort = 'alphabetical' THEN lower(q.name) END ASC NULLS LAST,
        CASE WHEN v_sort <> 'alphabetical' THEN q.added_at END DESC NULLS LAST,
        q.id
      ), '[]'::jsonb)
      INTO v_total, v_parted, v_items
      FROM page q
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::INT AS n
        FROM boardgamebuddy_games e
        WHERE NOT q.is_expansion
          AND q.bgg_id IS NOT NULL
          AND e.is_expansion = true
          AND e.base_game_bgg_id = q.bgg_id
      ) xc ON true;
  END IF;

  RETURN jsonb_build_object(
    'items', COALESCE(v_items, '[]'::jsonb),
    'total', COALESCE(v_total, 0),
    'parted_total', COALESCE(v_parted, 0)
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_collection_page(viewer uuid, target uuid, p_status text, p_search text, p_players integer, p_playtime_min integer, p_playtime_max integer, p_play_mode text, p_exclude_expansions boolean, p_sort text, p_prioritize_exact_players boolean, p_page integer, p_per_page integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_collection_page(viewer uuid, target uuid, p_status text, p_search text, p_players integer, p_playtime_min integer, p_playtime_max integer, p_play_mode text, p_exclude_expansions boolean, p_sort text, p_prioritize_exact_players boolean, p_page integer, p_per_page integer) TO boardgamebuddy_role;

-- bgb_delete_account_rows(p_user uuid)
--   last defined in archive/2026-09-28/051_account_deletion_handover.sql
CREATE OR REPLACE FUNCTION public.bgb_delete_account_rows(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name        TEXT;
  v_photos      INT := 0;
  v_names       INT := 0;
  v_reassigned  INT := 0;
  v_deleted     INT := 0;
BEGIN
  SELECT pr.display_name INTO v_name
  FROM boardgamebuddy_profiles pr WHERE pr.id = p_user;

  -- (a) Unlink photos whose objects the caller has already removed.
  --
  -- Matched on the URL rather than on user_id, and NOT restricted to this
  -- account's plays. The plays layout is `{user_id}/{uuid4hex}.{ext}`, which
  -- appears identically inside both the R2 and the Supabase Storage public
  -- URL, so this is exactly the set of objects that just went. Only the
  -- owner-gated PATCH can attach one, so in practice they are all on this
  -- account's own plays — but a row that pointed at a deleted object from
  -- anywhere else is a broken image either way, and matching the URL costs
  -- one scan of a small table and cannot be wrong. It also makes this
  -- statement independent of the reassignment below, so their order is free.
  --
  -- A uuid contains only hex and hyphens: no `%`, and no `_`, which is the
  -- LIKE wildcard that would otherwise need escaping here.
  UPDATE boardgamebuddy_plays
     SET photo_url = NULL
   WHERE photo_url LIKE '%/' || p_user::text || '/%';
  GET DIAGNOSTICS v_photos = ROW_COUNT;

  -- (b) Give every nameless seat of theirs a name, BEFORE anything nulls the
  -- account off it. See the header: without this the FK's SET NULL can leave a
  -- row failing bgb_play_players_identity_chk and abort the whole delete.
  -- Same expression as bgb_ghost_out_of_plays, including the 'Player' floor
  -- for an account whose own display_name is somehow blank.
  UPDATE boardgamebuddy_play_players pp
     SET player_display_name =
           COALESCE(NULLIF(btrim(COALESCE(v_name, '')), ''), 'Player')
   WHERE pp.player_user_id = p_user
     AND btrim(COALESCE(pp.player_display_name, '')) = '';
  GET DIAGNOSTICS v_names = ROW_COUNT;

  -- (c) Hand over every play that somebody else was also at.
  WITH candidates AS (
    SELECT p.id           AS play_id,
           pp.player_user_id AS heir,
           pp.linked_at   AS seated_at
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
     WHERE p.user_id = p_user
       AND pp.player_user_id IS NOT NULL
       AND pp.player_user_id <> p_user
       -- Not a candidate if the play would collide with one this account
       -- already holds on any of the three per-owner unique keys. See the
       -- header: BGA tables are the real case, and an heir who already has a
       -- row for the same table already has that night.
       AND NOT EXISTS (
             SELECT 1
               FROM boardgamebuddy_plays x
              WHERE x.user_id = pp.player_user_id
                AND (
                      (p.bgg_play_id  IS NOT NULL AND x.bgg_play_id  = p.bgg_play_id)
                   OR (p.bga_table_id IS NOT NULL AND x.bga_table_id = p.bga_table_id)
                   OR (p.client_key   IS NOT NULL AND x.client_key   = p.client_key)
                )
           )
  ),
  heirs AS (
    -- Earliest seated wins; the uid breaks the tie so a re-run picks the same
    -- person. DISTINCT ON needs the leading ORDER BY column to be the group.
    SELECT DISTINCT ON (c.play_id) c.play_id AS play_id, c.heir AS heir
      FROM candidates c
     ORDER BY c.play_id, c.seated_at ASC, c.heir ASC
  )
  UPDATE boardgamebuddy_plays p
     SET user_id             = h.heir,
         inherited_at        = now(),
         inherited_from_name = COALESCE(NULLIF(btrim(COALESCE(v_name, '')), ''), 'Player')
    FROM heirs h
   WHERE p.id = h.play_id;
  GET DIAGNOSTICS v_reassigned = ROW_COUNT;

  -- (d) Whatever is left was theirs alone, and goes with them.
  SELECT COUNT(*)::int INTO v_deleted
    FROM boardgamebuddy_plays WHERE user_id = p_user;

  -- (e) The profile, and every cascade hanging off it: collections, the
  -- remaining plays, buddies, buddy edges, sessions and participants,
  -- achievements, push subscriptions, pending imports, feedback, BGA links.
  -- Seats on the plays handed over in (c) are NOT among them — they take the
  -- FK's SET NULL and become named ghosts. Guide chapters they authored keep
  -- their text under a NULL created_by.
  DELETE FROM boardgamebuddy_profiles WHERE id = p_user;

  RETURN jsonb_build_object(
    'plays_reassigned', v_reassigned,
    'plays_deleted',    v_deleted,
    'photos_unlinked',  v_photos,
    'names_backfilled', v_names
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_delete_account_rows(p_user uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_delete_account_rows(p_user uuid) TO boardgamebuddy_role;

-- bgb_delete_import_batch(p_user uuid, p_batch uuid)
--   last defined in archive/2026-09-28/007_play_import_batches.sql
CREATE OR REPLACE FUNCTION public.bgb_delete_import_batch(p_user uuid, p_batch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted INT;
BEGIN
  IF p_batch IS NULL THEN
    RETURN jsonb_build_object('deleted', 0);
  END IF;

  WITH gone AS (
    DELETE FROM public.boardgamebuddy_plays
     WHERE user_id = p_user
       AND import_batch_id = p_batch
    RETURNING 1
  )
  SELECT COUNT(*)::INT INTO v_deleted FROM gone;

  RETURN jsonb_build_object('deleted', v_deleted);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_delete_import_batch(p_user uuid, p_batch uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_delete_import_batch(p_user uuid, p_batch uuid) TO boardgamebuddy_role;

-- bgb_delete_import_group(p_user uuid, p_group uuid)
--   last defined in archive/2026-09-28/007_play_import_batches.sql
CREATE OR REPLACE FUNCTION public.bgb_delete_import_group(p_user uuid, p_group uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted INT;
BEGIN
  IF p_group IS NULL THEN
    RETURN jsonb_build_object('deleted', 0);
  END IF;

  WITH gone AS (
    DELETE FROM public.boardgamebuddy_plays
     WHERE user_id = p_user
       AND import_group_id = p_group
    RETURNING 1
  )
  SELECT COUNT(*)::INT INTO v_deleted FROM gone;

  RETURN jsonb_build_object('deleted', v_deleted);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_delete_import_group(p_user uuid, p_group uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_delete_import_group(p_user uuid, p_group uuid) TO boardgamebuddy_role;

-- bgb_discover_recommendations(uid uuid, lim integer)
--   last defined in archive/2026-09-28/038_discover.sql
CREATE OR REPLACE FUNCTION public.bgb_discover_recommendations(uid uuid, lim integer DEFAULT 12)
 RETURNS TABLE(game_id uuid, score numeric, reason_kind text, reason_game_id uuid, reason_game_name text, shared_mechanics text[], shared_categories text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH
-- Own plays and plays the viewer was seated in, once each — the same UNION
-- bgb_user_stats uses, so "played" means the same thing here as on Stats.
my_plays AS (
  SELECT p.id, p.game_id, p.played_at
    FROM public.boardgamebuddy_plays p
   WHERE p.user_id = uid
  UNION
  SELECT p.id, p.game_id, p.played_at
    FROM public.boardgamebuddy_plays p
    JOIN public.boardgamebuddy_play_players pp ON pp.play_id = p.id
   WHERE pp.player_user_id = uid
),
play_counts AS (
  SELECT mp.game_id,
         COUNT(*)::INT AS plays,
         COUNT(*) FILTER (WHERE mp.played_at >= CURRENT_DATE - 90)::INT AS recent_plays
    FROM my_plays mp
   GROUP BY mp.game_id
),
-- Expansions are not seeds: their tags duplicate the base game's and would
-- count it twice.
seed_games AS (
  SELECT g.id AS game_id, g.name, g.mechanics, g.categories,
         ( CASE c.status WHEN 'owned' THEN 1.0 WHEN 'wishlist' THEN 0.6 WHEN 'prev_owned' THEN 0.25 ELSE 0 END
           + LN(1 + COALESCE(pc.plays, 0))
           + 1.5 * LN(1 + COALESCE(pc.recent_plays, 0)) )::NUMERIC AS w
    FROM public.boardgamebuddy_games g
    LEFT JOIN play_counts pc ON pc.game_id = g.id
    LEFT JOIN public.boardgamebuddy_collections c ON c.game_id = g.id AND c.user_id = uid
   WHERE (pc.game_id IS NOT NULL OR c.id IS NOT NULL)
     AND NOT g.is_expansion
),
mech_w AS (
  SELECT m AS mechanic, SUM(s.w) AS w
    FROM seed_games s CROSS JOIN LATERAL unnest(COALESCE(s.mechanics, '{}')) AS m
   WHERE m <> ''
   GROUP BY m
),
cat_w AS (
  SELECT c AS category, SUM(s.w) AS w
    FROM seed_games s CROSS JOIN LATERAL unnest(COALESCE(s.categories, '{}')) AS c
   WHERE c <> ''
   GROUP BY c
),
totals AS (
  SELECT (SELECT COUNT(*) FROM seed_games) AS seed_count
),
-- The viewer's typical table. Seats counted off the roster, minutes off the
-- game's listed playing time.
table_profile AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY seats.n)        AS median_seats,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY g.playing_time) AS median_minutes
    FROM my_plays mp
    JOIN public.boardgamebuddy_games g ON g.id = mp.game_id
    JOIN LATERAL (
      SELECT COUNT(*)::INT AS n
        FROM public.boardgamebuddy_play_players pp
       WHERE pp.play_id = mp.id
    ) seats ON true
),
-- Anything on the shelf in any status, or ever played, is not a discovery.
excluded AS (
  SELECT mp.game_id FROM my_plays mp
  UNION
  SELECT c.game_id FROM public.boardgamebuddy_collections c WHERE c.user_id = uid
),
candidates AS (
  SELECT g.id, g.name, g.mechanics, g.categories, g.min_players, g.max_players,
         g.playing_time, g.bgg_rating,
         COALESCE((SELECT SUM(mw.w) FROM unnest(COALESCE(g.mechanics, '{}')) m JOIN mech_w mw ON mw.mechanic = m), 0)
           / sqrt(GREATEST(1, cardinality(COALESCE(g.mechanics, '{}'))))  AS mech_score,
         COALESCE((SELECT SUM(cw.w) FROM unnest(COALESCE(g.categories, '{}')) c JOIN cat_w cw ON cw.category = c), 0)
           / sqrt(GREATEST(1, cardinality(COALESCE(g.categories, '{}')))) AS cat_score,
         ARRAY(SELECT mw.mechanic FROM unnest(COALESCE(g.mechanics, '{}')) m JOIN mech_w mw ON mw.mechanic = m
                ORDER BY mw.w DESC, mw.mechanic LIMIT 3) AS shared_m,
         ARRAY(SELECT cw.category FROM unnest(COALESCE(g.categories, '{}')) c JOIN cat_w cw ON cw.category = c
                ORDER BY cw.w DESC, cw.category LIMIT 3) AS shared_c
    FROM public.boardgamebuddy_games g
   WHERE NOT g.is_expansion
     AND NOT EXISTS (SELECT 1 FROM excluded e WHERE e.game_id = g.id)
),
scored AS (
  SELECT c.*,
         c.mech_score / NULLIF(MAX(c.mech_score) OVER (), 0) AS mech_norm,
         c.cat_score  / NULLIF(MAX(c.cat_score)  OVER (), 0) AS cat_norm,
         CASE WHEN tp.median_seats IS NOT NULL
               AND c.min_players IS NOT NULL AND c.max_players IS NOT NULL
               AND tp.median_seats BETWEEN c.min_players AND c.max_players THEN 1 ELSE 0 END AS seat_fit,
         COALESCE(
           CASE WHEN tp.median_minutes IS NULL OR c.playing_time IS NULL THEN 0.5
                ELSE 1 - LEAST(1, ABS(c.playing_time - tp.median_minutes) / NULLIF(tp.median_minutes, 0)) END,
           0.5) AS time_fit,
         -- 5.5 is BGG's centre of mass; 9 maps to +1, NULL (unsynced) to 0.
         COALESCE((c.bgg_rating - 5.5) / 3.5, 0) AS quality
    FROM candidates c
    CROSS JOIN table_profile tp
),
weighted AS (
  SELECT s.*,
         ( 0.45 * COALESCE(s.mech_norm, 0)
         + 0.20 * COALESCE(s.cat_norm, 0)
         + 0.15 * s.seat_fit
         + 0.10 * s.time_fit
         + 0.10 * s.quality )::NUMERIC(6,4) AS score
    FROM scored s
),
-- The single seed that explains this candidate best: most shared mechanics,
-- ties broken by the seed's own weight.
explained AS (
  SELECT w.*, bs.game_id AS seed_id, bs.name AS seed_name, bs.shared AS seed_shared
    FROM weighted w
    LEFT JOIN LATERAL (
      SELECT s.game_id, s.name,
             cardinality(ARRAY(SELECT unnest(s.mechanics) INTERSECT SELECT unnest(w.mechanics))) AS shared
        FROM seed_games s
       WHERE s.mechanics && w.mechanics
       ORDER BY 3 DESC, s.w DESC, s.game_id
       LIMIT 1
    ) bs ON true
),
labelled AS (
  SELECT e.id, e.score,
         CASE
           WHEN COALESCE(e.seed_shared, 0) >= 2               THEN 'because_you_play'
           WHEN cardinality(e.shared_m) >= 1                  THEN 'shared_mechanics'
           WHEN cardinality(e.shared_c) >= 1                  THEN 'shared_categories'
           WHEN e.seat_fit = 1 AND e.time_fit >= 0.7          THEN 'fits_your_table'
           ELSE 'highly_rated'
         END AS reason_kind,
         CASE WHEN COALESCE(e.seed_shared, 0) >= 2 THEN e.seed_id   END AS reason_game_id,
         CASE WHEN COALESCE(e.seed_shared, 0) >= 2 THEN e.seed_name END AS reason_game_name,
         e.shared_m, e.shared_c,
         ROW_NUMBER() OVER (
           PARTITION BY CASE WHEN COALESCE(e.seed_shared, 0) >= 2 THEN e.seed_id END
           ORDER BY e.score DESC, e.id
         ) AS per_seed_rank
    FROM explained e
   WHERE e.score > 0
)
SELECT l.id, l.score, l.reason_kind, l.reason_game_id, l.reason_game_name, l.shared_m, l.shared_c
  FROM labelled l
 CROSS JOIN totals t
 WHERE t.seed_count > 0
   AND (l.reason_game_id IS NULL OR l.per_seed_rank <= 3)
 ORDER BY l.score DESC, l.id
 LIMIT lim;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_discover_recommendations(uid uuid, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_discover_recommendations(uid uuid, lim integer) TO boardgamebuddy_role;

-- bgb_distinct_mechanics()
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_distinct_mechanics()
 RETURNS TABLE(mechanic text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT DISTINCT m
  FROM public.boardgamebuddy_games,
       LATERAL unnest(COALESCE(mechanics, ARRAY[]::TEXT[])) AS m
  WHERE m IS NOT NULL AND m <> ''
  ORDER BY m;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_distinct_mechanics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_distinct_mechanics() TO boardgamebuddy_role;

-- bgb_dormant_collection(uid uuid, days_since integer, lim integer)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_dormant_collection(uid uuid, days_since integer DEFAULT 60, lim integer DEFAULT 5)
 RETURNS TABLE(game_id uuid, last_played_at date)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    c.game_id,
    (
      SELECT MAX(p.played_at)
      FROM public.boardgamebuddy_plays p
      WHERE p.game_id = c.game_id
        AND (
          p.user_id = uid
          OR EXISTS (
               SELECT 1 FROM public.boardgamebuddy_play_players pp
               WHERE pp.play_id = p.id AND pp.player_user_id = uid
             )
        )
    ) AS last_played_at
  FROM public.boardgamebuddy_collections c
  WHERE c.user_id = uid
    AND c.status = 'owned'
    AND COALESCE(
          (
            SELECT MAX(p.played_at)
            FROM public.boardgamebuddy_plays p
            WHERE p.game_id = c.game_id
              AND (
                p.user_id = uid
                OR EXISTS (
                     SELECT 1 FROM public.boardgamebuddy_play_players pp
                     WHERE pp.play_id = p.id AND pp.player_user_id = uid
                   )
              )
          ),
          '-infinity'::DATE
        ) < (CURRENT_DATE - (days_since || ' days')::INTERVAL)
  ORDER BY last_played_at NULLS FIRST, c.game_id
  LIMIT lim;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_dormant_collection(uid uuid, days_since integer, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_dormant_collection(uid uuid, days_since integer, lim integer) TO boardgamebuddy_role;

-- bgb_feed_plays(viewer uuid, before_played_at date, before_created_at timestamp with time zone, lim integer)
--   last defined in archive/2026-09-28/048_play_teams.sql
CREATE OR REPLACE FUNCTION public.bgb_feed_plays(viewer uuid, before_played_at date DEFAULT NULL::date, before_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, lim integer DEFAULT 20)
 RETURNS TABLE(play_id uuid, play_user_id uuid, play_user_name text, play_user_avatar jsonb, game_id uuid, game_name text, game_image_url text, game_thumbnail_url text, played_at date, created_at timestamp with time zone, notes text, photo_url text, play_mode text, winner_display_name text, participant_count integer, participants jsonb, group_count integer, import_group_id uuid, players jsonb, expansions jsonb, country_code text, reaction_count integer, viewer_reacted boolean, reactors jsonb, import_batch_id uuid, scoring_template jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Dynamic SQL for one reason: `lim` is interpolated as a literal instead of
  -- being bound as a parameter. With BOTH `viewer` and `lim` opaque, the
  -- planner has no idea the `page` CTE yields ~20 rows, so it plans the roster
  -- lookup as if `page` were huge and reads the whole play_players table —
  -- measured 555 ms versus 12 ms with the limit visible. Interpolating just
  -- the limit restores the estimate; viewer/cursor stay bound via USING, which
  -- is enough for a good plan. Injection-safe because `lim` is typed INT, so
  -- it cannot carry SQL, and it's clamped to a sane range below.
  --
  -- EXECUTE also sidesteps plpgsql's substitution of RETURNS TABLE column
  -- names (play_id, played_at, notes, participants, players, …) into the query
  -- body: the string is handed to the SQL engine untouched. 015 added
  -- `players` and `expansions` to that set of shadowed names, 016 added
  -- `reactors`, 022 added `import_batch_id` and 031 adds `scoring_template` —
  -- all of which `page` selects by name from the plays table, so the shadowing
  -- would be a live bug rather than a theoretical one. One more reason this
  -- stays EXECUTE.
  RETURN QUERY EXECUTE format($q$
  WITH visible AS (
    SELECT $1::uuid AS uid
    UNION
    SELECT CASE WHEN be.user_a = $1::uuid THEN be.user_b ELSE be.user_a END AS uid
    FROM public.boardgamebuddy_buddy_edges be
    WHERE be.status = 'accepted'
      AND $1::uuid IN (be.user_a, be.user_b)
  ),
  -- Plays the viewer themselves attended — used to widen the roster
  -- filter so non-buddy participants are exposed on cards for plays
  -- the viewer was at.
  viewer_was_at AS (
    SELECT DISTINCT pp.play_id
    FROM public.boardgamebuddy_play_players pp
    WHERE pp.player_user_id = $1::uuid
  ),
  -- Plays where at least one visible user (viewer or any accepted buddy)
  -- appears in play_players. This is the "main" visibility branch.
  attended AS (
    SELECT DISTINCT pp.play_id
    FROM public.boardgamebuddy_play_players pp
    WHERE pp.player_user_id IN (SELECT uid FROM visible)
  ),
  -- Final candidate set: legacy "logger ∈ visible" UNION attended. The
  -- legacy branch is technically subsumed by `attended` when the logger
  -- is always tagged as a participant (the standard log_play flow does
  -- this), but we keep it as a belt-and-suspenders cover for any
  -- historical rows where it isn't.
  visible_plays AS (
    SELECT p.id
    FROM public.boardgamebuddy_plays p
    JOIN visible v ON v.uid = p.user_id
    UNION
    SELECT play_id FROM attended
  ),
  -- Resolve the page BEFORE touching play_players. This is the whole point of
  -- the rewrite: the roster lookup below runs per page row, so it reads at
  -- most `lim` plays' worth of play_players instead of the entire table.
  page AS (
    SELECT p.id, p.user_id, p.game_id, p.played_at, p.created_at,
           p.notes, p.photo_url, p.play_mode, p.import_group_id,
           -- New in 022. Free: `page` already reads this row, and the column
           -- is a plain uuid on it.
           p.import_batch_id,
           -- New in 031. Free for the same reason — a jsonb column on the row
           -- `page` already selects from.
           p.scoring_template,
           p.country_code,
           -- How many plays this row stands for. 1 for everything the app has
           -- ever logged live; the run's size for an imported group.
           CASE WHEN p.import_group_id IS NULL THEN 1
                ELSE (SELECT COUNT(*)::INT
                        FROM public.boardgamebuddy_plays q
                       WHERE q.import_group_id = p.import_group_id)
           END AS group_count
    FROM public.boardgamebuddy_plays p
    JOIN visible_plays vp ON vp.id = p.id
    WHERE (
      $2::date IS NULL
      OR $3::timestamptz IS NULL
      OR (p.played_at, p.created_at) < ($2::date, $3::timestamptz)
    )
      -- Migration 005. One representative row per imported run: the lowest id
      -- in the run, so the choice is stable and deleting the representative
      -- just promotes the next row rather than losing the group.
      --
      -- ORDER BY ... LIMIT 1 rather than MIN(): Postgres has no MIN aggregate
      -- for uuid, though the type orders fine in an index.
      --
      -- This sits INSIDE `page`, before the LIMIT, on purpose: that is what
      -- makes a page 20 CARDS rather than 20 rows of which 19 are the same
      -- run. A 106-play import used to consume five pages of everyone's feed
      -- before anything else could appear.
      --
      -- Deliberately a correlated lookup on the partial index rather than a
      -- window function over the viewer's visible plays: the window is the
      -- shape migration 043 removed (105 ms -> 5 ms on a 30k-play fixture),
      -- and it would make every feed call pay for grouping that almost no row
      -- needs. Both subqueries are short-circuited by the NULL check for every
      -- play that was not imported, which is all of them but a handful.
      AND (
        p.import_group_id IS NULL
        OR p.id = (SELECT q.id
                     FROM public.boardgamebuddy_plays q
                    WHERE q.import_group_id = p.import_group_id
                    ORDER BY q.id
                    LIMIT 1)
      )
    ORDER BY p.played_at DESC, p.created_at DESC, p.id
    LIMIT %s
  )
  -- Roster + winners, resolved per page row via LATERAL rather than as
  -- page-filtered CTEs. This matters: `lim` is a function parameter, so the
  -- planner has no idea `page` yields ~20 rows. Given `pp.play_id IN (SELECT
  -- id FROM page)` it assumes `page` is large and picks a hash semi-join over
  -- the whole play_players table — twice — which measured ~8x SLOWER than the
  -- original. A LATERAL keyed on p.id is an index lookup on
  -- idx_bgb_play_players_play per page row, so the work stays bounded by `lim`
  -- no matter what the planner estimates.
  SELECT
    p.id,
    p.user_id,
    prof.display_name,
    prof.avatar,
    g.id,
    g.name,
    g.image_url,
    g.thumbnail_url,
    p.played_at,
    p.created_at,
    p.notes,
    p.photo_url,
    p.play_mode,
    roster.winner_display_name,
    COALESCE(roster.participant_count, 0),
    COALESCE(roster.participants, '[]'::jsonb),
    p.group_count,
    p.import_group_id,
    COALESCE(roster.players, '[]'::jsonb),
    COALESCE(exp.expansions, '[]'::jsonb),
    p.country_code,
    COALESCE(rx.reaction_count, 0),
    COALESCE(rx.viewer_reacted, false),
    COALESCE(rx.reactors, '[]'::jsonb),
    p.import_batch_id,
    p.scoring_template
  FROM page p
  JOIN public.boardgamebuddy_profiles prof ON prof.id = p.user_id
  JOIN public.boardgamebuddy_games g       ON g.id = p.game_id
  LEFT JOIN LATERAL (
    SELECT
      string_agg(
        COALESCE(pprof.display_name, pp.player_display_name), ', '
        ORDER BY COALESCE(pprof.display_name, pp.player_display_name)
      ) FILTER (WHERE pp.is_winner = true) AS winner_display_name,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'user_id',      pp.player_user_id::text,
            'display_name', COALESCE(pprof.display_name, pp.player_display_name)
          )
          ORDER BY COALESCE(pprof.display_name, pp.player_display_name)
        ) FILTER (
          WHERE pp.player_user_id IS NOT NULL
            AND (
              pp.player_user_id IN (SELECT uid FROM visible)
              OR p.id IN (SELECT play_id FROM viewer_was_at)
            )
        ),
        '[]'::jsonb
      ) AS participants,
      -- The scorecard, added by 015. UNFILTERED, unlike `participants`: this
      -- is the roster the back of the card and the detail popup draw, and both
      -- have always shown every seat — ghosts included — because that is what
      -- GET /plays/{id} returns them today.
      --
      -- Ordered by is_winner then score, both DESC NULLS LAST, so the array
      -- arrives in the order the scoreboard wants and the client's sort is a
      -- no-op on well-formed data rather than the thing that makes it correct.
      -- Field names mirror PlayPlayerResponse exactly (name, not display_name)
      -- so the FE adapter is a pass-through.
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'user_id',      pp.player_user_id::text,
            'name',         COALESCE(pprof.display_name, pp.player_display_name),
            'avatar',       pprof.avatar,
            'is_winner',    COALESCE(pp.is_winner, false),
            'score',        pp.score,
            'round_scores', pp.round_scores,
            -- Migration 048. Required, not optional: Play.fromFeedCard passes
            -- this array straight into the detail popup's seed and the popup
            -- paints from it in the same frame as the tap. Without it a play
            -- opened from the feed would show an ungrouped roster that then
            -- reshuffled into sides when GET /plays/{id} landed.
            'team',         pp.team
          )
          ORDER BY COALESCE(pp.is_winner, false) DESC, pp.score DESC NULLS LAST
        ),
        '[]'::jsonb
      ) AS players,
      COUNT(*)::INT AS participant_count
    FROM public.boardgamebuddy_play_players pp
    LEFT JOIN public.boardgamebuddy_profiles pprof ON pprof.id = pp.player_user_id
    WHERE pp.play_id = p.id
  ) roster ON true
  -- The one genuinely new read in 015. Same LATERAL shape as the roster so it
  -- inherits the same bounded-by-`lim` property: an index lookup per page row
  -- on the (play_id, expansion_game_id) primary key. Most plays have no
  -- expansions and the aggregate collapses to NULL -> '[]'.
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
             jsonb_build_object(
               'expansion_game_id', pe.expansion_game_id::text,
               'name',              eg.name,
               'color',             eg.theme_color
             )
             ORDER BY eg.name
           ) AS expansions
    FROM public.boardgamebuddy_play_expansions pe
    JOIN public.boardgamebuddy_games eg ON eg.id = pe.expansion_game_id
    WHERE pe.play_id = p.id
  ) exp ON true
  -- Reactions, added by 016. Same bounded-by-`lim` LATERAL shape as the two
  -- above: an index lookup per page row on the (play_id, user_id) primary key.
  --
  -- `reactors` is capped at 8 and newest-first because the footer only ever
  -- draws three avatars; the exact total rides in `reaction_count`, so the cap
  -- never makes the number wrong. The viewer's own row is answered by an EXISTS
  -- rather than by scanning the capped array, which would go wrong the moment a
  -- ninth person reacted.
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::int AS reaction_count,
      bool_or(r.user_id = $1::uuid) AS viewer_reacted,
      COALESCE(
        (SELECT jsonb_agg(x)
           FROM (SELECT jsonb_build_object(
                          'user_id',      r2.user_id::text,
                          'display_name', rprof.display_name,
                          'avatar',       rprof.avatar
                        ) AS x
                   FROM public.boardgamebuddy_play_reactions r2
                   LEFT JOIN public.boardgamebuddy_profiles rprof ON rprof.id = r2.user_id
                  WHERE r2.play_id = p.id
                  ORDER BY r2.created_at DESC
                  LIMIT 8) capped),
        '[]'::jsonb
      ) AS reactors
    FROM public.boardgamebuddy_play_reactions r
    WHERE r.play_id = p.id
  ) rx ON true
  ORDER BY p.played_at DESC, p.created_at DESC, p.id
  -- The clamp bounds what a caller can interpolate. The ceiling must stay
  -- ABOVE every caller's own cap, because feed_service derives next_cursor
  -- from `len(rows) == limit` — if this silently returned fewer rows than
  -- asked for, pagination would stop early. Today /feed is capped at 50
  -- (feed_routes.py) and bootstrap asks for 20, so 100 has margin.
  $q$, LEAST(GREATEST(COALESCE(lim, 20), 1), 100))
  USING viewer, before_played_at, before_created_at;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_feed_plays(viewer uuid, before_played_at date, before_created_at timestamp with time zone, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_feed_plays(viewer uuid, before_played_at date, before_created_at timestamp with time zone, lim integer) TO boardgamebuddy_role;

-- bgb_feedback_list(viewer_id uuid, want_status text, want_type text, want_topic text, want_id uuid)
--   last defined in archive/2026-09-28/041_dev_feedback.sql
CREATE OR REPLACE FUNCTION public.bgb_feedback_list(viewer_id uuid, want_status text, want_type text DEFAULT NULL::text, want_topic text DEFAULT NULL::text, want_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, user_id uuid, author_name text, feedback_type text, feedback_type_label text, feedback_type_icon text, topic text, topic_label text, topic_icon text, body text, status text, resolved_at timestamp with time zone, resolver_name text, created_at timestamp with time zone, like_count bigint, viewer_liked boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    f.id,
    f.user_id,
    author.display_name,
    f.feedback_type,
    ft.label,
    ft.icon,
    f.topic,
    tp.label,
    tp.icon,
    f.body,
    f.status,
    f.resolved_at,
    resolver.display_name,
    f.created_at,
    -- A correlated count rather than a LEFT JOIN + GROUP BY: it reads off the
    -- likes PK directly (feedback_id leads it) and keeps every column above out
    -- of a GROUP BY clause that would have to list all fourteen of them.
    (SELECT COUNT(*) FROM public.boardgamebuddy_feedback_likes l
      WHERE l.feedback_id = f.id),
    EXISTS (SELECT 1 FROM public.boardgamebuddy_feedback_likes l
             WHERE l.feedback_id = f.id AND l.user_id = viewer_id)
  FROM public.boardgamebuddy_feedback f
  JOIN public.boardgamebuddy_profiles author ON author.id = f.user_id
  JOIN public.boardgamebuddy_feedback_types  ft ON ft.id = f.feedback_type
  JOIN public.boardgamebuddy_feedback_topics tp ON tp.id = f.topic
  -- LEFT, unlike the three above: resolved_by is null on every open item, and an
  -- inner join here would return an empty board.
  LEFT JOIN public.boardgamebuddy_profiles resolver ON resolver.id = f.resolved_by
  WHERE (want_id IS NULL     OR f.id     = want_id)
    -- Skipped entirely on an id lookup — see the header.
    AND (want_id IS NOT NULL OR f.status = want_status)
    AND (want_type  IS NULL OR f.feedback_type = want_type)
    AND (want_topic IS NULL OR f.topic         = want_topic)
  ORDER BY (SELECT COUNT(*) FROM public.boardgamebuddy_feedback_likes l
             WHERE l.feedback_id = f.id) DESC,
           f.created_at DESC;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_feedback_list(viewer_id uuid, want_status text, want_type text, want_topic text, want_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_feedback_list(viewer_id uuid, want_status text, want_type text, want_topic text, want_id uuid) TO boardgamebuddy_role;

-- bgb_game_detail_bundle(game_uuid uuid, viewer uuid, plays_limit integer)
--   last defined in archive/2026-09-28/030_game_viewer_stats.sql
CREATE OR REPLACE FUNCTION public.bgb_game_detail_bundle(game_uuid uuid, viewer uuid, plays_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_game JSONB;
  v_base JSONB;
  v_status TEXT;
  v_plays JSONB;
  v_expansions JSONB;
  v_exp_count_viewer INT;
  v_is_expansion BOOLEAN;
  v_base_bgg_id INT;
  v_bgg_id INT;
  v_viewer_stats JSONB;
BEGIN
  SELECT to_jsonb(g.*), g.is_expansion, g.base_game_bgg_id, g.bgg_id
    INTO v_game, v_is_expansion, v_base_bgg_id, v_bgg_id
    FROM boardgamebuddy_games g WHERE g.id = game_uuid;
  IF v_game IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_is_expansion AND v_base_bgg_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'id', g.id,
      'name', g.name,
      'thumbnail_url', g.thumbnail_url
    ) INTO v_base
    FROM boardgamebuddy_games g
    WHERE g.bgg_id = v_base_bgg_id
    LIMIT 1;
  END IF;

  -- Viewer's pill: collection row wins; otherwise fall through to 'played'
  -- when the viewer has any visible play (own or as a participant) so the
  -- played-not-owned case paints the purple Played banner instead of the
  -- bare "+ Add" picker.
  SELECT status INTO v_status
    FROM boardgamebuddy_collections
    WHERE user_id = viewer AND game_id = game_uuid;
  IF v_status IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM boardgamebuddy_plays p
      WHERE p.game_id = game_uuid
        AND (
          p.user_id = viewer
          OR EXISTS (
            SELECT 1 FROM boardgamebuddy_play_players pp
            WHERE pp.play_id = p.id AND pp.player_user_id = viewer
          )
        )
    ) THEN
      v_status := 'played';
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(play_row ORDER BY played_at DESC, created_at DESC), '[]'::jsonb)
    INTO v_plays
    FROM (
      SELECT
        p.played_at,
        p.created_at,
        jsonb_build_object(
          'id', p.id,
          'game_id', p.game_id,
          'game_name', p.game_name,
          'game_thumbnail', p.game_thumbnail_url,
          'played_at', p.played_at,
          'notes', p.notes,
          'photo_url', p.photo_url,
          'play_mode', COALESCE(p.play_mode, 'competitive'),
          'created_at', p.created_at,
          'logged_by_id', p.user_id,
          'logged_by_name', COALESCE(pr.display_name, 'Unknown'),
          'is_own', p.user_id = viewer,
          'players', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'user_id', pp.player_user_id,
              'name', COALESCE(pp_pr.display_name, pp.player_display_name, 'Unknown'),
              'is_winner', COALESCE(pp.is_winner, false),
              'score', pp.score
            ) ORDER BY pp.id)
            FROM boardgamebuddy_play_players pp
            LEFT JOIN boardgamebuddy_profiles pp_pr ON pp_pr.id = pp.player_user_id
            WHERE pp.play_id = p.id
          ), '[]'::jsonb),
          'expansions', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'expansion_game_id', pe.expansion_game_id,
              'name', eg.name,
              'color', eg.expansion_color
            ))
            FROM boardgamebuddy_play_expansions pe
            JOIN boardgamebuddy_games eg ON eg.id = pe.expansion_game_id
            WHERE pe.play_id = p.id
          ), '[]'::jsonb)
        ) AS play_row
      FROM boardgamebuddy_plays p
      LEFT JOIN boardgamebuddy_profiles pr ON pr.id = p.user_id
      WHERE p.game_id = game_uuid
        AND (
          p.user_id = viewer
          OR EXISTS (
            SELECT 1 FROM boardgamebuddy_play_players pl
            WHERE pl.play_id = p.id AND pl.player_user_id = viewer
          )
        )
      ORDER BY p.played_at DESC, p.created_at DESC
      LIMIT plays_limit
    ) ranked;

  IF NOT v_is_expansion AND v_bgg_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'expansion_game_id', g.id,
      'bgg_id', g.bgg_id,
      'name', g.name,
      'thumbnail_url', g.thumbnail_url,
      -- Full-size art for the expansion reel's polaroids: at 132x110 with
      -- object-fit: cover, BGG's ~200px thumbnail was being upscaled.
      'image_url', g.image_url,
      'color', g.expansion_color,
      'is_enabled', EXISTS (
        SELECT 1 FROM boardgamebuddy_user_expansions ue
        WHERE ue.user_id = viewer AND ue.expansion_game_id = g.id
      ),
      'rulebook_url', g.rulebook_url
    ) ORDER BY g.name), '[]'::jsonb)
      INTO v_expansions
      FROM boardgamebuddy_games g
      WHERE g.is_expansion = true AND g.base_game_bgg_id = v_bgg_id;

    SELECT COUNT(*) INTO v_exp_count_viewer
      FROM boardgamebuddy_games g
      JOIN boardgamebuddy_collections c
        ON c.game_id = g.id
       AND c.user_id = viewer
       AND c.status = 'owned'
      WHERE g.is_expansion = true AND g.base_game_bgg_id = v_bgg_id;
  ELSE
    v_expansions := '[]'::jsonb;
    v_exp_count_viewer := 0;
  END IF;

  -- ── Viewer's record with this game (migration 030) ──────────────────────
  WITH my_plays AS (
    SELECT p.id, p.played_at
      FROM boardgamebuddy_plays p
     WHERE p.game_id = game_uuid
       AND (
         p.user_id = viewer
         OR EXISTS (
           SELECT 1 FROM boardgamebuddy_play_players pp
            WHERE pp.play_id = p.id AND pp.player_user_id = viewer
         )
       )
  ),
  -- The viewer's own seat on each of those plays. A play they logged but sat
  -- out has no row here, so it has no result and no score.
  mine AS (
    SELECT mp.id AS play_id, pp.is_winner, pp.score,
           EXISTS (
             SELECT 1 FROM boardgamebuddy_play_players d
              WHERE d.play_id = mp.id
                AND (d.is_winner OR d.score IS NOT NULL)
           ) AS decided
      FROM my_plays mp
      JOIN boardgamebuddy_play_players pp
        ON pp.play_id = mp.id AND pp.player_user_id = viewer
  ),
  winner_scores AS (
    SELECT w.play_id, w.score
      FROM boardgamebuddy_play_players w
      JOIN my_plays mp ON mp.id = w.play_id
     WHERE w.is_winner AND w.score IS NOT NULL
  )
  SELECT CASE WHEN (SELECT COUNT(*) FROM my_plays) = 0 THEN NULL ELSE
    jsonb_build_object(
      'game_id',           game_uuid,
      'play_mode',         COALESCE(v_game->>'play_mode', 'competitive'),
      'plays',             (SELECT COUNT(*)::INT FROM my_plays),
      'wins',              (SELECT COUNT(*)::INT FROM mine WHERE is_winner),
      'decided_plays',     (SELECT COUNT(*)::INT FROM mine WHERE decided),
      'scored_plays',      (SELECT COUNT(DISTINCT play_id)::INT FROM winner_scores),
      'avg_winning_score', (SELECT ROUND(AVG(score))::INT FROM winner_scores),
      'your_avg_score',    (SELECT ROUND(AVG(score))::INT FROM mine WHERE score IS NOT NULL),
      'your_best_score',   (SELECT MAX(score) FROM mine),
      'first_played_at',   (SELECT MIN(played_at) FROM my_plays),
      'last_played_at',    (SELECT MAX(played_at) FROM my_plays)
    )
  END INTO v_viewer_stats;

  RETURN jsonb_build_object(
    'game', v_game,
    'base_game', v_base,
    'viewer_status', v_status,
    'recent_plays', v_plays,
    'expansions', v_expansions,
    'expansion_count_for_viewer', v_exp_count_viewer,
    'viewer_stats', v_viewer_stats
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_game_detail_bundle(game_uuid uuid, viewer uuid, plays_limit integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_game_detail_bundle(game_uuid uuid, viewer uuid, plays_limit integer) TO boardgamebuddy_role;

-- bgb_game_bundles(viewer uuid, owned_plays_limit integer, max_bundles integer)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_game_bundles(viewer uuid, owned_plays_limit integer DEFAULT 5, max_bundles integer DEFAULT 250)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_game_bundles JSONB;
  v_owned_count INT;
BEGIN
  -- Base games only — expansions are surfaced via the base game's
  -- bundle.expansions block.
  SELECT COUNT(*) INTO v_owned_count
    FROM boardgamebuddy_collections c
    WHERE c.user_id = viewer
      AND c.status = 'owned'
      AND COALESCE(c.game_is_expansion, false) = false;

  WITH owned AS (
    SELECT c.game_id
    FROM boardgamebuddy_collections c
    WHERE c.user_id = viewer
      AND c.status = 'owned'
      AND COALESCE(c.game_is_expansion, false) = false
    ORDER BY c.added_at DESC
    LIMIT max_bundles
  )
  SELECT COALESCE(jsonb_object_agg(o.game_id::text, bgb_game_detail_bundle(o.game_id, viewer, owned_plays_limit)), '{}'::jsonb)
    INTO v_game_bundles
    FROM owned o;

  RETURN jsonb_build_object(
    'game_detail_bundles', v_game_bundles,
    'owned_count', v_owned_count,
    'truncated', v_owned_count > max_bundles
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_game_bundles(viewer uuid, owned_plays_limit integer, max_bundles integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_game_bundles(viewer uuid, owned_plays_limit integer, max_bundles integer) TO boardgamebuddy_role;

-- bgb_game_summary(p_game_id uuid)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_game_summary(p_game_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
           'id', g.id,
           'bgg_id', g.bgg_id,
           'name', g.name,
           'year_published', g.year_published,
           'min_players', g.min_players,
           'max_players', g.max_players,
           'playing_time', g.playing_time,
           'thumbnail_url', g.thumbnail_url,
           'image_url', g.image_url,
           'theme_color', g.theme_color,
           'is_expansion', COALESCE(g.is_expansion, false),
           'base_game_bgg_id', g.base_game_bgg_id,
           'expansion_color', g.expansion_color,
           'rulebook_url', g.rulebook_url,
           'play_mode', COALESCE(g.play_mode, 'competitive')
         )
    FROM boardgamebuddy_games g
    WHERE g.id = p_game_id;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_game_summary(p_game_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_game_summary(p_game_id uuid) TO boardgamebuddy_role;

-- bgb_ghost_claim_suggestions(p_viewer uuid, p_limit integer, p_threshold real)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_ghost_claim_suggestions(p_viewer uuid, p_limit integer DEFAULT 10, p_threshold real DEFAULT 0.35)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_out JSONB;
BEGIN
  WITH me AS (
    SELECT lower(btrim(display_name)) AS dn, username
      FROM boardgamebuddy_profiles
     WHERE id = p_viewer
  ),
  owners AS (
    SELECT CASE WHEN be.user_a = p_viewer THEN be.user_b ELSE be.user_a END AS owner_id
      FROM boardgamebuddy_buddy_edges be
     WHERE be.status = 'accepted'
       AND p_viewer IN (be.user_a, be.user_b)
  ),
  ghost_rows AS (
    SELECT p.user_id AS owner_id,
           lower(btrim(pp.player_display_name)) AS name_key,
           btrim(pp.player_display_name) AS name_raw,
           p.played_at,
           p.game_name,
           EXISTS (
             SELECT 1 FROM boardgamebuddy_play_players s
              WHERE s.play_id = p.id AND s.player_user_id = p_viewer
           ) AS seats_viewer
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
     WHERE p.user_id IN (SELECT owner_id FROM owners)
       AND pp.player_user_id IS NULL
       AND btrim(COALESCE(pp.player_display_name, '')) <> ''
  ),
  grouped AS (
    SELECT owner_id,
           name_key,
           mode() WITHIN GROUP (ORDER BY name_raw) AS ghost_display_name,
           COUNT(*)::INT AS play_count,
           MAX(played_at) AS last_played_at,
           (array_agg(game_name ORDER BY played_at DESC))[1] AS last_game_name,
           bool_or(seats_viewer) AS collides
      FROM ghost_rows
     GROUP BY owner_id, name_key
  ),
  scored AS (
    SELECT g.*, m.score, m.is_match
      FROM grouped g, me, LATERAL (
        SELECT GREATEST(
                 extensions.similarity(g.name_key, me.dn),
                 extensions.similarity(g.name_key, me.username)
               ) AS score,
               (
                    extensions.similarity(g.name_key, me.dn) >= p_threshold
                 OR extensions.similarity(g.name_key, me.username) >= p_threshold
                 OR (
                      char_length(g.name_key) >= 3
                      AND position(' ' IN g.name_key) = 0
                      AND (
                           starts_with(me.dn, g.name_key)
                        OR starts_with(me.username, g.name_key)
                        OR g.name_key = split_part(me.dn, ' ', 1)
                      )
                    )
               ) AS is_match
      ) m
     -- A ghost the viewer is already seated beside is almost certainly not
     -- the viewer. Dropped whole, never partially — see bgb_create_ghost_claim.
     WHERE NOT g.collides
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY s_score DESC, s_count DESC, s_last DESC NULLS LAST), '[]'::jsonb)
    INTO v_out
    FROM (
      SELECT jsonb_build_object(
               'owner_user_id',      s.owner_id,
               'owner_display_name', pr.display_name,
               'owner_username',     pr.username,
               'owner_avatar',       pr.avatar,
               'ghost_display_name', s.ghost_display_name,
               'ghost_name_key',     s.name_key,
               'play_count',         s.play_count,
               'last_played_at',     s.last_played_at,
               'last_game_name',     s.last_game_name,
               'match_score',        round(s.score::numeric, 3),
               'claim_status',       c.status,
               'claim_id',           c.id
             ) AS x,
             s.score AS s_score,
             s.play_count AS s_count,
             s.last_played_at AS s_last
        FROM scored s
        JOIN boardgamebuddy_profiles pr ON pr.id = s.owner_id
        LEFT JOIN boardgamebuddy_ghost_claims c
               ON c.owner_id = s.owner_id
              AND c.ghost_name_key = s.name_key
              AND c.claimant_id = p_viewer
       WHERE s.is_match
         -- A PENDING claim is kept, and surfaced with claim_status so the row
         -- shows a disabled "Requested" chip instead of vanishing out from
         -- under the finger that just tapped it. Every other status means
         -- this ghost is settled and must stop appearing.
         AND (c.id IS NULL OR c.status = 'pending')
       ORDER BY s.score DESC, s.play_count DESC, s.last_played_at DESC NULLS LAST
       LIMIT GREATEST(p_limit, 0)
    ) q;

  RETURN COALESCE(v_out, '[]'::jsonb);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_claim_suggestions(p_viewer uuid, p_limit integer, p_threshold real) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claim_suggestions(p_viewer uuid, p_limit integer, p_threshold real) TO boardgamebuddy_role;

-- bgb_ghost_claims(p_viewer uuid)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_ghost_claims(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_incoming JSONB;
  v_outgoing JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(x ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_incoming
    FROM (
      SELECT jsonb_build_object(
               'id',                 c.id,
               'direction',          'incoming',
               'other_user_id',      pr.id,
               'other_display_name', pr.display_name,
               'other_username',     pr.username,
               'other_avatar',       pr.avatar,
               'ghost_display_name', c.ghost_display_name,
               'play_count',         COALESCE(st.play_count, 0),
               'last_played_at',     st.last_played_at,
               'created_at',         c.created_at
             ) AS x,
             c.created_at
        FROM boardgamebuddy_ghost_claims c
        JOIN boardgamebuddy_profiles pr ON pr.id = c.claimant_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::INT AS play_count, MAX(p.played_at) AS last_played_at
            FROM boardgamebuddy_plays p
            JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
           WHERE p.user_id = c.owner_id
             AND pp.player_user_id IS NULL
             AND lower(btrim(COALESCE(pp.player_display_name, ''))) = c.ghost_name_key
        ) st ON TRUE
       WHERE c.owner_id = p_viewer AND c.status = 'pending'
    ) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_outgoing
    FROM (
      SELECT jsonb_build_object(
               'id',                 c.id,
               'direction',          'outgoing',
               'other_user_id',      pr.id,
               'other_display_name', pr.display_name,
               'other_username',     pr.username,
               'other_avatar',       pr.avatar,
               'ghost_display_name', c.ghost_display_name,
               'play_count',         COALESCE(st.play_count, 0),
               'last_played_at',     st.last_played_at,
               'created_at',         c.created_at
             ) AS x,
             c.created_at
        FROM boardgamebuddy_ghost_claims c
        JOIN boardgamebuddy_profiles pr ON pr.id = c.owner_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::INT AS play_count, MAX(p.played_at) AS last_played_at
            FROM boardgamebuddy_plays p
            JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
           WHERE p.user_id = c.owner_id
             AND pp.player_user_id IS NULL
             AND lower(btrim(COALESCE(pp.player_display_name, ''))) = c.ghost_name_key
        ) st ON TRUE
       WHERE c.claimant_id = p_viewer AND c.status = 'pending'
    ) s;

  RETURN jsonb_build_object('incoming', v_incoming, 'outgoing', v_outgoing);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_claims(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claims(p_viewer uuid) TO boardgamebuddy_role;

-- bgb_ghost_out_of_plays(p_viewer uuid, p_play_ids uuid[], p_group_ids uuid[], p_batch_ids uuid[])
--   last defined in archive/2026-09-28/008_link_notifications.sql
CREATE OR REPLACE FUNCTION public.bgb_ghost_out_of_plays(p_viewer uuid, p_play_ids uuid[] DEFAULT '{}'::uuid[], p_group_ids uuid[] DEFAULT '{}'::uuid[], p_batch_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name    TEXT;
  v_plays   UUID[] := COALESCE(p_play_ids,  '{}'::uuid[]);
  v_groups  UUID[] := COALESCE(p_group_ids, '{}'::uuid[]);
  v_batches UUID[] := COALESCE(p_batch_ids, '{}'::uuid[]);
  v_updated INT;
BEGIN
  IF array_length(v_plays, 1) IS NULL
     AND array_length(v_groups, 1) IS NULL
     AND array_length(v_batches, 1) IS NULL THEN
    RETURN 0;
  END IF;

  SELECT display_name INTO v_name
  FROM boardgamebuddy_profiles WHERE id = p_viewer;

  -- The COALESCE is a defensive backfill: bgb_play_players_identity_chk needs
  -- one of (player_user_id, player_display_name), so nulling the first on a row
  -- that never carried the second would abort the whole statement. Rows written
  -- by _write_play_players always carry a name, so this normally changes
  -- nothing — but "normally" is not a constraint. NULLIF catches a name that is
  -- present but blank, which the CHECK accepts and a reader would not.
  UPDATE boardgamebuddy_play_players pp
     SET player_display_name =
           COALESCE(NULLIF(btrim(COALESCE(pp.player_display_name, '')), ''), v_name, 'Player'),
         player_user_id = NULL
    FROM boardgamebuddy_plays p
   WHERE p.id = pp.play_id
     AND pp.player_user_id = p_viewer
     AND p.user_id <> p_viewer
     AND (
           p.id = ANY(v_plays)
        OR (p.import_group_id IS NOT NULL AND p.import_group_id = ANY(v_groups))
        OR (p.import_batch_id IS NOT NULL AND p.import_batch_id = ANY(v_batches))
     );

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_out_of_plays(p_viewer uuid, p_play_ids uuid[], p_group_ids uuid[], p_batch_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_out_of_plays(p_viewer uuid, p_play_ids uuid[], p_group_ids uuid[], p_batch_ids uuid[]) TO boardgamebuddy_role;

-- bgb_ghost_summary(p_viewer uuid, p_owner uuid, p_name_key text)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_ghost_summary(p_viewer uuid, p_owner uuid, p_name_key text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH visible AS (
    SELECT p_viewer AS uid
    UNION
    SELECT CASE WHEN be.user_a = p_viewer THEN be.user_b ELSE be.user_a END
      FROM boardgamebuddy_buddy_edges be
     WHERE be.status = 'accepted'
       AND p_viewer IN (be.user_a, be.user_b)
  ),
  g_rows AS (
    SELECT p.played_at,
           p.game_name,
           btrim(pp.player_display_name) AS name_raw,
           EXISTS (
             SELECT 1 FROM boardgamebuddy_play_players s
              WHERE s.play_id = p.id AND s.player_user_id = p_viewer
           ) AS seats_viewer,
           (
             p.user_id IN (SELECT uid FROM visible)
             OR EXISTS (
               SELECT 1 FROM boardgamebuddy_play_players v
                WHERE v.play_id = p.id
                  AND v.player_user_id IN (SELECT uid FROM visible)
             )
           ) AS is_visible
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
     WHERE p.user_id = p_owner
       AND pp.player_user_id IS NULL
       AND lower(btrim(COALESCE(pp.player_display_name, ''))) = p_name_key
  )
  SELECT jsonb_build_object(
           'exists',             COUNT(*) > 0,
           'play_count',         COUNT(*)::INT,
           'last_played_at',     MAX(played_at),
           'last_game_name',     (array_agg(game_name ORDER BY played_at DESC))[1],
           'ghost_display_name', mode() WITHIN GROUP (ORDER BY name_raw),
           'collides',           COALESCE(bool_or(seats_viewer), false),
           'visible',            COALESCE(bool_or(is_visible), false)
         )
    FROM g_rows;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_summary(p_viewer uuid, p_owner uuid, p_name_key text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_summary(p_viewer uuid, p_owner uuid, p_name_key text) TO boardgamebuddy_role;

-- bgb_create_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_create_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key   TEXT := lower(btrim(COALESCE(p_display_name, '')));
  v_sum   JSONB;
  v_claim RECORD;
  v_has_claim BOOLEAN := false;
  v_id    UUID;
  v_out   JSONB;
BEGIN
  IF v_key = '' THEN
    RETURN jsonb_build_object('error', 'display_name_required');
  END IF;
  IF p_owner = p_claimant THEN
    -- Their own roster. POST /ghost-players/link is the tool for that.
    RETURN jsonb_build_object('error', 'own_roster');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_profiles WHERE id = p_owner) THEN
    RETURN jsonb_build_object('error', 'claim_not_found');
  END IF;

  SELECT * INTO v_claim
    FROM boardgamebuddy_ghost_claims
   WHERE owner_id = p_owner AND ghost_name_key = v_key AND claimant_id = p_claimant
     FOR UPDATE;
  v_has_claim := FOUND;

  -- Checked BEFORE the ghost lookup, and only for this claimant: once a claim
  -- is accepted the ghost rows no longer exist (they are the claimant's own
  -- rows now), so an exists-first order would answer a re-tap with the
  -- technically-true but useless "ghost_gone" instead of "that is already
  -- linked to your account".
  IF v_has_claim AND v_claim.status = 'accepted' THEN
    RETURN jsonb_build_object('error', 'already_linked');
  END IF;

  v_sum := bgb_ghost_summary(p_claimant, p_owner, v_key);

  IF NOT (v_sum->>'exists')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'ghost_gone');
  END IF;
  IF NOT (v_sum->>'visible')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'not_visible');
  END IF;
  IF (v_sum->>'collides')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'already_seated');
  END IF;

  IF v_has_claim THEN
    IF v_claim.status = 'pending' THEN
      -- Idempotent, matching buddy_service.send_request: asking twice is one ask.
      v_id := v_claim.id;
    ELSIF v_claim.reject_count >= 2 THEN
      RETURN jsonb_build_object('error', 'declined_twice');
    ELSE
      -- rejected (once), dismissed, or superseded: re-ask is allowed. The
      -- strike counter is NOT reset — that is what makes two strikes stick.
      UPDATE boardgamebuddy_ghost_claims
         SET status = 'pending',
             resolved_at = NULL,
             created_at = now(),
             ghost_display_name = COALESCE(v_sum->>'ghost_display_name', ghost_display_name)
       WHERE id = v_claim.id
       RETURNING id INTO v_id;
    END IF;
  ELSE
    INSERT INTO boardgamebuddy_ghost_claims
           (owner_id, ghost_name_key, ghost_display_name, claimant_id, status)
    VALUES (p_owner, v_key,
            COALESCE(v_sum->>'ghost_display_name', btrim(p_display_name)),
            p_claimant, 'pending')
    RETURNING id INTO v_id;
  END IF;

  SELECT jsonb_build_object(
           'id',                 c.id,
           'direction',          'outgoing',
           'other_user_id',      pr.id,
           'other_display_name', pr.display_name,
           'other_username',     pr.username,
           'other_avatar',       pr.avatar,
           'ghost_display_name', c.ghost_display_name,
           'play_count',         (v_sum->>'play_count')::INT,
           'last_played_at',     v_sum->'last_played_at',
           'created_at',         c.created_at
         )
    INTO v_out
    FROM boardgamebuddy_ghost_claims c
    JOIN boardgamebuddy_profiles pr ON pr.id = c.owner_id
   WHERE c.id = v_id;

  RETURN v_out;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_create_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_create_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text) TO boardgamebuddy_role;

-- bgb_dismiss_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_dismiss_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key TEXT := lower(btrim(COALESCE(p_display_name, '')));
  v_sum JSONB;
BEGIN
  IF v_key = '' THEN
    RETURN jsonb_build_object('error', 'display_name_required');
  END IF;
  IF p_owner = p_claimant THEN
    RETURN jsonb_build_object('error', 'own_roster');
  END IF;

  v_sum := bgb_ghost_summary(p_claimant, p_owner, v_key);

  INSERT INTO boardgamebuddy_ghost_claims
         (owner_id, ghost_name_key, ghost_display_name, claimant_id, status, resolved_at)
  VALUES (p_owner, v_key,
          COALESCE(v_sum->>'ghost_display_name', btrim(p_display_name)),
          p_claimant, 'dismissed', now())
  ON CONFLICT (owner_id, ghost_name_key, claimant_id) DO UPDATE
     SET status = 'dismissed', resolved_at = now()
   -- An accepted link is not a suggestion and must not be trampled by a
   -- stale "Not me" tap on a list rendered before the accept landed.
   WHERE boardgamebuddy_ghost_claims.status <> 'accepted';

  RETURN jsonb_build_object('dismissed', true);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_dismiss_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_dismiss_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text) TO boardgamebuddy_role;

-- bgb_ghost_claim_detail(p_viewer uuid, p_play_id uuid, p_display_name text)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_ghost_claim_detail(p_viewer uuid, p_play_id uuid, p_display_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key    TEXT := lower(btrim(COALESCE(p_display_name, '')));
  v_owner  UUID;
  v_sum    JSONB;
  v_claim  RECORD;
  v_has_claim BOOLEAN := false;
  v_reason TEXT := NULL;
  v_owner_row RECORD;
BEGIN
  IF v_key = '' THEN
    RETURN jsonb_build_object('error', 'display_name_required');
  END IF;

  SELECT user_id INTO v_owner FROM boardgamebuddy_plays WHERE id = p_play_id;
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('error', 'claim_not_found');
  END IF;

  v_sum := bgb_ghost_summary(p_viewer, v_owner, v_key);

  IF NOT (v_sum->>'exists')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'ghost_gone');
  END IF;
  IF NOT (v_sum->>'visible')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'not_visible');
  END IF;

  SELECT * INTO v_claim
    FROM boardgamebuddy_ghost_claims
   WHERE owner_id = v_owner AND ghost_name_key = v_key AND claimant_id = p_viewer;
  -- Latch it: every later SELECT INTO reassigns FOUND.
  v_has_claim := FOUND;

  IF v_owner = p_viewer THEN
    v_reason := 'own_roster';
  ELSIF (v_sum->>'collides')::BOOLEAN THEN
    v_reason := 'already_seated';
  ELSIF v_has_claim AND v_claim.status = 'accepted' THEN
    v_reason := 'already_linked';
  ELSIF v_has_claim AND v_claim.status = 'pending' THEN
    v_reason := 'pending';
  ELSIF v_has_claim AND v_claim.reject_count >= 2 THEN
    v_reason := 'declined_twice';
  END IF;

  SELECT display_name, username, avatar INTO v_owner_row
    FROM boardgamebuddy_profiles WHERE id = v_owner;

  RETURN jsonb_build_object(
    'owner_user_id',      v_owner,
    'owner_display_name', v_owner_row.display_name,
    'owner_username',     v_owner_row.username,
    'owner_avatar',       v_owner_row.avatar,
    'ghost_display_name', v_sum->>'ghost_display_name',
    'ghost_name_key',     v_key,
    'play_count',         (v_sum->>'play_count')::INT,
    'last_played_at',     v_sum->'last_played_at',
    'last_game_name',     v_sum->>'last_game_name',
    'match_score',        NULL::NUMERIC,
    'claim_status',       CASE WHEN v_has_claim THEN v_claim.status ELSE NULL END,
    'claim_id',           CASE WHEN v_has_claim THEN v_claim.id ELSE NULL END,
    'can_claim',          v_reason IS NULL,
    'blocked_reason',     v_reason
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_claim_detail(p_viewer uuid, p_play_id uuid, p_display_name text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claim_detail(p_viewer uuid, p_play_id uuid, p_display_name text) TO boardgamebuddy_role;

-- bgb_hot_games(window_days integer, lim integer)
--   last defined in archive/2026-09-28/013_hot_games_exclude_imports.sql
CREATE OR REPLACE FUNCTION public.bgb_hot_games(window_days integer DEFAULT 7, lim integer DEFAULT 10)
 RETURNS TABLE(game_id uuid, play_count bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.game_id, COUNT(*)::BIGINT AS play_count
  FROM public.boardgamebuddy_plays p
  WHERE p.played_at >= (CURRENT_DATE - (window_days || ' days')::INTERVAL)
    AND p.import_batch_id IS NULL
    AND p.import_group_id IS NULL
  GROUP BY p.game_id
  ORDER BY play_count DESC, p.game_id
  LIMIT lim;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_hot_games(window_days integer, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_hot_games(window_days integer, lim integer) TO boardgamebuddy_role;

-- bgb_joinable_sessions(p_viewer uuid)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_joinable_sessions(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_out JSONB;
BEGIN
  WITH buddies AS (
    SELECT CASE WHEN e.user_a = p_viewer THEN e.user_b ELSE e.user_a END AS buddy_id
    FROM boardgamebuddy_buddy_edges e
    WHERE e.status = 'accepted'
      AND (e.user_a = p_viewer OR e.user_b = p_viewer)
  ),
  visible AS (
    SELECT
      s.id,
      s.code,
      s.host_user_id,
      s.game_id,
      COALESCE(s.phase, 'gather') AS phase,
      s.created_at,
      (SELECT count(*)
         FROM boardgamebuddy_play_session_participants pp
         WHERE pp.session_id = s.id) AS participant_count,
      EXISTS (SELECT 1
                FROM boardgamebuddy_play_session_participants pp
                WHERE pp.session_id = s.id
                  AND pp.user_id = p_viewer) AS is_participant,
      s.host_user_id IN (SELECT buddy_id FROM buddies) AS is_host_buddy
    FROM boardgamebuddy_play_sessions s
    WHERE s.status = 'open'
      AND COALESCE(s.phase, 'gather') IN ('gather', 'play', 'settle')
      AND s.expires_at > now()
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', v.id,
           'code', v.code,
           'host_user_id', v.host_user_id,
           'host_display_name', COALESCE(pr.display_name, 'Host'),
           'host_avatar', pr.avatar,
           'game', bgb_game_summary(v.game_id),
           'phase', v.phase,
           'participant_count', v.participant_count,
           'is_participant', v.is_participant,
           'is_host_buddy', v.is_host_buddy,
           'created_at', v.created_at
         ) ORDER BY v.created_at DESC), '[]'::jsonb)
    INTO v_out
    FROM visible v
    LEFT JOIN boardgamebuddy_profiles pr ON pr.id = v.host_user_id
    WHERE v.is_participant
       OR v.host_user_id = p_viewer
       OR v.is_host_buddy;

  RETURN v_out;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_joinable_sessions(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_joinable_sessions(p_viewer uuid) TO boardgamebuddy_role;

-- bgb_link_ghost_rows(p_owner uuid, p_name_key text, p_target uuid)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_link_ghost_rows(p_owner uuid, p_name_key text, p_target uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated INT;
BEGIN
  -- Scoped to plays the owner logged, so a caller can never touch someone
  -- else's roster (the invariant migration 050 established).
  UPDATE boardgamebuddy_play_players pp
     SET player_user_id = p_target
   WHERE pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_owner
         )
     AND pp.player_user_id IS NULL
     AND lower(btrim(COALESCE(pp.player_display_name, ''))) = p_name_key;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_link_ghost_rows(p_owner uuid, p_name_key text, p_target uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_link_ghost_rows(p_owner uuid, p_name_key text, p_target uuid) TO boardgamebuddy_role;

-- bgb_accept_ghost_claim(p_owner uuid, p_claim_id uuid)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_accept_ghost_claim(p_owner uuid, p_claim_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_claim   RECORD;
  v_sum     JSONB;
  v_updated INT;
  v_out     JSONB;
BEGIN
  SELECT * INTO v_claim
    FROM boardgamebuddy_ghost_claims
   WHERE id = p_claim_id
     FOR UPDATE;

  -- 404 rather than 403 for a non-owner: do not confirm the claim exists.
  -- Same rule as buddy_service.reject_request.
  IF NOT FOUND OR v_claim.owner_id <> p_owner THEN
    RETURN jsonb_build_object('error', 'claim_not_found');
  END IF;
  IF v_claim.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'not_pending');
  END IF;

  v_sum := bgb_ghost_summary(v_claim.claimant_id, v_claim.owner_id, v_claim.ghost_name_key);
  IF (v_sum->>'collides')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'already_seated');
  END IF;

  v_updated := bgb_link_ghost_rows(v_claim.owner_id, v_claim.ghost_name_key, v_claim.claimant_id);

  IF v_updated = 0 THEN
    -- The ghost was renamed or its plays deleted between request and accept.
    -- The claim can never succeed now; retire it rather than leaving an
    -- Accept button that only ever errors.
    UPDATE boardgamebuddy_ghost_claims
       SET status = 'superseded', resolved_at = now()
     WHERE id = v_claim.id;
    RETURN jsonb_build_object('error', 'ghost_gone');
  END IF;

  UPDATE boardgamebuddy_ghost_claims
     SET status = 'accepted', resolved_at = now(), rows_merged = v_updated
   WHERE id = v_claim.id;

  -- Anyone else waiting on this same ghost is now waiting on rows that no
  -- longer exist. Retire their claims too, or the owner is left with Accept
  -- buttons that can only return ghost_gone.
  UPDATE boardgamebuddy_ghost_claims
     SET status = 'superseded', resolved_at = now()
   WHERE owner_id = v_claim.owner_id
     AND ghost_name_key = v_claim.ghost_name_key
     AND id <> v_claim.id
     AND status = 'pending';

  SELECT jsonb_build_object(
           'id',                 c.id,
           'direction',          'incoming',
           'other_user_id',      pr.id,
           'other_display_name', pr.display_name,
           'other_username',     pr.username,
           'other_avatar',       pr.avatar,
           'ghost_display_name', c.ghost_display_name,
           'play_count',         c.rows_merged,
           'last_played_at',     NULL::DATE,
           'created_at',         c.created_at
         )
    INTO v_out
    FROM boardgamebuddy_ghost_claims c
    JOIN boardgamebuddy_profiles pr ON pr.id = c.claimant_id
   WHERE c.id = v_claim.id;

  RETURN jsonb_build_object('updated', v_updated, 'claim', v_out);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_accept_ghost_claim(p_owner uuid, p_claim_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_accept_ghost_claim(p_owner uuid, p_claim_id uuid) TO boardgamebuddy_role;

-- bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid)
--   last defined in archive/2026-09-28/008_link_notifications.sql
CREATE OR REPLACE FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key TEXT := lower(btrim(COALESCE(p_display_name, '')));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_profiles WHERE id = p_target) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- One statement, so every row moved by one act of linking shares one
  -- timestamp — which is also what lets the notification list collapse a
  -- retroactive link across forty old plays into a single entry.
  UPDATE boardgamebuddy_play_players pp
     SET linked_at = now()
   WHERE pp.player_user_id IS NULL
     AND lower(btrim(COALESCE(pp.player_display_name, ''))) = v_key
     AND pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_viewer
         );

  RETURN jsonb_build_object(
    'updated',
    bgb_link_ghost_rows(p_viewer, v_key, p_target)
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid) TO boardgamebuddy_role;

-- bgb_list_imports(p_user uuid)
--   last defined in archive/2026-09-28/007_play_import_batches.sql
CREATE OR REPLACE FUNCTION public.bgb_list_imports(p_user uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(row_to_json(b) ORDER BY b.imported_at DESC NULLS LAST), '[]'::jsonb)
  FROM (
    SELECT
      p.import_batch_id                        AS batch_id,
      MIN(p.imported_at)                       AS imported_at,
      COUNT(*)::INT                            AS play_count,
      COUNT(DISTINCT p.game_id)::INT           AS game_count,
      -- Capped: a batch spanning fifteen games would otherwise push a
      -- paragraph into a settings row. The count beside it stays exact.
      (ARRAY_AGG(DISTINCT p.game_name ORDER BY p.game_name))[1:4] AS game_names,
      MIN(p.played_at)                         AS first_played_at,
      MAX(p.played_at)                         AS last_played_at
    FROM public.boardgamebuddy_plays p
    WHERE p.user_id = p_user
      AND p.import_batch_id IS NOT NULL
    GROUP BY p.import_batch_id
  ) b;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_list_imports(p_user uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_list_imports(p_user uuid) TO boardgamebuddy_role;

-- bgb_log_play(p_user uuid, p_payload jsonb)
--   last defined in archive/2026-09-28/048_play_teams.sql
CREATE OR REPLACE FUNCTION public.bgb_log_play(p_user uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_game        RECORD;
  v_mode        TEXT;
  v_play        RECORD;
  v_logged_name TEXT;
  v_roster      JSONB;
  v_players     JSONB;
  v_expansions  JSONB;
  v_client_key  UUID;
  v_existing    UUID;
  v_country     TEXT;
  v_group       UUID;
  v_batch       UUID;
  v_template    JSONB;
  v_bga_table   BIGINT;
  v_bgg_play_id BIGINT;
BEGIN
  -- Empty string and absent both mean "no key" — the client omits the field
  -- entirely for live writes, but a serializer that emits "" must not be read
  -- as a key shared by every unkeyed play.
  v_client_key := NULLIF(p_payload->>'client_key', '')::UUID;

  -- Migration 005. Set only by the Settings play importer, and only on plays
  -- it judged identical to at least one other in the same import: same game,
  -- same date, same players, same winner, and no score or note on either. The
  -- feed and the plays log show one card per group; every counter still sees
  -- the individual rows, which is the whole reason this is a tag rather than
  -- a row multiplier.
  v_group := NULLIF(p_payload->>'import_group_id', '')::UUID;

  -- Migration 007. One id per IMPORT, where the group above is one per RUN.
  -- Both are set only by the importer; a live log has neither, and neither is
  -- read by anything that counts plays.
  v_batch := NULLIF(p_payload->>'import_batch_id', '')::UUID;

  -- Migration 018. The scoring grid this play was scored on, snapshotted.
  -- jsonb 'null' and absent both mean "no template": the client sends an
  -- explicit null for a play scored on the plain R1..Rn grid.
  v_template := NULLIF(p_payload->'scoring_template', 'null'::jsonb);

  -- Migration 043. The BGA table this play came from, if any.
  v_bga_table := NULLIF(p_payload->>'bga_table_id', '')::BIGINT;

  -- Migration 044. The BoardGameGeek play this row came from, set only by the
  -- importer's BoardGameGeek source. Same empty-string rule as the two keys
  -- above.
  v_bgg_play_id := NULLIF(p_payload->>'bgg_play_id', '')::BIGINT;

  IF v_client_key IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.client_key = v_client_key;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- Migration 043. Same envelope, different key: a table already imported is
  -- not a failure, it is the answer "you already have this one".
  IF v_bga_table IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.bga_table_id = v_bga_table;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- Migration 044. The third key, and the only one that can see the plays the
  -- RETIRED POST /bgg/sync write path landed: those rows carry a bgg_play_id
  -- and no client_key at all, so nothing derived from the importer's own draft
  -- ids could ever recognise them. This is what makes re-importing from
  -- BoardGameGeek a no-op rather than a duplicate.
  IF v_bgg_play_id IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.bgg_play_id = v_bgg_play_id;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- Migration 023. The roster gate, before anything is written.
  SELECT COALESCE(jsonb_agg(kept.seat ORDER BY kept.ord), '[]'::JSONB)
    INTO v_roster
    FROM (
      SELECT s.seat, s.ord
        FROM jsonb_array_elements(COALESCE(p_payload->'players', '[]'::JSONB))
               WITH ORDINALITY AS s(seat, ord)
       WHERE NULLIF(btrim(COALESCE(s.seat->>'user_id', '')), '') IS NOT NULL
          OR NULLIF(btrim(COALESCE(s.seat->>'name', '')), '') IS NOT NULL
    ) kept;

  IF jsonb_array_length(v_roster) = 0 THEN
    RETURN jsonb_build_object('error', 'no_players');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_roster) AS s(seat)
     WHERE NULLIF(btrim(COALESCE(s.seat->>'user_id', '')), '') IS NOT NULL
     GROUP BY NULLIF(btrim(s.seat->>'user_id'), '')::UUID
    HAVING count(*) > 1
  ) THEN
    RETURN jsonb_build_object('error', 'duplicate_player');
  END IF;

  -- Migration 060. Unresolvable / malformed becomes NULL — "we don't know
  -- where this was played" is a legitimate row and a rejected save is not.
  v_country := upper(NULLIF(btrim(COALESCE(p_payload->>'country_code', '')), ''));
  IF v_country IS NOT NULL AND v_country !~ '^[A-Z]{2}$' THEN
    v_country := NULL;
  END IF;

  SELECT g.id, g.name, g.thumbnail_url, g.play_mode
    INTO v_game
    FROM boardgamebuddy_games g
   WHERE g.id = (p_payload->>'game_id')::UUID;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'game_not_found');
  END IF;

  -- Explicit override wins; otherwise inherit the game's intrinsic mode.
  v_mode := COALESCE(
    NULLIF(p_payload->>'play_mode', ''),
    v_game.play_mode,
    'competitive'
  );

  BEGIN
    INSERT INTO boardgamebuddy_plays (
      user_id, game_id, played_at, notes, photo_url, play_mode,
      game_name, game_thumbnail_url, client_key, country_code,
      import_group_id, import_batch_id, imported_at, scoring_template,
      bga_table_id, bgg_play_id
    )
    VALUES (
      p_user,
      v_game.id,
      (p_payload->>'played_at')::DATE,
      p_payload->>'notes',
      p_payload->>'photo_url',
      v_mode,
      v_game.name,
      v_game.thumbnail_url,
      v_client_key,
      v_country,
      v_group,
      v_batch,
      -- Stamped server-side, and only for an import: a client clock is the one
      -- thing here nobody should have to trust, and the Settings list orders by
      -- this value.
      CASE WHEN v_batch IS NULL THEN NULL ELSE now() END,
      v_template,
      v_bga_table,
      v_bgg_play_id
    )
    RETURNING id, created_at INTO v_play;
  EXCEPTION WHEN unique_violation THEN
    -- Lost the race against a concurrent flush of the same queued play, or
    -- against a concurrent import of the same BGA table. The winner's row is
    -- the canonical one; hand its id back on the same duplicate envelope the
    -- pre-checks use.
    --
    -- EVERY key, not just client_key (043, widened again by 044): there are
    -- three unique indexes a play can violate now, and resolving on the wrong
    -- one returns id: null — a wrong answer that raises nothing and looks like
    -- success. The BGG arm also covers the pending-imports worker still
    -- draining legacy kind='play' rows, which writes a bgg_play_id and no
    -- client_key, so that race was previously unresolvable by construction.
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user
       AND ((v_client_key  IS NOT NULL AND p.client_key   = v_client_key)
         OR (v_bga_table   IS NOT NULL AND p.bga_table_id = v_bga_table)
         OR (v_bgg_play_id IS NOT NULL AND p.bgg_play_id  = v_bgg_play_id));
    RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
  END;

  INSERT INTO boardgamebuddy_play_players (
    play_id, player_user_id, player_display_name, is_winner, score, round_scores,
    team
  )
  SELECT
    v_play.id,
    pl.user_id,
    pl.name,
    COALESCE(pl.is_winner, false),
    pl.score,
    pl.round_scores,
    -- '' is the COMMON case, not an edge one: the client seeds every seat with
    -- team:"" and writes "" back when a tag is cleared. Stored as NULL, or
    -- every untagged seat in the app would share one anonymous side.
    NULLIF(btrim(pl.team), '')
  FROM jsonb_to_recordset(v_roster)
         AS pl(name TEXT, is_winner BOOLEAN, score INTEGER,
               user_id UUID, round_scores JSONB, team TEXT);

  -- DISTINCT guards the (play_id, expansion_game_id) primary key against a
  -- payload that repeats an id.
  INSERT INTO boardgamebuddy_play_expansions (play_id, expansion_game_id)
  SELECT DISTINCT v_play.id, eid::UUID
    FROM jsonb_array_elements_text(
           COALESCE(p_payload->'expansion_ids', '[]'::JSONB)
         ) AS eid
   WHERE COALESCE(eid, '') <> '';

  SELECT pr.display_name INTO v_logged_name
    FROM boardgamebuddy_profiles pr
   WHERE pr.id = p_user;

  -- Response blocks are built from the NORMALIZED roster (plus the profile/game
  -- joins they need), not by reading the rows back — the values are identical
  -- and WITH ORDINALITY keeps the player list in the order the host entered it,
  -- which a RETURNING or a re-SELECT wouldn't guarantee.
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'user_id',      pl.user_id,
             'name',         COALESCE(prof.display_name, pl.name, 'Unknown'),
             'avatar',       prof.avatar,
             'is_winner',    COALESCE(pl.is_winner, false),
             'score',        pl.score,
             'round_scores', pl.round_scores,
             -- Echoed from the same NULLIF the INSERT used, for the reason
             -- country_code is echoed from its normalized local below: the
             -- client has to read back the value that actually landed.
             'team',         NULLIF(btrim(pl.team), '')
           ) ORDER BY pl.ord
         ), '[]'::JSONB)
    INTO v_players
    FROM ROWS FROM (
           jsonb_to_recordset(v_roster)
             AS (name TEXT, is_winner BOOLEAN, score INTEGER,
                 user_id UUID, round_scores JSONB, team TEXT)
         ) WITH ORDINALITY AS pl(name, is_winner, score, user_id, round_scores,
                                 team, ord)
    LEFT JOIN boardgamebuddy_profiles prof ON prof.id = pl.user_id;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'expansion_game_id', eg.id,
             'name',              eg.name,
             'color',             eg.expansion_color
           ) ORDER BY eg.name
         ), '[]'::JSONB)
    INTO v_expansions
    FROM (
      SELECT DISTINCT eid::UUID AS id
        FROM jsonb_array_elements_text(
               COALESCE(p_payload->'expansion_ids', '[]'::JSONB)
             ) AS eid
       WHERE COALESCE(eid, '') <> ''
    ) picked
    JOIN boardgamebuddy_games eg ON eg.id = picked.id;

  -- country_code is echoed from the NORMALIZED local, not from the payload:
  -- the client has to see the value that actually landed, or a "gb" it sent
  -- would read back as "gb" while the row holds "GB". scoring_template is
  -- echoed from its local for the same reason (an absent key vs. an explicit
  -- null must read back identically).
  RETURN jsonb_build_object(
    'id',               v_play.id,
    'game_id',          v_game.id,
    'game_name',        v_game.name,
    'game_thumbnail',   v_game.thumbnail_url,
    'played_at',        (p_payload->>'played_at')::DATE,
    'notes',            p_payload->>'notes',
    'players',          v_players,
    'photo_url',        p_payload->>'photo_url',
    'expansions',       v_expansions,
    'created_at',       v_play.created_at,
    'play_mode',        v_mode,
    'country_code',     v_country,
    'scoring_template', v_template,
    'group_count',      1,
    'logged_by_id',     p_user,
    'logged_by_name',   COALESCE(v_logged_name, ''),
    'is_own',           true
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_log_play(p_user uuid, p_payload jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_log_play(p_user uuid, p_payload jsonb) TO boardgamebuddy_role;

-- bgb_finalize_session(p_host uuid, p_code text, p_payload jsonb)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_finalize_session(p_host uuid, p_code text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session RECORD;
  v_play    JSONB;
BEGIN
  SELECT s.id, s.host_user_id, s.expires_at
    INTO v_session
    FROM boardgamebuddy_play_sessions s
   WHERE s.code = upper(p_code)
     AND s.status = 'open';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_session.expires_at < now() THEN
    UPDATE boardgamebuddy_play_sessions
       SET status = 'abandoned'
     WHERE id = v_session.id;
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  IF v_session.host_user_id <> p_host THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  v_play := bgb_log_play(p_host, p_payload);

  -- A failed write (e.g. game_not_found) must not finalize the lobby —
  -- the host stays on Settle Up and can retry.
  IF v_play ? 'error' THEN
    RETURN v_play;
  END IF;

  UPDATE boardgamebuddy_play_sessions
     SET status            = 'finalized',
         phase             = 'finalized',
         finalized_play_id = (v_play->>'id')::UUID,
         finalized_at      = now()
   WHERE id = v_session.id;

  RETURN v_play;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_finalize_session(p_host uuid, p_code text, p_payload jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_finalize_session(p_host uuid, p_code text, p_payload jsonb) TO boardgamebuddy_role;

-- bgb_import_plays(p_user uuid, p_payload jsonb)
--   last defined in archive/2026-09-28/004_import_plays_rpc.sql
CREATE OR REPLACE FUNCTION public.bgb_import_plays(p_user uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item     JSONB;
  v_result   JSONB;
  v_results  JSONB := '[]'::JSONB;
  v_index    INT := 0;
  v_imported INT := 0;
  v_dupes    INT := 0;
  v_failed   INT := 0;
BEGIN
  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'plays', '[]'::JSONB))
  LOOP
    v_result := public.bgb_log_play(p_user, v_item);

    IF v_result ? 'error' THEN
      v_failed := v_failed + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', v_index, 'id', NULL, 'duplicate', false,
        'error', v_result->>'error'
      ));
    ELSIF COALESCE((v_result->>'duplicate')::BOOLEAN, false) THEN
      -- A client_key this user already holds a play for. The importer stamps
      -- one UUID per expanded play and re-sends it on a retry, so this is the
      -- branch that makes re-running a half-finished import safe.
      v_dupes := v_dupes + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', v_index, 'id', v_result->>'id', 'duplicate', true, 'error', NULL
      ));
    ELSE
      v_imported := v_imported + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', v_index, 'id', v_result->>'id', 'duplicate', false, 'error', NULL
      ));
    END IF;

    v_index := v_index + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'imported',  v_imported,
    'duplicate', v_dupes,
    'failed',    v_failed,
    'results',   v_results
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_import_plays(p_user uuid, p_payload jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_import_plays(p_user uuid, p_payload jsonb) TO boardgamebuddy_role;

-- bgb_mark_link_notifications_seen(p_viewer uuid, p_through timestamp with time zone)
--   last defined in archive/2026-09-28/008_link_notifications.sql
CREATE OR REPLACE FUNCTION public.bgb_mark_link_notifications_seen(p_viewer uuid, p_through timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_through TIMESTAMPTZ := COALESCE(p_through, now());
  v_result  TIMESTAMPTZ;
BEGIN
  UPDATE boardgamebuddy_profiles
     SET link_notifications_seen_at =
           GREATEST(COALESCE(link_notifications_seen_at, '-infinity'::timestamptz), v_through)
   WHERE id = p_viewer
   RETURNING link_notifications_seen_at INTO v_result;
  RETURN v_result;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_mark_link_notifications_seen(p_viewer uuid, p_through timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_mark_link_notifications_seen(p_viewer uuid, p_through timestamp with time zone) TO boardgamebuddy_role;

-- bgb_mark_release_notices_seen(p_viewer uuid, p_through timestamp with time zone)
--   last defined in archive/2026-09-28/042_release_notices.sql
CREATE OR REPLACE FUNCTION public.bgb_mark_release_notices_seen(p_viewer uuid, p_through timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_through TIMESTAMPTZ := COALESCE(p_through, now());
  v_result  TIMESTAMPTZ;
BEGIN
  UPDATE public.boardgamebuddy_profiles
     SET release_notices_seen_at = GREATEST(release_notices_seen_at, v_through)
   WHERE id = p_viewer
   RETURNING release_notices_seen_at INTO v_result;
  RETURN v_result;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_mark_release_notices_seen(p_viewer uuid, p_through timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_mark_release_notices_seen(p_viewer uuid, p_through timestamp with time zone) TO boardgamebuddy_role;

-- bgb_merge_ghosts(p_viewer uuid, p_source text, p_target text)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_merge_ghosts(p_viewer uuid, p_source text, p_target text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated INT;
BEGIN
  UPDATE boardgamebuddy_play_players pp
     SET player_display_name = p_target
   WHERE pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_viewer
         )
     AND pp.player_display_name ILIKE p_source
     AND pp.player_user_id IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_updated);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_merge_ghosts(p_viewer uuid, p_source text, p_target text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_merge_ghosts(p_viewer uuid, p_source text, p_target text) TO boardgamebuddy_role;

-- bgb_notifications(p_viewer uuid, p_limit integer, p_before timestamp with time zone, p_before_key text)
--   last defined in archive/2026-09-28/051_account_deletion_handover.sql
CREATE OR REPLACE FUNCTION public.bgb_notifications(p_viewer uuid, p_limit integer DEFAULT 20, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_key text DEFAULT NULL::text)
 RETURNS TABLE(entry_key text, kind text, occurred_at timestamp with time zone, is_unread boolean, actor_id uuid, actor_display_name text, actor_username text, actor_avatar jsonb, play_group text, play_id uuid, play_ids uuid[], group_count integer, game_count integer, played_from date, played_to date, game_id uuid, game_name text, game_thumbnail_url text, import_batch_id uuid, edge_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_seen TIMESTAMPTZ;
  v_lim  INT := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
BEGIN
  SELECT pr.link_notifications_seen_at INTO v_seen
  FROM boardgamebuddy_profiles pr WHERE pr.id = p_viewer;

  RETURN QUERY
  WITH seats AS (
    -- The viewer's own seats on plays SOMEBODY ELSE logged, carrying their
    -- grouping key and nothing more. This is also the whole visibility rule:
    -- every row is a play the viewer is a player in, so there is nothing to
    -- leak and no buddy-graph check to run.
    --
    -- to_char at UTC rather than l_at::text, unchanged from 009: the key is the
    -- paging tiebreak and travels to the client and back, so it has to mean the
    -- same thing on both ends of that trip regardless of the session's TimeZone
    -- and DateStyle.
    SELECT pp.play_id   AS p_id,
           pp.linked_at AS l_at,
           p.user_id    AS o_id,
           CASE
             WHEN p.import_batch_id IS NOT NULL THEN 'b:' || p.import_batch_id::text
             WHEN p.import_group_id IS NOT NULL THEN 'g:' || p.import_group_id::text
             ELSE 'a:' || p.user_id::text || ':'
                  || to_char(pp.linked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
           END AS k,
           CASE
             WHEN p.import_batch_id IS NOT NULL THEN 'batch'
             WHEN p.import_group_id IS NOT NULL THEN 'run'
             ELSE 'act'
           END AS kd
    FROM boardgamebuddy_play_players pp
    JOIN boardgamebuddy_plays p ON p.id = pp.play_id
    WHERE pp.player_user_id = p_viewer
      AND p.user_id <> p_viewer
  ),
  page_keys AS (
    -- Which entries are on this page. MAX is the only aggregate here, and the
    -- ORDER BY / LIMIT are the ones the final SELECT would have applied anyway
    -- — just applied before the expensive work instead of after it.
    SELECT s.k AS k, s.kd AS kd, s.o_id AS o_id, MAX(s.l_at) AS l_at
    FROM seats s
    GROUP BY s.k, s.kd, s.o_id
    HAVING p_before IS NULL
        OR (MAX(s.l_at), s.k) < (p_before, COALESCE(p_before_key, ''))
    ORDER BY MAX(s.l_at) DESC, s.k DESC
    LIMIT v_lim
  ),
  members AS (
    -- Every seat belonging to a chosen entry, now with the wide columns. The
    -- join to plays is by primary key and runs for these rows only.
    SELECT pk.k AS k, pk.kd AS kd, pk.o_id AS o_id, s.l_at AS l_at,
           p.id AS p_id, p.game_id AS g_id, p.played_at AS p_at,
           p.game_name AS g_name, p.game_thumbnail_url AS g_thumb,
           p.import_batch_id AS b_id
    FROM seats s
    JOIN page_keys pk ON pk.k = s.k AND pk.kd = s.kd AND pk.o_id = s.o_id
    JOIN boardgamebuddy_plays p ON p.id = s.p_id
  ),
  entries AS (
    SELECT m.k AS k, m.kd AS kd, m.o_id AS o_id,
           MAX(m.l_at)                    AS l_at,
           COUNT(*)::int                  AS n_plays,
           COUNT(DISTINCT m.g_id)::int    AS n_games,
           MIN(m.p_at)                    AS from_at,
           MAX(m.p_at)                    AS to_at,
           array_agg(m.p_id ORDER BY m.p_at DESC NULLS LAST, m.p_id) AS ids,
           -- No MIN()/MAX() aggregate exists for uuid, so the representative is
           -- picked by ordering rather than aggregated. It is the most recent
           -- play in the entry — the one the card names and opens.
           (array_agg(m.p_id    ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep,
           (array_agg(m.g_id    ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep_game,
           (array_agg(m.g_name  ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep_name,
           (array_agg(m.g_thumb ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep_thumb,
           (array_agg(m.b_id    ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep_batch
    FROM members m
    GROUP BY m.k, m.kd, m.o_id
  ),
  -- Each source is normalised to the SAME wide row inside its own CTE, so the
  -- NULL casts are written once per branch rather than smeared through a union
  -- of bare SELECTs, and the cursor, the order and the limit are applied
  -- exactly once at the end over the merge.
  play_rows AS (
    SELECT e.k                                   AS ekey,
           'play_link'::text                     AS nkind,
           e.l_at                                AS occ,
           e.o_id                                AS act_id,
           NULL::text                            AS act_name,
           e.kd                                  AS pgroup,
           e.rep                                 AS rep_play,
           e.ids                                 AS rep_plays,
           e.n_plays                             AS n_plays,
           e.n_games                             AS n_games,
           e.from_at                             AS from_at,
           e.to_at                               AS to_at,
           e.rep_game                            AS rep_game,
           -- game_name / game_thumbnail_url are denormalized (migration 020)
           -- and null on rows written before it, so fall back to the catalog
           -- the same way bgb_collection_shelf does.
           COALESCE(e.rep_name, g.name)          AS rep_name,
           COALESCE(e.rep_thumb, g.thumbnail_url) AS rep_thumb,
           e.rep_batch                           AS rep_batch,
           NULL::uuid                            AS e_id
    FROM entries e
    LEFT JOIN boardgamebuddy_games g ON g.id = e.rep_game
  ),
  -- Somebody asked to be your buddy and you have not answered. Accept flips the
  -- edge to 'accepted' and both Decline and Cancel DELETE it, so this row
  -- leaves the feed the instant it is acted on, from either side and with no
  -- bookkeeping — the same self-healing the play source gets from being derived.
  request_rows AS (
    SELECT 'req:' || be.id::text  AS ekey,
           'buddy_request'::text  AS nkind,
           be.created_at          AS occ,
           be.requested_by        AS act_id,
           NULL::text   AS act_name,
           NULL::text   AS pgroup,    NULL::uuid AS rep_play,
           NULL::uuid[] AS rep_plays,  NULL::int  AS n_plays,
           NULL::int    AS n_games,    NULL::date AS from_at,
           NULL::date   AS to_at,      NULL::uuid AS rep_game,
           NULL::text   AS rep_name,   NULL::text AS rep_thumb,
           NULL::uuid   AS rep_batch,
           be.id                  AS e_id
    FROM boardgamebuddy_buddy_edges be
    WHERE be.status = 'pending'
      AND be.requested_by <> p_viewer
      AND (be.user_a = p_viewer OR be.user_b = p_viewer)
  ),
  -- Somebody said yes. Keyed on accepted_by, never on requested_by: see 009's
  -- rationale for that column for why the QR path makes the distinction
  -- load-bearing rather than pedantic. `accepted_by <> p_viewer` is what stops
  -- the feed announcing an act the viewer performed themselves.
  accepted_rows AS (
    SELECT 'acc:' || be.id::text  AS ekey,
           'buddy_accepted'::text AS nkind,
           be.accepted_at         AS occ,
           be.accepted_by         AS act_id,
           NULL::text   AS act_name,
           NULL::text   AS pgroup,    NULL::uuid AS rep_play,
           NULL::uuid[] AS rep_plays,  NULL::int  AS n_plays,
           NULL::int    AS n_games,    NULL::date AS from_at,
           NULL::date   AS to_at,      NULL::uuid AS rep_game,
           NULL::text   AS rep_name,   NULL::text AS rep_thumb,
           NULL::uuid   AS rep_batch,
           be.id                  AS e_id
    FROM boardgamebuddy_buddy_edges be
    WHERE be.status = 'accepted'
      AND be.accepted_at IS NOT NULL
      AND be.accepted_by IS NOT NULL
      AND be.accepted_by <> p_viewer
      AND (be.user_a = p_viewer OR be.user_b = p_viewer)
  ),
  -- A play that passed to the viewer because the account that logged it was
  -- deleted (051). The fourth kind, and the only one with no actor to join to
  -- — the person IS the actor and their profile row is gone, which is the
  -- whole event. So the name rides up the union in act_name and the final
  -- SELECT coalesces it against the join that is going to miss. That is what
  -- keeps RETURNS TABLE unchanged and this a REPLACE rather than a DROP.
  --
  -- One row per play and no grouping, deliberately: the import groupings that
  -- play_link uses answer "these twelve arrived together", and a handover is
  -- not a batch — the plays it moves need have nothing to do with each other
  -- beyond the person who is gone.
  inherited_rows AS (
    SELECT 'inh:' || p.id::text     AS ekey,
           'play_inherited'::text   AS nkind,
           p.inherited_at           AS occ,
           NULL::uuid               AS act_id,
           p.inherited_from_name    AS act_name,
           NULL::text               AS pgroup,
           p.id                     AS rep_play,
           ARRAY[p.id]::uuid[]      AS rep_plays,
           1::int                   AS n_plays,
           1::int                   AS n_games,
           p.played_at              AS from_at,
           p.played_at              AS to_at,
           p.game_id                AS rep_game,
           -- Same catalog fallback play_rows uses: the denormalized pair is
           -- null on rows written before migration 020.
           COALESCE(p.game_name, g.name)                    AS rep_name,
           COALESCE(p.game_thumbnail_url, g.thumbnail_url)  AS rep_thumb,
           NULL::uuid               AS rep_batch,
           NULL::uuid               AS e_id
    FROM boardgamebuddy_plays p
    LEFT JOIN boardgamebuddy_games g ON g.id = p.game_id
    WHERE p.user_id = p_viewer
      AND p.inherited_at IS NOT NULL
  ),
  merged AS (
    SELECT * FROM play_rows
    UNION ALL SELECT * FROM request_rows
    UNION ALL SELECT * FROM accepted_rows
    UNION ALL SELECT * FROM inherited_rows
  )
  SELECT m.ekey, m.nkind, m.occ,
         (m.occ > COALESCE(v_seen, '-infinity'::timestamptz)),
         -- The coalesce is for play_inherited alone: every other kind has a
         -- live profile behind act_id, and that arm has no act_id at all.
         m.act_id, COALESCE(pr.display_name, m.act_name), pr.username, pr.avatar,
         m.pgroup, m.rep_play, m.rep_plays, m.n_plays, m.n_games,
         m.from_at, m.to_at, m.rep_game, m.rep_name, m.rep_thumb, m.rep_batch,
         m.e_id
  FROM merged m
  LEFT JOIN boardgamebuddy_profiles pr ON pr.id = m.act_id
  -- Keyset, not OFFSET: rows vanish from under the cursor as the user unlinks
  -- and as requests are answered, and an offset would skip whatever slid up
  -- into the gap. Still applied here over the whole union — page_keys has
  -- already applied the identical predicate to the play arm, which is a
  -- redundancy on that arm and the only filter the two buddy arms get.
  WHERE p_before IS NULL
     OR (m.occ, m.ekey) < (p_before, COALESCE(p_before_key, ''))
  ORDER BY m.occ DESC, m.ekey DESC
  LIMIT v_lim;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_notifications(p_viewer uuid, p_limit integer, p_before timestamp with time zone, p_before_key text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_notifications(p_viewer uuid, p_limit integer, p_before timestamp with time zone, p_before_key text) TO boardgamebuddy_role;

-- bgb_notifications_unread(p_viewer uuid)
--   last defined in archive/2026-09-28/051_account_deletion_handover.sql
CREATE OR REPLACE FUNCTION public.bgb_notifications_unread(p_viewer uuid)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_seen TIMESTAMPTZ;
  v_n    INT;
BEGIN
  SELECT pr.link_notifications_seen_at INTO v_seen
  FROM boardgamebuddy_profiles pr WHERE pr.id = p_viewer;
  -- Both a NULL column and a missing profile row mean "has read nothing".
  v_seen := COALESCE(v_seen, '-infinity'::timestamptz);

  SELECT
      -- Play ENTRIES, not plays: a badge reading 214 over a list showing one
      -- row is a bug that only appears on the accounts that most need this
      -- feature. Same key expression bgb_notifications groups by, below.
      (SELECT COUNT(*)::int FROM (
         SELECT 1
         FROM boardgamebuddy_play_players pp
         JOIN boardgamebuddy_plays p ON p.id = pp.play_id
         WHERE pp.player_user_id = p_viewer
           AND pp.linked_at > v_seen
           AND p.user_id <> p_viewer
         GROUP BY CASE
                    WHEN p.import_batch_id IS NOT NULL THEN 'b:' || p.import_batch_id::text
                    WHEN p.import_group_id IS NOT NULL THEN 'g:' || p.import_group_id::text
                    ELSE 'a:' || p.user_id::text || ':'
                         || to_char(pp.linked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
                  END
       ) e)
      -- The two buddy terms are plain row counts: an edge is already one row
      -- per event. One account's pending and accepted sets are small, which is
      -- 009's reason for giving them no index of their own — that still holds.
    + (SELECT COUNT(*)::int
         FROM boardgamebuddy_buddy_edges be
        WHERE be.status = 'pending'
          AND be.requested_by <> p_viewer
          AND (be.user_a = p_viewer OR be.user_b = p_viewer)
          AND be.created_at > v_seen)
    + (SELECT COUNT(*)::int
         FROM boardgamebuddy_buddy_edges be
        WHERE be.status = 'accepted'
          AND be.accepted_at IS NOT NULL
          AND be.accepted_by IS NOT NULL
          AND be.accepted_by <> p_viewer
          AND (be.user_a = p_viewer OR be.user_b = p_viewer)
          AND be.accepted_at > v_seen)
      -- A play handed over by a deleted account (051). One row per play, no
      -- grouping: a handover is not a batch and two of them are two events.
      -- Rides idx_bgb_plays_inherited, so an account that has never inherited
      -- anything — which is almost all of them — scans nothing.
    + (SELECT COUNT(*)::int
         FROM boardgamebuddy_plays p
        WHERE p.user_id = p_viewer
          AND p.inherited_at IS NOT NULL
          AND p.inherited_at > v_seen)
    INTO v_n;

  RETURN v_n;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_notifications_unread(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_notifications_unread(p_viewer uuid) TO boardgamebuddy_role;

-- bgb_onboarding_buddy_suggestions(uid uuid, lim integer, active_window_days integer)
--   last defined in archive/2026-09-28/014_buddy_suggestion_dismissals.sql
CREATE OR REPLACE FUNCTION public.bgb_onboarding_buddy_suggestions(uid uuid, lim integer DEFAULT 12, active_window_days integer DEFAULT 90)
 RETURNS TABLE(user_id uuid, mutual_count bigint, play_count bigint, pending_mutual_count bigint, via_user_id uuid, source text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH my_edges AS (
    SELECT be.user_a, be.user_b, be.status, be.requested_by
      FROM public.boardgamebuddy_buddy_edges be
     WHERE uid IN (be.user_a, be.user_b)
  ),
  connected AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS other_id
      FROM my_edges me
  ),
  -- NEW here — see bgb_suggested_buddies above.
  dismissed AS (
    SELECT d.dismissed_user_id AS other_id
      FROM public.boardgamebuddy_buddy_suggestion_dismissals d
     WHERE d.user_id = uid
  ),
  my_buddies AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS friend_id
      FROM my_edges me
     WHERE me.status = 'accepted'
  ),
  my_requested AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS target_id
      FROM my_edges me
     WHERE me.status = 'pending' AND me.requested_by = uid
  ),
  fof AS (
    SELECT
      CASE WHEN be.user_a = mb.friend_id THEN be.user_b ELSE be.user_a END AS candidate,
      mb.friend_id
    FROM my_buddies mb
    JOIN public.boardgamebuddy_buddy_edges be
      ON be.status = 'accepted'
     AND mb.friend_id IN (be.user_a, be.user_b)
  ),
  mutuals AS (
    SELECT fof.candidate,
           COUNT(DISTINCT fof.friend_id)::BIGINT AS n,
           -- Postgres has no min(uuid); array_agg + [1] is the deterministic
           -- "pick one" and reads as the choice it is.
           (ARRAY_AGG(fof.friend_id ORDER BY fof.friend_id))[1] AS via_any
      FROM fof
     GROUP BY fof.candidate
  ),
  fof_pending AS (
    SELECT
      CASE WHEN be.user_a = mr.target_id THEN be.user_b ELSE be.user_a END AS candidate,
      mr.target_id AS via
    FROM my_requested mr
    JOIN public.boardgamebuddy_buddy_edges be
      ON be.status = 'accepted'
     AND mr.target_id IN (be.user_a, be.user_b)
  ),
  pending_mutuals AS (
    SELECT fof_pending.candidate,
           COUNT(DISTINCT fof_pending.via)::BIGINT AS n,
           (ARRAY_AGG(fof_pending.via ORDER BY fof_pending.via))[1] AS via_any
      FROM fof_pending
     GROUP BY fof_pending.candidate
  ),
  -- Same visibility rule as bgb_suggested_buddies / bgb_play_partners: plays
  -- the viewer logged, plus plays the viewer was a player in.
  visible_plays AS (
    SELECT p.id FROM public.boardgamebuddy_plays p WHERE p.user_id = uid
    UNION
    SELECT pp.play_id
      FROM public.boardgamebuddy_play_players pp
     WHERE pp.player_user_id = uid
  ),
  played_with AS (
    SELECT pp.player_user_id AS candidate, COUNT(*)::BIGINT AS n
      FROM public.boardgamebuddy_play_players pp
      JOIN visible_plays v ON v.id = pp.play_id
     WHERE pp.player_user_id IS NOT NULL
     GROUP BY pp.player_user_id
  ),
  candidate_ids AS (
    SELECT candidate FROM mutuals
    UNION
    SELECT candidate FROM pending_mutuals
    UNION
    SELECT candidate FROM played_with
  ),
  graph AS (
    SELECT
      ci.candidate,
      COALESCE(m.n, 0)  AS mutuals,
      COALESCE(w.n, 0)  AS plays,
      COALESCE(pm.n, 0) AS pending_mutuals,
      COALESCE(m.via_any, pm.via_any) AS via_user_id
    FROM candidate_ids ci
    LEFT JOIN mutuals         m  ON m.candidate  = ci.candidate
    LEFT JOIN pending_mutuals pm ON pm.candidate = ci.candidate
    LEFT JOIN played_with     w  ON w.candidate  = ci.candidate
  ),
  -- Suggestable at all: a real, set-up profile that is neither the viewer,
  -- already connected to them, nor someone they have dismissed. Both tiers
  -- below draw from this.
  eligible AS (
    SELECT pr.id, pr.created_at
      FROM public.boardgamebuddy_profiles pr
     WHERE pr.id <> uid
       AND pr.needs_setup IS NOT TRUE
       AND pr.id NOT IN (SELECT c.other_id FROM connected c)
       AND pr.id NOT IN (SELECT d.other_id FROM dismissed d)   -- added in 014 (this file)
  ),
  tier_graph AS (
    SELECT
      e.id                AS user_id,
      g.mutuals           AS mutual_count,
      g.plays             AS play_count,
      g.pending_mutuals   AS pending_mutual_count,
      g.via_user_id       AS via_user_id,
      'graph'::TEXT       AS source,
      0                   AS tier,
      -- Played-with outranks a graph path, most plays first (057's rule);
      -- a request nobody has answered yet sorts under both (072's).
      ROW_NUMBER() OVER (
        ORDER BY (g.plays > 0) DESC, g.plays DESC, g.mutuals DESC,
                 g.pending_mutuals DESC, e.id
      )                   AS rank_in_tier
    FROM graph g
    JOIN eligible e ON e.id = g.candidate
    WHERE g.mutuals > 0 OR g.plays > 0 OR g.pending_mutuals > 0
  ),
  -- Plays LOGGED in the window, by whoever logged them. Deliberately not the
  -- participated-in union used above: this is "who is running game nights",
  -- and a play counts once for the account that put it in the app.
  recent_activity AS (
    SELECT p.user_id AS candidate, COUNT(*)::BIGINT AS n
      FROM public.boardgamebuddy_plays p
     WHERE p.created_at >= now() - make_interval(days => GREATEST(active_window_days, 1))
     GROUP BY p.user_id
  ),
  tier_active AS (
    SELECT
      e.id                          AS user_id,
      0::BIGINT                     AS mutual_count,
      0::BIGINT                     AS play_count,
      0::BIGINT                     AS pending_mutual_count,
      NULL::UUID                    AS via_user_id,
      'active'::TEXT                AS source,
      1                             AS tier,
      -- Most active first; newest accounts break ties, so a quiet community
      -- still surfaces the people who just arrived rather than the same
      -- alphabetical head every time.
      ROW_NUMBER() OVER (
        ORDER BY COALESCE(ra.n, 0) DESC, e.created_at DESC, e.id
      )                             AS rank_in_tier
    FROM eligible e
    LEFT JOIN recent_activity ra ON ra.candidate = e.id
    WHERE e.id NOT IN (SELECT tg.user_id FROM tier_graph tg)
  )
  SELECT t.user_id, t.mutual_count, t.play_count,
         t.pending_mutual_count, t.via_user_id, t.source
    FROM (
      SELECT * FROM tier_graph
      UNION ALL
      SELECT * FROM tier_active
    ) t
   ORDER BY t.tier, t.rank_in_tier
   LIMIT lim;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_onboarding_buddy_suggestions(uid uuid, lim integer, active_window_days integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_onboarding_buddy_suggestions(uid uuid, lim integer, active_window_days integer) TO boardgamebuddy_role;

-- bgb_onboarding_suggestion_network(uid uuid, seed_ids uuid[], per_seed integer, lim integer)
--   last defined in archive/2026-09-28/014_buddy_suggestion_dismissals.sql
CREATE OR REPLACE FUNCTION public.bgb_onboarding_suggestion_network(uid uuid, seed_ids uuid[], per_seed integer DEFAULT 6, lim integer DEFAULT 48)
 RETURNS TABLE(via_user_id uuid, user_id uuid, buddy_count bigint, rank_in_seed integer)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH seeds AS (
    SELECT DISTINCT s.seed_id
      FROM unnest(COALESCE(seed_ids, ARRAY[]::UUID[])) AS s(seed_id)
     WHERE s.seed_id IS NOT NULL
  ),
  connected AS (
    SELECT CASE WHEN be.user_a = uid THEN be.user_b ELSE be.user_a END AS other_id
      FROM public.boardgamebuddy_buddy_edges be
     WHERE uid IN (be.user_a, be.user_b)
  ),
  -- NEW here — see bgb_suggested_buddies above.
  dismissed AS (
    SELECT d.dismissed_user_id AS other_id
      FROM public.boardgamebuddy_buddy_suggestion_dismissals d
     WHERE d.user_id = uid
  ),
  -- One row per (seed, person the seed has accepted).
  hops AS (
    SELECT
      s.seed_id AS via,
      CASE WHEN be.user_a = s.seed_id THEN be.user_b ELSE be.user_a END AS candidate
    FROM seeds s
    JOIN public.boardgamebuddy_buddy_edges be
      ON be.status = 'accepted'
     AND s.seed_id IN (be.user_a, be.user_b)
  ),
  -- How connected each candidate is in their own right — the rank inside a
  -- seed, and a number the client can show if it ever wants to. Counted off
  -- the DISTINCT candidate set: a person reachable from three seeds appears
  -- three times in hops, and counting from there would treble their edges.
  hop_candidates AS (
    SELECT DISTINCT h.candidate FROM hops h
  ),
  buddy_counts AS (
    SELECT hc.candidate, COUNT(*)::BIGINT AS n
      FROM hop_candidates hc
      JOIN public.boardgamebuddy_buddy_edges be
        ON be.status = 'accepted'
       AND hc.candidate IN (be.user_a, be.user_b)
     GROUP BY hc.candidate
  ),
  ranked AS (
    SELECT
      h.via,
      h.candidate,
      COALESCE(bc.n, 0) AS n,
      ROW_NUMBER() OVER (
        PARTITION BY h.via
        ORDER BY COALESCE(bc.n, 0) DESC, h.candidate
      )::INT AS rank_in_seed
    FROM hops h
    JOIN public.boardgamebuddy_profiles pr ON pr.id = h.candidate
    LEFT JOIN buddy_counts bc ON bc.candidate = h.candidate
    WHERE h.candidate <> uid
      AND pr.needs_setup IS NOT TRUE
      AND h.candidate NOT IN (SELECT c.other_id FROM connected c)
      AND h.candidate NOT IN (SELECT d.other_id FROM dismissed d)   -- added in 014 (this file)
      AND h.candidate NOT IN (SELECT s.seed_id FROM seeds s)
  )
  SELECT r.via, r.candidate, r.n, r.rank_in_seed
    FROM ranked r
   WHERE r.rank_in_seed <= GREATEST(per_seed, 1)
   ORDER BY r.rank_in_seed, r.n DESC, r.via, r.candidate
   LIMIT lim;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_onboarding_suggestion_network(uid uuid, seed_ids uuid[], per_seed integer, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_onboarding_suggestion_network(uid uuid, seed_ids uuid[], per_seed integer, lim integer) TO boardgamebuddy_role;

-- bgb_play_partners(p_viewer uuid)
--   last defined in archive/2026-09-28/049_play_partners_pending.sql
CREATE OR REPLACE FUNCTION public.bgb_play_partners(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_accounts JSONB;
  v_pending JSONB;
  v_ghosts JSONB;
  v_recent JSONB;
BEGIN
  -- accounts: accepted mutual edges, from the viewer's side.
  SELECT COALESCE(jsonb_agg(a ORDER BY a_sort), '[]'::jsonb)
    INTO v_accounts
    FROM (
      SELECT jsonb_build_object(
               'id', e.id,
               'other_user_id', pr.id,
               'other_display_name', pr.display_name,
               'other_username', pr.username,
               'other_avatar', pr.avatar,
               -- Per 012: the viewer's own private alias for this buddy, off
               -- whichever side of the canonical row the viewer sits on. NULL
               -- for the other party by construction — a per-viewer
               -- projection, not a property of the edge.
               'other_alias',
                 CASE WHEN e.user_a = p_viewer THEN e.alias_by_a ELSE e.alias_by_b END,
               'accepted_at', e.accepted_at,
               'created_at', e.created_at
             ) AS a,
             lower(pr.display_name) AS a_sort
        FROM boardgamebuddy_buddy_edges e
        JOIN boardgamebuddy_profiles pr
          ON pr.id = CASE WHEN e.user_a = p_viewer THEN e.user_b ELSE e.user_a END
       WHERE e.status = 'accepted'
         AND (e.user_a = p_viewer OR e.user_b = p_viewer)
    ) s;

  -- NEW in 049. pending: live requests either way, newest first — a request
  -- made minutes ago is likelier to be the person in front of you than one
  -- that has been sitting for a fortnight, which is the opposite of the
  -- alphabetical order `accounts` wants (that list is browsed; this one is a
  -- short "oh, them" list at the top of a picker).
  --
  -- A rejected or cancelled request is a DELETED row (buddy_service.reject_request
  -- / cancel_request), not a status, so "pending" here means genuinely waiting.
  -- 'blocked' edges are excluded by the same test.
  SELECT COALESCE(jsonb_agg(q ORDER BY q_sort DESC NULLS LAST, q_name), '[]'::jsonb)
    INTO v_pending
    FROM (
      SELECT jsonb_build_object(
               'id', e.id,
               'other_user_id', pr.id,
               'other_display_name', pr.display_name,
               'other_username', pr.username,
               'other_avatar', pr.avatar,
               'direction',
                 CASE WHEN e.requested_by = p_viewer THEN 'outgoing' ELSE 'incoming' END,
               'created_at', e.created_at
             ) AS q,
             e.created_at AS q_sort,
             lower(pr.display_name) AS q_name
        FROM boardgamebuddy_buddy_edges e
        JOIN boardgamebuddy_profiles pr
          ON pr.id = CASE WHEN e.user_a = p_viewer THEN e.user_b ELSE e.user_a END
       WHERE e.status = 'pending'
         AND (e.user_a = p_viewer OR e.user_b = p_viewer)
    ) s;

  -- ghosts: free-text names from the viewer's OWN plays, grouped
  -- case-sensitively on the trimmed name.
  SELECT COALESCE(jsonb_agg(g ORDER BY g_count DESC, g_sort), '[]'::jsonb)
    INTO v_ghosts
    FROM (
      SELECT jsonb_build_object(
               'display_name', btrim(pp.player_display_name),
               'play_count', COUNT(*),
               'last_played_at', MAX(p.played_at)
             ) AS g,
             COUNT(*) AS g_count,
             lower(btrim(pp.player_display_name)) AS g_sort
        FROM boardgamebuddy_plays p
        JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
       WHERE p.user_id = p_viewer
         AND pp.player_user_id IS NULL
         AND btrim(COALESCE(pp.player_display_name, '')) <> ''
       GROUP BY btrim(pp.player_display_name)
    ) s;

  -- recent: real accounts sharing a play with the viewer, ranked by how many.
  -- Visibility matches bgb_play_stats — plays the viewer logged, plus plays
  -- they appear in. Relation flags come from the same pass rather than the
  -- second query _relations_for_viewer used to run.
  WITH visible_plays AS (
    SELECT p.id FROM boardgamebuddy_plays p WHERE p.user_id = p_viewer
    UNION
    SELECT pp.play_id
      FROM boardgamebuddy_play_players pp
     WHERE pp.player_user_id = p_viewer
  ),
  counts AS (
    SELECT pp.player_user_id AS uid, COUNT(*) AS play_count
      FROM boardgamebuddy_play_players pp
      JOIN visible_plays v ON v.id = pp.play_id
     WHERE pp.player_user_id IS NOT NULL
       AND pp.player_user_id <> p_viewer
     GROUP BY pp.player_user_id
  )
  SELECT COALESCE(jsonb_agg(r ORDER BY r_count DESC, r_sort), '[]'::jsonb)
    INTO v_recent
    FROM (
      SELECT jsonb_build_object(
               'user_id', pr.id,
               'display_name', pr.display_name,
               'avatar', pr.avatar,
               'play_count', c.play_count,
               'is_buddy', COALESCE(e.status = 'accepted', FALSE),
               'has_pending_request', COALESCE(e.status = 'pending', FALSE),
               'pending_request_direction',
                 CASE WHEN e.status = 'pending'
                      THEN CASE WHEN e.requested_by = p_viewer THEN 'outgoing' ELSE 'incoming' END
                 END,
               -- Per 061: the edge id, so the row can cancel an outgoing
               -- request (or accept an incoming one) without first fetching
               -- /buddies/requests to look it up by other_user_id.
               'pending_request_id',
                 CASE WHEN e.status = 'pending' THEN e.id END
             ) AS r,
             c.play_count AS r_count,
             lower(pr.display_name) AS r_sort
        FROM counts c
        -- Inner join: a co-player with no profile row is dropped, as the
        -- Python did when the profile lookup came back empty.
        JOIN boardgamebuddy_profiles pr ON pr.id = c.uid
        LEFT JOIN boardgamebuddy_buddy_edges e
          ON ((e.user_a = p_viewer AND e.user_b = c.uid)
           OR (e.user_b = p_viewer AND e.user_a = c.uid))
         AND e.status IN ('accepted', 'pending')
    ) s;

  RETURN jsonb_build_object(
    'accounts', v_accounts,
    'pending', v_pending,
    'ghosts', v_ghosts,
    'recent', v_recent
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_play_partners(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_play_partners(p_viewer uuid) TO boardgamebuddy_role;

-- bgb_play_stats(p_viewer uuid, p_game_ids uuid[])
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_play_stats(p_viewer uuid, p_game_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'game_id', s.game_id,
           'play_count', s.play_count,
           'last_played_at', s.last_played_at
         )), '[]'::jsonb)
  FROM (
    SELECT p.game_id, count(*) AS play_count, max(p.played_at) AS last_played_at
    FROM boardgamebuddy_plays p
    WHERE (p.user_id = p_viewer
           OR EXISTS (
                SELECT 1 FROM boardgamebuddy_play_players pp
                WHERE pp.play_id = p.id AND pp.player_user_id = p_viewer))
      AND (p_game_ids IS NULL OR p.game_id = ANY (p_game_ids))
    GROUP BY p.game_id
  ) s;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_play_stats(p_viewer uuid, p_game_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_play_stats(p_viewer uuid, p_game_ids uuid[]) TO boardgamebuddy_role;

-- bgb_collection_shelf(viewer uuid, target uuid, p_status text, p_exclude_expansions boolean, p_limit integer)
--   last defined in archive/2026-09-28/057_played_mark.sql
CREATE OR REPLACE FUNCTION public.bgb_collection_shelf(viewer uuid, target uuid, p_status text DEFAULT 'owned'::text, p_exclude_expansions boolean DEFAULT true, p_limit integer DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_items JSONB;
  v_total BIGINT := 0;
  v_parted BIGINT := 0;
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 5000);
  v_excl BOOLEAN := COALESCE(p_exclude_expansions, true);
  -- 'owned' is a SET of statuses, not one: a prev_owned game (sold, gifted,
  -- donated — migration 069) is still on your Owned shelf, just dimmed and
  -- stamped by the client. It is excluded from every owned COUNT, which is why
  -- v_parted comes back alongside v_total for the caller to subtract. Every
  -- other status is its own single-element set.
  v_statuses TEXT[] := CASE
    WHEN p_status = 'owned' THEN ARRAY['owned', 'prev_owned']
    ELSE ARRAY[p_status]
  END;
BEGIN
  -- Wishlist is private to its owner (bgb_profile_bundle gates it the same way).
  IF p_status = 'wishlist' AND viewer IS DISTINCT FROM target THEN
    RETURN jsonb_build_object(
      'items', '[]'::jsonb, 'total', 0, 'parted_total', 0, 'truncated', false
    );
  END IF;

  IF p_status = 'played' THEN
    -- Played-not-owned: every game the target has a play for that has NO row
    -- on their collection table at all (owned AND wishlist both live there).
    -- Mirrors collection_routes.py:335-404 and 045's played_not_owned CTE.
    -- No denormalized columns available here — a played game has no
    -- collection row, or only a 'played' one — so this branch joins
    -- boardgamebuddy_games.
    WITH played_games AS (
      -- EXISTS, not a LEFT JOIN onto play_players: the join fans one play out
      -- to one row per participant, which would multiply play_count. Matches
      -- bgb_play_stats (039) and the 045 fix.
      SELECT p.game_id
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
         OR EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = target
            )
      GROUP BY p.game_id
      UNION ALL
      -- Played but never logged here (status 'played', migration 057).
      -- A game with a play is already above, so only the rest join.
      SELECT c.game_id
      FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.status = 'played'
        AND NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_plays p2
              WHERE p2.game_id = c.game_id
                AND (p2.user_id = target OR EXISTS (
                      SELECT 1 FROM boardgamebuddy_play_players pp2
                      WHERE pp2.play_id = p2.id AND pp2.player_user_id = target))
            )
    )
    SELECT COUNT(*) INTO v_total
      FROM played_games pg
      JOIN boardgamebuddy_games g ON g.id = pg.game_id
      WHERE NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_collections c
              WHERE c.user_id = target AND c.game_id = pg.game_id AND c.status <> 'played'
            )
        AND (NOT v_excl OR COALESCE(g.is_expansion, false) = false);

    WITH played_games AS (
      SELECT p.game_id,
             MAX(p.played_at) AS last_played_at,
             COUNT(*)::INT    AS play_count
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
         OR EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = target
            )
      GROUP BY p.game_id
      UNION ALL
      -- Played but never logged here (status 'played', migration 057).
      -- A game with a play is already above, so only the rest join.
      SELECT c.game_id, NULL, 0
      FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.status = 'played'
        AND NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_plays p2
              WHERE p2.game_id = c.game_id
                AND (p2.user_id = target OR EXISTS (
                      SELECT 1 FROM boardgamebuddy_play_players pp2
                      WHERE pp2.play_id = p2.id AND pp2.player_user_id = target))
            )
    ),
    played_not_owned AS (
      SELECT pg.*
      FROM played_games pg
      WHERE NOT EXISTS (
        SELECT 1 FROM boardgamebuddy_collections c
        WHERE c.user_id = target AND c.game_id = pg.game_id AND c.status <> 'played'
      )
    )
    SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY sort_a DESC NULLS LAST), '[]'::jsonb)
      INTO v_items
      FROM (
        SELECT
          pno.last_played_at AS sort_a,
          jsonb_build_object(
            -- Matches the synthetic id the Python branch minted so the client
            -- can key tiles identically across both endpoints.
            'id', 'played-' || g.id::TEXT,
            'game_id', g.id,
            'status', 'played',
            'added_at', COALESCE(pno.last_played_at::TEXT || 'T00:00:00+00:00', (SELECT to_jsonb(c.added_at) #>> '{}' FROM boardgamebuddy_collections c WHERE c.user_id = target AND c.game_id = pno.game_id)),
            'last_played_at', pno.last_played_at,
            'play_count', COALESCE(pno.play_count, 0),
            'played_before', EXISTS (
              SELECT 1 FROM boardgamebuddy_collections c
              WHERE c.user_id = target AND c.game_id = pno.game_id
                AND c.played_before_at IS NOT NULL),
            'game', jsonb_build_object(
              'id', g.id,
              'bgg_id', g.bgg_id,
              'name', g.name,
              'year_published', g.year_published,
              'min_players', g.min_players,
              'max_players', g.max_players,
              'playing_time', g.playing_time,
              'thumbnail_url', g.thumbnail_url,
              'image_url', g.image_url,
              'theme_color', g.theme_color,
              'is_expansion', COALESCE(g.is_expansion, false),
              'base_game_bgg_id', g.base_game_bgg_id,
              'expansion_color', g.expansion_color,
              'play_mode', COALESCE(g.play_mode, 'competitive'),
              'expansion_count', COALESCE(xc.n, 0)
            ),
            'expansions', '[]'::jsonb
          ) AS row_jsonb
        FROM played_not_owned pno
        JOIN boardgamebuddy_games g ON g.id = pno.game_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::INT AS n
          FROM boardgamebuddy_games e
          WHERE COALESCE(g.is_expansion, false) = false
            AND g.bgg_id IS NOT NULL
            AND e.is_expansion = true
            AND e.base_game_bgg_id = g.bgg_id
        ) xc ON true
        WHERE (NOT v_excl OR COALESCE(g.is_expansion, false) = false)
        ORDER BY pno.last_played_at DESC NULLS LAST
        LIMIT v_limit
      ) q;

  ELSE
    -- owned / wishlist: served entirely from the denormalized c.game_* columns.
    -- v_total counts every row the items array can draw from, prev_owned
    -- included, because `truncated` below has to be about the rows on offer.
    -- v_parted is how many of those the client must not count as owned.
    SELECT COUNT(*), COUNT(*) FILTER (WHERE c.status = 'prev_owned')
      INTO v_total, v_parted
      FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.status = ANY(v_statuses)
        AND (NOT v_excl OR COALESCE(c.game_is_expansion, false) = false);

    SELECT COALESCE(
             jsonb_agg(row_jsonb ORDER BY sort_a DESC NULLS LAST, sort_b DESC),
             '[]'::jsonb
           )
      INTO v_items
      FROM (
        SELECT
          -- Wishlist sorts on added_at alone (matching bgb_profile_bundle and
          -- the Python grid); collapsing sort_a to NULL makes the shared
          -- ORDER BY above degrade to `added_at DESC` for it.
          CASE WHEN p_status = 'wishlist' THEN NULL ELSE ps.last_played_at END AS sort_a,
          c.added_at AS sort_b,
          jsonb_build_object(
            'id', c.id,
            'game_id', c.game_id,
            'status', c.status,
            'added_at', c.added_at,
            'last_played_at', ps.last_played_at,
            'play_count', COALESCE(ps.play_count, 0),
            -- The played mark (057), so an unlogged but marked game can join
            -- the client's Most played order as a logged one does.
            'played_before', c.played_before_at IS NOT NULL,
            'game', jsonb_build_object(
              'id', c.game_id,
              'bgg_id', c.game_bgg_id,
              'name', c.game_name,
              'year_published', c.game_year_published,
              'min_players', c.game_min_players,
              'max_players', c.game_max_players,
              'playing_time', c.game_playing_time,
              'thumbnail_url', c.game_thumbnail_url,
              'image_url', gi.image_url,
              'theme_color', c.game_theme_color,
              'is_expansion', COALESCE(c.game_is_expansion, false),
              'base_game_bgg_id', c.game_base_game_bgg_id,
              'expansion_color', c.game_expansion_color,
              'play_mode', COALESCE(c.game_play_mode, 'competitive'),
              'expansion_count', COALESCE(xc.n, 0)
            ),
            'expansions', '[]'::jsonb
          ) AS row_jsonb
        FROM boardgamebuddy_collections c
        LEFT JOIN boardgamebuddy_games gi ON gi.id = c.game_id
        -- image_url only — see the header. Every other game field stays denorm.
        LEFT JOIN LATERAL (
          SELECT MAX(p.played_at) AS last_played_at, COUNT(*)::INT AS play_count
          FROM boardgamebuddy_plays p
          WHERE p.game_id = c.game_id
            AND (
              p.user_id = target
              OR EXISTS (
                   SELECT 1 FROM boardgamebuddy_play_players pp
                   WHERE pp.play_id = p.id AND pp.player_user_id = target
                 )
            )
        ) ps ON true
        LEFT JOIN LATERAL (
          -- CATALOG-wide expansion count, not the viewer's owned ones — the
          -- same number the game page's "Expansions (N)" heading shows.
          -- _attach_page_expansion_counts (collection_routes.py:238-251) is
          -- explicit about this: expansions arrive via the import popup
          -- without touching anyone's collection, so an owned-only count
          -- reads as zero for a game that plainly has eleven of them.
          -- Only base games get a count; expansion rows stay at 0.
          SELECT COUNT(*)::INT AS n
          FROM boardgamebuddy_games e
          WHERE COALESCE(c.game_is_expansion, false) = false
            AND c.game_bgg_id IS NOT NULL
            AND e.is_expansion = true
            AND e.base_game_bgg_id = c.game_bgg_id
        ) xc ON true
        WHERE c.user_id = target AND c.status = ANY(v_statuses)
          AND (NOT v_excl OR COALESCE(c.game_is_expansion, false) = false)
        ORDER BY
          CASE WHEN p_status = 'wishlist' THEN NULL ELSE ps.last_played_at END
            DESC NULLS LAST,
          c.added_at DESC
        LIMIT v_limit
      ) q;
  END IF;

  RETURN jsonb_build_object(
    'items', COALESCE(v_items, '[]'::jsonb),
    'total', v_total,
    -- Zero on every branch but owned/wishlist, and always zero for wishlist.
    'parted_total', v_parted,
    'truncated', v_total > v_limit
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_collection_shelf(viewer uuid, target uuid, p_status text, p_exclude_expansions boolean, p_limit integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_collection_shelf(viewer uuid, target uuid, p_status text, p_exclude_expansions boolean, p_limit integer) TO boardgamebuddy_role;

-- bgb_collection_status_map(p_viewer uuid)
--   last defined in archive/2026-09-28/057_played_mark.sql
CREATE OR REPLACE FUNCTION public.bgb_collection_status_map(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status_map JSONB;
  v_expansion_counts JSONB;
  v_played_marks JSONB;
BEGIN
  -- Collection rows first, then a derived 'played' entry for every game the
  -- viewer has a play for and no collection row on. Matches GET /collection's
  -- semantics: there, owned/wishlist rows come from the table and played rows
  -- are synthesized for games with plays but no owned row.
  --
  -- The visibility rule for "has a play" is the participated-in one shared by
  -- bgb_play_stats (039) and fixed across the board in 045: a play counts when
  -- the viewer logged it OR appears on it as a participant. EXISTS rather than
  -- a join, so a multi-player play can't fan out.
  SELECT COALESCE(jsonb_object_agg(game_id, status), '{}'::jsonb)
    INTO v_status_map
    FROM (
      SELECT c.game_id::TEXT AS game_id, c.status AS status
      FROM boardgamebuddy_collections c
      WHERE c.user_id = p_viewer
        AND c.status IN ('owned', 'wishlist', 'played', 'prev_owned')
      UNION
      SELECT DISTINCT p.game_id::TEXT, 'played'::TEXT
      FROM boardgamebuddy_plays p
      WHERE (
              p.user_id = p_viewer
              OR EXISTS (
                   SELECT 1 FROM boardgamebuddy_play_players pp
                   WHERE pp.play_id = p.id AND pp.player_user_id = p_viewer
                 )
            )
        AND NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_collections c2
              WHERE c2.user_id = p_viewer AND c2.game_id = p.game_id
            )
    ) m;

  -- Owned expansions per base game's bgg_id. Reads the denormalized game_*
  -- columns (migration 020), so no join to boardgamebuddy_games at all.
  -- Identical to bgb_profile_bundle's expansion_counts block (045:359-369).
  --
  -- `= 'owned'` here is deliberate and NOT widened to prev_owned (069): an
  -- expansion you sold is not clutter on your shelf any more, and this number
  -- is what the tile's expansion badge counts.
  SELECT COALESCE(jsonb_object_agg(base_bgg, cnt), '{}'::jsonb)
    INTO v_expansion_counts
    FROM (
      SELECT c.game_base_game_bgg_id AS base_bgg, COUNT(*)::INT AS cnt
      FROM boardgamebuddy_collections c
      WHERE c.user_id = p_viewer
        AND c.status = 'owned'
        AND COALESCE(c.game_is_expansion, false) = true
        AND c.game_base_game_bgg_id IS NOT NULL
      GROUP BY c.game_base_game_bgg_id
    ) e;

  -- Every game the viewer marked played without a logged play (057), on
  -- a row of any status. The map alone cannot say: it reads 'played' for a
  -- mark and for logged plays alike, and a shelf status for a marked
  -- owned or wishlisted game. This is what the sheet's switch shows.
  SELECT COALESCE(jsonb_agg(c.game_id::TEXT), '[]'::jsonb)
    INTO v_played_marks
    FROM boardgamebuddy_collections c
    WHERE c.user_id = p_viewer AND c.played_before_at IS NOT NULL;

  RETURN jsonb_build_object(
    'status_map', v_status_map,
    'expansion_counts', v_expansion_counts,
    'played_marks', v_played_marks
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_collection_status_map(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_collection_status_map(p_viewer uuid) TO boardgamebuddy_role;

-- bgb_plays_page(p_target uuid, p_page integer, p_per_page integer, p_game uuid, p_buddy uuid, p_search text, p_own_only boolean)
--   last defined in archive/2026-09-28/048_play_teams.sql
CREATE OR REPLACE FUNCTION public.bgb_plays_page(p_target uuid, p_page integer DEFAULT 1, p_per_page integer DEFAULT 20, p_game uuid DEFAULT NULL::uuid, p_buddy uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_own_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_search TEXT := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_total BIGINT;
  v_plays JSONB;
BEGIN
  WITH filtered AS (
    SELECT p.*
    FROM boardgamebuddy_plays p
    WHERE (
        p.user_id = p_target
        OR (NOT p_own_only AND EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = p_target))
      )
      AND (p_own_only IS FALSE OR p.user_id = p_target)
      AND (p_game IS NULL OR p.game_id = p_game)
      AND (p_buddy IS NULL OR EXISTS (
            SELECT 1 FROM boardgamebuddy_play_players pp
            WHERE pp.play_id = p.id AND pp.player_user_id = p_buddy))
      AND (v_search IS NULL
           OR p.game_name ILIKE '%' || v_search || '%'
           OR EXISTS (
                SELECT 1 FROM boardgamebuddy_play_players pp
                WHERE pp.play_id = p.id
                  AND pp.player_display_name ILIKE '%' || v_search || '%'))
      -- Migration 005. One row per imported run, same representative rule as
      -- bgb_feed_plays. It sits in `filtered` rather than in `page` so
      -- `counted` totals CARDS — a pager reading 106 over a six-row list would
      -- send the reader to five empty pages.
      AND (
        p.import_group_id IS NULL
        OR p.id = (SELECT q.id
                     FROM boardgamebuddy_plays q
                    WHERE q.import_group_id = p.import_group_id
                    ORDER BY q.id
                    LIMIT 1)
      )
  ),
  counted AS (SELECT count(*) AS total FROM filtered),
  page AS (
    SELECT f.*
    FROM filtered f
    ORDER BY f.played_at DESC, f.created_at DESC
    LIMIT p_per_page OFFSET GREATEST(p_page - 1, 0) * p_per_page
  )
  SELECT
    (SELECT total FROM counted),
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', pg.id,
      'game_id', pg.game_id,
      'game_name', pg.game_name,
      'game_thumbnail', pg.game_thumbnail_url,
      'played_at', pg.played_at,
      'notes', pg.notes,
      'photo_url', pg.photo_url,
      'created_at', pg.created_at,
      'play_mode', COALESCE(pg.play_mode, 'competitive'),
      'country_code', pg.country_code,
      'scoring_template', pg.scoring_template,
      'group_count', CASE WHEN pg.import_group_id IS NULL THEN 1
                          ELSE (SELECT COUNT(*)::INT
                                  FROM boardgamebuddy_plays q
                                 WHERE q.import_group_id = pg.import_group_id)
                     END,
      'logged_by_id', pg.user_id,
      'logged_by_name', COALESCE(lp.display_name, 'Unknown'),
      'is_own', (pg.user_id = p_target),
      'players', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'user_id', pp.player_user_id,
          'name', COALESCE(ppr.display_name, pp.player_display_name, 'Unknown'),
          'avatar', ppr.avatar,
          'is_winner', COALESCE(pp.is_winner, false),
          'score', pp.score,
          'round_scores', pp.round_scores,
          'team', pp.team
        ))
        FROM boardgamebuddy_play_players pp
        LEFT JOIN boardgamebuddy_profiles ppr ON ppr.id = pp.player_user_id
        WHERE pp.play_id = pg.id
      ), '[]'::jsonb),
      'expansions', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'expansion_game_id', pe.expansion_game_id,
          'name', COALESCE(eg.name, 'Unknown'),
          'color', eg.expansion_color
        ))
        FROM boardgamebuddy_play_expansions pe
        LEFT JOIN boardgamebuddy_games eg ON eg.id = pe.expansion_game_id
        WHERE pe.play_id = pg.id
      ), '[]'::jsonb)
    ) ORDER BY pg.played_at DESC, pg.created_at DESC), '[]'::jsonb)
    INTO v_total, v_plays
  FROM page pg
  LEFT JOIN boardgamebuddy_profiles lp ON lp.id = pg.user_id;

  RETURN jsonb_build_object('plays', v_plays, 'total', COALESCE(v_total, 0));
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_plays_page(p_target uuid, p_page integer, p_per_page integer, p_game uuid, p_buddy uuid, p_search text, p_own_only boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_plays_page(p_target uuid, p_page integer, p_per_page integer, p_game uuid, p_buddy uuid, p_search text, p_own_only boolean) TO boardgamebuddy_role;

-- bgb_push_note_failure(p_id uuid)
--   last defined in archive/2026-09-28/017_push_notifications.sql
CREATE OR REPLACE FUNCTION public.bgb_push_note_failure(p_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE boardgamebuddy_push_subscriptions
     SET failure_count = failure_count + 1
   WHERE id = p_id;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_push_note_failure(p_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_push_note_failure(p_id uuid) TO boardgamebuddy_role;

-- bgb_rank_deferrals_active(p_viewer uuid)
--   last defined in archive/2026-09-28/058_rank_deferrals.sql
CREATE OR REPLACE FUNCTION public.bgb_rank_deferrals_active(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(d.game_id), '[]'::jsonb)
  FROM boardgamebuddy_rank_deferrals d
  WHERE d.user_id = p_viewer
    AND NOT EXISTS (
      SELECT 1 FROM boardgamebuddy_plays p
      WHERE p.game_id = d.game_id
        AND p.created_at > d.deferred_at
        AND p.played_at >= d.deferred_at::date
        AND (p.user_id = p_viewer
             OR EXISTS (
                  SELECT 1 FROM boardgamebuddy_play_players pp
                  WHERE pp.play_id = p.id AND pp.player_user_id = p_viewer)));
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_rank_deferrals_active(p_viewer uuid) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.bgb_rank_deferrals_active(p_viewer uuid) IS 'The game ids p_viewer parked with "Rank after next play" and has not played since (migration 058), as a JSONB array. Called by GET /api/v1/boardgame_buddy/ranks/queue.';

-- bgb_rank_game(p_user uuid, p_game uuid, p_category text, p_tier text, p_index integer)
--   last defined in archive/2026-09-28/056_game_ranks.sql
CREATE OR REPLACE FUNCTION public.bgb_rank_game(p_user uuid, p_game uuid, p_category text, p_tier text, p_index integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old   boardgamebuddy_game_ranks%ROWTYPE;
  v_count integer;
  v_pos   integer;
BEGIN
  IF p_tier NOT IN ('love', 'good', 'not') THEN
    RETURN jsonb_build_object('error', 'invalid_tier');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_games WHERE id = p_game) THEN
    RETURN jsonb_build_object('error', 'game_not_found');
  END IF;

  -- Re-ranking: take it out of wherever it was first, closing the gap.
  DELETE FROM boardgamebuddy_game_ranks
   WHERE user_id = p_user AND game_id = p_game
  RETURNING * INTO v_old;
  IF FOUND THEN
    UPDATE boardgamebuddy_game_ranks
       SET position = position - 1
     WHERE user_id = p_user AND category = v_old.category AND tier = v_old.tier
       AND position > v_old.position;
  END IF;

  -- The client computed p_index against the list it was shown. Clamped, so a
  -- list that shrank since (a rank removed in another tab) cannot open a hole.
  SELECT count(*) INTO v_count
    FROM boardgamebuddy_game_ranks
   WHERE user_id = p_user AND category = p_category AND tier = p_tier;
  v_pos := LEAST(GREATEST(COALESCE(p_index, v_count), 0), v_count);

  UPDATE boardgamebuddy_game_ranks
     SET position = position + 1
   WHERE user_id = p_user AND category = p_category AND tier = p_tier
     AND position >= v_pos;

  INSERT INTO boardgamebuddy_game_ranks (user_id, game_id, category, tier, position)
  VALUES (p_user, p_game, p_category, p_tier, v_pos);

  RETURN jsonb_build_object('category', p_category, 'tier', p_tier, 'position', v_pos);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_rank_game(p_user uuid, p_game uuid, p_category text, p_tier text, p_index integer) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.bgb_rank_game(p_user uuid, p_game uuid, p_category text, p_tier text, p_index integer) IS 'Insert (or move) a game into a player''s ranking at p_index within p_category/p_tier, keeping positions dense. Returns {category, tier, position} or {error}. Called by PUT /api/v1/boardgame_buddy/ranks/games/{game_id} (migration 056).';

-- bgb_reject_ghost_claim(p_owner uuid, p_claim_id uuid)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_reject_ghost_claim(p_owner uuid, p_claim_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_claim RECORD;
BEGIN
  SELECT * INTO v_claim
    FROM boardgamebuddy_ghost_claims
   WHERE id = p_claim_id
     FOR UPDATE;

  IF NOT FOUND OR v_claim.owner_id <> p_owner THEN
    RETURN jsonb_build_object('error', 'claim_not_found');
  END IF;
  IF v_claim.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'not_pending');
  END IF;

  UPDATE boardgamebuddy_ghost_claims
     SET status = 'rejected',
         resolved_at = now(),
         reject_count = reject_count + 1
   WHERE id = v_claim.id;

  RETURN jsonb_build_object('rejected', true);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_reject_ghost_claim(p_owner uuid, p_claim_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_reject_ghost_claim(p_owner uuid, p_claim_id uuid) TO boardgamebuddy_role;

-- bgb_release_notices_unseen(p_viewer uuid, p_limit integer)
--   last defined in archive/2026-09-28/042_release_notices.sql
CREATE OR REPLACE FUNCTION public.bgb_release_notices_unseen(p_viewer uuid, p_limit integer DEFAULT 5)
 RETURNS TABLE(id uuid, title text, body_md text, link_route text, link_label text, published_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT newest.id, newest.title, newest.body_md,
         newest.link_route, newest.link_label, newest.published_at
    FROM (
      SELECT n.id, n.title, n.body_md, n.link_route, n.link_label, n.published_at
        FROM public.boardgamebuddy_release_notices n
       WHERE n.published_at IS NOT NULL
         AND n.published_at > (SELECT pr.release_notices_seen_at
                                 FROM public.boardgamebuddy_profiles pr
                                WHERE pr.id = p_viewer)
       ORDER BY n.published_at DESC
       LIMIT GREATEST(COALESCE(p_limit, 5), 1)
    ) newest
   ORDER BY newest.published_at ASC;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_release_notices_unseen(p_viewer uuid, p_limit integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_release_notices_unseen(p_viewer uuid, p_limit integer) TO boardgamebuddy_role;

-- bgb_session_bundle(p_session_id uuid)
--   last defined in archive/2026-09-28/050_session_participant_teams.sql
CREATE OR REPLACE FUNCTION public.bgb_session_bundle(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session JSONB;
  v_game_id UUID;
  v_phase TEXT;
  v_participants JSONB;
  v_scores JSONB := '[]'::jsonb;
BEGIN
  SELECT jsonb_build_object(
           'id', s.id,
           'code', s.code,
           'status', s.status,
           'phase', COALESCE(s.phase, 'gather'),
           'host_user_id', s.host_user_id,
           'game_id', s.game_id,
           'created_at', s.created_at,
           'expires_at', s.expires_at,
           'finalized_play_id', s.finalized_play_id,
           'scoring_template', s.scoring_template,
           'play_mode', s.play_mode
         ),
         s.game_id,
         COALESCE(s.phase, 'gather')
    INTO v_session, v_game_id, v_phase
    FROM boardgamebuddy_play_sessions s
    WHERE s.id = p_session_id;

  IF v_session IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', pp.id,
           'user_id', pp.user_id,
           'display_name', pp.display_name,
           'joined_at', pp.joined_at,
           'avatar', pr.avatar,
           'team', pp.team
         ) ORDER BY pp.position NULLS LAST, pp.joined_at), '[]'::jsonb)
    INTO v_participants
    FROM boardgamebuddy_play_session_participants pp
    LEFT JOIN boardgamebuddy_profiles pr ON pr.id = pp.user_id
    WHERE pp.session_id = p_session_id;

  IF v_phase = 'play' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'participant_id', sc.participant_id,
             'round_index', sc.round_index,
             'score', sc.score
           ) ORDER BY sc.round_index), '[]'::jsonb)
      INTO v_scores
      FROM boardgamebuddy_play_session_scores sc
      WHERE sc.session_id = p_session_id;
  END IF;

  RETURN v_session || jsonb_build_object(
    'participants', v_participants,
    'game', bgb_game_summary(v_game_id),
    'scores', v_scores
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_session_bundle(p_session_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_session_bundle(p_session_id uuid) TO boardgamebuddy_role;

-- bgb_create_session(p_host uuid, p_host_display_name text, p_game uuid)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_create_session(p_host uuid, p_host_display_name text, p_game uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- Crockford base32, mirrors PLAY_SESSION_CODE_ALPHABET / _LENGTH in
  -- shared-backend/routes/boardgame_buddy/constants.py — keep in step.
  v_alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_code_len CONSTANT INT := 5;
  v_max_attempts CONSTANT INT := 6;
  v_bytes BYTEA;
  v_code TEXT;
  v_session_id UUID;
BEGIN
  -- The Log Play tab always opens a fresh session on entry to Gather; a
  -- host who navigated away would otherwise leave orphan open rows.
  UPDATE boardgamebuddy_play_sessions
     SET status = 'abandoned', phase = 'abandoned'
   WHERE host_user_id = p_host
     AND status = 'open';

  FOR attempt IN 1..v_max_attempts LOOP
    -- One v4 UUID per attempt as the entropy source. 256 % 32 = 0, so a
    -- random byte mod 32 is uniform over the alphabet.
    v_bytes := uuid_send(gen_random_uuid());
    v_code := '';
    FOR i IN 1..v_code_len LOOP
      v_code := v_code
        || substr(v_alphabet, 1 + (get_byte(v_bytes, i - 1) % 32), 1);
    END LOOP;
    BEGIN
      INSERT INTO boardgamebuddy_play_sessions
        (code, host_user_id, game_id, status, phase)
      VALUES (v_code, p_host, p_game, 'open', 'gather')
      RETURNING id INTO v_session_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_session_id := NULL;
    END;
  END LOOP;

  IF v_session_id IS NULL THEN
    RETURN jsonb_build_object('error', 'code_allocation_failed');
  END IF;

  -- Position 0, not NULL. The host is player[0] in their own Gather list
  -- (_ensureSelfIncluded), and once bgb_add_participant hands every other
  -- player a real position a NULL here would sort the host LAST on every
  -- spectator's screen and last in the grid.
  INSERT INTO boardgamebuddy_play_session_participants
    (session_id, user_id, display_name, position)
  VALUES (v_session_id, p_host, p_host_display_name, 0);

  RETURN bgb_session_bundle(v_session_id);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_create_session(p_host uuid, p_host_display_name text, p_game uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_create_session(p_host uuid, p_host_display_name text, p_game uuid) TO boardgamebuddy_role;

-- bgb_get_session(p_code text)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_get_session(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
  v_expires TIMESTAMPTZ;
BEGIN
  SELECT s.id, s.expires_at
    INTO v_id, v_expires
    FROM boardgamebuddy_play_sessions s
    WHERE s.code = upper(p_code)
      AND s.status = 'open';

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_expires < now() THEN
    UPDATE boardgamebuddy_play_sessions
       SET status = 'abandoned'
     WHERE id = v_id;
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  RETURN bgb_session_bundle(v_id);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_get_session(p_code text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_get_session(p_code text) TO boardgamebuddy_role;

-- bgb_join_session(p_code text, p_user uuid, p_user_display_name text, p_guest_display_name text)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_join_session(p_code text, p_user uuid DEFAULT NULL::uuid, p_user_display_name text DEFAULT NULL::text, p_guest_display_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
  v_expires TIMESTAMPTZ;
  v_phase TEXT;
  v_guest_name TEXT;
BEGIN
  SELECT s.id, s.expires_at, COALESCE(s.phase, 'gather')
    INTO v_id, v_expires, v_phase
    FROM boardgamebuddy_play_sessions s
    WHERE s.code = upper(p_code)
      AND s.status = 'open';

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_expires < now() THEN
    UPDATE boardgamebuddy_play_sessions
       SET status = 'abandoned'
     WHERE id = v_id;
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  IF v_phase = 'gather' THEN
    IF p_user IS NOT NULL THEN
      INSERT INTO boardgamebuddy_play_session_participants
        (session_id, user_id, display_name)
      SELECT v_id, p_user, COALESCE(p_user_display_name, 'Player')
      WHERE NOT EXISTS (
        SELECT 1 FROM boardgamebuddy_play_session_participants
        WHERE session_id = v_id AND user_id = p_user
      );
    ELSE
      v_guest_name := btrim(COALESCE(p_guest_display_name, ''));
      IF v_guest_name = '' THEN
        RETURN jsonb_build_object('error', 'guest_name_required');
      END IF;
      INSERT INTO boardgamebuddy_play_session_participants
        (session_id, display_name)
      SELECT v_id, v_guest_name
      WHERE NOT EXISTS (
        SELECT 1 FROM boardgamebuddy_play_session_participants
        WHERE session_id = v_id
          AND lower(display_name) = lower(v_guest_name)
      );
    END IF;
  END IF;

  RETURN bgb_session_bundle(v_id);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_join_session(p_code text, p_user uuid, p_user_display_name text, p_guest_display_name text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_join_session(p_code text, p_user uuid, p_user_display_name text, p_guest_display_name text) TO boardgamebuddy_role;

-- bgb_session_gate(p_code text, p_host uuid, p_require_gather boolean)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_session_gate(p_code text, p_host uuid, p_require_gather boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row RECORD;
BEGIN
  SELECT s.id, s.host_user_id, s.game_id, s.expires_at, COALESCE(s.phase, 'gather') AS phase
    INTO v_row
    FROM boardgamebuddy_play_sessions s
   WHERE s.code = upper(p_code)
     AND s.status = 'open';

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_row.expires_at < now() THEN
    -- Status only — phase is left alone, exactly as the Python gate and
    -- bgb_get_session do.
    UPDATE boardgamebuddy_play_sessions
       SET status = 'abandoned'
     WHERE id = v_row.id;
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  IF v_row.host_user_id <> p_host THEN
    RETURN jsonb_build_object('error', 'host_only');
  END IF;

  IF p_require_gather AND v_row.phase <> 'gather' THEN
    RETURN jsonb_build_object('error', 'roster_locked');
  END IF;

  RETURN jsonb_build_object(
    'session_id', v_row.id,
    'host_user_id', v_row.host_user_id,
    'game_id', v_row.game_id,
    'phase', v_row.phase
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_session_gate(p_code text, p_host uuid, p_require_gather boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_session_gate(p_code text, p_host uuid, p_require_gather boolean) TO boardgamebuddy_role;

-- bgb_abandon_session(p_host uuid, p_code text)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_abandon_session(p_host uuid, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate JSONB;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, FALSE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;

  UPDATE boardgamebuddy_play_sessions
     SET status = 'abandoned', phase = 'abandoned'
   WHERE id = (v_gate ->> 'session_id')::UUID;

  RETURN jsonb_build_object('ok', TRUE);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_abandon_session(p_host uuid, p_code text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_abandon_session(p_host uuid, p_code text) TO boardgamebuddy_role;

-- bgb_add_participant(p_host uuid, p_code text, p_user uuid, p_display_name text)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_add_participant(p_host uuid, p_code text, p_user uuid, p_display_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate JSONB;
  v_session UUID;
  v_name TEXT;
  v_next SMALLINT;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, TRUE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  v_name := btrim(COALESCE(p_display_name, ''));
  IF v_name = '' THEN
    RETURN jsonb_build_object('error', 'display_name_required');
  END IF;

  SELECT (COALESCE(max(position), -1) + 1)::SMALLINT
    INTO v_next
    FROM boardgamebuddy_play_session_participants
   WHERE session_id = v_session;

  BEGIN
    IF p_user IS NOT NULL THEN
      INSERT INTO boardgamebuddy_play_session_participants (session_id, user_id, display_name, position)
      SELECT v_session, p_user, v_name, v_next
       WHERE NOT EXISTS (
         SELECT 1 FROM boardgamebuddy_play_session_participants
          WHERE session_id = v_session AND user_id = p_user
       );
    ELSE
      INSERT INTO boardgamebuddy_play_session_participants (session_id, display_name, position)
      SELECT v_session, v_name, v_next
       WHERE NOT EXISTS (
         SELECT 1 FROM boardgamebuddy_play_session_participants
          WHERE session_id = v_session
            AND user_id IS NULL
            AND lower(display_name) = lower(v_name)
       );
    END IF;
  EXCEPTION WHEN unique_violation THEN
    NULL;   -- already seated; the bundle below reflects reality either way
  END;

  RETURN bgb_session_bundle(v_session);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_add_participant(p_host uuid, p_code text, p_user uuid, p_display_name text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_add_participant(p_host uuid, p_code text, p_user uuid, p_display_name text) TO boardgamebuddy_role;

-- bgb_advance_phase(p_host uuid, p_code text, p_phase text, p_transitions jsonb)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_advance_phase(p_host uuid, p_code text, p_phase text, p_transitions jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate JSONB;
  v_session UUID;
  v_current TEXT;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, FALSE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;
  v_current := v_gate ->> 'phase';

  -- Idempotent: re-asserting the current phase is a no-op, not an error.
  IF p_phase = v_current THEN
    RETURN bgb_session_bundle(v_session);
  END IF;

  IF NOT (COALESCE(p_transitions -> v_current, '[]'::jsonb) ? p_phase) THEN
    RETURN jsonb_build_object(
      'error', 'invalid_transition', 'from', v_current, 'to', p_phase
    );
  END IF;

  UPDATE boardgamebuddy_play_sessions
     SET phase = p_phase,
         -- Keep status in step for the abandoned shortcut (mirrors
         -- abandon_session). `finalized` is set later by mark_finalized, once
         -- the play row exists.
         status = CASE WHEN p_phase = 'abandoned' THEN 'abandoned' ELSE status END
   WHERE id = v_session;

  RETURN bgb_session_bundle(v_session);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_advance_phase(p_host uuid, p_code text, p_phase text, p_transitions jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_advance_phase(p_host uuid, p_code text, p_phase text, p_transitions jsonb) TO boardgamebuddy_role;

-- bgb_remove_participant(p_host uuid, p_code text, p_participant uuid)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_remove_participant(p_host uuid, p_code text, p_participant uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate JSONB;
  v_session UUID;
  v_user UUID;
  v_found BOOLEAN;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, TRUE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  SELECT TRUE, pp.user_id
    INTO v_found, v_user
    FROM boardgamebuddy_play_session_participants pp
   WHERE pp.id = p_participant
     AND pp.session_id = v_session;

  IF NOT COALESCE(v_found, FALSE) THEN
    RETURN jsonb_build_object('error', 'participant_not_found');
  END IF;

  IF v_user IS NOT NULL AND v_user = (v_gate ->> 'host_user_id')::UUID THEN
    RETURN jsonb_build_object('error', 'cannot_remove_host');
  END IF;

  DELETE FROM boardgamebuddy_play_session_participants
   WHERE id = p_participant AND session_id = v_session;

  RETURN bgb_session_bundle(v_session);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_remove_participant(p_host uuid, p_code text, p_participant uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_remove_participant(p_host uuid, p_code text, p_participant uuid) TO boardgamebuddy_role;

-- bgb_reorder_participants(p_host uuid, p_code text, p_order uuid[])
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_reorder_participants(p_host uuid, p_code text, p_order uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate    JSONB;
  v_session UUID;
  v_listed  INT;
BEGIN
  -- require_gather = TRUE: same gate, same error vocabulary (not_found /
  -- expired / host_only / roster_locked) as add and remove.
  v_gate := bgb_session_gate(p_code, p_host, TRUE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  v_listed := COALESCE(array_length(p_order, 1), 0);

  UPDATE boardgamebuddy_play_session_participants pp
     SET position = ord.idx
    FROM (
      SELECT t.id, (t.ordinality - 1)::SMALLINT AS idx
        FROM unnest(p_order) WITH ORDINALITY AS t(id, ordinality)
    ) ord
   WHERE pp.id = ord.id
     AND pp.session_id = v_session;

  UPDATE boardgamebuddy_play_session_participants pp
     SET position = (v_listed + rest.rn)::SMALLINT
    FROM (
      SELECT id, (row_number() OVER (ORDER BY joined_at) - 1) AS rn
        FROM boardgamebuddy_play_session_participants
       WHERE session_id = v_session
         AND NOT (id = ANY (COALESCE(p_order, ARRAY[]::UUID[])))
    ) rest
   WHERE pp.id = rest.id;

  RETURN bgb_session_bundle(v_session);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_reorder_participants(p_host uuid, p_code text, p_order uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_reorder_participants(p_host uuid, p_code text, p_order uuid[]) TO boardgamebuddy_role;

-- bgb_set_session_scoring(p_host uuid, p_code text, p_template jsonb)
--   last defined in archive/2026-09-28/018_scoring_templates.sql
CREATE OR REPLACE FUNCTION public.bgb_set_session_scoring(p_host uuid, p_code text, p_template jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate JSONB;
  v_session UUID;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, FALSE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  UPDATE boardgamebuddy_play_sessions
     SET scoring_template = NULLIF(p_template, 'null'::jsonb)
   WHERE id = v_session;

  RETURN bgb_session_bundle(v_session);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_set_session_scoring(p_host uuid, p_code text, p_template jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_set_session_scoring(p_host uuid, p_code text, p_template jsonb) TO boardgamebuddy_role;

-- bgb_set_session_teams(p_host uuid, p_code text, p_mode text, p_teams jsonb)
--   last defined in archive/2026-09-28/050_session_participant_teams.sql
CREATE OR REPLACE FUNCTION public.bgb_set_session_teams(p_host uuid, p_code text, p_mode text, p_teams jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate    JSONB;
  v_session UUID;
  v_map     JSONB;
BEGIN
  -- require_gather = FALSE: a tag never renumbers a column — the one reason
  -- add / remove / reorder are frozen — and a debounced write can outrun the
  -- phase PATCH of a host rolling back to Gather to name a side. Same error
  -- vocabulary as every other host write, minus roster_locked.
  v_gate := bgb_session_gate(p_code, p_host, FALSE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  -- A JSON null, a missing argument and an empty object all mean "no seat
  -- carries a side", which is a legitimate write: it is what clearing the last
  -- tag sends, and what a host switching back to a competitive game sends.
  v_map := COALESCE(NULLIF(p_teams, 'null'::jsonb), '{}'::jsonb);
  IF jsonb_typeof(v_map) <> 'object' THEN
    RETURN jsonb_build_object('error', 'invalid_teams');
  END IF;

  -- Left alone when the caller says nothing, so a client that only knows how
  -- to publish tags cannot silently un-say the mode.
  IF p_mode = ANY (ARRAY['competitive', 'coop', 'team']) THEN
    UPDATE boardgamebuddy_play_sessions
       SET play_mode = p_mode
     WHERE id = v_session
       AND play_mode IS DISTINCT FROM p_mode;
  END IF;

  UPDATE boardgamebuddy_play_session_participants pp
     SET team = NULLIF(left(btrim(v_map ->> pp.id::TEXT), 16), '')
   WHERE pp.session_id = v_session
     AND pp.team IS DISTINCT FROM NULLIF(left(btrim(v_map ->> pp.id::TEXT), 16), '');

  RETURN bgb_session_bundle(v_session);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_set_session_teams(p_host uuid, p_code text, p_mode text, p_teams jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_set_session_teams(p_host uuid, p_code text, p_mode text, p_teams jsonb) TO boardgamebuddy_role;

-- bgb_suggested_buddies(uid uuid, lim integer)
--   last defined in archive/2026-09-28/014_buddy_suggestion_dismissals.sql
CREATE OR REPLACE FUNCTION public.bgb_suggested_buddies(uid uuid, lim integer DEFAULT 5)
 RETURNS TABLE(user_id uuid, mutual_count bigint, play_count bigint, pending_mutual_count bigint, via_user_id uuid)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH my_edges AS (
    SELECT be.user_a, be.user_b, be.status, be.requested_by
      FROM public.boardgamebuddy_buddy_edges be
     WHERE uid IN (be.user_a, be.user_b)
  ),
  -- Anyone already linked to the viewer in any way: accepted, pending in
  -- either direction, or blocked. None of them are suggestable.
  connected AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS other_id
      FROM my_edges me
  ),
  -- NEW here. People the viewer has said "not interested" about. A separate
  -- CTE from `connected` on purpose: they are not connected, they are refused,
  -- and folding the two would make the exclusion above read as something it is
  -- not the next time somebody changes it.
  dismissed AS (
    SELECT d.dismissed_user_id AS other_id
      FROM public.boardgamebuddy_buddy_suggestion_dismissals d
     WHERE d.user_id = uid
  ),
  my_buddies AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS friend_id
      FROM my_edges me
     WHERE me.status = 'accepted'
  ),
  -- The people the viewer has ASKED and who have not answered. An incoming
  -- request is not in here: someone else's interest in the viewer says
  -- nothing about who the viewer knows.
  my_requested AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS target_id
      FROM my_edges me
     WHERE me.status = 'pending' AND me.requested_by = uid
  ),
  fof AS (
    SELECT
      CASE WHEN be.user_a = mb.friend_id THEN be.user_b ELSE be.user_a END AS candidate,
      mb.friend_id
    FROM my_buddies mb
    JOIN public.boardgamebuddy_buddy_edges be
      ON be.status = 'accepted'
     AND mb.friend_id IN (be.user_a, be.user_b)
  ),
  mutuals AS (
    SELECT fof.candidate,
           COUNT(DISTINCT fof.friend_id)::BIGINT AS n,
           -- Postgres has no min(uuid); array_agg + [1] is the deterministic
           -- "pick one" and reads as the choice it is.
           (ARRAY_AGG(fof.friend_id ORDER BY fof.friend_id))[1] AS via_any
      FROM fof
     GROUP BY fof.candidate
  ),
  -- The same hop, one status weaker on the first leg only.
  fof_pending AS (
    SELECT
      CASE WHEN be.user_a = mr.target_id THEN be.user_b ELSE be.user_a END AS candidate,
      mr.target_id AS via
    FROM my_requested mr
    JOIN public.boardgamebuddy_buddy_edges be
      ON be.status = 'accepted'
     AND mr.target_id IN (be.user_a, be.user_b)
  ),
  pending_mutuals AS (
    SELECT fof_pending.candidate,
           COUNT(DISTINCT fof_pending.via)::BIGINT AS n,
           (ARRAY_AGG(fof_pending.via ORDER BY fof_pending.via))[1] AS via_any
      FROM fof_pending
     GROUP BY fof_pending.candidate
  ),
  -- Same visibility rule as bgb_play_partners / bgb_play_stats: plays the
  -- viewer logged, plus plays the viewer was a player in.
  visible_plays AS (
    SELECT p.id FROM public.boardgamebuddy_plays p WHERE p.user_id = uid
    UNION
    SELECT pp.play_id
      FROM public.boardgamebuddy_play_players pp
     WHERE pp.player_user_id = uid
  ),
  played_with AS (
    SELECT pp.player_user_id AS candidate, COUNT(*)::BIGINT AS n
      FROM public.boardgamebuddy_play_players pp
      JOIN visible_plays v ON v.id = pp.play_id
     WHERE pp.player_user_id IS NOT NULL
     GROUP BY pp.player_user_id
  ),
  -- Three sources now, so the FULL OUTER JOIN 057 used becomes a union of ids
  -- with the counts hung off it. Same result for the two it used to join.
  candidate_ids AS (
    SELECT candidate FROM mutuals
    UNION
    SELECT candidate FROM pending_mutuals
    UNION
    SELECT candidate FROM played_with
  ),
  candidates AS (
    SELECT
      ci.candidate,
      COALESCE(m.n, 0)  AS mutuals,
      COALESCE(w.n, 0)  AS plays,
      COALESCE(pm.n, 0) AS pending_mutuals,
      -- An accepted link explains the suggestion better than a pending one.
      COALESCE(m.via_any, pm.via_any) AS via_user_id
    FROM candidate_ids ci
    LEFT JOIN mutuals         m  ON m.candidate  = ci.candidate
    LEFT JOIN pending_mutuals pm ON pm.candidate = ci.candidate
    LEFT JOIN played_with     w  ON w.candidate  = ci.candidate
  )
  SELECT c.candidate, c.mutuals, c.plays, c.pending_mutuals, c.via_user_id
    FROM candidates c
    JOIN public.boardgamebuddy_profiles pr ON pr.id = c.candidate
   WHERE c.candidate <> uid
     AND pr.needs_setup IS NOT TRUE          -- added in 066
     AND c.candidate NOT IN (SELECT x.other_id FROM connected x)
     AND c.candidate NOT IN (SELECT x.other_id FROM dismissed x)   -- added in 014 (this file)
     AND (c.mutuals > 0 OR c.plays > 0 OR c.pending_mutuals > 0)
   -- Earned signals keep their order; the new one sorts below both, because a
   -- request nobody has answered is the weakest thing in the list.
   ORDER BY (c.plays > 0) DESC, c.plays DESC, c.mutuals DESC,
            c.pending_mutuals DESC, c.candidate
   LIMIT lim;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_suggested_buddies(uid uuid, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_suggested_buddies(uid uuid, lim integer) TO boardgamebuddy_role;

-- bgb_sync_achievements(uid uuid)
--   last defined in archive/2026-09-28/034_team_coop_win_achievements.sql
CREATE OR REPLACE FUNCTION public.bgb_sync_achievements(uid uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  m       JSONB;
  payload JSONB;
BEGIN
  -- ── 1. Every metric, in one pass ──────────────────────────────────────────
  -- country_code rides along from migration 068. It is on the play, so both
  -- legs carry it and the UNION still dedupes on the id.
  WITH my_plays AS (
    SELECT p.id, p.game_id, p.country_code, p.play_mode
    FROM public.boardgamebuddy_plays p
    WHERE p.user_id = uid
    UNION
    SELECT p.id, p.game_id, p.country_code, p.play_mode
    FROM public.boardgamebuddy_plays p
    JOIN public.boardgamebuddy_play_players pp ON pp.play_id = p.id
    WHERE pp.player_user_id = uid
  ),
  -- Head count per play. Ghost players (a free-text name, no account) are
  -- people at the table too, so every player row counts — "five around the
  -- board" is about the board, not about who has signed up.
  table_sizes AS (
    SELECT mp.id, COUNT(pp.id) AS players
    FROM my_plays mp
    JOIN public.boardgamebuddy_play_players pp ON pp.play_id = mp.id
    GROUP BY mp.id
  )
  SELECT jsonb_build_object(
    'plays_logged', (SELECT COUNT(*) FROM my_plays),
    'wins', (
      SELECT COUNT(*)
      FROM my_plays mp
      JOIN public.boardgamebuddy_play_players pp
        ON pp.play_id = mp.id AND pp.player_user_id = uid
      WHERE pp.is_winner
    ),
    -- ── Migration 034 ──────────────────────────────────────────────────────
    -- The same win, narrowed to the mode the table was playing in. Both are
    -- SUBSETS of `wins` above, which counts every win in every mode and is
    -- deliberately left alone: Crowned / King of the Hill / Dynasty are about
    -- how often you come first, whoever or whatever you came first against.
    --
    -- `play_mode` is NOT NULL DEFAULT 'competitive' on boardgamebuddy_plays,
    -- so a plain equality is exact here and no COALESCE is needed — unlike
    -- bgb_user_stats_detail, which reads the column off CTEs that can widen it
    -- to NULL. It lives on the PLAY, not the game: a co-op game played in a
    -- competitive variant is logged as what the table actually did.
    'team_wins', (
      SELECT COUNT(*)
      FROM my_plays mp
      JOIN public.boardgamebuddy_play_players pp
        ON pp.play_id = mp.id AND pp.player_user_id = uid
      WHERE pp.is_winner AND mp.play_mode = 'team'
    ),
    -- A co-op win is the whole table's win — every seat carries is_winner or
    -- none does (see the co-op record in bgb_user_stats_detail) — so reading
    -- the user's own seat is reading the table's result, and a play they sat
    -- at but did not log counts exactly as much as one they did.
    'coop_wins', (
      SELECT COUNT(*)
      FROM my_plays mp
      JOIN public.boardgamebuddy_play_players pp
        ON pp.play_id = mp.id AND pp.player_user_id = uid
      WHERE pp.is_winner AND mp.play_mode = 'coop'
    ),
    'biggest_table', COALESCE((SELECT MAX(players) FROM table_sizes), 0),
    -- Duelist: a game the BOX is built for two, not an evening that happened
    -- to seat two. `max_players = 2` is the test — a game that can never
    -- seat a third — which keeps 1-2 player games (Patchwork, Watergate) in:
    -- they are duels the moment a second person sits down, and excluding them
    -- on min_players would be a stricter reading than anyone means by "a
    -- two-player game". This is the one metric that has to reach the games
    -- table: migration 020 denormalized name and thumbnail onto plays, never
    -- the player counts.
    'two_player_games', (
      SELECT COUNT(DISTINCT mp.game_id)
      FROM my_plays mp
      JOIN public.boardgamebuddy_games g ON g.id = mp.game_id
      WHERE g.max_players = 2
    ),
    'buddies', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_buddy_edges e
      WHERE e.status = 'accepted' AND (e.user_a = uid OR e.user_b = uid)
    ),
    'guide_chapters', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_user_chapters uc
      WHERE uc.user_id = uid
        AND uc.state = 'kept'   -- added in 033 (this file)
    ),
    -- Chapters this user WROTE that somebody else keeps in their own guide.
    -- Distinct on the chapter: one popular chapter kept by nine people is one
    -- chapter, and the badge only needs the first.
    'chapters_borrowed', (
      SELECT COUNT(DISTINCT uc.chapter_id)
      FROM public.boardgamebuddy_user_chapters uc
      JOIN public.boardgamebuddy_guide_chapters gc ON gc.id = uc.chapter_id
      WHERE gc.created_by = uid AND uc.user_id <> uid
        AND uc.state = 'kept'   -- added in 033 (this file)
    ),
    -- Notes are written by whoever logged the play, so this counts the user's
    -- own rows rather than my_plays.
    'plays_with_notes', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_plays p
      WHERE p.user_id = uid AND COALESCE(BTRIM(p.notes), '') <> ''
    ),
    'bgg_linked', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_profiles pr
      WHERE pr.id = uid AND COALESCE(BTRIM(pr.bgg_username), '') <> ''
    ),
    'app_installed', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_profiles pr
      WHERE pr.id = uid AND pr.app_installed_at IS NOT NULL
    ),
    -- ── Migration 068 ──────────────────────────────────────────────────────
    -- Distinct countries. COUNT(DISTINCT …) already skips NULLs, so the
    -- decade of pre-065 plays that have no country simply do not participate;
    -- the WHERE is there to say so out loud rather than to change the answer.
    'countries', (
      SELECT COUNT(DISTINCT mp.country_code)
      FROM my_plays mp
      WHERE mp.country_code IS NOT NULL
    ),
    -- Distinct continents. The JOIN is inner ON PURPOSE. bgb_log_play accepts
    -- any well-formed ^[A-Z]{2}$ from any client — the native app, an offline
    -- outbox flush, a future integration — so a code the lookup has never
    -- heard of is possible. Such a play still counts toward `countries` and
    -- contributes no continent: the badge under-reports by one, which is a far
    -- better failure than the whole Achievements screen erroring out because
    -- somebody's browser reported a country tzdata has since retired.
    'continents', (
      SELECT COUNT(DISTINCT c.continent)
      FROM my_plays mp
      JOIN public.boardgamebuddy_countries c ON c.code = mp.country_code
    ),
    -- ── Migration 019 ──────────────────────────────────────────────────────
    -- Plays this user LOGGED on a custom scoring grid, not every play they sat
    -- at. Applying a template is something the person keeping score does, so
    -- this reads p.user_id rather than my_plays — the same reasoning, and the
    -- same shape, as plays_with_notes above.
    'plays_with_grid', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_plays p
      WHERE p.user_id = uid AND p.scoring_template IS NOT NULL
    ),
    -- The BEST single scoring grid this user wrote, measured by how many OTHER
    -- people keep it. A MAX rather than a SUM on purpose: "gold standard" means
    -- one grid everybody uses, and summing would hand the badge to someone who
    -- wrote ten grids that one person each took — the opposite of what the name
    -- claims. Note this differs from chapters_borrowed above, which counts
    -- DISTINCT chapters and only ever needs to reach one.
    --
    -- `uc.user_id <> uid` drops the author's own row: create_chapter adds every
    -- new chapter to its creator's guide, so without it every grid would start
    -- life at 1.
    --
    -- The subquery returns no rows when the user has written no grids (or none
    -- has been adopted), and MAX over zero rows is NULL — hence the COALESCE,
    -- without which the metric would be absent from the JSONB and the progress
    -- bar would read as 0 by accident rather than by intent.
    'grid_adopters', COALESCE((
      SELECT MAX(t.adopters) FROM (
        SELECT COUNT(DISTINCT uc.user_id) AS adopters
        FROM public.boardgamebuddy_guide_chapters gc
        JOIN public.boardgamebuddy_user_chapters uc ON uc.chapter_id = gc.id
        WHERE gc.created_by = uid
          AND gc.layout = 'scoring_grid'
          AND uc.user_id <> uid
          AND uc.state = 'kept'   -- added in 033 (this file)
        GROUP BY gc.id
      ) t
    ), 0)
  )
  INTO m;

  -- ── 2. Pin the unlock date for anything newly earned ──────────────────────
  INSERT INTO public.boardgamebuddy_user_achievements (user_id, achievement_id)
  SELECT uid, a.id
  FROM public.boardgamebuddy_achievements a
  WHERE COALESCE((m ->> a.metric)::NUMERIC, 0) >= a.threshold
  ON CONFLICT (user_id, achievement_id) DO NOTHING;

  -- ── 3. The screen ─────────────────────────────────────────────────────────
  -- `earned` reads the unlock row, not the metric: step 2 has already written
  -- a row for everything currently clearing its bar, and keeping the row is
  -- what makes a badge permanent when a play is later deleted.
  SELECT jsonb_build_object(
    'total', COUNT(*),
    'earned_count', COUNT(*) FILTER (WHERE ua.user_id IS NOT NULL),
    'metrics', m,
    'groups', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', g.id, 'label', g.label, 'blurb', g.blurb
             ) ORDER BY g.display_order), '[]'::JSONB)
      FROM public.boardgamebuddy_achievement_groups g
    ),
    'achievements', COALESCE(jsonb_agg(jsonb_build_object(
        'id',          a.id,
        'group_id',    a.group_id,
        'name',        a.name,
        'tagline',     a.tagline,
        'requirement', a.requirement,
        'icon',        a.icon,
        'metric',      a.metric,
        'threshold',   a.threshold,
        -- Clamped for the progress bar; `metrics` above carries the raw value
        -- for anything that wants to print "312 plays".
        'progress',    LEAST(COALESCE((m ->> a.metric)::NUMERIC, 0), a.threshold)::INT,
        'earned',      ua.user_id IS NOT NULL,
        'unlocked_at', ua.unlocked_at
      ) ORDER BY a.display_order), '[]'::JSONB)
  )
  INTO payload
  FROM public.boardgamebuddy_achievements a
  LEFT JOIN public.boardgamebuddy_user_achievements ua
    ON ua.achievement_id = a.id AND ua.user_id = uid;

  RETURN payload;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_sync_achievements(uid uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_sync_achievements(uid uuid) TO boardgamebuddy_role;

-- bgb_unrank_game(p_user uuid, p_game uuid)
--   last defined in archive/2026-09-28/056_game_ranks.sql
CREATE OR REPLACE FUNCTION public.bgb_unrank_game(p_user uuid, p_game uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old boardgamebuddy_game_ranks%ROWTYPE;
BEGIN
  DELETE FROM boardgamebuddy_game_ranks
   WHERE user_id = p_user AND game_id = p_game
  RETURNING * INTO v_old;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('removed', false);
  END IF;
  UPDATE boardgamebuddy_game_ranks
     SET position = position - 1
   WHERE user_id = p_user AND category = v_old.category AND tier = v_old.tier
     AND position > v_old.position;
  RETURN jsonb_build_object('removed', true);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_unrank_game(p_user uuid, p_game uuid) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.bgb_unrank_game(p_user uuid, p_game uuid) IS 'Remove a game from a player''s ranking, closing the gap in its tier. Returns {removed}. Called by DELETE /api/v1/boardgame_buddy/ranks/games/{game_id} (migration 056).';

-- bgb_update_session_game(p_host uuid, p_code text, p_game uuid)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_update_session_game(p_host uuid, p_code text, p_game uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate JSONB;
  v_session UUID;
  v_current UUID;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, FALSE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;
  v_current := (v_gate ->> 'game_id')::UUID;

  IF v_current IS DISTINCT FROM p_game THEN
    UPDATE boardgamebuddy_play_sessions SET game_id = p_game WHERE id = v_session;
  END IF;

  RETURN bgb_session_bundle(v_session);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_update_session_game(p_host uuid, p_code text, p_game uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_update_session_game(p_host uuid, p_code text, p_game uuid) TO boardgamebuddy_role;

-- bgb_user_stats(uid uuid)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_user_stats(uid uuid)
 RETURNS TABLE(total_plays bigint, unique_games bigint, win_count bigint, last_played_at date, hours_played numeric, owned_games bigint, owned_expansions bigint, favorite_game_id uuid, favorite_game_name text, favorite_play_count bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH my_plays AS (
    SELECT p.id, p.game_id, p.played_at
    FROM public.boardgamebuddy_plays p
    WHERE p.user_id = uid
    UNION
    SELECT p.id, p.game_id, p.played_at
    FROM public.boardgamebuddy_plays p
    JOIN public.boardgamebuddy_play_players pp ON pp.play_id = p.id
    WHERE pp.player_user_id = uid
  ),
  game_counts AS (
    SELECT game_id, COUNT(*)::BIGINT AS n
    FROM my_plays
    GROUP BY game_id
  ),
  favorite AS (
    SELECT gc.game_id, gc.n, g.name
    FROM game_counts gc
    LEFT JOIN public.boardgamebuddy_games g ON g.id = gc.game_id
    ORDER BY gc.n DESC, g.name
    LIMIT 1
  )
  SELECT
    (SELECT COUNT(*)::BIGINT FROM my_plays)                                      AS total_plays,
    (SELECT COUNT(DISTINCT game_id)::BIGINT FROM my_plays)                       AS unique_games,
    (SELECT COUNT(*)::BIGINT
       FROM public.boardgamebuddy_play_players pp
       WHERE pp.player_user_id = uid AND pp.is_winner = true)                    AS win_count,
    (SELECT MAX(played_at) FROM my_plays)                                        AS last_played_at,
    COALESCE(
      (SELECT SUM(g.playing_time)::NUMERIC / 60.0
         FROM my_plays mp
         LEFT JOIN public.boardgamebuddy_games g ON g.id = mp.game_id),
      0
    )                                                                            AS hours_played,
    -- Owned BASE games only — what the user thinks of as "my games".
    (SELECT COUNT(*)::BIGINT
       FROM public.boardgamebuddy_collections c
       JOIN public.boardgamebuddy_games g ON g.id = c.game_id
       WHERE c.user_id = uid
         AND c.status = 'owned'
         AND COALESCE(g.is_expansion, false) = false)                            AS owned_games,
    -- Owned expansions — surfaced as a secondary counter on the Profile.
    (SELECT COUNT(*)::BIGINT
       FROM public.boardgamebuddy_collections c
       JOIN public.boardgamebuddy_games g ON g.id = c.game_id
       WHERE c.user_id = uid
         AND c.status = 'owned'
         AND g.is_expansion = true)                                              AS owned_expansions,
    (SELECT game_id FROM favorite)                                               AS favorite_game_id,
    (SELECT name     FROM favorite)                                              AS favorite_game_name,
    (SELECT n        FROM favorite)                                              AS favorite_play_count;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_user_stats(uid uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_user_stats(uid uuid) TO boardgamebuddy_role;

-- bgb_profile_bundle(viewer uuid, target uuid, col_per_page integer, plays_per_page integer)
--   last defined in archive/2026-09-28/057_played_mark.sql
CREATE OR REPLACE FUNCTION public.bgb_profile_bundle(viewer uuid, target uuid, col_per_page integer DEFAULT 12, plays_per_page integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_stats JSONB;
  v_owned_page JSONB;
  v_owned_total BIGINT;
  v_owned_parted_total BIGINT;
  v_wishlist_page JSONB;
  v_wishlist_total BIGINT;
  v_played_page JSONB;
  v_played_total BIGINT;
  v_recent_plays JSONB;
  v_recent_plays_total BIGINT;
  v_status_map JSONB;
  v_expansion_counts JSONB;
  v_buddies JSONB;
  v_buddy_incoming JSONB;
  v_buddy_outgoing JSONB;
  v_ghost_claims_incoming JSONB;
  v_together JSONB;
  v_top_games JSONB;
  v_is_self BOOLEAN := (viewer = target);
  v_is_buddy BOOLEAN := false;
BEGIN
  -- Edges are canonical (user_a < user_b), so match the pair either way round.
  IF NOT v_is_self THEN
    SELECT EXISTS (
      SELECT 1 FROM boardgamebuddy_buddy_edges be
      WHERE be.status = 'accepted'
        AND ((be.user_a = viewer AND be.user_b = target)
          OR (be.user_a = target AND be.user_b = viewer))
    ) INTO v_is_buddy;
  END IF;

  SELECT jsonb_build_object(
    'total_plays', COALESCE(s.total_plays, 0),
    'unique_games', COALESCE(s.unique_games, 0),
    'win_count', COALESCE(s.win_count, 0),
    'last_played_at', s.last_played_at,
    'hours_played', COALESCE(s.hours_played, 0)::FLOAT,
    'owned_games', COALESCE(s.owned_games, 0),
    'owned_expansions', COALESCE(s.owned_expansions, 0),
    'favorite_game', CASE
      WHEN s.favorite_game_id IS NOT NULL THEN jsonb_build_object(
        'game_id', s.favorite_game_id,
        'name', s.favorite_game_name,
        'play_count', COALESCE(s.favorite_play_count, 0)
      )
      ELSE NULL
    END
  ) INTO v_stats
  FROM bgb_user_stats(target) s;
  v_stats := COALESCE(v_stats, jsonb_build_object(
    'total_plays', 0, 'unique_games', 0, 'win_count', 0,
    'last_played_at', NULL, 'hours_played', 0,
    'owned_games', 0, 'owned_expansions', 0, 'favorite_game', NULL
  ));

  -- owned_total is games you actually OWN, so it keeps the bare 'owned'
  -- predicate: a prev_owned row (sold, gifted, donated — 069) is on the Owned
  -- shelf for display only and is counted separately, in owned_parted_total.
  -- owned_page below returns BOTH, because it is the Collection spoke's
  -- first-frame seed and has to hold the same rows bgb_collection_shelf will.
  SELECT
    COUNT(*) FILTER (WHERE c.status = 'owned'),
    COUNT(*) FILTER (WHERE c.status = 'prev_owned')
    INTO v_owned_total, v_owned_parted_total
    FROM boardgamebuddy_collections c
    WHERE c.user_id = target AND c.status IN ('owned', 'prev_owned')
      AND COALESCE(c.game_is_expansion, false) = false;

  SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY sort_order_a DESC NULLS LAST, sort_order_b DESC), '[]'::jsonb)
    INTO v_owned_page
    FROM (
      SELECT
        ps.last_played_at AS sort_order_a,
        c.added_at AS sort_order_b,
        jsonb_build_object(
          'id', c.id,
          'game_id', c.game_id,
          'status', c.status,
          'added_at', c.added_at,
          'last_played_at', ps.last_played_at,
          'play_count', COALESCE(ps.play_count, 0),
          'game', jsonb_build_object(
            'id', c.game_id,
            'bgg_id', c.game_bgg_id,
            'name', c.game_name,
            'year_published', c.game_year_published,
            'min_players', c.game_min_players,
            'max_players', c.game_max_players,
            'playing_time', c.game_playing_time,
            'thumbnail_url', c.game_thumbnail_url,
            'image_url', gi.image_url,
            'theme_color', c.game_theme_color,
            'is_expansion', COALESCE(c.game_is_expansion, false),
            'base_game_bgg_id', c.game_base_game_bgg_id,
            'expansion_color', c.game_expansion_color,
            'play_mode', COALESCE(c.game_play_mode, 'competitive'),
            'expansion_count', 0
          ),
          'expansions', '[]'::jsonb
        ) AS row_jsonb
      FROM boardgamebuddy_collections c
      LEFT JOIN boardgamebuddy_games gi ON gi.id = c.game_id
      -- image_url only — see the header. Every other game field stays denorm.
      LEFT JOIN LATERAL (
        SELECT MAX(p.played_at) AS last_played_at, COUNT(*)::INT AS play_count
        FROM boardgamebuddy_plays p
        WHERE p.game_id = c.game_id
          AND (
            p.user_id = target
            OR EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = target
            )
          )
      ) ps ON true
      WHERE c.user_id = target AND c.status IN ('owned', 'prev_owned')
        AND COALESCE(c.game_is_expansion, false) = false
      ORDER BY ps.last_played_at DESC NULLS LAST, c.added_at DESC
      LIMIT col_per_page
    ) p;

  SELECT COUNT(*) INTO v_wishlist_total
    FROM boardgamebuddy_collections c
    WHERE c.user_id = target AND c.status = 'wishlist'
      AND COALESCE(c.game_is_expansion, false) = false;

  SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY added_at DESC), '[]'::jsonb)
    INTO v_wishlist_page
    FROM (
      SELECT
        c.added_at,
        jsonb_build_object(
          'id', c.id,
          'game_id', c.game_id,
          'status', c.status,
          'added_at', c.added_at,
          'last_played_at', ps.last_played_at,
          'play_count', COALESCE(ps.play_count, 0),
          'game', jsonb_build_object(
            'id', c.game_id,
            'bgg_id', c.game_bgg_id,
            'name', c.game_name,
            'year_published', c.game_year_published,
            'min_players', c.game_min_players,
            'max_players', c.game_max_players,
            'playing_time', c.game_playing_time,
            'thumbnail_url', c.game_thumbnail_url,
            'image_url', gi.image_url,
            'theme_color', c.game_theme_color,
            'is_expansion', COALESCE(c.game_is_expansion, false),
            'base_game_bgg_id', c.game_base_game_bgg_id,
            'expansion_color', c.game_expansion_color,
            'play_mode', COALESCE(c.game_play_mode, 'competitive'),
            'expansion_count', 0
          ),
          'expansions', '[]'::jsonb
        ) AS row_jsonb
      FROM boardgamebuddy_collections c
      LEFT JOIN boardgamebuddy_games gi ON gi.id = c.game_id
      -- image_url only — see the header. Every other game field stays denorm.
      LEFT JOIN LATERAL (
        SELECT MAX(p.played_at) AS last_played_at, COUNT(*)::INT AS play_count
        FROM boardgamebuddy_plays p
        WHERE p.game_id = c.game_id
          AND (
            p.user_id = target
            OR EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = target
            )
          )
      ) ps ON true
      WHERE c.user_id = target AND c.status = 'wishlist'
        AND COALESCE(c.game_is_expansion, false) = false
      ORDER BY c.added_at DESC
      LIMIT col_per_page
    ) p;

  WITH played_games AS (
    -- EXISTS, not a LEFT JOIN onto play_players: the join fans one play out
    -- to one row per participant, so COUNT(*) over it multiplied every play
    -- the target logged by its player count. Matches bgb_play_stats (039).
    SELECT
      mp.game_id,
      MAX(mp.played_at) AS last_played_at,
      COUNT(*)::INT AS play_count
    FROM (
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
      UNION
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE pp.player_user_id = target
    ) mp
    GROUP BY mp.game_id
    UNION ALL
    -- Played but never logged here (status 'played', migration 057).
    -- A game with a play is already above, so only the rest join.
    SELECT c.game_id, NULL, 0
    FROM boardgamebuddy_collections c
    WHERE c.user_id = target AND c.status = 'played'
      AND NOT EXISTS (
            SELECT 1 FROM boardgamebuddy_plays p2
            WHERE p2.game_id = c.game_id
              AND (p2.user_id = target OR EXISTS (
                    SELECT 1 FROM boardgamebuddy_play_players pp2
                    WHERE pp2.play_id = p2.id AND pp2.player_user_id = target))
          )
  ),
  played_not_owned AS (
    SELECT pg.*
    FROM played_games pg
    WHERE NOT EXISTS (
      SELECT 1 FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.game_id = pg.game_id AND c.status <> 'played'
    )
  )
  SELECT COUNT(*) INTO v_played_total
    FROM played_not_owned pno
    JOIN boardgamebuddy_games g ON g.id = pno.game_id
    WHERE g.is_expansion = false;

  WITH played_games AS (
    -- EXISTS, not a LEFT JOIN onto play_players: the join fans one play out
    -- to one row per participant, so COUNT(*) over it multiplied every play
    -- the target logged by its player count. Matches bgb_play_stats (039).
    SELECT
      mp.game_id,
      MAX(mp.played_at) AS last_played_at,
      COUNT(*)::INT AS play_count
    FROM (
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
      UNION
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE pp.player_user_id = target
    ) mp
    GROUP BY mp.game_id
    UNION ALL
    -- Played but never logged here (status 'played', migration 057).
    -- A game with a play is already above, so only the rest join.
    SELECT c.game_id, NULL, 0
    FROM boardgamebuddy_collections c
    WHERE c.user_id = target AND c.status = 'played'
      AND NOT EXISTS (
            SELECT 1 FROM boardgamebuddy_plays p2
            WHERE p2.game_id = c.game_id
              AND (p2.user_id = target OR EXISTS (
                    SELECT 1 FROM boardgamebuddy_play_players pp2
                    WHERE pp2.play_id = p2.id AND pp2.player_user_id = target))
          )
  ),
  played_not_owned AS (
    SELECT pg.*
    FROM played_games pg
    WHERE NOT EXISTS (
      SELECT 1 FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.game_id = pg.game_id AND c.status <> 'played'
    )
  )
  SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY sort_order DESC NULLS LAST), '[]'::jsonb)
    INTO v_played_page
    FROM (
      SELECT
        pno.last_played_at AS sort_order,
        jsonb_build_object(
          'id', 'derived-' || pno.game_id::text,
          'game_id', pno.game_id,
          'status', 'played',
          'added_at', COALESCE(pno.last_played_at::TEXT || 'T00:00:00+00:00', (SELECT to_jsonb(c.added_at) #>> '{}' FROM boardgamebuddy_collections c WHERE c.user_id = target AND c.game_id = pno.game_id)),
          'last_played_at', pno.last_played_at,
          'play_count', pno.play_count,
          'game', jsonb_build_object(
            'id', g.id,
            'bgg_id', g.bgg_id,
            'name', g.name,
            'year_published', g.year_published,
            'min_players', g.min_players,
            'max_players', g.max_players,
            'playing_time', g.playing_time,
            'thumbnail_url', g.thumbnail_url,
            'image_url', g.image_url,
            'theme_color', g.theme_color,
            'is_expansion', g.is_expansion,
            'base_game_bgg_id', g.base_game_bgg_id,
            'expansion_color', g.expansion_color,
            'play_mode', g.play_mode,
            'expansion_count', 0
          ),
          'expansions', '[]'::jsonb
        ) AS row_jsonb
      FROM played_not_owned pno
      JOIN boardgamebuddy_games g ON g.id = pno.game_id
      WHERE g.is_expansion = false
      ORDER BY pno.last_played_at DESC
      LIMIT col_per_page
    ) p;

  -- The total is a general stat and stays visible to everyone; only the log
  -- below it is buddies-only.
  SELECT COUNT(*) INTO v_recent_plays_total
    FROM (
      SELECT p.id
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
      UNION
      SELECT p.id
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE pp.player_user_id = target
    ) mp;

  IF v_is_self OR v_is_buddy THEN
    SELECT COALESCE(jsonb_agg(play_row ORDER BY played_at DESC, created_at DESC), '[]'::jsonb)
      INTO v_recent_plays
      FROM (
        SELECT
          p.played_at, p.created_at,
          jsonb_build_object(
            'id', p.id,
            'game_id', p.game_id,
            'game_name', p.game_name,
            'game_thumbnail', p.game_thumbnail_url,
            'played_at', p.played_at,
            'notes', p.notes,
            'photo_url', p.photo_url,
            'play_mode', COALESCE(p.play_mode, 'competitive'),
            'created_at', p.created_at,
            'logged_by_id', p.user_id,
            'logged_by_name', COALESCE(pr.display_name, 'Unknown'),
            'is_own', p.user_id = viewer,
            'players', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'user_id', pp.player_user_id,
                'name', COALESCE(pp_pr.display_name, pp.player_display_name, 'Unknown'),
                'is_winner', COALESCE(pp.is_winner, false),
                'score', pp.score,
                'avatar', pp_pr.avatar
              ) ORDER BY pp.id)
              FROM boardgamebuddy_play_players pp
              LEFT JOIN boardgamebuddy_profiles pp_pr ON pp_pr.id = pp.player_user_id
              WHERE pp.play_id = p.id
            ), '[]'::jsonb),
            'expansions', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'expansion_game_id', pe.expansion_game_id,
                'name', eg.name,
                'color', eg.expansion_color
              ))
              FROM boardgamebuddy_play_expansions pe
              JOIN boardgamebuddy_games eg ON eg.id = pe.expansion_game_id
              WHERE pe.play_id = p.id
            ), '[]'::jsonb)
          ) AS play_row
        FROM (
          SELECT p.id, p.played_at, p.created_at
          FROM boardgamebuddy_plays p
          WHERE p.user_id = target
          UNION
          SELECT p.id, p.played_at, p.created_at
          FROM boardgamebuddy_plays p
          JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
          WHERE pp.player_user_id = target
          ORDER BY played_at DESC, created_at DESC
          LIMIT plays_per_page
        ) mp
        JOIN boardgamebuddy_plays p ON p.id = mp.id
        LEFT JOIN boardgamebuddy_profiles pr ON pr.id = p.user_id
        ORDER BY p.played_at DESC, p.created_at DESC
      ) r;
  ELSE
    -- NULL, not '[]': an empty array is the honest answer for "this person has
    -- never logged a play", and the screen says exactly that under it. A
    -- stranger must not be told that.
    v_recent_plays := NULL;
  END IF;

  -- No status filter, so prev_owned (069) reaches the map unaided — which is
  -- what the status tag and its picker sheet read to know which row to check.
  SELECT COALESCE(jsonb_object_agg(game_id, status), '{}'::jsonb)
    INTO v_status_map
    FROM (
      SELECT c.game_id, c.status
      FROM boardgamebuddy_collections c
      WHERE c.user_id = viewer
      UNION ALL
      SELECT DISTINCT p.game_id, 'played'::TEXT AS status
      FROM boardgamebuddy_plays p
      LEFT JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE (p.user_id = viewer OR pp.player_user_id = viewer)
        AND NOT EXISTS (
          SELECT 1 FROM boardgamebuddy_collections c2
          WHERE c2.user_id = viewer AND c2.game_id = p.game_id
        )
    ) m;

  -- Owned-only on purpose (069): an expansion you sold is no longer clutter on
  -- the base game's shelf. Mirrors bgb_collection_status_map's block exactly.
  SELECT COALESCE(jsonb_object_agg(base_bgg, cnt), '{}'::jsonb)
    INTO v_expansion_counts
    FROM (
      SELECT c.game_base_game_bgg_id AS base_bgg, COUNT(*)::INT AS cnt
      FROM boardgamebuddy_collections c
      WHERE c.user_id = viewer
        AND c.status = 'owned'
        AND COALESCE(c.game_is_expansion, false) = true
        AND c.game_base_game_bgg_id IS NOT NULL
      GROUP BY c.game_base_game_bgg_id
    ) e;

  -- ── Buddy-only blocks ──────────────────────────────────────────────────
  IF v_is_buddy THEN
    -- Shared record. Both sides must have a player row on the play — see the
    -- header on why the logger alone does not count and why co-op is out.
    -- GROUP BY p.id collapses the two joins back to one row per play, so a
    -- duplicated participant row cannot inflate the count.
    WITH shared AS (
      SELECT
        p.id AS play_id,
        p.played_at,
        COALESCE(BOOL_OR(vp.is_winner), false) AS you_won,
        COALESCE(BOOL_OR(tp.is_winner), false) AS they_won
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players vp
        ON vp.play_id = p.id AND vp.player_user_id = viewer
      JOIN boardgamebuddy_play_players tp
        ON tp.play_id = p.id AND tp.player_user_id = target
      WHERE COALESCE(p.play_mode, 'competitive') <> 'coop'
        -- Only plays that recorded a result. shared_plays is the denominator
        -- your_wins and their_wins are read against, so a play nobody won and
        -- nobody scored would show up as a game you both somehow lost.
        AND EXISTS (
          SELECT 1 FROM boardgamebuddy_play_players d
           WHERE d.play_id = p.id AND (d.is_winner OR d.score IS NOT NULL)
        )
      GROUP BY p.id, p.played_at
    )
    SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE jsonb_build_object(
      'shared_plays', COUNT(*)::INT,
      'your_wins', COUNT(*) FILTER (WHERE you_won)::INT,
      'their_wins', COUNT(*) FILTER (WHERE they_won)::INT,
      'last_played_at', MAX(played_at)
    ) END INTO v_together FROM shared;

    -- Target's three most-played games, over the same "logged it or sat at the
    -- table" set every other block here uses. Name and thumbnail come off the
    -- denormalized play columns (020), with boardgamebuddy_games filling in
    -- full-size art the plays table never carried.
    SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY plays DESC, name), '[]'::jsonb)
      INTO v_top_games
      FROM (
        SELECT
          tg.plays,
          tg.name,
          jsonb_build_object(
            'game_id', tg.game_id,
            'name', tg.name,
            'thumbnail_url', COALESCE(g.thumbnail_url, tg.thumbnail_url),
            'image_url', g.image_url,
            'play_count', tg.plays,
            'last_played_at', tg.last_played_at
          ) AS row_jsonb
        FROM (
          SELECT
            mp.game_id,
            MAX(mp.game_name) AS name,
            MAX(mp.game_thumbnail_url) AS thumbnail_url,
            MAX(mp.played_at) AS last_played_at,
            COUNT(*)::INT AS plays
          FROM (
            SELECT p.id, p.game_id, p.game_name, p.game_thumbnail_url, p.played_at
            FROM boardgamebuddy_plays p
            WHERE p.user_id = target
            UNION
            SELECT p.id, p.game_id, p.game_name, p.game_thumbnail_url, p.played_at
            FROM boardgamebuddy_plays p
            JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
            WHERE pp.player_user_id = target
          ) mp
          GROUP BY mp.game_id
          ORDER BY plays DESC, name
          LIMIT 3
        ) tg
        LEFT JOIN boardgamebuddy_games g ON g.id = tg.game_id
      ) t;
  ELSE
    v_together := NULL;
    v_top_games := NULL;
  END IF;

  IF v_is_self THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', be.id,
      'other_user_id', CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END,
      'other_display_name', pr.display_name,
      'other_avatar', pr.avatar,
      'accepted_at', be.accepted_at,
      'created_at', be.created_at
    ) ORDER BY pr.display_name), '[]'::jsonb)
      INTO v_buddies
      FROM boardgamebuddy_buddy_edges be
      JOIN boardgamebuddy_profiles pr
        ON pr.id = (CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END)
      WHERE (be.user_a = viewer OR be.user_b = viewer) AND be.status = 'accepted';

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', be.id,
      'direction', 'incoming',
      'other_user_id', CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END,
      'other_display_name', pr.display_name,
      'other_avatar', pr.avatar,
      'created_at', be.created_at
    ) ORDER BY be.created_at DESC), '[]'::jsonb)
      INTO v_buddy_incoming
      FROM boardgamebuddy_buddy_edges be
      JOIN boardgamebuddy_profiles pr
        ON pr.id = (CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END)
      WHERE (be.user_a = viewer OR be.user_b = viewer)
        AND be.status = 'pending'
        AND be.requested_by <> viewer;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', be.id,
      'direction', 'outgoing',
      'other_user_id', CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END,
      'other_display_name', pr.display_name,
      'other_avatar', pr.avatar,
      'created_at', be.created_at
    ) ORDER BY be.created_at DESC), '[]'::jsonb)
      INTO v_buddy_outgoing
      FROM boardgamebuddy_buddy_edges be
      JOIN boardgamebuddy_profiles pr
        ON pr.id = (CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END)
      WHERE (be.user_a = viewer OR be.user_b = viewer)
        AND be.status = 'pending'
        AND be.requested_by = viewer;

    -- Ghost claims waiting on the viewer (migration 070). Same shape and same
    -- reason as buddy_requests_incoming: the Profile tab's dot and the Buddies
    -- card's count both have to be right on FIRST PAINT, and /bootstrap
    -- already carries this bundle. A separate fetch would put a round trip on
    -- the app's slowest path to publish one integer.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', gc.id,
      'direction', 'incoming',
      'other_user_id', pr.id,
      'other_display_name', pr.display_name,
      'other_avatar', pr.avatar,
      'ghost_display_name', gc.ghost_display_name,
      'created_at', gc.created_at
    ) ORDER BY gc.created_at DESC), '[]'::jsonb)
      INTO v_ghost_claims_incoming
      FROM boardgamebuddy_ghost_claims gc
      JOIN boardgamebuddy_profiles pr ON pr.id = gc.claimant_id
     WHERE gc.owner_id = viewer AND gc.status = 'pending';
  ELSE
    v_buddies := NULL;
    v_buddy_incoming := NULL;
    v_buddy_outgoing := NULL;
    v_ghost_claims_incoming := NULL;
  END IF;

  RETURN jsonb_build_object(
    'is_buddy', v_is_buddy,
    'stats', v_stats,
    'owned_page', v_owned_page,
    'owned_total', v_owned_total,
    'owned_parted_total', v_owned_parted_total,
    'wishlist_page', v_wishlist_page,
    'wishlist_total', v_wishlist_total,
    'played_page', v_played_page,
    'played_total', v_played_total,
    'recent_plays', v_recent_plays,
    'recent_plays_total', v_recent_plays_total,
    'together', v_together,
    'top_games', v_top_games,
    'status_map', v_status_map,
    'expansion_counts', v_expansion_counts,
    'buddies', v_buddies,
    'buddy_requests_incoming', v_buddy_incoming,
    'buddy_requests_outgoing', v_buddy_outgoing,
    'ghost_claims_incoming', v_ghost_claims_incoming
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_profile_bundle(viewer uuid, target uuid, col_per_page integer, plays_per_page integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_profile_bundle(viewer uuid, target uuid, col_per_page integer, plays_per_page integer) TO boardgamebuddy_role;

-- bgb_bootstrap(viewer uuid, owned_plays_limit integer, max_game_bundles integer)
--   last defined in archive/2026-09-28/003_rpcs.sql
CREATE OR REPLACE FUNCTION public.bgb_bootstrap(viewer uuid, owned_plays_limit integer DEFAULT 5, max_game_bundles integer DEFAULT 250)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current_user JSONB;
  v_profile_bundle JSONB;
  v_game_bundles JSONB := '{}'::jsonb;
  v_owned_count INT;
  v_truncated BOOLEAN := false;
BEGIN
  -- Current user row.
  SELECT to_jsonb(p.*) INTO v_current_user
    FROM boardgamebuddy_profiles p
    WHERE p.id = viewer;

  -- Profile bundle (stats, shelves, recent plays, status map, buddies,
  -- requests) for the viewer looking at themselves.
  v_profile_bundle := bgb_profile_bundle(viewer, viewer, 12, 10);

  -- Owned-game count. Base games only — expansions are surfaced via the base
  -- game's bundle.expansions block.
  SELECT COUNT(*) INTO v_owned_count
    FROM boardgamebuddy_collections c
    WHERE c.user_id = viewer
      AND c.status = 'owned'
      AND COALESCE(c.game_is_expansion, false) = false;

  IF max_game_bundles > 0 THEN
    v_truncated := v_owned_count > max_game_bundles;

    WITH owned AS (
      SELECT c.game_id
      FROM boardgamebuddy_collections c
      WHERE c.user_id = viewer
        AND c.status = 'owned'
        AND COALESCE(c.game_is_expansion, false) = false
      ORDER BY c.added_at DESC
      LIMIT max_game_bundles
    )
    SELECT COALESCE(jsonb_object_agg(o.game_id::text, bgb_game_detail_bundle(o.game_id, viewer, owned_plays_limit)), '{}'::jsonb)
      INTO v_game_bundles
      FROM owned o;
  END IF;

  RETURN jsonb_build_object(
    'bootstrap_version', 2,
    'generated_at', now(),
    'current_user', v_current_user,
    'profile_bundle', v_profile_bundle,
    'game_detail_bundles', v_game_bundles,
    'owned_count', v_owned_count,
    'truncated', v_truncated
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_bootstrap(viewer uuid, owned_plays_limit integer, max_game_bundles integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_bootstrap(viewer uuid, owned_plays_limit integer, max_game_bundles integer) TO boardgamebuddy_role;

-- bgb_user_stats_detail(uid uuid)
--   last defined in archive/2026-09-28/020_unscored_plays.sql
CREATE OR REPLACE FUNCTION public.bgb_user_stats_detail(uid uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH
-- ── The play set every block below reads ──────────────────────────────────
my_plays AS (
  SELECT p.id, p.game_id, p.played_at, p.play_mode, p.game_name
  FROM public.boardgamebuddy_plays p
  WHERE p.user_id = uid
  UNION
  SELECT p.id, p.game_id, p.played_at, p.play_mode, p.game_name
  FROM public.boardgamebuddy_plays p
  JOIN public.boardgamebuddy_play_players pp ON pp.play_id = p.id
  WHERE pp.player_user_id = uid
),
-- My own player row on each of those plays. The gap between this and my_plays
-- is the one the header comment describes: a play I logged but sat out has no
-- row here, so it has no result, no score and no side in a co-op record.
mine AS (
  SELECT mp.id AS play_id, mp.game_id, mp.played_at, mp.play_mode,
         pp.is_winner, pp.score, pp.round_scores,
         -- Did this play record an outcome at all? A play where NO seat is
         -- flagged a winner and NO seat carries a score says nothing about how
         -- it went — it is not a loss, it is a blank. It is still a play (it
         -- counts in total_plays, the heatmap, the podium, table sizes), but a
         -- win-rate denominator that swallows it reports losses nobody had.
         -- Read over the whole roster, not just my own seat: a play someone
         -- else won is decided for me too.
         EXISTS (
           SELECT 1 FROM public.boardgamebuddy_play_players d
            WHERE d.play_id = mp.id
              AND (d.is_winner OR d.score IS NOT NULL)
         ) AS decided
  FROM my_plays mp
  JOIN public.boardgamebuddy_play_players pp
    ON pp.play_id = mp.id AND pp.player_user_id = uid
),
by_game AS (
  SELECT mp.game_id,
         COALESCE(MAX(g.name), MAX(mp.game_name))    AS name,
         MAX(g.thumbnail_url)                        AS thumbnail_url,
         COALESCE(MAX(g.play_mode), 'competitive')   AS play_mode,
         COUNT(*)::INT                               AS plays,
         MAX(mp.played_at)                           AS last_played_at
  FROM my_plays mp
  LEFT JOIN public.boardgamebuddy_games g ON g.id = mp.game_id
  GROUP BY mp.game_id
),

-- ── Per-game breakdown (drives the picker) ────────────────────────────────
-- avg_winning_score averages the WINNER's score across my plays of that game —
-- the bar to clear, carried alongside my own average rather than in place of
-- it. Both are NULL when nobody logged a score (co-op games, and any table that
-- just called a winner), which is what the screen's "no scores" state reads.
winner_scores AS (
  SELECT mp.game_id, w.play_id, w.score
  FROM public.boardgamebuddy_play_players w
  JOIN my_plays mp ON mp.id = w.play_id
  WHERE w.is_winner AND w.score IS NOT NULL
),
game_rows AS (
  SELECT
    bg.game_id, bg.name, bg.thumbnail_url, bg.play_mode, bg.plays, bg.last_played_at,
    (SELECT COUNT(*)::INT FROM mine m
      WHERE m.game_id = bg.game_id AND m.is_winner)                       AS wins,
    -- The ring's denominator. `plays` above stays the honest play count (it
    -- includes plays I logged but sat out, and plays with no result); this is
    -- the subset that can be won or lost, so wins + losses adds up to it.
    (SELECT COUNT(*)::INT FROM mine m
      WHERE m.game_id = bg.game_id AND m.decided)                         AS decided_plays,
    (SELECT COUNT(DISTINCT ws.play_id)::INT FROM winner_scores ws
      WHERE ws.game_id = bg.game_id)                                      AS scored_plays,
    (SELECT ROUND(AVG(ws.score))::INT FROM winner_scores ws
      WHERE ws.game_id = bg.game_id)                                      AS avg_winning_score,
    (SELECT ROUND(AVG(m.score))::INT FROM mine m
      WHERE m.game_id = bg.game_id AND m.score IS NOT NULL)               AS your_avg_score,
    (SELECT MAX(m.score) FROM mine m WHERE m.game_id = bg.game_id)        AS your_best_score
  FROM by_game bg
  ORDER BY bg.plays DESC, bg.name
  LIMIT 100
),

-- ── Nemesis ───────────────────────────────────────────────────────────────
-- The account that has beaten me most across COMPETITIVE plays we both sat in.
-- Ranked by their wins, then by how often we've played; a 3-play floor keeps
-- one lucky evening from crowning anyone. Ghost players (no player_user_id)
-- can't be a nemesis — there is no profile to name or badge.
--
-- Co-op plays are excluded, and not just because "who beat whom" is meaningless
-- when you are on the same side: in co-op EVERY seat at the table wins or loses
-- together, so counting them made your_wins and their_wins both fire on the
-- same play. That double-count is visible, not academic — the screen draws
-- you/them/someone-else as one split bar, and with co-op folded in the segments
-- summed past the total.
opponents AS (
  SELECT o.play_id, o.player_user_id, o.is_winner
  FROM public.boardgamebuddy_play_players o
  JOIN mine m ON m.play_id = o.play_id
  WHERE o.player_user_id IS NOT NULL
    AND o.player_user_id <> uid
    AND COALESCE(m.play_mode, 'competitive') <> 'coop'
    AND m.decided
),
nemesis_row AS (
  SELECT
    op.player_user_id                                    AS user_id,
    pr.display_name,
    pr.avatar,
    COUNT(DISTINCT op.play_id)::INT                      AS shared_plays,
    COUNT(*) FILTER (WHERE op.is_winner)::INT            AS their_wins,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM mine m2 WHERE m2.play_id = op.play_id AND m2.is_winner
    ))::INT                                              AS your_wins
  FROM opponents op
  JOIN public.boardgamebuddy_profiles pr ON pr.id = op.player_user_id
  GROUP BY op.player_user_id, pr.display_name, pr.avatar
  HAVING COUNT(DISTINCT op.play_id) >= 3
  ORDER BY their_wins DESC, shared_plays DESC
  LIMIT 1
),

-- ── Play rhythm ───────────────────────────────────────────────────────────
-- 26 weeks of buckets for the heatmap, plus streaks over ALL history — the
-- longest streak predates the window more often than not.
week_buckets AS (
  SELECT date_trunc('week', mp.played_at)::DATE AS wk, COUNT(*)::INT AS n
  FROM my_plays mp
  GROUP BY 1
),
heat AS (
  SELECT s.wk::DATE AS wk, COALESCE(wb.n, 0) AS n
  FROM generate_series(
         date_trunc('week', CURRENT_DATE) - INTERVAL '25 weeks',
         date_trunc('week', CURRENT_DATE),
         INTERVAL '1 week') AS s(wk)
  LEFT JOIN week_buckets wb ON wb.wk = s.wk::DATE
),
-- Gaps-and-islands: consecutive weeks share (wk - row_number * 7).
streak_runs AS (
  SELECT COUNT(*)::INT AS len, MAX(wk) AS last_wk
  FROM (
    SELECT wk, wk - (ROW_NUMBER() OVER (ORDER BY wk))::INT * 7 AS grp
    FROM week_buckets
  ) g
  GROUP BY grp
),
weekday AS (
  SELECT EXTRACT(DOW FROM mp.played_at)::INT AS dow, COUNT(*)::INT AS plays
  FROM my_plays mp
  GROUP BY 1
  ORDER BY 2 DESC, 1
  LIMIT 1
),

-- ── Table size ────────────────────────────────────────────────────────────
-- Buckets cap at 5+; the tail past six players is one thin bar nobody reads.
-- Plays with no roster at all (a bare BGG import) are excluded so they can't
-- drag the average toward zero.
roster AS (
  SELECT mp.id AS play_id,
         (SELECT COUNT(*)::INT FROM public.boardgamebuddy_play_players pp
           WHERE pp.play_id = mp.id) AS n
  FROM my_plays mp
),

-- ── Comeback kid ──────────────────────────────────────────────────────────
-- Plays I won after trailing at the halfway round. Only computable because
-- round_scores stores the round-by-round breakdown; every other surface in the
-- app can see a play's result but not its shape.
tracked AS (
  SELECT pp.play_id, pp.player_user_id, pp.is_winner, pp.round_scores,
         jsonb_array_length(pp.round_scores) AS n
  FROM public.boardgamebuddy_play_players pp
  JOIN my_plays mp ON mp.id = pp.play_id
  WHERE pp.round_scores IS NOT NULL
    AND jsonb_typeof(pp.round_scores) = 'array'
    AND jsonb_array_length(pp.round_scores) >= 2
),
half AS (
  -- Cumulative score through the midpoint. A round cell holds null until it is
  -- entered, so anything that isn't a JSON number counts as zero rather than
  -- failing the whole call on a cast.
  SELECT t.play_id, t.player_user_id, t.is_winner,
         (SELECT COALESCE(SUM(CASE WHEN jsonb_typeof(e.value) = 'number'
                                   THEN (e.value #>> '{}')::NUMERIC
                                   ELSE 0 END), 0)
            FROM jsonb_array_elements(t.round_scores) WITH ORDINALITY AS e(value, idx)
           WHERE e.idx <= GREATEST(1, t.n / 2)) AS half_score
  FROM tracked t
),
half_lead AS (
  SELECT play_id, MAX(half_score) AS best_half FROM half GROUP BY play_id
),

-- ── Personal bests ────────────────────────────────────────────────────────
-- Ordered by how much I play the game, not by score: 168 at Brass and 94 at
-- Wingspan are not comparable numbers, so the useful ordering is "the records
-- you would actually try to beat".
best_rows AS (
  SELECT bg.game_id, bg.name, bg.plays, b.score, b.played_at
  FROM by_game bg
  JOIN LATERAL (
    SELECT m.score, m.played_at
    FROM mine m
    WHERE m.game_id = bg.game_id AND m.score IS NOT NULL
      -- A co-op loss records a deliberate 0 (see the FE's _stampCoopLoss), and
      -- "your personal best at Pandemic: 0" is not a record anybody set.
      AND COALESCE(m.play_mode, 'competitive') <> 'coop'
    ORDER BY m.score DESC, m.played_at DESC
    LIMIT 1
  ) b ON true
  ORDER BY bg.plays DESC, bg.name
  LIMIT 5
)

SELECT jsonb_build_object(
  -- career.win_rate is left to the caller: it divides rated_wins by
  -- rated_plays, never win_count by total_plays. A co-op win is the table
  -- beating the game and belongs in its own block; a play I logged but sat
  -- out has no result at all; and neither does a play nobody won and nobody
  -- scored, which is what `decided` filters out of every ratio below.
  'career', jsonb_build_object(
    'total_plays',     (SELECT COUNT(*)::INT FROM my_plays),
    'unique_games',    (SELECT COUNT(DISTINCT game_id)::INT FROM my_plays),
    'win_count',       (SELECT COUNT(*)::INT FROM mine WHERE is_winner),
    'rated_plays',     (SELECT COUNT(*)::INT FROM mine WHERE COALESCE(play_mode, 'competitive') <> 'coop' AND decided),
    'rated_wins',      (SELECT COUNT(*)::INT FROM mine WHERE COALESCE(play_mode, 'competitive') <> 'coop' AND is_winner),
    'first_played_at', (SELECT MIN(played_at) FROM my_plays),
    'last_played_at',  (SELECT MAX(played_at) FROM my_plays),
    'hours_played',    COALESCE((
      SELECT ROUND(SUM(g.playing_time)::NUMERIC / 60.0)
      FROM my_plays mp LEFT JOIN public.boardgamebuddy_games g ON g.id = mp.game_id
    ), 0)::FLOAT
  ),

  'podium', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'game_id', game_id, 'name', name,
             'thumbnail_url', thumbnail_url, 'plays', plays)
             ORDER BY plays DESC, name)
    FROM (SELECT * FROM game_rows ORDER BY plays DESC, name LIMIT 3) p
  ), '[]'::JSONB),

  'games', COALESCE((SELECT jsonb_agg(to_jsonb(gr) ORDER BY gr.plays DESC, gr.name)
                       FROM game_rows gr), '[]'::JSONB),

  'nemesis', (SELECT to_jsonb(n) FROM nemesis_row n),

  'rhythm', jsonb_build_object(
    'weeks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('week_start', wk, 'plays', n) ORDER BY wk)
      FROM heat
    ), '[]'::JSONB),
    'longest_streak_weeks', COALESCE((SELECT MAX(len) FROM streak_runs), 0),
    -- The run that is still alive must reach this week or last week. Requiring
    -- the current week would reset every streak each Monday morning, before
    -- that week's game night has happened.
    'current_streak_weeks', COALESCE((
      SELECT MAX(len) FROM streak_runs
      WHERE last_wk >= (date_trunc('week', CURRENT_DATE)::DATE - 7)
    ), 0),
    'busiest_weekday', (SELECT to_jsonb(w) FROM weekday w)
  ),

  -- Owned BASE games only, matching what bgb_user_stats calls owned_games — an
  -- unplayed expansion is not a guilt trip, it is a box on a shelf.
  --
  -- 'played' counts a game the viewer has plays for OR has hand-marked as
  -- played before they joined (played_before_at). The mark is deliberately
  -- scoped to THIS block: it creates no play row, so every other aggregate on
  -- this screen — the podium, the rhythm heatmap, personal bests, career
  -- totals — is untouched by it, and so is the collection's status map.
  --
  -- 'games' is the list the Stats spoke's shelf sheet renders: every owned
  -- base game with NO logged plays, marked or not. A game with real plays is
  -- not a shelf-of-shame candidate and has no mark to undo, so it never needs
  -- to be in here. Capped, because a BGG import can be four figures.
  'shelf', (
    WITH owned_base AS (
      SELECT c.game_id, c.game_name, c.game_thumbnail_url, c.game_year_published,
             c.played_before_at,
             EXISTS (SELECT 1 FROM my_plays mp WHERE mp.game_id = c.game_id) AS has_plays
      FROM public.boardgamebuddy_collections c
      JOIN public.boardgamebuddy_games g ON g.id = c.game_id
      WHERE c.user_id = uid AND c.status = 'owned'
        AND COALESCE(g.is_expansion, false) = false
    )
    SELECT jsonb_build_object(
      'owned',    COUNT(*)::INT,
      'played',   COUNT(*) FILTER (WHERE has_plays OR played_before_at IS NOT NULL)::INT,
      'unplayed', COUNT(*) FILTER (WHERE NOT has_plays AND played_before_at IS NULL)::INT,
      'marked',   COUNT(*) FILTER (WHERE NOT has_plays AND played_before_at IS NOT NULL)::INT,
      'games', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'game_id',        t.game_id,
                 'name',           t.game_name,
                 'thumbnail_url',  t.game_thumbnail_url,
                 'year_published', t.game_year_published,
                 'played_before',  t.played_before_at IS NOT NULL
               ) ORDER BY t.game_name)
        FROM (
          SELECT * FROM owned_base WHERE NOT has_plays
          ORDER BY game_name LIMIT 300
        ) t
      ), '[]'::JSONB),
      'games_truncated',
        (SELECT COUNT(*) FROM owned_base WHERE NOT has_plays) > 300
    )
    FROM owned_base
  ),

  'table_size', jsonb_build_object(
    'avg', (SELECT ROUND(AVG(n)::NUMERIC, 1)::FLOAT FROM roster WHERE n > 0),
    'buckets', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('size', size, 'plays', plays) ORDER BY size)
      FROM (
        SELECT LEAST(n, 5) AS size, COUNT(*)::INT AS plays
        FROM roster WHERE n > 0 GROUP BY 1
      ) b
    ), '[]'::JSONB)
  ),

  -- Weighted by plays, not by what is on the shelf: this answers "what do you
  -- actually put on the table", which the collection cannot.
  'taste', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('name', cat, 'plays', n) ORDER BY n DESC, cat)
    FROM (
      SELECT cat, COUNT(*)::INT AS n
      FROM my_plays mp
      JOIN public.boardgamebuddy_games g ON g.id = mp.game_id
      CROSS JOIN LATERAL unnest(COALESCE(g.categories, '{}')) AS cat
      WHERE cat IS NOT NULL AND cat <> ''
      GROUP BY cat
      ORDER BY n DESC, cat
      LIMIT 6
    ) q
  ), '[]'::JSONB),

  'comeback', jsonb_build_object(
    'wins_from_behind', (
      SELECT COUNT(*)::INT
      FROM half h JOIN half_lead hl ON hl.play_id = h.play_id
      WHERE h.player_user_id = uid AND h.is_winner AND h.half_score < hl.best_half
    ),
    'tracked_plays', (
      SELECT COUNT(DISTINCT h.play_id)::INT FROM half h WHERE h.player_user_id = uid
    )
  ),

  -- Kept out of the competitive win rate on purpose: folding co-op in would
  -- quietly inflate a number people read as head-to-head.
  'coop', (
    SELECT jsonb_build_object(
      'wins',   COUNT(*) FILTER (WHERE is_winner)::INT,
      'losses', COUNT(*) FILTER (WHERE NOT COALESCE(is_winner, false))::INT
    )
    FROM mine WHERE play_mode = 'coop' AND decided
  ),

  'personal_bests', COALESCE((SELECT jsonb_agg(to_jsonb(br) ORDER BY br.plays DESC, br.name)
                               FROM best_rows br), '[]'::JSONB)
);
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_user_stats_detail(uid uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_user_stats_detail(uid uuid) TO boardgamebuddy_role;

-- bgb_watch_session(p_code text, p_viewer uuid)
--   last defined in archive/2026-09-28/027_session_viewers.sql
CREATE OR REPLACE FUNCTION public.bgb_watch_session(p_code text, p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
  v_expires TIMESTAMPTZ;
BEGIN
  SELECT s.id, s.expires_at
    INTO v_id, v_expires
    FROM boardgamebuddy_play_sessions s
    WHERE s.code = upper(p_code)
      AND s.status = 'open';

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_expires < now() THEN
    UPDATE boardgamebuddy_play_sessions
       SET status = 'abandoned'
     WHERE id = v_id;
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  -- Idempotent: the viewer screen calls this on every open, and a reload must
  -- not move first_seen_at.
  IF p_viewer IS NOT NULL THEN
    INSERT INTO boardgamebuddy_play_session_viewers (session_id, user_id)
    VALUES (v_id, p_viewer)
    ON CONFLICT (session_id, user_id) DO NOTHING;
  END IF;

  RETURN bgb_session_bundle(v_id);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_watch_session(p_code text, p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_watch_session(p_code text, p_viewer uuid) TO boardgamebuddy_role;

-- boardgamebuddy_search_games(p_viewer uuid, p_query text, p_limit integer, p_include_expansions boolean)
--   last defined in archive/2026-09-28/057_played_mark.sql
CREATE OR REPLACE FUNCTION public.boardgamebuddy_search_games(p_viewer uuid, p_query text, p_limit integer DEFAULT 20, p_include_expansions boolean DEFAULT false)
 RETURNS TABLE(id uuid, bgg_id integer, name text, year_published integer, min_players integer, max_players integer, playing_time integer, thumbnail_url text, image_url text, theme_color text, is_expansion boolean, base_game_bgg_id integer, expansion_color text, rulebook_url text, play_mode text, collection_status text, in_collection boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    g.id,
    g.bgg_id,
    g.name,
    g.year_published,
    g.min_players,
    g.max_players,
    g.playing_time,
    g.thumbnail_url,
    g.image_url,
    g.theme_color,
    g.is_expansion,
    g.base_game_bgg_id,
    g.expansion_color,
    g.rulebook_url,
    g.play_mode,
    c.status                 AS collection_status,
    (c.user_id IS NOT NULL)  AS in_collection
  FROM public.boardgamebuddy_games g
  -- A mark-only 'played' row (057) is not a shelf: the game is a catalog hit,
  -- as one with only logged plays is.
  LEFT JOIN public.boardgamebuddy_collections c
    ON c.game_id = g.id AND c.user_id = p_viewer AND c.status <> 'played'
  WHERE g.name ILIKE '%' || COALESCE(p_query, '') || '%'
    AND (COALESCE(p_include_expansions, false) OR NOT g.is_expansion)
  ORDER BY (c.user_id IS NOT NULL) DESC, g.name
  LIMIT GREATEST(COALESCE(p_limit, 20), 0);
$function$;
REVOKE EXECUTE ON FUNCTION public.boardgamebuddy_search_games(p_viewer uuid, p_query text, p_limit integer, p_include_expansions boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.boardgamebuddy_search_games(p_viewer uuid, p_query text, p_limit integer, p_include_expansions boolean) TO boardgamebuddy_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Row-level security policies (7)
-- ─────────────────────────────────────────────────────────────────────────────
-- After the functions, since a policy expression may call one.

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
