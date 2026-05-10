# SauceBoss — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-05-01

## What This App Does
SauceBoss is a recipe companion for sauces, dressings, and marinades. The app has three tabs:

- **Sauces tab**: Pick a carb (pasta, rice, noodles, bread, potatoes, couscous) → browse sauce recipes with step-by-step pie-chart breakdowns.
- **Dressings tab**: Pick a salad base (romaine, spinach, arugula, mixed greens, kale, cucumber-tomato, shaved beet, quinoa, farro) → browse matching salad dressings.
- **Marinades tab**: Pick a protein (chicken, beef, tofu, fish) → browse marinades optimized for that protein.

All paths share the same recipe experience: step-by-step cooking cards with pie charts, a serving scaler (1-12 people), unit toggle (Imperial ↔ Metric), and an ingredient filter panel. The app was originally a React Native app with a local SQLite database; the retrofit moves the data to Supabase and adds a web prototype.

## Current Status
- Stage: Retrofit (migrating from local SQLite to Supabase + FastAPI)
- Web prototype: not deployed (was localhost-only HtmlPrototype)
- Backend: not deployed (new, needs Railway setup)
- Native app: exists but uses SQLite — needs API client retrofit

## Tech Stack
| Layer | Technology | Notes |
|---|---|---|
| Web frontend | Vanilla HTML/CSS/JS + Pico.css | `projects/sauceboss/web/` |
| Backend | Python FastAPI (shared service) | `shared-backend/routes/sauceboss.py` |
| Database | Supabase (shared project) | Tables prefixed `sauceboss_` |
| Native app | React Native 0.74 / Expo 51 | `projects/sauceboss/app/` |
| Auth | Supabase Auth (email + Google + Apple) | Optional — app is read-only without sign-in. Signed-in users can add sauces / ingredients, mark favorites, edit their own sauces. Admins (single-time `ADMIN_API_KEY` claim) can edit anything. |
| Storage | None | Not required |

## Directory Layout
```
projects/sauceboss/
├── STRUCTURE.md          — this file
├── .env.example
├── web/                  — static HTML prototype (formerly HtmlPrototype/)
│   ├── index.html
│   ├── styles.css
│   ├── app.js            — NEEDS UPDATE: replace SAUCE_DATA with fetch()
│   ├── config.js         — TO CREATE: window.APP_CONFIG.apiBase
│   └── saucedata.js      — TO REMOVE after backend is live
├── app/                  — React Native / Expo (formerly App/)
│   ├── App.js            — NEEDS UPDATE: remove SQLiteProvider, add API client
│   ├── app.json
│   ├── package.json
│   └── src/
│       ├── api/
│       │   └── client.js — TO CREATE: fetch wrappers to shared backend
│       ├── data/
│       │   ├── carbs.js      — source data (used for seed script)
│       │   ├── sauces.js     — source data (used for seed script)
│       │   └── database.js   — TO REMOVE after API client is live
│       ├── screens/
│       │   ├── CarbSelectorScreen.js
│       │   ├── SauceSelectorScreen.js
│       │   └── RecipeScreen.js
│       ├── components/
│       └── theme.js
├── scripts/
│   └── generate_seed_sql.js  — legacy seed generator (targets dropped tables; do not run against the consolidated DB)
├── Docs/
└── db/                   — legacy SQLite (reference only, not used in production)

shared-backend/routes/sauceboss.py  — FastAPI routes
db/migrations/sauceboss/001_baseline.sql  — schema, RLS, RPCs (consolidated 2026-05-01)
db/migrations/sauceboss/002_seed.sql      — units + ingredient categories + substitutions
```

## Data Model
All tables prefixed `sauceboss_` in the shared Supabase project. Renamed and consolidated by migration 013.

- **sauceboss_dish** — Dish hierarchy (carbs / proteins / salad bases). `dish_level='dish'` rows have `parent_id IS NULL`; `dish_level='subtype'` rows point at a dish (one level deep, enforced by `sauceboss_dish_level_check`). Columns: `id`, `category` ('carb'|'protein'|'salad'), `parent_id` (nullable FK→sauceboss_dish), `dish_level`, `name`, `emoji`, `description`, `sort_order`, `cook_time_minutes`, `instructions`, `water_ratio`, `portion_per_person`, `portion_unit`.
- **sauceboss_cuisine_info** — Cuisine display lookup. Columns: `cuisine` (PK), `cuisine_emoji`, `cuisine_image_url`. Auto-upserted by sauce writers; read by every sauce envelope to surface `cuisineEmoji`.
- **sauceboss_sauce** — All recipes (sauces, dressings, marinades, dips, full_recipes). Columns: `id`, `name`, `cuisine`, `color`, `description`, `source_url`, `sauce_type` (no DB CHECK; values governed by backend `SauceType` enum), `created_by`, `parent_sauce_id`, `created_at`. cuisine_emoji moved to sauceboss_cuisine_info post-013.
- **sauceboss_sauce_step** — Ordered cooking steps per recipe. Columns: `id` (bigserial), `sauce_id`, `step_order`, `title`, `instructions`, `input_from_step`, `estimated_time`.
- **sauceboss_sauce_step_ingredient** — Ingredients per step. Columns: `id`, `step_id`, `ingredient_id` (FK→sauceboss_ingredient), `unit_id` (FK→sauceboss_unit), `original_text`, `quantity`, `quantity_canonical_ml`, `quantity_canonical_g`. (was sauceboss_step_ingredients with food_id; renamed by migration 013.)
- **sauceboss_sauce_to_dish** — Sauce ↔ dish targeting. Columns: `sauce_id`, `target_kind` ('category'|'dish'|'subtype'), `target_value`. The `sauceboss_sauce_to_dish_check` trigger validates target alignment with sauce_type and rejects attachments on full_recipe sauces. (was sauceboss_sauce_attachments.)
- **sauceboss_unit** — Unit registry. One row per supported unit with `id`, `name`, `plural`, `abbreviation`, `dimension`, `ml_per_unit`, `g_per_unit`, `aliases`. The Python module `routes/sauceboss/units.py` mirrors this table — keep the two in sync.
- **sauceboss_ingredient** — Ingredient registry. Columns: `id`, `category` (was its own table; folded in by 013), `name`, `plural`, `name_normalized` (UNIQUE), `aliases`, `substitutions[]` (was its own table; folded in by 013), `created_at`. Auto-populated by `create_sauceboss_sauce` via `INSERT ... ON CONFLICT (name_normalized)`.
- **sauceboss_user_profiles** — Supabase-Auth-backed user profiles. Columns: `id` (UUID FK→auth.users), `display_name`, `avatar_url`, `is_admin`, `created_at`.
- **sauceboss_user_saucebook** — Per-user library (references). Columns: `user_id`, `sauce_id`, `added_at`.
- **sauceboss_user_pantry_missing** — Per-user negative pantry list. Columns: `user_id`, `ingredient_id`. A row means "user is OUT of this ingredient".
- `sauceboss_sauce.created_by` — UUID FK→auth.users, set when a user submits a sauce. Powers the owner-only edit gate.

**Removed by migration 013:** `sauceboss_sauce_items` (legacy junction; replaced by sauceboss_sauce_to_dish), `sauceboss_favorites` (superseded by saucebook), `sauceboss_ingredient_categories` (folded into ingredient.category), `sauceboss_ingredient_substitutions` (folded into ingredient.substitutions[]), and `sauceboss_sauce.cuisine_emoji` column (now sauceboss_cuisine_info.cuisine_emoji).

**RPCs** (current bodies in `db/migrations/sauceboss/013_table_rename_consolidation.sql`):
- `get_sauceboss_initial_load()` — `{ carbs, proteins, saladBases }` for the home screen (one round-trip).
- `get_sauceboss_item_load(p_item_id text)` — `{ item, variants, sauces, ingredients }` for any selection screen.
- `get_sauceboss_items_by_category(p_category text)` — Dish rows for one category, with sauce count + nested subtypes.
- `get_sauceboss_sauces_for_target(category, dishId, subtypeId)` — Resolver for the meal-builder; returns the union of sauces matching category / dish / subtype / parent-dish.
- `get_sauceboss_sauces_for_item(p_item_id text)` — Sauces linked to a dish/subtype. Emits `cuisineEmoji` (joined from sauceboss_cuisine_info), `attachments[]`, and ingredient rows with `ingredientId`.
- `get_sauceboss_variants_for_item(p_item_id text)` — Subtype rows under a dish.
- `get_sauceboss_ingredients_for_item(p_item_id text)` — Sorted unique ingredient names across linked sauces.
- `get_sauceboss_all_sauces[ _full ]()` — Sauce manager listings. compatibleItems is gone; read attachments directly.
- `get_sauceboss_saucebook(user)` / `get_sauceboss_browse(...)` / `get_sauceboss_browse_authors(q)` / `get_sauceboss_pantry_for_user(user)` / `set_sauceboss_pantry_missing(user, ingredient_ids[])`.
- `list_sauceboss_ingredients_with_usage()` / `merge_sauceboss_ingredients(keep, merge[])` / `delete_sauceboss_ingredient_safe(id)` — admin tooling for the Ingredient Manager.
- `create_sauceboss_sauce(p_data)` / `update_sauceboss_sauce(p_data)` / `fork_sauceboss_sauce(source, user, data)` — atomic write paths; auto-upsert sauceboss_cuisine_info from `cuisineEmoji` on save.

## API Endpoints
All served by `shared-backend/routes/sauceboss/` at prefix `/api/v1/sauceboss`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/v1/sauceboss/health` | None | Health check |
| GET | `/api/v1/sauceboss/initial-load` | None | Carbs, proteins, and salad bases for the home screen |
| GET | `/api/v1/sauceboss/items/{item_id}/load` | None | Variants, sauces, and ingredients for any item |
| GET | `/api/v1/sauceboss/sauces` | None | All sauces with steps + ingredients (sauce manager). |
| POST | `/api/v1/sauceboss/sauces` | JWT | Create a sauce. Stores `created_by = current user`. |
| PATCH | `/api/v1/sauceboss/sauces/{sauce_id}` | JWT (owner OR admin) | Atomic full replace of an existing sauce. |
| DELETE | `/api/v1/sauceboss/sauces/{sauce_id}` | JWT (owner OR admin) | Delete an owned sauce; admins may delete any. Cascades to steps, ingredients, and item links. |
| POST | `/api/v1/sauceboss/import` | None | Mealie-style URL → recipe parser. Body `{url}`; returns a draft (does not persist). |
| GET | `/api/v1/sauceboss/units` | None | Unit registry — id/name/plural/abbreviation/dimension/conversion factors. |
| GET | `/api/v1/sauceboss/ingredients` | None | Ingredient typeahead (`?q=`, `?limit=`) for the builder ingredient field. |
| GET | `/api/v1/sauceboss/ingredient-categories` | None | `{name: category}` map (reads sauceboss_ingredient.category). |
| GET | `/api/v1/sauceboss/substitutions` | None | `{name: [substitute_names]}` map (reads sauceboss_ingredient.substitutions[]). |
| GET | `/api/v1/sauceboss/profile` | JWT | Current user's profile (404 if missing). |
| POST | `/api/v1/sauceboss/profile` | JWT | Upsert `display_name` (auto-called on first login). |
| POST | `/api/v1/sauceboss/profile/become-admin` | JWT | Body `{admin_key}`. Compared to env `ADMIN_API_KEY`; sets `is_admin=true`. |
| DELETE | `/api/v1/sauceboss/profile` | JWT | Delete current user's profile. Cascades to saucebook + pantry; sauces' `created_by` becomes NULL. |
| GET / POST / DELETE | `/api/v1/sauceboss/saucebook[/{sauce_id}]` | JWT | List / add / remove the caller's saucebook entries. |
| GET | `/api/v1/sauceboss/pantry` | JWT | Pantry overview (every ingredient in saucebook + missing flags). |
| PUT | `/api/v1/sauceboss/pantry` | JWT | Replace `missingIngredientIds[]` in one round-trip. |
| GET | `/api/v1/sauceboss/browse` | Optional JWT | Paginated sauce listing with filters (q/cuisine/type/author). |
| GET | `/api/v1/sauceboss/authors` | Optional JWT | Author autocomplete for the Browse filter. |
| POST | `/api/v1/sauceboss/admin/ingredients` | JWT | Add an ingredient (any logged-in user). |
| * | `/api/v1/sauceboss/admin/*` | JWT + `is_admin` | Dish / sauce / ingredient management (rename, delete, merge). |
| GET | `/api/v1/sauceboss/sauces/{sauce_id}/export.json` | None | Download a single sauce as a versioned JSON envelope (`{version, exportedAt, sauce}`). Per-ingredient `originalText`/`ingredientId`/`unitId`/`canonicalMl`/`canonicalG` are stripped — they're rebuilt server-side on save. |
| GET | `/api/v1/sauceboss/sauces/{sauce_id}/export.md` | None | Download a single sauce as a human-readable Markdown document (one-way; not re-importable). |
| GET | `/api/v1/sauceboss/admin/sauces/export.json` | JWT + `is_admin` | Bulk download of every sauce in one JSON file (`{version, exportedAt, count, sauces[]}`). |

## Screen / Page Flow
```
CarbSelectorScreen
  → (tap a carb card) →
SauceSelectorScreen
  ├── IngredientFilterPanel (slide-up sheet, filters sauce list)
  └── (tap a sauce accordion) →
RecipeScreen
  └── PieChart per step, ingredient list
```

Web prototype (simpler, single page):
```
index.html
  ├── CarbGrid (6 cards) → click carb
  ├── IngredientFilter (tags) → toggle to filter
  └── SauceList → click sauce → RecipeDetail (same page, expanded)
```

## Key Business Logic
- A sauce is "available" for the ingredient filter if NONE of its ingredients are in the user's disabled set.
- Unavailable sauces in the React Native app render at 45% opacity and are not tappable.
- The ingredient filter panel shows only ingredients relevant to the currently selected carb.
- Pie chart slices in RecipeScreen are proportional to `amount` converted to teaspoon equivalents (see `src/utils/units.js` if it exists, otherwise `src/components/PieChartLegend.js`).
- `sauces.steps[i].ingredients` is the canonical source for both the per-step pie chart AND the flat `ingredients[]` array (which is derived by deduplication across all steps, preserving first-appearance order).

## Environment Variables
| Variable | Used In | Purpose |
|---|---|---|
| `SUPABASE_URL` | shared-backend (Railway) | Supabase project URL — also used by `jwt_auth.py` to verify Supabase-issued JWTs via JWKS. |
| `SUPABASE_SERVICE_ROLE_KEY` | shared-backend (Railway) | Server-side DB access |
| `VIBELAB_SUPABASE_URL` / `VIBELAB_SUPABASE_ANON_KEY` | web `build.sh` (GitHub Secrets) | Injected into `web/config.js` at deploy time so the Supabase JS client can sign users in. |
| `ADMIN_API_KEY` | shared-backend (Railway) | Single-time admin-claim secret. Compared in `POST /profile/become-admin`. |
| `ALLOWED_ORIGINS` | shared-backend (Railway) | Comma-separated CORS origins (add Vercel URL here) |
| `EXPO_PUBLIC_API_URL` | app/.env | Railway backend URL for React Native |

## Development Setup
```bash
# Shared backend (from vibelab root)
cd shared-backend
python -m venv .venv && source .venv/Scripts/activate  # Windows bash
pip install -r requirements.txt
cp .env.example .env   # fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
uvicorn main:app --reload --port 8000

# Test backend
curl http://localhost:8000/api/v1/sauceboss/health
curl http://localhost:8000/api/v1/sauceboss/carbs

# Web prototype
open projects/sauceboss/web/index.html  # or serve it:
npx serve projects/sauceboss/web --port 5500

# React Native app
cd projects/sauceboss/app
npm install
echo "EXPO_PUBLIC_API_URL=http://localhost:8000" > .env
npx expo start
```

## Active Development Notes
- 2026-03-13 — Retrofitted into vibelab monorepo. Files moved: HtmlPrototype/ → web/, App/ → app/.
- 2026-05-01 — Consolidated 29 sequential migrations into `db/migrations/sauceboss/001_baseline.sql` + `002_seed.sql`. Legacy carbs/addons/salad_bases tables and the `scripts/generate_seed_sql.js` pipeline are no longer used; populate the sauce/item catalog from a production data dump or via the in-app Sauce Manager.
- 2026-05-01 — Added user accounts (migration 003). Supabase Auth (email/Google/Apple) gates the write surface; signed-in users can add sauces / ingredients, mark favorites, and edit their own sauces. Admins (claim via `ADMIN_API_KEY`) can edit/delete anything. The legacy bearer-key admin flow is removed — every `/admin/*` endpoint now uses the `get_current_admin()` dependency, except `POST /admin/foods` which is open to any logged-in user. Sauce ownership lives in `sauceboss_sauces.created_by` and is never displayed.
- 2026-05-06 — Native app **Phase 1 (read-only browse)** complete on branch `claude/sauceboss-mobile-app-nuWed`. SQLite ripped out. Pure logic extracted into `projects/sauceboss/shared/` (constants, units, colors, families, filter, fuzzy, pieMath, validation, builder, api, themeTokens, copy) and consumed by native via Metro `#shared` alias. New `app/src/store/AppContext.js` mirrors `web/state.js` shape. New screens: `MealBuilderScreen`, `PrepSelectorScreen`, `SauceSelectorScreen` (rewritten), `MealRecipeScreen`. New components: `PotIllustration`, `StepCard`, `ServingsControl`, `UnitToggle`, `VariantSwitcher`, `FormChip`, `EmptyState`, `LoadingPot`. Inter font loaded via `@expo-google-fonts/inter`; lucide-react-native for icons. Both Android + iOS Metro bundles export cleanly. Admin Sauce Manager intentionally web-only.
- 2026-05-07 — Bumped native app to **Expo SDK 54** (React 19.1, RN 0.81.5, Reanimated 4 + worklets, React Navigation 7, lucide 0.577). Added `react-native-url-polyfill/auto` to fix Hermes' getter-only `URL.protocol` that crashed Expo Go SDK 54 boot. API client defaults to the Railway URL so a fresh clone works without `.env`. MealBuilder header now respects `useSafeAreaInsets()` so the wordmark clears the iOS notch.
- 2026-05-07 — Native app **Phase 2 (auth + favorites + settings)** complete. Supabase Auth (email/password) wired via `@supabase/supabase-js` + `expo-secure-store` storage adapter. `AppContext` subscribes to `onAuthStateChange` and auto-fetches profile (creates on 404) + favorites. New components: `AuthModal`, `HeaderAuthSlot` (avatar pill / sign-in button), `HeartButton` (optimistic toggle, spring scale animation). New screen: `SettingsScreen` (display name editing, become-admin via `ADMIN_API_KEY`, sign out, delete account). `SauceSelector` gets a "Favorites" pill that hides families with no favorited member. `MealRecipeScreen` shows a heart in the timing banner. Auth UI gracefully no-ops when `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` aren't set so the read-only build still runs. Google + Apple OAuth deferred to v1.1 (requires EAS build pipeline for the custom URL scheme).
- 2026-05-07 — Step `estimatedTime` is now persisted on save. The
  `sauceboss_sauce_steps.estimated_time` column has existed since the
  baseline (read paths emit it as `estimatedTime`) but the
  `create_sauceboss_sauce` / `update_sauceboss_sauce` RPCs never wrote
  to it, so every step fell back to the recipe view's hardcoded 5-minute
  default. Migration `006_step_estimated_time.sql` redefines both RPCs
  to read `p_data->'steps'->>'estimatedTime'`. `StepInput` Pydantic model
  gains the field. Web + native builders both grew a small "Time / min"
  numeric input next to the step title; existing sauces edited in either
  app round-trip the value.
- 2026-05-07 — Native app **Phase 3 (sauce manager + sauce builder)** complete. New `SauceManagerScreen` browses every sauce in the catalog (open to all users), grouped by cuisine accordion with search + type-filter pills + favorites toggle. Logged-in users get a "+" FAB that opens a new `SauceBuilderScreen`; the row's owner (or any admin) gets inline Edit + Delete actions. New `SauceBuilderScreen` is a single-screen authoring form (basics, type/cuisine/color picker, item pairings, multi-step editor with `FoodAutocomplete` debounced typeahead against `/foods?q=`, URL import via `/import` + `applyParsedRecipe` from `#shared/builder`, live `validateBuilder` from `#shared/validation`). New `RecipeScreen` is a single-sauce viewer used from the manager (the meal flow still goes through `MealRecipeScreen`). Home header gets a "Sauces" button (chef-hat icon) that opens the manager. Backend gained `DELETE /api/v1/sauceboss/sauces/{id}` (owner-or-admin) so the native app can delete recipes the user created without needing the admin claim. Pie chart layout in `StepCard` flipped to side-by-side (chart left, ingredient legend right) to match the web app.
- 2026-05-07 — **Recipe import/export + edit-mode toggle** (web only). New backend module `shared-backend/routes/sauceboss/import_export_routes.py` adds four endpoints: `GET /sauces/{id}/export.json` (public, versioned envelope), `GET /sauces/{id}/export.md` (public, human-readable, one-way), `GET /admin/sauces/export.json` (admin, bulk dump), and `POST /sauces/import` (multipart JSON upload, logged-in user becomes `created_by`). Reuses the existing `get_sauceboss_all_sauces_full` RPC and `_build_sauce_payload` / `create_sauceboss_sauce` create pipeline — no new SQL, no new Python deps. Single-import accepts both the envelope shape and bare `CreateSauceRequest` objects; bulk envelopes are rejected (422). Cross-installation `parentSauceId` references that don't resolve locally are stripped with a non-fatal warning rather than 422'd, so backups round-trip cleanly between Supabase projects. Frontend gets a new global `state.editMode` (default `false`, persisted in `sessionStorage`, reset on logout) toggled via a pencil icon in the Sauce Manager header. When `editMode` is OFF the Sauce Manager renders read-only — no `+` FAB, no swipe-to-edit/delete on sauce/dish/ingredient rows, no long-press merge, no import/bulk-export toolbar; flipping ON reveals all of them. Recipe view (`recipe.js`) and meal recipe view (`meal.js`) both gain JSON + Markdown export buttons gated on the same flag. Export endpoints are public so anonymous users can still download via shared links — only the UI is gated.
- 2026-05-08 — **Import flow polish + tighter exports.** Sauce import now skips the server-side persistence path entirely: the web UI parses the uploaded `.sauce.json` client-side, populates `state.builder` (mirrors `openBuilderEdit`'s shape mapping minus `editingId`), and routes through the existing builder → review → `POST /sauces` flow so users always confirm the imported recipe before it lands in the catalog. Backend `POST /sauces/import` endpoint and its helpers (`_unwrap_import_payload`, `_resolve_parent`, `ImportResultResponse`) are removed. JSON exports now strip per-ingredient `originalText`/`foodId`/`unitId`/`canonicalMl`/`canonicalG` — all are derived server-side on save (`_resolve_ingredient_for_save` rebuilds `originalText` from `amount + unit + name`), so dropping them keeps export shape symmetric with what the builder edit flow already discards and shrinks payloads ~15-25%. Markdown exports still use `originalText` for qualitative rows ("salt to taste"). The "Add a sauce" `+` FAB on the Sauces tab is now visible to any logged-in user regardless of edit-mode state — adding new content isn't really editing. Edit mode still gates the per-row swipe edit/delete actions, the import/bulk-export toolbar, and the ingredients-tab `+`. Non-resolvable `parentSauceId` references are dropped client-side with a warning before the builder loads.
- 2026-05-09 — **Native parity for import/export.** The native app (Expo SDK 54) now ships the same recipe import/export feature as the web. Per-sauce **download** lives alongside Edit / Delete in each row of `SauceManagerScreen → Sauces tab` (`app/src/screens/manager/SaucesTab.js`); tapping it opens an `Alert.alert` with **JSON / Markdown / Cancel** and, on choice, fetches the relevant export endpoint (`api.exportSauceJson` / `api.exportSauceMd`), writes the body to `FileSystem.cacheDirectory + {slug}.sauce.{format}`, and hands the URI to `Sharing.shareAsync` so the user gets the native share sheet (Save to Files, Mail, etc.). **Import** is a "From file" button beside the existing URL-import row in `SauceBuilderScreen`; it uses `expo-document-picker` + `expo-file-system/legacy` to read a JSON file, applies the same envelope checks the web does (`version: 1`, reject bulk envelopes, accept bare-sauce shape), drops a non-resolvable `parentSauceId` with an alert, then stamps `state.builder` via the new shared `builderFromSauce(sauce, defaults?)` helper hoisted to `shared/builder.js` from `SauceBuilderScreen.js`. Three new Expo packages added to `app/package.json`: `expo-file-system ~19`, `expo-sharing ~14`, `expo-document-picker ~14`. Shared `api.js` gains a `callText()` plumbing helper (returns response body as text) plus `exportSauceJson(id)` / `exportSauceMd(id)` methods consumed by both the native handler and a future web backup-CLI consumer. No backend changes — the Phase-1 export endpoints are reused as-is.
- TODO: Create Supabase project, run `db/migrations/sauceboss/001_baseline.sql` then `002_seed.sql`, then `db/migrations/_shared/*` (see `db/migrations/README.md`)
- TODO: Create Railway service, set env vars, deploy shared-backend
- TODO: Update `web/app.js` to use fetch() instead of window.SAUCE_DATA (remove saucedata.js)
- TODO: Add `web/config.js` to `web/index.html`
- TODO: Create `app/src/api/client.js` and update `App.js` to remove SQLiteProvider
- TODO: Update `registry.json` with Vercel + Railway URLs once deployed

## Retrofit Notes
Moved from `C:\CodeProjects\SauceBoss\` into vibelab monorepo:
- `App/` → `projects/sauceboss/app/` (no content changes)
- `HtmlPrototype/` → `projects/sauceboss/web/` (no content changes yet)
- `scripts/` → `projects/sauceboss/scripts/` (generate_seed_sql.js added)
- `Docs/` → `projects/sauceboss/Docs/` (unchanged)
Backend, migrations, and API client are new additions.
