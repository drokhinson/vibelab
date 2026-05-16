# SauceBoss v2 — Release Notes

A rollup of the changes that bring the React Native app to parity with the web
prototype, harden ingredient parsing on the backend, and converge the Browse +
Saucebook filter panels on a single shared design.

---

## Highlights

- **Native app overhaul** — Sauce Builder wizard rewritten, list screens get
  pull-to-refresh and shared row components, navigation chrome normalized.
- **Backend parser + ingredient normalization** — scraped names are
  lowercased and singularized against the DB, quantities default to a new
  "whole" unit, and historical rows are backfilled.
- **Unified filter panel** — Browse and Saucebook now share a single
  search-and-pick filter component with stable sizing and a reserved
  Clear-All slot.

---

## Mobile app — `projects/sauceboss/app/` (4b00b56a)

### Sauce Builder wizard
- Type chips moved to the **Pairing step**, with an expandable Dish tree
  (tri-state checkbox + chevron expand) that mirrors the web `.dish-tree`.
- **Source step** is four bubble cards (URL / File / Manual / Instagram
  coming-soon). URL has the input above the button; File has Choose File +
  Instructions side-by-side.
- **Info step** uses fieldHeader-style labels for Name / Description /
  Cuisine grid (with inline "+ New Cuisine") / Color. Case-insensitive
  color preselect on edit, with a custom swatch fallback.
- **Instructions step**: separator dividers between every step, insert at
  position (not append-only), per-step collapse, "NEW" pill on
  uncategorized ingredients, and combine-only steps now save (no
  ingredient required when `inputFromSteps` is set).
- **Review screen** is the entry point on edit. Steps and Dish Pairing
  render as accordion summaries with Edit pills; grey Discard button at
  the bottom.
- Editor modals (Add Ingredient / Previous Step) switched from
  `@gorhom/bottom-sheet` to React Native's built-in `Modal` — fixes the
  long-running "buttons did nothing" bug. The Ingredient editor gained a
  type-ahead autocomplete dropdown.

### List screens & navigation
- New shared `<SauceRow>` used by Browse, Saucebook (via
  `CuisineAccordion`), and Manager — three lists, one row shape.
- `CuisineAccordion` accepts a `renderRow` override so Manager wraps it
  instead of rolling its own header.
- Browse + Saucebook get pull-to-refresh, recipe-page bookmark + download
  header, full-sauce-envelope fetch before opening Recipe, and
  search-then-pick filters (Type → Cuisine → Pairs with → Author).
- Saucebook gains a collapse-all toggle next to Filters, a loading
  spinner until the first fetch resolves, swipe-commits-on-release past
  threshold, and an X close on the builder header.
- Manager: shared cuisine accordion; edit-toggle gates Dish + Ingredients
  tabs uniformly.
- Pantry: Restock + Expand/Collapse pill buttons under the header,
  section counts as right-justified badges.
- Settings: `AppHeader` wrap with `headerShown: false` on the stack
  screen (no duplicate orange bar); avatar tap → direct nav to Settings;
  sign-out / delete / not-signed-in all land on Browse.

### App chrome
- `AppHeader` props normalized to `titleIcon` / `titleEmoji` (mirrors web's
  `renderAppHeader`); new `closeIcon` prop swaps chevron-back for X;
  manage/auth slots togglable per screen.
- `BookPlus` icon on the "add recipe" FABs so the affordance reads as
  "import / build a recipe" instead of a generic +.
- MealBuilder flow: X close on every header (exits to Saucebook), Manage
  + Profile chrome hidden, "← Back to <prev step>" link at the bottom of
  PrepSelector + SauceSelector.
- `BootGate` inside `AppProvider` keeps the LoadingPot visible until
  `state.authReady` — signed-in users no longer flash the "Sign in to
  keep recipes" empty state on launch.
- Browse refetches on sign-in so `inSaucebook` flags + the + button
  hydrate without a manual pull.

---

## Filter panel convergence — Browse + Saucebook

Four commits walked the two screens onto a single shared design:

1. **Scrollable Type filter, matching chip layout** (11b81b40) — Type
   chip row becomes a horizontal `ScrollView` on both screens so the five
   type chips stay on one line on narrow phones. Browse Cuisine and
   Pairs-with reverted to flat wrapping chip rows to match Saucebook.
   Saucebook gained a "Clear all filters" button at the bottom of its
   panel, visible only when a filter is active.
2. **Naming fix** (2ae9b221).
3. **Shared `<FilterPicker>` component** (25717e6e) — new
   `components/FilterPicker.js` (label + search input + suggest dropdown
   + selected-pill row) drives Cuisine, Pairs-with, and Author on both
   screens. Saucebook gained the Pairs-with (Dish) filter to match
   Browse, and Browse moved Author through the shared component (drops
   the duplicate inline search + dropdown).
4. **Panel sizing parity** (c2979f9f) — both panels switched to
   `maxHeight: '75%'` (replacing fixed `520px` / `480px` caps).
5. **Stable filter panel sizing** (e644e37) — outer `<ScrollView>`
   replaced by a plain `<View>` so the panel reliably wraps to its
   content (no dead stripe in Saucebook, no clipping in Browse). The
   "Clear all filters" button is now rendered unconditionally and faded
   to `opacity: 0` when no filter is applied, so the panel reserves a
   stable bottom slot whether or not any filter is active. Margins and
   paddings aligned between the two screens.

Net result: the filter panel reads as the same component across Browse
and Saucebook, with no layout jump when the first filter is applied.

---

## Parser, normalization, and shared helpers (ca6a0407)

### Parser — `shared-backend/routes/sauceboss/parser.py` + `units.py`
- Lowercase + DB-aware singularize on scraped ingredient names: "Tomatoes"
  → "tomato", "Jalapeños" → "jalapeño", "Berries" → "berry". Falls back
  to plain lowercase when no canonical row matches, so unknown items
  still surface via the **NEW** pill.
- Quantity with no unit → defaults to the new **"whole"** unit (added in
  migration 024 below). "2 jalapeños" imports as "2 whole jalapeño"
  rather than bare "2 jalapeño".
- `parse_quantity` rounds to `0.01` — kills `0.333333` noise from "1/3".

### Save paths
- `public_routes._build_sauce_ingredient` and the admin routes lowercase
  ingredient names on store. The web builder mirrors the lowercase on the
  optimistic save payload.

### Shared logic
- `shared/text.js` (new): `capitalizeIngredient` title-cases for display
  so users see "Jalapeño" / "Olive Oil" while storage stays lowercased.
  Re-exported via `shared/index.js`. The web bundle mirrors the helper
  inline in `helpers.js`.
- `shared/validation.js`: combine-only steps (`inputFromSteps`, no
  ingredients) now validate cleanly.
- `shared/units.js#prepareItems`: passes `baseServings` to `scaleAmount`
  so imperial + metric scaling stop diverging on non-2-serving recipes.
- `shared/filter.js`: defensive guard on `missingSauceIngredients` so
  rows without `ingredientNames` no longer crash the row renderer.

### Web display
- `recipe.js` and `builder.js` apply `capitalizeIngredient` at the
  disabled-list, unassigned, readonly chip, and review-ing-list render
  sites.

### Database migrations
- `024_whole_unit.sql` — adds the "whole" count unit (aliases:
  whole/wholes/unit/units).
- `025_lowercase_ingredients.sql` — backfills existing
  `sauceboss_ingredient.name`, `.plural`, and
  `sauceboss_sauce_step_ingredient.name` to lowercase so historical rows
  line up with the new convention.

---

## Commits in this release

| SHA       | Summary |
|-----------|---------|
| `4b00b56a` | native: mobile app overhaul — builder rewrite, list polish, parity |
| `ca6a0407` | parser + ingredient normalization + shared helpers |
| `11b81b40` | native: scrollable Type filter + match Browse to Saucebook chip layout |
| `2ae9b221` | fix naming |
| `25717e6e` | native: unified search-and-pick filter panel on Browse + Saucebook |
| `c2979f9f` | native: match Browse + Saucebook filter panel sizing |
| `e644e37`  | native: stable filter panel sizing across Browse + Saucebook |
