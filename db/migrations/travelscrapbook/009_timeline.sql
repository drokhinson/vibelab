-- 009_timeline.sql — dates/times on anchors + a schedule slot on plans.
--
-- Anchors become timeline markers: a start anchor gets an arrival day/time,
-- an end anchor a departure day/time, a stay gets a check-out day next to its
-- existing check-in (stay_date). Times are optional — a dated anchor with no
-- time is a "point marker" (all-day). Trip scraps ("plans") gain an optional
-- plan_date/plan_time so they can be slotted onto a specific day.
--
-- Depends on: 003 (anchor stay_date). Run 003 first if it hasn't been applied.

ALTER TABLE public.travelscrapbook_anchors
  ADD COLUMN anchor_date   DATE,   -- start: arrival day; end: departure day
  ADD COLUMN anchor_time   TIME,   -- optional; NULL = all-day point marker
  ADD COLUMN stay_end_date DATE;   -- stay only: check-out day (stay_date = check-in)

ALTER TABLE public.travelscrapbook_scraps
  ADD COLUMN plan_date DATE,       -- day this plan is slotted on (trip scraps only)
  ADD COLUMN plan_time TIME;       -- optional time within the day

CREATE INDEX IF NOT EXISTS idx_travelscrapbook_scraps_trip_plan_date
  ON public.travelscrapbook_scraps (trip_id, plan_date);
