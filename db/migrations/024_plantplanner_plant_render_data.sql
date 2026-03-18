-- PlantPlanner: add render_params JSONB column for 3D plant rendering
ALTER TABLE plantplanner_plants
  ADD COLUMN IF NOT EXISTS render_params jsonb DEFAULT NULL;

-- render_params stores procedural geometry descriptors for Three.js:
-- {
--   "stem": { "shape": "cylinder", "height": 0.6, "radius": 0.04, "color": "#4a7c3f", "segments": 6 },
--   "foliage": [{ "shape": "sphere", "position": [0, 0.7, 0], "scale": [0.25, 0.3, 0.25], "color": "#5cba60", "segments": 6 }],
--   "accents": [{ "shape": "sphere", "position": [0.08, 0.65, 0], "scale": [0.06, 0.06, 0.06], "color": "#ff4444" }]
-- }
