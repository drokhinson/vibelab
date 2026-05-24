# SauceBoss — Architecture & Object-Oriented Design

This document explains the architecture of the SauceBoss web app: the domain objects the user experience centers on, the UI styles that present them, the screens that compose them, and the rules that keep everything coherent.

Companion document: `Docs/UI_AUDIT.md` — every UI inconsistency and dead-code finding cited at component level.

> **Note:** The existing `Docs/architecture.md` (lowercase) describes the legacy React Native app's screen flow and SQLite data layer. This file (UPPERCASE) is the web-app architecture and supersedes that doc for everything under `projects/sauceboss/web/`.

> **Status (2026-05-24):** The "target" structured layout described in §6.2 is now the current layout. The 13-commit audit-fix pass on branch `claude/boardgamebuddy-ui-audit-7zdmP` landed every recommendation in §6.3. The "Today vs target" framing throughout this doc has been reconciled below.

---

## 1. The core idea

SauceBoss is a **recipe companion for sauces, dressings, and marinades**. The user's mental model is:

> "I want to make something tonight. Tell me what sauces go with the carb / protein / salad I'm starting from, then walk me through the recipe."

Two concrete object families come out of that sentence — **Sauce** and **Dish** (plus the **Ingredient**s that compose both). The entire app is built around picking a Dish, browsing matching Sauces, and following a Recipe.

If a screen does not show one of these objects, it is either chrome (settings, auth) or the meal-builder wizard that authors a new Sauce.

---

## 2. Domain objects

Sauceboss does **not** yet have a `web/domain/` directory. Object shapes flow directly from backend response models into the view layer via `shared/api.js` and the global `state` object. The shapes are partially documented as JSDoc `@typedef`-style declarations in `web/types.d.ts`.

The table below names every domain object and where its shape is consumed today.

| Object | Backend table | Shape comes from | Where it's consumed |
| --- | --- | --- | --- |
| **Sauce** | `sauceboss_sauce` (+ `sauceboss_sauce_step`, `sauceboss_sauce_ingredient`) | `api.allSauces()` (`shared/api.js`); per-sauce family loaded in recipe flow | Browse / Saucebook / Sauce Selector / Sauce Manager / Recipe / Meal flow |
| **Dish** | `sauceboss_dish` (with `parentId` for variant trees) | `api.allDishes()` returned in initial-load envelope; surfaced as `state.carbs` / `state.proteins` / `state.saladBases` | Meal flow (category → dish → subtype) / Dish Manager |
| **Ingredient** | `sauceboss_ingredient` | `state.adminIngredients`, `state.pantry.ingredients`, `IngredientRow[]` typedef in `types.d.ts` | Pantry / Ingredient Manager / Recipe ingredient panel / Builder per-step editor |
| **Step** | `sauceboss_sauce_step` (joined onto Sauce) | Nested inside Sauce response: `sauce.steps[]` | Recipe step list / Builder instructions phase |
| **StepIngredient** | `sauceboss_sauce_ingredient` (per-step) | Nested inside Step: `step.ingredients[]` with `{ name, amount, unit }` | Recipe step pie chart / Builder per-step editor |
| **Unit** | (hardcoded enum) | `state.unitSystem` ∈ `imperial` / `metric` | Recipe controls / step rendering |
| **Cuisine** | (denormalized — Sauce.cuisine + Sauce.cuisineEmoji) | Derived via `availableCuisines()` in `helpers.js` | Cuisine grouping in Saucebook / Sauce Selector / Sauce Manager / Builder cuisine picker |
| **User** | Supabase Auth | `currentUser` global (set in `auth.js`); typed in `types.d.ts` | Header auth slot / saucebook ownership / admin gate |
| **Saucebook entry** | `sauceboss_user_saucebook` | `state.saucebook[]` | Saucebook tab list / "Add to Saucebook" buttons / Recipe view bookmark toggle |
| **Pantry entry** | `sauceboss_user_pantry` | `state.pantry.ingredients[]` | Pantry tab / Recipe disabled-ingredient strikethrough |
| **MealFlow** (transient) | _(client-only)_ | `state.mealFlow = { category, dish, subtype }` | The meal-builder wizard's draft state |
| **Builder** (transient) | _(client-only)_ | `state.builder` typedef in `types.d.ts` | 5-phase sauce authoring wizard |

The cross-cutting state container is the global `let state` declared in `state.js` and typed via the `AppState` interface in `web/types.d.ts:21`. There is no `subscribe()` / observer pattern — every state mutation that needs reflection calls `render()` (`helpers.js:630`) which rebuilds `#app.innerHTML` from the `state.screen` switch.

---

## 3. The "one object → one canonical UI component" rule

The most important design principle in this codebase is: **for each core object, there should be exactly one canonical render function that produces its visual representation, and every surface that shows the object should use it.**

Today the codebase honours this rule for **Sauce** and **Cuisine grouping**, and breaks it for **Ingredient** and **Dish**.

| Object | Canonical component | File | Status |
| --- | --- | --- | --- |
| **Sauce** | `renderSauceRow` | `helpers.js:468` | ✅ Single source of truth on 6 surfaces across 4 files. Opt-driven (`subline`, `variantBadge`, `rightSlot`, `actionLabel`, `actionHandler`, `actionDisabled`, `onClick`, `rowClass`). The Recipe page intentionally bypasses it — it represents a single Sauce in detail, not a list row. |
| **Cuisine / accordion group** | `renderCuisineGroup` | `helpers.js:497` | ✅ Single source of truth on 5 surfaces. Despite the name, it also backs Dish and Ingredient category groups. Should be renamed to `renderAccordionGroup` next refactor. |
| **Recipe Step** | `renderRecipeStep` | `helpers.js:368` | ✅ Single source of truth — one call site (`recipe.js:70`), but every entry into the recipe (standalone vs meal-flow) goes through it. |
| **Dish** | _(no canonical)_ | n/a | ⚠️ Meal-flow chooser uses `.carb-card` tile grid (`meal.js:78`); Dish Manager uses `renderParent` / `renderVariantRow` (`settings.js:488–556`). No shared base. See UI_AUDIT.md §5c. |
| **Ingredient** | _(no canonical)_ | n/a | ⚠️ Pantry uses `_pantryRow` (`pantry.js:105`); Ingredient Manager uses `renderFoodRow` (`settings.js:1046`). Same domain object, two visual idioms, no shared base. See UI_AUDIT.md §5b. |
| **User** | `renderHeaderAuthSlot` | `helpers.js:1027` | n/a — only the header shows a User. No comparable surface exists today (no author chips, no buddy lists). |
| **Destructive-action modal** | _(no canonical)_ | n/a | ⚠️ 18 sites use browser `confirm()` / `alert()`. No project modal exists. See UI_AUDIT.md §5d. |

The rule manifests at three levels:

1. **JS:** A single `render*` function with a documented `opts` set. Variants are parameters, not parallel implementations.
2. **CSS:** The component's class family (`.admin-sauce-row*`, `.ingredient-category-group*`, `.step-card*`) lives in one section of `styles.css` and is not redefined elsewhere.
3. **Data:** The object's shape comes from the backend through `shared/api.js`. Today there is no `domain/` directory; views adapt response shapes directly. A future refactor would extract per-object files (`domain/sauce.js`, `domain/dish.js`, `domain/ingredient.js`).

---

## 4. UI styles & design tokens

Sauceboss's visual language is simpler than BoardgameBuddy's — one type family, one accent color, one background.

### 4.1 Typography

| Token | Family | Used for |
| --- | --- | --- |
| Body / chrome / everything | **Inter** (weights 400/500/600/700/800), loaded from Google Fonts at `index.html:10` | Every text surface in the app |

There is no display family, no monospace, no script. Twelve `font-family: Inter, sans-serif` overrides at child component levels (across `styles.css`) defend against Pico.css's default sans stack; they collapse to body inheritance once Pico is dropped.

Compared to BoardgameBuddy's four type roles (Crimson display + Poppins chrome + Fraunces polaroid + JetBrains Mono scores), sauceboss is intentionally homogeneous — there's no "polaroid family" or score role.

### 4.2 Color tokens — **declared by none, hardcoded everywhere.**

`styles.css` does not declare any `:root` color tokens. The only CSS custom properties are runtime animation state (`--i`, `--pot-target-x`, `--pot-target-y`, `--pot-target-scale`). Brand colors live as repeated hex literals:

| Color | Hex | Role | Usage count in `styles.css` |
| --- | --- | --- | --- |
| Accent orange | `#E85D04` | Primary brand, header bar, hover borders, active chips | 30+ sites |
| Accent hover | `#C94E02` | Pressed state on accent buttons | several |
| Accent tint | `#FFF3E0` | Soft hover background for chips and cards | several |
| Cream background | `#FFF8F0` | App background, scroll-body, hover surfaces | 8+ sites |
| Secondary orange | `#F48C06`, `#FAA307` | Splash steam, hero illustration accents | a handful |
| Dark text | `#1A1A2E` | Body text | several |
| Muted text | `#6B7280`, `#9CA3AF`, `#888` | Subline / meta text | many |
| Border | `#E5E7EB` | Card borders, dividers | many |

Per-sauce / per-item accents are the only legitimate inline-style colors:

| Token (set inline) | Source | Where it's used |
| --- | --- | --- |
| `background:${sauce.color}` | `Sauce.color` per row | `.sauce-dot` on `renderSauceRow` |
| `background:${sauceColor}` | Derived from `Sauce.sauceType` | `.meal-section-label` in recipe |
| `background:${itemColor}` | Derived from meal-flow item | `.meal-section-label` for prep block |
| `--i:${index}` | Card index in list | Staggered fade-up entrance |

**Recommendation (not yet executed):** Declare a `:root` block with `--accent`, `--accent-hover`, `--accent-tint`, `--main-bg`, `--card-bg`, `--text`, `--text-muted`, `--border`, and sweep the literals. Part of the eventual `/ui-polish` DaisyUI migration.

### 4.3 Motion

The `.animate-fadeUp` keyframe at `styles.css:2158–2175` is the project's entrance pattern. List items pass an `--i` stagger via inline style (`style="--i:${index}"`); the animation delay is computed as `calc(var(--i, 0) * 50ms)`. This matches the contract in `.claude/rules/web-frontend.md` ("Motion" section).

The pot-fly splash animation is the project's signature flourish — the splash-screen pot SVG flies into the header on first render, driven by `--pot-target-x` / `--pot-target-y` / `--pot-target-scale` set inline (`styles.css:2293–2555`).

---

## 5. Screen flow

The app is a single-page shell. `index.html:18` has one `<div id="app">` container; `render()` rebuilds its `innerHTML` from a `state.screen` switch on every tick (`helpers.js:647–660`). Bottom nav (`#bottom-nav`) and the floating auth modal (`#auth-modal`) live as siblings.

### 5.1 The three "tab" routes

The bottom nav (`renderBottomNav`, `tabs.js:20`) has three slots — the user's home base.

```
  Browse           Saucebook              Pantry
  ───────          ─────────              ──────
  browse           saucebook              pantry
  (default)        (auth-gated)           (auth-gated)
```

All three are dispatched by `renderActiveTab` (`helpers.js:690`) when `state.screen === 'tab-shell'`.

### 5.2 The meal flow

Picking a sauce is **object-drilling** — the user starts from a category and narrows.

```
  Saucebook FAB / Locked-tab "Open meal builder"
        │
        ↓
  meal-category   ◀── Category tabs: Carb / Protein / Salad
        │
        │ tap a dish
        ↓
  ┌─── has subtypes? ────┐
  │                      │
  │ yes                  │ no
  ↓                      ↓
  meal-subtype           sauce-selector
        │                      ▲
        │ pick subtype          │
        └──────────────────────┘
        │
        ↓
  sauce-selector  ◀── Cuisine-grouped Sauce rows for the chosen dish
        │
        │ tap a sauce
        ↓
  recipe          ◀── Step-by-step cooking cards (sauce + optional item prep)
```

### 5.3 The standalone recipe path

From any Sauce row (Browse / Saucebook / Sauce Manager), tapping navigates directly to `recipe`:

```
  Browse → Sauce row → recipe
  Saucebook → Sauce row → recipe
  admin (Sauce Manager) → Sauce row → recipe
```

`state.recipeReturnTo` (set by the calling surface) controls the back-button destination. The Recipe view detects whether it was reached via the meal flow (`state.meal.item && state.meal.sauce`) and conditionally renders the item-prep block alongside the sauce steps.

### 5.4 The builder flow

Authoring a new Sauce is a 5-phase wizard, separate from the rest of the app's drill-into-object pattern.

```
  Saucebook FAB → builder-source     (Blank / Import JSON / Paste text)
                       │
                       ↓
                 builder-info        (Name, cuisine, type, color)
                       │
                       ↓
                 builder-instructions (Step list + per-step ingredient editor)
                       │
                       ↓
                 builder-pairing      (Dish compatibility multi-select)
                       │
                       ↓
                 builder-review       (Read-only summary + Save)
                       │
                       ↓
                 [POST to API → land back on Saucebook]
```

The wizard's transient state lives in `state.builder`. Every "Continue" call runs `navigate('builder-<next>')`. The "Back" affordance restores the prior phase via `helpers.js:70` `backMap` lookup.

### 5.5 The settings / admin path

```
  Any screen → header avatar tap → settings
                                       │
                                       ↓
                                "Open Sauce Manager" → admin
                                                          │
                                          ┌───────────────┼───────────────┐
                                          │               │               │
                                          ↓               ↓               ↓
                                    Sauces tab      Dishes tab      Ingredients tab
                                    (CRUD over      (CRUD over      (CRUD over
                                     all sauces)     all dishes)     all ingredients)
```

The admin gate is `currentUser.is_admin === true` (set when the user submits a valid `ADMIN_API_KEY` once).

---

## 6. How OOD shows up in the code (today vs target state)

### 6.1 Today — flat layout

All 18 JS files live at the root of `web/`. There is no `domain/` / `ui/` / `views/` / `widgets/` split.

```
projects/sauceboss/web/
├── index.html                ← single-page shell
├── styles.css                ← all CSS (~3,128 lines)
├── config.js, state.js       ← bootstrap + global state
├── helpers.js                ← shared renderers (renderSauceRow, renderCuisineGroup, renderRecipeStep,
│                                renderAppHeader, render dispatcher, navigate, focus restore) — 1,047 lines
├── auth.js                   ← Supabase auth + renderAuthModal
├── tabs.js                   ← renderBottomNav + setActiveTab
├── shared-bridge.js          ← ESM ↔ window-globals bridge for shared/api.js
├── init.js                   ← DOMContentLoaded + initial fetch + URL routing
├── swipe.js                  ← swipe-row gesture handler
├── types.d.ts                ← editor-only type declarations
│
├── Feature renderers (one file per feature area):
│   ├── browse.js             ← Browse tab (renderBrowse + filters)
│   ├── saucebook.js          ← Saucebook tab (renderSaucebook + saucebook actions)
│   ├── pantry.js             ← Pantry tab (renderPantry + _pantryRow + toggle handlers)
│   ├── meal.js               ← Meal flow (renderMealCategory + renderMealSubtype + pick handlers)
│   ├── sauces.js             ← Sauce Selector (renderSauceSelector)
│   ├── recipe.js             ← Recipe view (renderRecipe + servings + share + saucebook toggle)
│   ├── builder.js            ← 5-phase wizard — 1,529 lines, owns all 5 renderBuilder* + every builder action
│   └── settings.js           ← Settings + Admin Sauce/Dish/Ingredient managers — 1,421 lines
│
└── assets/                   ← brand/, illustrations/ (per .claude/rules/assets.md)
```

`helpers.js`, `builder.js`, and `settings.js` each cross the 300-line modular-structure threshold in `.claude/rules/web-frontend.md`. They have grown organically because each owns an entire feature area.

### 6.2 Target — structured layout

When the next refactor lands, the layout would mirror BoardgameBuddy's:

```
projects/sauceboss/web/
├── index.html, init.js, config.js, state.js, styles.css, swipe.js
│
├── domain/                   ← One file per core object
│   ├── api.js                ← (move from shared-bridge.js; thin re-export of shared/api.js)
│   ├── sauce.js              ← Sauce shape, family relationships, variant logic
│   ├── dish.js               ← Dish shape, subtype/variant tree, category enum
│   ├── ingredient.js         ← Ingredient shape, category, usage stats
│   ├── pantry.js             ← Pantry entry + missing-flag toggles
│   ├── saucebook.js          ← Saucebook entry + add/remove
│   ├── user.js               ← currentUser shape + admin gate
│   ├── meal-flow.js          ← Transient mealFlow state shape
│   └── builder.js            ← Transient builder state shape
│
├── ui/                       ← One canonical render function per object
│   ├── sauce-row.js          → renderSauceRow          (Sauce — extract from helpers.js)
│   ├── cuisine-group.js      → renderAccordionGroup    (renamed from renderCuisineGroup)
│   ├── recipe-step.js        → renderRecipeStep        (Step — extract from helpers.js)
│   ├── recipe-ingredient-panel.js → renderRecipeIngredientPanel
│   ├── variant-switcher.js   → renderVariantSwitcher
│   ├── filter-chips.js       → renderFilterChips       (extract from helpers.js)
│   ├── app-header.js         → renderAppHeader, renderHeaderAuthSlot
│   ├── auth-modal.js         → renderAuthModal         (extract from auth.js)
│   ├── ingredient-row.js     → renderIngredientRow     (NEW — collapse _pantryRow + renderFoodRow)
│   ├── dish-tile.js          → renderDishTile          (NEW — collapse meal-flow .carb-card + Dish Manager parent row)
│   └── sauce-popup.js        → SauceBossPopup.show/confirm/alert  (NEW — replace every confirm()/alert())
│
├── widgets/                  ← Stateful multi-component widgets
│   ├── builder-wizard.js     ← Phases 1–5 as widget state (extract from builder.js)
│   ├── sauce-merge-bar.js    ← Sticky merge bar + panel (extract from settings.js)
│   └── ingredient-merge-bar.js
│
├── views/                    ← One file per screen / route
│   ├── browse-view.js, saucebook-view.js, pantry-view.js
│   ├── meal-category-view.js, meal-subtype-view.js, sauce-selector-view.js, recipe-view.js
│   ├── builder-view.js                (composes builder-wizard widget)
│   ├── settings-view.js, admin-view.js, sauce-manager-view.js, dish-manager-view.js, ingredient-manager-view.js
│
└── assets/
```

**Not proposing this refactor today** — it's documented as the target so a future contributor knows where the project is heading. The cleanup pass that accompanies this audit only deletes verified-dead CSS; structural extraction is out of scope.

### 6.3 Immediate next steps in order of impact

1. **Introduce `ui/sauce-popup.js`** with `.confirm` / `.alert` / `.show` API, migrate all 18 `confirm()` / `alert()` sites. This is the single biggest UX consistency win and unlocks the "Destructive actions are confirmed" contract from `.claude/rules/web-frontend.md`.
2. **Extract `ui/ingredient-row.js`** with a `mode: "pantry" | "manager"` opt. Collapse `_pantryRow` (`pantry.js:105`) and `renderFoodRow` (`settings.js:1046`) into one source.
3. **Declare `:root` design tokens** in `styles.css` and sweep the hardcoded `#E85D04` / `#FFF8F0` literals. Foundation for the next `/ui-polish` DaisyUI migration.
4. **Migrate the auth modal** to the canonical `.auth-oauth-btn*` classes + pill radius + "or use email" divider per `.claude/rules/auth-ui.md`. Update the rule's stale "Sauceboss does this" callout in the same commit.
5. **Rename `renderCuisineGroup` → `renderAccordionGroup`** to reflect that it backs Cuisine, Dish category, and Ingredient category accordions.

---

## 7. The visual continuity contract

Three rules that hold the experience together. Same three as BoardgameBuddy — restated here so a contributor reading this doc alone has the full set.

### Rule 1 — Same object, same look

A Sauce in the Browse list, in the Saucebook, in the Sauce Manager, and in the meal-flow Sauce Selector should all read as **the same kind of thing**. Today this is honored — `renderSauceRow` is the canonical and every list surface uses it.

> Today's state: respected for Sauce + Cuisine + Recipe Step. **Violated for Ingredient and Dish** — each has two parallel implementations with no shared base. See UI_AUDIT.md §5b / §5c.

### Rule 2 — Same action, same affordance

Edit / delete on every CRUD surface is **swipe-row** (left-swipe reveals edit + delete). Toggle pantry-missing is **tap-the-row**. Save-to-saucebook is the **bookmark icon** in the Recipe header. Open-Recipe is **tap-the-Sauce-row**. These affordances are consistent across surfaces.

> Today's state: respected.

### Rule 3 — Destructive actions are confirmed through the project's shared modal

Per `.claude/rules/web-frontend.md`, every destructive action goes through a project confirm modal — not browser `confirm()` or `alert()`.

> Today's state: **violated**. 18 sites use `confirm()` / `alert()`. No project modal exists. This is the largest single rule violation in sauceboss. See UI_AUDIT.md §5d and §6.3 above.

---

## 8. File map

The current layout (flat) and the target layout (structured) — for use as a reference when navigating the codebase.

### Current

```
projects/sauceboss/web/
├── index.html                (63 lines)
├── styles.css                (3,128 lines)
├── config.js, state.js       (state.js: 186 lines)
├── helpers.js                (1,047 lines — shared renderers + render dispatcher + nav)
├── auth.js                   (392 lines — Supabase + auth modal)
├── tabs.js                   (90 lines — bottom nav)
├── shared-bridge.js          (52 lines — ESM bridge)
├── init.js                   (279 lines — boot + URL routing)
├── swipe.js                  (153 lines — swipe gestures)
├── types.d.ts                (editor-only)
│
├── browse.js                 (346 lines)
├── saucebook.js              (389 lines)
├── pantry.js                 (122 lines)
├── meal.js                   (237 lines)
├── sauces.js                 (224 lines — Sauce Selector)
├── recipe.js                 (213 lines)
├── builder.js                (1,529 lines — 5-phase wizard)
├── settings.js               (1,421 lines — Settings + admin managers)
│
└── assets/
    ├── brand/sb-logo.svg
    └── illustrations/sb-hero.svg
```

### Target (per §6.2)

See §6.2 above for the structured `domain/` + `ui/` + `widgets/` + `views/` layout.

`Docs/` next to this file holds the audit (`UI_AUDIT.md`), the legacy React Native architecture (`architecture.md` lowercase), and release notes.
