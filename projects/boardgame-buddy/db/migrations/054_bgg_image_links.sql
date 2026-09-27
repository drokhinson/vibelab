-- ─────────────────────────────────────────────────────────────────────────────
-- 054_bgg_image_links.sql — keep BoardGameGeek's own image URLs, and remember
--                           BGG search thumbnails between searches
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. GAMES KEEP BGG'S URLS NEXT TO OURS. Every import downloads BGG's box art
--    and re-hosts it (R2, Supabase Storage as the rollback), writing only the
--    re-hosted URL — BGG's own was read and thrown away. These two columns keep
--    it, so serving BGG's CDN directly later is a read-side switch rather than
--    a re-crawl. image_url / thumbnail_url stay what the app renders today.
--
--    bgg_images_synced_at is the backfill's queue marker, same shape and
--    reasoning as bgg_meta_synced_at (045): NULL with a non-null bgg_id = never
--    asked. It is stamped even when BGG has no art for the game, so the drain
--    terminates.
--
--    Free seed: a row whose re-host failed kept BGG's URL in image_url /
--    thumbnail_url (see _upload_to_storage), so that URL IS the answer. Copied
--    without stamping — the other half may still be unknown, and one /thing
--    per 20 games is cheap.
--
-- 2. boardgamebuddy_bgg_thumb_cache. BGG's /search returns no images, so the
--    search sheet asks /thing for the rows it shows. This table keeps each
--    answer — one row per bgg_id, NULL when BGG has no thumbnail — so a game is
--    looked up once rather than once per search, per deploy, per worker.
--    Deliberately NOT a stub row in boardgamebuddy_games: that would flip
--    already_in_db, surface in catalog search and join every backfill queue.
--    Service-role only (the API is the only reader); RLS on, no grants.
--    Seeded from the trending snapshots, which already hold BGG thumbnails.

BEGIN;

ALTER TABLE public.boardgamebuddy_games
  ADD COLUMN IF NOT EXISTS bgg_image_url        TEXT,
  ADD COLUMN IF NOT EXISTS bgg_thumbnail_url    TEXT,
  ADD COLUMN IF NOT EXISTS bgg_images_synced_at TIMESTAMPTZ;

UPDATE public.boardgamebuddy_games
   SET bgg_image_url = image_url
 WHERE bgg_image_url IS NULL
   AND image_url LIKE '%geekdo-images.com%';

UPDATE public.boardgamebuddy_games
   SET bgg_thumbnail_url = thumbnail_url
 WHERE bgg_thumbnail_url IS NULL
   AND thumbnail_url LIKE '%geekdo-images.com%';

CREATE INDEX IF NOT EXISTS idx_bgb_games_images_synced
  ON public.boardgamebuddy_games (bgg_images_synced_at ASC NULLS FIRST)
  WHERE (bgg_id IS NOT NULL);

COMMENT ON COLUMN public.boardgamebuddy_games.bgg_image_url IS
  'BoardGameGeek''s own box-art URL (migration 054), recorded next to the re-hosted image_url so the app can switch to serving BGG directly. Written by import, image refresh and POST /games/admin/backfill-image-links.';

COMMENT ON COLUMN public.boardgamebuddy_games.bgg_thumbnail_url IS
  'BoardGameGeek''s own thumbnail URL (migration 054); see bgg_image_url.';

COMMENT ON COLUMN public.boardgamebuddy_games.bgg_images_synced_at IS
  'When BGG''s image URLs were last read for this game (migration 054). NULL with a non-null bgg_id IS the image-links backfill queue. Stamped even when BGG has no art, so the queue terminates.';

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_bgg_thumb_cache (
  bgg_id        INTEGER     NOT NULL,
  thumbnail_url TEXT,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT boardgamebuddy_bgg_thumb_cache_pkey PRIMARY KEY (bgg_id)
);
ALTER TABLE public.boardgamebuddy_bgg_thumb_cache ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.boardgamebuddy_bgg_thumb_cache IS
  'BGG thumbnail per bgg_id for BGG search results (migration 054). NULL thumbnail_url = BGG has none. Not a catalog: a game here is not imported. Written and read only by the API (service role).';

INSERT INTO public.boardgamebuddy_bgg_thumb_cache (bgg_id, thumbnail_url, fetched_at)
SELECT DISTINCT ON (bgg_id) bgg_id, thumbnail_url, captured_at
  FROM public.boardgamebuddy_bgg_hot_snapshots
 WHERE thumbnail_url IS NOT NULL
 ORDER BY bgg_id, captured_at DESC
ON CONFLICT (bgg_id) DO NOTHING;

COMMIT;
