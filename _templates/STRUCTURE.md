# {{PROJECT_TITLE}} — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: {{TODAY}}

## What This App Does
<!-- One paragraph. Plain English. What problem it solves, who uses it, what makes it interesting. -->

## Current Status
- Stage: Ideation
- Web prototype: not deployed
- Backend: not deployed
- Native app: not started

## Tech Stack
| Layer | Technology | Notes |
|---|---|---|
| Web frontend | Vanilla HTML/CSS/JS + Pico.css | No build step, deployed to Vercel |
| Backend | Python FastAPI (shared service) | Routes at `/api/v1/{{PROJECT_ID}}/...` |
| Database | Supabase (shared project) | Tables prefixed `{{PROJECT_ID}}_` |
| Native app | React Native / Expo | Not started |
| Auth | Supabase Auth | Not used |
| Storage | Supabase Storage | Not used |

## Directory Layout
```
projects/{{PROJECT_ID}}/
├── web/              — Static HTML prototype
│   ├── index.html    — App shell
│   ├── styles.css    — App-specific overrides (base: _templates/web/styles.css)
│   ├── config.js     — Sets window.APP_CONFIG.apiBase
│   └── app.js        — All JS logic
├── app/              — React Native / Expo (add when prototype is live)
│   └── src/
│       ├── api/client.js     — fetch wrappers to shared backend
│       ├── screens/          — one file per screen
│       └── components/
└── STRUCTURE.md      — this file

shared-backend/routes/{{PROJECT_ID}}.py  — FastAPI routes for this project
db/migrations/{{PROJECT_ID}}/001_baseline.sql + optional 002_seed.sql — Supabase migrations
```

## Data Model
<!-- Describe each Supabase table. All tables prefixed with {{PROJECT_ID}}_ -->

Example:
- **{{PROJECT_ID}}_items** — Main data entity. Columns: id (uuid PK), name (text), created_at (timestamptz).

## API Endpoints
<!-- List all FastAPI routes. Backend registers them at /api/v1/{{PROJECT_ID}}/... -->

- `GET /api/v1/{{PROJECT_ID}}/health` — Health check. No auth.

## Screen / Page Flow
<!-- Describe navigation in plain English or ASCII diagram -->

```
Landing (index.html) → ...
```

## Key Business Logic
<!-- Bullet points describing non-obvious logic Claude needs to know -->

## Environment Variables
| Variable | Used In | Purpose |
|---|---|---|
| `SUPABASE_URL` | shared-backend | Supabase project URL (set in Railway) |
| `SUPABASE_SERVICE_ROLE_KEY` | shared-backend | Server-side DB access (set in Railway) |
| `SUPABASE_ANON_KEY` | web | Client-side access if needed (set in Vercel) |
| `EXPO_PUBLIC_API_URL` | app | Railway backend URL |

## Development Setup
```bash
# Backend (from vibelab root)
cd shared-backend
source .venv/Scripts/activate   # Windows; use .venv/bin/activate on Mac/Linux
uvicorn main:app --reload --port 8000

# Web prototype
# Open projects/{{PROJECT_ID}}/web/index.html in browser
# Or: npx serve projects/{{PROJECT_ID}}/web

# React Native app (once started)
cd projects/{{PROJECT_ID}}/app
npx expo start
```

## Active Development Notes
<!-- Current TODOs, known issues, what was last worked on -->

- {{TODAY}} — Project scaffolded. Fill in this STRUCTURE.md before writing any code.
