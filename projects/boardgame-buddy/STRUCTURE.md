# BoardgameBuddy — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-05-21 (game-picker redesign: inline dropdown picker on Gather + "Find a Game that fits" section on the Host/Join landing replaces the standalone game-search view; new `/games/recently-played` endpoint + `?sort=added_at` on `/collection/grid`)

## What It Does
A Strava-style log for board game plays. The home view is a chronological feed of plays from the user and their accepted buddies, interspersed with "hot games this week", suggested buddies, and dormant games from the user's own collection. Logging a play is a guided three-screen cascade — Gather → Play → Settle Up — that walks the host through the play and mirrors read-only to non-host joiners (who can score their own column live). The Log tab opens a Host-or-Join chooser; hosting opens a short-code session, joining either enters a code or picks a live session hosted by a buddy. Profiles are fully public and show a Strava-style stats strip + collection grid. The reference-guide system is fully user-driven: each user builds their own per-game guide by adding "chapters" — either creating new ones or browsing the community pool. The pool sorts by popularity. Reports on offensive chapters route to admin review.

Logging a play also surfaces the reference guide in-line: once a game is picked, a collapsed Expansions section lets the player toggle which expansions are active for this session, and a Reference guide section appears below Scoring with a centered Rulebook button + the parchment scroll merging chapters from the base game and every active expansion (each tagged with a colored dot matching the expansion's identity color). Adding chapters from this in-play scroll routes through the same Browse/Create UI, with each chapter saved against its source game's pool so it propagates automatically the next time the user opens the guide.

## Status
Prototype

## Tech Stack
- **Frontend (web):** Vanilla HTML/CSS/JS, DaisyUI v4 + Tailwind CDN, Lucide icons, Supabase JS SDK (CDN)
- **Backend:** Python FastAPI, Supabase (DB + Auth)
- **Auth:** Supabase Auth (email/password + Google OAuth) — pilot for the whole monorepo
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

### boardgamebuddy_play_sessions
Short-code lobby state for the cascading play-flow. The host's device opens
a row on entry to Gather; joiners use the code to add themselves; the host
walks the row through phase=gather → play → settle → finalized.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| code | TEXT | 5-char Crockford base32; unique among open sessions |
| host_user_id | UUID FK | → profiles |
| game_id | UUID FK | nullable → games |
| status | TEXT | open / finalized / abandoned (gates expiry + finalize path) |
| phase | TEXT | gather / play / settle / finalized / abandoned (drives cascading screen state; migration 026). Watched by joiners via Supabase Realtime. |
| finalized_play_id | UUID FK | nullable → plays |
| created_at | TIMESTAMPTZ | |
| expires_at | TIMESTAMPTZ | default now + 2h |
| finalized_at | TIMESTAMPTZ | nullable |

### boardgamebuddy_play_session_participants
Roster for an open session — populated as players join.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| session_id | UUID FK | → play_sessions |
| user_id | UUID FK | nullable → profiles (NULL for guest joins) |
| display_name | TEXT | |
| joined_at | TIMESTAMPTZ | |

### boardgamebuddy_play_session_scores
Per-player, per-round live scores during the Play phase (migration 026).
Browser writes directly via Supabase Realtime + RLS — only the host of the
session or the player themselves can write, and only while phase=play.
Merged into the canonical play on finalize.
| Column | Type | Notes |
|--------|------|-------|
| session_id | UUID FK | → play_sessions |
| player_user_id | UUID FK | → profiles (authed players only — guests stay local) |
| round_index | SMALLINT | 0-indexed, capped at 64 |
| score | INTEGER | nullable (blank cell) |
| updated_at | TIMESTAMPTZ | |
| PK (session_id, player_user_id, round_index) | | |

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
- `GET /api/v1/boardgame_buddy/collection/grid` — paginated owned collection sorted by `last_played_at DESC NULLS LAST, added_at DESC` by default. Supports `search`, `players`, `playtime_min/max`, `play_mode`, `exclude_expansions` (default true), `sort` (`last_played` / `added_at` / `alphabetical`), and `user_id` (target user; defaults to the viewer — profiles are public). Two round-trips: collection+game join, then plays for the matching set.
- `GET /api/v1/boardgame_buddy/games/recently-played?limit=6` — distinct games the caller has logged plays for, sorted by latest `played_at DESC`. Used by the inline game-picker dropdown on the host Gather screen for its first-focus suggestions.
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
- `POST /api/v1/boardgame_buddy/ghost-players/merge` — collapse two ghost spellings into one (body `{source_display_name, target_display_name}`); renames every matching ghost row the viewer logged so duplicates appear as a single ghost
- `GET /api/v1/boardgame_buddy/feed?cursor=&limit=20` — Strava-style mixed feed (plays + hot games + suggested buddies + featured-from-collection). Cursor-paginated via `created_at`.
- `GET /api/v1/boardgame_buddy/hot-games?window_days=7` — most-played games in window
- `GET /api/v1/boardgame_buddy/suggestions/buddies` — friends-of-friends candidates
- `GET /api/v1/boardgame_buddy/suggestions/featured-from-collection` — dormant owned games
- `GET /api/v1/boardgame_buddy/users/me/stats` — Strava-style aggregate stats for the current user
- `GET /api/v1/boardgame_buddy/users/{user_id}/stats` — same shape for any user (profiles are public)
- `GET /api/v1/boardgame_buddy/users/{user_id}/profile` — public profile + buddy-relation flags
- `GET /api/v1/boardgame_buddy/search?q=&include_bgg=false` — unified game search (collection → DB; BGG only when `include_bgg=true`)
- `POST /api/v1/boardgame_buddy/sessions` — open a short-code play session (body `{game_id?}`). Closes any prior open session for the same host first.
- `GET /api/v1/boardgame_buddy/sessions/joinable` — list active sessions the caller can join (phase=gather where caller is participant/host/host-buddy). Drives the Join chooser screen.
- `GET /api/v1/boardgame_buddy/sessions/{code}` — poll target for the lobby
- `PATCH /api/v1/boardgame_buddy/sessions/{code}` — host updates the lobby (body `{game_id?}`)
- `PATCH /api/v1/boardgame_buddy/sessions/{code}/phase` — host advances the cascading flow (body `{phase: 'gather'|'play'|'settle'|'finalized'|'abandoned'}`). Transitions enforced: gather→play→settle→finalized, plus any→abandoned. Joiners watch this column via Realtime.
- `POST /api/v1/boardgame_buddy/sessions/{code}/join` — join a session by code. Returns 409 once the session has moved past phase=gather.
- `POST /api/v1/boardgame_buddy/sessions/{code}/participants` — host-only. Adds a buddy (with `user_id`) or a ghost (name-only, `user_id=null`) to the lobby roster so joiners see the player. Gather-only.
- `DELETE /api/v1/boardgame_buddy/sessions/{code}/participants/{participant_id}` — host-only. Removes a participant from the lobby roster. Refuses to remove the host themselves. Gather-only.
- `DELETE /api/v1/boardgame_buddy/sessions/{code}` — host abandons a session
- `POST /api/v1/boardgame_buddy/sessions/{code}/finalize` — write a play row from the session. Merges per-player live-scoring rows from `boardgamebuddy_play_session_scores` into the player payload (authed players only; guests keep host-typed scores).
- Session create/join/get/joinable (and every session endpoint's response payload) are single Postgres RPCs as of migrations 036-038 (`bgb_create_session` / `bgb_join_session` / `bgb_get_session` / `bgb_joinable_sessions` / `bgb_session_bundle`) — previously 4-6 sequential PostgREST round trips per request, which made host/join taps, the 2s lobby poll, and the Join chooser crawl at cross-region RTTs. See `db/functions/boardgamebuddy.sql`.
- Migration 039 extends the same treatment to the other hot reads: `GET /plays` + `GET /games/{id}/plays` → `bgb_plays_page` (was 8-11 round trips with Python-side pagination over the full history), Closet play stats → `bgb_play_stats` (SQL GROUP BY instead of shipping every play row), `GET /bgg/sync/status` → `bgb_bgg_sync_status` (poll target, was up to 7 round trips). Play-player writes are bulked (2 statements per play regardless of player count), `/played-with` resolves buddy relations from one edges query, and pg_trgm GIN indexes back the per-keystroke name searches.
- `POST /api/v1/boardgame_buddy/bgg/link` — body `{username, password}`; logs into BGG via `POST /login/api/v1`, stores the username + Fernet-encrypted password (`BGG_CREDENTIAL_KEY`) and the returned SessionID/bggusername/bggpassword cookies on the profile. A successful login is also our existence check (BGG returns 401 for both bad passwords and unknown handles, surfaced as a 400 to the client). Returns `{bgg_username}`.
- `DELETE /api/v1/boardgame_buddy/bgg/link` — clear `bgg_username` plus all stored credentials/cookies. Already-imported collection/plays remain in place.
- `POST /api/v1/boardgame_buddy/bgg/sync` — pull collection (`own=1`, `wishlist=1`, `wanttoplay=1`, `showprivate=1`) and plays (paginated) from BGG. Per-user calls go through `fetch_bgg_as_user`, which sends the stored cookies so BGG evaluates the request AS the linked user — that's what unlocks the `<privateinfo>` block (purchase price, private comment, acquisition date, …) which we mirror onto `boardgamebuddy_collections.bgg_*` columns. BGG `own→owned`; `wishlist` and `wanttoplay` both map to `'wishlist'`. Games we already have are written immediately (collections upsert on `(user_id, game_id)`; plays dedup on `(user_id, bgg_play_id)`). Games we don't have go into `boardgamebuddy_bgg_pending_imports` (the `payload.private` carries the private fields through to materialization) and a `BackgroundTasks` worker drains the queue (~1.5s between BGG calls). At the start of every sync the handler stamps `profiles.bgg_last_sync_started_at` so the status endpoint can compute session-scoped progress. Returns `{bgg_username, collection_imported, collection_pending, plays_imported, plays_pending, unique_games_to_import, warm_up_retry_pending}`. Players from BGG plays are upserted as buddies on `(owner_id, name)` using the same path as `POST /plays`. If the stored password no longer works, returns 409 — the FE surfaces a "re-link required" banner.
- `POST /api/v1/boardgame_buddy/bgg/sync/process-pending` — manual fallback to drain the pending queue (e.g. after a process restart cut a BackgroundTask short). Idempotent.
- `GET /api/v1/boardgame_buddy/bgg/sync/status` — `{bgg_username, auth_state, pending_count, errored_count, last_completed_at, session_started_at, session_total, session_done, session_errored}`. `auth_state` is `unlinked` / `linked` / `relink_required`; the session_* counts are scoped to the most recent sync (rows with `created_at >= profiles.bgg_last_sync_started_at`) and counted in distinct BGG ids so they line up with the per-game `/thing` calls the worker makes. The Settings BGG card polls this every 2s while `session_done + session_errored < session_total` to drive an "Importing X of Y" progress bar.
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
- `PATCH /api/v1/boardgame_buddy/games/admin/{game_id}/rulebook-url` — *admin-only* set or clear a game's `rulebook_url` (body `{rulebook_url: string|null}`)

### Admin UI
- Promote via **Settings** screen → "Have an admin key?" → enter `ADMIN_API_KEY`. Server sets `profiles.is_admin=true`; the client then exposes the **Admin** screen with the chapter-reports moderation panel.

## Routes & URL Map

Path-based routing via the History API (`projects/boardgame-buddy/web/domain/view.js` → `Router`). On boot, `init.js` parses `window.location.pathname` via `matchPath()`, stashes the resolved route in `store("pendingRoute")`, and restores it once Supabase auth resolves so deep links survive refresh. `vercel.json` rewrites every path to `/index.html` for the SPA fallback.

| Path | Route name | Path params | Querystring (optional) | Notes |
|---|---|---|---|---|
| `/feed` (also `/`) | `feed` | — | — | Home: chronological play feed + rails. Bottom-nav Feed tab. |
| `/auth` | `auth` | — | — | Sign-in / sign-up. Pushed when Supabase reports no session. |
| `/play` | `log-play` | — | — | Host-or-Join chooser. Bottom-nav Play tab without an active lobby. |
| `/play/:code` | `play-flow` (host) **or** `session-viewer` (joiner) | `code` | — | Active session. URL is shared by host & joiners — play-flow's onMount fetches the lobby and hops to session-viewer if `host_user_id` isn't the current user. `_ensureLobbyOpen` calls `router.replaceUrl("play-flow", { code })` once the host's lobby opens so `/play` becomes `/play/{code}` without a back-stack entry. |
| `/join` | `join-session` | — | — | Code entry + active-session chooser for joiners. |
| `/game/:gameId` | `game-detail` | `gameId` | `gameName` | Game hero, status toggle, reference scroll, recent plays. |
| `/game/:gameId/chapters` | `reference-guide-add` | `gameId` | `gameName`, `expansionIds`, `mode` (`"edit"` for prefill), `chapterId` | Three-mode chapter editor (browse / create / edit). When opened with `mode=edit`, the scroll widget stashes the chapter on the view singleton (`_prefillChapter`) so the deep-link parent never re-fetches it. |
| `/profile` | `profile-self` | — | — | Own profile: stats strip + collection grid + recent plays. Bottom-nav Profile tab. |
| `/profile/collection` | `collection` | — | `userId` (when viewing another user — though `/u/:userId` is preferred for that) | Collection grid. |
| `/profile/wishlist` | `wishlist` | — | `userId` | Wishlist grid. |
| `/profile/plays` | `plays` | — | `userId` | Plays log. |
| `/profile/buddies` | `buddies` | — | — | Accepted buddies + pending requests + search. |
| `/u/:userId` | `profile-other` | `userId` | — | Public profile for another account. Distinct from `/profile/*` so userId can't collide with a subpage name. |
| `/settings` | `settings` | — | — | Account / theme / logout. |
| `/admin` | `admin` | — | — | Chapter-reports moderation. Only reachable when `is_admin=true`. |

**Routes intentionally not in the URL:**

- `splash` — transient loading view between boot and Supabase auth resolving. Never pushed to history, never appears in the back stack.

**Back-stack semantics:** `router.back()` defers to `history.back()`; the popstate handler replays the entry's state (or falls back to `matchPath()` for direct loads). An internal `_stack` is kept in parallel only because the browser doesn't expose history-entry metadata — `peekBack()` reads it to label back affordances ("Back to game details", etc.).

## Screen Flow
Bottom nav has three tabs: **Feed**, **Log**, **Profile**.

1. Auth (login/signup) → splash → 2. **Feed** (home): chronological mix of plays from the viewer and their accepted buddies, plus inline "hot this week" / "buddies you may know" / "time to revisit" rails. A search pill at the top opens the **Game Search** screen.
3. **Log a play**: the Log tab opens a Host-or-Join chooser. Picking **Host a game** drops the user into the cascading three-screen flow (`play-flow` view); picking **Join a game** routes to a session-select screen that combines a 5-char code input with a list of active sessions where the user is a participant or the host is a buddy.
   The Log a play cascade has three snap-scroll screens:
   - **Gather** — pick a game, set game type (competitive/team/co-op), manage the player list. A session code opens on entry and is shown at the top of the screen; other phones can join via code while the host is on Gather. Joiners stream into the player list via polling.
   - **Play** — full-width reference guide on top, scoring grid below. Host has full grid access (add rounds, override winners). Authenticated joiners see the same grid in read-only mode except for their own column, which they can edit live. Per-cell edits stream both ways via Supabase Realtime against `boardgamebuddy_play_session_scores`. Scores may be negative; a "± Negative" header toggle (default off, remembered) reveals per-cell +/− sign buttons for keyboards that lack a minus key.
   - **Settle Up** — host only. Optional photo upload + "Key moments" notes textarea (reuses the play's `notes` column), then Save. Save calls `/sessions/{code}/finalize` which merges live scores into the canonical play and marks the session finalized.
   When the host advances Gather→Play, the lobby closes (`POST /sessions/{code}/join` returns 409 thereafter). When the host enters Settle Up, every non-host joiner sees a polaroid splash popup centered on the screen with the game thumbnail and current winner; tapping the X dismisses to a refreshed feed.
   The draft auto-persists to localStorage (metadata only, plus current phase); the photo blob stays in memory. The chooser surfaces a "Resume hosting?" banner when a non-terminal draft exists.
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
