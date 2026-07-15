-- ─────────────────────────────────────────────────────────────────────────────
-- travelscrapbook — seed data
-- Category option set. icon = custom SVG sprite slug rendered by the web app
-- as assets/sprites/categories/travel-scrapbook-cat-<icon>.svg (no emojis —
-- see .claude/rules/assets.md § Custom Images, Not Generic Emojis).
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.travelscrapbook_categories (slug, label, icon, sort_order) VALUES
  ('restaurant', 'Restaurant', 'restaurant', 1),
  ('cafe',       'Cafe',       'cafe',       2),
  ('bar',        'Bar',        'bar',        3),
  ('sight',      'Sight',      'sight',      4),
  ('activity',   'Activity',   'activity',   5),
  ('shop',       'Shop',       'shop',       6),
  ('lodging',    'Lodging',    'lodging',    7),
  ('other',      'Other',      'other',      8)
ON CONFLICT (slug) DO UPDATE
  SET label = EXCLUDED.label,
      icon = EXCLUDED.icon,
      sort_order = EXCLUDED.sort_order;
