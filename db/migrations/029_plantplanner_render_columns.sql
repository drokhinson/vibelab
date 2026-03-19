-- PlantPlanner: create separate renders table and link to plants
-- The renders table stores reusable geometry + color templates keyed by a
-- human-readable string (e.g. "sunflower", "bush_herb", "leafy_green").
-- When adding a new plant, set render_key to an existing key or create a new one.

CREATE TABLE IF NOT EXISTS plantplanner_renders (
  key        text PRIMARY KEY,
  label      text NOT NULL DEFAULT '',
  params     jsonb NOT NULL DEFAULT '{}',
  colors     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.plantplanner_renders ENABLE ROW LEVEL SECURITY;

-- Add render_key FK on plants table
ALTER TABLE plantplanner_plants
  ADD COLUMN IF NOT EXISTS render_key text REFERENCES plantplanner_renders(key);

-- Emoji column no longer needed — plants are rendered from 3D models
ALTER TABLE plantplanner_plants
  DROP COLUMN IF EXISTS emoji;
