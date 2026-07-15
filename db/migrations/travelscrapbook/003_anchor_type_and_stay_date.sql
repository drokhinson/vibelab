-- ─────────────────────────────────────────────────────────────────────────────
-- travelscrapbook — anchor location type + stay date
-- 'type' classifies start/end anchors by how you arrive/depart
--   (airport | train_station | car_rental | other). Nullable; only set on
--   start/end. Arrival and departure are often the same place, so the app can
--   copy a start anchor into the end anchor (location + type) with no re-geocode.
-- 'stay_date' pins a 'stay' anchor to a single check-in day, giving a future
--   day-by-day timeline something to hang lodging on. Nullable; only set on stay.
-- Both are enforced app-side by role; the DB just constrains the type vocabulary.
-- Columns on an already-granted, service-role-only table — no new GRANT needed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.travelscrapbook_anchors
  ADD COLUMN IF NOT EXISTS type TEXT
    CHECK (type IS NULL OR type IN ('airport', 'train_station', 'car_rental', 'other'));

ALTER TABLE public.travelscrapbook_anchors
  ADD COLUMN IF NOT EXISTS stay_date DATE;
