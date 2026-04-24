# BoardgameBuddy — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-04-24

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

### boardgamebuddy_chunk_types (lookup)
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | `setup`, `player_turn`, `card_reference`, `scoring`, `tips`, `variant`, `rulebook` |
| label | TEXT | human label |
| icon | TEXT | lucide icon name |
| display_order | INT | sort in UI |

### boardgamebuddy_guide_chunks
Reusable chunks of guide content contributed by any authed user.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| game_id | UUID FK | → games |
| chunk_type | TEXT FK | → chunk_types |
| title | TEXT | short label |
| created_by | UUID FK | nullable → profiles (only creator can edit/delete) |
| layout | TEXT | `text` for now; future `table`, `grid` |
| content | TEXT | markdown for `text` layout |
| created_at / updated_at | TIMESTAMPTZ | |

### boardgamebuddy_guide_selections
Per-user ordered selection of chunks that assemble into that user's guide.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID FK | → profiles |
| game_id | UUID FK | → games |
| chunk_id | UUID FK | → guide_chunks |
| display_order | INT | position within the user's guide |

### boardgamebuddy_guides (legacy)
Flat guide table from the initial prototype. Retained temporarily during rollout
of the chunk system; will be dropped in a follow-up migration.

## API Endpoints

### Public
- `GET /api/v1/boardgame_buddy/health`
- `GET /api/v1/boardgame_buddy/games` — paginated, search, filter
- `GET /api/v1/boardgame_buddy/games/{game_id}` — detail (includes derived `bgg_url`)
- `GET /api/v1/boardgame_buddy/games/search-bgg?query=` — proxy BGG API
- `GET /api/v1/boardgame_buddy/games/{game_id}/chunks` — all guide chunks for a game
- `GET /api/v1/boardgame_buddy/chunk-types` — chunk type lookup

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
- `POST /api/v1/boardgame_buddy/games/{game_id}/chunks` — contribute a new chunk
- `PATCH /api/v1/boardgame_buddy/chunks/{chunk_id}` — edit own chunk
- `DELETE /api/v1/boardgame_buddy/chunks/{chunk_id}` — delete own chunk
- `GET /api/v1/boardgame_buddy/games/{game_id}/my-guide` — this user's chunk selection
- `PUT /api/v1/boardgame_buddy/games/{game_id}/my-guide` — replace selection (ordered)

### Admin (ADMIN_API_KEY)
- `POST /api/v1/boardgame_buddy/guides/import?force=<bool>` — bulk import a guide bundle produced by the `/guide-from-rulebook` slash command. Request body = `GuideBundle` JSON (see below). If the referenced game isn't in `boardgamebuddy_games`, the endpoint calls the existing BGG import flow. `force=true` deletes existing chunks with `created_by IS NULL` for the game before inserting (user chunks are preserved). Dedupe key: `(game_id, chunk_type, title)`.

#### GuideBundle schema
```json
{
  "version": 1,
  "game": { "bgg_id": 68448, "name": "7 Wonders" },
  "source": {
    "generated_at": "2026-04-24T00:00:00Z",
    "generator": "guide-from-rulebook@2",
    "rulebook_urls": [{ "url": "...", "label": "Publisher EN", "source": "publisher" }],
    "missing": ["variant"]
  },
  "chunks": [
    { "chunk_type": "setup",        "title": "Components & Dealing", "content": "markdown", "layout": "text" },
    { "chunk_type": "player_turn",  "title": "Turn Actions",         "content": "markdown", "layout": "text" },
    { "chunk_type": "rulebook",     "title": "Official Rulebook (PDF)", "content": "https://…pdf", "layout": "text" }
  ]
}
```
`chunk_type` must be one of the seven IDs in `boardgamebuddy_chunk_types`. Up to 25 chunks per bundle (7 specialist agents × 3 max each).

### Admin UI
- `?admin=1` in the URL reveals a shield icon in the header. Clicking it opens the `admin-guides` view, which accepts a JSON bundle file and POSTs it to the import endpoint with the admin API key stored in `sessionStorage.bgbAdminKey`.

## Screen Flow
1. Auth (login/signup) → 2. **Closet** (home: shelves for Owned / Played / Wish as book-spines, with list-view toggle and sort by Alphabetical or Last Played; in-closet search filters your games) → 3. Tap a spine → pull-down animation → Game detail (themed, with Log Play + guide) → 4. Log Play → 5. Play History. "+ Add Game" from the Closet opens the Browse catalog (BGG top 1000 + live BGG search).

## Environment Variables
| Variable | Where | Purpose |
|---|---|---|
| SUPABASE_URL | Railway + Vercel | Supabase project URL |
| SUPABASE_SERVICE_ROLE_KEY | Railway | Server-side DB access |
| SUPABASE_ANON_KEY | Vercel | Client-side Supabase Auth |
| SUPABASE_JWT_SECRET | Railway | Verify Supabase JWTs in backend |
| ALLOWED_ORIGINS | Railway | CORS |
| ADMIN_API_KEY | Railway | Protects `POST /guides/import` (admin guide upload) |

## Active Development Notes
- Pilot project for Supabase Auth across the monorepo
- Hybrid data: pre-seeded top 1000 BGG games + live BGG API search
- Quick reference guides seeded for: Puerto Rico, Castles of Burgundy, Lost Cities, 7 Wonders
- Guides can now be generated agentically via `/guide-from-rulebook <game name>`, which writes a JSON bundle to `projects/boardgame-buddy/web/sample-guides/<slug>.json` for an admin to upload through `?admin=1`.
- Game detail pages themed with accent color + header image from box art
