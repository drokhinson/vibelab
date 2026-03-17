-- ─────────────────────────────────────────────────────────────────────────────
-- 014_sauceboss_indian_sauces.sql
-- Adds 4 new Indian cuisine sauces to expand under-represented cuisine.
-- Each sauce uses inputFromStep to demonstrate the combine-from-previous-step feature.
-- Run in Supabase dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Dal Makhani — rice, bread (3 steps, step 2 and 3 combine from previous)
SELECT create_sauceboss_sauce('{
  "id": "dal-makhani",
  "name": "Dal Makhani",
  "cuisine": "Indian",
  "cuisineEmoji": "🇮🇳",
  "color": "#7C2D12",
  "description": "Rich, slow-cooked black lentil sauce with a buttery tomato-cream base.",
  "carbIds": ["rice", "bread"],
  "steps": [
    {
      "stepOrder": 1,
      "title": "Bloom aromatics",
      "inputFromStep": null,
      "ingredients": [
        {"name": "butter",    "amount": 2,   "unit": "tbsp"},
        {"name": "onion",     "amount": 0.5, "unit": "piece"},
        {"name": "garlic",    "amount": 4,   "unit": "cloves"},
        {"name": "ginger",    "amount": 1,   "unit": "tsp"},
        {"name": "cumin",     "amount": 1,   "unit": "tsp"},
        {"name": "coriander", "amount": 1,   "unit": "tsp"}
      ]
    },
    {
      "stepOrder": 2,
      "title": "Simmer tomato base",
      "inputFromStep": 1,
      "ingredients": [
        {"name": "tomato puree",  "amount": 1,   "unit": "cup"},
        {"name": "garam masala",  "amount": 1,   "unit": "tsp"},
        {"name": "chili powder",  "amount": 0.5, "unit": "tsp"},
        {"name": "turmeric",      "amount": 0.25,"unit": "tsp"}
      ]
    },
    {
      "stepOrder": 3,
      "title": "Finish with cream",
      "inputFromStep": 2,
      "ingredients": [
        {"name": "heavy cream", "amount": 0.25, "unit": "cup"},
        {"name": "butter",      "amount": 1,    "unit": "tbsp"}
      ]
    }
  ]
}');

-- 2. Korma Sauce — rice, noodles (2 steps, step 2 combines from step 1)
SELECT create_sauceboss_sauce('{
  "id": "korma-sauce",
  "name": "Korma Sauce",
  "cuisine": "Indian",
  "cuisineEmoji": "🇮🇳",
  "color": "#D97706",
  "description": "Mild, fragrant sauce with cashews, yogurt, and warm spices.",
  "carbIds": ["rice", "noodles"],
  "steps": [
    {
      "stepOrder": 1,
      "title": "Build the spice base",
      "inputFromStep": null,
      "ingredients": [
        {"name": "butter",      "amount": 2,   "unit": "tbsp"},
        {"name": "onion",       "amount": 0.5, "unit": "piece"},
        {"name": "garlic",      "amount": 3,   "unit": "cloves"},
        {"name": "ginger",      "amount": 1,   "unit": "tsp"},
        {"name": "garam masala","amount": 1.5, "unit": "tsp"},
        {"name": "coriander",   "amount": 1,   "unit": "tsp"},
        {"name": "cumin",       "amount": 0.5, "unit": "tsp"},
        {"name": "cashews",     "amount": 2,   "unit": "tbsp"}
      ]
    },
    {
      "stepOrder": 2,
      "title": "Add creamy finish",
      "inputFromStep": 1,
      "ingredients": [
        {"name": "yogurt",       "amount": 0.25,"unit": "cup"},
        {"name": "heavy cream",  "amount": 0.25,"unit": "cup"},
        {"name": "coconut milk", "amount": 0.25,"unit": "cup"}
      ]
    }
  ]
}');

-- 3. Vindaloo — rice (2 steps, step 2 combines from step 1)
SELECT create_sauceboss_sauce('{
  "id": "vindaloo-sauce",
  "name": "Vindaloo",
  "cuisine": "Indian",
  "cuisineEmoji": "🇮🇳",
  "color": "#B91C1C",
  "description": "Fiery Goan sauce with vinegar-forward heat, garlic, and warming spices.",
  "carbIds": ["rice"],
  "steps": [
    {
      "stepOrder": 1,
      "title": "Make spice paste",
      "inputFromStep": null,
      "ingredients": [
        {"name": "garlic",      "amount": 5,   "unit": "cloves"},
        {"name": "ginger",      "amount": 1.5, "unit": "tsp"},
        {"name": "chili powder","amount": 2,   "unit": "tsp"},
        {"name": "cumin",       "amount": 1,   "unit": "tsp"},
        {"name": "paprika",     "amount": 1,   "unit": "tsp"},
        {"name": "turmeric",    "amount": 0.5, "unit": "tsp"},
        {"name": "vinegar",     "amount": 2,   "unit": "tbsp"}
      ]
    },
    {
      "stepOrder": 2,
      "title": "Build the curry",
      "inputFromStep": 1,
      "ingredients": [
        {"name": "onion",       "amount": 1,   "unit": "piece"},
        {"name": "tomato puree","amount": 0.5, "unit": "cup"},
        {"name": "olive oil",   "amount": 1,   "unit": "tbsp"}
      ]
    }
  ]
}');

-- 4. Coconut Tomato Curry — rice, noodles, pasta (2 steps, step 2 combines from step 1)
SELECT create_sauceboss_sauce('{
  "id": "coconut-tomato-curry",
  "name": "Coconut Tomato Curry",
  "cuisine": "Indian",
  "cuisineEmoji": "🇮🇳",
  "color": "#F59E0B",
  "description": "South Indian-inspired curry with coconut milk, tamarind, and mustard seeds.",
  "carbIds": ["rice", "noodles", "pasta"],
  "steps": [
    {
      "stepOrder": 1,
      "title": "Fry the base",
      "inputFromStep": null,
      "ingredients": [
        {"name": "olive oil",     "amount": 2,   "unit": "tbsp"},
        {"name": "mustard seeds", "amount": 1,   "unit": "tsp"},
        {"name": "onion",         "amount": 0.5, "unit": "piece"},
        {"name": "garlic",        "amount": 3,   "unit": "cloves"},
        {"name": "ginger",        "amount": 1,   "unit": "tsp"},
        {"name": "turmeric",      "amount": 0.5, "unit": "tsp"},
        {"name": "chili powder",  "amount": 0.5, "unit": "tsp"}
      ]
    },
    {
      "stepOrder": 2,
      "title": "Simmer with coconut",
      "inputFromStep": 1,
      "ingredients": [
        {"name": "coconut milk",   "amount": 0.5, "unit": "cup"},
        {"name": "tomato puree",   "amount": 0.5, "unit": "cup"},
        {"name": "tamarind paste", "amount": 1,   "unit": "tsp"}
      ]
    }
  ]
}');
