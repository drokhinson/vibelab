# Day Word Play — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-03-17

## What This App Does

Day Word Play is a daily vocabulary challenge with friends. Every day, all members of a group get the same randomly selected word. Each user writes a sentence using that word. The next day, everyone votes on their favourite sentence, and the cycle repeats. A leaderboard tracks who has earned the most votes over time. Users can also bookmark words to build their personal "friend dictionary". Groups are created or joined using a searchable list + 4-letter join code.

## Current Status
- Stage: Prototype (Stage 3)
- Web prototype: implemented, not yet deployed
- Backend: implemented, registered in shared Railway service
- Native app: not started

## Tech Stack
| Layer | Technology | Notes |
|---|---|---|
| Web frontend | Vanilla HTML/CSS/JS + Pico.css | Warm beige theme, deployed to Vercel |
| Backend | Python FastAPI (shared service) | Routes at `/api/v1/daywordplay/...` |
| Database | Supabase (shared project) | Tables prefixed `daywordplay_` |
| Auth | Custom JWT + bcrypt | Uses shared `auth.py` helpers |
| Native app | React Native / Expo | Not started |

## Directory Layout
```
projects/daywordplay/
├── web/
│   ├── index.html      — App shell (light/beige theme, modular scripts)
│   ├── styles.css      — Full custom styles (warm beige palette)
│   ├── config.js       — Sets window.APP_CONFIG.apiBase
│   ├── state.js        — Global state variables + analytics ping
│   ├── helpers.js      — apiFetch, icons, renderApp, showView, formatDate
│   ├── auth.js         — Login/register views
│   ├── home.js         — Word of day view + sentence submission
│   ├── vote.js         — Yesterday's sentences + voting
│   ├── leaderboard.js  — Group leaderboard
│   ├── groups.js       — Group search/join/create
│   ├── dictionary.js   — Bookmarked words
│   ├── profile.js      — User profile + logout
│   └── init.js         — DOMContentLoaded boot + tab switching
└── STRUCTURE.md

shared-backend/routes/daywordplay/
├── __init__.py         — Router + imports
├── models.py           — Pydantic request bodies
├── constants.py        — JWT_SECRET
├── dependencies.py     — get_current_user()
├── auth_routes.py      — register, login, me, delete
├── group_routes.py     — list, create, join, leaderboard, leave
└── word_routes.py      — today, yesterday, sentences, votes, bookmarks

db/migrations/
├── 017_daywordplay_schema.sql   — All tables + indexes
└── 018_daywordplay_words_seed.sql — ~90 vocabulary words
```

## Data Model

- **daywordplay_users** — id, username (unique), display_name, email, password_hash, recovery_hash, created_at
- **daywordplay_groups** — id, name, code CHAR(4) UNIQUE, created_by→users, created_at
- **daywordplay_group_members** — id, group_id, user_id, joined_at — UNIQUE(group_id, user_id)
- **daywordplay_words** — id, word, part_of_speech, definition, pronunciation, etymology
- **daywordplay_daily_words** — id, group_id, word_id, assigned_date DATE — UNIQUE(group_id, assigned_date)
- **daywordplay_sentences** — id, group_id, word_id, user_id, sentence, assigned_date, created_at — UNIQUE(group_id, user_id, assigned_date)
- **daywordplay_votes** — id, sentence_id, voter_user_id, created_at — UNIQUE(voter_user_id, sentence_id)
- **daywordplay_bookmarks** — id, user_id, word_id, created_at — UNIQUE(user_id, word_id)

## API Endpoints

All routes at `/api/v1/daywordplay/...`. JWT Bearer token required unless noted.

### Auth
- `GET /health` — Health check. No auth.
- `POST /auth/register` — Register user. Body: `{username, password, display_name?, email?}`
- `POST /auth/login` — Login. Body: `{username, password}`
- `GET /auth/me` — Current user info.
- `DELETE /auth/me` — Delete account.

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
| `SUPABASE_URL` | shared-backend | Supabase project URL (Railway) |
| `SUPABASE_SERVICE_ROLE_KEY` | shared-backend | Server-side DB access (Railway) |
| `DAYWORDPLAY_JWT_SECRET` | shared-backend | JWT signing secret (Railway) |

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
