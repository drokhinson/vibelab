-- ─────────────────────────────────────────────────────────────────────────────
-- plantplanner — reference data seed
-- 1) Plant catalog (collapsed from legacy 020 + 022; obsolete `emoji` column dropped).
-- 2) 3D render templates and render_key linkage (from legacy 030).
--    The legacy 025 seed populated a `render_params` JSONB column that was later
--    dropped — it is intentionally not carried forward.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Plant catalog ────────────────────────────────────────────────────────────
INSERT INTO public.plantplanner_plants
  (name, height_inches, sunlight, bloom_season, spread_inches, description, sort_order, category) VALUES
  ('Tomato', 48, 'full_sun', '{summer}', 24, 'Classic garden staple. Needs staking.', 1, 'vegetable'),
  ('Pepper', 30, 'full_sun', '{summer}', 18, 'Sweet or hot varieties. Heat loving.', 2, 'vegetable'),
  ('Lettuce', 10, 'partial', '{spring,fall}', 12, 'Cool-season leafy green. Quick harvest.', 3, 'vegetable'),
  ('Carrot', 12, 'full_sun', '{spring,fall}', 3, 'Root vegetable. Needs loose, deep soil.', 4, 'vegetable'),
  ('Zucchini', 24, 'full_sun', '{summer}', 36, 'Prolific producer. Needs space.', 5, 'vegetable'),
  ('Cucumber', 18, 'full_sun', '{summer}', 24, 'Vining or bush types. Loves moisture.', 6, 'vegetable'),
  ('Broccoli', 24, 'full_sun', '{spring,fall}', 18, 'Cool-season brassica. Harvest before flowering.', 7, 'vegetable'),
  ('Spinach', 8, 'partial', '{spring,fall}', 6, 'Fast-growing leafy green. Bolts in heat.', 8, 'vegetable'),
  ('Kale', 24, 'partial', '{spring,fall,winter}', 18, 'Hardy green. Sweetens after frost.', 9, 'vegetable'),
  ('Radish', 6, 'full_sun', '{spring,fall}', 4, 'Ready in 3-4 weeks. Great for beginners.', 10, 'vegetable'),
  ('Bean (Bush)', 20, 'full_sun', '{summer}', 8, 'Compact. No trellis needed.', 11, 'vegetable'),
  ('Bean (Pole)', 72, 'full_sun', '{summer}', 6, 'Needs trellis or pole. Heavy producer.', 12, 'vegetable'),
  ('Pea', 48, 'full_sun', '{spring}', 4, 'Cool-season climber. Needs support.', 13, 'vegetable'),
  ('Onion', 18, 'full_sun', '{spring,summer}', 4, 'Long-season crop. Plant from sets.', 14, 'vegetable'),
  ('Garlic', 18, 'full_sun', '{spring,summer}', 4, 'Plant in fall, harvest in summer.', 15, 'vegetable'),
  ('Potato', 24, 'full_sun', '{summer}', 12, 'Hill soil as plants grow.', 16, 'vegetable'),
  ('Sweet Potato', 18, 'full_sun', '{summer}', 24, 'Sprawling vines. Needs warm soil.', 17, 'vegetable'),
  ('Corn', 84, 'full_sun', '{summer}', 12, 'Plant in blocks for pollination.', 18, 'vegetable'),
  ('Eggplant', 36, 'full_sun', '{summer}', 24, 'Heat-loving. Beautiful purple fruits.', 19, 'vegetable'),
  ('Basil', 18, 'full_sun', '{summer}', 12, 'Essential herb. Pinch flowers to extend harvest.', 20, 'herb'),
  ('Cilantro', 12, 'partial', '{spring,fall}', 6, 'Bolts quickly in heat. Succession plant.', 21, 'herb'),
  ('Parsley', 12, 'partial', '{spring,summer,fall}', 8, 'Biennial herb. Flat or curly leaf.', 22, 'herb'),
  ('Rosemary', 36, 'full_sun', '{spring,summer}', 24, 'Perennial shrub. Drought tolerant.', 23, 'herb'),
  ('Thyme', 8, 'full_sun', '{spring,summer}', 12, 'Low-growing perennial. Great ground cover.', 24, 'herb'),
  ('Mint', 18, 'partial', '{summer}', 24, 'Aggressive spreader. Best in containers.', 25, 'herb'),
  ('Dill', 36, 'full_sun', '{summer}', 12, 'Attracts beneficial insects. Self-seeds.', 26, 'herb'),
  ('Chives', 12, 'full_sun', '{spring,summer}', 8, 'Perennial allium. Pretty purple flowers.', 27, 'herb'),
  ('Oregano', 12, 'full_sun', '{summer}', 18, 'Mediterranean perennial. Spreading habit.', 28, 'herb'),
  ('Sage', 24, 'full_sun', '{spring,summer}', 18, 'Woody perennial. Silvery leaves.', 29, 'herb'),
  ('Lavender', 24, 'full_sun', '{summer}', 18, 'Fragrant perennial. Drought tolerant once established.', 30, 'herb'),
  ('Sunflower', 72, 'full_sun', '{summer}', 12, 'Tall and cheerful. Attracts pollinators.', 31, 'flower'),
  ('Marigold', 12, 'full_sun', '{summer,fall}', 10, 'Pest deterrent companion plant. Easy to grow.', 32, 'flower'),
  ('Zinnia', 30, 'full_sun', '{summer,fall}', 12, 'Colorful cut flower. Heat and drought tolerant.', 33, 'flower'),
  ('Petunia', 10, 'full_sun', '{spring,summer,fall}', 18, 'Trailing annual. Great for edges.', 34, 'flower'),
  ('Cosmos', 48, 'full_sun', '{summer,fall}', 12, 'Delicate daisy-like flowers. Low maintenance.', 35, 'flower'),
  ('Nasturtium', 12, 'full_sun', '{summer,fall}', 18, 'Edible flowers and leaves. Trailing habit.', 36, 'flower'),
  ('Dahlia', 48, 'full_sun', '{summer,fall}', 18, 'Showy blooms. Dig up tubers in winter.', 37, 'flower'),
  ('Pansy', 8, 'partial', '{spring,fall}', 8, 'Cool-season flower. Many color patterns.', 38, 'flower'),
  ('Impatiens', 12, 'shade', '{spring,summer,fall}', 12, 'Shade garden staple. Constant blooms.', 39, 'flower'),
  ('Hosta', 24, 'shade', '{summer}', 36, 'Shade-loving foliage plant. Many varieties.', 40, 'flower'),
  ('Snapdragon', 30, 'full_sun', '{spring,summer}', 10, 'Vertical spikes of color. Cool-season annual.', 41, 'flower'),
  ('Black-Eyed Susan', 30, 'full_sun', '{summer,fall}', 18, 'Native wildflower. Drought tolerant perennial.', 42, 'flower'),
  ('Coneflower', 36, 'full_sun', '{summer,fall}', 18, 'Purple daisy. Attracts butterflies.', 43, 'flower'),
  ('Geranium', 18, 'full_sun', '{spring,summer,fall}', 12, 'Classic container plant. Deadhead for blooms.', 44, 'flower'),
  ('Strawberry', 8, 'full_sun', '{spring,summer}', 12, 'Ground cover fruit. Plant as crowns.', 45, 'fruit'),
  ('Blueberry', 48, 'full_sun', '{spring,summer}', 36, 'Acidic soil required. Multi-year producer.', 46, 'fruit'),
  ('Raspberry', 60, 'full_sun', '{summer}', 24, 'Bramble fruit. Needs trellis support.', 47, 'fruit'),
  ('Watermelon', 18, 'full_sun', '{summer}', 72, 'Space hog. Needs long warm season.', 48, 'fruit'),
  ('Pumpkin', 24, 'full_sun', '{fall}', 72, 'Sprawling vines. Fun to grow.', 49, 'fruit'),
  ('Cantaloupe', 18, 'full_sun', '{summer}', 48, 'Sweet melon. Needs warm soil.', 50, 'fruit')
ON CONFLICT DO NOTHING;

-- ── 3D render templates ──────────────────────────────────────────────────────
INSERT INTO public.plantplanner_renders (key, label, params, colors) VALUES

-- Unique models
('sunflower', 'Sunflower', '{"stem":{"shape":"cylinder","height":0.7,"radius":0.05},"foliage":[{"shape":"sphere","position":[0,0.55,0],"scale":[0.12,0.04,0.12]},{"shape":"sphere","position":[0,0.35,0],"scale":[0.1,0.03,0.1]}],"accents":[{"shape":"sphere","position":[0,0.75,0],"scale":[0.28,0.06,0.28]},{"shape":"sphere","position":[0,0.76,0],"scale":[0.12,0.05,0.12]}]}', '{"stem":"#4a7c3f","foliage":["#2E7D32","#388E3C"],"accents":["#FFD600","#5D4037"]}'),

('corn', 'Corn Stalk', '{"stem":{"shape":"cylinder","height":0.75,"radius":0.04},"foliage":[{"shape":"box","position":[0.12,0.45,0],"scale":[0.22,0.02,0.06],"rotation":[0,0,-0.4]},{"shape":"box","position":[-0.12,0.35,0],"scale":[0.22,0.02,0.06],"rotation":[0,0,0.4]},{"shape":"box","position":[0,0.55,0.12],"scale":[0.06,0.02,0.22],"rotation":[0.4,0,0]}],"accents":[{"shape":"cone","position":[0,0.82,0],"scale":[0.04,0.1,0.04]}]}', '{"stem":"#558B2F","foliage":["#66BB6A","#66BB6A","#66BB6A"],"accents":["#F9A825"]}'),

('tomato', 'Tomato Bush', '{"stem":{"shape":"cylinder","height":0.45,"radius":0.04},"foliage":[{"shape":"sphere","position":[0,0.45,0],"scale":[0.25,0.22,0.25]},{"shape":"sphere","position":[0.08,0.5,0.06],"scale":[0.15,0.14,0.15]}],"accents":[{"shape":"sphere","position":[0.12,0.38,0.1],"scale":[0.06,0.06,0.06]},{"shape":"sphere","position":[-0.08,0.42,-0.06],"scale":[0.055,0.055,0.055]},{"shape":"sphere","position":[0.02,0.35,0.14],"scale":[0.05,0.05,0.05]}]}', '{"stem":"#4a7c3f","foliage":["#388E3C","#43A047"],"accents":["#E53935","#EF5350","#C62828"]}'),

('pepper', 'Pepper Bush', '{"stem":{"shape":"cylinder","height":0.4,"radius":0.035},"foliage":[{"shape":"sphere","position":[0,0.42,0],"scale":[0.22,0.2,0.22]}],"accents":[{"shape":"box","position":[0.1,0.3,0.05],"scale":[0.04,0.08,0.04]},{"shape":"box","position":[-0.06,0.32,-0.08],"scale":[0.035,0.07,0.035]}]}', '{"stem":"#4a7c3f","foliage":["#388E3C"],"accents":["#F44336","#4CAF50"]}'),

('carrot', 'Carrot Top', '{"stem":{"shape":"cylinder","height":0.08,"radius":0.02},"foliage":[{"shape":"cone","position":[0,0.22,0],"scale":[0.18,0.18,0.18]},{"shape":"cone","position":[0.04,0.26,0.03],"scale":[0.12,0.14,0.12]}],"accents":[{"shape":"cone","position":[0,-0.04,0],"scale":[0.05,0.14,0.05],"rotation":[3.14159,0,0]}]}', '{"stem":"#4a7c3f","foliage":["#66BB6A","#81C784"],"accents":["#FF6D00"]}'),

('radish', 'Radish', '{"stem":{"shape":"cylinder","height":0.06,"radius":0.015},"foliage":[{"shape":"sphere","position":[0,0.14,0],"scale":[0.16,0.1,0.16]}],"accents":[{"shape":"sphere","position":[0,-0.02,0],"scale":[0.07,0.09,0.07]}]}', '{"stem":"#4a7c3f","foliage":["#66BB6A"],"accents":["#E91E63"]}'),

('lavender', 'Lavender Spikes', '{"stem":{"shape":"cylinder","height":0.3,"radius":0.015},"foliage":[{"shape":"cylinder","height":0.25,"radius":0.012,"position":[0.06,0.12,0.03]},{"shape":"cylinder","height":0.22,"radius":0.012,"position":[-0.05,0.11,-0.04]},{"shape":"cylinder","height":0.2,"radius":0.012,"position":[0.02,0.1,-0.06]}],"accents":[{"shape":"cone","position":[0,0.48,0],"scale":[0.04,0.1,0.04]},{"shape":"cone","position":[0.06,0.42,0.03],"scale":[0.035,0.08,0.035]},{"shape":"cone","position":[-0.05,0.4,-0.04],"scale":[0.035,0.08,0.035]},{"shape":"cone","position":[0.02,0.38,-0.06],"scale":[0.03,0.07,0.03]}]}', '{"stem":"#6D8764","foliage":["#6D8764","#6D8764","#6D8764"],"accents":["#9C27B0","#AB47BC","#AB47BC","#9C27B0"]}'),

('strawberry', 'Strawberry Ground Cover', '{"stem":{"shape":"cylinder","height":0.05,"radius":0.02},"foliage":[{"shape":"sphere","position":[0,0.08,0],"scale":[0.2,0.08,0.2]},{"shape":"sphere","position":[0.08,0.07,0.06],"scale":[0.12,0.06,0.12]}],"accents":[{"shape":"sphere","position":[0.1,0.04,0.08],"scale":[0.04,0.035,0.03]},{"shape":"sphere","position":[-0.06,0.04,0.1],"scale":[0.035,0.03,0.025]},{"shape":"sphere","position":[0.04,0.03,-0.09],"scale":[0.04,0.035,0.03]}]}', '{"stem":"#4a7c3f","foliage":["#388E3C","#43A047"],"accents":["#E53935","#C62828","#EF5350"]}'),

('pumpkin', 'Pumpkin Vine', '{"stem":{"shape":"cylinder","height":0.06,"radius":0.02},"foliage":[{"shape":"sphere","position":[0,0.1,0],"scale":[0.25,0.06,0.25]}],"accents":[{"shape":"sphere","position":[0.06,0.05,0.04],"scale":[0.12,0.09,0.12]},{"shape":"cylinder","position":[0.06,0.11,0.04],"scale":[0.02,0.04,0.02]}]}', '{"stem":"#4a7c3f","foliage":["#388E3C"],"accents":["#FF6D00","#4a7c3f"]}'),

('hosta', 'Hosta Mound', '{"stem":{"shape":"cylinder","height":0.04,"radius":0.02},"foliage":[{"shape":"sphere","position":[0,0.12,0],"scale":[0.25,0.12,0.25]},{"shape":"sphere","position":[0.06,0.14,0.04],"scale":[0.18,0.1,0.18]},{"shape":"sphere","position":[-0.04,0.1,-0.05],"scale":[0.16,0.09,0.16]}],"accents":[]}', '{"stem":"#4a7c3f","foliage":["#4CAF50","#66BB6A","#388E3C"],"accents":[]}'),

('dill', 'Dill Umbrella', '{"stem":{"shape":"cylinder","height":0.55,"radius":0.02},"foliage":[{"shape":"sphere","position":[0.05,0.35,0],"scale":[0.06,0.02,0.08]},{"shape":"sphere","position":[-0.05,0.25,0.03],"scale":[0.05,0.02,0.07]}],"accents":[{"shape":"sphere","position":[0,0.6,0],"scale":[0.12,0.03,0.12]}]}', '{"stem":"#66BB6A","foliage":["#81C784","#81C784"],"accents":["#C0CA33"]}'),

('eggplant', 'Eggplant Bush', '{"stem":{"shape":"cylinder","height":0.45,"radius":0.04},"foliage":[{"shape":"sphere","position":[0,0.45,0],"scale":[0.25,0.22,0.25]}],"accents":[{"shape":"sphere","position":[0.08,0.3,0.06],"scale":[0.06,0.1,0.06]},{"shape":"sphere","position":[-0.06,0.32,-0.05],"scale":[0.055,0.09,0.055]}]}', '{"stem":"#3d7a2e","foliage":["#388E3C"],"accents":["#5b2c8a","#6b3c9a"]}'),

-- Shared templates: leafy greens
('leafy_light', 'Leafy Green (Light)', '{"stem":{"shape":"cylinder","height":0.1,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.12,0],"scale":[0.2,0.12,0.2]},{"shape":"sphere","position":[0.06,0.14,0.04],"scale":[0.15,0.1,0.15]},{"shape":"sphere","position":[-0.05,0.13,-0.03],"scale":[0.14,0.09,0.14]}],"accents":[]}', '{"stem":"#8bc48a","foliage":["#6abf69","#7dd87c","#5cb85c"],"accents":[]}'),

('leafy_dark', 'Leafy Green (Dark)', '{"stem":{"shape":"cylinder","height":0.1,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.12,0],"scale":[0.2,0.12,0.2]},{"shape":"sphere","position":[0.06,0.14,0.04],"scale":[0.15,0.1,0.15]},{"shape":"sphere","position":[-0.05,0.13,-0.03],"scale":[0.14,0.09,0.14]}],"accents":[]}', '{"stem":"#6abf69","foliage":["#3d9a4e","#4aad5e","#2d8a3e"],"accents":[]}'),

('leafy_curly', 'Leafy Green (Curly/Kale)', '{"stem":{"shape":"cylinder","height":0.1,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.12,0],"scale":[0.2,0.12,0.2]},{"shape":"sphere","position":[0.06,0.14,0.04],"scale":[0.15,0.1,0.15]},{"shape":"sphere","position":[-0.05,0.13,-0.03],"scale":[0.14,0.09,0.14]}],"accents":[]}', '{"stem":"#3d7a2e","foliage":["#2d6b3e","#3d8a4e","#4a9e5a"],"accents":[]}'),

-- Shared templates: vine crops
('vine_zucchini', 'Vine Crop (Green Fruit)', '{"stem":{"shape":"cylinder","height":0.06,"radius":0.02},"foliage":[{"shape":"sphere","position":[0,0.08,0],"scale":[0.25,0.05,0.25]},{"shape":"sphere","position":[-0.12,0.06,0.08],"scale":[0.12,0.04,0.1]}],"accents":[{"shape":"sphere","position":[0.08,0.04,0.06],"scale":[0.14,0.1,0.1]}]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a","#5cb85c"],"accents":["#5a8a2e"]}'),

('vine_cucumber', 'Vine Crop (Dark Green Fruit)', '{"stem":{"shape":"cylinder","height":0.06,"radius":0.02},"foliage":[{"shape":"sphere","position":[0,0.08,0],"scale":[0.25,0.05,0.25]},{"shape":"sphere","position":[-0.12,0.06,0.08],"scale":[0.12,0.04,0.1]}],"accents":[{"shape":"sphere","position":[0.08,0.04,0.06],"scale":[0.14,0.1,0.1]}]}', '{"stem":"#3d7a2e","foliage":["#5cb85c","#43A047"],"accents":["#2d6b1e"]}'),

('vine_sweet_potato', 'Vine Crop (Brown Root)', '{"stem":{"shape":"cylinder","height":0.06,"radius":0.02},"foliage":[{"shape":"sphere","position":[0,0.08,0],"scale":[0.25,0.05,0.25]},{"shape":"sphere","position":[-0.12,0.06,0.08],"scale":[0.12,0.04,0.1]}],"accents":[{"shape":"sphere","position":[0.08,0.04,0.06],"scale":[0.14,0.1,0.1]}]}', '{"stem":"#5cb85c","foliage":["#4a9e3a","#6abf69"],"accents":["#D2691E"]}'),

('vine_watermelon', 'Vine Crop (Striped Fruit)', '{"stem":{"shape":"cylinder","height":0.06,"radius":0.02},"foliage":[{"shape":"sphere","position":[0,0.08,0],"scale":[0.25,0.05,0.25]},{"shape":"sphere","position":[-0.12,0.06,0.08],"scale":[0.12,0.04,0.1]}],"accents":[{"shape":"sphere","position":[0.08,0.04,0.06],"scale":[0.14,0.1,0.1]}]}', '{"stem":"#4a7c3f","foliage":["#388E3C","#43A047"],"accents":["#2E7D32"]}'),

('vine_cantaloupe', 'Vine Crop (Tan Fruit)', '{"stem":{"shape":"cylinder","height":0.06,"radius":0.02},"foliage":[{"shape":"sphere","position":[0,0.08,0],"scale":[0.25,0.05,0.25]},{"shape":"sphere","position":[-0.12,0.06,0.08],"scale":[0.12,0.04,0.1]}],"accents":[{"shape":"sphere","position":[0.08,0.04,0.06],"scale":[0.14,0.1,0.1]}]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a","#5cb85c"],"accents":["#E8C44D"]}'),

-- Bush crops
('bush_broccoli', 'Bush Crop (Green Head)', '{"stem":{"shape":"cylinder","height":0.35,"radius":0.04},"foliage":[{"shape":"sphere","position":[0,0.35,0],"scale":[0.25,0.2,0.25]},{"shape":"sphere","position":[0.08,0.3,-0.05],"scale":[0.18,0.15,0.18]}],"accents":[{"shape":"sphere","position":[0,0.42,0],"scale":[0.12,0.08,0.12]}]}', '{"stem":"#3d7a2e","foliage":["#2d8a3e","#3d9a4e"],"accents":["#4aad5e"]}'),

('bush_potato', 'Bush Crop (Brown Tuber)', '{"stem":{"shape":"cylinder","height":0.35,"radius":0.04},"foliage":[{"shape":"sphere","position":[0,0.35,0],"scale":[0.25,0.2,0.25]},{"shape":"sphere","position":[0.08,0.3,-0.05],"scale":[0.18,0.15,0.18]}],"accents":[{"shape":"sphere","position":[0,0.42,0],"scale":[0.12,0.08,0.12]}]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a","#5cb85c"],"accents":["#8B6914"]}'),

-- Climbing plants
('climbing_bean', 'Climbing Bean', '{"stem":{"shape":"cylinder","height":0.65,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.5,0],"scale":[0.18,0.2,0.18]},{"shape":"sphere","position":[0.06,0.35,0.04],"scale":[0.12,0.12,0.12]}],"accents":[{"shape":"box","position":[0.06,0.25,0.04],"scale":[0.04,0.06,0.03]},{"shape":"box","position":[-0.04,0.4,-0.05],"scale":[0.04,0.06,0.03]}]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a","#5cb85c"],"accents":["#7a5c3a","#8a6c4a"]}'),

('climbing_pea', 'Climbing Pea', '{"stem":{"shape":"cylinder","height":0.65,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.5,0],"scale":[0.18,0.2,0.18]},{"shape":"sphere","position":[0.06,0.35,0.04],"scale":[0.12,0.12,0.12]}],"accents":[{"shape":"box","position":[0.06,0.25,0.04],"scale":[0.04,0.06,0.03]},{"shape":"box","position":[-0.04,0.4,-0.05],"scale":[0.04,0.06,0.03]}]}', '{"stem":"#5cb85c","foliage":["#4a9e3a","#5cb85c"],"accents":["#8bc48a","#8bc48a"]}'),

('bush_bean', 'Bush Bean', '{"stem":{"shape":"cylinder","height":0.3,"radius":0.03},"foliage":[{"shape":"sphere","position":[0,0.25,0],"scale":[0.2,0.18,0.2]}],"accents":[{"shape":"box","position":[0.06,0.15,0.04],"scale":[0.04,0.06,0.03]},{"shape":"box","position":[-0.04,0.18,-0.05],"scale":[0.04,0.06,0.03]}]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a"],"accents":["#7a5c3a","#8a6c4a"]}'),

-- Alliums
('allium_onion', 'Allium (Green)', '{"stem":{"shape":"cylinder","height":0.2,"radius":0.02},"foliage":[{"shape":"cone","position":[0,0.25,0],"scale":[0.08,0.35,0.08]}],"accents":[]}', '{"stem":"#5cb85c","foliage":["#4a9e3a"],"accents":[]}'),

('allium_garlic', 'Allium (Light)', '{"stem":{"shape":"cylinder","height":0.2,"radius":0.02},"foliage":[{"shape":"cone","position":[0,0.25,0],"scale":[0.08,0.35,0.08]}],"accents":[]}', '{"stem":"#8bc48a","foliage":["#5cb85c"],"accents":[]}'),

('allium_chive', 'Allium (Dark)', '{"stem":{"shape":"cylinder","height":0.2,"radius":0.02},"foliage":[{"shape":"cone","position":[0,0.25,0],"scale":[0.08,0.35,0.08]}],"accents":[]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a"],"accents":[]}'),

-- Herb bushes
('herb_basil', 'Herb Bush (Deep Green)', '{"stem":{"shape":"cylinder","height":0.25,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.32,0],"scale":[0.18,0.14,0.18]},{"shape":"sphere","position":[0.06,0.28,0.04],"scale":[0.12,0.1,0.12]},{"shape":"sphere","position":[-0.05,0.26,-0.03],"scale":[0.1,0.09,0.1]}],"accents":[]}', '{"stem":"#4a7c3f","foliage":["#43A047","#4CAF50","#388E3C"],"accents":[]}'),

('herb_cilantro', 'Herb Bush (Bright)', '{"stem":{"shape":"cylinder","height":0.25,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.32,0],"scale":[0.18,0.14,0.18]},{"shape":"sphere","position":[0.06,0.28,0.04],"scale":[0.12,0.1,0.12]},{"shape":"sphere","position":[-0.05,0.26,-0.03],"scale":[0.1,0.09,0.1]}],"accents":[]}', '{"stem":"#5cb85c","foliage":["#4a9e3a","#6abf69","#5cb85c"],"accents":[]}'),

('herb_parsley', 'Herb Bush (Forest)', '{"stem":{"shape":"cylinder","height":0.25,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.32,0],"scale":[0.18,0.14,0.18]},{"shape":"sphere","position":[0.06,0.28,0.04],"scale":[0.12,0.1,0.12]},{"shape":"sphere","position":[-0.05,0.26,-0.03],"scale":[0.1,0.09,0.1]}],"accents":[]}', '{"stem":"#3d7a2e","foliage":["#3d9a3e","#4aad4e","#388E3C"],"accents":[]}'),

('herb_mint', 'Herb Bush (Vivid)', '{"stem":{"shape":"cylinder","height":0.25,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.32,0],"scale":[0.18,0.14,0.18]},{"shape":"sphere","position":[0.06,0.28,0.04],"scale":[0.12,0.1,0.12]},{"shape":"sphere","position":[-0.05,0.26,-0.03],"scale":[0.1,0.09,0.1]}],"accents":[]}', '{"stem":"#5cb85c","foliage":["#2d9a3e","#3daa4e","#4aba5e"],"accents":[]}'),

-- Woody herbs
('woody_rosemary', 'Woody Herb (Pine Green)', '{"stem":{"shape":"cylinder","height":0.3,"radius":0.03},"foliage":[{"shape":"cone","position":[0,0.4,0],"scale":[0.12,0.25,0.12]},{"shape":"cone","position":[0.07,0.35,0.04],"scale":[0.08,0.2,0.08]},{"shape":"cone","position":[-0.05,0.33,-0.05],"scale":[0.07,0.18,0.07]}],"accents":[]}', '{"stem":"#5D4037","foliage":["#558B2F","#689F38","#558B2F"],"accents":[]}'),

('woody_sage', 'Woody Herb (Silver-Green)', '{"stem":{"shape":"cylinder","height":0.3,"radius":0.03},"foliage":[{"shape":"cone","position":[0,0.4,0],"scale":[0.12,0.25,0.12]},{"shape":"cone","position":[0.07,0.35,0.04],"scale":[0.08,0.2,0.08]},{"shape":"cone","position":[-0.05,0.33,-0.05],"scale":[0.07,0.18,0.07]}],"accents":[]}', '{"stem":"#5D4037","foliage":["#8a9e7a","#9aae8a","#7a8e6a"],"accents":[]}'),

-- Low woody
('low_woody_thyme', 'Low Woody (Dark)', '{"stem":{"shape":"cylinder","height":0.1,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.1,0],"scale":[0.18,0.08,0.18]},{"shape":"sphere","position":[0.06,0.09,0.04],"scale":[0.12,0.06,0.12]}],"accents":[]}', '{"stem":"#6b4e2a","foliage":["#3d7a2e","#4a8a3e"],"accents":[]}'),

-- Berry bushes
('berry_blue', 'Berry Bush (Blue)', '{"stem":{"shape":"cylinder","height":0.35,"radius":0.04},"foliage":[{"shape":"sphere","position":[0,0.4,0],"scale":[0.22,0.2,0.22]},{"shape":"sphere","position":[0.08,0.45,0.06],"scale":[0.14,0.13,0.14]}],"accents":[{"shape":"sphere","position":[0.1,0.32,0.08],"scale":[0.035,0.035,0.035]},{"shape":"sphere","position":[-0.06,0.35,-0.09],"scale":[0.03,0.03,0.03]},{"shape":"sphere","position":[0.04,0.3,-0.1],"scale":[0.035,0.035,0.035]}]}', '{"stem":"#5D4037","foliage":["#388E3C","#43A047"],"accents":["#283593","#1A237E","#303F9F"]}'),

('berry_red', 'Berry Bush (Red)', '{"stem":{"shape":"cylinder","height":0.35,"radius":0.04},"foliage":[{"shape":"sphere","position":[0,0.4,0],"scale":[0.22,0.2,0.22]},{"shape":"sphere","position":[0.08,0.45,0.06],"scale":[0.14,0.13,0.14]}],"accents":[{"shape":"sphere","position":[0.1,0.32,0.08],"scale":[0.035,0.035,0.035]},{"shape":"sphere","position":[-0.06,0.35,-0.09],"scale":[0.03,0.03,0.03]},{"shape":"sphere","position":[0.04,0.3,-0.1],"scale":[0.035,0.035,0.035]}]}', '{"stem":"#5D4037","foliage":["#388E3C","#43A047"],"accents":["#C62828","#D32F2F","#B71C1C"]}'),

-- Flowers: tall
('flower_zinnia', 'Tall Flower (Pink)', '{"stem":{"shape":"cylinder","height":0.55,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.35,0],"scale":[0.12,0.08,0.12]}],"accents":[{"shape":"sphere","position":[0,0.58,0],"scale":[0.14,0.1,0.14]},{"shape":"sphere","position":[0,0.56,0],"scale":[0.06,0.04,0.06]}]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a"],"accents":["#E91E63","#fd79a8"]}'),

('flower_cosmos', 'Tall Flower (Light Pink)', '{"stem":{"shape":"cylinder","height":0.55,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.35,0],"scale":[0.12,0.08,0.12]}],"accents":[{"shape":"sphere","position":[0,0.58,0],"scale":[0.14,0.1,0.14]},{"shape":"sphere","position":[0,0.56,0],"scale":[0.06,0.04,0.06]}]}', '{"stem":"#5cb85c","foliage":["#4a9e3a"],"accents":["#F48FB1","#E91E63"]}'),

('flower_dahlia', 'Dahlia (Layered Bloom)', '{"stem":{"shape":"cylinder","height":0.55,"radius":0.03},"foliage":[{"shape":"sphere","position":[0,0.4,0],"scale":[0.15,0.12,0.15]}],"accents":[{"shape":"sphere","position":[0,0.58,0],"scale":[0.15,0.1,0.15]},{"shape":"sphere","position":[0,0.56,0],"scale":[0.12,0.08,0.12]},{"shape":"sphere","position":[0,0.54,0],"scale":[0.08,0.06,0.08]}]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a"],"accents":["#AD1457","#C2185B","#D81B60"]}'),

('flower_snapdragon', 'Snapdragon Spikes', '{"stem":{"shape":"cylinder","height":0.45,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.3,0],"scale":[0.1,0.08,0.1]}],"accents":[{"shape":"cone","position":[0,0.45,0],"scale":[0.06,0.12,0.06]},{"shape":"cone","position":[0,0.38,0],"scale":[0.05,0.08,0.05]},{"shape":"cone","position":[0,0.32,0],"scale":[0.05,0.06,0.05]}]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a"],"accents":["#FF7043","#FF5722","#FF8A65"]}'),

-- Flowers: low
('flower_marigold', 'Low Flower (Orange)', '{"stem":{"shape":"cylinder","height":0.12,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.1,0],"scale":[0.18,0.08,0.18]}],"accents":[{"shape":"sphere","position":[0,0.16,0],"scale":[0.1,0.06,0.1]},{"shape":"sphere","position":[0.04,0.15,0.03],"scale":[0.08,0.05,0.08]}]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a"],"accents":["#FF8F00","#E88700"]}'),

('flower_petunia', 'Low Flower (Purple)', '{"stem":{"shape":"cylinder","height":0.12,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.1,0],"scale":[0.18,0.08,0.18]}],"accents":[{"shape":"sphere","position":[0,0.16,0],"scale":[0.1,0.06,0.1]},{"shape":"sphere","position":[0.04,0.15,0.03],"scale":[0.08,0.05,0.08]}]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a"],"accents":["#CE93D8","#E1BEE7"]}'),

('flower_nasturtium', 'Low Flower (Deep Orange)', '{"stem":{"shape":"cylinder","height":0.12,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.1,0],"scale":[0.18,0.08,0.18]}],"accents":[{"shape":"sphere","position":[0,0.16,0],"scale":[0.1,0.06,0.1]},{"shape":"sphere","position":[0.04,0.15,0.03],"scale":[0.08,0.05,0.08]}]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a"],"accents":["#FF6D00","#E65100"]}'),

('flower_pansy', 'Low Flower (Purple-Yellow)', '{"stem":{"shape":"cylinder","height":0.12,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.1,0],"scale":[0.18,0.08,0.18]}],"accents":[{"shape":"sphere","position":[0,0.16,0],"scale":[0.1,0.06,0.1]},{"shape":"sphere","position":[0.04,0.15,0.03],"scale":[0.08,0.05,0.08]}]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a"],"accents":["#7B1FA2","#FFC107"]}'),

('flower_impatiens', 'Low Flower (Coral)', '{"stem":{"shape":"cylinder","height":0.12,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.1,0],"scale":[0.18,0.08,0.18]}],"accents":[{"shape":"sphere","position":[0,0.16,0],"scale":[0.1,0.06,0.1]},{"shape":"sphere","position":[0.04,0.15,0.03],"scale":[0.08,0.05,0.08]}]}', '{"stem":"#5cb85c","foliage":["#4a9e3a"],"accents":["#EF5350","#E57373"]}'),

('flower_geranium', 'Low Flower (Red)', '{"stem":{"shape":"cylinder","height":0.12,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.1,0],"scale":[0.18,0.08,0.18]}],"accents":[{"shape":"sphere","position":[0,0.16,0],"scale":[0.1,0.06,0.1]},{"shape":"sphere","position":[0.04,0.15,0.03],"scale":[0.08,0.05,0.08]}]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a"],"accents":["#E53935","#EF5350"]}'),

-- Flowers: daisy-like
('daisy_yellow', 'Daisy (Yellow Petals)', '{"stem":{"shape":"cylinder","height":0.45,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.3,0],"scale":[0.12,0.06,0.12]}],"accents":[{"shape":"sphere","position":[0,0.48,0],"scale":[0.14,0.05,0.14]},{"shape":"sphere","position":[0,0.5,0],"scale":[0.06,0.05,0.06]}]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a"],"accents":["#FFC107","#5D4037"]}'),

('daisy_purple', 'Daisy (Purple Petals)', '{"stem":{"shape":"cylinder","height":0.45,"radius":0.025},"foliage":[{"shape":"sphere","position":[0,0.3,0],"scale":[0.12,0.06,0.12]}],"accents":[{"shape":"sphere","position":[0,0.48,0],"scale":[0.14,0.05,0.14]},{"shape":"sphere","position":[0,0.5,0],"scale":[0.06,0.05,0.06]}]}', '{"stem":"#3d7a2e","foliage":["#4a9e3a"],"accents":["#AB47BC","#5D4037"]}')

ON CONFLICT (key) DO NOTHING;

-- ── Plant → render_key linkage ───────────────────────────────────────────────
UPDATE public.plantplanner_plants SET render_key = 'tomato' WHERE name = 'Tomato';
UPDATE public.plantplanner_plants SET render_key = 'pepper' WHERE name = 'Pepper';
UPDATE public.plantplanner_plants SET render_key = 'leafy_light' WHERE name = 'Lettuce';
UPDATE public.plantplanner_plants SET render_key = 'carrot' WHERE name = 'Carrot';
UPDATE public.plantplanner_plants SET render_key = 'vine_zucchini' WHERE name = 'Zucchini';
UPDATE public.plantplanner_plants SET render_key = 'vine_cucumber' WHERE name = 'Cucumber';
UPDATE public.plantplanner_plants SET render_key = 'bush_broccoli' WHERE name = 'Broccoli';
UPDATE public.plantplanner_plants SET render_key = 'leafy_dark' WHERE name = 'Spinach';
UPDATE public.plantplanner_plants SET render_key = 'leafy_curly' WHERE name = 'Kale';
UPDATE public.plantplanner_plants SET render_key = 'radish' WHERE name = 'Radish';
UPDATE public.plantplanner_plants SET render_key = 'bush_bean' WHERE name = 'Bean (Bush)';
UPDATE public.plantplanner_plants SET render_key = 'climbing_bean' WHERE name = 'Bean (Pole)';
UPDATE public.plantplanner_plants SET render_key = 'climbing_pea' WHERE name = 'Pea';
UPDATE public.plantplanner_plants SET render_key = 'allium_onion' WHERE name = 'Onion';
UPDATE public.plantplanner_plants SET render_key = 'allium_garlic' WHERE name = 'Garlic';
UPDATE public.plantplanner_plants SET render_key = 'bush_potato' WHERE name = 'Potato';
UPDATE public.plantplanner_plants SET render_key = 'vine_sweet_potato' WHERE name = 'Sweet Potato';
UPDATE public.plantplanner_plants SET render_key = 'corn' WHERE name = 'Corn';
UPDATE public.plantplanner_plants SET render_key = 'eggplant' WHERE name = 'Eggplant';
UPDATE public.plantplanner_plants SET render_key = 'herb_basil' WHERE name = 'Basil';
UPDATE public.plantplanner_plants SET render_key = 'herb_cilantro' WHERE name = 'Cilantro';
UPDATE public.plantplanner_plants SET render_key = 'herb_parsley' WHERE name = 'Parsley';
UPDATE public.plantplanner_plants SET render_key = 'woody_rosemary' WHERE name = 'Rosemary';
UPDATE public.plantplanner_plants SET render_key = 'low_woody_thyme' WHERE name = 'Thyme';
UPDATE public.plantplanner_plants SET render_key = 'herb_mint' WHERE name = 'Mint';
UPDATE public.plantplanner_plants SET render_key = 'dill' WHERE name = 'Dill';
UPDATE public.plantplanner_plants SET render_key = 'allium_chive' WHERE name = 'Chives';
UPDATE public.plantplanner_plants SET render_key = 'low_woody_thyme' WHERE name = 'Oregano';
UPDATE public.plantplanner_plants SET render_key = 'woody_sage' WHERE name = 'Sage';
UPDATE public.plantplanner_plants SET render_key = 'lavender' WHERE name = 'Lavender';
UPDATE public.plantplanner_plants SET render_key = 'sunflower' WHERE name = 'Sunflower';
UPDATE public.plantplanner_plants SET render_key = 'flower_marigold' WHERE name = 'Marigold';
UPDATE public.plantplanner_plants SET render_key = 'flower_zinnia' WHERE name = 'Zinnia';
UPDATE public.plantplanner_plants SET render_key = 'flower_petunia' WHERE name = 'Petunia';
UPDATE public.plantplanner_plants SET render_key = 'flower_cosmos' WHERE name = 'Cosmos';
UPDATE public.plantplanner_plants SET render_key = 'flower_nasturtium' WHERE name = 'Nasturtium';
UPDATE public.plantplanner_plants SET render_key = 'flower_dahlia' WHERE name = 'Dahlia';
UPDATE public.plantplanner_plants SET render_key = 'flower_pansy' WHERE name = 'Pansy';
UPDATE public.plantplanner_plants SET render_key = 'flower_impatiens' WHERE name = 'Impatiens';
UPDATE public.plantplanner_plants SET render_key = 'hosta' WHERE name = 'Hosta';
UPDATE public.plantplanner_plants SET render_key = 'flower_snapdragon' WHERE name = 'Snapdragon';
UPDATE public.plantplanner_plants SET render_key = 'daisy_yellow' WHERE name = 'Black-Eyed Susan';
UPDATE public.plantplanner_plants SET render_key = 'daisy_purple' WHERE name = 'Coneflower';
UPDATE public.plantplanner_plants SET render_key = 'flower_geranium' WHERE name = 'Geranium';
UPDATE public.plantplanner_plants SET render_key = 'strawberry' WHERE name = 'Strawberry';
UPDATE public.plantplanner_plants SET render_key = 'berry_blue' WHERE name = 'Blueberry';
UPDATE public.plantplanner_plants SET render_key = 'berry_red' WHERE name = 'Raspberry';
UPDATE public.plantplanner_plants SET render_key = 'vine_watermelon' WHERE name = 'Watermelon';
UPDATE public.plantplanner_plants SET render_key = 'pumpkin' WHERE name = 'Pumpkin';
UPDATE public.plantplanner_plants SET render_key = 'vine_cantaloupe' WHERE name = 'Cantaloupe';
