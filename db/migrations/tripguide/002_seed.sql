-- ─────────────────────────────────────────────────────────────────────────────
-- tripguide — seed data
-- Color-scheme presets + the first trip ("Slovenian Arrow") with example stops.
-- Idempotent: re-running upserts schemes and only seeds the demo trip once.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Color schemes ────────────────────────────────────────────────────────────
INSERT INTO public.tripguide_color_schemes (slug, name, palette, sort_order) VALUES
  ('alpine', 'Alpine',
   '{"primary":"#2f6fb0","bg":"#eef4fb","surface":"#ffffff","text":"#12283f","accent":"#7ab7e0","muted":"#5b7590"}', 1),
  ('sunset', 'Sunset',
   '{"primary":"#e0662f","bg":"#fff5ed","surface":"#fffaf6","text":"#4a2411","accent":"#f5a15a","muted":"#9c6b4e"}', 2),
  ('forest', 'Forest',
   '{"primary":"#2f7d4f","bg":"#eef5ee","surface":"#ffffff","text":"#1c3320","accent":"#7cc088","muted":"#5c7a63"}', 3),
  ('ocean', 'Ocean',
   '{"primary":"#1f7a8c","bg":"#eef6f7","surface":"#ffffff","text":"#0e2b33","accent":"#5cc0cf","muted":"#4a7982"}', 4),
  ('mono', 'Mono',
   '{"primary":"#3f3f46","bg":"#f4f4f5","surface":"#ffffff","text":"#1f2024","accent":"#a1a1aa","muted":"#71717a"}', 5)
ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name,
      palette = EXCLUDED.palette,
      sort_order = EXCLUDED.sort_order;


-- ── Demo trip: Slovenian Arrow ───────────────────────────────────────────────
-- Seeded only once. Uses a fixed UUID so re-runs are no-ops.
INSERT INTO public.tripguide_trips (id, name, description, color_scheme, sort_order)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'Slovenian Arrow',
  'A route through Slovenia — from the Julian Alps to the Adriatic. Follow the arrow, stop by stop.',
  'alpine',
  1
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.tripguide_stops (trip_id, name, description, content_html, sort_order)
SELECT
  '11111111-1111-1111-1111-111111111111', v.name, v.description, v.content_html, v.sort_order
FROM (VALUES
  (
    'Lake Bled',
    'Fairy-tale island church and a cliff-top castle.',
    '<p>Start at <strong>Lake Bled</strong>, the postcard of Slovenia. Row a <em>pletna</em> boat out to the island church and ring the wishing bell.</p><ul><li>Walk up to Bled Castle for the clifftop view.</li><li>Try a slice of <strong>kremšnita</strong> (cream cake).</li></ul>',
    1
  ),
  (
    'Ljubljana',
    'The green capital, dragons on the bridge.',
    '<p><strong>Ljubljana</strong> is compact and walkable. Cross the Dragon Bridge, wander the riverside cafés, and take the funicular to the castle.</p><p>Base yourself here for a night before heading to the coast.</p>',
    2
  )
) AS v(name, description, content_html, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM public.tripguide_stops
  WHERE trip_id = '11111111-1111-1111-1111-111111111111'
);
