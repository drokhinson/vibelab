-- Create public Supabase Storage bucket for re-hosting BoardGameGeek images.
-- Images are downloaded at import time and stored here permanently,
-- eliminating runtime dependency on the BGG CDN.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'boardgamebuddy-games',
    'boardgamebuddy-games',
    true,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;
