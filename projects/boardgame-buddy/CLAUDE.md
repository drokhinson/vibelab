# CLAUDE.md — BoardgameBuddy

BoardgameBuddy is **isolated** inside this monorepo: everything it needs lives
under `projects/boardgame-buddy/`, it shares no code with the other apps, and it
deploys on its own workflows to its own hosts. The repo-root `CLAUDE.md` still
loads and its Git and file-size conventions still apply — but its pipeline
stages, `shared-backend/` layout and `scaffold.sh` flow **do not describe this
project**. When the two disagree, this file wins.

Read `STRUCTURE.md` before touching any feature code,
`Docs/MIGRATION_PLAN.md` before touching any infrastructure
(`Docs/RUNBOOK_R2_CUTOVER.md` and `Docs/RUNBOOK_AUTH_ROLE_CLAIM.md` are the
live ones), and
`Docs/BRAND_VOICE.md` before writing any user-facing copy — it carries the
tagline, the eight places it has to stay in sync, and the tone rules that came
out of choosing it.

## Layout

```
projects/boardgame-buddy/
├── api/                    FastAPI service — its OWN app, its own Railway service
│   ├── main.py             one app, one router (NOT shared-backend/main.py)
│   ├── routes/             the project package; routes/services/ under it
│   ├── analytics_routes.py own copy — web/domain/api.js pings /analytics/track
│   ├── db.py jwt_auth.py cache.py api_logger.py gemini.py auth.py shared_models.py
│   ├── object_store.py     Cloudflare R2 uploads (see below)
│   └── tests/
├── db/migrations/          001–036, plus _shared/ (analytics + api_logs)
├── scripts/bgb-bundle.mjs  deploy-time bundler
├── tools/                  one-off generators + operator scripts, never deploy steps
├── web/                    the static PWA
├── moved/                  the retired Vercel origin's notice (see below)
└── Docs/
```

`api/routes/` **is** the package that used to be `routes/boardgame_buddy/`. That
naming is deliberate: every `from ..constants import` / `from ..models import`
in `routes/services/` resolves against the package root, so the rename cost zero
import changes. **Do not flatten `routes/` into `api/`** — it would break all
forty of them for nothing.

## Deploys

| Tier | Host | Workflow |
|---|---|---|
| `web/` | Cloudflare Pages (`bgbuddy`) | `.github/workflows/deploy-bgb-web.yml` |
| `api/` | Railway, Root Directory `projects/boardgame-buddy/api` | `.github/workflows/deploy-bgb-api.yml` |
| `moved/` | the retired Vercel project — a static notice, dispatch-only | `.github/workflows/deploy-bgb-moved-notice.yml` |

Workflows live at the repo root because GitHub only reads them from there.
`deploy-frontend.yml` filters this project out of its change detection — if that
filter is ever removed, a commit here also deploys the app to Vercel without the
build steps it cannot ship without.

`vars.BGB_API_BASE` (a repo *variable*, not a secret) is the API origin baked
into `web/config.js` at deploy. Re-point the backend there, not in the workflow.

## The things that look wrong and are not

1. **`web/index.html` keeps the DaisyUI + Tailwind CDN pair.** The runtime JIT
   must run before first paint in local dev. The precompiled stylesheet is a
   deploy-artifact-only swap. Never commit the swapped shell.
2. **`web/` keeps ~121 `<script src>` tags.** That is the authoring model
   (`.claude/rules/web-frontend.md`); `scripts/bgb-bundle.mjs` folds them into
   one hashed file at deploy. Do not introduce a bundler into the tree.
3. **`web/sw.js` keeps `__BGB_BUILD_ID__` literal.** The unreplaced placeholder
   is how `sw.js` knows it is in local dev and disables itself.
4. **Deploy step order is fixed: Tailwind swap → bundle → stamp `sw.js`.**
   `sw.js` derives its precache list from `src=`/`href=` in the final shell.
5. **The bundler enforces a 450 KB gzip ceiling.** Raise it only via
   `BGB_JS_GZIP_BUDGET` as a workflow-level `env:`, in a commit that says why.
6. **`api/main.py`'s middleware order is load-bearing.** `add_middleware`
   prepends, and the `postgrest` `APIError` handler exists so a 500 still
   carries CORS headers — without it the browser reports an opaque
   "Failed to fetch" on every page.
7. **The app must be served from an origin ROOT.** `index.html` has
   `<base href="/">`, `manifest.json` declares `start_url`/`scope` of `/`, and
   `sw.js` resolves root-relative paths. Never a subpath.
8. **One uvicorn worker.** `cache.py` is per-worker, so more workers means more
   cache misses and a staler 60-second profile cache, not more speed.
9. **`web/assets/illustrations/bgb-hero.svg` is referenced by nothing in the
   app.** It was the pre-launch landing view's hero, and that view is gone. It
   stays because `.claude/rules/assets.md` makes this copy the source of truth
   for the vibelab landing page's featured card, which bundles its own copy at
   `landing/assets/illustrations/`. Deleting it as dead code orphans that.
10. **`moved/index.html` duplicates the logo as inline SVG** rather than linking
   `assets/brand/bgb-logo.svg`. Required, not lazy: the service worker still
   registered on that origin serves same-origin subresources cache-first with
   revalidation off, so any file the notice referenced could come back as the
   old app's bytes. Its deploy workflow fails on any external reference.
11. **Both image uploads still carry a Supabase Storage branch**, and
   `object_store.py` treats an unconfigured R2 as normal rather than as an
   error. That is the Stage 4 rollout: the R2 code deploys before the buckets
   exist, and unsetting one variable rolls it back after they do. What is NOT
   allowed is widening that fallback to cover a *failing* R2 — see the
   docstrings and `tests/test_object_store.py`, which pin it. A failing R2
   writes a supabase.co URL into a row the migration has already rewritten.

## Secrets that must never be rotated casually

`BGB_VAPID_PUBLIC_KEY` + `BGB_VAPID_PRIVATE_KEY` are one keypair — rotating
them silently stops delivery to every existing subscription and requires
`TRUNCATE boardgamebuddy_push_subscriptions`. `BGB_QR_SECRET` *is* the
revocation lever for add-a-buddy codes, which carry no server-side state.
`BGG_CREDENTIAL_KEY` is the Fernet key for linked users' stored BGG passwords.
See `ENV.md`.
