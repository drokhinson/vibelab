# Travel Scrapbook — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-07-15

## What This App Does

Travel Scrapbook is for people who research trips by collecting links — a Reddit thread about ramen shops, an Instagram reel about a hidden bar, a Pinterest board of viewpoints — and currently paste them into Word docs to untangle later. A bookmarklet ("Scrap it") or an in-app paste box saves the URL to a chosen trip. The backend then scrapes the page, asks Claude Haiku to figure out *what place it is* (name, city, country, category), geocodes it with Nominatim (OpenStreetMap, free), and attaches a Google Maps link. Inside a trip, scraps appear as sticker-style cards; the user can add anchors (start/end airports, hotel/Airbnb stays), sort all scraps into the shortest route (nearest-neighbor + 2-opt over haversine distances), open the route as multi-stop Google Maps directions links, or download a CSV that imports into Google My Maps.

## Current Status
- Stage: Prototype (web)
- Web prototype: built, not yet deployed
- Backend: implemented in shared-backend, not yet deployed
- Native app: not started

## Tech Stack
| Layer | Technology | Notes |
|---|---|---|
| Web frontend | Vanilla HTML/CSS/JS + DaisyUI v4 + Lucide | No build step, deployed to Vercel |
| Backend | Python FastAPI (shared service) | Routes at `/api/v1/travel_scrapbook/...` |
| Database | Supabase (shared project) | Tables prefixed `travelscrapbook_` |
| Native app | React Native / Expo | Not started |
| Auth | Supabase Auth | `travelscrapbook_profiles`, pilot pattern (like boardgame-buddy) |
| LLM | Claude Haiku 4.5 (`claude-haiku-4-5`) | Place extraction from scraped pages; `ANTHROPIC_API_KEY` in Railway |
| Geocoding | Nominatim (OpenStreetMap) | Free, no key; 1 req/s courtesy limit + 30-day cache |
| Storage | Supabase Storage | Not used (og:images hotlinked in v1) |

## Directory Layout
```
projects/travel-scrapbook/
├── web/
│   ├── index.html            — app shell (script order: config → store → helpers → auth → domain → ui → widgets → views → init)
│   ├── vercel.json           — SPA rewrites for History API routing
│   ├── styles.css            — scrapbook theme (paper bg, sticker cards, washi tape)
│   ├── config.js             — window.APP_CONFIG { apiBase, supabaseUrl, supabaseAnonKey, project }
│   ├── helpers.js            — analytics ping, toast, escapeHtml, date fmt
│   ├── auth.js               — Supabase Auth flow (sauceboss pattern)
│   ├── domain/               — store.js, api.js (makeApi), view.js (Router), trip.js, scrap.js, route.js
│   ├── ui/                   — canonical render fns: trip-card, scrap-card, route-stop, category-badge, oauth-buttons, sprites.js
│   ├── widgets/              — quick-paste, scrap-editor, anchor-editor
│   ├── views/                — login, trips, trip, scrap-popup (bookmarklet), settings
│   ├── init.js               — router boot
│   └── assets/
│       ├── brand/travel-scrapbook-logo.svg
│       ├── sprites/categories/travel-scrapbook-cat-<slug>.svg   (8 custom category stickers)
│       ├── sprites/covers/travel-scrapbook-cover-<slug>.svg     (trip cover stickers)
│       └── illustrations/travel-scrapbook-empty-*.svg           (custom empty states)
└── STRUCTURE.md

shared-backend/routes/travel_scrapbook/   — FastAPI package (see below)
db/migrations/travelscrapbook/001_baseline.sql + 002_seed.sql
db/schema/travelscrapbook.sql, db/functions/travelscrapbook.sql
```

**No emojis policy:** this app uses zero generic emojis. All data-art (category markers, trip cover stickers, empty states, success flourishes) is custom-built SVG under `web/assets/` per `.claude/rules/assets.md` § Custom Images, Not Generic Emojis.

## Data Model

All tables RLS-enabled, granted to `travelscrapbook_role`; backend-only access via service role (no Data API grants, no RPCs).

- **travelscrapbook_profiles** — Supabase Auth profile. `id uuid PK → auth.users ON DELETE CASCADE`, `display_name text`, `username text UNIQUE`, `is_admin bool`, `created_at`.
- **travelscrapbook_categories** — seeded option set. `slug text PK` (restaurant, cafe, bar, sight, activity, shop, lodging, other), `label text`, `icon text` (sprite slug → `assets/sprites/categories/travel-scrapbook-cat-<icon>.svg`), `sort_order int`.
- **travelscrapbook_trips** — `id uuid PK`, `user_id → profiles CASCADE`, `name text`, `destination text`, `cover_icon text DEFAULT 'plane'` (sprite slug), `start_date date`, `end_date date`, `notes text`, timestamps. Index `(user_id)`.
- **travelscrapbook_anchors** — route endpoints/stays. `id uuid PK`, `trip_id → trips CASCADE`, `role text CHECK ('start','end','stay')`, `label text`, `query text` (geocode input), `lat/lng double precision`, `geocode_confidence text CHECK ('high','medium','low','none')`, `created_at`. Partial unique `(trip_id, role) WHERE role IN ('start','end')`.
- **travelscrapbook_scraps** — the saved links. `id uuid PK`, `trip_id → trips CASCADE`, `user_id → profiles CASCADE`, `source_url text`, `source_domain text`, `status text CHECK ('pending','ready','failed')`, `error_kind text` (network/blocked/llm/geocode), `og_title/og_description/og_image_url text`, `place_name/place_city/place_country text`, `category → categories(slug) DEFAULT 'other'`, `lat/lng`, `geocode_confidence`, `geocode_display_name text` (Nominatim's resolved address, shown so users can spot mis-geocodes), `maps_url text`, `notes text`, `is_favorite bool`, `route_position int` (last computed route order), timestamps. Indexes `(trip_id)`, `(user_id)`.

## API Endpoints

All under `/api/v1/travel_scrapbook`, Supabase bearer auth (profile auto-created) except health.

- `GET /health` — health check, no auth
- `GET /me` — profile bootstrap + category list; `PATCH /me` — update display_name
- `GET /trips` — list with scrap counts; `POST /trips`; `GET /trips/{id}` — trip + anchors + scraps bundle; `PATCH /trips/{id}`; `DELETE /trips/{id}`
- `POST /trips/{id}/anchors` — create + geocode synchronously; `PATCH /anchors/{id}` — edit (re-geocodes if query changed); `DELETE /anchors/{id}`
- `POST /scraps` — `{trip_id, url, notes?}` → inserts `pending` row, returns 201 immediately, enrichment runs via FastAPI BackgroundTasks
- `GET /scraps/{id}` — poll one; `GET /trips/{id}/scraps` — list (frontend polls while pending)
- `PATCH /scraps/{id}` — user edits place fields/category/notes/favorite; body flag `regeocode: true` re-runs Nominatim synchronously
- `POST /scraps/{id}/retry` — reset to pending, re-enrich; `DELETE /scraps/{id}`
- `POST /trips/{id}/route/optimize` — `{scrap_ids?, favorites_only?}`; NN + 2-opt with start/end anchors; persists `route_position`; returns ordered scraps + leg/total km + skipped (ungeocoded)
- `GET /trips/{id}/export/maps-links` — JSON `{legs: [{label, url, stop_count}]}` of `google.com/maps/dir/...` URLs (≤10 stops/leg, legs overlap at endpoints)
- `GET /trips/{id}/export/csv` — text/csv attachment (name, category, address, lat, lng, notes, url) for Google My Maps import

## Routes & URL Map

| Path | Route name | Params | Notes |
|---|---|---|---|
| `/` | `trips` | — | Trip grid (default landing, auth required). |
| `/trip/:tripId` | `trip` | `tripId` | Trip detail: anchors, quick-paste, scraps, route panel. |
| `/scrap` | `scrap-popup` | `?url=&title=` | Bookmarklet popup — chrome-less trip picker + save. |
| `/settings` | `settings` | — | Profile, bookmarklet install, logout. |
| `/login` | `login` | — | OAuth + email sign-in. |

## Screen / Page Flow

```
/login → (OAuth/email, redirects straight back) → / (trips grid)
/ → tap trip card → /trip/:id
/trip/:id → paste link in quick-paste → scrap card appears (pending shimmer) → polls → ready
/trip/:id → "Sort my route" → ordered stop list + "Open leg in Google Maps" buttons + "Download CSV"
Any third-party page → bookmarklet → popup /scrap?url=… → pick trip → Save → popup closes
/settings → drag bookmarklet to bookmarks bar (copy-paste fallback)
```

## Key Business Logic

- **Enrichment pipeline** (`services/enrichment.py`, background task, never raises): fetch page (browser UA; on 403/login-wall degrade to URL-slug-only context — common for Instagram/Reddit) → Haiku extracts `{place_name, city, country, category, geocode_query}` as strict JSON → Nominatim fallback chain: `name,city,country` (high) → `name,country` (medium) → `city,country` (low, centroid) → none → build `maps_url = google.com/maps/search/?api=1&query=<name, city>` → single UPDATE to `ready`. Failures write `status='failed'` + `error_kind`; UI offers retry.
- **Nominatim courtesy**: module-level asyncio lock + monotonic timestamp enforce ≥1.1s between calls; results cached 30 days (cache.py ns `ts.geocode`); descriptive User-Agent. Never add a Google geocoding key — links are plain URLs.
- **Route optimizer** (`services/optimizer.py`): haversine matrix; nearest-neighbor seeded at start anchor (or first scrap), 2-opt improvement with fixed endpoints; open path when no end anchor. Ungeocoded scraps are skipped and reported.
- **Maps export chunking**: Google directions URLs cap ~10 waypoints; legs overlap (last stop of leg N = first stop of leg N+1).
- **Bookmarklet = popup window**, not in-page fetch: third-party CSP (Instagram/Reddit) blocks XHR from injected JS, and the popup is our origin so the Supabase session just works. No tokens ever touch third-party pages.
- **Stuck pending**: BackgroundTasks are lost on worker restart; frontend poll times out at 45s and offers retry.

## Environment Variables
| Variable | Used In | Purpose |
|---|---|---|
| `SUPABASE_URL` | shared-backend | Supabase project URL (Railway) |
| `SUPABASE_SERVICE_ROLE_KEY` | shared-backend | Server-side DB access (Railway) |
| `ANTHROPIC_API_KEY` | shared-backend | Claude Haiku place extraction (Railway) — see ENV.md |
| `SUPABASE_ANON_KEY` | web | Supabase Auth client (config.js via Vercel build) |

## Development Setup
```bash
# Backend (from vibelab root)
cd shared-backend
source .venv/bin/activate
uvicorn main:app --reload --port 8000

# Web prototype
npx serve projects/travel-scrapbook/web
```

## Active Development Notes

- 2026-07-15 — Initial build: migrations, backend package, web prototype, custom SVG asset set (no-emoji policy). Pending user actions: run migrations in Supabase, add ANTHROPIC_API_KEY to Railway, create Vercel project + VERCEL_TRAVEL_SCRAPBOOK_PROJECT_ID secret, add domain to ALLOWED_ORIGINS.
