# SpotMe — STRUCTURE.md

## What This App Does

SpotMe is a personal hobby record and social discovery app. Users track their hobbies with proficiency levels, record books read and movies seen, share community links by location, discover nearby users with shared interests, and post meetups.

Theme: adventure/mountains/nature — designed to feel like an outdoor exploration app.

## Current Status

**Stage:** Prototype (Web) — Phase 1 MVP
**Phase 1:** Auth + profile + hobbies (DONE)
**Phase 2:** Books/movies, community links, friends (PLANNED)
**Phase 3:** Discovery, meetups, notifications (PLANNED)
**Phase 4:** Strava/Garmin, push notifications, native app (FUTURE)

## Tech Stack

| Tier | Stack |
|------|-------|
| Web | Vanilla HTML/CSS/JS + Pico.css (dark mode, adventure theme) |
| Backend | Python FastAPI (shared-backend/routes/spotme/) |
| Database | Supabase (spotme_ prefixed tables) |
| Auth | Custom JWT (bcrypt + HS256) |
| Deploy | Vercel (web), Railway (backend) |

## Directory Layout

```
projects/spotme/
├── STRUCTURE.md          ← this file
├── web/
│   ├── index.html        ← single page, all views
│   ├── styles.css         ← adventure theme on Pico.css
│   ├── config.js          ← API base URL
│   ├── state.js           ← global state variables
│   ├── helpers.js         ← apiFetch, auth, showView, proficiency helpers
│   ├── profile.js         ← profile view, edit, location
│   ├── hobbies.js         ← hobby browser, add/edit/remove
│   └── init.js            ← DOMContentLoaded, event bindings
└── app/                   ← React Native (Phase 4)
    └── src/

shared-backend/routes/spotme/
├── __init__.py            ← router + imports
├── models.py              ← Pydantic schemas
├── constants.py           ← proficiency levels
├── dependencies.py        ← get_current_user (Supabase Auth JWT)
├── auth_routes.py         ← profile upsert, me, delete
├── profile_routes.py      ← profile, location, traveling, discoverable
└── hobby_routes.py        ← categories, hobbies, user hobbies CRUD

db/migrations/
├── 011_spotme_schema.sql  ← users, categories, hobbies, user_hobbies
└── 012_spotme_seed.sql    ← seed categories + 35 starter hobbies
```

## Data Model (Phase 1)

- **spotme_profiles** — id (→ auth.users), username, display_name, email, bio, avatar_url, is_discoverable, home_lat/lng, traveling fields, created_at
- **spotme_hobby_categories** — id, slug, name, icon, sort_order (9 categories)
- **spotme_hobbies** — id, category_id, name, slug (shared dictionary)
- **spotme_user_hobbies** — id, user_id, hobby_id, proficiency, notes, is_active

Proficiency levels: want_to_learn, beginner, intermediate, advanced, expert

## API Endpoints

### Auth (Supabase Auth — signup/login handled client-side)
- `GET /api/v1/spotme/health`
- `POST /api/v1/spotme/auth/profile` — (authed) create/update profile after Supabase sign-up
- `GET /api/v1/spotme/auth/me` — (authed) full user profile
- `DELETE /api/v1/spotme/auth/me` — (authed) delete account

### Profile
- `PUT /api/v1/spotme/profile` — (authed) {display_name?, bio?, avatar_url?}
- `PUT /api/v1/spotme/profile/location` — (authed) {home_lat?, home_lng?, home_label?}
- `PUT /api/v1/spotme/profile/traveling` — (authed) {traveling_to_lat, traveling_to_lng, traveling_to_label, traveling_from, traveling_until}
- `DELETE /api/v1/spotme/profile/traveling` — (authed) clear traveling status
- `PUT /api/v1/spotme/profile/discoverable` — (authed) {is_discoverable}

### Hobbies
- `GET /api/v1/spotme/hobbies/categories` — list categories
- `GET /api/v1/spotme/hobbies?category_id=` — list hobbies
- `POST /api/v1/spotme/hobbies` — (authed) create custom hobby {name, category_id}
- `GET /api/v1/spotme/me/hobbies` — (authed) user's hobbies
- `POST /api/v1/spotme/me/hobbies` — (authed) add {hobby_id, proficiency, notes?}
- `PUT /api/v1/spotme/me/hobbies/{id}` — (authed) update {proficiency?, notes?, is_active?}
- `DELETE /api/v1/spotme/me/hobbies/{id}` — (authed) remove

## Screen Flow

```
Login <-> Register <-> Forgot Password
              |
              v
  Profile (home base, bio, hobbies summary)
     |
  Hobbies (browse by category, add/edit/remove)
     |
  Settings (recovery code, logout, delete account)
```

## Environment Variables

| Variable | Where | Purpose |
|---|---|---|
| `SPOTME_JWT_SECRET` | Railway | JWT signing secret |
