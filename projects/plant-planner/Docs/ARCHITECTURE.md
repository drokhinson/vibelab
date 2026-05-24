# PlantPlanner — Architecture & Object-Oriented Design

This document explains the architecture of the PlantPlanner web app: the domain objects the user experience centers on, the UI styles that present them, the screens that compose them, and the rules that keep everything coherent.

Companion document: `Docs/UI_AUDIT.md` — every UI inconsistency and dead-code finding cited at component level. Read it for the per-line evidence behind the gaps called out here.

> **Status (2026-05-24):** The "target" structured layout described in §6.2 is **not** yet the current layout — see §6.1 for what exists today. The audit at `Docs/UI_AUDIT.md` §9 captures the 12-PR sequence that would migrate the codebase to the target.

---

## 1. The core idea

PlantPlanner is a **planter design tool focused on plant selection**. The user's mental model is:

> "I'm starting a new planter. Walk me through picking the right plants for my conditions, then let me arrange them."

Three concrete object families come out of that sentence — **Plant**, **Garden**, and the **Placement** of a Plant inside a Garden's bed. The entire app is built around browsing Plants, building a Garden, and placing Plants inside it.

If a screen does not show one of these objects, it is either chrome (auth header) or a wizard step authoring a new Garden.

---

## 2. Domain objects

PlantPlanner does **not** yet have a `web/domain/` directory. Object shapes flow directly from backend response models into the view layer via `apiFetch` (`helpers.js`) and the global `state` / per-view state variables. The canonical shape definitions live in the database schema (see `STRUCTURE.md` §Data Model).

The table below names every domain object and where its shape is consumed today.

| Object | Backend table | Shape comes from | Where it's consumed |
| --- | --- | --- | --- |
| **Plant** | `plantplanner_plant_cache` | `apiFetch('/catalog/search')`, `apiFetch('/catalog/{id}')` | Plant Browser grid / Plant shopping grid / My Plants library grid / Garden builder shortlist sidebar / All three detail panels |
| **Garden** | `plantplanner_gardens` | `apiFetch('/gardens')`, `apiFetch('/gardens/{id}')` | My-Gardens list / New-Garden wizard / Garden builder header + conditions strip / Shopping header |
| **Placement** | `plantplanner_garden_plants` | Nested inside Garden: `garden.plants[]` | 2D top-down builder (`render2d.js`) only — no other surface visualizes Placements |
| **UserPlant** (library entry) | `plantplanner_user_plants` | `apiFetch('/user_plants')` | My Plants library / Plant Browser "Add to plant list" / "Add to favorites" toggles |
| **Shortlist** (per-garden) | `plantplanner_gardens.shortlist_plant_cache_ids` (TEXT[]) | Embedded in Garden response | Shopping heart toggles / Builder sidebar tiles |
| **User** | Supabase Auth → `plantplanner_profiles` | `apiFetch('/auth/me')` → global `currentUser` | Auth screen / navbar pill only |
| **Cuisine — N/A** | — | — | (PlantPlanner has no Cuisine analog. The closest concept is per-garden "conditions" — light/water/season — but those are scalars on the Garden, not separate objects.) |
| **Wizard state** (transient) | _(client-only)_ | `gardenWizardState` global | The 4-step new-garden wizard |
| **Builder state** (transient) | _(client-only)_ | `placements[]`, `currentGarden`, drag state | The 2D builder |

The cross-cutting state container is `state` declared in `state.js` plus per-feature scoped state objects (`libraryState`, `shoppingState`, `browserState`, `gardenWizardState`). There is no `subscribe()` / observer pattern — every state mutation that needs reflection calls `render()` (`helpers.js:605`) which rebuilds `#app.innerHTML` from the `currentView` switch.

---

## 3. The "one object → one canonical UI component" rule

The most important design principle in this codebase is: **for each core object, there should be exactly one canonical render function that produces its visual representation, and every surface that shows the object should use it.**

Today the codebase honours this rule for **shared utilities (filter chips, plant-info bullets, fill-progress runner)** and **breaks it for the Plant card** and **the Plant detail panel**.

| Object | Canonical component | File | Status |
| --- | --- | --- | --- |
| **Plant** (card) | _(no canonical)_ | n/a | ❌ **Three parallel implementations.** `_renderShoppingCard` (`shopping.js:222`), `_renderBrowserCard` (`browser.js:249`), `_renderLibraryCard` (`library.js:114`). Same domain object, three CSS class families, no shared base. See UI_AUDIT.md §4a. |
| **Plant** (detail panel) | _(no canonical shell; body is shared)_ | n/a | ⚠️ **Three parallel hosts.** `#shopping-detail-panel` (`shopping.js:189`), `#library-detail-panel` (`library.js:59`), `#browser-detail-panel` (`browser.js:183`). The panel **body** uses shared `_plant*` helpers; the **shell** (mount div + open / dismiss) is duplicated three ways. See UI_AUDIT.md §4b. |
| **Plant info bullets** | `_plant*Bullets` cluster + `_plantInfoSectionsHtml` | `helpers.js:262–525` | ✅ Single source of truth on 3 surfaces — used by all three detail panels. |
| **Garden** | `.garden-card` markup + `renderGardens` | `gardens.js` | ⚠️ Only one surface today (My-Gardens list) renders a Garden as a card. The builder header surfaces a Garden as a banner, not a card. No fragmentation yet; canonical extraction is opportunistic, not urgent. |
| **Placement** | `render2d.js` SVG renderer | `render2d.js` | n/a — only one surface (the builder) visualizes a Placement. No comparable surface exists today. The dropped Phase-2 features (companion warnings, bloom calendar, shading) used to render Placement-derived data; they were retired (`STRUCTURE.md` 2026-05-09). |
| **UserPlant status pill** | `_statusPillHtml` | `library.js:143` | n/a — only the library surface shows the status. |
| **Filter chips** | `renderFilterChipRow` (post-PR 2: `renderFilterChips`) | `helpers.js:212` | ✅ Single source of truth on 3 surfaces (Browser / wizard / Import). |
| **Fill-progress** | `renderFillProgress`, `setFillStep` | `helpers.js:533, :578` | ✅ Single source of truth on 2 surfaces (Shopping / Import). |
| **User badge** | `renderAuth` header logic | `auth.js:97` | n/a — only the navbar shows a user identity. No comparable surface exists today. |
| **Destructive-action modal** | _(no canonical)_ | n/a | ❌ 16 sites use browser `confirm()` / `alert()`. No project modal exists. See UI_AUDIT.md §5. |

The rule manifests at three levels:

1. **JS:** A single `render*` function with a documented `opts` set. Variants are parameters, not parallel implementations.
2. **CSS:** The component's class family (`.shopping-card*`, `.library-card*`, `.shopping-detail-panel*`) lives in one section of `styles.css` and is not redefined elsewhere. Today the three Plant card families overlap.
3. **Data:** The object's shape comes from the backend via `apiFetch`. Today there is no `domain/` directory; views adapt response shapes directly. A future refactor (UI_AUDIT.md §9 PR 12) would extract per-object files (`domain/plant.js`, `domain/garden.js`, `domain/placement.js`).

---

## 4. UI styles & design tokens

PlantPlanner's visual language is anchored by DaisyUI's pastel theme + a small custom token block.

### 4.1 Typography

| Token | Family | Used for |
| --- | --- | --- |
| Display | **Quicksand** (weights 500/600/700) — loaded from Google Fonts at `index.html:15` | `.font-display` — used on the navbar wordmark, section headings |
| Body / chrome | **Inter** (weights 400/500/600) — same source | Everything else |

Two type roles. Less than BoardgameBuddy's four (no polaroid script, no monospace), more than sauceboss's one (no display family). Quicksand pairs well with the cute-garden visual identity (rounded letterforms).

### 4.2 Color tokens — declared on the pastel theme override

`styles.css:6–14` declares 7 custom tokens that layer on top of DaisyUI's pastel palette:

```css
[data-theme="pastel"] {
  --pp-accent:       #E8856C;   /* warm coral — primary accent */
  --pp-lavender:     #B8A9D4;   /* secondary accent */
  --pp-sage:         #7BAE7F;   /* tertiary / leaf accent */
  --pp-cream:        #FBF8F3;   /* warm off-white background */
  --pp-warm-border:  rgba(0, 0, 0, 0.06);
  --pp-shadow:       0 2px 12px rgba(0,0,0,0.05);
  --pp-shadow-lg:    0 6px 24px rgba(0,0,0,0.08);
}
```

DaisyUI's semantic tokens (`oklch(var(--bc))`, `oklch(var(--b1))`, `oklch(var(--p))`, `oklch(var(--su))`, etc.) carry the rest. `styles.css` uses `var(--…)` at 324 sites; only 40 raw hex literals remain. **This is the standard already.**

One token is missing for the modal in UI_AUDIT.md §9 PR 4: `--pp-danger: #dc2626` (the destructive accent). Today `#dc2626` is hardcoded twice in CSS.

Per-data accents are the only legitimate inline-style colors:

| Token (set inline) | Source | Where it's used |
| --- | --- | --- |
| `style="--i:${index}"` | Card index in list | Staggered fade-up entrance |
| `style="--i:${idx}"` | Library / browser / shopping card index | Same animation |
| `background:${color}` | Per-plant or per-status color in `render2d.js` / pills | Disk renderer + library status pill |

### 4.3 Motion

The `.animate-fadeUp` keyframe and `--i` stagger pattern match the contract in `.claude/rules/web-frontend.md` "Motion" section. Every card grid (`.shopping-card`, `.library-card`, `.garden-card`) passes `style="--i:${index}"` and inherits the staggered entrance.

There is no signature splash animation (cf. sauceboss's pot-fly). The boot sequence shows a `loading` spinner inside `#app` while data loads.

---

## 5. Screen flow

The app is a single-page shell. `index.html:33` has one `<div id="app">` container; `render()` rebuilds its `innerHTML` from the `currentView` switch. The top navbar (`#nav-right` inside the `.navbar`) and the bottom-nav slot (`#bottom-nav`) live as siblings.

### 5.1 The three top-level views (navbar)

The navbar exposes three top-level destinations after sign-in. Default landing is **My Plants** (library).

```
  My Plants (default)       Plant Browser        My Gardens
  ──────────────────        ─────────────        ──────────
  library                   browser              gardens
                            │
                            └─ Import (separate view, reached via the "Import" button)
```

### 5.2 The new-planter flow

Creating a planter is a 4-step wizard, followed by a plant-shopping phase, followed by the placement builder.

```
  My Gardens → "+ New Garden"
                    │
                    ↓
              wizard (4 steps in gardens.js)
              ├─ Filters       (light · water · zone · season)
              ├─ Planter       (type · size · name)
              ├─ Catalog source (Sync from API · Use existing)
              └─ Review         (read-only summary + Confirm)
                    │
                    │ (POST /gardens, then openShoppingForGarden(id))
                    ↓
              shopping (Pinterest grid of plants matching the planter's conditions)
              ├─ Heart cards to shortlist
              ├─ Tap card → slide-in detail panel
              └─ "Continue to placement"
                    │
                    │ (PUT /gardens/{id} shortlist, then openGarden(id))
                    ↓
              garden builder (2D top-down via render2d.js)
              ├─ Sidebar — shortlist tiles, draggable
              ├─ 2D bed — drag-drop placement, tap-to-remove
              └─ Save / Reseed
```

### 5.3 The plant-library flow

```
  My Plants → status filter tabs (All · Current · Wishlist · Former)
                    │
                    │ tap a card
                    ↓
              slide-in detail panel
              ├─ Plant facts (sunlight, watering, hardiness, edible)
              ├─ Editable fields (status, qty, notes, acquired_at)
              ├─ Planter chips ("In: <Garden Name>" — each navigates to that planter's builder)
              ├─ "Add to a planter" picker (every Garden the plant is NOT already in)
              └─ "Remove from library" button
```

### 5.4 The plant-browser flow

```
  Plant Browser → free-text search + collapsible filter dropdown
                    │
                    │ tap a card
                    ↓
              slide-in detail panel
              ├─ Plant facts (same body as library/shopping)
              └─ Two action buttons: "Add to plant list" (current) / "Add to favorites" (wishlist)
```

The Browser also exposes an "Import" button that opens the standalone Import view — runs the same `runFillStep` orchestration as the wizard but standalone (no planter created).

---

## 6. How OOD shows up in the code (today vs target state)

### 6.1 Today — flat layout

All 15 JS files live at the root of `web/`. There is no `domain/` / `ui/` / `views/` / `widgets/` split.

```
projects/plant-planner/web/
├── index.html              (61 lines)         ← single-page shell, DaisyUI + Tailwind CDN
├── styles.css              (2,558 lines)      ← all CSS; 425 class selectors, 324 var(--…) uses
├── config.js, state.js     (state.js: 32 lines, set by build.sh at deploy)
├── theme.js                (13 lines)         ← Theme registry
├── helpers.js              (644 lines)        ← apiFetch + nav + 25+ _plant* formatters + renderFilterChipRow + renderFillProgress + render() + validatePlacement
├── garden-units.js         (61 lines)         ← Per-garden-type unit semantics (inches vs feet)
├── auth.js                 (252 lines)        ← Supabase auth + canonical OAuth modal
├── init.js                 (21 lines)         ← DOMContentLoaded + boot
│
├── Feature renderers (one file per top-level view):
│   ├── gardens.js          (922 lines)        ← My-Gardens list + 4-step new-garden wizard
│   ├── shopping.js         (515 lines)        ← Plant shopping grid + detail panel + shortlist
│   ├── library.js          (464 lines)        ← My Plants library + status filter + detail panel
│   ├── browser.js          (568 lines)        ← Plant Browser + filter dropdown + detail panel
│   ├── import.js           (199 lines)        ← Plant import view (catalog fill orchestration)
│   ├── garden.js           (291 lines)        ← Garden builder shell — wires renderer, sidebar, save/reseed
│   └── location.js         (270 lines)        ← Geolocation + ZIP picker modal
│
├── Renderers (the 2D top-down view):
│   ├── render2d.js         (339 lines)        ← SVG top-down 2D planter renderer
│   └── preview3d.js        (328 lines)        ← SVG isometric wizard preview
│
└── assets/
    ├── brand/              pp-logo.svg
    ├── illustrations/      empty-state, hero
    └── sprites/plants/     per-plant PNGs
```

`gardens.js`, `helpers.js`, `browser.js`, and `shopping.js` each cross the 300-line modular-structure threshold in `.claude/rules/web-frontend.md`. They have grown organically because each owns an entire feature area.

### 6.2 Target — structured layout

When the audit's fix sequence (UI_AUDIT.md §9) lands, the layout would match the post-audit sauceboss + boardgame-buddy pattern:

```
projects/plant-planner/web/
├── index.html, init.js, config.js, state.js, theme.js, styles.css
├── helpers.js (residual ~200 lines — apiFetch, nav, render dispatcher, validatePlacement)
├── garden-units.js (unchanged, canonical per STRUCTURE.md)
│
├── domain/                 ← One file per core object
│   ├── plant.js            ← Plant shape, library-status helpers, shortlist helpers
│   ├── garden.js           ← Garden shape, conditions formatter
│   └── placement.js        ← Placement shape + validatePlacement
│
├── ui/                     ← One canonical render function per object + shared shells
│   ├── filter-chips.js     → renderFilterChips         (extract from helpers.js)
│   ├── plant-info.js       → _plant*Bullets cluster    (extract from helpers.js)
│   ├── fill-progress.js    → renderFillProgress        (extract from helpers.js)
│   ├── pp-modal.js         → PPModal.show/confirm/alert/dismiss  (NEW — replace every confirm()/alert())
│   ├── plant-card.js       → renderPlantCard(plant, { variant })  (NEW — collapse the 3 parallel renderers)
│   ├── plant-detail-panel.js → renderPlantDetailPanel(plant, { variant })  (NEW — collapse the 3 detail-panel hosts)
│   └── plant-grid.js       → renderPlantGrid(plants, { variant })  (NEW — small wrapper)
│
├── widgets/                ← Stateful multi-component widgets
│   ├── garden-wizard.js    ← The 4-step wizard (extract from gardens.js)
│   └── location-picker.js  ← Geolocation + ZIP picker (move from location.js)
│
├── renderers/              ← Domain renderers (SVG / canvas)
│   ├── render2d.js         ← 2D top-down builder (move from web/render2d.js)
│   └── preview3d.js        ← Isometric wizard preview (move from web/preview3d.js)
│
├── views/                  ← One file per screen / route — thin, composes ui/ + widgets/
│   ├── auth-view.js        (rename from auth.js)
│   ├── gardens-list-view.js
│   ├── garden-builder-view.js
│   ├── shopping-view.js
│   ├── browser-view.js
│   ├── library-view.js
│   └── import-view.js
│
└── assets/
```

**Not proposing this refactor today** — it's documented as the target so a future contributor (or a follow-up audit-fix session) knows where the project is heading. The current pass produces only this document + `Docs/UI_AUDIT.md`. The fix sequence is in `Docs/UI_AUDIT.md` §9.

### 6.3 Immediate next steps in order of impact

1. **Introduce `ui/pp-modal.js`** with `.confirm` / `.alert` / `.show` / `.dismiss`, migrate all 16 `confirm()` / `alert()` sites. The single biggest UX consistency win and unlocks the "Destructive actions are confirmed" contract from `.claude/rules/web-frontend.md`. (UI_AUDIT.md §9 PR 4 + PR 5.)
2. **Extract `ui/plant-card.js`** with `variant: "shopping" | "browser" | "library"`. Collapses the three parallel Plant card renderers. The biggest visual-consistency win. (UI_AUDIT.md §9 PR 6.)
3. **Extract `ui/plant-detail-panel.js`** to collapse the three detail-panel shells to one host + one open function. (UI_AUDIT.md §9 PR 7.)
4. **Carve `gardens.js` (922 lines) into `widgets/garden-wizard.js` + `views/gardens-list-view.js`.** The largest single file in the codebase. (UI_AUDIT.md §9 PR 10.)
5. **Introduce `web/domain/`** so future contributors have an obvious home for per-object shape + helper code, and the `--pp-*` token system is matched by a domain-tokens system at the JS layer. (UI_AUDIT.md §9 PR 12.)

---

## 7. The visual continuity contract

Three rules that hold the experience together. Same three as `.claude/rules/ui-object-design.md` §3 — restated here so a contributor reading this doc alone has the full set, applied to plant-planner specifically.

### Rule 1 — Same object, same look

A Plant on the Shopping grid, the Plant Browser grid, the My Plants library grid, and inside a detail panel should all read as **the same kind of thing**.

> Today's state: **violated.** Three parallel implementations of the Plant card with three CSS class families. See UI_AUDIT.md §4a. Target: a single canonical `renderPlantCard(plant, { variant })`.

### Rule 2 — Same action, same affordance

Opening a Plant's detail panel is **always card-tap**. The heart button never means different things on different surfaces (it's always "shortlist for this planter" in the shopping flow; it's always "add to favorites/wishlist" in the browser). Adding to the library uses one consistent affordance per status: leaf for "current", heart for "wishlist".

> Today's state: respected. The two `confirm` paths for wizard-discard (`gardens.js:257, :806`) are not the same affordance — one is the kebab close, one is the back-button cancel — but they confirm the same destructive operation.

### Rule 3 — Destructive actions are confirmed through the project's shared modal

Per `.claude/rules/web-frontend.md`, every destructive action goes through a project confirm modal — not browser `confirm()` or `alert()`.

> Today's state: **violated.** 16 sites use `confirm()` / `alert()` (6 confirms — 3 destructive, 3 data-loss-adjacent — plus 10 alerts). No project modal exists. This is the largest single rule violation in plant-planner. See UI_AUDIT.md §5.

Once UI_AUDIT.md §9 PR 4 + PR 5 land, this rule will be honored.

---

## 8. Conventions

This doc is intentionally plant-planner-specific. For the cross-project conventions it builds on, read the rules directly:

- `.claude/rules/ui-object-design.md` — the canonical OOD rule (object → component → variant opts).
- `.claude/rules/web-frontend.md` — vanilla-JS conventions, accessibility (≥44px tap targets), motion (`fadeUp` + `--i` stagger), destructive-action contract.
- `.claude/rules/auth-ui.md` — auth modal visual standard. Plant-planner's `auth.js` already matches this (see UI_AUDIT.md §8.1).
- `.claude/rules/typed-js.md` — JSDoc `@typedef` + `// @ts-check`. Plant-planner does not have a `web/types.d.ts` today; UI_AUDIT.md §9 PR 12 optionally introduces one.
- `.claude/rules/assets.md` — asset directory + naming. Plant-planner is already compliant (`web/assets/brand/pp-logo.svg`, etc.).
- `.claude/rules/performance-caching.md` — caching architecture. Plant-planner does not use `cache.js` today; out of scope for this audit.

---

## 9. File map

The current layout (flat) and the target layout (structured) — for use as a reference when navigating the codebase.

### Current

```
projects/plant-planner/web/
├── index.html              (61 lines)
├── styles.css              (2,558 lines)
├── config.js, state.js, theme.js
├── helpers.js              (644 lines — shared renderers + render dispatcher + nav)
├── auth.js                 (252 lines — Supabase + canonical OAuth modal)
├── init.js                 (21 lines — boot)
├── garden-units.js         (61 lines — canonical units helper)
│
├── gardens.js              (922 lines — list + wizard)
├── shopping.js             (515 lines)
├── library.js              (464 lines)
├── browser.js              (568 lines)
├── import.js               (199 lines)
├── garden.js               (291 lines — builder shell)
├── location.js             (270 lines — zone picker)
├── render2d.js             (339 lines — 2D top-down)
├── preview3d.js            (328 lines — isometric wizard preview)
│
└── assets/
    ├── brand/pp-logo.svg
    ├── illustrations/
    └── sprites/plants/
```

### Target (per §6.2)

See §6.2 above for the structured `domain/` + `ui/` + `widgets/` + `renderers/` + `views/` layout.

`Docs/` next to this file holds the audit (`UI_AUDIT.md`) — the structural pair to this architecture doc.

---

## 10. Status snapshot — what's "present" vs "missing"

The honest scorecard. Future passes update this table as each canonical component lands.

| Component | Status | File | Notes |
| --- | --- | --- | --- |
| Auth modal | ✅ Present | `auth.js:97` | Fully canonical per `.claude/rules/auth-ui.md`. Do not rewrite. |
| Design tokens | ✅ Present | `styles.css:6–14` | `--pp-*` block + DaisyUI semantic tokens. One missing: `--pp-danger` (lands in PR 4). |
| Filter chips | ✅ Present | `helpers.js:212` | Shared on 3 surfaces. Rename → `renderFilterChips` in PR 2. |
| Plant-info bullets | ✅ Present | `helpers.js:262–525` | Shared body of all detail panels. |
| Fill-progress runner | ✅ Present | `helpers.js:533–605` | Shared on 2 surfaces. |
| Plant card | ❌ Missing (3 duplicates) | `shopping.js:222`, `browser.js:249`, `library.js:114` | Target: `ui/plant-card.js` (PR 6). |
| Plant detail panel | ⚠️ Half-present | `shopping.js:364`, `browser.js:497`, `library.js:239` | Body shared via `_plant*` helpers; shell duplicated 3×. Target: `ui/plant-detail-panel.js` (PR 7). |
| Plant grid wrapper | ❌ Missing | n/a | Target: `ui/plant-grid.js` (PR 8). |
| Project modal | ❌ Missing | n/a | 16 native dialog sites. Target: `ui/pp-modal.js` (PR 4 + PR 5). |
| Garden card | ✅ Present (one surface) | `gardens.js` | No fragmentation yet — only My-Gardens list renders Gardens as cards. |
| Placement renderer | ✅ Present (one surface) | `render2d.js` | Only the builder shows Placements. |
| User badge | n/a | `auth.js` | Only the navbar shows the user identity. No cross-surface need today. |
| `domain/` directory | ❌ Missing | n/a | Target: `domain/plant.js` + `domain/garden.js` + `domain/placement.js` (PR 12). |
| `ui/` directory | ❌ Missing | n/a | Target: 7 files (PRs 3, 4, 6, 7, 8). |
| `widgets/` directory | ❌ Missing | n/a | Target: `garden-wizard.js` + `location-picker.js` (PR 10). |
| `renderers/` directory | ❌ Missing | n/a | Target: `render2d.js` + `preview3d.js` (PR 11). |
| `views/` directory | ❌ Missing | n/a | Target: 7 files (PR 11). |

Future audit-fix passes flip rows to ✅ and add a "Pass N (date)" annotation in the Notes column.
