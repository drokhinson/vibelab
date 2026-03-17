-- PlantPlanner seed data: ~50 plants for the catalog

INSERT INTO plantplanner_plants (name, emoji, height_inches, sunlight, bloom_season, spread_inches, description, sort_order) VALUES
-- Vegetables
('Tomato',        '🍅', 48, 'full_sun', '{summer}',        24, 'Classic garden staple. Needs staking.',           1),
('Pepper',        '🌶️', 30, 'full_sun', '{summer}',        18, 'Sweet or hot varieties. Heat loving.',             2),
('Lettuce',       '🥬', 10, 'partial',  '{spring,fall}',   12, 'Cool-season leafy green. Quick harvest.',          3),
('Carrot',        '🥕', 12, 'full_sun', '{spring,fall}',    3, 'Root vegetable. Needs loose, deep soil.',          4),
('Zucchini',      '🥒', 24, 'full_sun', '{summer}',        36, 'Prolific producer. Needs space.',                  5),
('Cucumber',      '🥒', 18, 'full_sun', '{summer}',        24, 'Vining or bush types. Loves moisture.',            6),
('Broccoli',      '🥦', 24, 'full_sun', '{spring,fall}',   18, 'Cool-season brassica. Harvest before flowering.',  7),
('Spinach',       '🥬', 8,  'partial',  '{spring,fall}',   6,  'Fast-growing leafy green. Bolts in heat.',         8),
('Kale',          '🥬', 24, 'partial',  '{spring,fall,winter}', 18, 'Hardy green. Sweetens after frost.',          9),
('Radish',        '🔴', 6,  'full_sun', '{spring,fall}',   4,  'Ready in 3-4 weeks. Great for beginners.',        10),
('Bean (Bush)',    '🫘', 20, 'full_sun', '{summer}',        8,  'Compact. No trellis needed.',                     11),
('Bean (Pole)',    '🫘', 72, 'full_sun', '{summer}',        6,  'Needs trellis or pole. Heavy producer.',           12),
('Pea',           '🫛', 48, 'full_sun', '{spring}',        4,  'Cool-season climber. Needs support.',              13),
('Onion',         '🧅', 18, 'full_sun', '{spring,summer}', 4,  'Long-season crop. Plant from sets.',               14),
('Garlic',        '🧄', 18, 'full_sun', '{spring,summer}', 4,  'Plant in fall, harvest in summer.',                15),
('Potato',        '🥔', 24, 'full_sun', '{summer}',       12,  'Hill soil as plants grow.',                        16),
('Sweet Potato',  '🍠', 18, 'full_sun', '{summer}',       24,  'Sprawling vines. Needs warm soil.',                17),
('Corn',          '🌽', 84, 'full_sun', '{summer}',       12,  'Plant in blocks for pollination.',                 18),
('Eggplant',      '🍆', 36, 'full_sun', '{summer}',       24,  'Heat-loving. Beautiful purple fruits.',            19),

-- Herbs
('Basil',         '🌿', 18, 'full_sun', '{summer}',       12, 'Essential herb. Pinch flowers to extend harvest.',  20),
('Cilantro',      '🌿', 12, 'partial',  '{spring,fall}',   6, 'Bolts quickly in heat. Succession plant.',          21),
('Parsley',       '🌿', 12, 'partial',  '{spring,summer,fall}', 8, 'Biennial herb. Flat or curly leaf.',           22),
('Rosemary',      '🌿', 36, 'full_sun', '{spring,summer}', 24, 'Perennial shrub. Drought tolerant.',               23),
('Thyme',         '🌿', 8,  'full_sun', '{spring,summer}', 12, 'Low-growing perennial. Great ground cover.',       24),
('Mint',          '🌿', 18, 'partial',  '{summer}',        24, 'Aggressive spreader. Best in containers.',          25),
('Dill',          '🌿', 36, 'full_sun', '{summer}',        12, 'Attracts beneficial insects. Self-seeds.',          26),
('Chives',        '🌿', 12, 'full_sun', '{spring,summer}', 8,  'Perennial allium. Pretty purple flowers.',          27),
('Oregano',       '🌿', 12, 'full_sun', '{summer}',       18, 'Mediterranean perennial. Spreading habit.',          28),
('Sage',          '🌿', 24, 'full_sun', '{spring,summer}', 18, 'Woody perennial. Silvery leaves.',                  29),
('Lavender',      '💜', 24, 'full_sun', '{summer}',       18, 'Fragrant perennial. Drought tolerant once established.', 30),

-- Flowers
('Sunflower',     '🌻', 72, 'full_sun', '{summer}',       12, 'Tall and cheerful. Attracts pollinators.',          31),
('Marigold',      '🌼', 12, 'full_sun', '{summer,fall}',  10, 'Pest deterrent companion plant. Easy to grow.',     32),
('Zinnia',        '🌸', 30, 'full_sun', '{summer,fall}',  12, 'Colorful cut flower. Heat and drought tolerant.',   33),
('Petunia',       '🌺', 10, 'full_sun', '{spring,summer,fall}', 18, 'Trailing annual. Great for edges.',           34),
('Cosmos',        '🌸', 48, 'full_sun', '{summer,fall}',  12, 'Delicate daisy-like flowers. Low maintenance.',     35),
('Nasturtium',    '🌺', 12, 'full_sun', '{summer,fall}',  18, 'Edible flowers and leaves. Trailing habit.',        36),
('Dahlia',        '🌸', 48, 'full_sun', '{summer,fall}',  18, 'Showy blooms. Dig up tubers in winter.',            37),
('Pansy',         '🌸', 8,  'partial',  '{spring,fall}',  8,  'Cool-season flower. Many color patterns.',          38),
('Impatiens',     '🌺', 12, 'shade',    '{spring,summer,fall}', 12, 'Shade garden staple. Constant blooms.',       39),
('Hosta',         '🌿', 24, 'shade',    '{summer}',       36, 'Shade-loving foliage plant. Many varieties.',       40),
('Snapdragon',    '🌸', 30, 'full_sun', '{spring,summer}', 10, 'Vertical spikes of color. Cool-season annual.',   41),
('Black-Eyed Susan','🌻', 30, 'full_sun', '{summer,fall}', 18, 'Native wildflower. Drought tolerant perennial.',   42),
('Coneflower',    '🌸', 36, 'full_sun', '{summer,fall}',  18, 'Purple daisy. Attracts butterflies.',              43),
('Geranium',      '🌺', 18, 'full_sun', '{spring,summer,fall}', 12, 'Classic container plant. Deadhead for blooms.', 44),

-- Fruits
('Strawberry',    '🍓', 8,  'full_sun', '{spring,summer}', 12, 'Ground cover fruit. Plant as crowns.',             45),
('Blueberry',     '🫐', 48, 'full_sun', '{spring,summer}', 36, 'Acidic soil required. Multi-year producer.',       46),
('Raspberry',     '🫐', 60, 'full_sun', '{summer}',        24, 'Bramble fruit. Needs trellis support.',            47),
('Watermelon',    '🍉', 18, 'full_sun', '{summer}',        72, 'Space hog. Needs long warm season.',               48),
('Pumpkin',       '🎃', 24, 'full_sun', '{fall}',          72, 'Sprawling vines. Fun to grow.',                    49),
('Cantaloupe',    '🍈', 18, 'full_sun', '{summer}',        48, 'Sweet melon. Needs warm soil.',                    50)
ON CONFLICT DO NOTHING;
