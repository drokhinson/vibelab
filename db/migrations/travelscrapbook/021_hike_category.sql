-- ─────────────────────────────────────────────────────────────────────────────
-- travelscrapbook — 021: "hike" place category
--
-- A place category for trails/hikes imported from Komoot, AllTrails, Strava,
-- etc. Non-checkpoint, so it's offered to the LLM and behaves like a normal
-- plan. icon = custom SVG sprite slug rendered as
-- assets/sprites/categories/travel-scrapbook-cat-hike.svg (no emojis — see
-- .claude/rules/assets.md). Slotted right after "activity"; the tail
-- (shop/lodging/other) bumps up one so ordering stays tidy. Transport
-- categories (90+) are unaffected.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.travelscrapbook_categories SET sort_order = 7 WHERE slug = 'shop';
UPDATE public.travelscrapbook_categories SET sort_order = 8 WHERE slug = 'lodging';
UPDATE public.travelscrapbook_categories SET sort_order = 9 WHERE slug = 'other';

INSERT INTO public.travelscrapbook_categories (slug, label, icon, sort_order) VALUES
  ('hike', 'Hike', 'hike', 6)
ON CONFLICT (slug) DO NOTHING;
