# SauceBoss Shared Modules

Pure ESM modules consumed by the React Native app via the Metro `#shared` alias.

**Rules:**
- No DOM imports, no React Native imports, no platform-specific globals.
- All functions take their context as arguments — no implicit `state` or `window` references.
- Mirrors the logic in `web/state.js` and `web/helpers.js` so a future web refactor can swap `<script>` tags for `import` statements without rewriting business rules.

**Modules:**

| File | Purpose |
|---|---|
| `constants.js` | CUISINES, UNITS, PALETTE, ING_COLOR, conversion tables, ITEM_FLOW_META |
| `units.js` | `toTsp`, `cumulativeStepTsp`, `tspToDisplay`, `convertUnit`, `formatAmount`, `scaleAmount`, `prepareItems` |
| `colors.js` | `ingColor(name, idx)` |
| `families.js` | `buildSauceFamilies`, `pickDisplayedFromFamily`, `familyHasFavorite` |
| `filter.js` | `isSauceAvailable`, `missingSauceIngredients`, `getSubstitutionText`, `groupIngredientsByCategory`, `withIngredientNames` |
| `fuzzy.js` | `levenshtein`, `fuzzyMatchIngredients`, `isKnownIngredient` |
| `pieMath.js` | `polarToCartesian`, `arcPath` |
| `validation.js` | `validateBuilder` |
| `builder.js` | `applyParsedRecipe`, `unitDisplayFromParsed`, `ingNameInInstruction` |
| `api.js` | `makeApi({ fetchFn, getAuthToken, baseUrl })` — endpoint factory |
| `themeTokens.js` | COLORS, SPACING, RADII, FONT_SIZES, FONT_WEIGHTS |
| `copy.js` | UI strings |
