# SauceBoss — Architecture Notes

## Stack
- **Expo** ~51 (React Native, managed workflow)
- **React Navigation** v6 native-stack
- **react-native-svg** 15.x — custom pie chart component

## Screen Flow
```
CarbSelectorScreen
    ↓  navigation.navigate('SauceSelector', { carb })
SauceSelectorScreen
    ↓  navigation.navigate('Recipe', { sauce, carb })
RecipeScreen
```

## Data Layer
- `src/data/carbs.js` — 6 carb options
- `src/data/sauces.js` — 22 sauces across 7 cuisines
  - Each sauce: `{ id, name, cuisine, cuisineEmoji, compatibleCarbs[], color, description, ingredients[], steps[] }`
  - Each step: `{ title, ingredients: [{ name, amount, unit }] }`
- `src/utils/units.js` — `toTsp()` converts any unit to teaspoons for proportional pie slices

## Key Components
- **PieChart** — SVG donut chart per step. Slices sized by `toTsp(amount, unit)`.
  - Fixed colour map for common ingredients (consistent cross-sauce)
  - Donut hole at 38% radius for readability
- **CuisineAccordion** — collapsible section per cuisine. Computes availability live.
- **IngredientFilterPanel** — accordion with ingredient chip toggles. Chip turns red + strikethrough when missing.

## Filtering Logic
- A sauce is *available* if `sauce.ingredients.every(i => !disabledIngredients.has(i.name))`
- Unavailable sauces render at opacity 0.45, are not tappable, show a "−N" badge.

## Running
```bash
cd App
npm install
npx expo start
```
Scan QR with Expo Go on iOS or Android.
