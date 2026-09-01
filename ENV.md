# Environment Variables

Single source of truth for every env var the system uses, grouped by where the value is **stored**. The **Source** column tells you the upstream system that produced the value — that's where you go to read or rotate it. If the same logical value is copied to multiple stores, see §6.

If you add or rename an env var anywhere, update the table here in the same commit. Keep `CLAUDE.md` pointing here rather than duplicating the list.

---

## 1. Railway — `shared-backend` service

Set in Railway dashboard → backend service → Variables.

| Variable | Source | Purpose | Used by |
|---|---|---|---|
| `SUPABASE_URL` | Supabase dashboard → Project Settings → API | Supabase project URL | `shared-backend/db.py`, `shared-backend/jwt_auth.py` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Project Settings → API | Server-side DB key (bypasses RLS) | `shared-backend/db.py` |
| `ALLOWED_ORIGINS` | Hand-maintained (operator) | Comma-separated CORS allowlist, no trailing slash | `shared-backend/main.py` |
| `ADMIN_API_KEY` | Hand-generated (operator) | Bearer token for admin endpoints | `shared-backend/auth.py` |
| `SPOTME_JWT_SECRET` | Hand-generated (operator) | Signs SpotMe JWTs | `shared-backend/routes/spotme/constants.py` |
| `WEALTHMATE_JWT_SECRET` | Hand-generated (operator) | Signs WealthMate JWTs | `shared-backend/routes/wealthmate/constants.py` |
| `BGB_QR_SECRET` | `python -c "import secrets; print(secrets.token_urlsafe(32))"` — must be ≥32 bytes, or PyJWT warns it is under the HMAC-SHA256 minimum | Signs BoardgameBuddy's short-lived add-a-buddy QR tokens. **Set this in Railway before deploying** — the `dev-secret-change-me` fallback is public, and anyone who knows it could mint a token that adds them to any account's buddy list. Rotating it is also the revocation lever: it invalidates every outstanding code at once, which is why the tokens carry no server-side state. Missing key → codes still mint and redeem, but on a guessable secret. | `shared-backend/routes/boardgame_buddy/constants.py`, read by `services/buddy_qr_service.py` |
| `BGG_API_TOKEN` | BoardGameGeek app registration (boardgamegeek.com/applications) | API rate-limit headroom | `shared-backend/routes/boardgame_buddy/bgg_client.py` |
| `BGG_CREDENTIAL_KEY` | `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` | Fernet key for encrypting linked users' BGG passwords | `shared-backend/routes/boardgame_buddy/bgg_credentials.py` |
| `BGG_PUSH_DRY_RUN` | Set by hand (`true`/`1`) | Logs the BgB→BGG collection-write payload and sends nothing. BGG has no write API, so the form fields are reverse-engineered — leave this ON until the payload has been confirmed against a throwaway BGG account. Unset/false = pushes go through. | `shared-backend/routes/boardgame_buddy/bgg_write.py` |
| `BGG_PUSH_THROTTLE_SECONDS` | Set by hand (default `2.0`) | Seconds between BGG collection writes. Above the read path's 1.5s because BGG's *write* rate limits are undocumented; tunable without a redeploy — watch the `api_name='bgg-write'` rows in `api_logs` for latency and 429s before changing it. | `shared-backend/routes/boardgame_buddy/bgg_push_routes.py` |
| `PERENUAL_API_KEY` | Perenual dashboard (perenual.com/user/developer) | Sole upstream source for `plantplanner_plant_cache`. Both wizard fill (`/catalog/fill/perenual`) and lazy fill (`/catalog/search` on miss) call species-list with the wizard filters, then fan out species-details lookups so the cache row carries hardiness, dimensions, description, care_level, soil[], growing_months[], etc. | `shared-backend/routes/plant_planner/api_clients.py` |
| `GEMINI_API_KEY` | Google AI Studio (aistudio.google.com → API Keys) | Shared Gemini key (free tier). **Travel Trove** place extraction — identifies the place a saved URL is about (~500 in / ~150 out tokens per scrap); missing key → scraps fail with `error_kind='llm'` and a retry affordance. **BoardgameBuddy** chapter drafting — the chapter editor's "Generate with AI" button drafts a reference-guide chapter (~1k in / ~600 out tokens per press); missing key → the button 502s with a toast. **BoardgameBuddy** play import — Settings → Import plays reads a pasted note (a tally list, a Notes table) into draft plays for the wizard to review (~5k in / up to 8k out tokens per parse, once per import); missing key → the parse step 502s and the wizard cannot advance. Nothing else breaks in either app. | `shared-backend/gemini.py` (shared caller), `shared-backend/routes/travel_scrapbook/services/llm.py`, `shared-backend/routes/boardgame_buddy/services/chapter_ai.py`, `shared-backend/routes/boardgame_buddy/services/play_import_ai.py` |

Anything else in Railway is stale — `grep -r VAR_NAME shared-backend/` to confirm zero references before deleting.

---

## 2. GitHub Actions Secrets

Set in Repo → Settings → Secrets and variables → Actions.

| Secret | Source | Purpose | Used by |
|---|---|---|---|
| `VIBELAB_SUPABASE_URL` | Supabase dashboard | Injected into web `config.js` at deploy; keep-alive ping target | `deploy-frontend.yml`, `deploy-frontend-all.yml`, `supabase-keepalive.yml` |
| `VIBELAB_SUPABASE_ANON_KEY` | Supabase dashboard | Injected into web `config.js` at deploy; keep-alive ping auth | `deploy-frontend.yml`, `deploy-frontend-all.yml`, `supabase-keepalive.yml` |
| `VERCEL_TOKEN` | Vercel → Account Settings → Tokens | CLI auth for `vercel pull` / `vercel deploy` | all `deploy-*.yml` |
| `VERCEL_ORG_ID` | Vercel → Settings → General | Target Vercel org for the CLI | all `deploy-*.yml` |
| `VERCEL_LANDING_PROJECT_ID` | Vercel → landing project → Settings | Target Vercel project for landing | `deploy-landing.yml` |
| `VERCEL_<PROJECT>_PROJECT_ID` | Vercel → that project → Settings | One per per-project deploy. Project keys are upper-case, dashes → underscores: `VERCEL_DAYWORDPLAY_PROJECT_ID`, `VERCEL_SAUCEBOSS_PROJECT_ID`, `VERCEL_PLANT_PLANNER_PROJECT_ID`, `VERCEL_BOARDGAME_BUDDY_PROJECT_ID`, `VERCEL_SPOTME_PROJECT_ID`, `VERCEL_WEALTHMATE_PROJECT_ID`, `VERCEL_ADMIN_PROJECT_ID` | `deploy-frontend.yml`, `deploy-frontend-all.yml` |

`RAILWAY_TOKEN` is referenced (commented out) in `deploy-backend.yml`. Backend deploys currently use Railway's native GitHub auto-deploy, so this secret is not required.

---

## 3. Vercel — Project Settings → Environment Variables

**No runtime env vars are configured per project.** All web config flows in via `build.sh` regenerating `config.js` from GitHub Secrets at deploy time. The Vercel-side env-var UI should be empty.

The only Vercel-side state that matters per project:
- **Root Directory** (Settings → General). Must be **blank** (or `./`). The deploy workflows already `cd` into the project dir via `working-directory`, so a non-empty Root Directory doubles the path (e.g. `landing/landing` → `path does not exist`).
- **Git connection** (Settings → Git). Should be **disconnected** for any project that has a `deploy-*.yml` workflow — otherwise Vercel auto-deploys from `main` race the GH-Actions CLI deploys.

---

## 4. Supabase — Project Settings → API

No env vars are stored *in* Supabase itself. This dashboard is the **source** of three values that flow to other stores:

| Value | Source | Stored in |
|---|---|---|
| Project URL | Supabase → Settings → API | Railway `SUPABASE_URL`; GH Secret `VIBELAB_SUPABASE_URL` |
| `service_role` key | Supabase → Settings → API | Railway `SUPABASE_SERVICE_ROLE_KEY` only (never frontend) |
| `anon` key | Supabase → Settings → API | GH Secret `VIBELAB_SUPABASE_ANON_KEY` |

Per-app project roles (`{prefix}_role`) are defined in `db/migrations/_shared/003_project_roles.sql`, not via env vars.

---

## 5. Local `.env` files

### 5a. `local_dev/.env` → `shared-backend/.env` (both gitignored)

The single source file for local credentials. `local_dev/setup-local.py` copies it to `shared-backend/.env` (so `uvicorn`'s `load_dotenv()` picks it up) and fans values out to each project. Template: `local_dev/.env.example`. Mirrors §1 — same vars, same sources. Defaults baked into the code (`dev-admin-key`, `dev-secret-change-me`, etc.) let you run with an empty file, but production-equivalent secrets must never be committed here.

### 5b. `projects/<name>/app/.env` (gitignored; generated by `local_dev/setup-local.py`)

Loaded by Expo at build time. Anything prefixed `EXPO_PUBLIC_` is bundled into the client. Run `python local_dev/setup-local.py` to generate for all projects at once (reads `local_dev/.env`).

| Variable | Source | Purpose | Apps |
|---|---|---|
|---|
| `EXPO_PUBLIC_API_URL` | Railway dashboard (URL of `shared-backend`) | Backend URL for the native client (`process.env.EXPO_PUBLIC_API_URL`) | every native app |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase dashboard | Direct Supabase access from native | all apps with auth |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase dashboard | Direct Supabase access from native | all apps with auth |
| `EXPO_PUBLIC_AUTH_CALLBACK_URL` | Hand-set per environment | Web bridge URL for OAuth redirect | daywordplay |

### 5c. `projects/<name>/web/config.js` (gitignored; generated at build and locally)

`build.sh` writes this file at deploy time using GitHub Secrets. For local dev, `local_dev/setup-local.py` generates it with localhost values.

| Key | Source | Purpose |
|---|---|---|
| `window.APP_CONFIG.apiBase` | `deploy-frontend.yml` env `API_BASE` (currently hardcoded to `https://vibelab-production-2119.up.railway.app`) | Backend URL for the web app |
| `window.APP_CONFIG.supabaseUrl` | GH Secret `VIBELAB_SUPABASE_URL` | Optional direct Supabase access from web |
| `window.APP_CONFIG.supabaseAnonKey` | GH Secret `VIBELAB_SUPABASE_ANON_KEY` | Optional direct Supabase access from web |
| `window.APP_CONFIG.project` | Hardcoded per-project in `build.sh` | Project ID label |

---

## 6. Cross-reference — where the same logical value lives

| Logical value | Origin | Copied to |
|---|---|---|
| Supabase project URL | Supabase dashboard | Railway `SUPABASE_URL` · GH `VIBELAB_SUPABASE_URL` · web `config.js` (`supabaseUrl`) · native `EXPO_PUBLIC_SUPABASE_URL` |
| Supabase `anon` key | Supabase dashboard | GH `VIBELAB_SUPABASE_ANON_KEY` · web `config.js` (`supabaseAnonKey`) · native `EXPO_PUBLIC_SUPABASE_ANON_KEY` |
| Supabase `service_role` key | Supabase dashboard | Railway `SUPABASE_SERVICE_ROLE_KEY` only — never frontend |
| Railway backend URL | Railway dashboard | `deploy-frontend*.yml` `API_BASE` default · web `config.js` (`apiBase`) · native `EXPO_PUBLIC_API_URL` |

When rotating the Supabase URL or anon key, update Supabase first, then propagate to every store listed in the row above. The `service_role` key only needs Railway.