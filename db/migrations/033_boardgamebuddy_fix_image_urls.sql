-- Fix protocol-relative image URLs stored from BGG API (prepend https:)
UPDATE public.boardgamebuddy_games
  SET image_url = 'https:' || image_url
  WHERE image_url IS NOT NULL AND image_url LIKE '//%';

UPDATE public.boardgamebuddy_games
  SET thumbnail_url = 'https:' || thumbnail_url
  WHERE thumbnail_url IS NOT NULL AND thumbnail_url LIKE '//%';
