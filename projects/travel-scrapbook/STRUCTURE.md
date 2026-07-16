# Travel Scrapbook — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-07-16

## What This App Does

Travel Scrapbook is for people who research trips by collecting links — a Reddit thread about ramen shops, an Instagram reel about a hidden bar, a TripAdvisor page found on the couch. Capture is everywhere the user already is: **share from any phone app** (Android share sheet via installed PWA, iPhone via a "Scrap it" Shortcut), a bookmarklet, or an in-app paste box. The backend scrapes the page, asks Gemini to extract **every place it mentions** (one reel can fan out into several), dedupes each into a canonical **place** (the source of truth — name, category, coordinates, Google Maps link) with the URLs attached as **sources** ("how you stumbled on it"), and geocodes with Nominatim (OpenStreetMap, free). New finds land **staged on a nearby trip** (a "Needs review" section the user approves) or in the **inbox** when no trip matches. Inside a trip, scraps appear as sticker-style cards; the user can add anchors (start/end airports, hotel/Airbnb stays), sort all scraps into the shortest route (nearest-neighbor + 2-opt over haversine distances), open the route as multi-stop Google Maps directions links, or download a CSV that imports into Google My Maps.

Every saved place carries the owner's own **rating** — Booked / Must do / Interested / Could skip — settable from the Wander List or any trip (`scraps.rating`). Trips can be **shared** with other travelers as a viewer or collaborator (invite → accept); on a shared trip every member sets their own **Vibe** on each place (same four levels) which rolls up into a group consensus, and each place shows who added it. The owner's rating doubles as their vibe: setting a rating on an in-trip place upserts the owner's vibe row server-side, so consensus includes them without a second control.

**Core objects:** Trip, Scrap (a saved place in a trip or the inbox), **Place** (canonical, deduped), **Source** (capture event), Anchor/RouteStop, Category, **TripMember** (a viewer/collaborator on a shared trip), **Vibe** (a traveler's per-place take → group consensus).

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
│   ├── ui/                   — canonical render fns: trip-card, scrap-card, scrap-groups (collapsible group-by sections), source-card, route-stop, category-badge, oauth-buttons, sprites.js
│   ├── widgets/              — quick-paste, scrap-editor, trip-editor (edit name/destination/scope/dates), add-plans (from-Wander-List multi-select + manual entry), anchor-editor, tutorial-carousel
│   ├── views/                — login, trips, trip, inbox (Wander List), visited, scrap-popup (bookmarklet), share (share target), settings
│   ├── init.js               — router boot, SW registration, inbox badge
│   └── assets/
│       ├── brand/travel-scrapbook-logo.svg + travel-scrapbook-icon-{192,512,512-maskable}.png
│       ├── sprites/categories/travel-scrapbook-cat-<slug>.svg   (8 custom category stickers)
│       ├── sprites/covers/travel-scrapbook-cover-<slug>.svg     (trip cover stickers)
│       └── illustrations/travel-scrapbook-empty-*.svg           (custom empty states incl. empty-inbox)
└── STRUCTURE.md

shared-backend/routes/travel_scrapbook/   — FastAPI package (see below)
db/migrations/travelscrapbook/001_baseline.sql … 007_trip_sharing_vibes.sql
db/schema/travelscrapbook.sql, db/functions/travelscrapbook.sql
```

**No emojis policy:** this app uses zero generic emojis. All data-art (category markers, trip cover stickers, empty states, success flourishes) is custom-built SVG under `web/assets/` per `.claude/rules/assets.md` § Custom Images, Not Generic Emojis.

## Data Model

All tables RLS-enabled, granted to `travelscrapbook_role`; backend-only access via service role (no Data API grants, no RPCs). The **place is the source of truth**; sources record how the user found it; a scrap is "the user's saved place, in a trip or the inbox".

- **travelscrapbook_profiles** — Supabase Auth profile. `id uuid PK → auth.users ON DELETE CASCADE`, `display_name text`, `username text UNIQUE`, `is_admin bool`, `created_at`.
- **travelscrapbook_categories** — seeded option set. `slug text PK` (restaurant, cafe, bar, sight, activity, shop, lodging, other), `label text`, `icon text` (sprite slug → `assets/sprites/categories/travel-scrapbook-cat-<icon>.svg`), `sort_order int`.
- **travelscrapbook_trips** — `id uuid PK`, `user_id → profiles CASCADE`, `name text`, `destination text`, `cover_icon text DEFAULT 'plane'` (sprite slug), **geographic scope** `scope_level text CHECK ('region','country','city') DEFAULT 'city'` + `dest_city/dest_region/dest_country/dest_country_code` (match values derived from the destination geocode; `dest_region` = the destination country's macro-region, so a region-scoped trip spans a whole country grouping), `start_date date`, `end_date date`, `notes text`, **geocoded destination** `lat/lng`, `geocode_confidence`, `geocode_display_name`, `destination_geocoded_at` (NULL = never attempted; drives lazy backfill), timestamps. Index `(user_id)`. Scope drives tag-based staging + the trip candidates panel; city scope stays distance-based.
- **travelscrapbook_anchors** — route endpoints/stays. `id uuid PK`, `trip_id → trips CASCADE`, `role text CHECK ('start','end','stay')`, `label text`, `query text` (geocode input), `lat/lng double precision`, `geocode_confidence text CHECK ('high','medium','low','none')`, `type text CHECK ('airport','train_station','car_rental','other')` (start/end only — how you arrive/depart), `stay_date date` (stay only — check-in day, seeds a future day-by-day timeline), `created_at`. Partial unique `(trip_id, role) WHERE role IN ('start','end')`. Arrival and departure are often the same place, so the end anchor can be created with `same_as_start` to copy the start's location + type (no re-geocode).
- **travelscrapbook_sources** — one capture event. `id uuid PK`, `user_id → profiles CASCADE`, `url text`, `url_normalized text` (tracking params/fragment stripped; UNIQUE per user), `source_domain`, `status CHECK ('processing','ready','failed')`, `error_kind` (network/blocked/llm/no_place), `captured_via CHECK ('paste','bookmarklet','share','shortcut')`, `shared_text` (share-sheet caption — extra LLM context, key for blocked Instagram pages), `capture_notes` (user note at capture, copied onto created scraps), `trip_hint_id → trips SET NULL`, `og_title/og_description/og_image_url`, timestamps.
- **travelscrapbook_regions** — reference data: `country_code text PK` (ISO-3166 alpha-2, lowercase) → `region text` (UN M49 subregion, e.g. Greece→Southern Europe, Japan→Eastern Asia). Seeded in `006`; read backend-only to tag places/trips with a macro-region. Cached in-process (`ts.regions`).
- **travelscrapbook_places** — canonical place, per-user (osm identity recorded for future global/cross-user dedupe). `id uuid PK`, `user_id → profiles CASCADE`, `name text`, `name_normalized text` (accent/case/punct-folded dedupe key), `city/country`, `country_code` (ISO alpha-2), `region` (**macro-region** = the country's UN subregion, a grouping of countries — derived via `travelscrapbook_regions`, not admin-1), `category → categories DEFAULT 'other'`, `lat/lng`, `geocode_confidence`, `geocode_display_name`, `osm_type/osm_id`, `maps_url`, timestamps. Index `(user_id, name_normalized)`. Names come back in English (`accept-language=en`).
- **travelscrapbook_place_sources** — N sources ↔ N places join (`place_id`, `source_id`, PK both, CASCADE both).
- **travelscrapbook_capture_tokens** — iOS Shortcut auth. `id uuid PK`, `user_id → profiles CASCADE`, `token_hash text UNIQUE` (sha256 hex — deterministic so /capture can look up BY token; safe for 256-bit random tokens), `created_at`, `last_used_at`, `revoked_at` (soft revoke; one active per user, enforced app-side).
- **travelscrapbook_scraps** — the user's saved place. `id uuid PK`, `trip_id → trips CASCADE` **nullable** (NULL = wishlist/inbox), `user_id → profiles CASCADE`, `place_id → places CASCADE`, `status CHECK ('inbox','staged','approved')` (staged = auto-matched to a trip, awaiting review; only approved scraps route/export), `notes`, `rating text CHECK (NULL,'booked','must_do','interested','could_skip')` (the owner's own priority, settable anywhere — replaced `is_favorite` in `008`; backfilled from the owner's vibe, then hearts→must_do), `visited_at timestamptz` (NULL = on the wishlist; set = visited → surfaces in the Visited view, excluded from the wishlist + nav badge), `route_position`, timestamps. Indexes `(trip_id)`, `(user_id)`, `(user_id, status)`, `(place_id)`, `(user_id, visited_at)`.
- **travelscrapbook_trip_members** — trip sharing. `id uuid PK`, `trip_id → trips CASCADE`, `user_id → profiles CASCADE`, `role text CHECK ('viewer','collaborator')` (viewer = read + vibe; collaborator = read + vibe + add places/edit the shared route), `status text CHECK ('pending','accepted','declined') DEFAULT 'pending'` (only `accepted` grants access — the invite → accept flow), `invited_by → profiles SET NULL`, `created_at`, `responded_at`. `UNIQUE (trip_id, user_id)`; indexes `(user_id, status)`, `(trip_id)`. **The owner is NOT a member row** — ownership stays on `trips.user_id`; access = owner ∪ accepted members.
- **travelscrapbook_scrap_vibes** — each traveler's **Vibe** on a place (the group-consensus input). `id uuid PK`, `scrap_id → scraps CASCADE`, `user_id → profiles CASCADE`, `level text CHECK ('booked','must_do','interested','could_skip')`, timestamps. `UNIQUE (scrap_id, user_id)` (one vibe per person per scrap); index `(scrap_id)`. Present on all trips (a solo trip just has one voter). Because scraps are per-user, two collaborators saving the same place get two cards, each with its own vibes/consensus.

## Trip sharing, roles & vibes

- **Share a trip** with another user by username as a **viewer** or **collaborator** (invite → accept). Invites are pending until the invitee accepts; only accepted members see the trip. Non-destructive removal/leave — a departing member's saved places stay on the trip (still shown "added by X").
- **Roles.** Owner: everything, incl. edit trip settings, manage members, delete the trip. Collaborator: read + add places (capture/assign onto the shared trip) + edit the shared route (anchors, optimize). Viewer: read + set their own vibe only. Enforced in `access.py get_accessible_trip(...)` (owner-or-member gate; `need_write`/`need_owner` flags) — the single chokepoint replacing the old owner-only `get_owned_trip`. Scrap *content* mutations (edit/delete a place) stay own-scrap-only (`get_owned_scrap`) so no one edits another traveler's places.
- **Vibes → consensus.** Every member (viewers included) sets their own vibe on each place; the card shows a per-member chip row + a consensus headline (top count, tie-break booked > must_do > interested > could_skip). "Added by X" shows who saved each place on a shared trip. Vibes + consensus are attached in `hydrate_scraps(..., with_vibes=True)` on the trip surfaces (2 extra batched round-trips, no N+1).

## API Endpoints

All under `/api/v1/travel_scrapbook`, Supabase bearer auth (profile auto-created) except health; `POST /capture` also accepts a personal capture token (`tsc_…` prefix).

- `GET /health` — health check, no auth
- `GET /me` — profile bootstrap + category list; `PATCH /me` — update display_name
- `GET /trips` — owned **plus accepted-shared** trips with scrap counts, each tagged with the caller's `role` + `owner_display_name` (lazily backfills destination geocodes + `dest_*` components, inferring legacy scope); `POST /trips` (accepts `scope_level`; geocodes destination synchronously, inferring scope from the destination when none given); `GET /trips/{id}` — trip + anchors + `scraps` (approved) + `staged_scraps` bundle, plus the caller's `role`/owner (readable by owner or member; vibes hydrated in); `PATCH /trips/{id}` (owner only; re-geocodes a changed destination, honors `scope_level`); `DELETE /trips/{id}` (owner only)
- `POST /trips/{id}/anchors` — create + geocode synchronously (accepts `type` for start/end, `stay_date` for stay, or `same_as_start` on an end anchor to copy the start's place + type without geocoding); `PATCH /anchors/{id}` — edit (re-geocodes if query changed); `DELETE /anchors/{id}`
- `POST /capture` → 202 — the single silent-capture entry: `{url?, text?, title?, trip_id?, via?, notes?}`; URL taken from `url` or extracted from `text` (Android share sheets put it there); dedupes on `(user, url_normalized)` (re-capture reuses the source; failed/stale resets and re-runs); processing via BackgroundTasks
- `POST /capture-token` → 201 (plaintext shown once; replaces prior token); `GET /capture-token` — status; `DELETE /capture-token` — revoke
- `GET /inbox` — the wishlist: `{processing_sources, failed_sources, scraps}` (only unvisited inbox scraps; each carries `suggestions`: nearest ≤3 trips within 200 km, plus country/region trips by tag match); sweeps sources stuck processing >10 min → failed; `GET /inbox/count` — nav badge (unvisited only)
- `GET /visited` — every scrap with `visited_at` set (any trip or the wishlist), most-recently-visited first — the Visited view
- `POST /sources/{id}/retry` → 202; `DELETE /sources/{id}` — dismiss; `GET /sources/{id}/scraps` — a capture's live `{status, error_kind, scraps}` (drives the "watch it import" cards on the share success screen)
- `GET /scraps/{id}`; `GET /trips/{id}/scraps` — hydrated with place fields (incl. `place_region`) + source chips
- `GET /trips/{id}/candidates` — unvisited wishlist scraps whose location matches the trip's scope (city/country/region), for the inline "Suggested plans" panel; same predicate as auto-staging
- `GET /trips/{id}/wishlist` — ALL unvisited wishlist scraps + a `fits_scope` flag (matches sort first), for the trip's "Add plans → From your Wander List" picker (not scope-filtered — add anything); `POST /trips/{id}/assign-scraps` `{scrap_ids}` — bulk-add them as approved
- `POST /trips/{id}/plans` `{name, city?, country?, category?, notes?}` — manual entry: geocode a typed place, dedupe into a canonical place, attach to the trip as approved (reuses an existing scrap for the same place). **In a trip, scraps are called "plans" in the UI** (internal identifiers unchanged).
- `PATCH /scraps/{id}` — place-field/category edits (incl. `place_region`) write to the canonical **place** row; notes/`visited` stay on the scrap (`visited` → `visited_at` now()/NULL); `regeocode: true` re-runs Nominatim synchronously (also refreshes region)
- **Rating** — `PUT /scraps/{id}/rating` `{level}` / `DELETE /scraps/{id}/rating` — set/clear the owner's own priority (owner-only). When the scrap is in a trip, the rating also upserts/deletes the owner's vibe row (one-way sync: rating→vibe), so group consensus includes the owner without a second control.
- `POST /scraps/{id}/assign` `{trip_id}` → approved; `POST /scraps/{id}/approve` (staged only, else 409); `POST /scraps/{id}/unassign` → back to inbox; `POST /trips/{id}/approve-all` — approve every staged scrap; `DELETE /scraps/{id}`
- `POST /trips/{id}/route/optimize` — `{scrap_ids?, priority_only?}` (priority_only = booked/must-do plans only); NN + 2-opt with start/end anchors; **approved scraps only**; persists `route_position`; returns ordered scraps + leg/total km + skipped (ungeocoded)
- `GET /trips/{id}/export/maps-links` — JSON `{legs: [{label, url, stop_count}]}` of `google.com/maps/dir/...` URLs (≤10 stops/leg, legs overlap at endpoints)
- `GET /trips/{id}/export/csv` — text/csv attachment (name, category, address, lat, lng, notes, url) for Google My Maps import
- **Sharing** — `GET /trips/{id}/members` (owner + members, incl. pending); `POST /trips/{id}/members` `{username, role}` → 201 (owner; invite by username, pending); `PATCH /trips/{id}/members/{userId}` `{role}` (owner); `DELETE /trips/{id}/members/{userId}` (owner removes, or member leaves); `GET /invitations` — my pending invites; `POST /trips/{id}/invitation/respond` `{action: accept|decline}`
- **Vibes** — `PUT /scraps/{id}/vibe` `{level}` — set/replace my vibe (any member incl. viewer; scrap must be in a trip); `DELETE /scraps/{id}/vibe` — clear mine; both return the re-hydrated scrap with the updated consensus

## Routes & URL Map

| Path | Route name | Params | Notes |
|---|---|---|---|
| `/` | `trips` | — | Trip grid (default landing, auth required). |
| `/trip/:tripId` | `trip` | `tripId` | Trip detail: anchors, quick-paste, staging review, scraps, route panel. |
| `/inbox` | `inbox` | — | Wander List (wishlist): processing, failed (retry), want-to-go places (suggestion chips + mark-visited). |
| `/visited` | `visited` | — | Places marked visited (any trip or the wishlist); tap the check to move one back. |
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
- 2026-07-16 — English + region-as-country-grouping + grouping everywhere (migration `006`): (1) Nominatim now requests `accept-language=en` (cache ns → `ts.geocode3`) so names read "Greece" not "Ελλάς" — **going-forward only**; older places switch to English when re-pinned. (2) **"Region" redefined** from admin-1 (state/province) to a **grouping of countries** (UN M49 subregion, e.g. Southern Europe): new `travelscrapbook_regions` seed table (country_code→region) + `country_code`/`dest_country_code` columns; `places.region`/`trips.dest_region` now hold the macro-region (derived via `region_for_country_code`), the scrap-editor region field is gone (derived), and the card subtitle is City, Country. Region-scope matching is pure label equality (spans countries). (3) The group-by toggle is now on **all three lists** (Wander List, Visited, trip scraps), ordered **Region › Country › City** (+ Activity in trips), and a dimension that would yield a single group is auto-hidden (`availableGroupDims`) — so Region disappears on a one-country trip. **Pending user action: run `db/migrations/travelscrapbook/006_country_regions.sql` in Supabase.**
- 2026-07-16 — Plans in a trip + editable scope + three ways to add (no migration): a "Crete" trip showed nothing from Greece because "Crete" geocodes to a state → inferred **city** scope (100 km radius). Fixes: (1) **trip is now editable** (`widgets/trip-editor.js` → `PATCH /trips/{id}`) so scope can be changed to **Country** (all Greece) after creation; (2) trip-scoped scraps are labelled **"Plans"** in the UI; (3) a **"+ Add plans"** button opens `widgets/add-plans.js` with two ways — **From your Wander List** (`GET /trips/{id}/wishlist` all places + `fits_scope` flag, multi-select via a new scrap-card `'select'` variant → `POST /trips/{id}/assign-scraps`, scope-agnostic) and **Add manually** (`POST /trips/{id}/plans` — geocode a typed name into a plan). The inline scope-matched panel is relabelled "Suggested plans". Global/community Wander List deferred (still per-user). No migration.
- 2026-07-16 — Grouped lists (no migration, frontend only): a flat wishlist/trip list got overwhelming, so both now group into **collapsible sections with a "group by" toggle** (shared `ui/scrap-groups.js`: `groupScraps`, `renderScrapGroups`, `renderGroupByToggle`, `bindScrapGroups`). Wander List toggles City / Region / Country; the trip toggles Activity (category) / City / Region / Country. Native `<details>` collapse, counts per group, geography sorted by size (missing-value group last) and category by seed sort order; selection persists in `localStorage`. Grouping is pure over the flat place fields the API already returns — no backend change.
- 2026-07-16 — Suggestion + photo polish (no migration): (1) `place_matches_trip_scope` city scope now also matches by **city-name equality** (country-guarded), not just centroid distance, so same-city wishlist places surface even when their geocode centroid drifts past 100 km — improving auto-stage, inbox suggestions, and the candidates panel together; the candidates panel/endpoint remains location-only (no category/confidence filter), so uncategorized scraps always appear. (2) Scrap cards with **no source image** now fall back to a keyless OSM **static-map thumbnail** of the pin (`staticMapUrl` in `helpers.js`, used in `ui/scrap-card.js`), degrading to the category sprite on error or for ungeocoded places. No env/user action.
- 2026-07-16 — Trip sharing, collaboration & group "Vibes" (migration `007`): share a trip by username as a **viewer** (read + vibe) or **collaborator** (read + vibe + add places) via an **invite → accept** flow (`travelscrapbook_trip_members` with a `status`). Every member sets their own **Vibe** on each place (booked / must-do / interested / could-skip → `travelscrapbook_scrap_vibes`), rolled up into a group **consensus** on the card; shared cards show who added each place. New `access.py` `get_accessible_trip`/`get_accessible_scrap` owner-or-member gate (`need_write`/`need_owner`) replaces the owner-only `get_owned_trip` across all trip/scrap/source/route/export routes; scrap content edits stay own-scrap-only. New `member_routes.py` (members + `/invitations`), vibe endpoints, `hydrate_scraps(with_vibes=True)`, and `list_trips` returning owned ∪ accepted-shared. Frontend: `domain/share.js`, vibe control + consensus + "added by" on the canonical scrap card (threaded through `ui/scrap-groups.js`), a trip-view share panel, and a trips-view invitations banner. **Pending user action: run `db/migrations/travelscrapbook/007_trip_sharing_vibes.sql` in Supabase.**
- 2026-07-16 — Global place rating replaces favorites (migration `008`): the binary favorite heart is gone; every scrap now carries its owner's **rating** (booked / must_do / interested / could_skip — same value set as vibes, `ScrapRating = TripVibe`), settable from the **Wander List and trips alike** via the 4-segment control on the canonical scrap card (`renderPriorityControl`, action `rate` on own scraps / `vibe` on others' shared-trip scraps; visited cards show a read-only badge). Setting/clearing a rating on an in-trip scrap syncs the owner's vibe row (one-way). Trip filter "Favorites" → "Must-dos" (booked+must_do); route optimize `favorites_only` → `priority_only`. Backfill: owner's vibe → rating, then remaining hearts → must_do; `is_favorite` dropped. Backend + web ship together (no compat shim) — **merge and run the migration in the same sitting**. **Pending user action: run `db/migrations/travelscrapbook/008_scrap_rating.sql` in Supabase (after 003–007).**
- 2026-07-16 — Region tags + trip scope + wishlist/visited (migration `005`): (1) `places.region` (admin-1 state/province) auto-filled from Nominatim address components — `GeocodeResult` now parses the `address` object (geocode cache namespace bumped to `ts.geocode2`); (2) trips gain `scope_level` (city/country/region, picked in the New Trip modal) + derived `dest_*`, a single `place_matches_trip_scope` predicate powering auto-staging, inbox suggestions, and a new "From your wishlist" candidates panel (`GET /trips/{id}/candidates`); city = distance (unchanged), country/region = tag match; (3) the inbox is reframed as the **Wander List** (label/copy only — enum + `/inbox` unchanged), scraps gain `visited_at`, a new **Visited** view (`GET /visited`, `/visited` route) collects them, mark-visited toggle on wishlist/trip cards + editor. **Pending user action: run `db/migrations/travelscrapbook/005_region_scope_visited.sql` in Supabase** (it re-arms destination geocoding so existing trips backfill `dest_*` + infer scope on next `/trips` load; existing places gain a region only when re-pinned/re-captured).
