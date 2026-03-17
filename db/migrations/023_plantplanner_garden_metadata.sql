-- PlantPlanner: add garden type, shade level, and planting season to gardens
ALTER TABLE plantplanner_gardens
  ADD COLUMN IF NOT EXISTS garden_type text NOT NULL DEFAULT 'garden_bed',   -- garden_bed | planter
  ADD COLUMN IF NOT EXISTS shade_level text NOT NULL DEFAULT 'full_sun',     -- full_sun | partial | shade
  ADD COLUMN IF NOT EXISTS planting_season text NOT NULL DEFAULT 'spring';   -- spring | summer | fall | winter
