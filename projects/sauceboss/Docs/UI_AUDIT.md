# SauceBoss Web UI Audit

A consistency audit of `projects/sauceboss/web/`. Every claim cites code as `path:line` so each finding can be jumped to and verified. The scope is the web frontend only; the React Native app under `app/` and the FastAPI routes under `shared-backend/routes/sauceboss/` are out of scope.

> **Status:** Original audit produced 2026-05-24. **Cleanup pass applied 2026-05-24**: 18 verified-dead CSS classes deleted; no JS function was found dead. See "Cleanup log" at the bottom for the exact diff.

---

## 1. Executive summary

Sauceboss has a flat web layout — 18 JS files at the root of `web/`, no `ui/` / `views/` / `widgets/` / `domain/` split. The total surface is 9,822 lines of JS + 3,128 lines of CSS, dominated by three feature files (`builder.js` 1,529, `settings.js` 1,421, `helpers.js` 1,047). The audit found four drivers of consistency debt:

1. **`renderSauceRow` is the de-facto canonical Sauce component** (`helpers.js:468`), used on 6 surfaces across 4 files. It already takes an `opts` shape (`compact`, `variantBadge`, `rightSlot`, `actionLabel`, `onClick`, `rowClass`) — the Sauce object is the codebase's bright spot. Same story for `renderCuisineGroup` (`helpers.js:497`, 5 surfaces). After the cleanup, this is the model to extend.
2. **There is no canonical Ingredient component and no canonical Dish component.** Pantry rows (`pantry.js:105`, `_pantryRow`) and Ingredient Manager rows (`settings.js:1046`, `renderFoodRow`) render the same domain object with different markup and different interactions. Meal-flow dish tiles (`meal.js:81`, `.carb-card`) and Dish-Manager rows (`settings.js:488–556`, `renderParent` / `renderVariantRow`) likewise share no base. See §5b / §5c.
3. **No project-shared modal exists.** Destructive and error-state actions use browser `confirm()` / `alert()` at 18 sites (5 `confirm`, 13 `alert`) across `settings.js`, `builder.js`, `saucebook.js`, `recipe.js`, `auth.js`. This violates the `.claude/rules/web-frontend.md` "Destructive actions are confirmed" contract. See §5d.
4. **No design tokens.** `styles.css` declares 3 CSS variables total (`--i`, `--pot-target-x`, `--pot-target-y`) — all for runtime animation state, not design. The accent orange `#E85D04` and cream `#FFF8F0` are hardcoded at 80+ sites. Sauceboss is on Pico.css; a future DaisyUI migration via `/ui-polish` would convert these. See §8.

Smaller findings remained or are addressed:

- ~~Earlier pass flagged `renderAdmin()` as 0-call-sites dead.~~ **Wrong.** It is dispatched at `helpers.js:659` for `case 'admin'`, and `navigate('admin')` is invoked from 6 sites in `settings.js`. See §7.2.
- ~~Earlier pass flagged `.sauce-type-sauce/marinade/dressing` as dead.~~ **Wrong.** They are built via `sauce-type-${typeValue}` at `settings.js:275`. See §7.2.
- ~~Earlier pass claimed sauceboss has text-only OAuth buttons (per `.claude/rules/auth-ui.md`).~~ **Stale rule comment.** `auth.js:285–299` ships the proper 4-color Google G and monochrome Apple SVG. The divergence from the rule is structural: classes are `auth-modal__oauth*` not `auth-oauth-btn*`, buttons are `border-radius: 10px` not the canonical `999px` pill, and the divider copy is "or" not "or use email". See §5e.
- 18 CSS classes confirmed dead by re-grep + dynamic-build check; deleted in cleanup. See §7.1 and Cleanup log.

---

## 2. Screens & routes

The app is a single-page shell. `index.html:18` contains a single `<div id="app">` container; `render()` (`helpers.js:630`) rebuilds its `innerHTML` from a `state.screen` switch on every tick. Bottom nav (`#bottom-nav`) and the floating auth modal (`#auth-modal`) live as siblings at `index.html:19–20`.

There are 11 screen routes plus a 3-way tab dispatch on the `tab-shell` route.

| Route (`state.screen`) | Renderer | File:line | How user reaches it | Primary content |
| --- | --- | --- | --- | --- |
| `tab-shell` | `renderActiveTab` | `helpers.js:690` | Default after auth boot; bottom-nav taps | Dispatches to the 3 tab roots |
| `meal-category` | `renderMealCategory` | `meal.js:37` | Saucebook FAB / "+" / locked-tab meal CTA | Carb / Protein / Salad tabs + dish grid |
| `meal-subtype` | `renderMealSubtype` | `meal.js:126` | Pick a dish with subtypes | "Just X" tile + one tile per subtype |
| `sauce-selector` | `renderSauceSelector` | `sauces.js:28` | Pick a dish with no subtypes / pick subtype | Cuisine-grouped Sauce rows for the chosen dish |
| `recipe` | `renderRecipe` | `recipe.js:6` | Tap any Sauce row | Variant switcher, controls, ingredient panel, steps |
| `builder-source` | `renderBuilderSource` | `builder.js:105` | Saucebook FAB → "Add a sauce" | Blank vs JSON-import vs paste-text starting point |
| `builder-info` | `renderBuilderInfo` | `builder.js:185` | Source → Continue | Name, cuisine, type, color |
| `builder-instructions` | `renderBuilderInstructions` | `builder.js:247` | Info → Continue | Step list with per-step ingredient editor |
| `builder-pairing` | `renderBuilderPairing` | `builder.js:561` | Instructions → Continue | Dish compatibility multi-select |
| `builder-review` | `renderBuilderReview` | `builder.js:638` | Pairing → Continue | Read-only summary + Save |
| `settings` | `renderSettings` | `settings.js:19` | Header avatar tap | Account hub: sign-out, admin-key, sauce import/export |
| `admin` | `renderAdmin` | `settings.js:77` | Settings → "Open Sauce Manager" / direct from `navigate('admin')` (6 sites) | Tabbed manager: Sauces / Dishes / Ingredients |

The three tabs handled by `renderActiveTab` (`helpers.js:690`):

| Tab (`state.activeTab`) | Renderer | File:line | Auth gate |
| --- | --- | --- | --- |
| `browse` | `renderBrowse` | `browse.js:14` | None |
| `saucebook` | `renderSaucebook` | `saucebook.js:25` | Locked shell for signed-out users (`_tabLockedShell`) |
| `pantry` | `renderPantry` | `pantry.js:15` | Locked shell for signed-out users |

Bottom navigation (`renderBottomNav`, `tabs.js:20`) renders three slots — Browse, Saucebook, Pantry — and is the only persistent chrome alongside the app header. There is no floating "Play" disc or center action.

The auth modal (`renderAuthModal`, `auth.js:263`) is not a route — it mounts into `#auth-modal` and overlays whichever screen is active, controlled by `state.authModalOpen`.

---

## 3. Reusable components

Components are global functions attached to `window` via implicit script-tag scope (no module system). Counts in this section are produced by grepping each name across `*.js` and `*.html`; each row is exact.

### 3.1 `renderSauceRow` — `helpers.js:468`
- **Returns:** HTML string (a `<div class="admin-sauce-row">`).
- **Reuse count: 6 call sites** across 4 files.
  - `browse.js:141` — Browse tab list (with "+ Saucebook" CTA via `actionLabel`)
  - `saucebook.js:225` — Saucebook tab list (with swipe-row wrapper)
  - `sauces.js:90` — Sauce Selector for the meal flow
  - `settings.js:289` — Sauce Manager top-level row (non-variant)
  - `settings.js:299` — Sauce Manager variant child row
  - `settings.js:310` — Sauce Manager when merge-mode is active
- **Visual style:** White card with left color dot (`<span class="sauce-dot">` colored by `sauce.color`), name + author meta, optional right-slot (sauce-type pill, missing badge, merge tag), optional action button (`+ Saucebook` / `Added`). Class family: `.admin-sauce-row*` (`styles.css:1781–1828`).
- **How accessed:** Every list of Sauces in the app.
- **Opts shape:** `subline`, `variantBadge`, `rightSlot`, `actionLabel`, `actionHandler`, `actionDisabled`, `onClick`, `rowClass`. Documented inline at `helpers.js:455–467`.
- **Note:** This is the closest sauceboss has to a canonical "object → component" mapping. It is variant-driven, opt-shaped, and used everywhere a Sauce list row appears. **The Recipe page (`renderRecipe`, `recipe.js:6`) intentionally bypasses it** — the full recipe surface uses its own header + step-card markup since it represents a single Sauce in detail, not a row in a list.

### 3.2 `renderCuisineGroup` — `helpers.js:497`
- **Returns:** HTML string (an `<div class="ingredient-category-group">` accordion).
- **Reuse count: 5 call sites** across 3 files.
  - `saucebook.js:202` — Saucebook cuisine grouping
  - `sauces.js:98` — Sauce Selector cuisine grouping
  - `settings.js:235` — Sauce Manager cuisine grouping
  - `settings.js:479` — Dish Manager category sections (re-uses the same accordion shape)
  - `settings.js:1032` — Ingredient Manager category sections (via `renderIngredientCategoryGroup`)
- **Visual style:** Orange chevron + optional flag emoji + label + count chip. Body slot accepts pre-rendered HTML.
- **How accessed:** Every collapsible grouped list in the app.
- **Note:** The function name is "Cuisine" but the helper is generic — it backs Cuisine sections, Dish category sections, and Ingredient category sections alike. The naming should be widened to `renderAccordionGroup` or similar when next touched.

### 3.3 `renderRecipeStep` — `helpers.js:368`
- **Returns:** HTML string (a `<div class="step-card">` with pie-chart + ingredient list).
- **Reuse count: 1 call site.** `recipe.js:70` — inside the unified `renderRecipe`.
- **Visual style:** Step card with 4-shade rotation (`data-shade="${index % 4}"`), pie chart on the right, ingredient rows on the left, optional instruction expand toggle.
- **How accessed:** Recipe view only.
- **Note:** Single source of truth for the cooking-step visual — even though there's only one consumer today, both the standalone recipe (Browse / Saucebook / Sauce Manager → tap) and the meal-flow recipe go through the same code path.

### 3.4 `renderItemPrepBlock` — `helpers.js:422`
- **Returns:** HTML string (a meal-flow item-prep block).
- **Reuse count: 1 call site.** `recipe.js:74` — only when `state.meal` has both `item` and `sauce` populated.
- **Visual style:** Colored `.meal-section-label` header + step cards. Color comes from `flowMetaFor(item).itemColor`.
- **How accessed:** Recipe view when reached through the meal builder.

### 3.5 `renderRecipeControls` — `helpers.js:289`
- **Returns:** HTML string (servings stepper + unit toggle).
- **Reuse count: 1 call site.** `recipe.js:92`.
- **Visual style:** Two-row control panel above the steps.

### 3.6 `renderRecipeIngredientPanel` — `helpers.js:335`
- **Returns:** HTML string (collapsible card with full ingredient list).
- **Reuse count: 1 call site.** `recipe.js:93`.
- **Visual style:** `.card-panel` accordion containing one chip per ingredient; chips turn strikethrough when the ingredient is disabled via Pantry.

### 3.7 `renderVariantSwitcher` — `helpers.js:406`
- **Returns:** HTML string (chip row).
- **Reuse count: 1 call site.** `recipe.js:91`.
- **Visual style:** Horizontal scroll of `.builder-chip` for picking sibling variants of a sauce family.

### 3.8 `renderFilterChips` — `helpers.js:523`
- **Returns:** HTML string (three sections: Dish search + chips, Cuisine search + chips, Type pills).
- **Reuse count: 2 call sites.** `browse.js:46`, `saucebook.js:140`.
- **Visual style:** Search input → dropdown suggestion list → multi-select toggle chips. `.toggle-chip` + `.toggle-chip--active` for state.
- **Opts shape:** `activeCuisines`, `activeTypes`, `activeDishes`, `onCuisine`, `onType`, `onDish` (each is a JS expression template with `$NAME` / `$VALUE` / `$ID` placeholders), plus `cuisineFilterQ` / `dishFilterQ` search state and `cuisineSource` / `dishSource` overrides.
- **Note:** This is the canonical filter UI. The Sauce Manager (`renderSauceManagerRow`'s siblings at `settings.js:162–250`) has its own bespoke filter row instead of reusing `renderFilterChips` — flagged in §6.

### 3.9 `renderAppHeader` — `helpers.js:994`
- **Returns:** HTML string (an `<header class="app-header">`).
- **Reuse count: ~12 call sites.** Every screen renderer (Browse, Saucebook, Pantry, Meal flow, Recipe, Builder, Settings, Admin) calls it.
- **Visual style:** Orange (`#E85D04`) bar, optional back arrow, title + subtitle, right-side action cluster (manage button + auth slot + caller-supplied extras).
- **Opts shape:** `title`, `subtitle`, `back`, `manage`, `extraActions`, `titleIcon`, `titleEmoji`, `titlePrefix`, `auth` (defaults `true`).
- **Note:** Single source of truth for the top chrome. The auth slot is delegated to `renderHeaderAuthSlot` (`helpers.js:1027`) so the same avatar/sign-in pill renders across every screen.

### 3.10 `renderHeaderAuthSlot` — `helpers.js:1027`
- **Returns:** HTML string (a colored circle with initials or a "Sign in" pill).
- **Reuse count: 1 call site.** `helpers.js:1019` (inside `renderAppHeader`).
- **Visual style:** Circle with `currentUser.display_name[0]` over the orange header. Signed-out users see a "Sign in" pill.
- **Note:** This is sauceboss's User badge. It is **not** a generalized component — there's no equivalent of `BgbBadge.render` that other surfaces (player chips, attribution rows) could use. The badge exists only in the header. There are no other surfaces today that show a user identity visually.

### 3.11 `renderAuthModal` — `auth.js:263`
- **Returns:** Mutates `#auth-modal` `innerHTML` directly (does not return).
- **Reuse count: 8 internal call sites** (`auth.js:253, 260, 330, 337, 349, 359, 364, 390`) — all in-file rerender hooks triggered by state changes (toggling open/closed, switching login↔signup, async submit feedback).
- **Visual style:** Card with backdrop, X close, 4-color Google G + monochrome Apple SVG OAuth buttons, "or" divider, email/password form.
- **Auth-ui.md compliance:** The SVGs match the canonical pattern (`.claude/rules/auth-ui.md`). The class names diverge (`auth-modal__oauth*` vs the rule's `auth-oauth-btn*`); the button radius is `10px` instead of the canonical pill `999px`; the divider copy is "or" instead of "or use email". See §5e.

### 3.12 `renderEmoji` — `helpers.js:41`
- **Returns:** HTML string (an emoji wrapped in `<span class="emoji">`).
- **Reuse count: 8 call sites.** `builder.js:190, 670`, `helpers.js:532, 545, 565, 577`, `sauces.js:71`. Used inside `renderFilterChips`, the builder chip rows, and the cuisine-emoji slot on `renderCuisineGroup`.
- **Note:** Tiny but consistent — every emoji that appears as part of the UI chrome routes through this so future emoji-font tweaks (e.g. forcing Twemoji) have a single chokepoint.

### 3.13 `renderBottomNav` — `tabs.js:20`
- **Returns:** Mutates `#bottom-nav` `innerHTML` directly.
- **Reuse count: 1 call site.** `helpers.js:673` (called at the end of every `render()` tick to reflect active tab + auth state).
- **Visual style:** Three lucide-icon tabs (Browse / Saucebook / Pantry) with a fixed bottom bar.

### 3.14 `renderActiveTab` — `helpers.js:690`
- **Returns:** HTML string (forwards to `renderBrowse` / `renderSaucebook` / `renderPantry`).
- **Reuse count: 1 call site.** `helpers.js:648` (the `tab-shell` case of the dispatcher).

### 3.15 `render()` (the dispatcher) — `helpers.js:630`
- **Reuse count: 100+ call sites.** Used as the universal "re-render after a state change" hook.
- **Behavior:** Captures focus + selection on any `[data-focus-key]` input, rebuilds `#app.innerHTML` via the `state.screen` switch, re-renders the bottom nav, re-initializes Lucide icons, then restores focus + caret.

### 3.16 Per-screen render functions (one per screen)

The following are each single-purpose screen renderers — listed for completeness but not "reusable" in the §3.1–3.15 sense. Each has exactly one dispatch site in the `render()` switch at `helpers.js:647–660`.

| Function | File:line | Screen |
| --- | --- | --- |
| `renderBrowse` | `browse.js:14` | Browse tab |
| `renderSaucebook` | `saucebook.js:25` | Saucebook tab |
| `renderPantry` | `pantry.js:15` | Pantry tab |
| `renderMealCategory` | `meal.js:37` | Meal builder step 1 |
| `renderMealSubtype` | `meal.js:126` | Meal builder step 2 |
| `renderSauceSelector` | `sauces.js:28` | Meal builder step 3 |
| `renderRecipe` | `recipe.js:6` | Final recipe view |
| `renderBuilderSource` | `builder.js:105` | Builder phase 1 |
| `renderBuilderInfo` | `builder.js:185` | Builder phase 2 |
| `renderBuilderInstructions` | `builder.js:247` | Builder phase 3 |
| `renderBuilderPairing` | `builder.js:561` | Builder phase 4 |
| `renderBuilderReview` | `builder.js:638` | Builder phase 5 |
| `renderSettings` | `settings.js:19` | Settings hub |
| `renderAdmin` | `settings.js:77` | Admin manager hub |

### 3.17 Admin manager sub-renderers (in `settings.js`)

The admin surface composes a large number of sub-renderers, all in `settings.js`. They are single-screen helpers, not cross-cutting components.

| Function | Line | What it renders |
| --- | --- | --- |
| `renderSaucesTab` | 162 | Sauces tab list + filters + bulk merge |
| `renderSauceManagerRow` | 251 | Wrapper around `renderSauceRow` that adds swipe-row + variant nesting |
| `renderSauceMergePanel` | 328 | Merge confirmation panel |
| `renderSauceMergeBar` | 341 | Sticky bar when merge mode is active |
| `renderDishTab` | 427 | Dish manager hub |
| `renderDishSection` | 467 | One category accordion (carb / protein / salad-base) |
| `renderParent` | 488 | Parent dish row with expand/collapse |
| `renderVariantRow` | 535 | Child variant row |
| `renderItemForm` | 560 | Shared add/edit form for dishes |
| `renderIngredientsTab` | 956 | Ingredient manager hub |
| `renderIngredientCategoryGroup` | 1027 | One ingredient category accordion (wraps `renderCuisineGroup`) |
| `renderFoodRow` | 1046 | One ingredient row with swipe actions |
| `renderIngredientSaucesPanel` | 1098 | Expandable "used by N sauces" sub-panel |
| `renderFoodForm` | 1125 | Add/edit form for ingredients |
| `renderMergePanel` | 1171 | Ingredient merge confirmation |

---

## 4. CSS class inventory

`styles.css` is 3,128 lines and contains ~600 top-level class selectors. The table groups them by purpose and notes the dead members.

| Group | Representative classes | Lives at | Dead members |
| --- | --- | --- | --- |
| Global layout | `#app`, `.screen`, `.screen-wrap`, `.scroll-body`, `.scroll-body--padded` | `:1–95` | None |
| App header | `.app-header`, `.app-header__titles`, `.app-header__actions`, `.app-header-back-btn`, `.manage-btn`, `.header-emoji`, `.header-auth-pill` | `:27–95`, `:1716–1775` | None |
| Carb / dish cards (meal flow) | `.carb-grid`, `.carb-card`, `.carb-emoji`, `.carb-name`, `.carb-desc`, `.cat-tabs`, `.cat-tab`, `.cat-tab--active` | `:215–280` | `.carb-card-check`, `.check-mark`, `.color-dot-header` (deleted in cleanup) |
| Recipe step / pie-chart | `.step-card`, `.builder-step-card`, `.meal-section`, `.meal-section-label`, `.pie-chart`, `.pie-slice` | `:536–620`, `:2556–2670` | `.steps-container` (deleted in cleanup) |
| Card panel (accordion) | `.card-panel`, `.card-panel__header`, `.card-panel__body` | `:283–322` | None |
| Toggle chip / filter chip | `.toggle-chip`, `.toggle-chip--active`, `.legend-swatch`, `.legend-item`, `.legend-hidden`, `.legend-disabled` | `:323–445` | None |
| Share / recipe controls | `.share-menu`, `.share-menu__dropdown`, `.share-menu__item`, `.recipe-action-btn`, `.recipe-action-btn--active`, `.unit-toggle`, `.servings-control` | `:182–215`, `:446–490` | `.recipe-action-row` (deleted in cleanup) |
| Sauce row (canonical) | `.admin-sauce-row`, `.admin-sauce-row--variant`, `.admin-sauce-row__action`, `.admin-sauce-row__action--added`, `.sauce-dot`, `.admin-sauce-info`, `.admin-sauce-name`, `.admin-sauce-meta` | `:1777–1828` | None |
| Swipe gestures | `.swipe-row`, `.swipe-content`, `.swipe-action`, `.swipe-action-edit`, `.swipe-action-delete` | `:1830–1855` | None |
| FAB | `.fab`, `.fab--builder` | `:1856–1884` | None |
| Sauce Manager tabs / search / filter | `.sauce-manager-tabs`, `.sauce-manager-search`, `.sauce-manager-search__input` | `:1885–1970` | None |
| Sauce-type pill (dynamic) | `.sauce-type-tag`, `.sauce-type-sauce`, `.sauce-type-marinade`, `.sauce-type-dressing` | `:1972–1987` | None — all three variants are built via `class="sauce-type-${typeValue}"` at `settings.js:275` |
| Builder | `.builder-step-card`, `.builder-sticky-header`, `.builder-label`, `.builder-input`, `.builder-name-input`, `.builder-chip`, `.builder-chip-row`, `.builder-chip-lg`, `.color-swatches`, `.color-swatch`, `.color-swatch.selected`, `.color-dot-inline`, `.builder-primary-btn`, `.builder-secondary-btn` | `:546–1700` | `.builder-sticky-header` (deleted; the actual sticky header uses inline styles), `.builder-import-panel` (deleted) |
| Builder review | `.review-step-card`, `.review-info-row`, `.review-info-cuisine` | inside builder block | `.review-carbs`, `.review-summary` (deleted in cleanup) |
| Meal timing (DEAD) | `.meal-timing-banner`, `.meal-timing-note`, `.meal-timing-total` | DELETED | All three removed in cleanup; the meal flow does not surface a "total minutes" banner today |
| Auth modal | `.auth-modal`, `.auth-modal__backdrop`, `.auth-modal__card`, `.auth-modal__close`, `.auth-modal__title`, `.auth-modal__subtitle`, `.auth-modal__oauth`, `.auth-modal__oauth--google`, `.auth-modal__oauth--apple`, `.auth-modal__oauth-logo`, `.auth-modal__divider`, `.auth-modal__form`, `.auth-modal__label`, `.auth-modal__error`, `.auth-modal__submit`, `.auth-modal__footer` | `:2419–2555` | None |
| Inline pot loader | `.loading-inline`, `.loading-pot`, `.loading-text`, `.spinner-sm` | `:1692–1715`, `:2192–2214` | None |
| Hero illustration | `.hero-illustration`, `.pot-svg`, `.steam-circle`, `.steam-trail` | `:2215–2295` | None |
| Splash / pot-fly animation | `.splash`, `.splash-pot-wrap`, `.splash-pot-wiggle`, `.splash-text`, `.splash-dots`, splash exit keyframes | `:2293–2555` | None |
| Browse filters | `.browse-filters`, `.browse-filters__label`, `.browse-filters__row`, `.browse-filters__suggest`, `.browse-filters__chip` | `:2960–3010` | `.browse-filters__empty`, `.browse-filters__row--scrollable` (deleted in cleanup) |
| Bottom nav | `.bottom-nav`, `.bottom-nav__tab`, `.bottom-nav__tab--active` | `:2728+` | None |
| Pantry | `.pantry-row`, `.pantry-row--missing`, `.pantry-row__name`, `.pantry-row__name--strike`, `.pantry-row__state` | `:3085–3125` | None |
| Ingredient manager | `.food-row`, `.food-row-keep`, `.food-row-picked`, `.food-sauce-chip`, `.food-sauces-panel`, `.food-sauces-empty`, `.food-merge-tag`, `.food-merge-tag-keep`, `.food-merge-tag-merge` | `:2053–2100` | None — but `.remove-ing-btn` (an old delete affordance) deleted in cleanup |
| Coming-soon (DEAD) | `.coming-soon-badge`, `.source-card--disabled` | DELETED | Removed in cleanup; no source/coming-soon distinction in current builder |
| Variant-of (DEAD) | `.variant-of-row` | DELETED | Removed in cleanup |
| Animations | `.animate-fadeUp`, `.fade-up`, `--i` stagger | `:2158–2175` | None |
| Hover lift | `.carb-card:hover`, `.step-card:hover`, `.admin-sauce-row:hover` | `:2176–2191` | None |
| Lucide sizing | `.app-header [data-lucide]`, `.builder-chip [data-lucide]`, etc. | `:2179–2191` | None |

---

## 5. Cross-cutting consistency findings

### 5a. Do all sauce surfaces look and act the same? — **Mostly yes, this is the bright spot.**

Every surface that lists Sauces uses `renderSauceRow` (`helpers.js:468`). Six call sites across four files, all rendering the same `.admin-sauce-row` markup, all driven by opts:

| Surface | File:line | Opts used | Visual variant |
| --- | --- | --- | --- |
| Browse tab list | `browse.js:141` | `actionLabel`, `actionHandler`, `actionDisabled`, `rowClass: 'unavailable'` when missing ingredients | Action button on right |
| Saucebook tab list | `saucebook.js:225` | `onClick`, `variantBadge` for variant chips, wrapped in `.swipe-row` for swipe-to-delete | Swipe gesture |
| Sauce Selector (meal flow) | `sauces.js:90` | `onClick`, `rowClass: 'unavailable'` when missing | Plain row |
| Sauce Manager — top sauce | `settings.js:289` | `rightSlot` with sauce-type pill, `onClick` | Manager row |
| Sauce Manager — variant child | `settings.js:299` | `rowClass: 'admin-sauce-row--variant'`, indented | Indented variant |
| Sauce Manager — merge mode | `settings.js:310` | `rightSlot` with merge tag, `onClick: toggleMergePick` | Merge-mode row |

**Verdict: consistent.** The opt shape covers every surface-specific need without forking the markup. The Recipe page is the only surface that does **not** use `renderSauceRow`, and that is intentional: it's not a row in a list, it's the full record. See §3.1.

A second outlier: the Sauce Manager has its own bespoke filter row (`settings.js:162–250`) that does not use `renderFilterChips`. Browse and Saucebook both use `renderFilterChips`. Reusing it inside the manager would unify the filter UI across all three.

### 5b. Are all ingredient surfaces consistent? — **No. Two parallel implementations.**

Ingredients show up in two places, both rendering the same domain object (a sauceboss_ingredient row joined with usage stats) with completely different markup.

| Surface | Component | File:line | Visual | Interaction |
| --- | --- | --- | --- | --- |
| Pantry tab | `_pantryRow` | `pantry.js:105` | Compact row, `.pantry-row`, `.pantry-row__name`, `.pantry-row__state` ("In stock" / "Missing"), strikethrough when missing | Tap toggles missing flag |
| Ingredient Manager | `renderFoodRow` | `settings.js:1046` | Card-style row, `.food-row`, with `usageCount` subline, swipe-to-edit/delete | Tap expands a "used by N sauces" sub-panel; swipe edits / deletes |

Both group by category using accordion shells: Pantry uses `_pantrySection` (`pantry.js:84`); Ingredient Manager uses `renderIngredientCategoryGroup` (`settings.js:1027`) which delegates to `renderCuisineGroup`. The accordion shells are visually similar but distinct.

**No shared base markup, no opts-driven variants.** This is the largest "same object, two presentations" debt in sauceboss.

**Recommendation:** Extract a canonical `renderIngredientRow(ingredient, opts)` that takes a `mode: "pantry" | "manager"` variant. Today's two functions can collapse into one with conditionals on `mode`.

### 5c. Are all dish surfaces consistent? — **No. Two parallel implementations.**

Dishes also appear in two places with no shared markup.

| Surface | Component | File:line | Visual | Interaction |
| --- | --- | --- | --- | --- |
| Meal-flow category picker | `_mealDishGridHTML` | `meal.js:72` | Tile grid (`.carb-grid` of `.carb-card` with emoji + name + variant count), staggered fadeUp via `--i` | Tap navigates to sauce selector or subtype picker |
| Dish Manager | `renderParent` + `renderVariantRow` | `settings.js:488–556` | List rows inside an accordion (`renderDishSection` → `renderCuisineGroup`), chevron-expand to show variants, swipe-to-edit/delete | Tap expands; swipe edits / deletes |

The meal-flow tile grid (`meal.js:78–88`) is the prettier of the two — it's the user-facing chooser. The Dish Manager is dense by necessity (CRUD over many items). Even so, both render the same shape (`{ id, name, emoji, variants[] }`) without a shared component.

**Recommendation:** This is less urgent than the Ingredient case because the variants serve genuinely different jobs (chooser vs CRUD). A `renderDishTile(dish, opts)` could share at least the emoji + name layout, but the CRUD swipe actions and the tile-grid layout would still diverge.

### 5d. Destructive actions — **18 sites using browser `confirm()` / `alert()`.**

The `.claude/rules/web-frontend.md` rule states: "Destructive actions are confirmed … Reuse the project's existing modal pattern — don't introduce per-screen ad-hoc dialogs." Sauceboss has no project modal. Every destructive or error message uses `window.confirm()` or `window.alert()`.

| File:line | Type | Trigger |
| --- | --- | --- |
| `auth.js:246` | `alert` | "Sign-in not configured for this deployment" (env error) |
| `saucebook.js:383` | `alert` | "Couldn't remove" sauce from saucebook |
| `recipe.js:198` | `alert` | "Couldn't remove" from saucebook |
| `recipe.js:206` | `alert` | "Couldn't save" to saucebook |
| `builder.js:1464` | `confirm` | "You are about to overwrite this recipe. Continue?" |
| `settings.js:366` | `alert` | "{sauce} is already a variant — pick the original as parent" |
| `settings.js:382` | `confirm` | "Re-parent {sauce} to {other}?" |
| `settings.js:791` | `confirm` | "Delete {sauce}? This cannot be undone." |
| `settings.js:943` | `confirm` | Sauce merge confirmation |
| `settings.js:1260` | `alert` | "Cannot delete {ingredient} — used by N recipe step rows" |
| `settings.js:1263` | `confirm` | "Delete ingredient {name}? This cannot be undone." |
| `settings.js:1336` | `alert` | "File is not valid JSON" (import error) |
| `settings.js:1341` | `alert` | "Bulk imports aren't supported" |
| `settings.js:1345` | `alert` | "Unsupported export version" |
| `settings.js:1351` | `alert` | "Could not locate sauce payload" |
| `settings.js:1361` | `alert` | "Parent sauce not found — link dropped" |
| `settings.js:1408` | `alert` | "Export failed: {status}" |
| `settings.js:1419` | `alert` | "Export failed: {message}" |

Totals: **5 `confirm()` (destructive gates) + 13 `alert()` (errors)**.

**Not addressed in this audit's cleanup pass** — fixing this requires designing the modal first. Tracked in `Docs/ARCHITECTURE.md` §6 as target-state work.

### 5e. Auth surface — matches the standard visually, diverges structurally.

The `.claude/rules/auth-ui.md` rule contains the line: "❌ Text-only OAuth buttons (no logo). Sauceboss does this." This was true at some point, but `auth.js:285–299` ships the correct 4-color Google G and monochrome Apple SVG — the rule comment is stale.

What still diverges from the rule:

| Aspect | Sauceboss | Canonical (auth-ui.md) |
| --- | --- | --- |
| Class names | `.auth-modal__oauth`, `.auth-modal__oauth--google`, `.auth-modal__oauth--apple`, `.auth-modal__oauth-logo` | `.auth-oauth-btn`, `.auth-oauth-google`, `.auth-oauth-apple`, `.auth-oauth-logo` |
| Button radius | `10px` rounded rectangle (`styles.css:2483`) | `999px` full pill |
| Divider copy | "or" | "or use email" |
| OAuth SVGs | ✅ Match exactly | ✅ |

The class rename is mechanical but touches `auth.js`, `styles.css`, and the rule's "Sauceboss does this" callout. Not addressed in this cleanup pass — tracked as future work for the next `/ui-polish` run.

### 5f. Recipe page — colors are derived from sauce-type, but the value table is in-file.

`recipe.js:60–63` declares:

```js
const sauceColor = isMarinade ? '#5D4037'
                 : sauce.sauceType === 'dressing' ? '#1B5E20'
                 : '#4A0072';
```

These three colors do not live in CSS and are not shared with the per-sauce sauce-type pill colors in `styles.css:1985–1987` (`.sauce-type-sauce { background: #FEE7D6; color: #B43E0A; }` etc.). The pill colors are bright tints; the recipe-section label uses dark shades. They are coordinated by hand. A `SAUCE_TYPE_META` constant in `state.js` (which already declares `SAUCE_TYPES`) would unify them.

---

## 6. Component reuse summary

A list of every place where ad-hoc markup duplicates an available (or intended-to-be-available) component.

| Concern | Component that exists | Surface(s) that bypass it | Recommendation |
| --- | --- | --- | --- |
| Sauce list row | `renderSauceRow` (`helpers.js:468`) | None for list rows. The full recipe page is intentionally different — it represents a single Sauce in detail, not a list row. | No action. Rename the canonical to make its status explicit (e.g. `ui/sauce-row.js`) when the `ui/` directory is introduced. |
| Cuisine / accordion group | `renderCuisineGroup` (`helpers.js:497`) | None — but the function name is "Cuisine" while it's also used for Dish category and Ingredient category sections. | Rename to `renderAccordionGroup` when the next refactor lands. |
| Filter chips | `renderFilterChips` (`helpers.js:523`) | Sauce Manager (`settings.js:162–250`) has its own bespoke filter row | Migrate Sauce Manager to `renderFilterChips`. |
| Ingredient row | _(no canonical)_ | Pantry `_pantryRow` (`pantry.js:105`) and Ingredient Manager `renderFoodRow` (`settings.js:1046`) | Extract `renderIngredientRow(ing, { mode })`. See §5b. |
| Dish tile | _(no canonical)_ | Meal-flow `.carb-card` (`meal.js:78`) and Dish Manager `renderParent` / `renderVariantRow` (`settings.js:488–556`) | Possibly out of scope — the two surfaces serve very different jobs. At minimum extract the emoji + name + subline as `renderDishHeader(dish)`. See §5c. |
| Destructive-action confirm | _(no canonical)_ | 5 `confirm()` and 13 `alert()` sites across 5 files | Introduce `ui/sauce-popup.js` with `.confirm` / `.alert` / `.show` and migrate every site. Parallel to boardgame-buddy's `PolaroidPopup`. See `Docs/ARCHITECTURE.md` §6. |
| User badge | `renderHeaderAuthSlot` (`helpers.js:1027`) | Only the header. No other surface shows a user identity today. | No action until a user-attribution surface (e.g. sauce-author chip) is added. |
| Sauce-type color map | `SAUCE_TYPES` constant in `state.js:166` (labels only) + `styles.css:1985–1987` (pill bg/color) + `recipe.js:60–63` (section-label colors) | Three sources of truth | Consolidate into a `SAUCE_TYPE_META` const that ships labels + both color shades. |

---

## 7. Dead code (verified)

> All items in §7.1 below were deleted in the cleanup pass. They are retained in this document as a historical record. See "Cleanup log" at the end of the doc for the diff summary.

### 7.1 Confirmed dead — resolved by cleanup

Verified by per-class grep across `*.js` and `*.html` plus dynamic-build check (no `class="<prefix>-${`-style template hit).

| Class | styles.css line | Resolution |
| --- | --- | --- |
| `.browse-filters__empty` | 3009 | DELETED |
| `.browse-filters__row--scrollable` | 3002 | DELETED |
| `.builder-import-panel` | 1392 | DELETED |
| `.builder-sticky-header` | 621 | DELETED |
| `.carb-card-check` | 1409 | DELETED |
| `.check-mark` | 1411 | DELETED |
| `.color-dot-header` | 1423 | DELETED |
| `.coming-soon-badge` | 1489 | DELETED |
| `.meal-timing-banner` | 118 | DELETED |
| `.meal-timing-note` | 126 | DELETED |
| `.meal-timing-total` | 125 | DELETED |
| `.recipe-action-row` | 402 | DELETED |
| `.remove-ing-btn` | 1330 | DELETED |
| `.review-carbs` | 1438 | DELETED |
| `.review-summary` | 1431 | DELETED |
| `.source-card--disabled` | 1484 | DELETED |
| `.steps-container` | 534 | DELETED |
| `.variant-of-row` | 2645 | DELETED |

No JS function or file was confirmed dead.

### 7.2 Items previously suspected dead that are actually alive

| Item | Citation that proves it is alive |
| --- | --- |
| `renderAdmin()` (`settings.js:77`) | Dispatched at `helpers.js:659` for `case 'admin'`; `navigate('admin')` invoked at `settings.js:26, 41, 46, 56, 604, 777`. |
| `.sauce-type-sauce`, `.sauce-type-marinade`, `.sauce-type-dressing` | Built dynamically via `class="sauce-type-tag sauce-type-${typeValue}"` at `settings.js:275`, where `typeValue ∈ {sauce, marinade, dressing}` from `SAUCE_TYPES` (`state.js:166`). |
| `.builder-step-card[data-shade="1/2/3"]` | Built at `builder.js:341` via `data-shade="${si % 4}"`. |
| `.step-card[data-shade="1/2/3"]` | Built at `helpers.js:389` via `data-shade="${index % 4}"`. |
| `.recipe-action-btn--active` | Used at `recipe.js:55` (share button active state) and `recipe.js:37` (saucebook toggle active state). |
| `.swipe-row`, `.swipe-content`, `.swipe-action-edit`, `.swipe-action-delete` | Used across `saucebook.js`, `settings.js` (multiple sites). |
| `.empty-state` | Used at `meal.js:76`, `saucebook.js` empty state. |
| `.spinner-sm` | Used inside loading bursts in `settings.js`, `builder.js`. |
| `.legend-item`, `.legend-hidden`, `.legend-disabled` | Used in `helpers.js` step pie legend (`renderRecipeStep`). |
| `.admin-sauce-row--variant` | Used at `settings.js:296`. |

---

## 8. Inconsistencies — fonts, inline styles, design tokens

### 8.1 Typography

Sauceboss uses **Inter only** (`index.html:10` loads weights 400/500/600/700/800 from Google Fonts). There is no display family, no monospace, no script. The font is declared inline at `styles.css:3` for `html, body`, plus 12 explicit `font-family: Inter, sans-serif` overrides at child component levels (`:831, 1101, 1164, 1202, 1250, 1357, 2155, 2419, 2447, 2524, 2561`). These overrides look defensive against Pico.css's default sans-serif stack; once Pico is dropped they can collapse to the body inheritance.

There are 6 `font-family: inherit` declarations at form / button sites (`:646, 713, 957, 1325, 2761`) — these are correct; they keep the inputs from falling back to the UA monospace.

**Verdict: typographically homogeneous.** Compared to BoardgameBuddy (4 type roles: Crimson display, Poppins chrome, Fraunces polaroid, JetBrains Mono scores), sauceboss is visually simpler and more uniform.

### 8.2 Inline styles

Two flavors:

**Legitimate CSS-variable inline-style (4 sites)** — drive the staggered fade-up animation. All four pass per-item `--i` data:

| Site | Variable | Source |
| --- | --- | --- |
| `meal.js:81` | `--i:${i}` | Index of dish in grid |
| `meal.js:140, 146` | `--i:0`, `--i:${i+1}` | Index in subtype grid |
| `helpers.js:389` | `--i:${index}` | Index of recipe step |

**Verdict: legitimate.** These are per-instance values that can't come from the stylesheet.

**Legitimate data-driven literal inline-style (4 sites)** — drive per-sauce / per-item accent colors:

| Site | Style | Source |
| --- | --- | --- |
| `helpers.js:482` | `background:${sauce.color || '#E85D04'}` | Sauce's stored color → `.sauce-dot` left dot |
| `recipe.js:69` | `background:${sauceColor}` | Sauce-type derived color → `.meal-section-label` |
| `helpers.js:438` | `background:${itemColor}` | Item-prep derived color → `.meal-section-label` |
| `helpers.js:249` | `background:${color}` | Pie-slice color → legend swatch |
| `builder.js:204` | `background:${hex}` | Swatch picker iteration |
| `builder.js:668` | `background:${b.color}` | Review color dot |
| `settings.js:1105` | `border-left-color:${color}` | Sauce-chip border on ingredient panel |

**Verdict: legitimate.** Per-data accents must be inline.

**Questionable utility inline-style (~40 sites)** — hard-coded spacing, color, padding:

Examples:
- `init.js:50–53` — error fallback styling with literal hex colors and font-family
- `saucebook.js:157` / `browse.js:61` / `helpers.js:582, 599` — `margin-top:10px;display:block` repeated for `.browse-filters__label`
- `saucebook.js:162` / `browse.js:79` — `color:#9CA3AF` for count meta
- `browse.js:100` — `color:#DC2626;padding:8px 0` for error text
- `settings.js:142, 199, 202, 334, 351, 357, ...` — many `padding`, `color:#888`, `margin` literal inline styles in the admin surface
- `helpers.js:352` — `margin-bottom:16px` on card-panel
- `sauces.js:117` — `margin:16px` on card-panel

These would normally be utility classes or component-scoped CSS. They have grown organically across the admin manager and the filter rows. Migrating them is a stylistic cleanup, not a correctness fix; out of scope for this audit.

### 8.3 Design tokens — **None.**

`styles.css` declares **zero** design tokens. The only CSS custom properties used are runtime animation state:

- `--i` (stagger index) — used at `:2171` (`animation-delay: calc(var(--i, 0) * 50ms)`).
- `--pot-target-x`, `--pot-target-y`, `--pot-target-scale` — used at `:2302–2303` for the pot-fly splash exit animation.

There is no `--accent`, `--main-bg`, `--polaroid-bg`, etc. The brand orange `#E85D04` is hardcoded at 30+ sites in `styles.css` (verified by `grep -n 'E85D04' styles.css | wc -l` = 30). The cream background `#FFF8F0` is hardcoded at 8+ sites.

**Recommendation:** Declare a `:root` block at the top of `styles.css` with:

```css
:root {
  --accent: #E85D04;
  --accent-hover: #C94E02;
  --accent-tint: #FFF3E0;
  --main-bg: #FFF8F0;
  --card-bg: #ffffff;
  --text: #1A1A2E;
  --text-muted: #6B7280;
  --border: #E5E7EB;
}
```

Then sweep the hardcoded literals. This is part of the eventual `/ui-polish` DaisyUI migration; not addressed in this cleanup pass.

---

## Appendix — How this audit was produced

Every component count, dead-code claim, and `confirm`/`alert` citation in this document is `grep`-verified. Key commands:

```
# Render function definitions
grep -n "^function render" projects/sauceboss/web/*.js

# renderSauceRow call sites
grep -rn "renderSauceRow" projects/sauceboss/web --include="*.js"

# Dynamic CSS class builds
grep -nE 'class="[^"]*\$\{' projects/sauceboss/web/*.js
grep -n 'sauce-type-' projects/sauceboss/web/*.js

# Destructive action sites
grep -nE '\bconfirm\(|\balert\(' projects/sauceboss/web/*.js | grep -v '//'

# Inline style usage
grep -nE 'style="' projects/sauceboss/web/*.js

# Hex literal counts in CSS
grep -n "E85D04\|#FFF8F0" projects/sauceboss/web/styles.css | wc -l

# Top-level class selectors
grep -oE '^\.[a-zA-Z][a-zA-Z0-9_-]*' projects/sauceboss/web/styles.css | sort -u | wc -l

# CSS variable usage (sanity check on design tokens)
grep -n "var(--" projects/sauceboss/web/styles.css
```

To reproduce or extend: re-run those greps after any refactor and update the counts in §3 and §6.

---

## Cleanup log

### Pass 1 (initial audit) — 2026-05-24
Inventory only; no code changes.

### Pass 2 (cleanup) — 2026-05-24

**JS removed:** None. Every `render*` function in the codebase has at least one verified call site. `renderAdmin` was flagged by an earlier pass as dead; it is in fact dispatched at `helpers.js:659` and reached via 6 `navigate('admin')` sites in `settings.js` (see §7.2).

**CSS removed:** 18 verified-dead class blocks. Each was confirmed dead by `grep -rn '<name>' projects/sauceboss/web --include="*.js" --include="*.html"` returning 0 hits AND no dynamic build pattern.

| Class | Approx. former lines |
| --- | --- |
| `.browse-filters__empty` | 3 |
| `.browse-filters__row--scrollable` | 4 |
| `.builder-import-panel` | 8 |
| `.builder-sticky-header` | 9 |
| `.carb-card-check` | 2 |
| `.check-mark` | 11 |
| `.color-dot-header` | 7 |
| `.coming-soon-badge` | 8 |
| `.meal-timing-banner` | 8 |
| `.meal-timing-note` | 4 |
| `.meal-timing-total` | 4 |
| `.recipe-action-row` | 6 |
| `.remove-ing-btn` | 11 |
| `.review-carbs` | 6 |
| `.review-summary` | 6 |
| `.source-card--disabled` | 4 |
| `.steps-container` | 6 |
| `.variant-of-row` | 13 |

**Net effect on `styles.css`:** 3,128 → 3,027 lines (101 lines removed, ~3.2%).

**Verification commands run after cleanup:**

```
grep -rnE "browse-filters__empty|browse-filters__row--scrollable|builder-import-panel|builder-sticky-header|carb-card-check|check-mark|color-dot-header|coming-soon-badge|meal-timing-(banner|note|total)|recipe-action-row|remove-ing-btn|review-(carbs|summary)|source-card--disabled|steps-container|variant-of-row" projects/sauceboss/web
# → 0 matches
```

**Not addressed in this pass (tracked in `Docs/ARCHITECTURE.md` §6):**

- The 18 `confirm()` / `alert()` sites. Requires a shared modal first; tracked as target-state work.
- The missing canonical `renderIngredientRow` and `renderDishTile`. Each needs design decisions about variants.
- The auth-modal class rename to match `.claude/rules/auth-ui.md` (`auth-modal__oauth*` → `auth-oauth-btn*`, radius `10px` → `999px` pill, divider "or" → "or use email"). Touches `auth.js`, `styles.css`, and the rule's stale "Sauceboss does this" callout.
- The introduction of `:root` design tokens to replace the 80+ hardcoded `#E85D04` / `#FFF8F0` literals.
- The flat `web/` layout (18 files at root) being carved into `domain/` / `ui/` / `views/` / `widgets/`. Each is a multi-file refactor.
