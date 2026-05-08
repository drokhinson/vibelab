# PlantPlanner — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-05-08

## What This App Does

PlantPlanner is a virtual garden and planter box builder. Users create a bird's-eye grid (preset or custom sizes, each cell = 1 sq ft), then drag and drop plants from a catalog onto the grid to plan their garden layout. A side-view toggle shows plant heights as an elevation profile. A split-pane 3D render (Three.js with toon shading) shows the planter with plants in a rotatable Cubirds-style low-poly view, with toggleable render styles (Cubirds/Natural/Blueprint). Users sign in with Google, Apple, or email/password (Supabase Auth) to save and load multiple garden designs. The plant catalog (~50 plants) is stored in the database with sunlight, height, bloom season, and 3D render parameter data.

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
├── web/              — Static HTML prototype
│   ├── index.html    — App shell
│   ├── styles.css    — App-specific styles
│   ├── config.js     — Sets window.APP_CONFIG.apiBase
│   ├── state.js      — Global state variables
│   ├── helpers.js    — apiFetch (Supabase bearer token), nav helpers, logout
│   ├── catalog.js    — Plant catalog sidebar
│   ├── garden.js     — Grid builder + drag-drop + side view + 3D split pane
│   ├── render3d.js   — Three.js 3D planter scene (toon/natural/wireframe)
│   ├── auth.js       — Supabase Auth screen (Google/Apple OAuth + email)
│   ├── gardens.js    — My gardens list (save/load)
│   ├── build.sh      — Generates config.js from SUPABASE_URL/SUPABASE_ANON_KEY at deploy
│   └── init.js       — DOMContentLoaded, initSupabase, event listeners
└── STRUCTURE.md      — this file

shared-backend/routes/plant_planner/  — FastAPI route package
db/migrations/plantplanner/001_baseline.sql + 002_seed.sql — Supabase migrations
```

## Data Model

- **plantplanner_profiles** — id (uuid PK, = `auth.users.id` ON DELETE CASCADE), display_name (text), avatar_url (text, nullable), is_admin (bool default false), created_at (timestamptz default now())
- **plantplanner_renders** — key (text PK), label (text), params (jsonb — 3D geometry), colors (jsonb — color map), created_at (timestamptz default now())
- **plantplanner_plants** — id (uuid PK default gen_random_uuid()), name (text), height_inches (int), sunlight (text: full_sun/partial/shade), bloom_season (text[]), spread_inches (int), description (text), sort_order (int), category (text), render_key (text FK→renders), bloom_months (int[] 1–12), native (bool), usda_zones (jsonb `{min:int, max:int}`), pollinator_attracts (text[] subset of `bees`/`butterflies`/`hummingbirds`/`moths`/`beneficial_insects`), water_need (text: low/medium/high), care_summary (text, nullable)
- **plantplanner_gardens** — id (uuid PK default gen_random_uuid()), user_id (uuid FK→profiles ON DELETE CASCADE), name (text), grid_width (int), grid_height (int), garden_type (text), shade_level (text), planting_season (text), usda_zone (text, nullable — e.g. `"6b"`), created_at (timestamptz default now()), updated_at (timestamptz default now())
- **plantplanner_garden_plants** — id (uuid PK default gen_random_uuid()), garden_id (uuid FK→gardens ON DELETE CASCADE), plant_id (uuid FK→plants), grid_x (int), grid_y (int)

## API Endpoints

- `GET  /api/v1/plant_planner/health` — Health check
- `GET  /api/v1/plant_planner/auth/me` — Get current user (auth required; auto-creates profile row on first call)
- `GET  /api/v1/plant_planner/plants` — List all plants in catalog (includes Iteration-1 fields: `bloom_months`, `native`, `usda_zones` `{min,max}`, `pollinator_attracts`, `water_need`, `care_summary`)
- `GET  /api/v1/plant_planner/gardens` — List user's gardens (auth required)
- `POST /api/v1/plant_planner/gardens` — Create new garden (auth required; accepts optional `usda_zone`)
- `GET  /api/v1/plant_planner/gardens/{id}` — Get garden with placed plants (auth required)
- `PUT  /api/v1/plant_planner/gardens/{id}` — Update garden name/size/`usda_zone` (auth required)
- `DELETE /api/v1/plant_planner/gardens/{id}` — Delete garden (auth required)
- `PUT  /api/v1/plant_planner/gardens/{id}/plants` — Save all plant placements (auth required, full replace)

## Screen / Page Flow

```
Auth View (login/register)
    ↓ (on login)
My Gardens View (list saved gardens, create new)
    ↓ (select or create garden)
Garden Builder View
  ├── Header (garden name + size + USDA-zone chip + Save/Reseed)
  ├── Plant Catalog Sidebar (search input + horizontally-scrolling chip row + draggable plant tiles)
  │     ↳ Tile click → slide-in Plant Detail Panel (care summary, 12-dot bloom strip,
  │       pollinators, hardiness range, description). Tile drag still places onto the grid.
  ├── 3D Render (rotatable Three.js, drag from catalog to place)
  └── Save button
```

## Key Business Logic

- Grid is always measured in square feet. Preset sizes: 4x4, 4x8, 8x8. Custom allows any width×height.
- Catalog filtering uses one search input + a single horizontally-scrolling chip row (replaces the legacy 3 stacked dropdowns). Chips combine AND across categories, OR within a category. The `Native` chip additionally restricts to plants whose `usda_zones` range covers the garden's `usda_zone` (when set).
- Drag and drop: pick plant from catalog sidebar, drop onto grid cell. Multiple plants can't occupy same cell. Click (movement < 5px AND mouseup within 300ms) opens the Plant Detail Panel instead of starting a drag.
- Side view: renders plants as vertical bars proportional to their height_inches.
- Garden save: sends full grid state (all plant placements) to the API in one PUT.
- Plant catalog is loaded from DB once on page load and cached in JS state.

## Environment Variables
| Variable | Used In | Purpose |
|---|---|---|
| `SUPABASE_URL` | shared-backend (Railway) | Supabase project URL — also used by `jwt_auth.py` to fetch the JWKS for Supabase token verification |
| `SUPABASE_SERVICE_ROLE_KEY` | shared-backend (Railway) | Server-side DB access (bypasses RLS) |
| `VIBELAB_SUPABASE_URL` | GitHub Actions secret | Injected into `web/config.js` at deploy time by `build.sh` |
| `VIBELAB_SUPABASE_ANON_KEY` | GitHub Actions secret | Public anon key used by the Supabase JS client in the browser |

## Active Development Notes

- 2026-03-17 — Project scaffolded. Building web prototype + backend.
- 2026-05-08 — Iteration 1 (agentic): compressed catalog + rich plant knowledge — see ITERATIONS.md. Added `bloom_months`, `native`, `usda_zones`, `pollinator_attracts`, `water_need`, `care_summary` to `plantplanner_plants`; added `usda_zone` to `plantplanner_gardens`. Catalog sidebar header switched from 3 stacked dropdowns to one search input + horizontally-scrolling chip row. Plant tiles now show a native badge + pollinator icons. Tile click opens a slide-in Plant Detail Panel. Garden header gets a USDA-zone chip → picker, persisted via PUT /gardens/{id}.
- 2026-05-08 — Switched auth from custom bcrypt + JWT to Supabase Auth (Google + Apple OAuth + email/password). Migration `db/migrations/plantplanner/003_supabase_auth.sql` drops `plantplanner_users` and recreates `plantplanner_gardens` / `plantplanner_garden_plants` keyed off `plantplanner_profiles(id) = auth.users.id`. Backend uses shared `jwt_auth.get_current_supabase_user`; profile rows are auto-created on first sign-in. `PLANTPLANNER_JWT_SECRET` env var is no longer used. **One-time setup before deploying:** enable Google + Apple providers in Supabase dashboard, add `https://vibelab-plant-planner.vercel.app` + `/**` to Authentication → URL Configuration → Redirect URLs, run the 003 migration in SQL Editor.
