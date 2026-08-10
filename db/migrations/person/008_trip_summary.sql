-- ─────────────────────────────────────────────────────────────────────────────
-- person — 008 trip recap document
-- A trip could only be read one stop at a time. It can now also carry ONE
-- whole-trip document — a hand-authored standalone HTML page about the journey
-- rather than a single place (an animated route replay, a stats page, a
-- gallery). The trip page shows it as a banner above the stop list and opens it
-- full screen in the same reader chrome a postcard uses.
--
-- Same storage shape as person_trip_stops.html_content, and deliberately NOT a
-- flagged row in that table: sort_order there is load-bearing in the URL's stop
-- number, the 01…N card badge, the reader's "n / total" counter and its
-- Previous/Next bounds, and the admin reorder payload. A recap row would have to
-- be filtered out of every one of them.
--
-- has_summary is GENERATED so the trip-detail endpoint can say "there is one"
-- without selecting the document itself — these run to hundreds of kilobytes
-- (inline scripts, inline CSS, base64 photos), and Postgres TOASTs a value that
-- size out of line, so a SELECT that omits the column genuinely costs nothing.
-- Generated rather than maintained by the backend so the flag cannot drift from
-- the column it describes.
--
-- No new table, so no RLS/GRANT block — the columns inherit the grants already
-- on person_trips from 001_baseline.sql.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.person_trips
  ADD COLUMN IF NOT EXISTS summary_html    TEXT,
  ADD COLUMN IF NOT EXISTS summary_title   TEXT,
  ADD COLUMN IF NOT EXISTS summary_caption TEXT;

-- Separate from the ADD COLUMN above: a generated column cannot be added in the
-- same statement as the column its expression reads.
ALTER TABLE public.person_trips
  ADD COLUMN IF NOT EXISTS has_summary BOOLEAN
    GENERATED ALWAYS AS (summary_html IS NOT NULL AND summary_html <> '') STORED;
