-- 038_r2_photo_urls.sql — repoint stored image URLs at Cloudflare R2.
--
-- Stage 4 of Docs/MIGRATION_PLAN.md. The object KEY is identical on both sides
-- (`{user_id}/{uuid4hex}.{ext}` for photos, `{bgg_id}_{kind}.{ext}` for covers
-- — see api/object_store.py), so this is a prefix substitution and not a
-- re-key. Nothing about a row changes except the origin in front of the path.
--
-- ─── BEFORE YOU RUN THIS ────────────────────────────────────────────────────
--
-- 1. EDIT THE FOUR PREFIXES BELOW. They are deliberately not guessable from
--    the repo: the Supabase project ref is a secret-adjacent identifier and
--    the R2 hostnames are an operator choice. The block refuses to run while
--    the placeholder is still in place rather than rewriting 200 rows to a
--    URL containing the word REPLACE.
--
-- 2. COPY THE OBJECTS FIRST:
--       rclone copy supabase:boardgamebuddy-plays r2:bgb-plays --progress
--       rclone copy supabase:boardgamebuddy-games r2:bgb-games --progress
--    A rewritten URL whose object has not copied yet is a broken image, so
--    the order is not negotiable.
--
-- 3. RE-RUN THE COPY AFTERWARDS. It is incremental. Uploads that landed
--    between the copy and this migration went to R2 already (the API writes
--    there as soon as its variables are set) — but a cover re-hosted in that
--    window while the API was still on Supabase would otherwise be missed.
--
-- This migration is re-runnable: every UPDATE is guarded on the row still
-- carrying the old prefix, so a second run reports zero rows instead of
-- double-rewriting.
--
-- ─── WHAT IT DOES NOT TOUCH ─────────────────────────────────────────────────
--
-- boardgamebuddy_games.image_url also holds un-rehosted BGG URLs — the
-- fallback in `_upload_to_storage` returns the original cf.geekdo-images.com
-- address when a re-host fails. Those must survive untouched, which the
-- prefix guard handles for free.
--
-- DO NOT DELETE THE SUPABASE BUCKETS until §4.5's acceptance checks pass. The
-- API's read path has no branch on origin (the client loads whatever absolute
-- URL the row holds), so the buckets staying up IS the rollback: revert this
-- migration's effect by swapping the prefixes and running it the other way.

DO $$
DECLARE
  -- ── EDIT THESE FOUR ──────────────────────────────────────────────────────
  old_plays TEXT := 'https://__PROJECT_REF__.supabase.co/storage/v1/object/public/boardgamebuddy-plays/';
  new_plays TEXT := 'https://img.bgbuddy.app/';
  old_games TEXT := 'https://__PROJECT_REF__.supabase.co/storage/v1/object/public/boardgamebuddy-games/';
  new_games TEXT := 'https://covers.bgbuddy.app/';
  -- ─────────────────────────────────────────────────────────────────────────
  n_photos    BIGINT;
  n_images    BIGINT;
  n_thumbs    BIGINT;
BEGIN
  -- The guard looks for a double underscore rather than for the placeholder
  -- itself, on purpose. A hostname cannot contain one and neither bucket path
  -- does, so any '__' left in a prefix means it was not edited. Matching the
  -- placeholder text would be the obvious way to write this and would break
  -- the obvious way to edit the file: a global find/replace of
  -- __PROJECT_REF__ rewrites the guard's own literal too, and the check then
  -- fires on a correctly edited migration.
  IF strpos(old_plays, '__') > 0 OR strpos(new_plays, '__') > 0
     OR strpos(old_games, '__') > 0 OR strpos(new_games, '__') > 0 THEN
    RAISE EXCEPTION
      'Fill in the Supabase project ref and the R2 hostnames at the top of 038_r2_photo_urls.sql first';
  END IF;

  -- starts_with(), not LIKE: a LIKE pattern would read `_` in the project ref
  -- or a bucket name as a single-character wildcard. These prefixes are
  -- literals and are matched as literals.
  --
  -- And `new || substr(col, length(old) + 1)` rather than replace(): replace()
  -- substitutes EVERY occurrence, so a path that somehow contained the prefix
  -- twice would be mangled. This only ever rewrites the front of the string.
  UPDATE public.boardgamebuddy_plays
     SET photo_url = new_plays || substr(photo_url, length(old_plays) + 1)
   WHERE photo_url IS NOT NULL
     AND starts_with(photo_url, old_plays);
  GET DIAGNOSTICS n_photos = ROW_COUNT;

  UPDATE public.boardgamebuddy_games
     SET image_url = new_games || substr(image_url, length(old_games) + 1)
   WHERE image_url IS NOT NULL
     AND starts_with(image_url, old_games);
  GET DIAGNOSTICS n_images = ROW_COUNT;

  UPDATE public.boardgamebuddy_games
     SET thumbnail_url = new_games || substr(thumbnail_url, length(old_games) + 1)
   WHERE thumbnail_url IS NOT NULL
     AND starts_with(thumbnail_url, old_games);
  GET DIAGNOSTICS n_thumbs = ROW_COUNT;

  RAISE NOTICE 'plays.photo_url: % rewritten', n_photos;
  RAISE NOTICE 'games.image_url: % rewritten', n_images;
  RAISE NOTICE 'games.thumbnail_url: % rewritten', n_thumbs;
END $$;

-- §4.5 acceptance — all three must return 0:
--
--   SELECT count(*) FROM public.boardgamebuddy_plays
--    WHERE photo_url LIKE '%supabase.co/storage%';
--   SELECT count(*) FROM public.boardgamebuddy_games
--    WHERE image_url LIKE '%supabase.co/storage%';
--   SELECT count(*) FROM public.boardgamebuddy_games
--    WHERE thumbnail_url LIKE '%supabase.co/storage%';
