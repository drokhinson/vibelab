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
│   ├── object_store.py     Cloudflare R2 uploads and deletes (see below)
│   ├── identity_admin.py   deletes the Identity Platform credential (see below)
│   └── tests/
├── db/migrations/          001–049, plus _shared/ (analytics + api_logs)
├── scripts/bgb-bundle.mjs  deploy-time bundler
├── tools/                  generators, operator scripts, and web/'s only tests —
│                           `node tools/check-*.mjs`; never deploy steps
├── functions/              ONE Identity Platform blocking function (see below)
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
| `functions/` | GCP Identity Platform blocking function | **manual** — `firebase deploy --only functions` from `projects/boardgame-buddy` |

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
11. **`functions/` looks unused and is load-bearing.** Nothing in the repo
   imports it and no test covers it — it runs inside Google's auth flow. It
   puts two claims on every ID token: `role: "authenticated"`, without which
   the `TO authenticated` RLS policies on the live-session tables are not
   evaluated at all, and `app_uid`, **the UUID this codebase knows the user
   by**. A Firebase uid is not a UUID and 35 columns here are, so without that
   claim a new account 500s on every endpoint (`037_app_uid_claim.sql`).
   Delete this directory and every account created afterwards loses live
   scoring, both Realtime channels, and — once the transitional `sub`
   fallback goes — the ability to load anything at all. Silently, because the
   API is service-role and bypasses RLS, so only the browser-direct paths
   notice. `Docs/RUNBOOK_AUTH_ROLE_CLAIM.md` is the whole story.
12. **Both image uploads still carry a Supabase Storage branch**, and
   `object_store.py` treats an unconfigured R2 as normal rather than as an
   error. **R2 is live now**, so that branch is the rollback: unsetting the
   variables returns uploads to Supabase, whose buckets are still there. What
   is NOT allowed is widening the fallback to cover a *failing* R2 — see the
   docstrings and `tests/test_object_store.py`, which pin it. A failing R2
   writes a supabase.co URL into a row the migration has already rewritten.
13. **`R2_JURISDICTION` is not optional here even though the code treats it as
   optional.** The buckets were created in the US jurisdiction, which puts a
   label in the S3 endpoint host. Unset, every upload gets `AccessDenied` —
   indistinguishable from a mis-scoped token, which is why the put error names
   the jurisdiction it signed for.
14. **`jwt_auth.py` verifies one issuer and there is no rollback to Supabase
   Auth.** Both sides were removed once accounts existed only in Identity
   Platform. A consequence: local dev needs the four `BGB_FIREBASE_*` values in
   its `config.js` to sign in at all. They are repo variables, not secrets.
15. **`identity_admin.py` treats "not configured" as an ERROR, and
   `object_store.py` treats it as normal.** The two stances are opposite on
   purpose. An unconfigured R2 has a working fallback — the bytes go to
   Supabase Storage. An unconfigured identity admin has none: the only thing
   `DELETE /profile` could still do is delete the rows and leave the login
   standing, which is the exact bug the module was added to fix. So account
   deletion answers 503 and destroys nothing rather than half-succeeding, and
   local dev cannot delete accounts without `GCP_SERVICE_ACCOUNT_JSON`.
16. **`SupabaseUser.sub` is the app_uid; the provider's uid is
   `provider_uid`.** `jwt_auth.py` rewrites `sub` from the `app_uid` claim
   (see 11), so the field named `sub` is NOT the token's subject. Only
   `identity_admin.delete_user` wants the real one. Passing it `sub` addresses
   a uid Identity Platform has never seen, which it answers `USER_NOT_FOUND`
   to, which that function reports as success — every deletion green, every
   credential alive. `tests/test_account_deletion.py` is the only thing that
   catches it.

## Secrets that must never be rotated casually

`BGB_VAPID_PUBLIC_KEY` + `BGB_VAPID_PRIVATE_KEY` are one keypair — rotating
them silently stops delivery to every existing subscription and requires
`TRUNCATE boardgamebuddy_push_subscriptions`. `BGB_QR_SECRET` *is* the
revocation lever for add-a-buddy codes, which carry no server-side state.
`BGG_CREDENTIAL_KEY` is the Fernet key for linked users' stored BGG passwords.
`BGA_CREDENTIAL_KEY` is the same thing for Board Game Arena, and is deliberately
a **separate** key — rotating one must not orphan the other's stored passwords.
See `ENV.md`.
