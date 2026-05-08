# Day Word Play — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-05-08

## What This App Does

Day Word Play is a daily vocabulary challenge with friends. Every day, all members of a group get the same randomly selected word. Each user writes a sentence using that word. The next day, everyone votes on their favourite sentence, and the cycle repeats. A leaderboard tracks who has earned the most votes over time. Users can also bookmark words to build their personal "friend dictionary". Groups are created or joined using a searchable list + 4-letter join code.

## Current Status
- Stage: Prototype (Stage 3) — Native app scaffold built
- Web prototype: implemented, not yet deployed
- Backend: implemented, registered in shared Railway service
- Native app: dev-only build, full feature parity with web (email + Google OAuth). EAS / store assets deferred.

## Tech Stack
| Layer | Technology | Notes |
|---|---|---|
| Web frontend | Vanilla HTML/CSS/JS + Pico.css | Warm beige theme, deployed to Vercel |
| Backend | Python FastAPI (shared service) | Routes at `/api/v1/daywordplay/...` |
| Database | Supabase (shared project) | Tables prefixed `daywordplay_` |
| Auth | Supabase Auth (email + Google + Apple) | JWT verified via shared `jwt_auth.py`; profile row in `daywordplay_profiles` keyed off `auth.users.id` |
| Native app | React Native / Expo SDK 54 | Dev build runnable in Expo Go; consumes the same Railway backend + Supabase project as web |

## Directory Layout
```
projects/daywordplay/
├── web/
│   ├── index.html      — App shell (light/beige theme, modular scripts)
│   ├── styles.css      — Full custom styles (warm beige palette)
│   ├── config.js       — Sets window.APP_CONFIG.apiBase + Supabase keys
│   ├── state.js        — Global state variables + analytics ping
│   ├── helpers.js      — apiFetch, icons, renderApp, showView, formatDate
│   ├── auth.js         — Supabase Auth (email + Google + Apple)
│   ├── home.js         — Word of day view + sentence submission
│   ├── vote.js         — Yesterday's sentences + voting
│   ├── leaderboard.js  — Group leaderboard
│   ├── groups.js       — Group search/join/create
│   ├── dictionary.js   — Bookmarked words
│   ├── profile.js      — User profile + logout
│   ├── admin.js        — Admin tools (gated by ADMIN_API_KEY)
│   ├── init.js         — DOMContentLoaded boot + tab switching
│   └── auth-callback.html — Bridge that forwards Supabase OAuth redirects to the native deep link
├── shared/             — Pure ESM shared between web (future bridge) and native
│   ├── api.js          — makeApi({ fetchFn, getAuthToken, baseUrl }) factory
│   ├── constants.js    — GROUP_CODE_LEN, MIN_SENTENCE_LEN, CACHE_TTL_MS
│   ├── themeTokens.js  — COLORS, SPACING, RADII palette (beige/teal)
│   ├── validation.js   — sentence + group code/name validators
│   ├── format.js       — formatDate, tokenizeWithWord
│   ├── index.js        — re-exports
│   └── package.json    — { type: "module" }
├── app/                — React Native / Expo dev build
│   ├── App.js          — Boot error boundary → MainApp
│   ├── app.json        — Expo config (slug daywordplay, scheme daywordplay)
│   ├── babel.config.js — module-resolver alias #shared → ../shared
│   ├── metro.config.js — watchFolders + extraNodeModules alias for #shared
│   ├── .env.example    — EXPO_PUBLIC_* env vars; copy to .env locally
│   ├── assets/         — dwp-logo.svg (icon/splash PNGs deferred to store-prep)
│   └── src/
│       ├── MainApp.js          — NavigationContainer, font + auth bootstrap, OAuth deep-link handler
│       ├── theme.js            — Re-exports #shared/themeTokens + native shadows
│       ├── api/client.js       — Wraps #shared/api with Supabase token getter (reads from supabase.auth.getSession())
│       ├── auth/               — supabase.js, secureStorage.js, google.js (OAuth via web bridge)
│       ├── store/AppContext.js — useReducer + split state/dispatch/actions contexts
│       ├── components/         — DwpLogo, GroupSwitcher, WordDisplay, HighlightedSentence, banners
│       ├── screens/            — Auth, Home, Vote, Leaderboard, Groups, JoinByCode, CreateGroup,
│       │                         Dictionary, ProposeWord, Profile, Admin
│       └── utils/analytics.js  — fire-and-forget /api/v1/analytics/track
└── STRUCTURE.md

shared-backend/routes/daywordplay/
├── __init__.py         — Router + imports
├── models.py           — Pydantic request/response models
├── constants.py        — (placeholder; auth handled by shared jwt_auth.py)
├── dependencies.py     — CurrentUser + get_current_user (resolves Supabase JWT → profile)
├── profile_routes.py   — health + get/upsert/delete profile + become-admin
├── group_routes.py     — list, create, join, leaderboard, leave
├── word_routes.py      — today, yesterday, sentences, votes, bookmarks
└── admin_routes.py     — admin-key gated word/group/proposal management

db/migrations/daywordplay/
├── 001_baseline.sql        — Legacy custom-auth tables (superseded by 003)
├── 002_seed.sql            — ~90 vocabulary words (preserved across 003)
└── 003_supabase_auth.sql   — Drops daywordplay_users + dependents, recreates everything against auth.users via daywordplay_profiles
```

## Data Model

- **daywordplay_profiles** — id (= auth.users.id), display_name, avatar_url, is_admin, created_at — auto-created on first authenticated request
- **daywordplay_groups** — id, name, code CHAR(4) UNIQUE, created_by→users, created_at
- **daywordplay_group_members** — id, group_id, user_id, joined_at — UNIQUE(group_id, user_id)
- **daywordplay_words** — id, word, part_of_speech, definition, pronunciation, etymology
- **daywordplay_daily_words** — id, group_id, word_id, assigned_date DATE — UNIQUE(group_id, assigned_date)
- **daywordplay_sentences** — id, group_id, word_id, user_id, sentence, assigned_date, created_at — UNIQUE(group_id, user_id, assigned_date)
- **daywordplay_votes** — id, sentence_id, voter_user_id, created_at — UNIQUE(voter_user_id, sentence_id)
- **daywordplay_bookmarks** — id, user_id, word_id, created_at — UNIQUE(user_id, word_id)

## API Endpoints

All routes at `/api/v1/daywordplay/...`. Supabase Auth Bearer token required unless noted.

### Profile
- `GET /health` — Health check. No auth.
- `GET /profile` — Current user's Day Word Play profile.
- `POST /profile` — Upsert current user's profile. Body: `{display_name, avatar_url?}` (auto-called by the frontend on first sign-in).
- `DELETE /profile` — Delete the current user's account; ON DELETE CASCADE wipes group memberships, sentences, votes, bookmarks, etc.
- `POST /profile/become-admin` — Promote the current user to admin. Body: `{admin_key}` (must match Railway `ADMIN_API_KEY`).

### Groups
- `GET /groups?q=` — List/search all groups (annotated with member_count, is_member).
- `GET /groups/mine` — Current user's groups.
- `POST /groups` — Create group. Body: `{name}`. Auto-generates 4-char code, auto-joins creator.
- `POST /groups/join` — Join by code. Body: `{code}`.
- `GET /groups/{id}` — Group detail + member list. Must be a member.
- `GET /groups/{id}/leaderboard` — Vote totals per member, all-time. Must be a member.
- `DELETE /groups/{id}/leave` — Leave a group.

### Words / Sentences / Votes
- `GET /groups/{id}/today` — Today's word (lazy-assigned). Returns submission status for current user.
- `POST /groups/{id}/sentences` — Submit sentence for today. One per user per day.
- `GET /groups/{id}/yesterday` — Yesterday's word + all sentences + vote counts + has_voted flag.
- `POST /sentences/{id}/vote` — Vote for a sentence. One vote per user per group per day. Cannot vote for own.
- `GET /words/bookmarks` — User's bookmarked words (friend dictionary).
- `POST /words/{id}/bookmark` — Bookmark a word (idempotent).
- `DELETE /words/{id}/bookmark` — Remove bookmark.

## Screen / Page Flow

```
Auth Screen (not logged in)
├── Login tab
└── Register tab

App Shell (logged in)
├── Top Header: avatar → Profile | bookmark pill → Dictionary
├── Word Tab (default)
│   ├── Home view: today's word + sentence input (or submitted state)
│   │   └── → Vote button: yesterday's sentences
│   └── Vote view: sentence cards + vote button
├── Groups Tab
│   ├── My groups list (tap to switch active group)
│   ├── Search/discover groups
│   ├── Join modal (4-letter code)
│   └── Create modal (group name)
└── Stats Tab
    ├── Leaderboard view
    └── → Dictionary button
```

## Key Business Logic

- **Word assignment (lazy):** When the first user of a group requests today's word, if no word is assigned for `date.today()`, a random unused word is picked from `daywordplay_words` and inserted into `daywordplay_daily_words`. Race conditions are handled by catching insert conflicts.
- **One sentence per day:** `UNIQUE(group_id, user_id, assigned_date)` enforces this at the DB level.
- **One vote per day per group:** Before inserting a vote, the backend finds all sentence IDs for the group on yesterday's date and checks if the user has already voted on any of them.
- **Cannot vote for own sentence:** Checked in the vote route — returns 400 if `sentence.user_id == current_user.user_id`.
- **Leaderboard:** Aggregates votes received across all sentences for a group, grouped by user.
- **4-letter group codes:** Generated randomly from A-Z + 0-9, uniqueness verified before insert.
- **Word cycle reset:** If all words have been used in a group, the used-list resets so all words become available again.

## Environment Variables
| Variable | Used In | Purpose |
|---|---|---|
| `SUPABASE_URL` | shared-backend | Supabase project URL (Railway). Also used by `jwt_auth.py` to fetch the JWKS for token verification. |
| `SUPABASE_SERVICE_ROLE_KEY` | shared-backend | Server-side DB access (Railway) |
| `ADMIN_API_KEY` | shared-backend | Shared admin bearer token; also accepted by `POST /profile/become-admin`. |
| `VIBELAB_SUPABASE_URL` | GitHub Secrets | Injected into `web/config.js` at deploy time. |
| `VIBELAB_SUPABASE_ANON_KEY` | GitHub Secrets | Injected into `web/config.js` at deploy time. |

## Development Setup
```bash
# Backend (from vibelab root)
cd shared-backend
source .venv/bin/activate
uvicorn main:app --reload --port 8000

# Web prototype
# Update projects/daywordplay/web/config.js apiBase to http://localhost:8000
# Open projects/daywordplay/web/index.html in browser
# Or: npx serve projects/daywordplay/web
```

## Active Development Notes

- 2026-03-17 — Stage 3 complete. Backend + web prototype built. Pending: deploy to Vercel + Railway, add DAYWORDPLAY_JWT_SECRET env var in Railway, run migrations in Supabase, update webUrl in registry.json.
- 2026-05-08 — Switched auth to Supabase (email + Google + Apple), matching sauceboss/boardgame-buddy. Replaced `daywordplay_users` with `daywordplay_profiles` keyed off `auth.users(id)`. Manual steps before deploy: enable email/Google/Apple in Supabase, add `https://vibelab-daywordplay.vercel.app` and `/**` to redirect URLs, run `db/migrations/daywordplay/003_supabase_auth.sql`, remove the now-unused `DAYWORDPLAY_JWT_SECRET` from Railway.
- 2026-05-08 — Native app (Stage 4) scaffolded. Expo SDK 54 + RN 0.81 dev build covering all web flows (auth, today's word + submit, vote, groups, leaderboard, dictionary, propose word, profile, admin). Architecture mirrors sauceboss: `shared/` ESM modules consumed by native via `#shared` Metro alias; Supabase via `expo-secure-store` adapter; Google OAuth via `expo-auth-session` + `web/auth-callback.html` bridge. Apple Sign-In, EAS builds, store assets, and the web→shared bridge are deferred. To run locally: `cd projects/daywordplay/app && npm install && cp .env.example .env` (fill EXPO_PUBLIC_* values) `&& npx expo start` and scan with Expo Go.

## Native Screen Flow

```
Auth (signed out)
└── Email login/signup + Continue with Google

Authed Stack (signed in)
├── Bottom Tabs
│   ├── Dictionary tab — Played / All Words filter, Propose word modal
│   ├── Word tab (default) — today's word, sentence input, reusable pills, submit
│   └── Stats tab — group leaderboard with rank emojis
├── Vote (push) — yesterday's sentences with thumbs-up vote
├── Groups (push) — my groups + discover, swap active group
├── JoinByCode (modal) — 4-letter code entry
├── CreateGroup (modal) — name a new group
├── ProposeWord (modal) — propose a dictionary word
├── Profile (push) — name, email, stats, leave groups, logout, delete account, admin entry
└── Admin (push, gated) — add word, approve/reject proposals, delete groups
```
