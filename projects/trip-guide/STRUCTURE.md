# TripGuide — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-08-02

## What This App Does

TripGuide is a generic builder for shareable, visual trip guides. An admin creates a **trip**
(name, description, and a **color-scheme preset**) and populates it with ordered **stops** — cards
that each hold a name, a short description, and admin-authored **HTML content**. Every stop renders
in the same standard card frame; the trip's color scheme themes both the trip page and its stop
cards. Anyone can view trips and stops; creating, editing, reordering, and deleting is gated behind
the shared vibelab admin code. The first seeded trip is "Slovenian Arrow"; new trips are just new
rows, so the app supports any number of trips.

## Current Status
- Stage: Prototype (web)
- Web prototype: built, not yet deployed
- Backend: built, not yet deployed (routes registered in shared service)
- Native app: not started

## Tech Stack
| Layer | Technology | Notes |
|---|---|---|
| Web frontend | Vanilla HTML/CSS/JS + DaisyUI/Tailwind (CDN) + Lucide | No build step, deployed to Vercel |
| Backend | Python FastAPI (shared service) | Routes at `/api/v1/trip_guide/...` |
| Database | Supabase (shared project) | Tables prefixed `tripguide_` |
| Auth | Shared vibelab admin code (`ADMIN_API_KEY`) | Public read; admin-gated writes via `auth.require_admin` |

## Data Model
All tables prefixed `tripguide_` (see `db/migrations/tripguide/`, `db/schema/tripguide.sql`).

- **tripguide_color_schemes** — preset palettes (option set). `slug` (PK), `name`, `palette` (JSONB:
  primary/bg/surface/text/accent/muted), `sort_order`.
- **tripguide_trips** — `id` (uuid PK), `name`, `description`, `color_scheme` (FK → color_schemes.slug),
  `sort_order`, `created_at`, `updated_at`.
- **tripguide_stops** — `id` (uuid PK), `trip_id` (FK → trips, ON DELETE CASCADE), `name`,
  `description`, `content_html` (admin HTML), `sort_order`, `created_at`, `updated_at`.

## API Endpoints
Registered at `/api/v1/trip_guide/...` (package: `shared-backend/routes/trip_guide/`).

Public (no auth):
- `GET /health` — Health check.
- `GET /color-schemes` — List color-scheme presets.
- `GET /trips` — List trips (with stop counts).
- `GET /trips/{trip_id}` — Trip bundle: trip + resolved palette + ordered stops.

Admin (require `Authorization: Bearer <ADMIN_API_KEY>`):
- `GET /admin/health` — Validate the admin code (used by the web login).
- `POST /trips`, `PUT /trips/{trip_id}`, `DELETE /trips/{trip_id}`
- `POST /trips/{trip_id}/stops`, `PUT /stops/{stop_id}`, `DELETE /stops/{stop_id}`
- `POST /trips/{trip_id}/stops/reorder` — Body `{ordered_ids: [...]}`; sets each stop's `sort_order`.

## Routes & URL Map
History-API routing (`web/domain/view.js`); `vercel.json` rewrites all paths to `/index.html`,
and `<base href="/">` keeps relative script/asset URLs correct on deep links.

| Path | Route name | Params | Notes |
|---|---|---|---|
| `/` | `home` | — | Trips list. |
| `/trip/:id` | `trip` | `id` | One trip: themed header + ordered stop cards. |

## Screen / Page Flow
```
Home (trips list) → tap a trip → Trip page (stops)
Admin button (header) → sign-in modal → unlocks +New trip / +Add stop / edit / delete / drag-reorder
```

## Key Business Logic
- **Admin session:** the code is stored in `sessionStorage` (`tripguide_admin_key`) and sent as a
  Bearer token by `web/api.js`. A 401/403 on any request clears it and re-prompts.
- **Theming:** the trip bundle returns the resolved `palette`; `web/views/trip-view.js` applies it as
  `--tg-*` CSS custom properties on the view container, so page + stop cards share the scheme.
- **Reorder:** drag-and-drop is optimistic with a monotonic sequence guard; it persists via
  `/stops/reorder` and rolls back to server truth on error.
- **HTML content** is admin-authored and rendered as HTML on purpose (trusted input).

## Web File Layout
```
web/
├── index.html          — shell (header + view containers + modal/toast hosts)
├── config.js           — window.APP_CONFIG.apiBase
├── domain/view.js      — View base class + History-API Router
├── api.js              — window.api (Bearer-injecting fetch wrapper)
├── admin.js            — admin-code session + login modal
├── ui/modal.js         — modal + toast surfaces
├── ui/forms.js         — shared trip + stop create/edit forms (stop form has live HTML preview)
├── ui/trip-card.js     — renderTripCard (Trip object)
├── ui/stop-card.js     — renderStopCard (Stop object)
├── views/trips-view.js — home
├── views/trip-view.js  — one trip
├── init.js             — register views, wire header, boot (loaded last)
├── styles.css          — visual system (palette-driven)
└── vercel.json         — SPA rewrite
```

## Environment Variables
| Variable | Used In | Purpose |
|---|---|---|
| `SUPABASE_URL` | shared-backend | Supabase project URL (Railway) |
| `SUPABASE_SERVICE_ROLE_KEY` | shared-backend | Server-side DB access (Railway) |
| `ADMIN_API_KEY` | shared-backend | Shared vibelab admin code, gates write endpoints (Railway) |

## Development Setup
```bash
# Backend (from vibelab root)
cd shared-backend && uvicorn main:app --reload --port 8000

# Web prototype
npx serve projects/trip-guide/web   # or python -m http.server -d projects/trip-guide/web
```

## Active Development Notes
- 2026-08-02 — Built web + backend + migrations. Run `db/migrations/tripguide/001` then `002` in
  Supabase before the API returns data. Native app not started.
