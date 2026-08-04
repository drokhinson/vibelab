-- ─────────────────────────────────────────────────────────────────────────────
-- person — 005 trip card icon
-- Per-trip card art for the about-page grid. Until now every trip card rendered
-- the same hardcoded arrow SVG (landing/about-travel.js ARROW_SVG). icon_url
-- points at an image (e.g. a race poster) that fills the card's art column;
-- NULL or empty falls back to the arrow, so existing trips are unchanged.
--
-- No new table, so no RLS/GRANT block — the column inherits the grants already
-- on person_trips from 001_baseline.sql.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.person_trips ADD COLUMN IF NOT EXISTS icon_url TEXT;
