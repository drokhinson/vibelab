# Local Dev Setup

Everything you need to run any vibelab app locally. Do this once, then all projects work.

---

## Quick Start

```bash
# 1. Fill in the one shared env file
cp local_dev/.env.example local_dev/.env
#    → edit local_dev/.env: fill SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

# 2. Fan out credentials to every project (web + native)
python local_dev/setup-local.py
#    → copies local_dev/.env → shared-backend/.env  (so uvicorn can load it)
#    → writes projects/*/web/config.js               (for web)
#    → writes projects/*/app/.env                     (for native, where an app/ dir exists)

# 3. Start the backend
cd shared-backend
python -m venv .venv
# Activate the venv (pick one for your shell):
  .venv\Scripts\Activate.ps1      # PowerShell
  source .venv/bin/activate       # macOS / Linux
  .venv\Scripts\activate.bat      # Windows CMD
pip install -r requirements.txt
uvicorn main:app --reload       # → http://localhost:8000
#    Swagger UI: http://localhost:8000/docs

# 4a. switch to project web app folder:
cd projects/<name>/web

# 4b. If the project has a shared/ folder (e.g. sauceboss), copy it into web/ first:
    cd .. ; Copy-Item -Recurse -Force shared web\shared ; cd web   # PowerShell
    cd .. && cp -R shared web/shared && cd web                     # macOS / Linux

# 5. Serve a web project (opens browser automatically)

start http://localhost:5500; python -m http.server 5500 --bind 0.0.0.0
```

---

## How the Credential Fan-Out Works

`local_dev/setup-local.py` reads `local_dev/.env` and writes three kinds of files:

| Output file | Contents |
|---|---|
| `shared-backend/.env` | Copy of `local_dev/.env` (so `uvicorn`'s `load_dotenv()` picks it up) |
| `projects/*/web/config.js` | `window.APP_CONFIG = { apiBase, project, supabaseUrl, supabaseAnonKey }` |
| `projects/*/app/.env` | `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` |

Both output types are gitignored. In CI, `build.sh` (present in every project's `web/` directory) regenerates `config.js` with production values before Vercel deploys.

---

## App-Specific Notes

| App | Notes |
|---|---|
| `boardgame-buddy` | BGG API token is a **backend** Railway var — no extra web config needed |
| `plant-planner` | Perenual API key is a **backend** Railway var — no extra web config needed |
| `sauceboss` | Full auth (hearts, settings) requires Supabase fields; without them the app is read-only |
| `daywordplay` | Supabase required for word-save and streak features; native also needs `EXPO_PUBLIC_AUTH_CALLBACK_URL` (see below) |
| `admin` | Uses `ADMIN_API_KEY` passed as a header in the browser — no separate web var |
| `spotme` | No Supabase client-side access; only `apiBase` matters |
| `wealthmate` | No Supabase client-side access; only `apiBase` matters |

### daywordplay native: OAuth callback

`setup-local.py` writes the production Vercel URL for `EXPO_PUBLIC_AUTH_CALLBACK_URL` by default. To use a local tunnel instead, edit `projects/daywordplay/app/.env` after running the script:

```
EXPO_PUBLIC_AUTH_CALLBACK_URL=https://<your-tunnel>.ngrok.io/auth-callback.html
```

---

## Running a Native App (Expo)

```bash
cd projects/<name>/app
npx expo start
```

Use your LAN IP (not `localhost`) for `EXPO_PUBLIC_API_URL` when testing on a physical device — `setup-local.py` sets `http://localhost:8000` which only works in the iOS/Android simulator.

---

## Common Issues

**CORS error in the browser**
Check that `ALLOWED_ORIGINS` in `local_dev/.env` includes `http://localhost:5500` (or whichever port you're using). Re-run `python local_dev/setup-local.py` to propagate.

**`window.APP_CONFIG.supabaseUrl` is empty**
`config.js` is missing or `SUPABASE_ANON_KEY` was blank in `local_dev/.env` when you ran `setup-local.py`. Re-fill the value and re-run the script.

**App loads but API calls fail**
Confirm the backend is running (`http://localhost:8000/docs` should be reachable) and that `config.js` has `apiBase: "http://localhost:8000"`.

**Adding a new project**
`setup-local.py` automatically picks up any new directory matching `projects/*/web/` and `projects/*/app/`, so no script changes are needed after scaffolding.
