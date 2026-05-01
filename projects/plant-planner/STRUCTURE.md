# PlantPlanner — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-03-17

## What This App Does

PlantPlanner is a virtual garden and planter box builder. Users create a bird's-eye grid (preset or custom sizes, each cell = 1 sq ft), then drag and drop plants from a catalog onto the grid to plan their garden layout. A side-view toggle shows plant heights as an elevation profile. A split-pane 3D render (Three.js with toon shading) shows the planter with plants in a rotatable Cubirds-style low-poly view, with toggleable render styles (Cubirds/Natural/Blueprint). Users can register accounts to save and load multiple garden designs. The plant catalog (~50 plants) is stored in the database with sunlight, height, bloom season, and 3D render parameter data.

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
| Auth | Shared auth.py (bcrypt + JWT) | Username/password registration |
| Storage | Supabase Storage | Not used |

## Directory Layout
```
projects/plant-planner/
├── web/              — Static HTML prototype
│   ├── index.html    — App shell
│   ├── styles.css    — App-specific styles
│   ├── config.js     — Sets window.APP_CONFIG.apiBase
│   ├── state.js      — Global state variables
│   ├── helpers.js    — apiFetch, auth, nav helpers
│   ├── catalog.js    — Plant catalog sidebar
│   ├── garden.js     — Grid builder + drag-drop + side view + 3D split pane
│   ├── render3d.js   — Three.js 3D planter scene (toon/natural/wireframe)
│   ├── auth.js       — Login/register views
│   ├── gardens.js    — My gardens list (save/load)
│   └── init.js       — DOMContentLoaded, event listeners
└── STRUCTURE.md      — this file

shared-backend/routes/plant_planner/  — FastAPI route package
db/migrations/plantplanner/001_baseline.sql + 002_seed.sql — Supabase migrations
```

## Data Model

- **plantplanner_users** — id (uuid PK default gen_random_uuid()), username (text unique), display_name (text), password_hash (text), created_at (timestamptz default now())
- **plantplanner_plants** — id (uuid PK default gen_random_uuid()), name (text), emoji (text), height_inches (int), sunlight (text: full_sun/partial/shade), bloom_season (text[]), spread_inches (int), description (text), sort_order (int), render_params (jsonb, nullable — procedural 3D geometry descriptors for Three.js)
- **plantplanner_gardens** — id (uuid PK default gen_random_uuid()), user_id (uuid FK→users), name (text), grid_width (int), grid_height (int), created_at (timestamptz default now()), updated_at (timestamptz default now())
- **plantplanner_garden_plants** — id (uuid PK default gen_random_uuid()), garden_id (uuid FK→gardens ON DELETE CASCADE), plant_id (uuid FK→plants), grid_x (int), grid_y (int)

## API Endpoints

- `GET  /api/v1/plant_planner/health` — Health check
- `POST /api/v1/plant_planner/auth/register` — Register user
- `POST /api/v1/plant_planner/auth/login` — Login
- `GET  /api/v1/plant_planner/auth/me` — Get current user (auth required)
- `GET  /api/v1/plant_planner/plants` — List all plants in catalog
- `GET  /api/v1/plant_planner/gardens` — List user's gardens (auth required)
- `POST /api/v1/plant_planner/gardens` — Create new garden (auth required)
- `GET  /api/v1/plant_planner/gardens/{id}` — Get garden with placed plants (auth required)
- `PUT  /api/v1/plant_planner/gardens/{id}` — Update garden name/size (auth required)
- `DELETE /api/v1/plant_planner/gardens/{id}` — Delete garden (auth required)
- `PUT  /api/v1/plant_planner/gardens/{id}/plants` — Save all plant placements (auth required, full replace)

## Screen / Page Flow

```
Auth View (login/register)
    ↓ (on login)
My Gardens View (list saved gardens, create new)
    ↓ (select or create garden)
Garden Builder View
  ├── Plant Catalog Sidebar (draggable plant tiles)
  ├── Split Pane:
  │   ├── 2D Grid (bird's-eye or side view, toggle)
  │   └── 3D Render (rotatable Three.js, render style selector)
  └── Save button
```

## Key Business Logic

- Grid is always measured in square feet. Preset sizes: 4x4, 4x8, 8x8. Custom allows any width×height.
- Drag and drop: pick plant from catalog sidebar, drop onto grid cell. Multiple plants can't occupy same cell.
- Side view: renders plants as vertical bars proportional to their height_inches.
- Garden save: sends full grid state (all plant placements) to the API in one PUT.
- Plant catalog is loaded from DB once on page load and cached in JS state.

## Environment Variables
| Variable | Used In | Purpose |
|---|---|---|
| `SUPABASE_URL` | shared-backend | Supabase project URL (set in Railway) |
| `SUPABASE_SERVICE_ROLE_KEY` | shared-backend | Server-side DB access (set in Railway) |
| `PLANTPLANNER_JWT_SECRET` | shared-backend | JWT signing secret |

## Active Development Notes

- 2026-03-17 — Project scaffolded. Building web prototype + backend.
