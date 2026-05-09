# PlantPlanner — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-05-09 (Phase-2 plant-first refactor: legacy DB cutover)

## What This App Does

PlantPlanner is a planter-design tool focused on plant selection. Creating a planter walks the user through a **7-step wizard** (`gardens.js → renderGardenWizard*`) that captures every constraint we feed to the catalog API: type, size, light, location → USDA zone, water plan, planting season. Step 1 presents seven planter types in two columns (Indoor: pot · planter box · greenhouse; Outdoor: pot · planter box · garden bed · raised bed). After confirming, the user lands in a **plant shopping step** (`shopping.js → openShoppingForGarden`): a Pinterest-style grid of plants matching those conditions, sourced from `plantplanner_plant_cache` (Trefle/Perenual-backed). The user hearts the plants they want; the shortlist persists on the garden. Continuing to placement opens a **2D top-down builder** (`render2d.js`) whose sidebar shows only the shortlisted plants, draggable onto the soil. Both the wizard preview and the builder render fill the available viewport width. Users sign in with Google, Apple, or email/password (Supabase Auth) to save multiple planters.

**Storage invariant for grid dimensions:** `grid_width` / `grid_height` are stored as inches when `garden_type` is one of `indoor_pot`, `indoor_planter_box`, `outdoor_pot`, `outdoor_planter_box`; in feet for `greenhouse`, `garden_bed`, `raised_bed`. Placement coordinates (`pos_x`, `pos_y`, `radius_feet`) are always feet — the backend converts grid dims to feet before bounds-checking. The single-source-of-truth helpers live in `shared-backend/routes/plant_planner/garden_units.py` (mirrored in `web/garden-units.js`).

The legacy seed-table catalog (`plantplanner_plants`) and its render templates have been retired from the user-facing flow — every browse, filter, and placement now reads from the cache. Companion-planting warnings, bloom-calendar strip, year-scrubber, and shading overlays were dropped in the Phase-2 cutover (they depended on legacy fields); they will be re-introduced once equivalent data is available for cache plants.

## Current Status
- Stage: Prototype
- Web prototype: in development
- Backend: in development
- Native app: not started

## Tech Stack
| Layer | Technology | Notes |
|---|---|---|
| Web frontend | Vanilla HTML/CSS/JS + Pico.css | No build step, deployed to Vercel |
| Backend | Python FastAPI (shared service) | Routes at `/api/v1/plant_planner/...` |
| Database | Supabase (shared project) | Tables prefixed `plantplanner_` |
| Native app | React Native / Expo | Not started |
| Auth | Supabase Auth | Google + Apple OAuth + email/password; backend verifies JWT via shared `jwt_auth.py` |
| Storage | Supabase Storage | Not used |

## Directory Layout
```
projects/plant-planner/
├── web/              — Static HTML prototype (loaded by index.html)
│   ├── config.js        — Sets window.APP_CONFIG.apiBase
│   ├── state.js         — Global state variables
│   ├── theme.js         — Theme registry
│   ├── helpers.js       — apiFetch, nav helpers, logout, view dispatcher
│   ├── garden-units.js  — Per-garden_type unit semantics (inches vs feet)
│   ├── auth.js          — Supabase Auth screen
│   ├── gardens.js       — My-Gardens list + 7-step New-Garden wizard
│   ├── location.js      — Geolocation + ZIP picker modal
│   ├── render2d.js      — SVG-based 2D top-down planter renderer
│   ├── shopping.js      — Plant-shopping step + builder shortlist sidebar
│   ├── garden.js        — Builder shell — wires renderer, sidebar, save/reseed
│   ├── init.js          — DOMContentLoaded, initSupabase, event listeners
│   ├── styles.css       — App-specific styles
│   └── build.sh         — Generates config.js at deploy
└── STRUCTURE.md         — this file

shared-backend/routes/plant_planner/  — FastAPI route package
  ├── api_clients.py     — Trefle/Perenual fetchers + record normalization
  ├── image_mirror.py    — Supabase Storage upload helper (3 sizes)
  ├── catalog_routes.py  — /catalog/search + /catalog/{id} (cache-first)
  ├── garden_routes.py   — Garden CRUD + cache-only placement save
  ├── garden_units.py    — Per-garden_type unit semantics (mirrors web/garden-units.js)
  ├── auth_routes.py     — /auth/me
  ├── location_routes.py — ZIP/geolocation → USDA zone
  ├── models.py          — Pydantic request/response models
  ├── dependencies.py    — Supabase Auth → CurrentUser
  ├── constants.py       — Enums for garden_type / shade / season / water
  └── data/              — Static lookup tables (e.g. zip3_to_zone.json)

db/migrations/plantplanner/001_baseline.sql … 012_planter_types_redesign.sql
```

## Data Model

- **plantplanner_profiles** — id (uuid PK, = `auth.users.id` ON DELETE CASCADE), display_name (text), avatar_url (text, nullable), is_admin (bool default false), created_at (timestamptz default now())
- **plantplanner_renders** — key (text PK), label (text), params (jsonb — 3D geometry), colors (jsonb — color map), created_at (timestamptz default now())
- **plantplanner_plants** — id (uuid PK default gen_random_uuid()), name (text), height_inches (int), sunlight (text: full_sun/partial/shade), bloom_season (text[]), spread_inches (int), description (text), sort_order (int), category (text), render_key (text FK→renders), bloom_months (int[] 1–12), native (bool), usda_zones (jsonb `{min:int, max:int}`), pollinator_attracts (text[] subset of `bees`/`butterflies`/`hummingbirds`/`moths`/`beneficial_insects`), water_need (text: low/medium/high), care_summary (text, nullable)
- **plantplanner_gardens** — id (uuid PK default gen_random_uuid()), user_id (uuid FK→profiles ON DELETE CASCADE), name (text), grid_width (int — feet for outdoor types, inches diameter for indoor), grid_height (int — feet for outdoor types, inches depth for indoor), garden_type (text CHECK in `indoor`/`outdoor`/`garden_bed`/`raised_bed`/`greenhouse` — captured in wizard step 1), shade_level (text — captured in wizard step 3), planting_season (text), water_plan (text CHECK in `regular`/`occasional`/`rain_only` — captured in wizard step 5), usda_zone (text, nullable — captured in wizard step 4 for outdoor types; e.g. `"6b"`), location_label (text, nullable — display label such as `"02139, MA · Zone 6b"`), settings_json (jsonb default `{}` — per-garden client preferences such as `dismissed_companion_warnings: ["<minId>:<maxId>", ...]`), shortlist_plant_cache_ids (uuid[] default `'{}'` — the user's plant-shopping shortlist, references `plantplanner_plant_cache.id`), created_at (timestamptz default now()), updated_at (timestamptz default now())
- **plantplanner_garden_plants** — id (uuid PK), garden_id (uuid FK→gardens ON DELETE CASCADE), plant_id (uuid FK→plants, **nullable**), plant_cache_id (uuid FK→plant_cache, **nullable**), pos_x/pos_y (real, feet), radius_feet (real). CHECK constraint requires exactly one of plant_id / plant_cache_id to be set. Phase-1 placements use plant_cache_id; legacy seed-table placements use plant_id.
- **plantplanner_companions** — id (uuid PK default gen_random_uuid()), plant_a_id (uuid FK→plants, with `a < b` ordering), plant_b_id (uuid FK→plants), relationship (text: `good`/`bad`/`neutral`), reason (text). Indexed on both `plant_a_id` and `plant_b_id`.
- **plantplanner_plant_cache** — Phase-1 API-backed catalog. id (uuid PK), source (`trefle`/`perenual`/`merged`), source_id (text), scientific_name (text UNIQUE), common_name (text), family (text), emoji (text), hardiness_min/max (int — USDA zone), sunlight (`full_sun`/`part_shade`/`full_shade`), watering (`frequent`/`average`/`minimum`/`none`), cycle (`annual`/`perennial`/`biennial`), indoor (bool), height_min_cm/height_max_cm (int), spread_cm (int), days_to_harvest (int), edible (bool), vegetable (bool), toxicity (text), growth_rate (text), ph_min/ph_max (real), sowing (text), nitrogen_fixation (bool), tags (text[]). **Three image sizes** mirrored to Supabase Storage: image_thumbnail_url/path, image_medium_url/path, image_regular_url/path — all nullable, populated as available from each API source. raw_trefle_json + raw_perenual_json keep the source payloads for forward compat. last_synced_at + last_image_synced_at timestamps.

## API Endpoints

- `GET  /api/v1/plant_planner/health` — Health check
- `GET  /api/v1/plant_planner/auth/me` — Get current user (auth required; auto-creates profile row on first call)
- `GET  /api/v1/plant_planner/catalog/search` — Cache-first plant search. Accepts every wizard input as a query param: `shade_level`, `water_plan`, `usda_zone`, `planting_season`, `garden_type`, `grid_width`, `grid_height` plus optional overrides `query`, `edible`, `indoor`, `cycle`, `max_height_cm`, `max_spread_cm`, `planter_size`. The route maps `garden_type + grid_*` to a small/medium/large bucket and applies height/spread caps so a 12-inch pot never returns 10-foot tomatoes. Returns cached `plantplanner_plant_cache` rows; if hits < threshold, lazy-fills from Trefle (criteria) + Perenual (hardiness) and persists.
- `GET  /api/v1/plant_planner/catalog/{cache_id}` — Single cached plant; lazy-enriches missing hardiness via Perenual on first call.
- `GET  /api/v1/plant_planner/gardens` — List user's gardens (auth required)
- `POST /api/v1/plant_planner/gardens` — Create new garden (auth required; accepts the wizard's full conditions payload: `garden_type`, `shade_level`, `water_plan`, plus optional `usda_zone` + `location_label`)
- `GET  /api/v1/plant_planner/gardens/{id}` — Get garden with placed plants + `settings_json` (auth required)
- `PUT  /api/v1/plant_planner/gardens/{id}` — Update any garden field (`garden_type`, `shade_level`, `water_plan`, `usda_zone`, `location_label`, `settings_json`, etc.); auth required
- `POST /api/v1/plant_planner/location/lookup` — Resolve `{zip}` or `{lat, lng}` to `{zone, zone_number, label, source}` for the wizard's location step. Backed by `routes/plant_planner/data/zip3_to_zone.json` (~90 ZIP3-prefix entries, replaceable with the full USDA dataset later).
- `DELETE /api/v1/plant_planner/gardens/{id}` — Delete garden (auth required)
- `PUT  /api/v1/plant_planner/gardens/{id}/plants` — Save all plant placements (auth required, full replace)
- `GET  /api/v1/plant_planner/companions` — List companion-planting relationships `[{plant_a_id, plant_b_id, relationship, reason}]` (symmetric pairs; client stores both directions)

## Screen / Page Flow

```
Auth View (login/register)
    ↓ (on login)
My Gardens View (list saved gardens, "+ New Garden")
    ↓ ("+ New Garden")
New-Garden Wizard (state.js → currentView === "wizard")
  Step 1 — Planter type           (indoor/outdoor/garden_bed/raised_bed/greenhouse)
  Step 2 — Size + name            (preset 4×4/4×8/8×8/custom in ft, or pot ⌀×depth in inches for indoor)
  Step 3 — Light                  (full_sun/partial/shade)
  Step 4 — Location → zone        (geolocation + ZIP fallback + manual; SKIPPED for indoor/greenhouse)
  Step 5 — Water plan             (regular/occasional/rain_only)
  Step 6 — Planting season        (spring/summer/fall/winter — maps to plant cycle filter)
  Step 7 — Review & confirm       (read-only summary; live `/catalog/search` count)
    ↓ (on Confirm — POST /gardens)
Plant Shopping View (currentView === "shopping")
  ├── Header: planter name + condition chips (sunlight, water, zone, type)
  ├── Search input (queries common_name + scientific_name)
  ├── Pinterest-style grid of cache plants matching the planter's conditions
  │     ↳ Image / name / scientific / quick bullets (sun, water, cycle, zone, edible)
  │     ↳ Heart button → toggles shortlist (saved on Continue)
  │     ↳ Card tap → slide-in detail panel (full bullets + sowing notes)
  └── Footer: shortlist count + "Continue to placement" → PUT /gardens/{id} (shortlist) → opens builder
    ↓
Garden Builder View
  ├── Toolbar Row 1 (garden name + size · kebab menu)
  ├── Toolbar Row 2 (read-only conditions strip)
  ├── Sidebar — shortlist tiles (drag → place, "Add more" reopens shopping)
  ├── 2D Render (SVG top-down via render2d.js — soil rect, grid lines, plant disks)
  │     ↳ Drag from sidebar → preview disk + drop to commit
  │     ↳ Tap placed plant disk → remove
  └── Save button
```

## Key Business Logic

- Grid is always measured in square feet. Preset sizes: 4x4, 4x8, 8x8. Custom allows any width×height.
- Catalog filtering uses one search input + a single horizontally-scrolling chip row (replaces the legacy 3 stacked dropdowns). Chips combine AND across categories, OR within a category. The `Native` chip additionally restricts to plants whose `usda_zones` range covers the garden's `usda_zone` (when set).
- Drag and drop: pick plant from catalog sidebar, drop onto grid cell. Multiple plants can't occupy same cell. Click (movement < 5px AND mouseup within 300ms) opens the Plant Detail Panel instead of starting a drag.
- Side view: renders plants as vertical bars proportional to their height_inches.
- Garden save: sends full grid state (all plant placements) to the API in one PUT.
- Plant catalog is loaded from DB once on page load and cached in JS state.

### Bloom Calendar Strip (Iteration 4)

- A persistent full-width `<section id="bloom-calendar-strip">` sits directly under the 3D pane in the builder. It renders a 12-column Jan–Dec grid showing every placed plant's bloom timeline at a glance — the wildflower-gardener's #1 unmet need.
- The aggregate header row (always visible) shows a chevron toggle, the title "Bloom Calendar", a count chip ("3 plants · 7 mo"), and 12 month cells whose green opacity scales with `count_blooming_that_month / max_count_any_month` — the more plants blooming in a month, the bolder its cell.
- The body (collapsible; default open on desktop, collapsed on mobile <600px) lists one row per *unique* placed plant — duplicate placements collapse into "Plant Name ×N". Each row shows a thumbnail, the name, and 12 dot cells filled where `bloom_months.includes(monthNum)`. Plants with empty `bloom_months` are omitted; if all placed plants lack bloom data, the body shows a hint to try a flowering plant.
- Re-rendered (`renderBloomCalendar()`) from the same hook sites as `sync3DView()` / `renderCompanionChips()` / `refreshCatalogList()`: drag-drop placement, click-to-remove, reseed, and initial scene load. Drag-to-move is intentionally not hooked because placement *contents* don't change on move.
- Mobile: horizontally scrollable strip with a sticky left plant-name column; default collapsed.

### Companion Warnings (Iteration 2)

- After every placement, removal, and garden load, the client recomputes companion-planting warnings from `placements` + the cached `/companions` lookup. Two placements are considered adjacent when their disk centers are within `r_a + r_b + 0.5 ft`. Adjacent pairs with a `good` or `bad` relationship surface a small floating chip on the 3D scene above the placement:
  - **Yellow `alert-triangle` chip** — placement has at least one undismissed `bad` neighbor or undismissed `crowd` neighbor.
  - **Green `sparkles` chip** — placement has a `good` neighbor and no warnings.
  - **Crowded** — fires when two disks overlap by more than 6 inches (i.e. center distance < `r_a + r_b - 0.5 ft`). The popover row offers an "It's fine, dismiss" button stored as `crowd:<placementA>:<placementB>` in `dismissedCompanionWarnings`.
- Tapping a chip opens a popover anchored to it, listing each conflicting/helpful neighbor (thumbnail + name + relationship pill + reason). `Bad` companion rows offer a "Dismiss for this garden" button that adds `companion:<minPlantId>:<maxPlantId>` to `dismissedCompanionWarnings`. Companion dismissals now use the `companion:` prefix; legacy unprefixed `<minId>:<maxId>` entries are still treated as `companion:` matches for backward compatibility. Esc / outside-click / close button dismiss the popover.
- Dismissals persist in `gardens.settings_json.dismissed_companion_warnings` (PUT'd to `/gardens/{id}` whenever the user saves). Failure to persist is non-fatal (logged + continue).
- Catalog tile badges: tiny green-leaf badge (top-left, ~12px) when the tile's plant is a good companion of any placed plant; tiny red dot when it's a bad companion. Sidebar height is unchanged — badges sit on top of the existing tile.
- Plant detail panel "Companions" section appears under Pollinators with two horizontal mini-rows ("Grows well with" up to 6 chips, "Avoid planting near" up to 6). Each chip swaps the detail panel to that partner.
- Placement is never blocked. UI is fail-soft: if `/companions` fetch fails, no chips are drawn, the Companions section is hidden, and placement still works.

## Environment Variables
| Variable | Used In | Purpose |
|---|---|---|
| `SUPABASE_URL` | shared-backend (Railway) | Supabase project URL — also used by `jwt_auth.py` to fetch the JWKS for Supabase token verification |
| `SUPABASE_SERVICE_ROLE_KEY` | shared-backend (Railway) | Server-side DB access (bypasses RLS) |
| `TREFLE_API_TOKEN` | shared-backend (Railway) | Free-tier plant API; primary source for the cache lazy-fill |
| `PERENUAL_API_KEY` | shared-backend (Railway) | Freemium fallback for hardiness zones + sunlight/watering |
| `VIBELAB_SUPABASE_URL` | GitHub Actions secret | Injected into `web/config.js` at deploy time by `build.sh` |
| `VIBELAB_SUPABASE_ANON_KEY` | GitHub Actions secret | Public anon key used by the Supabase JS client in the browser |

## Active Development Notes

- 2026-03-17 — Project scaffolded. Building web prototype + backend.
- 2026-05-08 — Iteration 1 (agentic): compressed catalog + rich plant knowledge — see ITERATIONS.md. Added `bloom_months`, `native`, `usda_zones`, `pollinator_attracts`, `water_need`, `care_summary` to `plantplanner_plants`; added `usda_zone` to `plantplanner_gardens`. Catalog sidebar header switched from 3 stacked dropdowns to one search input + horizontally-scrolling chip row. Plant tiles now show a native badge + pollinator icons. Tile click opens a slide-in Plant Detail Panel. Garden header gets a USDA-zone chip → picker, persisted via PUT /gardens/{id}.
- 2026-05-08 — Switched auth from custom bcrypt + JWT to Supabase Auth (Google + Apple OAuth + email/password). Migration `db/migrations/plantplanner/003_supabase_auth.sql` drops `plantplanner_users` and recreates `plantplanner_gardens` / `plantplanner_garden_plants` keyed off `plantplanner_profiles(id) = auth.users.id`. Backend uses shared `jwt_auth.get_current_supabase_user`; profile rows are auto-created on first sign-in. `PLANTPLANNER_JWT_SECRET` env var is no longer used. **One-time setup before deploying:** enable Google + Apple providers in Supabase dashboard, add `https://vibelab-plant-planner.vercel.app` + `/**` to Authentication → URL Configuration → Redirect URLs, run the 003 migration in SQL Editor.
- 2026-05-08 — Iteration 2 (agentic): companion-planting warnings — see ITERATIONS.md. New `plantplanner_companions` table + `GET /companions`. `plantplanner_gardens` gains `settings_json jsonb` for per-garden `dismissed_companion_warnings`. UI: floating yellow/green chips on 3D cells, tap-to-popover with dismiss-for-this-garden, catalog tile good/bad badges, detail-panel Companions section.
- 2026-05-08 — Iteration 3 (agentic): real-radius placement — see ITERATIONS.md. Migration `008_real_radius_placement` drops grid_x/grid_y unique-cell model and recreates `plantplanner_garden_plants` with `(pos_x, pos_y, radius_feet)` floats; existing rows are disposable. Drag-from-catalog now drops anywhere on the soil with a green/amber/red spread-disk preview; placed plants render permanent translucent disks. Companion adjacency switched to disk-distance overlap; new yellow 'crowded' chip fires on >6" disk overlap.
- 2026-05-08 — Iteration 4 (agentic): garden-wide bloom calendar strip — see ITERATIONS.md. New `<section id="bloom-calendar-strip">` below the 3D pane shows aggregate Jan–Dec intensity + per-plant dot rows, reactive to placement changes. No backend or schema work — `bloom_months` data was already in place since iter 1.
- 2026-05-08 — Iteration 5 (agentic): year 1/2/3 growth preview — see ITERATIONS.md. New `lifecycle` (annual|biennial|perennial) and `years_to_maturity` (1–5) columns on plantplanner_plants, seeded for all ~40 catalog rows. Year scrubber pills in the 3D pane header rescale every placed plant's disk + mesh per its lifecycle. Annuals stay full-size every year; perennials ramp from 0.4× at year 1 to 1.0× at maturity. Companion adjacency + crowded chips re-evaluate at the selected year. Placement saves are unchanged — preview is view-only.
- 2026-05-08 — Iteration 6 (agentic): height-aware shading warnings — see ITERATIONS.md. New `shading.js` computes shadow zones using existing `height_inches` + `sunlight` columns (no schema changes). Tall plants cast a translucent ground-shadow disk on the soil to their south (+y is treated as north; northern-hemisphere default). A warning chip + "Shaded" popover row fire when a `full_sun` plant is being shaded by a ≥1.2×-taller neighbor. Year-aware via `yearScale`. Reuses iter 2's chip + popover infrastructure under the unified warning-precedence rule (warning > good).

- 2026-05-08 — **Conditions-wizard redesign.** Replaced the cramped builder toolbar (everything-in-one-row + tiny chip bar of mixed-axis filters) with an explicit conditions model: every garden now persists `garden_type` (5 values), `shade_level`, `water_plan`, `usda_zone`, `location_label`. Migration `010_garden_conditions.sql` adds the new columns + a CHECK on `garden_type` and migrates legacy `'planter'` → `'indoor'`. New 6-step New-Garden wizard (`gardens.js`) collects type → size → light → location → water → review, ending on a read-only summary with a live "X of Y plants match" preview; nothing is saved until the user confirms. Builder toolbar simplified to a 2-row layout (title + size + kebab; conditions strip below). Catalog filter UI replaced flat 10-chip row with a "Match my garden" toggle (default ON, auto-filters by lighting/water/hardiness/planter-type) plus refinement rows (bloom season, type) and toggle chips (Native, Pollinators). Catalog tiles now load PNG sprites directly (`assets/sprites/plants/<slug>.png`, fallback to `_<category>.png`) instead of relying on the slow Three.js thumbnail renderer. Native filter still uses USDA-zone overlap as a directional proxy; ecoregion-aware `native_regions[]` is a follow-up.

- 2026-05-09 — **Phase-1 plant-first refactor.** Refocused the tool around plant selection. (1) New `plantplanner_plant_cache` table is the source of truth for all browsing — populated lazily from Trefle (free) with Perenual (freemium) fallback for hardiness zones. Image URLs from each API are mirrored into Supabase Storage in three sizes (thumbnail / medium / regular) and served from there, so the UI never round-trips to third-party CDNs at read time. Migration `011_plant_cache_and_shortlist.sql` adds the cache table, a `shortlist_plant_cache_ids` array on `plantplanner_gardens`, and a nullable `plant_cache_id` on `plantplanner_garden_plants` (XOR with the legacy `plant_id`). (2) New backend routes `GET /catalog/search` and `GET /catalog/{cache_id}` are cache-first; misses trigger a Trefle search (+ Perenual hardiness merge), upsert into the cache, and mirror images. (3) New shopping step (`web/shopping.js → openShoppingForGarden`) lands the user after wizard confirmation in a Pinterest-style grid of cache plants matching the wizard's conditions; the user hearts plants to shortlist, which persists on the garden. (4) The 3D Three.js render is hidden in this iteration — the builder uses an SVG-based 2D top-down renderer (`web/render2d.js`). (5) Builder sidebar switched from the seed-table catalog to a shortlist panel for any garden with a populated shortlist; legacy gardens still saw the old catalog at this point.

- 2026-05-09 — **Phase-2 cutover: legacy DB integration removed.** All user-facing reads go through `plantplanner_plant_cache`. Backend deletes: `GET /plants` and `GET /companions` routes (and their files). Backend simplifies: `GET /gardens/{id}` no longer joins `plantplanner_plants` / `plantplanner_renders`; `PUT /gardens/{id}/plants` accepts only `plant_cache_id` (XOR + the legacy `plant_id` field on `PlantPlacement` are gone). Frontend deletes from the bundle: `catalog.js`, `plant-data.js`, `companions.js`, `shading.js`, `bloom-calendar.js`. Builder simplifies to a single shortlist sidebar (no fallback catalog branch). Wizard gains step 5 — **Planting season** — and moves Review to step 6/7 (with the location-skip rule preserved). The wizard's review-step "X of Y plants match" preview now hits `/catalog/search` live instead of running `plantMatchesFilters` against the seed pool. `/catalog/search` gains four new query params — `planting_season` (mapped to plant `cycle`), `garden_type` + `grid_width` + `grid_height` (combined into a small/medium/large bucket that drives `max_height_cm` and `max_spread_cm` caps so small pots don't return tree-sized plants), plus `planter_size` as an explicit override. Companion-warning chips, bloom calendar, year scrubber, and shading overlays are gone for now — they were seed-coupled and will be re-introduced in Phase 3 once equivalent data sources exist for cache plants. Tables `plantplanner_plants`, `plantplanner_companions`, and `plantplanner_renders` are still in the database but unused; a future `*_drop_legacy_plant_tables.sql` will retire them once production gardens are confirmed clear.

- 2026-05-09 — **Step-one redesign: 7 planter types + units fix.** Migration `012_planter_types_redesign.sql` expands `garden_type` from 5 to 7 values (`indoor_pot`, `indoor_planter_box`, `greenhouse`, `outdoor_pot`, `outdoor_planter_box`, `garden_bed`, `raised_bed`); existing `'indoor'` rows migrate to `'indoor_pot'`, `'outdoor'` to `'outdoor_pot'`. Wizard step 1 redesigns to a two-column picker (Indoor | Outdoor). New shared helper modules — `shared-backend/routes/plant_planner/garden_units.py` and `web/garden-units.js` — codify the storage invariant (pots and planter boxes store inches in grid_width/grid_height; greenhouse + beds store feet; placements always feet). The 2D top-down renderer (`render2d.js`) and `garden_routes.save_garden_plants` bounds check now normalize grid dims to feet via `gridDimToFeet` / `grid_dim_to_feet`, fixing a silent bug where indoor pots rendered as 12-foot soil patches and accepted out-of-bounds placements. Both the wizard-step-1 preview and the builder's render2d pane now span full content width (preview stacked below the size controls; builder collapses sidebar above the render at <900px). All 11 Phase-2-retired web/*.js files (`render3d.js`, `plant-data.js`, `plant-drag.js`, `touch-drag.js`, `plant-models.js`, `plant-sprites.js`, `plant-thumbnails.js`, `companions.js`, `shading.js`, `bloom-calendar.js`, `catalog.js`) are deleted from disk in this commit.

### Coordinate convention

The bed grid runs along x (`grid_width`) and y (`grid_height`) in feet. **+y = north** is a project-wide invariant (used by iter 6's shading model so solar-noon shadows fall in the −y / south direction). For southern-hemisphere support, flip the sign in `shadowZoneFor()` (see top-of-file comment in `web/shading.js`).

### Open follow-ups

- **Ecoregion-aware Native filter.** Today `plantplanner_plants.native` is a single boolean and the Native filter combines it with USDA-zone overlap. To filter "what's native to MY ecoregion" properly, add a `native_regions text[]` column (e.g. `['eastern_woodlands', 'midwest']`) and a lat/lng → ecoregion lookup.
- **ZIP3 lookup table size.** `routes/plant_planner/data/zip3_to_zone.json` currently ships ~90 representative ZIP3 prefixes. Replace with the full ~1000-entry USDA dataset for production accuracy. `_load_table()` already filters non-ZIP keys (`_comment`).
- **Reverse-geocoding labels.** `LocationLookupResponse.label` is currently `"<state> · Zone X"`; integrating a real reverse-geocoder would yield a city name.
