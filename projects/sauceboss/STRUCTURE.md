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
All tables prefixed `sauceboss_` in the shared Supabase project.

- **sauceboss_items** — Unified selector table for carbs / proteins / salad bases. Type rows have `parent_id IS NULL`; Variant rows (e.g. basmati rice as a prep variant of rice) point at their Type via `parent_id`. Columns: `id` (text PK), `category` ('carb'|'protein'|'salad'), `parent_id` (nullable FK→items), `name`, `emoji`, `description`, `sort_order`, `cook_time_minutes`, `instructions`, `water_ratio`, `portion_per_person`, `portion_unit`.
- **sauceboss_sauces** — All recipes (sauces, dressings, marinades). Columns: `id`, `name`, `cuisine`, `cuisine_emoji`, `color` (hex), `description`, `sauce_type` ('sauce'|'dressing'|'marinade').
- **sauceboss_sauce_items** — Unified junction: sauces ↔ items. A trigger enforces `sauce_type ↔ item.category` (sauce→carb, marinade→protein, dressing→salad) and that links target Type rows only (not Variants). Columns: `sauce_id`, `item_id`.
- **sauceboss_sauce_steps** — Ordered cooking steps per recipe. Columns: `id` (bigserial), `sauce_id`, `step_order` (int), `title`, `estimated_time` (minutes), `input_from_step` (nullable int).
- **sauceboss_step_ingredients** — Ingredients per step. Mealie-inspired normalized shape (migration 063). Columns: `id`, `step_id`, `food_id` (FK→sauceboss_foods), `unit_id` (FK→sauceboss_units), `original_text`, `quantity` (numeric), `quantity_canonical_ml`, `quantity_canonical_g`. Legacy freeform `name`/`amount`/`unit` columns were dropped — joins emit them at read time for backwards-compat.
- **sauceboss_units** — Unit registry (migration 063). One row per supported unit with `id`, `name`, `plural`, `abbreviation`, `dimension` ('volume'|'mass'|'count'), `ml_per_unit`, `g_per_unit`, `aliases` (text[]). The Python module `routes/sauceboss/units.py` mirrors this table for in-process parsing — keep the two in sync.
- **sauceboss_foods** — One row per distinct ingredient food (migration 063). Auto-populated by `create_sauceboss_sauce` via `INSERT ... ON CONFLICT (name_normalized)`. Columns: `id`, `name`, `plural`, `name_normalized`, `aliases`. **No density column for v1** — see `routes/sauceboss/units.py::DENSITY_TODO` for the wet↔dry conversion follow-up.
- **sauceboss_ingredient_categories** — Maps ingredient names to filter panel categories.
- **sauceboss_ingredient_substitutions** — Substitution suggestions shown when an ingredient is marked unavailable.
- **sauceboss_profiles** (migration 003) — Supabase-Auth-backed user profiles. Columns: `id` (UUID FK→auth.users), `display_name`, `avatar_url`, `is_admin`, `created_at`. Mirrors the boardgamebuddy_profiles pattern.
- **sauceboss_favorites** (migration 003) — Per-user sauce favorites (composite PK `user_id`+`sauce_id`).
- `sauceboss_sauces.created_by` (migration 003) — UUID FK→auth.users, set when a user submits a sauce. Never displayed; powers the owner-only edit gate.

**RPCs** (defined in `db/migrations/sauceboss/001_baseline.sql`, with migration 003 amending the sauce-related ones):
- `get_sauceboss_initial_load()` — `{ carbs, proteins, saladBases }` for the home screen (one round-trip).
- `get_sauceboss_item_load(p_item_id text)` — `{ item, variants, sauces, ingredients }` for any selection screen (one round-trip).
- `get_sauceboss_items_by_category(p_category text)` — Type rows for one category, with sauce count. Used by `initial_load`.
- `get_sauceboss_sauces_for_item(p_item_id text)` — Fully assembled sauces linked to an item. Emits `createdBy` (003).
- `get_sauceboss_variants_for_item(p_item_id text)` — Child rows (parent_id = p_item_id).
- `get_sauceboss_ingredients_for_item(p_item_id text)` — Sorted unique ingredient names across linked sauces.
- `get_sauceboss_all_sauces[ _full ]()` — Sauce manager listings. Emit `createdBy` (003).
- `create_sauceboss_sauce(p_data)` — Now accepts `p_data->>'createdBy'` (003).
- `update_sauceboss_sauce(p_data)` (003) — Atomic full-replace of a sauce's scalar fields, item links, steps, and step ingredients. Preserves `created_by`. Authorization is enforced upstream.

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
| GET | `/api/v1/sauceboss/foods` | None | Foods typeahead (`?q=`, `?limit=`) for the builder ingredient field. |
| GET | `/api/v1/sauceboss/profile` | JWT | Current user's profile (404 if missing). |
| POST | `/api/v1/sauceboss/profile` | JWT | Upsert `display_name` (auto-called on first login). |
| POST | `/api/v1/sauceboss/profile/become-admin` | JWT | Body `{admin_key}`. Compared to env `ADMIN_API_KEY`; sets `is_admin=true`. |
| DELETE | `/api/v1/sauceboss/profile` | JWT | Delete current user's profile. Cascades to favorites; sauces' `created_by` becomes NULL. |
| GET | `/api/v1/sauceboss/favorites` | JWT | List the user's favorited sauce IDs. |
| PUT | `/api/v1/sauceboss/favorites/{sauce_id}` | JWT | Idempotently mark a sauce as favorite. |
| DELETE | `/api/v1/sauceboss/favorites/{sauce_id}` | JWT | Idempotently remove a favorite. |
| POST | `/api/v1/sauceboss/admin/foods` | JWT | Add an ingredient (any logged-in user). |
| * | `/api/v1/sauceboss/admin/*` | JWT + `is_admin` | Item / sauce / food management (rename, delete, merge). |

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
