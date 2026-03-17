-- PlantPlanner schema
-- Tables: plantplanner_users, plantplanner_plants, plantplanner_gardens, plantplanner_garden_plants

-- Users
CREATE TABLE IF NOT EXISTS plantplanner_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username text UNIQUE NOT NULL,
    display_name text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamptz DEFAULT now()
);

-- Plant catalog
CREATE TABLE IF NOT EXISTS plantplanner_plants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    emoji text NOT NULL DEFAULT '🌱',
    height_inches integer NOT NULL DEFAULT 12,
    sunlight text NOT NULL DEFAULT 'full_sun',  -- full_sun, partial, shade
    bloom_season text[] NOT NULL DEFAULT '{}',   -- spring, summer, fall, winter
    spread_inches integer NOT NULL DEFAULT 12,
    description text,
    sort_order integer NOT NULL DEFAULT 0
);

-- Saved gardens
CREATE TABLE IF NOT EXISTS plantplanner_gardens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES plantplanner_users(id) ON DELETE CASCADE,
    name text NOT NULL DEFAULT 'My Garden',
    grid_width integer NOT NULL DEFAULT 4,
    grid_height integer NOT NULL DEFAULT 4,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- Plants placed in a garden
CREATE TABLE IF NOT EXISTS plantplanner_garden_plants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    garden_id uuid NOT NULL REFERENCES plantplanner_gardens(id) ON DELETE CASCADE,
    plant_id uuid NOT NULL REFERENCES plantplanner_plants(id),
    grid_x integer NOT NULL,
    grid_y integer NOT NULL,
    UNIQUE(garden_id, grid_x, grid_y)
);

CREATE INDEX IF NOT EXISTS idx_plantplanner_gardens_user ON plantplanner_gardens(user_id);
CREATE INDEX IF NOT EXISTS idx_plantplanner_garden_plants_garden ON plantplanner_garden_plants(garden_id);
