-- Deduplicate plantplanner_plants by name.
-- Keeps the row with the lowest sort_order (first inserted wins on ties).
-- Rewires any garden placements that reference a duplicate to the surviving row,
-- then deletes the duplicates.

BEGIN;

-- 1. For each duplicate name, pick the canonical (lowest sort_order) id.
WITH ranked AS (
    SELECT
        id,
        name,
        ROW_NUMBER() OVER (PARTITION BY name ORDER BY sort_order ASC, id ASC) AS rn
    FROM plantplanner_plants
),
canonical AS (
    -- Map every duplicate id → the canonical id for that name
    SELECT
        dup.id        AS dup_id,
        keep.id       AS keep_id
    FROM ranked dup
    JOIN ranked keep ON keep.name = dup.name AND keep.rn = 1
    WHERE dup.rn > 1
)
-- 2. Re-point any garden placements that used a duplicate plant.
--    The UNIQUE(garden_id, grid_x, grid_y) constraint means we may have
--    collisions if two duplicates were placed in the same cell — those rows
--    are left for the DELETE to clean up.
UPDATE plantplanner_garden_plants gp
SET plant_id = c.keep_id
FROM canonical c
WHERE gp.plant_id = c.dup_id
  AND NOT EXISTS (
      -- Avoid collision with an existing placement that already uses keep_id
      -- at the same position in the same garden
      SELECT 1 FROM plantplanner_garden_plants other
      WHERE other.garden_id = gp.garden_id
        AND other.grid_x    = gp.grid_x
        AND other.grid_y    = gp.grid_y
        AND other.plant_id  = c.keep_id
  );

-- 3. Delete garden placements that still reference a duplicate
--    (collision case — the keep_id is already in that cell).
DELETE FROM plantplanner_garden_plants
WHERE plant_id IN (
    SELECT dup.id
    FROM (
        SELECT id, name,
               ROW_NUMBER() OVER (PARTITION BY name ORDER BY sort_order ASC, id ASC) AS rn
        FROM plantplanner_plants
    ) dup
    WHERE dup.rn > 1
);

-- 4. Delete the duplicate plant rows.
DELETE FROM plantplanner_plants
WHERE id IN (
    SELECT id
    FROM (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY name ORDER BY sort_order ASC, id ASC) AS rn
        FROM plantplanner_plants
    ) sub
    WHERE sub.rn > 1
);

COMMIT;
