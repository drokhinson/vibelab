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
- **Native app (`app/`):** React Native / Expo (SDK 54, RN 0.81, React 19), React Navigation
  (native-stack + bottom-tabs), Context + useReducer state, Supabase Auth (secure-store, PKCE),
  Supabase Realtime for live sessions. Self-contained — theme/api/components live under `app/src`
  (no `shared/` layer; the web app is untouched). See "Native app" below.
- **Backend:** Python FastAPI, Supabase (DB + Auth)
- **Auth:** Supabase Auth (email/password + Google OAuth) — pilot for the whole monorepo
- **External API:** BoardGameGeek XML API v2 (for live search fallback)

### Native app (`app/`)
Full feature-parity React Native build. Organized around the repo's one-canonical-component-per-
core-object rule (`.claude/rules/ui-object-design.md`):
- **Core-object components** (`app/src/components/`): `GameTile` (variants tile/preview/hero/thumb),
  `PlayCard` (flip card), `UserBadge` (avatars + 11 icon glyphs), `BuddyRow`, `StatusTag`/
  `ExpansionBadge`. Shared chrome: `AppHeader`, `LoadingState`, `EmptyState`, `ConfirmModal`
  (the single app-wide destructive-confirm surface), `OAuthButtons`, `Markdown`, `AvatarCustomizer`,
  `StatsStrip`.
- **Widgets** (`app/src/widgets/`): `ReferenceGuideScroll`, `RoundScoreGrid`, `GameFinder`,
  `PlayDetailPopup` (the single "open a play" destination).
- **Realtime** (`app/src/realtime/`): `liveScores`, `sessionPhase` (Supabase channels for the live
  host/join cascade); draft model in `app/src/models/playSession.js` (AsyncStorage-persisted).
- **API client** (`app/src/api/client.js`): all ~80 endpoints, 401 refresh-retry, multipart photo
  upload. Boot seeds first paint via `GET /bootstrap`.
- **Auth/OAuth prerequisites (web-side, not in `app/`):** Google sign-in routes through a hosted
  `web/auth-callback.html` bridge page on the BGB Vercel deploy, allowlisted in Supabase → Auth →
  URL Configuration. Store submission also needs `web/privacy.html` + `web/delete-account.html`.
  Apple Sign-In is deferred.

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
| bgg_username | TEXT | nullable; linked BoardGameGeek username (folded into 001_baseline). Unique when non-null. |
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

### boardgamebuddy_buddy_edges
The mutual friendship graph (migration 008). One row per pair, stored
canonically as `(user_a, user_b)` with `user_a < user_b` so a pair can never
have two rows. `requested_by` records who sent the request, which is what makes
an incoming request distinguishable from an outgoing one.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_a | UUID FK | → profiles; always the lower UUID of the pair |
| user_b | UUID FK | → profiles |
| status | TEXT | `pending` / `accepted` |
| requested_by | UUID FK | → profiles; the sender |
| created_at | TIMESTAMPTZ | |
| accepted_at | TIMESTAMPTZ | nullable; set when the recipient accepts |

### boardgamebuddy_buddies
**Ghost players only.** This was the original one-way buddy table; migration 013
dropped its `linked_user_id` and friendship moved to `boardgamebuddy_buddy_edges`.
What remains is a per-owner roster of free-text names for people who played but
do not have an account.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| owner_id | UUID FK | → profiles |
| name | TEXT | typed name |
| created_at | TIMESTAMPTZ | |
| UNIQUE(owner_id, name) | | |

### boardgamebuddy_plays
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID FK | → profiles |
| game_id | UUID FK | → games |
| played_at | DATE | |
| notes | TEXT | nullable |
| bgg_play_id | BIGINT | nullable; set when the row was imported from BGG. Unique per (user_id, bgg_play_id) — re-running BGG sync is idempotent. |
| photo_url | TEXT | nullable; Storage URL for the play photo |
| play_mode | TEXT | `competitive` / `coop` / `team` — what the user actually played, which may differ from the game's intrinsic mode |
| game_name | TEXT | denormalized off games (migration 020) so play lists are a single-table read |
| game_thumbnail_url | TEXT | denormalized off games |
| created_at | TIMESTAMPTZ | |

Migration 020 also cached `game_image_url` and `game_play_mode` here; migration
044 dropped both after finding nothing ever read them off a play row.

### boardgamebuddy_play_players
One row per participant in a play. Since migration 009 a participant is either a
real account (`player_user_id`) or a free-text label (`player_display_name`);
migration 013 dropped the old `buddy_id` reference.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| play_id | UUID FK | → plays |
| player_user_id | UUID FK | nullable → profiles; set for account players |
| player_display_name | TEXT | nullable; the typed label for ghost players |
| is_winner | BOOLEAN | |
| score | INTEGER | nullable final score |
| round_scores | JSONB | nullable per-round totals (migration 028) |

### boardgamebuddy_play_expansions
Which expansions were in play for a given play.
| Column | Type | Notes |
|--------|------|-------|
| play_id | UUID FK | → plays |
| expansion_game_id | UUID FK | → games (a row with is_expansion=true) |
| PRIMARY KEY (play_id, expansion_game_id) | | |

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
Per-user "this expansion is switched on for me" toggle. **Live** — do not drop.
An earlier note here called it unused; it is not. `expansion_routes` writes and
deletes rows through the toggle endpoint and reads them back, and
`bgb_game_detail_bundle` joins it to carry the viewer's toggle state onto the
game-detail response.
| Column | Type | Notes |
|--------|------|-------|
| user_id | UUID FK | → profiles |
| expansion_game_id | UUID FK | → games (a row with is_expansion=true) |
| PRIMARY KEY (user_id, expansion_game_id) | | presence = enabled |

### boardgamebuddy_bgg_pending_imports
Staging queue for BGG syncs (folded into 001_baseline). When a user's collection or play
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
| error_message | TEXT | populated when status='error'; written for diagnostics, not surfaced in the UI yet |
| attempts | INT | retry count; promotes to `error` after 3 |
| created_at / completed_at | TIMESTAMPTZ | |
| UNIQUE(user_id, bgg_id, kind) WHERE status='pending' | | one pending row per (user, game, kind) |

## API Endpoints

### Public
- `GET /api/v1/boardgame_buddy/health`
- `GET /api/v1/boardgame_buddy/games` — paginated, search, filter. Supports `players`, `playtime_min/max`, `mechanics` (AND logic), and `owned_only=true` (requires bearer token; intersected with the caller's `boardgamebuddy_collections` rows where `status='owned'`)
- `GET /api/v1/boardgame_buddy/games/{game_id}` — detail (includes derived `bgg_url`)
- `GET /api/v1/boardgame_buddy/games/{game_id}/bundle` — single-call Game Detail: the game, its base game, the viewer's collection status, recent plays and expansions in one `bgb_game_detail_bundle` RPC. Supersedes the separate status / plays / expansions fetches.
- `GET /api/v1/boardgame_buddy/games/{game_id}/chapter-pool` — browse the pool of existing chapters for a game. Each row carries `popularity` (count of users who have it) and `in_my_guide` (whether the caller has it). Sorted by `popularity DESC, created_at DESC`. Supports `?q=` (title+content ILIKE), `?chapter_type=`, and `?expansion_ids=a,b,c` (comma-separated game UUIDs to merge into the pool — each merged row carries `source_game_id` / `source_game_name` / `source_color` so the FE can render colored dots tying chapters to their expansion). Auth optional — anon callers always see `in_my_guide=false`.
- `GET /api/v1/boardgame_buddy/games/{game_id}/expansions` — list expansions linked to this base game; `is_enabled` reflects the caller's own toggle when authenticated, `false` otherwise. Each item includes the expansion's `rulebook_url`.
- `GET /api/v1/boardgame_buddy/games/{base_id}/expansions/available` — expansions BGG links to this base game that BgB hasn't imported yet. Backs the "Import expansions" popup: already-imported bgg_ids are filtered out and each `name` has the base game's name stripped off the front ("Catan: Cities & Knights" → "Cities & Knights"), with BGG's original string kept in `full_name`. 400 when the target is itself an expansion.
- `POST /api/v1/boardgame_buddy/games/import-bgg/{bgg_id}` — import one game from BGG into the catalog by its BGG id. Idempotent; returns the existing row when already present.
- `POST /api/v1/boardgame_buddy/games/{base_id}/expansions/import/{bgg_id}` — import one expansion into the catalog and pin `base_game_bgg_id` to this base game (BGG keeps only the first inbound link, which can point at a different base). Idempotent; returns the `ExpansionListItem`. Catalog-only — does not touch the caller's collection.
- `GET /api/v1/boardgame_buddy/chapter-types` — chapter type lookup

### Auth Required
- `GET /api/v1/boardgame_buddy/bootstrap` — first-paint cache warm-up: `current_user`, `profile_bundle`, `feed_first_page` + `feed_cursor`, `recently_played_games`, `play_partners`, and a `bootstrap_version` the FE compares against its own constant (mismatch → wipe and rehydrate). The six blocks are fetched concurrently (`asyncio.to_thread` + `gather`) since the Supabase client is synchronous. Deliberately excludes the per-game detail bundles — see below.
- `GET /api/v1/boardgame_buddy/bootstrap/game-bundles` — deferred second stage: one `bgb_game_detail_bundle` per owned base game, keyed by `game_id`, plus `owned_count` / `truncated`. Split out of `/bootstrap` because it's an N+1 in SQL (up to 250 invocations) and nothing on the first screen reads it; the FE pulls it from an idle callback after the user has landed, and Game Detail falls back to its own fetch on a miss.
- `GET /api/v1/boardgame_buddy/profile`
- `POST /api/v1/boardgame_buddy/profile`
- `POST /api/v1/boardgame_buddy/profile/become-admin` — body `{admin_key}`; sets `is_admin=true` if the key matches `ADMIN_API_KEY`
- `GET /api/v1/boardgame_buddy/profile/bundle` — single-call Profile view: stats + all three shelves + recent plays + the buddy lists and status/expansion-count caches the FE would otherwise fetch separately. One `bgb_profile_bundle` RPC.
- `GET /api/v1/boardgame_buddy/profiles/search?q=` — search other users by display name (returns id, display_name, email) for buddy linking
- `DELETE /api/v1/boardgame_buddy/profile` — delete current user's account and data
- `GET /api/v1/boardgame_buddy/collection` — flat list (legacy shape, list[CollectionItem])
- `GET /api/v1/boardgame_buddy/collection/grid` — paginated owned collection sorted by `last_played_at DESC NULLS LAST, added_at DESC` by default. Supports `search`, `players`, `playtime_min/max`, `play_mode`, `exclude_expansions` (default true), `sort` (`last_played` / `added_at` / `alphabetical`), and `user_id` (target user; defaults to the viewer — profiles are public). Two round-trips: collection+game join, then plays for the matching set, plus one more to tally each page's `game.expansion_count` — the catalog-wide number of expansions pointing at that base game, which drives the tile badge.
- `GET /api/v1/boardgame_buddy/games/recently-played?limit=6` — distinct games the caller has logged plays for, sorted by latest `played_at DESC`. Used by the inline game-picker dropdown on the host Gather screen for its first-focus suggestions.
- `POST /api/v1/boardgame_buddy/collection`
- `PATCH /api/v1/boardgame_buddy/collection/{game_id}`
- `DELETE /api/v1/boardgame_buddy/collection/{game_id}`
- `GET /api/v1/boardgame_buddy/plays` — paginated plays the target user logged + participated in. Each play includes `is_own`, `logged_by_id`, `logged_by_name`. Supports `page`, `per_page`, `game_id`, `buddy_id` (treated as a player_user_id filter post-migration-009), `search` (free-text match on game name OR any player's display name), and `user_id` (target user; defaults to the viewer — profiles are public).
- `POST /api/v1/boardgame_buddy/plays` — one round trip: the whole write (play row + players + expansions) happens inside the `bgb_log_play` RPC (migration 042). Migration 044 dropped its legacy buddies-roster insert — the only reader of that roster was `GET /plays/filter-options`, which was removed as uncalled.
- `PUT /api/v1/boardgame_buddy/plays/{play_id}` — **full replacement** of the play: deletes and re-inserts every player and expansion row. Used by the play-edit screen. Do not reach for it to change one field.
- `PATCH /api/v1/boardgame_buddy/plays/{play_id}/photo` — body `{photo_url}`; owner-only, writes just that column in a single statement (ownership is the WHERE clause, so a missing play and someone else's are both 404). This is what the log-play flow uses to attach a photo — routing that through the PUT above cost twelve round trips and recreated every player row to set one string.
- `POST /api/v1/boardgame_buddy/plays/photo` — multipart upload of a play photo to Storage, returning the URL. Used by the play-flow wrap-up card, which uploads in parallel with the finalize and attaches afterwards.
- `DELETE /api/v1/boardgame_buddy/plays/{play_id}` — only the original logger can delete
- `POST /api/v1/boardgame_buddy/plays/{play_id}/leave` — a non-owner participant self-removes from a play they didn't take part in. Turns their `player_user_id` row into a ghost (nulls the id, keeps `player_display_name`) instead of deleting the play — the owner keeps it and sees them as a named ghost; the play drops out of the leaver's history/played-with. 400 if the caller owns the play (use edit/delete), 404 if they aren't a player in it.
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
- `GET /api/v1/boardgame_buddy/feed?cursor=&limit=20` — Strava-style mixed feed (plays + hot games + suggested buddies + featured-from-collection). Cursor-paginated via `created_at`. The three rails are composed into this response by `feed_service.build_feed_page`; they have no standalone endpoints.
- `GET /api/v1/boardgame_buddy/users/me/stats` — Strava-style aggregate stats for the current user
- `GET /api/v1/boardgame_buddy/users/{user_id}/stats` — same shape for any user (profiles are public)
- `GET /api/v1/boardgame_buddy/users/{user_id}/profile` — public profile + buddy-relation flags
- `GET /api/v1/boardgame_buddy/search?q=&include_bgg=false` — unified game search (collection → DB; BGG only when `include_bgg=true`). Expansions are excluded from every source unless `include_expansions=true` — they aren't pickable as a session's main game and are added through the base game's expansion section instead.
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
- Migration 039 extends the same treatment to the other hot reads: `GET /plays` → `bgb_plays_page` (was 8-11 round trips with Python-side pagination over the full history), Closet play stats → `bgb_play_stats` (SQL GROUP BY instead of shipping every play row), `GET /bgg/sync/status` → `bgb_bgg_sync_status` (poll target, was up to 7 round trips). Play-player writes are bulked (2 statements per play regardless of player count), `/played-with` resolves buddy relations from one edges query, and pg_trgm GIN indexes back the per-keystroke name searches.
- `POST /api/v1/boardgame_buddy/bgg/link` — body `{username, password}`; logs into BGG via `POST /login/api/v1`, stores the username + Fernet-encrypted password (`BGG_CREDENTIAL_KEY`) and the returned SessionID/bggusername/bggpassword cookies on the profile. A successful login is also our existence check (BGG returns 401 for both bad passwords and unknown handles, surfaced as a 400 to the client). Returns `{bgg_username}`.
- `DELETE /api/v1/boardgame_buddy/bgg/link` — clear `bgg_username` plus all stored credentials/cookies. Already-imported collection/plays remain in place.
- `POST /api/v1/boardgame_buddy/bgg/sync` — pull collection (`own=1`, `wishlist=1`, `wanttoplay=1`, `showprivate=1`) and plays (paginated) from BGG. Per-user calls go through `fetch_bgg_as_user`, which sends the stored cookies so BGG evaluates the request AS the linked user — that's what unlocks the `<privateinfo>` block (purchase price, private comment, acquisition date, …) which we mirror onto `boardgamebuddy_collections.bgg_*` columns. BGG `own→owned`; `wishlist` and `wanttoplay` both map to `'wishlist'`. Games we already have are written immediately (collections upsert on `(user_id, game_id)`; plays dedup on `(user_id, bgg_play_id)`). Games we don't have go into `boardgamebuddy_bgg_pending_imports` (the `payload.private` carries the private fields through to materialization) and a `BackgroundTasks` worker drains the queue (~1.5s between BGG calls). At the start of every sync the handler stamps `profiles.bgg_last_sync_started_at` so the status endpoint can compute session-scoped progress. Returns `{bgg_username, collection_imported, collection_pending, plays_imported, plays_pending, unique_games_to_import, warm_up_retry_pending}`. If the stored password no longer works, returns 409 — the FE surfaces a "re-link required" banner.
- `GET /api/v1/boardgame_buddy/bgg/sync/status` — `{bgg_username, auth_state, pending_count, errored_count, last_completed_at, session_started_at, session_total, session_done, session_errored}`. `auth_state` is `unlinked` / `linked` / `relink_required`; the session_* counts are scoped to the most recent sync (rows with `created_at >= profiles.bgg_last_sync_started_at`) and counted in distinct BGG ids so they line up with the per-game `/thing` calls the worker makes. The Settings BGG card polls this every 2s while `session_done + session_errored < session_total` to drive an "Importing X of Y" progress bar.
- `POST /api/v1/boardgame_buddy/games/{game_id}/chapters` — create a brand-new chapter (type + title + markdown) and auto-add to the creator's guide
- `POST /api/v1/boardgame_buddy/games/{game_id}/chapters/generate` — AI-draft a chapter of the given `chapter_type` for this game and return `{chapter_type, title, content}`. **Saves nothing** — the editor loads the draft into its form and the user reviews, edits, and saves it themselves. Synchronous (the user is waiting in the editor), backed by Gemini Flash Lite via the shared `shared-backend/gemini.py` caller; 400 on an unknown chapter type, 404 on an unknown game, 502 when the model call fails (missing `GEMINI_API_KEY`, safety block, transport error). The markdown spec in the prompt is the app's own authoring guide — see the sync note below.
- `PATCH /api/v1/boardgame_buddy/chapters/{chapter_id}` — edit own chapter (creator-only)
- `DELETE /api/v1/boardgame_buddy/chapters/{chapter_id}` — delete from pool (creator or admin); cascades to user_chapters + reports
- `POST /api/v1/boardgame_buddy/chapters/{chapter_id}/report` — body `{reason?}`; flag a chapter for admin moderation. Idempotent per user.
- `GET /api/v1/boardgame_buddy/games/{game_id}/my-chapters` — chapters the caller has added to their guide for this game (empty list when none). Supports `?expansion_ids=a,b,c` to also merge in chapters from the listed expansions in one round-trip; each row carries `source_game_id` / `source_game_name` / `source_color` for FE colored-dot rendering.
- `POST /api/v1/boardgame_buddy/games/{game_id}/my-chapters` — body `{chapter_id}`; add an existing pool chapter to my guide (idempotent)
- `DELETE /api/v1/boardgame_buddy/games/{game_id}/my-chapters/{chapter_id}` — remove from my guide (does NOT delete the chapter)
- `POST /api/v1/boardgame_buddy/games/{base_id}/expansions/{expansion_id}/toggle` — body `{is_enabled}`; per-user expansion toggle. Read back by this module's expansion list and joined into `bgb_game_detail_bundle`; the chapter system does not consume it
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
   **The host's Save is non-blocking.** Tapping Save puts the same "Well played!" polaroid up in the same frame and runs the finalize behind it, with the photo uploading *in parallel* rather than after. The card's primary CTA spins as **Saving…** — the X is hidden and the backdrop inert while the write is in flight — then settles into **Go to feed**, alongside **View play** and the host-only **Another round?**. It unblocks the moment the play lands, not when the photo does: the photo has always been best-effort, and `PATCH /plays/{id}/photo` attaches it afterwards in the background. The finalize itself is a single round trip (`bgb_finalize_session`, migration 042), so the spinner is brief. A failed write swaps the CTA to **Retry** and leaves the draft fully intact, so closing the card lands back on Settle Up with everything still there; a failed photo upload becomes a warning line on the card rather than a separate modal. **Another round?** (enabled only once the play is safely saved) opens a *new* session pre-seeded with the same game, expansions, play mode and roster — teams included, scores and winner reset — landing on Gather under a new code. The carried-over roster is pushed to the new lobby as participants, so the previous joiners see it in their Join chooser.
   The draft auto-persists to localStorage (metadata only, plus current phase); the photo blob stays in memory. The chooser surfaces a "Resume hosting?" banner when a non-terminal draft exists.
4. **Game Search** (search pill on Feed/Profile): single ranked list — collection hits first, then DB matches. A "Search BoardGameGeek for more" button appends BGG hits on demand. **Expansions never appear here** — base games only, on every source. They live in the base game's Expansions section instead.
5. **Game Detail** (tap any game card): box art hero, status toggle (none → owned → wishlist → none), Log a Play button, BGG + Rulebook links, Expansions section, a rolled-up parchment **Reference Guide scroll** (tap either roll to open/close), and recent plays. The scroll is per-user per-game and starts empty; tap **Add a chapter** at the bottom to either Create a new one or Browse the community pool.

**Expansions section.** Rendered on every base game — on the Game Detail page (a reel of expansion polaroids) and on the host's Gather card (a collapsible toggle list). The Gather list caps at five visible rows and scrolls, with a sliver of the sixth showing so it reads as scrollable; past five rows a client-side filter field appears above it (with a × to clear), matching the displayed label or the stored full name so typing the base game's name still hits. Import expansions sits *below* the scroll box, so it stays reachable however far down the list you are. Both carry an **Import expansions** button, and it stays available when nothing is imported yet. It opens `widgets/import-expansions-modal.js`, which lists the expansions BoardGameGeek links to this game that BgB doesn't have (`GET /games/{id}/expansions/available`); each row's name has the base game's name stripped off the front, and a **+** imports it into the catalog and pins it to this base game. A filter field above the list narrows it by name — the whole list arrives in one response, so filtering is client-side (no debounce, no second request) and matches both the displayed name and BGG's full name, so typing the base game's name still hits. Escape backs out of the filter before it closes the popup. Import is catalog-only — it doesn't touch the caller's collection. On the Game Detail page the new expansion appears in the reel as soon as the import returns — the endpoint answers with the finished `ExpansionListItem`, so the reel takes it directly (name-ordered, matching the bundle RPC) and only that section repaints, with a forced bundle refetch reconciling in the background. Since expansions are hidden from search, this popup is the only way one enters the catalog, so the base game has to be imported first.

**Expansion count badge.** Collection and wishlist tiles carry a `git-fork N` chip counting every expansion **the catalog holds** for that base game — the same number as the game page's "Expansions (N)" heading, tooltip "N expansions in Boardgame Buddy". It used to count only expansions the viewer *owned*, which read as zero for a game with eleven of them, since importing is catalog-only. The count rides on `game.expansion_count` from `/collection/grid`; the profile-bundle seed doesn't compute it, so the badge appears when the grid fetch lands rather than on first paint. Feed rails still show the owned count (their rows come from `bgb_hot_games`, which doesn't carry the total) — their tooltip says "owned", so the two stay truthful.

**Expansion labels drop the base game's name** wherever the base game is already the surrounding context: the Game Detail reel, the host's Gather picker, the reference guide's expansion chips, and a play's expansion list. "Carcassonne: Abbey & Mayor" reads as "Abbey & Mayor" there. This is display-only via `stripBaseGameName()` in `web/helpers.js` (the frontend twin of the backend's `_strip_base_prefix` — keep the pair in sync); the stored name is untouched, the full name stays on the element's `title` and on the `gameName` navigation param, and every other surface — the expansion's own page, collection, search, feed, plays — shows it in full.
6. **Reference guide chapter add**: full-screen view with two tabs — **Create** or **Browse** (search the per-game pool, sorted by popularity, tap + to add). Each browseable row also has a **Report** action for moderation. Create asks for the **chapter type first** (it governs everything below it — Save stays disabled and reads "Select chapter type" until one is picked), then offers a draft-source row of **Import .md** / **Generate with AI**, then title, then the Write/Preview markdown editor. Generate is greyed out until a type is picked, calls the generate endpoint above, and fills the title and body for the user to review — overwriting an already-typed draft goes through the project's `PolaroidPopup.confirm()`. The draft row is create-only; Edit shows the type picker and title alone.
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
| GEMINI_API_KEY | Railway | Shared with Travel Trove. Powers the chapter editor's "Generate with AI" button. Missing key → that button 502s with a toast; nothing else breaks. |

## Active Development Notes
- Pilot project for Supabase Auth across the monorepo
- Hybrid data: pre-seeded top 1000 BGG games + live BGG API search
- Reference guides are user-built (migration 018). No curated defaults, no admin seed content, no bulk import. A chapter can be AI-drafted from the editor, but the draft only ever lands in the form — a user reviews and saves it, so every chapter in the pool is still one a person chose to publish.
- **The chapter authoring guide lives in two places and must stay in sync**: `CHAPTER_AUTHORING_GUIDE` in `web/views/reference-guide-add-view.js` (the in-app modal + the .md download) and `_AUTHORING_GUIDE` in `shared-backend/routes/boardgame_buddy/services/chapter_ai.py` (what "Generate with AI" hands the model). Both must match what `web/ui/markdown.js` actually renders; anything else shows up as literal text.
- Game detail pages themed with accent color + header image from box art
- BGG XML API has a daily request quota. Imports prefer bundle metadata (skips the API call when player counts + playtime are present); image refresh is admin-gated and sequential to spread requests across the day.
