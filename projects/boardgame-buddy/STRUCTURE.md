# BoardgameBuddy — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-05-17 (reference guide rebuilt as user-owned "chapters" — migration 018; in-play expansions picker + merged reference guide added the same day)

## What It Does
A Strava-style log for board game plays. The home view is a chronological feed of plays from the user and their accepted buddies, interspersed with "hot games this week", suggested buddies, and dormant games from the user's own collection. Logging a play supports a short-code "join from another phone" flow so the host's device opens a session code that other phones join to add themselves to the player list. Profiles are fully public and show a Strava-style stats strip + collection grid. The reference-guide system is fully user-driven: each user builds their own per-game guide by adding "chapters" — either creating new ones or browsing the community pool. The pool sorts by popularity. Reports on offensive chapters route to admin review.

Logging a play also surfaces the reference guide in-line: once a game is picked, a collapsed Expansions section lets the player toggle which expansions are active for this session, and a Reference guide section appears below Scoring with a centered Rulebook button + the parchment scroll merging chapters from the base game and every active expansion (each tagged with a colored dot matching the expansion's identity color). Adding chapters from this in-play scroll routes through the same Browse/Create UI, with each chapter saved against its source game's pool so it propagates automatically the next time the user opens the guide.

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
| rulebook_url | TEXT | nullable; official rulebook URL surfaced as a link card on the game detail page |
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

### boardgamebuddy_chapter_types (lookup)
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | `setup`, `player_turn`, `card_reference`, `scoring`, `tips`, `variant` |
| label | TEXT | human label |
| icon | TEXT | lucide icon name |
| display_order | INT | sort in UI |

### boardgamebuddy_guide_chapters
Reference-guide chapters contributed by users. Each chapter belongs to one
game; there are no admin-curated defaults. Chapters surface in the per-game
browse pool sorted by popularity.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| game_id | UUID FK | → games |
| chapter_type | TEXT FK | → chapter_types |
| title | TEXT | short label |
| created_by | UUID FK | nullable → profiles (creator can edit; creator or admin can delete) |
| layout | TEXT | `text` for now; future `table`, `grid` |
| content | TEXT | markdown |
| created_at / updated_at | TIMESTAMPTZ | |

### boardgamebuddy_user_chapters
Presence row: this chapter is in the user's guide for that game.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID FK | → profiles |
| game_id | UUID FK | → games |
| chapter_id | UUID FK | → guide_chapters |
| display_order | INT | reserved for future reorder UI; V1 sorts by `created_at` |
| created_at | TIMESTAMPTZ | when the user added the chapter |
| UNIQUE(user_id, chapter_id) | | one row per user-chapter pair |

### boardgamebuddy_chapter_reports
User-submitted moderation reports against a chapter. Admins resolve
(`status='resolved'`) or delete the chapter outright (cascade removes
the report).
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| chapter_id | UUID FK | → guide_chapters |
| reporter_id | UUID FK | → profiles |
| reason | TEXT | nullable user-provided reason |
| status | TEXT | `open` / `resolved` |
| resolved_by | UUID FK | nullable → profiles |
| resolved_at | TIMESTAMPTZ | nullable |
| created_at | TIMESTAMPTZ | |
| UNIQUE(chapter_id, reporter_id) | | one report per user per chapter |

### boardgamebuddy_user_expansions
Per-user expansion toggle from the previous design. Retained but unused
by the new chapter system; each game (including expansions) has its own
guide. Drop in a follow-up.

### boardgamebuddy_guides (legacy)
Flat guide table from the initial prototype. Retained as a historical
no-op; drop in a follow-up.

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
- `GET /api/v1/boardgame_buddy/games/{game_id}/chapter-pool` — browse the pool of existing chapters for a game. Each row carries `popularity` (count of users who have it) and `in_my_guide` (whether the caller has it). Sorted by `popularity DESC, created_at DESC`. Supports `?q=` (title+content ILIKE), `?chapter_type=`, and `?expansion_ids=a,b,c` (comma-separated game UUIDs to merge into the pool — each merged row carries `source_game_id` / `source_game_name` / `source_color` so the FE can render colored dots tying chapters to their expansion). Auth optional — anon callers always see `in_my_guide=false`.
- `GET /api/v1/boardgame_buddy/games/{game_id}/expansions` — list expansions linked to this base game; `is_enabled` reflects the caller's own toggle when authenticated, `false` otherwise. Each item includes the expansion's `rulebook_url`.
- `GET /api/v1/boardgame_buddy/chapter-types` — chapter type lookup

### Auth Required
- `GET /api/v1/boardgame_buddy/profile`
- `POST /api/v1/boardgame_buddy/profile`
- `POST /api/v1/boardgame_buddy/profile/become-admin` — body `{admin_key}`; sets `is_admin=true` if the key matches `ADMIN_API_KEY`
- `GET /api/v1/boardgame_buddy/profiles/search?q=` — search other users by display name (returns id, display_name, email) for buddy linking
- `DELETE /api/v1/boardgame_buddy/profile` — delete current user's account and data
- `GET /api/v1/boardgame_buddy/collection` — flat list (legacy shape, list[CollectionItem])
- `GET /api/v1/boardgame_buddy/collection/grid` — paginated owned collection sorted by `last_played_at DESC NULLS LAST, added_at DESC`. Supports `search`, `players`, `playtime_min/max`, `play_mode`, `exclude_expansions` (default true), and `user_id` (target user; defaults to the viewer — profiles are public). Two round-trips: collection+game join, then plays for the matching set.
- `POST /api/v1/boardgame_buddy/collection`
- `PATCH /api/v1/boardgame_buddy/collection/{game_id}`
- `DELETE /api/v1/boardgame_buddy/collection/{game_id}`
- `GET /api/v1/boardgame_buddy/plays` — paginated plays the target user logged + participated in. Each play includes `is_own`, `logged_by_id`, `logged_by_name`. Supports `page`, `per_page`, `game_id`, `buddy_id` (treated as a player_user_id filter post-migration-009), `search` (free-text match on game name OR any player's display name), and `user_id` (target user; defaults to the viewer — profiles are public).
- `POST /api/v1/boardgame_buddy/plays`
- `DELETE /api/v1/boardgame_buddy/plays/{play_id}` — only the original logger can delete
- `GET /api/v1/boardgame_buddy/buddies` — accepted mutual edges only (mutual graph, migration 008). Returns `BuddyEdgeResponse[]`
- `GET /api/v1/boardgame_buddy/buddies/requests` — pending requests in both directions: `{incoming[], outgoing[]}`
- `POST /api/v1/boardgame_buddy/buddies/request` — body `{target_user_id}`; auto-accepts if a reverse request exists
- `POST /api/v1/boardgame_buddy/buddies/{request_id}/accept` — accept incoming request
- `POST /api/v1/boardgame_buddy/buddies/{request_id}/reject` — delete a pending request
- `DELETE /api/v1/boardgame_buddy/buddies/{edge_id}` — unfriend (either party can call)
- `GET /api/v1/boardgame_buddy/played-with` — real-account players the viewer has shared a play with (carries buddy-relation flags so the FE can show a quick-add affordance for non-buddies)
- `GET /api/v1/boardgame_buddy/ghost-players` — free-text nicknames the viewer recorded in plays without an account, grouped with play counts + last-played date
- `POST /api/v1/boardgame_buddy/ghost-players/link` — promote a ghost nickname to a real account (body `{display_name, target_user_id}`); stamps player_user_id on every matching play_players row the viewer logged
- `GET /api/v1/boardgame_buddy/feed?cursor=&limit=20` — Strava-style mixed feed (plays + hot games + suggested buddies + featured-from-collection). Cursor-paginated via `created_at`.
- `GET /api/v1/boardgame_buddy/hot-games?window_days=7` — most-played games in window
- `GET /api/v1/boardgame_buddy/suggestions/buddies` — friends-of-friends candidates
- `GET /api/v1/boardgame_buddy/suggestions/featured-from-collection` — dormant owned games
- `GET /api/v1/boardgame_buddy/users/me/stats` — Strava-style aggregate stats for the current user
- `GET /api/v1/boardgame_buddy/users/{user_id}/stats` — same shape for any user (profiles are public)
- `GET /api/v1/boardgame_buddy/users/{user_id}/profile` — public profile + buddy-relation flags
- `GET /api/v1/boardgame_buddy/search?q=&include_bgg=false` — unified game search (collection → DB; BGG only when `include_bgg=true`)
- `POST /api/v1/boardgame_buddy/sessions` — open a short-code play session (body `{game_id?}`)
- `GET /api/v1/boardgame_buddy/sessions/{code}` — poll target for the lobby
- `POST /api/v1/boardgame_buddy/sessions/{code}/join` — join a session by code
- `DELETE /api/v1/boardgame_buddy/sessions/{code}` — host abandons a session
- `POST /api/v1/boardgame_buddy/sessions/{code}/finalize` — write a play row from the session
- `POST /api/v1/boardgame_buddy/bgg/link` — body `{username, password}`; logs into BGG via `POST /login/api/v1`, stores the username + Fernet-encrypted password (`BGG_CREDENTIAL_KEY`) and the returned SessionID/bggusername/bggpassword cookies on the profile. A successful login is also our existence check (BGG returns 401 for both bad passwords and unknown handles, surfaced as a 400 to the client). Returns `{bgg_username}`.
- `DELETE /api/v1/boardgame_buddy/bgg/link` — clear `bgg_username` plus all stored credentials/cookies. Already-imported collection/plays remain in place.
- `POST /api/v1/boardgame_buddy/bgg/sync` — pull collection (`own=1`, `wishlist=1`, `wanttoplay=1`, `showprivate=1`) and plays (paginated) from BGG. Per-user calls go through `fetch_bgg_as_user`, which sends the stored cookies so BGG evaluates the request AS the linked user — that's what unlocks the `<privateinfo>` block (purchase price, private comment, acquisition date, …) which we mirror onto `boardgamebuddy_collections.bgg_*` columns. BGG `own→owned`; `wishlist` and `wanttoplay` both map to `'wishlist'`. Games we already have are written immediately (collections upsert on `(user_id, game_id)`; plays dedup on `(user_id, bgg_play_id)`). Games we don't have go into `boardgamebuddy_bgg_pending_imports` (the `payload.private` carries the private fields through to materialization) and a `BackgroundTasks` worker drains the queue (~1.5s between BGG calls). Returns `{bgg_username, collection_imported, collection_pending, plays_imported, plays_pending}`. Players from BGG plays are upserted as buddies on `(owner_id, name)` using the same path as `POST /plays`. If the stored password no longer works, returns 409 — the FE surfaces a "re-link required" banner.
- `POST /api/v1/boardgame_buddy/bgg/sync/process-pending` — manual fallback to drain the pending queue (e.g. after a process restart cut a BackgroundTask short). Idempotent.
- `GET /api/v1/boardgame_buddy/bgg/sync/status` — `{bgg_username, auth_state, pending_count, errored_count, last_completed_at}`. `auth_state` is `unlinked` / `linked` / `relink_required`; the Account tab polls this every 3s while `pending_count > 0` and uses `auth_state` to choose between the link form, the re-link prompt, and the synced view.
- `POST /api/v1/boardgame_buddy/games/{game_id}/chapters` — create a brand-new chapter (type + title + markdown) and auto-add to the creator's guide
- `PATCH /api/v1/boardgame_buddy/chapters/{chapter_id}` — edit own chapter (creator-only)
- `DELETE /api/v1/boardgame_buddy/chapters/{chapter_id}` — delete from pool (creator or admin); cascades to user_chapters + reports
- `POST /api/v1/boardgame_buddy/chapters/{chapter_id}/report` — body `{reason?}`; flag a chapter for admin moderation. Idempotent per user.
- `GET /api/v1/boardgame_buddy/games/{game_id}/my-chapters` — chapters the caller has added to their guide for this game (empty list when none). Supports `?expansion_ids=a,b,c` to also merge in chapters from the listed expansions in one round-trip; each row carries `source_game_id` / `source_game_name` / `source_color` for FE colored-dot rendering.
- `POST /api/v1/boardgame_buddy/games/{game_id}/my-chapters` — body `{chapter_id}`; add an existing pool chapter to my guide (idempotent)
- `DELETE /api/v1/boardgame_buddy/games/{game_id}/my-chapters/{chapter_id}` — remove from my guide (does NOT delete the chapter)
- `POST /api/v1/boardgame_buddy/games/{base_id}/expansions/{expansion_id}/toggle` — body `{is_enabled}`; per-user expansion toggle (currently a no-op for the reference guide; the toggle table is retained but the chapter system no longer reads it)
- `PATCH /api/v1/boardgame_buddy/games/admin/{game_id}/expansion-color` — *admin-only* override the auto-assigned `expansion_color`
- `GET /api/v1/boardgame_buddy/admin/chapter-reports?status=open|resolved` — *admin-only* list chapter moderation reports
- `POST /api/v1/boardgame_buddy/admin/chapter-reports/{report_id}/resolve` — *admin-only* mark a report resolved with no further action
- `GET  /api/v1/boardgame_buddy/games/admin/missing-images` — *admin-only* list of games whose `image_url` or `thumbnail_url` is NULL
- `POST /api/v1/boardgame_buddy/games/admin/{game_id}/refresh-images` — *admin-only* re-fetch one game's box art + thumbnail from BGG and re-host in Storage
- `POST /api/v1/boardgame_buddy/games/refresh-images` — *admin-only* bulk refresh of all games with missing or BGG-hosted image URLs

### Admin UI
- Promote via **Settings** screen → "Have an admin key?" → enter `ADMIN_API_KEY`. Server sets `profiles.is_admin=true`; the client then exposes the **Admin** screen with the chapter-reports moderation panel.

## Screen Flow
Bottom nav has three tabs: **Feed**, **Log**, **Profile**.

1. Auth (login/signup) → splash → 2. **Feed** (home): chronological mix of plays from the viewer and their accepted buddies, plus inline "hot this week" / "buddies you may know" / "time to revisit" rails. A search pill at the top opens the **Game Search** screen.
3. **Log a play**: pick a game (Game Search → Game Detail → Log Play, or directly from the Log tab), add players (buddies via autocomplete, free-text otherwise), and Save. Three modes are surfaced as tabs at the top of the Log Play view:
   - **Solo log** — host fills the form alone.
   - **Host a session** — open a 5-char code; other phones POST `/sessions/{code}/join` to add themselves; the host polls `/sessions/{code}` every 2s and the participant list streams into the player list. Save calls `/sessions/{code}/finalize` which writes a single play.
   - **Join by code** — enter a host's code to add yourself to their session.
   The draft auto-persists to localStorage (metadata only); the photo blob stays in memory.
4. **Game Search** (search pill on Feed/Profile): single ranked list — collection hits first, then DB matches. A "Search BoardGameGeek for more" button appends BGG hits on demand.
5. **Game Detail** (tap any game card): box art hero, status toggle (none → owned → wishlist → none), Log a Play button, BGG + Rulebook links, collapsible Expansions section (default collapsed), a rolled-up parchment **Reference Guide scroll** (tap either roll to open/close), and recent plays. The scroll is per-user per-game and starts empty; tap **Add a chapter** at the bottom to either Create a new one or Browse the community pool.
6. **Reference guide chapter add**: full-screen view with two tabs — **Create** (chapter-type picker + title + markdown) or **Browse** (search the per-game pool, sorted by popularity, tap + to add). Each browseable row also has a **Report** action for moderation.
7. **Profile** (own): Strava-style stats strip (plays / games / wins / hours), collection grid, recent plays. Admin users get an "Admin tools" link.
8. **Profile (other user)**: fully public — same stats strip + collection grid for any account. The header surfaces buddy-state ("Add buddy" / "Accept request" / "Request sent" / "Buddies").
9. **Buddies**: accepted mutual edges, plus incoming and outgoing pending requests. Search-by-display-name to send a new request.
10. **Admin tools**: chapter-reports moderation. Each row has Resolve (no action) and Delete chapter (remove from the pool). (Reachable only when `is_admin=true`.)

## Environment Variables
| Variable | Where | Purpose |
|---|---|---|
| SUPABASE_URL | Railway + Vercel | Supabase project URL |
| SUPABASE_SERVICE_ROLE_KEY | Railway | Server-side DB access |
| SUPABASE_ANON_KEY | Vercel | Client-side Supabase Auth |
| SUPABASE_JWT_SECRET | Railway | Verify Supabase JWTs in backend |
| ALLOWED_ORIGINS | Railway | CORS |
| ADMIN_API_KEY | Railway | Promotes a profile to admin via `/profile/become-admin` |
| BGG_API_TOKEN | Railway | BoardGameGeek app-registration bearer token (rate-limit accounting; not user-scoped) |
| BGG_CREDENTIAL_KEY | Railway | Fernet key (urlsafe base64) used to encrypt linked users' BGG passwords. Generate via `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Rotating it forces every BGG-linked user to re-link. |

## Active Development Notes
- Pilot project for Supabase Auth across the monorepo
- Hybrid data: pre-seeded top 1000 BGG games + live BGG API search
- Reference guides are 100% user-built (migration 018). No curated defaults, no admin seed content, no bulk import. The community pool is whatever users author and share.
- Game detail pages themed with accent color + header image from box art
- BGG XML API has a daily request quota. Imports prefer bundle metadata (skips the API call when player counts + playtime are present); image refresh is admin-gated and sequential to spread requests across the day.
