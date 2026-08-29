# BoardgameBuddy — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-08-29 (the spectator's mirror is built from the host's screen: the Play step now carries the game and the session code in their own cards, the crumb bar above the cascade is gone and the view container no longer double-pads the cascade's own gutters, and the live grid actually moves — the score channel starts on a poll-detected phase change, paints its initial backfill, and `GET /sessions/{code}` carries a `scores` array so a spectator who joined after Gather sees the grid at all — migration 054). Earlier: a dead session code can no longer block the host: the play flow drops a finished lobby on remount, re-mints a dead one instead of erroring, and Host a game always starts a fresh session. Earlier the same day: the host is the only person who scores: joiners and spectators get a read-only mirror of the host's grid, live scores are keyed by participant so guest columns stream too, and `bgb_finalize_session` stops overlaying them onto the host's payload — migration 053)

## What It Does
A Strava-style log for board game plays. The home view is a chronological feed of plays from the user and their accepted buddies, interspersed with "hot games this week" and suggested buddies. Logging a play is a guided three-screen cascade — Gather → Play → Settle Up — that walks the host through the play and mirrors read-only to everyone else (the host is the only person who scores; joiners and spectators watch the grid update live). The Play tab is split in two: hosting on top (host a game, replay the last one, or browse the Game Explorer) and joining on the bottom (enter a short code, or pick a live session hosted by a buddy). Hosting also works with no connectivity at all — the cascade runs from cache, the play queues on the device, and it uploads on the next online session. That switches itself on and off with the device's connection; there is nothing to toggle. Profiles are fully public and show a Strava-style stats strip + collection grid. The reference-guide system is fully user-driven: each user builds their own per-game guide by adding "chapters" — either creating new ones or browsing the community pool. The pool sorts by popularity. Reports on offensive chapters route to admin review.

Logging a play also surfaces the reference guide in-line: once a game is picked, a collapsed Expansions section lets the player toggle which expansions are active for this session, and a Reference guide section appears below Scoring with a centered Rulebook button + the parchment scroll merging chapters from the base game and every active expansion (each tagged with a colored dot matching the expansion's identity color). Adding chapters from this in-play scroll routes through the same Browse/Create UI, with each chapter saved against its source game's pool so it propagates automatically the next time the user opens the guide.

## Status
Prototype

## Tech Stack
- **Frontend (web):** Vanilla HTML/CSS/JS, DaisyUI v4 + Tailwind CDN, Phosphor icons vendored in `ui/icons.js`, Supabase JS SDK (CDN). Installable PWA (`manifest.json` + `sw.js`) so the host flow works with no connectivity — see Offline mode under Screen Flow §3. `ui/install-prompt.js` surfaces the install itself: a dismissable strip docked above the bottom nav on phone-sized viewports, replaying Chrome's `beforeinstallprompt` on tap and falling back to a "Share → Add to Home Screen" hint on iOS (which has no install API). It is shown only on the feed, and only when signed in and not already running standalone; dismissal is session-scoped via the `bgb.pwa.installDismissed` sessionStorage key.
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
| client_key | UUID | nullable; idempotency key for offline-queued plays (migration 048). Partial-unique per (user_id, client_key). NULL for every live write — two identical online POSTs legitimately mean two plays. |
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
Per-participant, per-round live scores during the Play phase (migration 026;
re-keyed by migration 053). **One-way broadcast:** the host's browser writes
directly via Supabase Realtime + RLS and everybody else reads. Only the host
of the session can write, and only while phase=play.

Keyed by **participant**, not by user. A guest has a roster row but no
account, so a user-keyed table could never carry their cells and spectators
watched a guest's column sit blank all game — which stopped being tolerable
once the host became the only person who could fill one in.

Not read on finalize: the host's payload is the grid (see
`POST /sessions/{code}/finalize`).
| Column | Type | Notes |
|--------|------|-------|
| session_id | UUID FK | → play_sessions |
| participant_id | UUID FK | → play_session_participants (guests included) |
| round_index | SMALLINT | 0-indexed, capped at 64 |
| score | INTEGER | nullable (blank cell) |
| PK (session_id, participant_id, round_index) | | |

### boardgamebuddy_chapter_types (lookup)
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | `setup`, `player_turn`, `card_reference`, `scoring`, `tips`, `variant` |
| label | TEXT | human label |
| icon | TEXT | icon name resolved by `ui/icons.js` (unknown names fall back) |
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
- `GET /api/v1/boardgame_buddy/games` — catalog browse. `include_expansion_counts` (default **true**) gates a second DB round trip per page that fills `game.expansion_count`; the explorer's polaroid grid never renders it and passes `false`, halving the round trips on that path. Ordering is `created_at DESC, id DESC` — the `id` tiebreaker is load-bearing, not cosmetic: `created_at` is nullable and bulk BGG imports share a transaction timestamp, so without it paginated calls repeat and skip games. Backed by `idx_bgb_games_browse` (migration 051).
- `GET /api/v1/boardgame_buddy/collection/status-map` — the viewer's `{game_id: status}` map plus owned-expansion counts per base game, in one DB round trip (`bgb_collection_status_map`). What the web client actually needs from a collection read; it used to derive these from `GET /collection` at a cost of three unbounded round trips. `GET /collection` is unchanged for the native app.
- `GET /api/v1/boardgame_buddy/collection/shelf` — a **whole** shelf in one response, for client-side paging. Params: `status` (owned / wishlist / played), `exclude_expansions` (default true), `limit` (default 1000, hard cap 5000), `user_id`. Returns `{items, total, truncated, generated_at}`, pre-sorted the same way `/collection/grid` sorts by default so the caller can slice without re-sorting. Deliberately takes **no** search/filter/page params — one cache entry per shelf, with every page, filter and search derived on the client. One DB round trip (`bgb_collection_shelf`), down from the grid's two-to-three: it reads the denormalized `game_*` columns instead of joining `boardgamebuddy_games`, folds play stats in as a LATERAL, and computes `expansion_count` in SQL. `truncated` marks a shelf past `limit`, and the web client then falls back to `/collection/grid` for search/filter rather than narrowing an incomplete list. This is what the Collection and Wishlist spokes use; a page turn there costs **zero** requests.
- `GET /api/v1/boardgame_buddy/collection/grid` — paginated owned collection sorted by `last_played_at DESC NULLS LAST, added_at DESC` by default. Supports `search`, `players`, `playtime_min/max`, `play_mode`, `exclude_expansions` (default true), `sort` (`last_played` / `added_at` / `alphabetical`), and `user_id` (target user; defaults to the viewer — profiles are public). Two round-trips: collection+game join, then plays for the matching set, plus one more to tally each page's `game.expansion_count` — the catalog-wide number of expansions pointing at that base game, which drives the tile badge. Still the paginated/server-filtered path, used by the native app (`app/src/api/client.js`) and the web game explorer; the Collection and Wishlist spokes moved to `/collection/shelf`.
- `GET /api/v1/boardgame_buddy/games/recently-played?limit=6` — distinct games the caller has logged plays for, sorted by latest `played_at DESC`. Used by the inline game-picker dropdown on the host Gather screen for its first-focus suggestions.
- `POST /api/v1/boardgame_buddy/collection`
- `PATCH /api/v1/boardgame_buddy/collection/{game_id}`
- `DELETE /api/v1/boardgame_buddy/collection/{game_id}`
- `GET /api/v1/boardgame_buddy/plays` — paginated plays the target user logged + participated in. Each play includes `is_own`, `logged_by_id`, `logged_by_name`. Supports `page`, `per_page`, `game_id`, `buddy_id` (treated as a player_user_id filter post-migration-009), `search` (free-text match on game name OR any player's display name), and `user_id` (target user; defaults to the viewer — profiles are public).
- `POST /api/v1/boardgame_buddy/plays` — one round trip: the whole write (play row + players + expansions) happens inside the `bgb_log_play` RPC (migration 042). Migration 044 dropped its legacy buddies-roster insert — the only reader of that roster was `GET /plays/filter-options`, which was removed as uncalled. **Idempotent when the body carries `client_key`** (migration 048): a key this user already has a play for returns that play instead of writing a second one, still as a 201. The key is minted when the host taps Save and carried by every attempt — the live write and any later outbox flush — which is what lets a failed live write be handed to the queue without risking a duplicate. `POST /sessions/{code}/finalize` inherits the guard (it goes through `bgb_log_play`) and reads the stored row back the same way.
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
- `GET /api/v1/boardgame_buddy/feed?cursor=&limit=20` — Strava-style mixed feed (plays + hot games + suggested buddies). Cursor-paginated via `created_at`. Both rails are composed into this response by `feed_service.build_feed_page`; they have no standalone endpoints.
- `GET /api/v1/boardgame_buddy/users/me/stats` — Strava-style aggregate stats for the current user
- `GET /api/v1/boardgame_buddy/users/{user_id}/stats` — same shape for any user (profiles are public)
- `GET /api/v1/boardgame_buddy/users/{user_id}/profile` — public profile + buddy-relation flags
- `GET /api/v1/boardgame_buddy/search?q=&include_bgg=false` — unified game search (collection → DB; BGG only when `include_bgg=true`). Expansions are excluded from every source unless `include_expansions=true` — they aren't pickable as a session's main game and are added through the base game's expansion section instead.
- `POST /api/v1/boardgame_buddy/sessions` — open a short-code play session (body `{game_id?}`). Closes any prior open session for the same host first.
- `GET /api/v1/boardgame_buddy/sessions/joinable` — list active sessions the caller can join (phase=gather where caller is participant/host/host-buddy). Drives the Play tab's Join half (JoinPanel).
- `GET /api/v1/boardgame_buddy/sessions/{code}` — poll target for the lobby. Carries a `scores` array (participant_id, round_index, score) while phase='play', `[]` otherwise — the live grid, for spectators whose own client can't read the scores table (migration 054)
- `PATCH /api/v1/boardgame_buddy/sessions/{code}` — host updates the lobby (body `{game_id?}`)
- `PATCH /api/v1/boardgame_buddy/sessions/{code}/phase` — host advances the cascading flow (body `{phase: 'gather'|'play'|'settle'|'finalized'|'abandoned'}`). Transitions enforced: gather→play→settle→finalized, plus any→abandoned. Joiners watch this column via Realtime.
- `POST /api/v1/boardgame_buddy/sessions/{code}/join` — join a session by code. Returns 409 once the session has moved past phase=gather.
- `POST /api/v1/boardgame_buddy/sessions/{code}/participants` — host-only. Adds a buddy (with `user_id`) or a ghost (name-only, `user_id=null`) to the lobby roster so joiners see the player. Gather-only.
- `DELETE /api/v1/boardgame_buddy/sessions/{code}/participants/{participant_id}` — host-only. Removes a participant from the lobby roster. Refuses to remove the host themselves. Gather-only.
- `DELETE /api/v1/boardgame_buddy/sessions/{code}` — host abandons a session
- `POST /api/v1/boardgame_buddy/sessions/{code}/finalize` — write a play row from the session. **The host's payload is the grid** and the RPC writes it verbatim; it does not read `boardgamebuddy_play_session_scores` at all (migration 053). It used to overlay live per-round totals onto the payload — 042 as an override, 052 narrowed to a fallback — to recover cells joiners had authored that the host's draft had never seen. Host-only scoring makes that case impossible, and `play-flow-view._commitResolvedScores` already folds the live overlay into the draft before building the payload, so an overlay could now only ever disagree with it: exactly the "saved total doesn't match its own rounds" bug 052 was written to fix.
- Session create/join/get/joinable (and every session endpoint's response payload) are single Postgres RPCs as of migrations 036-038 (`bgb_create_session` / `bgb_join_session` / `bgb_get_session` / `bgb_joinable_sessions` / `bgb_session_bundle`) — previously 4-6 sequential PostgREST round trips per request, which made host/join taps, the 2s lobby poll, and the joinable-sessions list crawl at cross-region RTTs. See `db/functions/boardgamebuddy.sql`.
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
| `/play` (also `/join`) | `log-play` | — | — | The Play tab: Host half on top (resume banner + Host a game / Another Round / Game Explorer), Join half below (code entry + active sessions). `/join` is an alias for the retired standalone Join screen so old links still land here. |
| `/play/:code` | `play-flow` (host) **or** `session-viewer` (joiner) | `code` | — | Active session. URL is shared by host & joiners — play-flow's onMount fetches the lobby and hops to session-viewer if `host_user_id` isn't the current user. `_ensureLobbyOpen` calls `router.replaceUrl("play-flow", { code })` once the host's lobby opens so `/play` becomes `/play/{code}` without a back-stack entry. |
| `/games` | `game-explorer` | — | — | Game Explorer: My Collection ↔ All BgB Games toggle + players / play time / type filters over a paginated polaroid grid. Tapping a game stages it and opens Gather prefilled. |
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

- `splash` — transient loading view between boot and Supabase auth resolving. Never pushed to history, never appears in the back stack. It is also the one screen with no bottom nav, so a boot that never finishes has no escape hatch: `init.js` arms a **12s watchdog** that routes forward anyway — to the normal destination when a session is in hand (the destination paints its own skeleton and reconciles when `/bootstrap` lands), to `/auth` when nothing resolved at all. The fallback never sets `_bootRouted`, so a late auth callback still routes the user correctly on its own.

**Back-stack semantics:** `router.back()` defers to `history.back()`; the popstate handler replays the entry's state (or falls back to `matchPath()` for direct loads). An internal `_stack` is kept in parallel only because the browser doesn't expose history-entry metadata — `peekBack()` reads it to label back affordances ("Back to game details", etc.).

## Screen Flow
Bottom nav has three tabs: **Feed**, **Log**, **Profile**.

1. Auth (login/signup) → splash → 2. **Feed** (home): chronological mix of plays from the viewer and their accepted buddies, plus inline "hot this week" / "buddies you may know" rails. A search pill at the top opens the **Game Search** screen.
3. **Log a play**: the Play tab is split — **Host on top, Join on the bottom**.
   The Host half offers three cards: **Host a game** drops straight into the cascading three-screen flow (`play-flow`) with an empty game slot; **Another Round** (only when there's a recent play) reseeds the last game + roster and lands on Gather; **Game Explorer** opens `/games`, where players / play time / type filters over the user's collection or the whole library help pick a game — selecting one opens Gather with it prefilled. A "Resume hosting?" banner sits above the cards whenever a non-terminal draft exists.

   **Host a game always means a NEW game** — fresh draft, fresh session code, empty game slot — even when a resumable draft exists. The Resume banner is the only thing that continues a session. Starting a new play ends the previous one (`bgb_create_session` abandons the host's other open sessions), the same way Another Round already abandons deliberately. Until 2026-08-25 the card skipped its draft-clear whenever a resumable session existed, so a host who tapped it landed back in the old session, code and all.
   The Join half is the `JoinPanel` widget: a 5-char code input plus a 10s-polled list of active sessions where the user is a participant or the host is a buddy (sessions past Gather are labelled **Spectate**).
   The Log a play cascade has three snap-scroll screens:
   - **Gather** — pick a game, set game type (competitive/team/co-op), manage the player list. A session code opens on entry and is shown at the top of the screen; other phones can join via code while the host is on Gather. Joiners stream into the player list via polling.
   - **Play** — full-width reference guide on top, scoring grid below. **The host is the only person who scores.** They have full grid access (add rounds, override winners) and every cell they touch streams one-way to everybody else via Supabase Realtime against `boardgamebuddy_play_session_scores`; joiners and spectators get the same grid, read-only, and cannot write at all (RLS enforces it — migration 053). Guests are on the table like anyone else: scores are keyed by participant row rather than by account, so a guest's column streams too. Scores may be negative; a "± Negative" header toggle (default off, remembered) reveals per-cell +/− sign buttons for keyboards that lack a minus key.

     Joiners used to own their own column. Collapsing that to host-only removed the whole reconciliation problem it created — the per-column edit mode in the grid widget, the caret-preservation dance on every repaint of the mirror, the two-principal RLS policy, and the finalize-time merge of "what the host typed" against "what joiners streamed in" that migration 052 existed to un-break.

     The read-only grid is the same widget in its other mode: same columns, same score font, same round labels, same Total row, minus the input chrome. Read cells carry `.scoring-cell--read` and deliberately **not** `.scoring-cell` — the border/fill/radius there is input chrome, and a table of boxes nobody can type in reads as a different component.

     **The mirror is built out of the host's screen, card for card.** The spectator's Play step carries the same cards in the same order the host sees: the game (`Now playing`), the session code, the reference guide (with the game's Rulebook CTA — the bundle has carried `rulebook_url` all along), then the scoring grid. Both sides use the same `.cascade-card` / `.cascade-invite` / `.cascade-game` families and the same three-column screen header, whose left 44px slot rolls the phase back for the host and leaves the session for the spectator. Two things went the other way: the crumb bar that used to sit above the cascade (`Session {code}`, the view's only back affordance) is gone — the code has its own card now and the back arrow moved into the screen header — and `<main data-view="session-viewer">` dropped its `px-4 py-4`, which had been stacking on top of `.cascade-screen`'s own 12/16px gutters and squeezing every spectator card, the scoring grid included, narrower than the host's.

     **A late spectator reads the grid through the bundle, not the table.** A user who joins *after* Gather gets no row in `boardgamebuddy_play_session_participants` (`bgb_join_session`), and `bgb_session_scores_select` is scoped to host-or-participant — so their own client reads the scores table and gets zero rows back (not an error), and Realtime, gated by the same policy, never fires for them. Their grid used to sit blank at 0 for the whole game. `bgb_session_bundle` now folds a `scores` array into the (already unauthenticated, code-as-token) `GET /sessions/{code}` response while phase='play' (migration 054), and `LiveScores.seed()` takes it. The RLS SELECT policy was deliberately **not** broadened — an unfiltered grant would dump every open session's scores to every authenticated user. Two rules keep the seed honest: it is the base only for a client that has never read a row itself (`isSeedOnly()`), so a readable table always wins and an empty read from a client that can see the table means "the host cleared it", not "fall back to a stale bundle"; and the session viewer's poll drops to a 4s cadence on the seeded path, because for those spectators the poll *is* the live channel and the "Realtime is carrying it, stand down" gating would otherwise freeze the grid.

     **The Total row is the visible cells, added up — always.** `widgets/round-score-grid.js` owns the one implementation (`window.roundGridTotal`), summing the same `getCellValue` resolver over the same round count it just rendered; there is no "total resolver" opt for a caller to supply its own arithmetic, and any surface that repaints the totals row between renders (the host grid, the joiner's mirror, the play-detail popup) calls that same helper. Two rules keep it honest upstream: every player carries a dense `roundScores` array of the grid's full length (`_normalizeRoundArrays`), and a typed edit repaints the total from local state *before* mirroring to Realtime, never awaiting the write. On Save the host folds the live overlay into its own draft (`_commitResolvedScores`) so the recorded play is the grid that was on screen, and `PlayerEntry` on the backend re-derives `score` from `round_scores` whenever a breakdown is present.
   - **Settle Up** — host only. Optional photo upload + "Key moments" notes textarea (reuses the play's `notes` column), then Save. Save calls `/sessions/{code}/finalize` which merges live scores into the canonical play and marks the session finalized.
   When the host advances Gather→Play, the lobby closes (`POST /sessions/{code}/join` returns 409 thereafter). When the host enters Settle Up, every non-host joiner sees a polaroid splash popup centered on the screen with the game thumbnail and current winner; tapping the X dismisses to a refreshed feed.
   **The host's Save doesn't wait for anything.** Tapping Save puts the same "Well played!" polaroid up in the same frame, with the host-only **Another round?** and the corner **X** live immediately, and runs the finalize behind it (photo uploading *in parallel* rather than after). The card carries no save state at all: the upload queue guarantees the play is recorded, so there is nothing for the host to watch. A failed write — any failure, not just a network one — hands the play to `domain/outbox.js` under the same `client_key` the live attempt carried, so a request that actually landed and only lost its response can't be written twice; the header's upload indicator owns it from there, and the card says "Saved on this device" if it's still up. The one case that stops the host is the queue write itself failing (no room in localStorage): that gets a modal and puts the draft back on Settle Up. A failed photo upload is still just a warning line on the card. **Another round?** opens a *new* session pre-seeded with the same game, expansions, play mode and roster — teams included, scores and winner reset — landing on Gather under a new code. Because it can now be tapped mid-write, two things are guarded: every post-write touch of view state is skipped when the draft it belonged to has been replaced (`_isStaleSave`), and the new lobby's `POST /sessions` waits for the previous write to settle (bounded at 8s) — `bgb_create_session` abandons the host's other open sessions, and minting early would close the lobby the finalize is about to write to, leaving spectators on 'abandoned' instead of their wrap-up card. The carried-over roster is pushed to the new lobby as participants, so the previous joiners see it in their Join list.
   The draft auto-persists to localStorage (metadata only, plus current phase); the photo blob stays in memory. The chooser surfaces a "Resume hosting?" banner when a non-terminal draft exists.

   **The lobby is a nice-to-have; recording the play is not.** Nothing about the session code can stop the host from playing and saving — the cascade runs off the draft, and Save falls back to `POST /plays` when there is no usable code. Every `/sessions/{code}` write goes through `_withLobby()`, which on a *definitive* dead-lobby answer (404/410/403/409, and the 400 for a transition out of a terminal session) drops the lobby, mints a replacement and retries once; a blip (offline, 5xx) is left alone, because minting abandons the host's other open sessions and reacting to a hiccup would kill a live one. Healing is single-flight (`_healLobby`) — `_syncRosterToLobby` fails N writes at once, and without it each would mint a session that abandoned the one before it. When the code does change mid-run, `_onLobbyReplaced` clears the now-dangling `participant_id`s, re-pushes the roster, restarts live scores, and the invite card says *"New code — share it again"* for a few seconds. No toast, no modal: the swap can happen while the host is typing in the scoring grid.

   `PlayFlowView` is a singleton, so `onMount` drops `_lobby` unless it still matches the draft's (or the URL's) code — `_resetRunState()`. Without that a finished session's code survived into the next one: `_lobbyReady()` short-circuits on `_liveLobbyCode()`, so `_ensureLobbyOpen()` never re-ran, the invite card showed a code nobody could join, and Continue bounced off a 404 with the phase rolled back. `_advancePhase` no longer rolls back or reports at all — the local phase is the truth the host is looking at and the lobby only mirrors it.

   **Offline mode.** The same three screens with the entire lobby subtracted — no `POST /sessions`, no code, no 2s poll, no Realtime, no phase PATCH, no photo. All of that exists to serve joiners, and there can't be any without a server. What remains already ran locally: the game picker and player picker paint from `bgbCache` (`game.recent` / `buddy:all`, warmed by `/bootstrap` at 24h fresh / 7d stale), the draft lives in localStorage, and Save hands the play to `domain/outbox.js` instead of the API.
   - **Entering — entirely automatic, never chosen.** `domain/net.js` (`window.BgbNet`) is the single source of truth. Two signals decide: `navigator.onLine === false`, and **two** consecutive `fetch` network failures (two, not one — a single request can fail for reasons unrelated to the link, and flipping the whole app on that is worse than the problem). A completed HTTP response outranks both: it is direct proof of reachability, so it overrides a stale `navigator.onLine === false`, which would otherwise strand the app with no way out since every probe would be judged by the flag it was trying to correct. There is **no** offline switch in the UI — the Play tab's cards are identical online and offline, only their copy changes. `PlayFlowView` latches the answer once at mount so its guards can't disagree mid-cascade; **Save is the one place that re-checks**, so a host who walked back into signal gets a live write.
   - **Every request has a deadline** (`domain/api.js`): 15s for JSON, 60s for a photo upload, with one automatic retry for a stalled `GET` on a fresh connection. A dead network *rejects* and the app recovers; a stalled request never settles at all, and no browser imposes a timeout worth waiting for — so one stalled first-paint call used to be the whole app, hanging on a loader with no error and no retry (reported from an iPhone's first launch of the freshly-installed PWA). A timeout is normalized into the same shape as a network error (`err.offline`, `err.status = 0`, plus `err.timeout`) and counts as one strike toward offline mode: a link on which requests never complete is offline as far as this app is concerned, and the outbox's `client_key` de-duplicates a write that may in fact have landed.
   - **Leaving.** Three paths, all converging on `BgbNet._publish()`'s offline→online edge, which is also the single place the outbox is drained: the browser's `online` event, any ordinary background request succeeding, or the user tapping **Try again** in the offline banner. That button is the only *active* probe in the system — everything else learns passively from requests the app was making anyway — and it exists for when the user can see they have signal and the app hasn't caught up. It hits `GET /health` (unauthenticated, and mandated on every project by `.claude/rules/backend-python.md`, so it can't fail for a reason that isn't connectivity); any status counts as reachable, since a 500 still proves we got there.
     - **Known gap:** on a connection that resolves and then times out (captive portal, one bar), auto-detection has to wait for two requests to actually fail, so the host sits through those timeouts before the app flips. A per-request timeout would close it, but not a blanket one — a photo upload on bad mobile upstream can legitimately run long.
   - **Uploading.** `domain/outbox.js` (`window.Outbox`) queues finished plays in `localStorage['bgb_outbox_v1']` — deliberately NOT a `bgbCache` namespace, which evicts its oldest 25% under quota pressure. Each entry carries a `client_key` UUID and the account that recorded it (a shared device must never file one user's play into another's history). `flush()` runs on boot once a profile load reaches the server, on the `online` event, and on the debounced tab-focus refresh. A network failure stops the loop with everything intact; a definitive 4xx parks that one entry as `failed` so a bad play can't wedge the queue behind it, surfaced in Settings → Pending uploads for manual discard. The queue is also where a *live* write goes when it fails, not just an offline one — see the host's Save above. When a flush lands anything it re-pulls the feed's first page and dispatches `plays-uploaded` carrying it, so a feed the user is sitting on splices the new play in rather than showing it only on the next mount.
   - **What offline can't do.** Joining (the lobby is server-side — the Join half disables itself and says so), live scores, photos (the blob is never persisted, so a queued play can't carry one), signing in, and BGG search/import. Picking a game is limited to what's already cached — `PlayCreate.game_id` is required and the catalog can't be searched, so the picker filters `game.recent` plus every warmed `game.bundle` (i.e. the user's whole owned collection) and says as much in its empty state. The reference guide still works: `Chapter.cachedMyChapters` reads through the stale window when offline rather than returning nothing.
   - **Cold start.** `web/sw.js` precaches the app shell so BgB opens from a home-screen icon with no signal at all; without it the feature would only work for people who left the tab open. See Active Development Notes.
4. **Game Search** (search pill on Feed/Profile): single ranked list — collection hits first, then DB matches. A "Search BoardGameGeek for more" button appends BGG hits on demand. **Expansions never appear here** — base games only, on every source. They live in the base game's Expansions section instead.
5. **Game Detail** (tap any game card): box art hero, status toggle (none → owned → wishlist → none), Log a Play button, BGG + Rulebook links, Expansions section, a rolled-up parchment **Reference Guide scroll** (tap either roll to open/close), and recent plays. The scroll is per-user per-game and starts empty; tap **Add a chapter** at the bottom to either Create a new one or Browse the community pool.

**Expansions section.** Rendered on every base game — on the Game Detail page (a reel of expansion polaroids) and on the host's Gather card (a collapsible toggle list). The Gather list caps at five visible rows and scrolls, with a sliver of the sixth showing so it reads as scrollable; past five rows a client-side filter field appears above it (with a × to clear), matching the displayed label or the stored full name so typing the base game's name still hits. Import expansions sits *below* the scroll box, so it stays reachable however far down the list you are. Both carry an **Import expansions** button, and it stays available when nothing is imported yet. It opens `widgets/import-expansions-modal.js`, which lists the expansions BoardGameGeek links to this game that BgB doesn't have (`GET /games/{id}/expansions/available`); each row's name has the base game's name stripped off the front, and a **+** imports it into the catalog and pins it to this base game. A filter field above the list narrows it by name — the whole list arrives in one response, so filtering is client-side (no debounce, no second request) and matches both the displayed name and BGG's full name, so typing the base game's name still hits. Escape backs out of the filter before it closes the popup. Import is catalog-only — it doesn't touch the caller's collection. On the Game Detail page the new expansion appears in the reel as soon as the import returns — the endpoint answers with the finished `ExpansionListItem`, so the reel takes it directly (name-ordered, matching the bundle RPC) and only that section repaints, with a forced bundle refetch reconciling in the background. Since expansions are hidden from search, this popup is the only way one enters the catalog, so the base game has to be imported first.

**Expansion count badge.** Collection and wishlist tiles carry a `git-fork N` chip counting every expansion **the catalog holds** for that base game — the same number as the game page's "Expansions (N)" heading, tooltip "N expansions in Boardgame Buddy". It used to count only expansions the viewer *owned*, which read as zero for a game with eleven of them, since importing is catalog-only. The count rides on `game.expansion_count`, which `bgb_collection_shelf` computes in SQL — so the badge is correct on the first cached paint. (It previously came from `/collection/grid` only, and the profile-bundle seed doesn't compute it, so the badge used to pop in when the grid fetch landed.) Feed rails still show the owned count (their rows come from `bgb_hot_games`, which doesn't carry the total) — their tooltip says "owned", so the two stay truthful.

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
- **The Game Explorer repaints surgically; a chip tap touches no node it doesn't have to.** Caching alone didn't make filtering feel fast — the view rebuilt the whole container twice per tap, which destroyed the chip *under the user's finger* (so `:active` never painted and the tap read as ignored), reset the horizontally-scrolling `.lp-chip-row` to `scrollLeft` 0, and recreated all nine `<img>` nodes. Those images are cached, but they carry `loading="lazy"`, which defers a freshly-inserted image to the next rendering opportunity — hence a one-frame blank photo on every tap.
  - `render()` now ensures the shell (`#gx-grid-host` / `#gx-pager-host`) and otherwise patches. It needs no `_structuralSig` (unlike `collection-view.js`) because nothing in the shell outside the patched regions is state-dependent.
  - **Chips are updated by class only, never re-emitted.** That required making the chip `onclick` strings state-*independent* — `_setFilter` toggles rather than the markup encoding which of set/clear a tap means. A value-encoding onclick would go stale the instant the class changed without the markup.
  - `_paintGrid()` reconciles by `data-game-id`: retained cards are *moved* (which preserves their live `<img>` and decoded pixels) and only new cards are built. New cards pass `eager: true` to `renderGamePolaroid` — a 3×3 grid is one viewport, so lazy-loading only costs a frame there.
  - The warm path is fully synchronous: `_loadGames` peeks `Collection.cachedShelf()` and paints in the tap's own frame. It used to set `_loading = true` and render *before* knowing whether the data was local, paying two paints for a loading state that (being microtask-adjacent) was never visible.
  - The `added_at` sort is memoised per shelf object. Filtering only removes rows, so the order is filter-independent; it previously re-sorted up to 1000 rows with `localeCompare` on every tap. ISO-8601 strings compare identically with `<`/`>`, and `game_id` breaks ties so paging is stable.
  - A `truncated` shelf only falls back to the server when the user is actually *narrowing* it, matching `ShelfController.serverFallback`.
- **Three more surfaces page or read from cache instead of round-tripping.** Same model as the Collection spokes.
  - **Game Explorer** (`web/views/game-explorer-view.js`): the "My Collection" scope pages, filters and sorts off the already-warmed owned shelf via `ShelfFilter` — zero requests for a page turn or a filter chip. It re-sorts by `added_at DESC` because that grid orders by when a game was added, not when it was last played; `added_at` is NOT NULL, so it needs none of the NULLS-LAST care the collection spokes take. The "All BgB Games" scope is cached per query string under `game.explorer` (3 min fresh / 30 min stale), so page-back and scope-toggle-back are free. A shelf past the endpoint's row cap falls back to `/collection/grid`.
  - **Plays** (`web/domain/play.js`): `Play.list()` was the only domain call with no cache wrapper, so every mount, every debounced keystroke and every return visit re-fetched pages already seen. Now SWR under `play.list` keyed `user|game|buddy|search|page|perPage`, with `Play.cachedList()` for the first-frame paint. Paging is offset-based, so a single insert shifts every page after it — `_invalidatePlayDeps()` therefore clears the **whole namespace**, never one key.
  - **Status pills** (`web/domain/collection.js`): reads `GET /collection/status-map` (one bounded round trip) rather than deriving them from `GET /collection` (three unbounded ones, of which everything but two dicts was discarded). `GET /collection` still exists unchanged for the native app.
- **The Collection and Wishlist spokes page entirely on the client.** They fetch one whole shelf via `GET /collection/shelf` (cached in `bgbCache` under `collection.shelf`, key `${target}|${status}`, 60s fresh / 5min stale) and derive every page, filter and search from it. A page turn, a filter chip and a keystroke all cost **zero** requests. Before this, each of those was its own uncached `/collection/grid` round trip — ~1s per page turn — even though the backend was already materializing the whole shelf on every one of them and slicing it in Python.
  - Shared logic lives in `web/domain/shelf-controller.js` (load / derive / page / filter state) and `web/domain/shelf-filter.js`. **`shelf-filter.js` is a line-for-line port of `_passes_grid_filters` in `collection_routes.py` and must be kept in step with it** — three behaviours look like bugs and are deliberate: search is a plain case-insensitive substring test; the "6+" player chip skips the `min_players` check; and a game with no `playing_time` passes a `playtime_max` filter but fails a `playtime_min` one.
  - **Never re-sort client-side.** The RPC returns the shelf pre-sorted and filters only remove rows, so slicing is order-identical to the old endpoint. Re-deriving the NULLS-LAST tie-break in JS would only risk drift.
  - Invalidation is namespace-wide (`Collection.invalidateShelves()`), hooked into `Collection.invalidateMyStatusMap()` and `Play._invalidatePlayDeps()`. Per-key wouldn't do: an add lands on owned *or* wishlist, a status change moves a game *between* shelves, and removing an owned game can make it reappear on the played shelf.
  - A shelf past the endpoint's row cap comes back `truncated`; narrowing one of those falls back to `/collection/grid`, so search never silently misses games in a huge collection.
  - Repaints are surgical — `#collection-grid-host` / `#collection-pager-host` (and the wishlist twins). A page turn rewrites those two subtrees only. A full `container.innerHTML` per page turn is itself the "laggy" feel, independent of the network.
- **BgB is an installable PWA, and its service worker caches where travel-scrapbook's deliberately doesn't.** `projects/travel-scrapbook/web/sw.js` is a documented no-op: "the app is a thin shell over the API and stale HTML/JS causes more trouble than offline support is worth." That holds for an app whose every screen needs the server. It doesn't hold here, because the host cascade genuinely runs with no backend — without a cached shell, offline mode would only work for someone who never closed the tab. The stale-bundle risk is answered rather than accepted: `sw.js` keys its cache on a `__BGB_BUILD_ID__` placeholder that `.github/workflows/deploy-frontend*.yml` stamps with the commit SHA, so every deploy lands in a fresh cache and `activate` deletes the old one. Left un-stamped in the repo, which `sw.js` reads as local dev and disables itself — a dev editing JS is never served yesterday's copy.
  - The precache list is **derived at install time** from `index.html` and `styles.css`, not hand-written: this is a no-build-step project where modules arrive as `<script>` tags, and a hand-kept list would silently drift the first time someone added one.
  - `vercel.json`'s catch-all rewrite returns `index.html` with a **200** for a missing asset, so a mistyped or deleted script would otherwise be cached as a `.js` file containing the whole page and break the app on the *next* boot. `precacheOne` rejects an HTML body under a non-HTML URL and fails the install loudly instead, leaving the previous worker in charge.
  - The API and `*.supabase.co` are never intercepted. Read freshness is `bgbCache`'s job (TTLs, schema version, explicit invalidation); write retry is the outbox's.
  - **Registration waits for `load`, and the precache runs 6 at a time.** A first-ever install fetches the whole shell with `cache: "reload"` — ~60 requests — and that is the one launch where the app also has nothing cached and is fetching `/bootstrap` and the feed over the same radio. Nothing in the precache is needed until the *next* launch, so it gives way rather than racing the screen the user is looking at.
- Pilot project for Supabase Auth across the monorepo
- Hybrid data: pre-seeded top 1000 BGG games + live BGG API search
- Reference guides are user-built (migration 018). No curated defaults, no admin seed content, no bulk import. A chapter can be AI-drafted from the editor, but the draft only ever lands in the form — a user reviews and saves it, so every chapter in the pool is still one a person chose to publish.
- **The chapter authoring guide lives in two places and must stay in sync**: `CHAPTER_AUTHORING_GUIDE` in `web/views/reference-guide-add-view.js` (the in-app modal + the .md download) and `_AUTHORING_GUIDE` in `shared-backend/routes/boardgame_buddy/services/chapter_ai.py` (what "Generate with AI" hands the model). Both must match what `web/ui/markdown.js` actually renders; anything else shows up as literal text.
- **Testing the chapter editor requires the real DOM.** Every rule that positions the create/edit shell is gated on `main[data-view="reference-guide-add"].chapter-edit-locked:not(.hidden)`, so a test that renders the view into a scratch `<div>` matches none of them and validates a layout that does not exist on a phone. The shell is `position: fixed`, sized from `--bgb-vv-h` / `--bgb-vv-top` (published by `web/ui/viewport-lock.js`), and its footer is the last `flex: none` child — which is what falls off-screen when those vars go stale. Mobile Chrome on iOS drops `visualViewport` resize events across toolbar and keyboard transitions, so treat the vars as untrusted: the shell height is clamped with `min(..., calc(100dvh - var(--bgb-vv-top)))`, and `_syncEditorChrome()` re-syncs on every render plus a debounced settle pass for the keyboard-dismiss animation.
- Game detail pages themed with accent color + header image from box art
- BGG XML API has a daily request quota. Imports prefer bundle metadata (skips the API call when player counts + playtime are present); image refresh is admin-gated and sequential to spread requests across the day.
