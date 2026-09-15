-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — Phase 2: denormalize stable game fields onto plays + collections
--
-- Every play/collection read currently JOINs boardgamebuddy_games to surface
-- the title, image, and basic metadata used to render a tile. Games are
-- immutable after BGG import (the only writers are admin re-host paths),
-- so caching those fields on the dependent rows is safe and turns every
-- list endpoint into a single-table read.
--
-- Phase 3 (bundle RPCs) will be the first consumer; Phase 2 just lays the
-- columns down, backfills them, and sets up writers to keep them current.
-- Reads still work through the existing JOINs until they're rewritten.
--
-- Sync strategy: NO triggers. The only writers to boardgamebuddy_games are
-- a handful of admin paths in game_routes.py; they call a tiny Python helper
-- (_sync_denormalized_game_fields) to fan changes out. New play/collection
-- inserts populate the columns inline. This keeps the write path explicit
-- and avoids a trigger that would have to handle every column we ever cache.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── boardgamebuddy_plays ─────────────────────────────────────────────────────
ALTER TABLE public.boardgamebuddy_plays
  ADD COLUMN IF NOT EXISTS game_name TEXT,
  ADD COLUMN IF NOT EXISTS game_thumbnail_url TEXT,
  ADD COLUMN IF NOT EXISTS game_image_url TEXT,
  -- The intrinsic mode of the game, distinct from boardgamebuddy_plays.play_mode
  -- (which is the per-play mode the user picked, e.g. playing a competitive
  -- game cooperatively). Filtering "show me my coop plays" uses game_play_mode.
  ADD COLUMN IF NOT EXISTS game_play_mode TEXT;

UPDATE public.boardgamebuddy_plays p
   SET game_name = g.name,
       game_thumbnail_url = g.thumbnail_url,
       game_image_url = g.image_url,
       game_play_mode = g.play_mode
  FROM public.boardgamebuddy_games g
 WHERE p.game_id = g.id
   AND p.game_name IS NULL;

ALTER TABLE public.boardgamebuddy_plays
  ALTER COLUMN game_name SET NOT NULL;


-- ── boardgamebuddy_collections ───────────────────────────────────────────────
ALTER TABLE public.boardgamebuddy_collections
  ADD COLUMN IF NOT EXISTS game_name TEXT,
  ADD COLUMN IF NOT EXISTS game_thumbnail_url TEXT,
  ADD COLUMN IF NOT EXISTS game_year_published INTEGER,
  ADD COLUMN IF NOT EXISTS game_min_players SMALLINT,
  ADD COLUMN IF NOT EXISTS game_max_players SMALLINT,
  ADD COLUMN IF NOT EXISTS game_playing_time SMALLINT,
  ADD COLUMN IF NOT EXISTS game_is_expansion BOOLEAN,
  ADD COLUMN IF NOT EXISTS game_base_game_bgg_id INTEGER,
  ADD COLUMN IF NOT EXISTS game_expansion_color TEXT,
  ADD COLUMN IF NOT EXISTS game_play_mode TEXT,
  ADD COLUMN IF NOT EXISTS game_bgg_id INTEGER,
  ADD COLUMN IF NOT EXISTS game_theme_color TEXT;

UPDATE public.boardgamebuddy_collections c
   SET game_name = g.name,
       game_thumbnail_url = g.thumbnail_url,
       game_year_published = g.year_published,
       game_min_players = g.min_players,
       game_max_players = g.max_players,
       game_playing_time = g.playing_time,
       game_is_expansion = g.is_expansion,
       game_base_game_bgg_id = g.base_game_bgg_id,
       game_expansion_color = g.expansion_color,
       game_play_mode = g.play_mode,
       game_bgg_id = g.bgg_id,
       game_theme_color = g.theme_color
  FROM public.boardgamebuddy_games g
 WHERE c.game_id = g.id
   AND c.game_name IS NULL;

ALTER TABLE public.boardgamebuddy_collections
  ALTER COLUMN game_name SET NOT NULL;


-- Shelf alphabetical sort: (user_id, status, game_name) covers the
-- "owned/wishlist sorted by name" page Phase 3's bgb_collection_shelf
-- RPC will rely on without a sort-after-scan.
CREATE INDEX IF NOT EXISTS idx_bgb_collections_user_status_name
  ON public.boardgamebuddy_collections (user_id, status, game_name);

COMMIT;
