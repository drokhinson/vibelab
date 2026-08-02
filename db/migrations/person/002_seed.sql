-- ─────────────────────────────────────────────────────────────────────────────
-- person — seed
-- Migrates the previously-hardcoded "Slovenian Arrow 2026" trip (formerly
-- landing/travel/slovenian-arrow.html + the POSTCARDS array) into the DB.
--
-- The two stop postcards are ~400 KB self-contained HTML pages, too large to
-- embed comfortably here. This file seeds the trip + stop METADATA with a
-- placeholder html_content; run db/migrations/person/seed_postcards.py once
-- afterward to load the real html_content from the existing files. Idempotent:
-- re-running inserts nothing new.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Trip ─────────────────────────────────────────────────────────────────────
INSERT INTO public.person_trips (slug, title, eyebrow, headline, lede, card_cta, sort_order)
VALUES (
  'slovenian-arrow',
  'Slovenian Arrow 2026',
  'The Slovenian Arrow',
  'Brussels → Slovenia',
  'A race across Europe, documented one postcard at a time.',
  'Follow the route ↗',
  0
)
ON CONFLICT (slug) DO NOTHING;

-- ── Stops ────────────────────────────────────────────────────────────────────
-- Placeholder html_content; real bodies are loaded by seed_postcards.py.
INSERT INTO public.person_trip_stops (trip_id, title, meta, note, html_content, sort_order)
SELECT t.id, s.title, s.meta, s.note,
       '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;color:#333">'
       || '<p>Postcard content not yet loaded. Run seed_postcards.py.</p></body></html>',
       s.sort_order
FROM public.person_trips t
CROSS JOIN (VALUES
  ('Brussels', 'Belgium · Day 0 — Start line', 'Départ from La Bellone, 11:00 — the flag drops.', 0),
  ('Brussels', 'Belgium · The start line', 'Where the arrow is loosed — the send-off from Brussels.', 1)
) AS s(title, meta, note, sort_order)
WHERE t.slug = 'slovenian-arrow'
  AND NOT EXISTS (
    SELECT 1 FROM public.person_trip_stops ps
    WHERE ps.trip_id = t.id AND ps.sort_order = s.sort_order
  );
