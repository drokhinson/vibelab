-- ─────────────────────────────────────────────────────────────────────────────
-- person — 007 trip colour preset
-- Every trip rendered in the same deep-blue-and-gold palette. A trip now picks
-- one of four presets, which colours its card on the about page, the trip page
-- itself, and the file its Download button produces.
--
-- The column holds the preset's SLUG, never a colour. The four palettes live in
-- landing/person-travel.css as [data-trip-theme="…"] token blocks — the same
-- split as the icon-slug rule in .claude/rules/assets.md, and what lets a
-- palette be retuned without a data migration.
--
-- 'enamel' is the palette the section already had, so every existing trip
-- backfills to exactly what it looks like today. Unlike 006's status, the
-- backfill value and the new-row default are the same, so there is no second
-- ALTER to flip the default afterwards.
--
-- No new table, so no RLS/GRANT block — the column inherits the grants already
-- on person_trips from 001_baseline.sql.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.person_trips
  ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'enamel';

-- ADD CONSTRAINT has no IF NOT EXISTS, so guard on the catalog to keep the
-- migration re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'person_trips_theme_check'
  ) THEN
    ALTER TABLE public.person_trips
      ADD CONSTRAINT person_trips_theme_check
      CHECK (theme IN ('enamel', 'terracotta', 'pine', 'plum'));
  END IF;
END $$;
