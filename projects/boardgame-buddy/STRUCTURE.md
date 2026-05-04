# BoardgameBuddy — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-04-26 (migration 044)

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
| categories | TEXT[] | e.g. Strategy, Card Game |
| mechanics | TEXT[] | e.g. Drafting, Set Collection |
| theme_color | TEXT | hex color for UI theming |
| is_expansion | BOOLEAN | default false; true when this row is an expansion of another game |
| base_game_bgg_id | INTEGER | nullable; BGG id of the base game this expansion extends (no FK — expansions may be imported before their base game) |
| expansion_color | TEXT | nullable; auto-assigned at import for the expansion-dot UI (admin-overridable) |
| rulebook_url | TEXT | nullable; official rulebook URL surfaced as a link card on the game's reference guide. Per-game metadata, not a chunk |
| created_at | TIMESTAMPTZ | |

### boardgamebuddy_profiles
Linked to Supabase Auth `auth.users`.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | references auth.users(id) |
| display_name | TEXT | |
| avatar_url | TEXT | nullable |
| is_admin | BOOLEAN | default false; granted via `POST /profile/become-admin` with the shared admin key |
| bgg_username | TEXT | nullable; linked BoardGameGeek username (migration 062). Unique when non-null. |
| created_at | TIMESTAMPTZ | |

### boardgamebuddy_pending_guides
Review queue for guide bundles uploaded by non-admin users.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| uploader_id | UUID FK | → profiles |
| game_name | TEXT | |
| bgg_id | INTEGER | nullable |
| chunk_count | INTEGER | |
| bundle | JSONB | the full GuideBundle payload |
| status | TEXT | `pending` / `approved` / `rejected` |
| review_notes | TEXT | nullable |
| reviewed_by | UUID FK | nullable → profiles |
| reviewed_at | TIMESTAMPTZ | nullable |
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
A buddy is a person you've played with — auto-created on play log by name.
Free-text by default; can be linked to a real BoardgameBuddy account, at which
point the linked profile's display name is shown everywhere and the linked user
sees those plays in their own log. Linking is one-way and consolidates: linking
a second buddy of yours to the same account merges into the first.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| owner_id | UUID FK | → profiles |
| name | TEXT | typed name; rewritten to linked profile's display_name on link |
| linked_user_id | UUID FK | nullable → profiles |
| created_at | TIMESTAMPTZ | |
| UNIQUE(owner_id, name) | | |
| UNIQUE(owner_id, linked_user_id) WHERE linked_user_id IS NOT NULL | | one linked row per (owner, target) |

### boardgamebuddy_plays
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID FK | → profiles |
| game_id | UUID FK | → games |
| played_at | DATE | |
| notes | TEXT | nullable |
| bgg_play_id | BIGINT | nullable; set when the row was imported from BGG (migration 062). Unique per (user_id, bgg_play_id) — re-running BGG sync is idempotent. |
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
| id | TEXT PK | `setup`, `player_turn`, `card_reference`, `scoring`, `tips` (the legacy `rulebook` type was promoted to `boardgamebuddy_games.rulebook_url` in migration 048) |
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

### boardgamebuddy_user_expansions
Per-user toggle: presence of a row means the user has enabled that expansion
for its base game, which merges the expansion's default chunks into the
user's reference guide.
| Column | Type | Notes |
|--------|------|-------|
| user_id | UUID FK | → profiles, PK part 1 |
| expansion_game_id | UUID FK | → games (the expansion), PK part 2 |
| enabled_at | TIMESTAMPTZ | |

### boardgamebuddy_guides (legacy)
Flat guide table from the initial prototype. Retained temporarily during rollout
of the chunk system; will be dropped in a follow-up migration.

### boardgamebuddy_bgg_pending_imports
Staging queue for BGG syncs (migration 062). When a user's collection or play
references a `bgg_id` we don't yet have in `boardgamebuddy_games`, the desired
write is persisted here and a background worker drains the queue after fetching
each missing game from the BGG XML API.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID FK | → profiles |
| bgg_id | INTEGER | the missing BGG game id |
| kind | TEXT | `collection` or `play` |
| payload | JSONB | collection: `{status}`. play: `{bgg_play_id, played_at, notes, players[]}`. |
| status | TEXT | `pending` / `done` / `error` |
| error_message | TEXT | populated when status='error' |
| attempts | INT | retry count; promotes to `error` after 3 |
| created_at / completed_at | TIMESTAMPTZ | |
| UNIQUE(user_id, bgg_id, kind) WHERE status='pending' | | one pending row per (user, game, kind) |

## API Endpoints

### Public
- `GET /api/v1/boardgame_buddy/health`
- `GET /api/v1/boardgame_buddy/games` — paginated, search, filter. Supports `players`, `playtime_min/max`, `mechanics` (AND logic), and `owned_only=true` (requires bearer token; intersected with the caller's `boardgamebuddy_collections` rows where `status='owned'`)
- `GET /api/v1/boardgame_buddy/games/{game_id}` — detail (includes derived `bgg_url`)
- `GET /api/v1/boardgame_buddy/games/search-bgg?query=` — proxy BGG API
- `GET /api/v1/boardgame_buddy/games/lookup-by-bgg/{bgg_id}` — null-or-`GameSummary`; the import preview uses this to label a bundle as "new game" vs "existing game"
- `GET /api/v1/boardgame_buddy/games/{game_id}/chunks` — all guide chunks for a game
- `GET /api/v1/boardgame_buddy/games/{game_id}/expansions` — list expansions linked to this base game; `is_enabled` reflects the caller's own toggle when authenticated, `false` otherwise. Each item includes the expansion's `rulebook_url` so the frontend can render expansion-rulebook links at the bottom of the Quick Reference when the toggle is on
- `GET /api/v1/boardgame_buddy/chunk-types` — chunk type lookup

### Auth Required
- `GET /api/v1/boardgame_buddy/profile`
- `POST /api/v1/boardgame_buddy/profile`
- `POST /api/v1/boardgame_buddy/profile/become-admin` — body `{admin_key}`; sets `is_admin=true` if the key matches `ADMIN_API_KEY`
- `GET /api/v1/boardgame_buddy/profiles/search?q=` — search other users by display name (returns id, display_name, email) for buddy linking
- `DELETE /api/v1/boardgame_buddy/profile` — delete current user's account and data
- `GET /api/v1/boardgame_buddy/collection`
- `POST /api/v1/boardgame_buddy/collection`
- `PATCH /api/v1/boardgame_buddy/collection/{game_id}`
- `DELETE /api/v1/boardgame_buddy/collection/{game_id}`
- `GET /api/v1/boardgame_buddy/plays` — own plays plus shared plays (where the current user is a linked buddy). Each play includes `is_own`, `logged_by_id`, `logged_by_name`.
- `POST /api/v1/boardgame_buddy/plays`
- `DELETE /api/v1/boardgame_buddy/plays/{play_id}` — only the original logger can delete
- `GET /api/v1/boardgame_buddy/buddies` — alphabetical list with `linked_display_name` and `play_count`
- `POST /api/v1/boardgame_buddy/buddies/{buddy_id}/link` — body `{user_id}`; one-way link, merges any of the owner's other buddies that already linked to (or have the display name of) the target
- `POST /api/v1/boardgame_buddy/bgg/link` — body `{username, password}`; logs into BGG via `POST /login/api/v1`, stores the username + Fernet-encrypted password (`BGG_CREDENTIAL_KEY`) and the returned SessionID/bggusername/bggpassword cookies on the profile. A successful login is also our existence check (BGG returns 401 for both bad passwords and unknown handles, surfaced as a 400 to the client). Returns `{bgg_username}`.
- `DELETE /api/v1/boardgame_buddy/bgg/link` — clear `bgg_username` plus all stored credentials/cookies. Already-imported collection/plays remain in place.
- `POST /api/v1/boardgame_buddy/bgg/sync` — pull collection (`own=1`, `wishlist=1`, `wanttoplay=1`, `showprivate=1`) and plays (paginated) from BGG. Per-user calls go through `fetch_bgg_as_user`, which sends the stored cookies so BGG evaluates the request AS the linked user — that's what unlocks the `<privateinfo>` block (purchase price, private comment, acquisition date, …) which we mirror onto `boardgamebuddy_collections.bgg_*` columns. BGG `own→owned`; `wishlist` and `wanttoplay` both map to `'wishlist'`. Games we already have are written immediately (collections upsert on `(user_id, game_id)`; plays dedup on `(user_id, bgg_play_id)`). Games we don't have go into `boardgamebuddy_bgg_pending_imports` (the `payload.private` carries the private fields through to materialization) and a `BackgroundTasks` worker drains the queue (~1.5s between BGG calls). Returns `{bgg_username, collection_imported, collection_pending, plays_imported, plays_pending}`. Players from BGG plays are upserted as buddies on `(owner_id, name)` using the same path as `POST /plays`. If the stored password no longer works, returns 409 — the FE surfaces a "re-link required" banner.
- `POST /api/v1/boardgame_buddy/bgg/sync/process-pending` — manual fallback to drain the pending queue (e.g. after a process restart cut a BackgroundTask short). Idempotent.
- `GET /api/v1/boardgame_buddy/bgg/sync/status` — `{bgg_username, auth_state, pending_count, errored_count, last_completed_at}`. `auth_state` is `unlinked` / `linked` / `relink_required`; the Account tab polls this every 3s while `pending_count > 0` and uses `auth_state` to choose between the link form, the re-link prompt, and the synced view.
- `POST /api/v1/boardgame_buddy/games/{game_id}/chunks` — contribute a new chunk
- `PATCH /api/v1/boardgame_buddy/chunks/{chunk_id}` — edit own chunk
- `DELETE /api/v1/boardgame_buddy/chunks/{chunk_id}` — delete own chunk
- `GET /api/v1/boardgame_buddy/games/{game_id}/my-guide` — this user's chunk selection. Default chunks of any expansion the user has toggled on are merged in; each merged chunk's response carries an `expansion: {expansion_game_id, name, color}` object so the UI can render the source dot.
- `PUT /api/v1/boardgame_buddy/games/{game_id}/my-guide` — replace selection (ordered). Accepts chunk ids from the base game OR any enabled expansion.
- `POST /api/v1/boardgame_buddy/games/{base_id}/expansions/{expansion_id}/toggle` — body `{is_enabled}`; per-user enable/disable. Inserts or deletes one row in `boardgamebuddy_user_expansions`.
- `PATCH /api/v1/boardgame_buddy/games/admin/{game_id}/expansion-color` — *admin-only* override the auto-assigned `expansion_color`
- `POST /api/v1/boardgame_buddy/guides/submit` — upload a GuideBundle. Admin users import directly; everyone else's submission is queued for admin review.
- `GET /api/v1/boardgame_buddy/guides/pending` — *admin-only* list of pending submissions
- `GET /api/v1/boardgame_buddy/guides/pending/{id}` — *admin-only* fetch full bundle. Response includes `game_exists` and `existing_game` so the review UI can show a NEW vs EXISTING banner without a second round-trip.
- `POST /api/v1/boardgame_buddy/guides/pending/{id}/approve` — *admin-only* import. Per-chunk `is_default` from the override bundle decides which chunks land in the curated default guide; by default community-submitted chunks are non-default. When the bundle has full metadata for a new game, image hydration runs best-effort — failures surface as `image_fetch_warning` instead of blocking approval.
- `POST /api/v1/boardgame_buddy/guides/pending/{id}/reject` — *admin-only* reject
- `GET  /api/v1/boardgame_buddy/games/admin/missing-images` — *admin-only* list of games whose `image_url` or `thumbnail_url` is NULL
- `POST /api/v1/boardgame_buddy/games/admin/{game_id}/refresh-images` — *admin-only* re-fetch one game's box art + thumbnail from BGG and re-host in Storage
- `POST /api/v1/boardgame_buddy/games/refresh-images` — *admin-only* bulk refresh of all games with missing or BGG-hosted image URLs

### Admin (ADMIN_API_KEY)
- `POST /api/v1/boardgame_buddy/guides/import?force=<bool>` — bulk import a guide bundle produced by the `/guide-from-rulebook` slash command. Request body = `GuideBundle` JSON (see below). If the referenced game isn't in `boardgamebuddy_games`, the endpoint calls the existing BGG import flow. `force=true` deletes existing chunks with `created_by IS NULL` for the game before inserting (user chunks are preserved). Dedupe key: `(game_id, chunk_type, title)`.

#### GuideBundle schema
If `min_players`, `max_players`, and `playing_time` are all present in the bundle's `game` object, `/guides/import` skips the BGG XML API call and inserts the game directly. `image_url` / `thumbnail_url` stay NULL on that path — admins backfill them from the Import screen → "Refresh missing images". Otherwise the import falls back to the existing BGG-fetch flow.
```json
{
  "version": 1,
  "game": {
    "bgg_id": 68448,
    "name": "7 Wonders",
    "min_players": 2,
    "max_players": 7,
    "playing_time": 30,
    "bgg_url": "https://boardgamegeek.com/boardgame/68448",
    "is_expansion": false,
    "base_game_bgg_id": null,
    "rulebook_url": "https://example.com/7-wonders-rulebook.pdf"
  },
  "source": {
    "generated_at": "2026-04-24T00:00:00Z",
    "generator": "guide-from-rulebook@2",
    "rulebook_urls": [{ "url": "...", "label": "Publisher EN", "source": "publisher" }],
    "missing": ["variant"]
  },
  "chunks": [
    { "chunk_type": "setup",        "title": "Components & Dealing", "content": "markdown", "layout": "text" },
    { "chunk_type": "player_turn",  "title": "Turn Actions",         "content": "markdown", "layout": "text" }
  ]
}
```
`chunk_type` must be one of the IDs in `boardgamebuddy_chunk_types` (`setup`, `player_turn`, `card_reference`, `scoring`, `tips`). The rulebook URL is per-game metadata at `game.rulebook_url`, not a chunk. Up to 25 chunks per bundle. Legacy bundles that still carry a `chunk_type='rulebook'` chunk are accepted: the importer migrates the URL into `boardgamebuddy_games.rulebook_url` and drops the chunk.

When the bundle's `game.is_expansion` is true, the import flow stamps `is_expansion`, `base_game_bgg_id`, and (if not already set) auto-assigns `expansion_color` from the palette in `boardgame_buddy/constants.py`. The expansion then surfaces in the base game's `GET /games/{id}/expansions` response with `is_enabled=false` until the viewer flips the toggle.

### Admin UI
- Promote via **Profile** screen → "Become admin" → enter `ADMIN_API_KEY`. Server sets `profiles.is_admin=true`; the client then exposes the admin-only controls (direct imports and pending-review list) inside the **Import** screen.

## Screen Flow
Bottom nav has three tabs: **Browse**, **Closet**, **Play Log**.

1. Auth (login/signup) → 2. **Closet** (home): list view of Owned/Played (toggleable to shelf/book-spine view), plus a Wishlist tab. In-closet search filters your games. → 3. Tap a row/spine → Game detail (themed, with Log Play + guide).
4. **Browse** tab: list of available games (BGG top 1000 + search). "Import games" button opens the Import screen.
5. **Play Log** tab: history of plays. The global floating "+" button (visible on every authed view) opens a live **session bubble** with game + players + per-round score grid + notes. The bubble can be minimized back into the FAB while the session stays alive in browser memory, so the user can flip to the Quick Reference guide for the game and come back. Reloading the page discards any in-progress session — only the explicit Save action writes to the database. On Save, the winner is computed (highest total, or manual override) and persisted to `boardgamebuddy_play_players`; per-round scores are not stored.
6. **Import** screen: *Import from BoardGameGeek* (live BGG API search + add), *Import from file* (upload a GuideBundle JSON — admins import directly, others queue for review), *Review pending additions* (admin only), *Download Guide Builder instructions* (downloads `guide-from-rulebook.md` so users can feed the prompt into their own AI).
7. **Profile** (click username in header): two tabs.
   - **Account:** display name, email, become-admin, delete account.
   - **Buddies:** alphabetical list of everyone you've played with and how many games. A free-text buddy has a "Link" button that opens a search-by-display-name modal (with email shown for tiebreaking) — picking a result one-way links the buddy to that BoardgameBuddy account, merges any other buddies of yours that point to the same person, and from then on those plays appear in the linked user's own Play Log (read-only, badged "logged by …"). Future: link BGG account.

## Environment Variables
| Variable | Where | Purpose |
|---|---|---|
| SUPABASE_URL | Railway + Vercel | Supabase project URL |
| SUPABASE_SERVICE_ROLE_KEY | Railway | Server-side DB access |
| SUPABASE_ANON_KEY | Vercel | Client-side Supabase Auth |
| SUPABASE_JWT_SECRET | Railway | Verify Supabase JWTs in backend |
| ALLOWED_ORIGINS | Railway | CORS |
| ADMIN_API_KEY | Railway | Protects `POST /guides/import` (admin guide upload) |
| BGG_API_TOKEN | Railway | BoardGameGeek app-registration bearer token (rate-limit accounting; not user-scoped) |
| BGG_CREDENTIAL_KEY | Railway | Fernet key (urlsafe base64) used to encrypt linked users' BGG passwords. Generate via `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Rotating it forces every BGG-linked user to re-link. |

## Active Development Notes
- Pilot project for Supabase Auth across the monorepo
- Hybrid data: pre-seeded top 1000 BGG games + live BGG API search
- Quick reference guides seeded for: Puerto Rico, Castles of Burgundy, Lost Cities, 7 Wonders
- Guides can now be generated agentically via `/guide-from-rulebook <game name>`, which writes a JSON bundle to `projects/boardgame-buddy/web/sample-guides/<slug>.json` for an admin to upload through `?admin=1`.
- Game detail pages themed with accent color + header image from box art
- BGG XML API has a daily request quota. Imports prefer bundle metadata (skips the API call when player counts + playtime are present); image refresh is admin-gated and sequential to spread requests across the day.
