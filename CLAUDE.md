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
- `shared-backend/routes/[name].py` — Python FastAPI routes (one shared Railway service)
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
The web prototype is always the first deliverable. Deploy: push to main, Actions auto-deploys.

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
│   └── routes/[project].py   ← one file per project
├── db/migrations/             ← all Supabase SQL migrations (ONE shared DB)
├── _templates/                ← scaffold source, not deployed
├── .github/workflows/         ← CI/CD
├── .claude/commands/          ← Claude slash command skills
└── projects/[name]/
    ├── STRUCTURE.md           ← AI context doc — READ FIRST
    ├── .env.example
    ├── web/                   ← static prototype
    └── app/                   ← React Native / Expo
```

---

## Conventions

### Database (Supabase)
- ONE shared Supabase project for all apps. Tables are app-prefixed: `sauceboss_carbs`, `spotme_locations`.
- All migrations go in `db/migrations/` as numbered SQL: `001_sauceboss_schema.sql`, `002_sauceboss_seed.sql`.
- Run migrations in Supabase dashboard → SQL Editor → New Query → Run.
- Use RPCs (`supabase.rpc()`) for complex multi-table reads.
- Backend uses `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS). Never expose it to the frontend.

### Backend (FastAPI in `shared-backend/`)
- All routes namespaced: `/api/v1/[project]/[resource]`
- `async def` for all route handlers.
- One router file per project in `shared-backend/routes/[project].py`.
- Register every new router in `shared-backend/main.py`.
- `db.py` exports `get_supabase()`. Never import `supabase` directly in route files.
- Do not add auth unless STRUCTURE.md says it is required.
- Always include `GET /api/v1/[project]/health` that returns `{"project": "[name]", "status": "ok"}`.

### Web Prototypes (`projects/[name]/web/`)
- No npm, no bundler. Vanilla HTML + Pico.css (via CDN) + vanilla JS.
- `config.js` sets `window.APP_CONFIG = { apiBase: "..." }`. Default: `http://localhost:8000`.
- Use `fetch()` for all data. Never inline data in JS globals.
- Mobile-first responsive. Max width 480px for single-column apps, 900px for dashboards.
- Loading states and error handling are required on every `fetch()`.

### React Native / Expo (`projects/[name]/app/`)
- Expo managed workflow (bare only when a native module requires it).
- All API calls go through `src/api/client.js`. Never call `fetch()` directly in a screen.
- Navigation: `@react-navigation/native-stack`.
- Theme tokens go in `src/theme.js`.
- Do NOT use `expo-sqlite`. Use the shared API client.
- Set `EXPO_PUBLIC_API_URL` in `app/.env` for the Railway backend URL.

### Git
- Commit format: `[project-name] description` or `[infra] description`
- Examples: `[sauceboss] add carbs endpoint`, `[landing] update registry`, `[infra] add deploy workflow`
- One logical change per commit. Do not batch unrelated projects.

---

## Common Tasks

### Add a new project
```bash
bash scaffold.sh my-app "My App" "Description"
# Then fill in STRUCTURE.md and implement routes + web/
```

### Add an API endpoint to an existing project
1. Edit `shared-backend/routes/[project].py`
2. Update STRUCTURE.md → API Endpoints section
3. Test: `uvicorn main:app --reload` in `shared-backend/`
4. Push — Railway auto-deploys

### Add a React Native screen
1. Create `projects/[name]/app/src/screens/[ScreenName].js`
2. Register in the navigator in `App.js`
3. Add any new API calls to `src/api/client.js`
4. Update STRUCTURE.md → Screen Flow section

### Run a Supabase migration
1. Write SQL in `db/migrations/[NNN]_[project]_[description].sql`
2. Paste into Supabase dashboard → SQL Editor → Run
3. Commit the file

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
| `SUPABASE_ANON_KEY` | Vercel (per project) | Client-side access for web (respects RLS) |
| `ALLOWED_ORIGINS` | Railway | Comma-separated CORS origins |
| `EXPO_PUBLIC_API_URL` | `app/.env` | Railway backend URL for React Native |

---

## Available Skills

| Skill | Command | When to use |
|---|---|---|
| New project | `/new-project` | Turn an idea into a scaffold + STRUCTURE.md |
| Build prototype | `/build-prototype` | Implement web/ + backend routes from STRUCTURE.md |
| UI polish | `/ui-polish` | Improve visual design of a working prototype |
| Build native | `/build-native` | Create Expo app wired to backend |
| Deploy check | `/deploy-check` | Verify all deployments are live and correct |
| Retrofit | `/retrofit` | Migrate an existing project into this structure |
| Add auth | `/add-supabase-auth` | Add Supabase Auth + RLS to a project |
