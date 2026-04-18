# PlantPlanner — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-04-18

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
| Auth | Supabase Auth | Email + password, Google OAuth, Apple OAuth |
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
db/migrations/007_plant_planner_*.sql — Supabase migrations
```

## Data Model

- **plantplanner_profiles** — id (uuid PK FK→auth.users ON DELETE CASCADE), display_name (text), created_at (timestamptz default now())
- **plantplanner_plants** — id (uuid PK default gen_random_uuid()), name (text), height_inches (int), sunlight (text: full_sun/partial/shade), bloom_season (text[]), spread_inches (int), description (text), sort_order (int), category (text), render_key (text FK→plantplanner_renders.key)
- **plantplanner_renders** — key (text PK), label (text), params (jsonb, geometry), colors (jsonb), created_at (timestamptz)
- **plantplanner_gardens** — id (uuid PK default gen_random_uuid()), user_id (uuid FK→plantplanner_profiles ON DELETE CASCADE), name, grid_width, grid_height, garden_type, shade_level, planting_season, created_at, updated_at
- **plantplanner_garden_plants** — id (uuid PK default gen_random_uuid()), garden_id (uuid FK→gardens ON DELETE CASCADE), plant_id (uuid FK→plants), grid_x (int), grid_y (int)

## API Endpoints

All routes that require auth expect a Supabase access token in `Authorization: Bearer <token>`.

- `GET  /api/v1/plant_planner/health` — Health check
- `GET  /api/v1/plant_planner/profile` — Get current user's profile (auth required; returns 404 on first login)
- `POST /api/v1/plant_planner/profile` — Create or update profile (`{display_name}`) (auth required)
- `GET  /api/v1/plant_planner/plants` — List all plants in catalog (public)
- `GET  /api/v1/plant_planner/gardens` — List user's gardens (auth required)
- `POST /api/v1/plant_planner/gardens` — Create new garden (auth required)
- `GET  /api/v1/plant_planner/gardens/{id}` — Get garden with placed plants (auth required)
- `PUT  /api/v1/plant_planner/gardens/{id}` — Update garden name/size (auth required)
- `DELETE /api/v1/plant_planner/gardens/{id}` — Delete garden (auth required)
- `PUT  /api/v1/plant_planner/gardens/{id}/plants` — Save all plant placements (auth required, full replace)

Sign-up, sign-in, password reset, and OAuth callbacks are all handled directly by Supabase Auth — there is no backend `/auth/*` endpoint.

## Screen / Page Flow

```
Auth View (email login/signup, "Continue with Google", "Continue with Apple")
    ↓ (on first login only) Profile Setup View (pick display name)
    ↓
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
| `SUPABASE_URL` | shared-backend (Railway) + web (Vercel) | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | shared-backend (Railway) | Server-side DB access (bypasses RLS) |
| `SUPABASE_JWT_SECRET` | shared-backend (Railway) | Verifies Supabase Auth JWTs in FastAPI |
| `SUPABASE_ANON_KEY` | web (Vercel) | Client-side auth via supabase-js |

## Auth Provider Setup (Supabase Dashboard)

1. **Authentication → Providers → Email** — enabled (default).
2. **Authentication → Providers → Google** — enabled with Google OAuth Client ID + Secret. Authorized redirect URI on Google's side: `https://<project>.supabase.co/auth/v1/callback`.
3. **Authentication → Providers → Apple** — enabled with Services ID, Team ID, Key ID, and `.p8` private key.
4. **Authentication → URL Configuration** — production Vercel URL and `http://localhost:5500` added to the Redirect URLs allowlist.

## Active Development Notes

- 2026-03-17 — Project scaffolded. Building web prototype + backend.
- 2026-04-18 — Migrated from custom username/password JWT to Supabase Auth (email + Google + Apple). Dropped `plantplanner_users`; gardens now FK to `plantplanner_profiles` (id references `auth.users`). Migration `034_plantplanner_supabase_auth.sql`.
