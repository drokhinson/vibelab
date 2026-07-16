# Travel Scrapbook — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-07-15

## What This App Does

Travel Scrapbook is for people who research trips by collecting links — a Reddit thread about ramen shops, an Instagram reel about a hidden bar, a TripAdvisor page found on the couch. Capture is everywhere the user already is: **share from any phone app** (Android share sheet via installed PWA, iPhone via a "Scrap it" Shortcut), a bookmarklet, or an in-app paste box. The backend scrapes the page, asks Gemini to extract **every place it mentions** (one reel can fan out into several), dedupes each into a canonical **place** (the source of truth — name, category, coordinates, Google Maps link) with the URLs attached as **sources** ("how you stumbled on it"), and geocodes with Nominatim (OpenStreetMap, free). New finds land **staged on a nearby trip** (a "Needs review" section the user approves) or in the **inbox** when no trip matches. Inside a trip, scraps appear as sticker-style cards; the user can add anchors (start/end airports, hotel/Airbnb stays), sort all scraps into the shortest route (nearest-neighbor + 2-opt over haversine distances), open the route as multi-stop Google Maps directions links, or download a CSV that imports into Google My Maps.

**Core objects:** Trip, Scrap (a saved place in a trip or the inbox), **Place** (canonical, deduped), **Source** (capture event), Anchor/RouteStop, Category.

## Current Status
- Stage: Prototype (web)
- Web prototype: built, not yet deployed
- Backend: implemented in shared-backend, not yet deployed
- Native app: not started (phone capture ships via PWA share target + iOS Shortcut instead)

## Tech Stack
| Layer | Technology | Notes |
|---|---|---|
| Web frontend | Vanilla HTML/CSS/JS + DaisyUI v4 + Lucide | No build step, deployed to Vercel; PWA (manifest + share_target + minimal SW) |
| Backend | Python FastAPI (shared service) | Routes at `/api/v1/travel_scrapbook/...` |
| Database | Supabase (shared project) | Tables prefixed `travelscrapbook_` |
| Native app | React Native / Expo | Not started |
| Auth | Supabase Auth | `travelscrapbook_profiles`, pilot pattern (like boardgame-buddy); plus per-user capture tokens for the iOS Shortcut |
| LLM | Gemini free tier (`gemini-flash-lite-latest` alias) | Multi-place extraction from scraped pages; `GEMINI_API_KEY` in Railway. Alias (not a pinned ID) so a model deprecation can't 404 every request — `gemini-2.5-flash` was pulled early on 2026-07-09 |
| Geocoding | Nominatim (OpenStreetMap) | Free, no key; 1 req/s courtesy limit + 30-day cache; osm_type/osm_id recorded for future global dedupe |
| Storage | Supabase Storage | Not used (og:images hotlinked in v1) |

## Directory Layout
```
projects/travel-scrapbook/
├── web/
│   ├── index.html            — app shell (script order: config → store → helpers → auth → domain → ui → widgets → views → init)
│   ├── manifest.json         — PWA manifest incl. share_target (GET /share) → Android share sheet
│   ├── sw.js                 — minimal no-cache service worker (installability only)
│   ├── vercel.json           — SPA rewrites for History API routing
│   ├── styles.css            — scrapbook theme (paper bg, sticker cards, washi tape)
│   ├── config.js             — window.APP_CONFIG { apiBase, supabaseUrl, supabaseAnonKey, project }
│   ├── helpers.js            — analytics ping, toast, escapeHtml, date fmt
│   ├── auth.js               — Supabase Auth flow (sauceboss pattern)
│   ├── domain/               — store.js, api.js (makeApi), view.js (Router), trip.js, scrap.js, source.js, route.js
│   ├── ui/                   — canonical render fns: trip-card, scrap-card, source-card, route-stop, category-badge, oauth-buttons, sprites.js
│   ├── widgets/              — quick-paste, scrap-editor, anchor-editor, tutorial-carousel
│   ├── views/                — login, trips, trip, inbox, scrap-popup (bookmarklet), share (share target), settings
│   ├── init.js               — router boot, SW registration, inbox badge
│   └── assets/
│       ├── brand/travel-scrapbook-logo.svg + travel-scrapbook-icon-{192,512,512-maskable}.png
│       ├── sprites/categories/travel-scrapbook-cat-<slug>.svg   (8 custom category stickers)
│       ├── sprites/covers/travel-scrapbook-cover-<slug>.svg     (trip cover stickers)
│       └── illustrations/travel-scrapbook-empty-*.svg           (custom empty states incl. empty-inbox)
└── STRUCTURE.md

shared-backend/routes/travel_scrapbook/   — FastAPI package (see below)
db/migrations/travelscrapbook/001_baseline.sql … 004_places_sources.sql
db/schema/travelscrapbook.sql, db/functions/travelscrapbook.sql
```

**No emojis policy:** this app uses zero generic emojis. All data-art (category markers, trip cover stickers, empty states, success flourishes) is custom-built SVG under `web/assets/` per `.claude/rules/assets.md` § Custom Images, Not Generic Emojis.

## Data Model

All tables RLS-enabled, granted to `travelscrapbook_role`; backend-only access via service role (no Data API grants, no RPCs). The **place is the source of truth**; sources record how the user found it; a scrap is "the user's saved place, in a trip or the inbox".

- **travelscrapbook_profiles** — Supabase Auth profile. `id uuid PK → auth.users ON DELETE CASCADE`, `display_name text`, `username text UNIQUE`, `is_admin bool`, `created_at`.
- **travelscrapbook_categories** — seeded option set. `slug text PK` (restaurant, cafe, bar, sight, activity, shop, lodging, other), `label text`, `icon text` (sprite slug → `assets/sprites/categories/travel-scrapbook-cat-<icon>.svg`), `sort_order int`.
- **travelscrapbook_trips** — `id uuid PK`, `user_id → profiles CASCADE`, `name text`, `destination text`, `cover_icon text DEFAULT 'plane'` (sprite slug), `start_date date`, `end_date date`, `notes text`, **geocoded destination** `lat/lng`, `geocode_confidence`, `geocode_display_name`, `destination_geocoded_at` (NULL = never attempted; drives lazy backfill), timestamps. Index `(user_id)`.
- **travelscrapbook_anchors** — route endpoints/stays. `id uuid PK`, `trip_id → trips CASCADE`, `role text CHECK ('start','end','stay')`, `label text`, `query text` (geocode input), `lat/lng double precision`, `geocode_confidence text CHECK ('high','medium','low','none')`, `type text CHECK ('airport','train_station','car_rental','other')` (start/end only — how you arrive/depart), `stay_date date` (stay only — check-in day, seeds a future day-by-day timeline), `created_at`. Partial unique `(trip_id, role) WHERE role IN ('start','end')`. Arrival and departure are often the same place, so the end anchor can be created with `same_as_start` to copy the start's location + type (no re-geocode).
- **travelscrapbook_sources** — one capture event. `id uuid PK`, `user_id → profiles CASCADE`, `url text`, `url_normalized text` (tracking params/fragment stripped; UNIQUE per user), `source_domain`, `status CHECK ('processing','ready','failed')`, `error_kind` (network/blocked/llm/no_place), `captured_via CHECK ('paste','bookmarklet','share','shortcut')`, `shared_text` (share-sheet caption — extra LLM context, key for blocked Instagram pages), `capture_notes` (user note at capture, copied onto created scraps), `trip_hint_id → trips SET NULL`, `og_title/og_description/og_image_url`, timestamps.
- **travelscrapbook_places** — canonical place, per-user (osm identity recorded for future global/cross-user dedupe). `id uuid PK`, `user_id → profiles CASCADE`, `name text`, `name_normalized text` (accent/case/punct-folded dedupe key), `city/country`, `category → categories DEFAULT 'other'`, `lat/lng`, `geocode_confidence`, `geocode_display_name`, `osm_type/osm_id`, `maps_url`, timestamps. Index `(user_id, name_normalized)`.
- **travelscrapbook_place_sources** — N sources ↔ N places join (`place_id`, `source_id`, PK both, CASCADE both).
- **travelscrapbook_capture_tokens** — iOS Shortcut auth. `id uuid PK`, `user_id → profiles CASCADE`, `token_hash text UNIQUE` (sha256 hex — deterministic so /capture can look up BY token; safe for 256-bit random tokens), `created_at`, `last_used_at`, `revoked_at` (soft revoke; one active per user, enforced app-side).
- **travelscrapbook_scraps** — the user's saved place. `id uuid PK`, `trip_id → trips CASCADE` **nullable** (NULL = inbox), `user_id → profiles CASCADE`, `place_id → places CASCADE`, `status CHECK ('inbox','staged','approved')` (staged = auto-matched to a trip, awaiting review; only approved scraps route/export), `notes`, `is_favorite`, `route_position`, timestamps. Indexes `(trip_id)`, `(user_id)`, `(user_id, status)`, `(place_id)`.

## API Endpoints

All under `/api/v1/travel_scrapbook`, Supabase bearer auth (profile auto-created) except health; `POST /capture` also accepts a personal capture token (`tsc_…` prefix).

- `GET /health` — health check, no auth
- `GET /me` — profile bootstrap + category list; `PATCH /me` — update display_name
- `GET /trips` — list with scrap counts (lazily backfills destination geocodes); `POST /trips` (geocodes destination synchronously); `GET /trips/{id}` — trip + anchors + `scraps` (approved) + `staged_scraps` bundle; `PATCH /trips/{id}` (re-geocodes a changed destination); `DELETE /trips/{id}`
- `POST /trips/{id}/anchors` — create + geocode synchronously (accepts `type` for start/end, `stay_date` for stay, or `same_as_start` on an end anchor to copy the start's place + type without geocoding); `PATCH /anchors/{id}` — edit (re-geocodes if query changed); `DELETE /anchors/{id}`
- `POST /capture` → 202 — the single silent-capture entry: `{url?, text?, title?, trip_id?, via?, notes?}`; URL taken from `url` or extracted from `text` (Android share sheets put it there); dedupes on `(user, url_normalized)` (re-capture reuses the source; failed/stale resets and re-runs); processing via BackgroundTasks
- `POST /capture-token` → 201 (plaintext shown once; replaces prior token); `GET /capture-token` — status; `DELETE /capture-token` — revoke
- `GET /inbox` — `{processing_sources, failed_sources, scraps}` (inbox scraps carry `suggestions`: nearest ≤3 trips within 200 km); sweeps sources stuck processing >10 min → failed; `GET /inbox/count` — nav badge
- `POST /sources/{id}/retry` → 202; `DELETE /sources/{id}` — dismiss
- `GET /scraps/{id}`; `GET /trips/{id}/scraps` — hydrated with place fields + source chips
- `PATCH /scraps/{id}` — place-field/category edits write to the canonical **place** row; notes/favorite stay on the scrap; `regeocode: true` re-runs Nominatim synchronously
- `POST /scraps/{id}/assign` `{trip_id}` → approved; `POST /scraps/{id}/approve` (staged only, else 409); `POST /scraps/{id}/unassign` → back to inbox; `POST /trips/{id}/approve-all` — approve every staged scrap; `DELETE /scraps/{id}`
- `POST /trips/{id}/route/optimize` — `{scrap_ids?, favorites_only?}`; NN + 2-opt with start/end anchors; **approved scraps only**; persists `route_position`; returns ordered scraps + leg/total km + skipped (ungeocoded)
- `GET /trips/{id}/export/maps-links` — JSON `{legs: [{label, url, stop_count}]}` of `google.com/maps/dir/...` URLs (≤10 stops/leg, legs overlap at endpoints)
- `GET /trips/{id}/export/csv` — text/csv attachment (name, category, address, lat, lng, notes, url) for Google My Maps import

## Routes & URL Map

| Path | Route name | Params | Notes |
|---|---|---|---|
| `/` | `trips` | — | Trip grid (default landing, auth required). |
| `/trip/:tripId` | `trip` | `tripId` | Trip detail: anchors, quick-paste, staging review, scraps, route panel. |
| `/inbox` | `inbox` | — | Captured finds: processing, failed (retry), needs-a-home (suggestion chips). |
| `/scrap` | `scrap-popup` | `?url=&title=` | Bookmarklet popup — chrome-less trip picker + save. |
| `/share` | `share` | `?url=&text=&title=` | Android share-target landing — silent capture + instant "Saved". |
| `/settings` | `settings` | — | Profile, phone capture (Shortcut token + PWA hint), bookmarklet, logout. |
| `/login` | `login` | — | OAuth + email sign-in. |

## Screen / Page Flow

```
/login → (OAuth/email, redirects straight back) → / (trips grid)
Phone: Instagram/Reddit/Maps → share sheet → [Android: Travel Scrapbook (PWA) → /share | iPhone: "Scrap it" Shortcut → POST /capture]
       → user stays in their app → backend extracts places → each lands staged on a nearby trip, or in /inbox
/inbox → suggestion chip ("Add to Tokyo · 3 km") or trip picker → scrap approved into trip
/trip/:id → "Needs review" section → Keep / Keep all / Move to inbox
/trip/:id → paste link in quick-paste → poll → scraps appear (may be several from one link)
/trip/:id → "Sort my route" → ordered stop list + "Open leg in Google Maps" buttons + "Download CSV"
Any third-party page → bookmarklet → popup /scrap?url=… → pick trip → Save (auto-approved) → popup closes
/settings → create capture token + follow Shortcut steps (iPhone); install PWA (Android); drag bookmarklet (desktop)
```

## Key Business Logic

- **Capture pipeline** (`services/enrichment.py::process_source`, background task, never raises): fetch page (browser UA; on 403/login-wall degrade to URL-slug + share-sheet-text context — common for Instagram/Reddit) → Gemini extracts an **array** of places (max 8) as strict JSON `{places: [{place_name, city, country, category, geocode_query, confident}]}` → per place: Nominatim fallback chain `name,city,country` (high) → `name,country` (medium) → `city,country` (low, centroid) → none → `find_or_create_place` dedupe → link `place_sources` → create a scrap **only if the user has no scrap for that place yet**. Zero places → source `failed/no_place`. Source ends `ready`/`failed`.
- **Place dedupe** (`services/places.py`): same `name_normalized` (NFKD accent-fold, lowercase, punctuation-stripped, leading "the" dropped) AND (both geocoded within 0.5 km, or coords missing with city agreeing/absent). Never coordinate-only. On merge, NULL fields fill in from the new extraction. Per-user scope; `osm_type/osm_id` is the forward path to global cross-user dedupe.
- **Trip auto-staging**: trip destinations geocode on create/update (lazy backfill on list). A confident, geocoded place within **100 km** of a destination staged onto the nearest matching trip (upcoming/undated trips beat past ones); explicit `trip_id` at capture → approved directly; otherwise inbox. Inbox cards suggest the nearest ≤3 trips within 200 km.
- **URL dedupe**: `normalize_url` (host lowercased, www/fragment/trailing-slash stripped, `utm_*`/`fbclid`/`igsh`/`si`/`gclid` params dropped, query sorted); UNIQUE `(user_id, url_normalized)` — re-sharing the same reel attaches to the existing source instead of duplicating.
- **Capture auth**: `get_capture_user` routes on the `tsc_` prefix — capture-token lookup (sha256) for iOS Shortcut traffic, Supabase JWT otherwise. Tokens: `tsc_` + `secrets.token_urlsafe(32)`, shown once, one active per user, soft-revoked.
- **Nominatim courtesy**: module-level asyncio lock + monotonic timestamp enforce ≥1.1s between calls; results cached 30 days (cache.py ns `ts.geocode`); descriptive User-Agent. Never add a Google geocoding key — links are plain URLs.
- **Route optimizer** (`services/optimizer.py`): haversine matrix; nearest-neighbor seeded at start anchor (or first scrap), 2-opt improvement with fixed endpoints; open path when no end anchor. Approved scraps only; ungeocoded scraps are skipped and reported.
- **Maps export chunking**: Google directions URLs cap ~10 waypoints; legs overlap (last stop of leg N = first stop of leg N+1).
- **Bookmarklet = popup window**, not in-page fetch: third-party CSP (Instagram/Reddit) blocks XHR from injected JS, and the popup is our origin so the Supabase session just works. No tokens ever touch third-party pages. `/share` follows the same pattern (localStorage stash across the OAuth hop).
- **Hydration** (`services/hydrate.py`): scraps serve flat place fields + source chips in 3 DB round-trips regardless of count (scraps → places → place_sources+sources); `og_image_url` = first non-null image among the place's sources.
- **Stuck processing**: BackgroundTasks are lost on worker restart; `GET /inbox` sweeps sources processing >10 min to `failed/network`; trip/inbox polls time out at 45 s.

## Environment Variables
| Variable | Used In | Purpose |
|---|---|---|
| `SUPABASE_URL` | shared-backend | Supabase project URL (Railway) |
| `SUPABASE_SERVICE_ROLE_KEY` | shared-backend | Server-side DB access (Railway) |
| `GEMINI_API_KEY` | shared-backend | Gemini place extraction (Railway) — see ENV.md |
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

- 2026-07-15 — Initial build: migrations, backend package, web prototype, custom SVG asset set (no-emoji policy). Pending user actions: run migrations in Supabase, add GEMINI_API_KEY to Railway, create Vercel project + VERCEL_TRAVEL_SCRAPBOOK_PROJECT_ID secret, add domain to ALLOWED_ORIGINS.
- 2026-07-15 — Anchor upgrades (migration `003`): location `type` (airport/train_station/car_rental/other) on start/end anchors, `stay_date` check-in day on stay anchors, and a "Same as arrival" shortcut that copies the start anchor into the end. **Pending user action: run `db/migrations/travelscrapbook/003_anchor_type_and_stay_date.sql` in Supabase.**
- 2026-07-15 — Tutorial carousel rewritten around the capture-first flow (welcome → collect scraps via share sheet → build a trip → anchor it → export to Google Maps); new `tutorial-collect` / `tutorial-anchors` illustrations, orphaned quick-paste/bookmarklet/organize art deleted.
- 2026-07-15 — Phone capture + places/sources split (migration `004`): silent capture from the phone share sheet (Android PWA share_target at `/share`; iPhone Shortcut → `POST /capture` with a personal `tsc_` token), places/sources data model (place = source of truth, deduped across URLs; one reel fans out into many places), inbox + trip staging ("Needs review"), Gemini multi-place prompt, trip destination geocoding. **Pending user action: run `db/migrations/travelscrapbook/004_places_sources.sql` in Supabase** (take a backup first — it restructures scraps and deletes pending/failed rows).
- 2026-07-16 — Fix: every link failed to process with Gemini API `404 NotFound`. Google pulled the pinned `gemini-2.5-flash` model on 2026-07-09 (ahead of its announced shutdown). Switched `GEMINI_MODEL` to the `gemini-flash-lite-latest` alias so future deprecations hot-swap (with 2-week notice) instead of 404-ing. No migration or user action needed — Railway auto-deploys on merge.
