-- 012_travel_checkpoints.sql — 'travel' anchor role for multi-city legs.
--
-- Anchors are surfaced in the UI as "checkpoints" (the stay/travel combo).
-- Alongside start (arrival), end (departure), and stay (lodging), a trip can
-- now hold any number of 'travel' checkpoints — mid-trip legs between cities
-- (a flight to the next island, a train to the next town). A travel anchor
-- reuses the endpoint columns: anchor_date/anchor_time (when the leg happens)
-- and type (airport | train_station | car_rental | other). The partial unique
-- index only covers start/end, so multiple travel rows per trip are allowed.
--
-- Depends on: 009 (anchor_date/anchor_time). Run 009 first if needed.

ALTER TABLE public.travelscrapbook_anchors
  DROP CONSTRAINT IF EXISTS travelscrapbook_anchors_role_check;

ALTER TABLE public.travelscrapbook_anchors
  ADD CONSTRAINT travelscrapbook_anchors_role_check
  CHECK (role IN ('start', 'end', 'stay', 'travel'));
