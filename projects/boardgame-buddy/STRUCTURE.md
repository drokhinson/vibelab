# BoardgameBuddy — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-03-27

## What It Does
A board game collection manager. Users browse the top 1000 BoardGameGeek-ranked games, build their closet (owned / played / wishlist), log game sessions with friends, and access quick-reference guides (setup reminders, turn summaries, rulebook links).

## Status
Prototype

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JS, DaisyUI v4 + Tailwind CDN, Lucide icons, Supabase JS SDK (CDN)
- **Backend:** Python FastAPI, Supabase (DB + Auth)
- **Auth:** Supabase Auth (email/password) — pilot for the whole monorepo
- **External API:** BoardGameGeek XML API v2 (for live search fallback)

## Data Model

### boardgamebuddy_games
Game catalog seeded from BGG top 1000.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| bgg_id | INTEGER UNIQUE | BoardGameGeek ID |
| name | TEXT | |
| year_published | INTEGER | |
| min_players | INTEGER | |
| max_players | INTEGER | |
| playing_time | INTEGER | minutes |
| description | TEXT | |
| image_url | TEXT | BGG box art |
| thumbnail_url | TEXT | |
| bgg_rank | INTEGER | overall rank |
| bgg_rating | NUMERIC(4,2) | average rating |
| categories | TEXT[] | e.g. Strategy, Card Game |
| mechanics | TEXT[] | e.g. Drafting, Set Collection |
| theme_color | TEXT | hex color for UI theming |
| created_at | TIMESTAMPTZ | |

### boardgamebuddy_profiles
Linked to Supabase Auth `auth.users`.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | references auth.users(id) |
| display_name | TEXT | |
| avatar_url | TEXT | nullable |
| created_at | TIMESTAMPTZ | |

### boardgamebuddy_collections
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID FK | → profiles |
| game_id | UUID FK | → games |
| status | TEXT | owned / played / wishlist |
| added_at | TIMESTAMPTZ | |
| UNIQUE(user_id, game_id) | | |

### boardgamebuddy_buddies
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| owner_id | UUID FK | → profiles |
| name | TEXT | typed name |
| linked_user_id | UUID FK | nullable → profiles |
| created_at | TIMESTAMPTZ | |

### boardgamebuddy_plays
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID FK | → profiles |
| game_id | UUID FK | → games |
| played_at | DATE | |
| notes | TEXT | nullable |
| created_at | TIMESTAMPTZ | |

### boardgamebuddy_play_players
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| play_id | UUID FK | → plays |
| buddy_id | UUID FK | → buddies |
| is_winner | BOOLEAN | |

### boardgamebuddy_guides
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| game_id | UUID FK | → games |
| quick_setup | TEXT | markdown |
| player_guide | TEXT | markdown |
| rulebook_url | TEXT | link to PDF |
| contributed_by | UUID FK | nullable → profiles |
| is_official | BOOLEAN | seed = true |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

## API Endpoints

### Public
- `GET /api/v1/boardgame_buddy/health`
- `GET /api/v1/boardgame_buddy/games` — paginated, search, filter
- `GET /api/v1/boardgame_buddy/games/{game_id}` — detail + guide
- `GET /api/v1/boardgame_buddy/games/search-bgg?query=` — proxy BGG API

### Auth Required
- `GET /api/v1/boardgame_buddy/profile`
- `POST /api/v1/boardgame_buddy/profile`
- `GET /api/v1/boardgame_buddy/collection`
- `POST /api/v1/boardgame_buddy/collection`
- `PATCH /api/v1/boardgame_buddy/collection/{game_id}`
- `DELETE /api/v1/boardgame_buddy/collection/{game_id}`
- `GET /api/v1/boardgame_buddy/plays`
- `POST /api/v1/boardgame_buddy/plays`
- `DELETE /api/v1/boardgame_buddy/plays/{play_id}`
- `GET /api/v1/boardgame_buddy/buddies`
- `POST /api/v1/boardgame_buddy/buddies/{buddy_id}/link`
- `GET /api/v1/boardgame_buddy/games/{game_id}/guide`
- `POST /api/v1/boardgame_buddy/games/{game_id}/guide`

## Screen Flow
1. Auth (login/signup) → 2. Browse games → 3. Game detail (themed) → 4. My Collection (tabs) → 5. Log Play → 6. Play History

## Environment Variables
| Variable | Where | Purpose |
|---|---|---|
| SUPABASE_URL | Railway + Vercel | Supabase project URL |
| SUPABASE_SERVICE_ROLE_KEY | Railway | Server-side DB access |
| SUPABASE_ANON_KEY | Vercel | Client-side Supabase Auth |
| SUPABASE_JWT_SECRET | Railway | Verify Supabase JWTs in backend |
| ALLOWED_ORIGINS | Railway | CORS |

## Active Development Notes
- Pilot project for Supabase Auth across the monorepo
- Hybrid data: pre-seeded top 1000 BGG games + live BGG API search
- Quick reference guides seeded for: Puerto Rico, Castles of Burgundy, Lost Cities, 7 Wonders
- Game detail pages themed with accent color + header image from box art
