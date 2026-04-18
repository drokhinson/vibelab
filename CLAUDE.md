# CLAUDE.md — Vibe Coding Pipeline

This is the master instruction file for Claude Code when working in the `vibelab` monorepo. Read this before touching any project.

---

## What This Repo Is

A monorepo of prototype apps built via a Claude-driven pipeline:

```
Idea → STRUCTURE.md → web/ prototype → shared-backend/ API → native app
```

Each project lives in `projects/[name]/` and has three tiers:
- `web/` — Static HTML/CSS/JS (deployed to Vercel, no build step)
- `shared-backend/routes/[name]/` — Python FastAPI route package (one shared Railway service)
- `app/` — React Native / Expo (distributed via Expo Go / EAS)

---

## Pipeline Stages

### Stage 1 — Ideation
Fill in `projects/[name]/STRUCTURE.md` completely before writing any code.
Ask the user clarifying questions about the idea. The STRUCTURE.md is the source of truth.

### Stage 2 — Scaffold
Run `bash scaffold.sh [name] "[Title]" "[Description]"` from repo root.
This creates `projects/[name]/` from `_templates/` and adds a route stub in `shared-backend/routes/`.
Then fill in STRUCTURE.md and write `db/migrations/NNN_[name]_schema.sql`.

### Stage 3 — Prototype (Web)
Implement `shared-backend/routes/[name].py` (FastAPI) and `projects/[name]/web/` (HTML/JS) together.
The web prototype is always the first deliverable. Deploy: push to branch and create pull request. Once merged to main, Actions auto-deploys.

### Stage 4 — Native App
Use the `build-native` skill. Wire `projects/[name]/app/src/api/client.js` to the shared Railway backend.
The React Native app shares Supabase tables with the web prototype. Do NOT use expo-sqlite.

### Stage 5 — Polish
Use the `ui-polish` skill to refine the web prototype. Add Supabase Auth if needed via `add-supabase-auth`.

---

## Directory Layout

```
vibelab/
├── CLAUDE.md                  ← this file
├── registry.json              ← project index (update when deploying)
├── scaffold.sh                ← new project scaffolding
├── landing/                   ← central landing page (Vercel)
├── shared-backend/            ← ONE FastAPI service for ALL projects
│   ├── main.py                ← registers all routers
│   ├── db.py                  ← Supabase client singleton
│   ├── auth.py                ← shared bcrypt + JWT + admin auth helpers
│   ├── shared_models.py       ← shared Pydantic response models (HealthResponse, etc.)
│   └── routes/[project]/     ← one package per project
├── db/migrations/             ← all Supabase SQL migrations (ONE shared DB)
├── db/schema/                 ← current-state schema snapshots, one file per project
├── _templates/                ← scaffold source, not deployed
├── .github/workflows/         ← CI/CD
├── .claude/commands/          ← Claude slash command skills
├── .claude/rules/             ← domain-specific conventions (loaded by file path)
└── projects/[name]/
    ├── STRUCTURE.md           ← AI context doc — READ FIRST
    ├── .env.example
    ├── web/                   ← static prototype
    └── app/                   ← React Native / Expo
```

---

## Conventions

Domain-specific conventions (backend, frontend, database, native, performance) are in `.claude/rules/` and load automatically when editing relevant files.

### Git
- Commit format: `[project-name] description` or `[infra] description`
- Examples: `[sauceboss] add carbs endpoint`, `[landing] update registry`, `[infra] add deploy workflow`
- One logical change per commit. Do not batch unrelated projects.

### Modular File Structure
Keep individual files under ~300 lines. When a file grows beyond that, split it by domain. This reduces AI token usage — Claude only reads the relevant module instead of a full monolith.

### Admin Dashboard Maintenance
When adding a new app or new tables to the monorepo:
- **Analytics:** Add the analytics tracking ping to the new app's `app.js` (fire-and-forget `fetch` to `/api/v1/analytics/track`).
- **User management:** If the new app has user auth, add an entry to `APPS_WITH_USERS` in `shared-backend/routes/admin.py`.
- **DB storage:** Automatically picked up — tables are grouped by prefix in the storage view.

---

## Common Tasks

### Add a new project
```bash
bash scaffold.sh my-app "My App" "Description"
# Then fill in STRUCTURE.md and implement routes + web/
```

### Run the backend locally (always use venv)
All local backend work must run inside a virtual environment — never install packages globally.
```bash
cd shared-backend
python -m venv .venv                  # create once
source .venv/Scripts/activate         # Windows (Git Bash)
# source .venv/bin/activate           # macOS / Linux
pip install -r requirements.txt       # install deps inside venv
uvicorn main:app --reload             # starts on http://localhost:8000
```
`.venv/` is gitignored. Re-run `pip install -r requirements.txt` after pulling changes that add new deps.

### Update the landing page
Edit `registry.json` — the landing page reads it at load time. Set `status`, `webUrl`, `backendUrl` when deploying.

### Debug a CORS error
Check `ALLOWED_ORIGINS` in Railway environment variables.
Format: `https://project.vercel.app,http://localhost:5500` (comma-separated, no trailing slash).

---

## Environment Variables

All vars are in Railway (backend) and Vercel (frontend) dashboards. Never committed.

| Variable | Where | Purpose |
|---|---|---|
| `SUPABASE_URL` | Railway | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Railway | Server-side DB access (bypasses RLS) |
| `VIBELAB_SUPABASE_URL` | GitHub Secrets | Shared Supabase URL injected into every app's `config.js` at deploy time |
| `VIBELAB_SUPABASE_ANON_KEY` | GitHub Secrets | Shared Supabase anon key for all frontends (one auth system across the monorepo) |
| `ALLOWED_ORIGINS` | Railway | Comma-separated CORS origins |
| `EXPO_PUBLIC_API_URL` | `app/.env` | Railway backend URL for React Native |
| `ADMIN_API_KEY` | Railway | Admin dashboard authentication key |
| `WEALTHMATE_JWT_SECRET` | Railway | WealthMate JWT signing secret |
