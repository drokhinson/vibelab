-- PlantPlanner: add category column to plants
ALTER TABLE plantplanner_plants ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'other';

-- Vegetables
UPDATE plantplanner_plants SET category = 'vegetable' WHERE name IN (
  'Tomato', 'Pepper', 'Lettuce', 'Carrot', 'Zucchini', 'Cucumber',
  'Broccoli', 'Spinach', 'Kale', 'Radish', 'Bean (Bush)', 'Bean (Pole)',
  'Pea', 'Onion', 'Garlic', 'Potato', 'Sweet Potato', 'Corn', 'Eggplant'
);

-- Herbs
UPDATE plantplanner_plants SET category = 'herb' WHERE name IN (
  'Basil', 'Cilantro', 'Parsley', 'Rosemary', 'Thyme', 'Mint',
  'Dill', 'Chives', 'Oregano', 'Sage', 'Lavender'
);

-- Flowers
UPDATE plantplanner_plants SET category = 'flower' WHERE name IN (
  'Sunflower', 'Marigold', 'Zinnia', 'Petunia', 'Cosmos', 'Nasturtium',
  'Dahlia', 'Pansy', 'Impatiens', 'Hosta', 'Snapdragon',
  'Black-Eyed Susan', 'Coneflower', 'Geranium'
);

-- Fruits
UPDATE plantplanner_plants SET category = 'fruit' WHERE name IN (
  'Strawberry', 'Blueberry', 'Raspberry', 'Watermelon', 'Pumpkin', 'Cantaloupe'
);
