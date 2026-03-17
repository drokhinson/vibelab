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
│   └── routes/[project]/     ← one package per project (see Modular File Structure)
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
- **Data belongs in the database, not in code.** Any named list, option set, lookup table, or configurable preset (e.g. skill levels, categories, status values, tags) must be stored as rows in a Supabase table with a migration, not as a Python dict/list or JS array in application code. Hard-coded constants require a deploy to change; a DB row does not. The only things that belong in `constants.py` are secrets, algorithm identifiers, and other true compile-time values.

### Backend (FastAPI in `shared-backend/`)
- All routes namespaced: `/api/v1/[project]/[resource]`
- `async def` for all route handlers.
- Register every new router in `shared-backend/main.py` via `from routes import [project]`.
- `db.py` exports `get_supabase()`. Never import `supabase` directly in route files.
- Do not add auth unless STRUCTURE.md says it is required.
- Always include `GET /api/v1/[project]/health` that returns `{"project": "[name]", "status": "ok"}`.
- See **Modular File Structure** below for how to organize route files.

### Python Code Quality

**Type annotations (required on all functions):**
- All route handlers: annotate every parameter and return type.
- All private helpers (`_foo()`): annotate params and return type.
- FastAPI dependencies (`get_current_user`): return a typed Pydantic model, not `dict`.
- Type the Supabase client parameter as `Client` from `supabase`.

**Pydantic models (not dicts):**
- Every request body must use a Pydantic `BaseModel`.
- Every route must declare `response_model=` in its decorator with a Pydantic model.
- Common response shapes (health, auth token, message confirmations) get shared models in the project's `models.py`.
- Name response models with a `Response` suffix: `HealthResponse`, `TokenResponse`, `MessageResponse`.

**Enums instead of string literals:**
- Any fixed set of string values (account types, statuses, seasons, frequencies) must be a `class MyEnum(str, Enum)` in the project's `constants.py`.
- Use these enums in Pydantic model fields — this provides automatic validation and Swagger dropdowns.
- Database string values map 1:1 to enum member values.

**Swagger / OpenAPI readability:**
- Every route decorator must include: `response_model`, `status_code`, `summary`.
- Every route handler must have a one-line docstring (shows as description in Swagger).
- Path params use `Path(..., description="...")`. Query params use `Query(..., description="...")`.
- `main.py` defines `openapi_tags` metadata for all project routers.

**No duplicate utilities:**
- Admin auth checking: use `require_admin()` from `auth.py`, not per-file private helpers.
- Password/JWT helpers: import from `auth.py`, not local wrappers in `dependencies.py`.

### Shared Auth (`shared-backend/auth.py`)
- Generic bcrypt + JWT helpers: `hash_password`, `verify_password`, `create_token`, `decode_token`, `extract_bearer_token`.
- When a new app needs login/user management, import from `auth.py` instead of reimplementing.
- Each app keeps its own `{app}_users` table following the same schema pattern as `wealthmate_users`.

### Admin Dashboard Maintenance
When adding a new app or new tables to the monorepo:
- **Analytics:** Add the analytics tracking ping to the new app's `app.js` (fire-and-forget `fetch` to `/api/v1/analytics/track`).
- **User management:** If the new app has user auth, add an entry to `APPS_WITH_USERS` in `shared-backend/routes/admin.py`.
- **DB storage:** Automatically picked up — tables are grouped by prefix in the storage view.

### Web Prototypes (`projects/[name]/web/`)
- No npm, no bundler. Vanilla HTML + vanilla JS. No build step.
- **Standard CDN stack** for new projects:
  - **DaisyUI v4** (Tailwind component library — cards, badges, bottom-nav, toasts, 30+ themes, no build step)
  - **Lucide Icons** (crisp SVG icon set, replaces emoji for UI chrome)
  - **Google Fonts: Inter** (body) + optional display font per project
- Existing projects on Pico.css are migrated to DaisyUI incrementally via `/ui-polish`.
- `config.js` sets `window.APP_CONFIG = { apiBase: "..." }`. Default: `http://localhost:8000`.
- Use `fetch()` for all data. Never inline data in JS globals.
- Mobile-first responsive. Max width 480px for single-column apps, 900px for dashboards.
- Loading states and error handling are required on every `fetch()`.
- **Icons:** Use Lucide SVG icons for all UI chrome (nav, buttons, back arrows, action icons). Keep emojis for content/data (food, plants, animals — things that *are* the data).
- **Illustrations:** Every empty state, loading screen, and app header should include an SVG illustration. Source from [undraw.co](https://undraw.co) (free, MIT). Download the SVG, inline it in the relevant JS render function, and customize the primary fill color to match the project accent.
- **Motion:** All card lists get entrance animations (`fadeUp` keyframe). Cards get hover lift (`translateY(-2px)` + shadow increase). Stagger list items with `animation-delay: calc(var(--i) * 40ms)`.
- **Design reference:** Use [v0.app](https://v0.app) to generate visual mockups for complex screens. Do not copy its React code — extract the layout, spacing, and component structure decisions and implement them in DaisyUI + vanilla JS.
- See **Modular File Structure** below for how to organize JS files.

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

### Modular File Structure

Keep individual files under ~300 lines. When a file grows beyond that, split it by domain. This reduces AI token usage — Claude only reads the relevant module instead of a full monolith.

**Frontend (vanilla JS):** No ES modules — use `<script>` tags sharing global scope. Load order matters: state → helpers → feature modules → init.

| File | Purpose |
|------|---------|
| `config.js` | API base URL |
| `state.js` | All global `let` variables (shared state) |
| `helpers.js` | Formatting, auth tokens, `apiFetch()`, `showView()`, navigation |
| `[feature].js` | One file per view/feature (e.g. `dashboard.js`, `accounts.js`, `checkin.js`) |
| `init.js` | `DOMContentLoaded` handler: all event listeners, startup logic. Loaded last. |

Add `<script>` tags to `index.html` in the order above. All functions remain global.

**Backend (FastAPI):** Convert `routes/[project].py` into a `routes/[project]/` package. `main.py` still does `from routes import [project]` — Python resolves through `__init__.py`.

| File | Purpose |
|------|---------|
| `__init__.py` | Creates `router = APIRouter(prefix=...)`, imports all sub-modules |
| `models.py` | Pydantic request/response models |
| `constants.py` | Lookup tables, config values, enums |
| `dependencies.py` | `get_current_user()`, auth helpers, shared FastAPI dependencies |
| `[domain]_routes.py` | One file per route group (e.g. `auth_routes.py`, `account_routes.py`) |

Each sub-module imports `router` from `__init__.py` via `from . import router` and decorates routes onto it.

**When to split:** Start with a single file during initial prototyping. Split once any file exceeds ~300 lines or has 3+ distinct feature areas. Small apps (under 300 lines total) can stay as a single file.

---

## Common Tasks

### Add a new project
```bash
bash scaffold.sh my-app "My App" "Description"
# Then fill in STRUCTURE.md and implement routes + web/
```

### Add an API endpoint to an existing project
1. Edit the relevant file in `shared-backend/routes/[project]/` (e.g. `account_routes.py`)
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
| `ADMIN_API_KEY` | Railway | Admin dashboard authentication key |
| `WEALTHMATE_JWT_SECRET` | Railway | WealthMate JWT signing secret |

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
