# BoardgameBuddy — Option D Migration Runbook

> **How to use this document.** Each stage below is a self-contained work order.
> Paste the **Context brief** (§0) plus **one stage** into a fresh Claude Code
> instance and it has everything it needs — no history from the session that
> wrote this. Do not paste two stages at once: every stage ends at a deployed,
> verified, revertible state, and that is the point of the split.
>
> Companion document: `DEPLOYMENT_STRATEGY.md` in this directory has the cost
> comparison and the reasoning for choosing Option D. This file is only the
> *how*. Full-Hetzner notes are Appendix D.
>
> Written 2026-09-10 against `9a6d60b`.

---

## 0. Context brief

*(Paste this section with whichever stage you are running.)*

### What BoardgameBuddy is

A Strava-style board game play log. Web-only PWA — there is no `app/`
directory, no native build, no app store. Vanilla HTML/CSS/JS, no build step in
the tree. ~67k lines of JS across `web/views/`, `web/ui/` and `web/domain/`;
~18k lines of Python in one FastAPI route package.

### Where it lives today

| Tier | Location | Detail |
|---|---|---|
| Web | Vercel (Hobby), via `.github/workflows/deploy-frontend.yml` | Static files; bundled + minified at deploy into one hashed file (~215 KB gzip) |
| API | Railway, shared FastAPI service for 9 monorepo apps | `shared-backend/routes/boardgame_buddy/` |
| DB | Supabase Postgres (Free), one project shared by 9 apps | Tables prefixed `boardgamebuddy_*`; 23 migrations; **60 Postgres functions** |
| Auth | Supabase Auth — email/password + Google OAuth | Client-side via the JS SDK; backend verifies the JWT against cached JWKS |
| Photos | Supabase Storage, 2 buckets | `boardgamebuddy-plays`, `boardgamebuddy-games` |
| Push | Self-hosted Web Push (VAPID) | No vendor |

### Where it is going (Option D)

| Concern | Target | Why |
|---|---|---|
| Static web app | **Cloudflare Pages** | Free, commercial use permitted, no bandwidth cap. Replaces Vercel, whose Hobby plan forbids commercial use. |
| Photos + cover cache | **Cloudflare R2** | 10 GB free, then $0.015/GB, **$0 egress ever**. Image bytes are ~93% of all egress in this app. |
| API | **Railway** now → **Hetzner VPS** later | $5 covers the first ~1,000 users. |
| Postgres + Auth + RLS | **Supabase**, own project, + custom domain add-on | Keeps 199 PostgREST calls, 55 RPC calls and 60 functions working untouched. $10/mo buys a branded OAuth consent screen. |

Target steady state: **~$15/mo at 100 users, ~$45 at 1,000, ~$47 at 10,000.**

### Invariants — do not break these

These are all load-bearing and all counter-intuitive. Every one of them has a
comment in the code explaining why; read the comment before changing the line.

1. **`web/index.html` keeps its DaisyUI + Tailwind CDN pair.** The runtime JIT
   must run before first paint in local dev. The precompiled stylesheet is a
   **deploy-artifact-only** swap performed on the checkout being uploaded.
   Nothing is committed back.
2. **The repo keeps its ~121 `<script src>` tags.** That is the authoring model
   (`.claude/rules/web-frontend.md`). `.github/scripts/bgb-bundle.mjs`
   concatenates them at deploy time only. Do not restructure into ES modules or
   introduce a bundler in the tree.
3. **`web/sw.js` must keep `__BGB_BUILD_ID__` literal in the repo.** `sw.js`
   reads the unreplaced placeholder as "this is local dev" and disables itself.
   It is `sed`-stamped at deploy.
4. **`sw.js` derives its precache list from `src=`/`href=` in `index.html`.** So
   deploy step order is fixed: **Tailwind swap → bundle → stamp `sw.js`**. The QR
   codecs stay `rel=prefetch` in `index.html` precisely so the sweep still finds
   them.
5. **The bundler enforces a gzip budget** (450 KB, overridable only via
   `BGB_JS_GZIP_BUDGET` as a workflow-level `env:`, deliberately visible in a
   commit). Do not raise it to make a build pass.
6. **`SUPABASE_SERVICE_ROLE_KEY` never reaches the frontend.** Frontend gets the
   anon key only, via generated `config.js`.
7. **Carry `BGB_VAPID_PUBLIC_KEY` / `BGB_VAPID_PRIVATE_KEY` across unchanged.**
   They are one keypair; rotating them silently stops delivery to every existing
   subscription and requires `TRUNCATE boardgamebuddy_push_subscriptions`.
8. **Carry `BGB_QR_SECRET` across unchanged.** Rotating it invalidates every
   outstanding add-a-buddy QR code — the tokens carry no server-side state, so
   the secret *is* the revocation lever.
9. **Leave `BGG_PUSH_DRY_RUN` set.** BGG has no write API; the collection-write
   payload is reverse-engineered and unconfirmed.
10. **Photo uploads must keep stripping EXIF.** The photo importer reads a GPS
    tag on-device; `PHOTO_IMPORT_OPTS.alwaysReencode` guarantees that tag never
    reaches a bucket every buddy can read.

### Repo conventions

- Commit format: `[boardgame-buddy] description` (or `[infra] …`). One logical
  change per commit.
- Keep files under ~300 lines; split by domain past that.
- Update `ENV.md` in the **same commit** that adds, renames or removes any
  environment variable.
- After a PR merges, rebase follow-up branches onto main (`git rebase main`;
  `git rebase --skip` on a spurious conflict for a commit already in main), then
  force-push with `--force-with-lease`.

---

## Stage order and what each one costs

| Stage | Does | Cost after | Downtime | Reversible? |
|---|---|---|---|---|
| 1 | Extract to a standalone repo | no change | none | yes — old monorepo still deploys |
| 2 | Vercel → Cloudflare Pages | −$0, unblocks revenue | none (DNS swap) | yes — Vercel project until deleted |
| 3a | Supabase custom domain + SMTP | +$10/mo | none, **no logout** | yes — revert `supabaseUrl` |
| 3b | Own Supabase project | +$25/mo when needed | one window, **everyone re-signs in** | hard — old project is read-only fallback |
| 4 | Photos → R2 | ~$0, kills the growth curve | none (dual-read) | yes — Supabase objects stay |
| 5 | API → Hetzner VPS | ~−$0 to −$15/mo | none (DNS swap) | yes — Railway service until deleted |
| 6 | Full Hetzner (Appendix D) | flat ~€35/mo | one window | hard |

**Stages 1, 2 and 4 are pure wins with no user-visible risk. Do those three
first regardless of anything else.** Stage 3b is the only one that gets *more
expensive the longer you wait* — it forces a global re-login, which costs
nothing at 50 users and is a support incident at 5,000.

---

## Stage 1 — Extract to a standalone repo

**Goal:** a new repo that builds, runs locally, and deploys the same app to the
same Vercel + Railway + Supabase it uses today. Zero infrastructure change. This
stage is only about the code moving house.

### 1.1 Create the repo

```
boardgamebuddy/
├── CLAUDE.md                 ← trimmed from the monorepo's, BGB only
├── ENV.md                    ← BGB's variables only (Appendix A)
├── README.md
├── api/                      ← was shared-backend/
│   ├── main.py               ← REWRITE: one router, not nine
│   ├── db.py                 ← copy verbatim
│   ├── jwt_auth.py           ← copy verbatim
│   ├── cache.py              ← copy verbatim
│   ├── api_logger.py         ← copy verbatim
│   ├── gemini.py             ← copy verbatim
│   ├── auth.py               ← copy verbatim
│   ├── shared_models.py      ← copy verbatim
│   ├── requirements.txt      ← REWRITE: drop 3 sauceboss deps
│   ├── Procfile
│   ├── railway.toml
│   ├── routes/               ← the whole boardgame_buddy package, flattened
│   └── tests/
├── web/                      ← projects/boardgame-buddy/web/ verbatim
├── db/
│   ├── migrations/           ← 001–023 + the two _shared files (1.4)
│   ├── schema/
│   └── functions/
├── docs/                     ← projects/boardgame-buddy/Docs/ verbatim
├── tools/                    ← projects/boardgame-buddy/tools/ verbatim
├── scripts/
│   └── bgb-bundle.mjs        ← from .github/scripts/, unchanged
└── .github/workflows/
    ├── deploy-web.yml
    └── deploy-api.yml
```

### 1.2 The backend

Copy `shared-backend/routes/boardgame_buddy/` to `api/routes/` — the whole
package, `services/` included. Then fix imports: the package currently uses
relative imports one level up (`from ..models import …`) that no longer have a
level to go up to. Flattening `routes/boardgame_buddy/*` to `routes/*` makes
`..models` → `.models`; run the test suite to catch the rest.

Copy the seven shared modules **verbatim into `api/`**. Total shared surface is
~1,078 lines:

| Module | Lines | Purpose |
|---|---|---|
| `db.py` | 23 | Supabase client singleton (service role) |
| `jwt_auth.py` | 115 | Supabase Auth JWT verification against cached JWKS |
| `cache.py` | 136 | In-process, per-worker TTL cache |
| `api_logger.py` | 259 | Writes the `api_logs` table; per-request user contextvar |
| `gemini.py` | 219 | Shared Gemini caller |
| `auth.py` | 57 | `ADMIN_API_KEY` bearer check |
| `shared_models.py` | 16 | `HealthResponse` |

Do **not** publish them as a package. One consumer.

`main.py` is a rewrite, not a copy. Keep, from the original:

- The `truststore.inject_into_ssl()` call **before** any other import that
  touches SSL.
- `ALLOWED_ORIGINS` parsing and `CORSMiddleware`.
- `GZipMiddleware(minimum_size=1024)`.
- The `postgrest.exceptions.APIError` handler — **this one matters**: an
  unhandled `APIError` returns a 500 that never passes back through
  `CORSMiddleware`, so the browser reports an opaque "Failed to fetch" on every
  page. The handler must stay registered so the 500 carries CORS headers.
- The middleware ordering comment, and the ordering it describes:
  `add_middleware` **prepends**, so api-logger-context → GZip → CORS → routes.
- `/api/v1/health` (Railway's healthcheck path).

Drop: the eight other project routers, the sauceboss registry loaders
(`load_modifier_registry`, `load_unit_registry`), and the `openapi_tags` for
apps that are gone.

Keep the URL prefix **exactly** `/api/v1/boardgame_buddy/…` for now. Renaming it
is a frontend change too, and this stage changes nothing observable. Do it in a
later, separate commit if you want it.

`requirements.txt`: drop `recipe-scrapers`, `beautifulsoup4` and
`ingredient-parser-nlp` (sauceboss only). Keep everything else, including the
`supabase>=2.4.0,<2.26.0` cap — 2.26+ pulls `pyiceberg`, a C extension with no
3.14 wheels yet. Keep `pywebpush` and `truststore`.

### 1.3 The frontend

`projects/boardgame-buddy/web/` moves verbatim. `web/config.js` stays gitignored
and generated. Copy `.github/scripts/bgb-bundle.mjs` to `scripts/`.

### 1.4 The database

Copy `db/migrations/boardgamebuddy/` (001–023) as-is — it is already numbered
from 001 in its own directory, so it replays cleanly. Then bring the two
`_shared/` migrations BoardgameBuddy actually reads:

- `_shared/001_analytics.sql` → `analytics_events`. `web/domain/api.js:380` fires
  a tracking ping at `/api/v1/analytics/track`, so the table and that route both
  have to come along, or the ping has to go.
- `_shared/004_api_logs.sql` → `api_logs`. Read by `api_logger.py`.

Drop `_shared/002_admin_rpcs.sql` and `_shared/003_project_roles.sql` unless you
also want the admin dashboard, which is a separate app.

Renumber the two shared files as `000_analytics.sql` and `000_api_logs.sql`, or
keep a `db/migrations/_shared/` directory — either is fine, but write the
execution order into `db/migrations/README.md` so it is not folklore.

### 1.5 CI

Two workflows replace eight. `deploy-web.yml` reproduces the existing job
verbatim for now (still Vercel — Stage 2 changes the target), preserving the
step order from invariant #4:

1. `bash build.sh` with `API_BASE`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`
2. Tailwind + DaisyUI precompile, CDN-block swap, `.btn-primary` sanity gate
3. `node scripts/bgb-bundle.mjs web`
4. `sed` the `sw.js` build id from `${GITHUB_SHA}`
5. deploy

`deploy-api.yml` can stay a no-op notifier like the current
`deploy-backend.yml`, if you keep Railway's native GitHub auto-deploy (set the
service's Root Directory to `api`).

### 1.6 Leave behind, in the monorepo

A separate PR against `vibelab`, after the new repo is verified:

- BGB's entry in `APPS_WITH_USERS` (`shared-backend/routes/admin.py`)
- `from routes import boardgame_buddy` and its `openapi_tags` entry in `main.py`
- BGB's row in `registry.json` and the landing page's card
- `db/schema/boardgamebuddy.sql`, `db/functions/boardgamebuddy.sql`
- The `boardgame-buddy` cases in `deploy-frontend.yml` / `deploy-frontend-all.yml`
  and `.github/scripts/bgb-bundle.mjs`
- `supabase-keepalive.yml` pings a BGB table — repoint it at another app's table
- `ENV.md`: remove the eight `BGB_*` / `BGG_*` rows and the
  `VERCEL_BOARDGAME_BUDDY_PROJECT_ID` row, in the same commit
- Do **not** delete `projects/boardgame-buddy/` in the same PR that removes the
  wiring. Two commits, so a revert is cheap.

### 1.7 Acceptance

- `pip install -r api/requirements.txt && uvicorn main:app` boots from `api/`.
- `GET /api/v1/health` returns 200; `/docs` lists only BGB routes.
- The test suite passes.
- Serving `web/` locally with a generated `config.js` pointed at the local API:
  sign in, feed loads, log a play end to end, upload a photo.
- A deploy from the new repo lands on the existing Vercel project and the live
  app still works. **Verify the bundle actually ran** — one hashed JS file in the
  page source, not 121 tags.
- Old monorepo still deploys everything else.

---

## Stage 2 — Vercel → Cloudflare Pages

**Goal:** monetization unblocked, and −$20/mo against complying on Vercel Pro.
No code change; a different deploy target and a DNS record.

### 2.1 Cloudflare setup

1. Register the domain (Cloudflare Registrar sells at cost) or move DNS to
   Cloudflare.
2. Create a Pages project — **Direct Upload**, not the Git integration. The
   deploy artifact is generated by three build steps that must run in order
   (invariant #4); Cloudflare's own build step cannot reproduce them.
3. Create an API token scoped to **Cloudflare Pages: Edit** for that project.
4. Repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

### 2.2 Swap the deploy step

Everything above it is unchanged. Replace the Vercel step with:

```yaml
- name: Deploy to Cloudflare Pages
  working-directory: ./web
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  run: |
    npx wrangler@latest pages deploy . \
      --project-name=boardgamebuddy \
      --branch=main \
      --commit-dirty=true
```

`--commit-dirty=true` is required: the three preceding steps deliberately modify
the checkout (that is the whole design), and wrangler otherwise refuses to
upload a dirty tree.

### 2.3 Headers

Add `web/_headers` — Pages reads it, and it is the one thing Vercel was doing
that needs restating:

```
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/sw.js
  Cache-Control: no-cache

/index.html
  Cache-Control: no-cache

/config.js
  Cache-Control: no-cache

/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

`sw.js`, `index.html` and `config.js` must not be cached at the edge — the
service worker's whole update path depends on the browser re-fetching `sw.js`
and finding a new `BUILD_ID`. The bundled JS/CSS are content-hashed by
`bgb-bundle.mjs`, so `immutable` is safe for `/assets/*`.

### 2.4 Cutover

1. Deploy to the Pages URL. Verify on `*.pages.dev` before touching DNS.
2. Add the custom domain in Pages; point the apex at it.
3. **Add the new origin to `ALLOWED_ORIGINS` in Railway before the DNS swap.**
   Comma-separated, no trailing slash. Keep the Vercel origin in the list until
   you delete the project — a stale-DNS client still hits the old host.
4. Update `API_BASE` in the workflow if the API host changes (it doesn't yet).
5. Watch for 24h. Then: delete the Vercel project, remove `VERCEL_TOKEN`,
   `VERCEL_ORG_ID`, `VERCEL_BOARDGAME_BUDDY_PROJECT_ID` from repo secrets, and
   drop the Vercel origin from `ALLOWED_ORIGINS`.

### 2.5 Acceptance

- Page loads on the custom domain over HTTPS; one hashed JS file in source.
- Service worker installs; `caches.keys()` shows `bgb-shell-<sha>`.
- Offline: reload with the network off — the shell still boots.
- A second deploy replaces the old cache (`activate()` deletes it) — no stale
  bundle.
- Install prompt works; `manifest.json` and icons resolve.
- No CORS errors in the console.

---

## Stage 3a — Supabase custom domain + branded email

**Goal:** the Google consent screen reads "continue to
`auth.boardgamebuddy.com`" instead of `<ref>.supabase.co`, and auth emails come
from your domain. **+$10/mo. No downtime and no forced logout.**

Why no logout: `jwt_auth.py` verifies the token's signature and its
`audience="authenticated"` claim, but **not** its `iss`. A custom domain is the
same project with the same signing keys, so tokens minted under the old issuer
keep verifying. This is the cheap half of the auth work — do it independently of
Stage 3b.

### 3a.1 Steps

1. Buy the custom-domain add-on on the Supabase project ($10/mo per domain per
   project). Add the CNAME and TXT records it asks for; wait for activation.
2. Update `SUPABASE_URL` to the custom domain in **both** places: the Railway
   variable (backend, for `db.py` and the `jwt_auth.py` JWKS URL) and the
   `VIBELAB_SUPABASE_URL` repo secret (frontend, baked into `config.js` by
   `build.sh`).
3. In the Google Cloud console → Google Auth Platform:
   - **Branding**: app name, logo, support email, the app's home page and
     privacy-policy URLs on your domain.
   - **Clients**: add `https://auth.boardgamebuddy.com/auth/v1/callback` to the
     authorized redirect URIs. Keep the old `*.supabase.co` URI until the
     rollout is confirmed.
   - Verify the domain in Google Search Console. Brand review takes a few
     business days — start it early; it is the long pole in this stage.
4. In Supabase → Authentication → URL Configuration: set Site URL to the app's
   domain and add it to Redirect URLs.
5. **Custom SMTP** (Authentication → Emails → SMTP Settings). Supabase's
   built-in mailer is rate-limited for development and sends from a shared
   address, so a branded consent screen with a `noreply@supabase.io` confirmation
   email is a half-finished job. Resend's free tier is 3,000/month; SES is
   $0.10/1,000. Set SPF and DKIM for the sending domain or the mail lands in spam.
6. Re-theme the email templates (Authentication → Emails) — they ship with
   Supabase's default copy.

### 3a.2 Acceptance

- "Sign in with Google" consent screen shows your app name and your domain.
- A **new** sign-up receives a confirmation email from your domain; the link
  works.
- An **existing** signed-in session on a phone that has not reloaded still
  works — no logout. (This is the claim worth actually testing.)
- Password reset and magic-link flows both land on the right host.

---

## Stage 3b — Move to a dedicated Supabase project

**Goal:** BoardgameBuddy owns its own database, so its traffic, its bill and its
blast radius stop being shared with eight other apps.

**This is the only stage with real user-visible cost: a new project means new
signing keys, so every refresh token is invalidated and everyone signs in
again, once.** That is free at 50 users and a support incident at 5,000 — which
is the argument for doing it now rather than later.

You can also legitimately skip this stage. Pointing the extracted repo at the
existing shared project works fine; you just keep the coupling. Decide
deliberately.

### 3b.1 Before the window

1. Create the new Supabase project. Free allows 2 active projects, so you can
   stage this at no cost.
2. Replay migrations 001–023 plus the two `_shared` files on the new project.
   Verify all 60 functions exist:
   ```sql
   SELECT count(*) FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'bgb%';
   ```
3. Dump and restore data:
   ```sql
   pg_dump "$OLD_URL" \
     --data-only --no-owner \
     -t 'public.boardgamebuddy_*' \
     -t 'public.analytics_events' \
     -t 'public.api_logs' \
     > bgb-data.sql
   ```
   Restore into the new project. Watch FK order — restore `boardgamebuddy_games`
   and `boardgamebuddy_profiles` before the tables referencing them, or restore
   with constraints deferred.
4. Migrate `auth.users`. Supabase stores passwords as **bcrypt** in
   `auth.users.encrypted_password`; a dump-and-restore of `auth.users` preserves
   them, so nobody has to reset a password. `boardgamebuddy_profiles.user_id`
   FKs `auth.users(id)`, so **user UUIDs must be preserved exactly** — insert the
   ids, do not let the new project generate them.
5. Re-create the two storage buckets and copy their objects (`rclone`, or skip
   this if Stage 4 is running first — then the objects go straight to R2 and
   this step disappears).
6. Re-apply the 4 RLS policies and confirm the anon key can read only what it
   should.
7. Re-do Stage 3a on the new project: custom domain, Google redirect URI, SMTP.
8. Point a **staging** deploy at the new project and run the whole app against
   it: sign in, feed, log a play, photo upload, BGG sync, push subscribe.

### 3b.2 The window

1. Announce it. Put a banner in the app.
2. Freeze writes on the old project (revoke the service role's write grants, or
   stop the Railway service).
3. Re-run the data dump for the delta since step 3.
4. Flip `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in Railway and
   `VIBELAB_SUPABASE_URL` + `VIBELAB_SUPABASE_ANON_KEY` in repo secrets; redeploy
   both tiers. The frontend's `config.js` is generated at build, so **the web
   deploy has to re-run** — this is not a runtime env change.
5. Verify against the acceptance list.
6. Keep the old project **read-only, not deleted**, for at least two weeks.

### 3b.3 Acceptance

- Sign in with an **existing** email/password — proves the bcrypt hashes came
  across.
- Sign in with Google as an existing user — lands on the same profile, not a new
  one. (If it creates a duplicate, the `auth.users` id did not survive; stop and
  roll back.)
- Play counts, buddy edges, achievements and reference-guide chapters all match
  pre-migration values. Spot-check `bgb_user_stats` for a heavy account.
- Push: an existing subscription still delivers (it will, if you carried the
  VAPID keypair — invariant #7).
- A QR add-a-buddy code minted before the window still redeems (invariant #8).

---

## Stage 4 — Photos to Cloudflare R2

**Goal:** the only cost line that grows with success goes to $0. **This is the
highest-value stage in the plan** and it is contained: 4 call sites, one new
module, one data migration.

Nothing in the frontend touches Supabase Storage — verified, zero
`storage.from` calls in `web/`. Photo upload goes through the backend at
`POST /plays/photo`. So this is a backend + data change only.

### 4.1 What is stored where

| Call site | Bucket | Path shape | URL stored in |
|---|---|---|---|
| `routes/play_routes.py:516` | `boardgamebuddy-plays` | `{user_id}/{uuid4hex}.{ext}` | `boardgamebuddy_plays.photo_url` |
| `routes/game_routes.py:95` (`_upload_to_storage`) | `boardgamebuddy-games` | `{bgg_id}_{kind}.{ext}` | `boardgamebuddy_games.image_url`, `.thumbnail_url` |

Both derive the stored URL from `get_public_url(path)` immediately after upload.
Both paths are already stable and collision-free, so **keep them byte-identical
in R2** — that makes the object copy a straight mirror and the URL rewrite a
pure prefix substitution.

### 4.2 Cloudflare setup

1. Create two R2 buckets: `bgb-plays`, `bgb-games`.
2. Attach a custom domain to each — e.g. `img.boardgamebuddy.com/plays/…` via one
   bucket with a prefix, or two subdomains. **Serve images from the R2 custom
   domain, not through Pages.** R2 is a paid product and is the clean way to
   push a lot of image bytes through Cloudflare; Cloudflare's terms have
   historically discouraged serving a disproportionate share of non-HTML content
   on free plans.
3. Create an R2 API token (Object Read & Write, scoped to those buckets).
4. New Railway variables — add all five to `ENV.md` in the same commit:
   `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_PLAYS_BUCKET`, `R2_GAMES_PUBLIC_BASE` (and `R2_PLAYS_PUBLIC_BASE`).

### 4.3 Code

Add `api/object_store.py` — a small S3-compatible wrapper, well under the
300-line convention:

```python
"""object_store.py — S3-compatible object storage (Cloudflare R2).

Replaces Supabase Storage for image objects. Paths are unchanged from the
Supabase layout so the migration is a prefix rewrite, not a re-key.
"""
```

It needs exactly two operations — `put(bucket, path, data, content_type)` and
`public_url(bucket, path)`. Use `boto3` against the R2 endpoint
(`https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, region `auto`) and add
`boto3>=1.34` to `requirements.txt`.

Then replace the two upload blocks. Keep every guard that is already there —
the MIME allowlist, the 5 MiB cap, the empty-file check, the `logger.warning` +
`502` on failure, and `_upload_to_storage`'s fallback of returning the original
BGG URL when the re-host fails. Only the two lines that talk to
`sb.storage.from_(…)` change.

**Read path must tolerate both.** Old rows hold `…supabase.co/storage/v1/…`
URLs; new rows hold `img.boardgamebuddy.com/…`. Both are absolute URLs the
client just loads, so nothing needs a code branch — but do not delete the
Supabase buckets until §4.5 confirms every row is rewritten.

### 4.4 Copy the objects

```
rclone copy supabase:boardgamebuddy-plays r2:bgb-plays --progress
rclone copy supabase:boardgamebuddy-games r2:bgb-games --progress
```

Then rewrite the stored URLs — three columns, one migration
(`024_r2_photo_urls.sql`):

```sql
UPDATE public.boardgamebuddy_plays
   SET photo_url = replace(photo_url, :old_plays_prefix, :new_plays_prefix)
 WHERE photo_url LIKE :old_plays_prefix || '%';

UPDATE public.boardgamebuddy_games
   SET image_url     = replace(image_url,     :old_games_prefix, :new_games_prefix),
       thumbnail_url = replace(thumbnail_url, :old_games_prefix, :new_games_prefix)
 WHERE image_url     LIKE :old_games_prefix || '%'
    OR thumbnail_url LIKE :old_games_prefix || '%';
```

Run the `rclone copy` **before** the UPDATE and re-run it after (it is
incremental) to catch uploads that landed mid-flight. Order matters: a rewritten
URL whose object has not copied yet is a broken image.

Note that `boardgamebuddy_games.image_url` may also hold un-rehosted BGG URLs
(the `_upload_to_storage` fallback), and those must be left alone — the `LIKE`
guards handle it.

### 4.5 Acceptance

- Upload a new play photo → the returned URL is on the R2 domain, and the image
  loads.
- An **old** play's photo still loads (pre-rewrite rows).
- After the migration: `SELECT count(*) FROM boardgamebuddy_plays WHERE photo_url
  LIKE '%supabase.co%'` returns **0**. Same for both game columns.
- A photo-import run of 5+ photos writes plays whose photos all load.
- `curl -I` an image URL: `cf-cache-status: HIT` on the second request.
- **EXIF check** (invariant #10): download an uploaded photo and confirm no GPS
  tag — `exiftool -gps:all <file>` returns nothing.
- Supabase egress on the usage report drops on the next cycle. That is the whole
  point of the stage.

---

## Stage 5 — API to a Hetzner VPS

**Goal:** get off metered compute. Optional, and only worth doing when Railway's
bill or its cold starts actually bother you. Does not touch the database.

### 5.1 Provision

A shared-vCPU box, 2 vCPU / 4 GB, is generous for one uvicorn process. **Check
current Hetzner pricing and availability first** — prices rose on 2026-04-01 and
again on 2026-06-15 (shared vCPU +30–38%, dedicated vCPU +113–175%), and some
shared lines were showing as unavailable in early September 2026. If shared vCPU
is unavailable, compare against Fly.io or Scaleway before defaulting to a
dedicated-vCPU box at 3× the price.

Baseline hardening: non-root user with sudo, SSH keys only
(`PasswordAuthentication no`), UFW allowing 22/80/443 only, unattended-upgrades
on.

### 5.2 Run it

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Compose it with Caddy for automatic TLS. Caddy needs a real certificate even
behind Cloudflare — use Full (Strict) SSL mode, not Flexible.

Two things to carry over from Railway that are easy to forget:

- **`--proxy-headers --forwarded-allow-ips`** on uvicorn, or every client IP in
  `api_logs` becomes the proxy's.
- The healthcheck path is `/api/v1/health` (`railway.toml`). Point Caddy's or
  the monitor's check at it.

Keep it one uvicorn worker unless you measure otherwise: `cache.py` is
**per-worker**, so adding workers multiplies cache misses and makes the 60-second
profile cache staler, not faster.

### 5.3 Cutover

1. Copy every env var from Railway (Appendix A). Carry the VAPID pair and
   `BGB_QR_SECRET` unchanged (invariants #7, #8).
2. Bring it up on `api-new.boardgamebuddy.com` and smoke-test against production
   Supabase.
3. Add the new origin to nothing — CORS is about the *frontend* origin, which is
   unchanged. But **do** update `API_BASE` in `deploy-web.yml` and redeploy the
   web tier, since `config.js` bakes it in at build.
4. DNS-swap `api.boardgamebuddy.com` (proxied through Cloudflare, orange cloud).
5. Watch, then stop the Railway service. Keep it stopped-not-deleted for a week.

### 5.4 Acceptance

- `/api/v1/health` 200 through the Cloudflare-proxied hostname.
- Sign in, feed, log a play, photo upload, BGG sync, push send.
- `api_logs` shows real client IPs, not the proxy's.
- Restart the box: the container comes back on its own (`restart: unless-stopped`
  or a systemd unit).
- Cold-start latency and `/bootstrap` timing at least match Railway's — the
  `boot_timing` analytics event carries `dcl_ms` and `bootstrap_ms`, so compare
  them rather than guessing.

---

## Appendix A — Environment variable matrix (new repo)

**API host (Railway, later the VPS):**

| Variable | Carry unchanged? | Note |
|---|---|---|
| `SUPABASE_URL` | changes in 3a/3b | Also the JWKS base for `jwt_auth.py` |
| `SUPABASE_SERVICE_ROLE_KEY` | changes in 3b | Never to the frontend |
| `ALLOWED_ORIGINS` | update in 2, 5 | Comma-separated, no trailing slash |
| `ADMIN_API_KEY` | yes | |
| `BGB_QR_SECRET` | **yes — invariant #8** | ≥32 bytes |
| `BGB_VAPID_PUBLIC_KEY` | **yes — invariant #7** | 87 base64url chars, starts `B` |
| `BGB_VAPID_PRIVATE_KEY` | **yes — invariant #7** | 43 base64url chars |
| `BGB_VAPID_SUBJECT` | yes | Set a real `mailto:` before relying on push |
| `BGG_API_TOKEN` | yes | |
| `BGG_CREDENTIAL_KEY` | **yes** | Fernet key; rotating it orphans stored BGG credentials |
| `BGG_PUSH_DRY_RUN` | **yes, leave on — invariant #9** | |
| `BGG_WEB_USER_AGENT` | yes | Moving target; Cloudflare screens it |
| `BGG_THROTTLE_SECONDS` | yes | default 1.5 |
| `BGG_PUSH_THROTTLE_SECONDS` | yes | default 2.0 |
| `GEMINI_API_KEY` | yes | Chapter drafting + play-note import |
| `R2_*` (5 vars) | new in Stage 4 | |

**Repo secrets:** `SUPABASE_URL`, `SUPABASE_ANON_KEY` (baked into `config.js` by
`build.sh`), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Four, replacing
~15. Delete the three `VERCEL_*` secrets at the end of Stage 2.

**Not a secret:** `BGB_JS_GZIP_BUDGET` — only ever set as a workflow-level `env:`
in a commit that says why (invariant #5).

---

## Appendix B — Verification commands

```bash
# 60 Postgres functions present
psql "$DB_URL" -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'bgb%';"

# No Supabase Storage URLs left after Stage 4
psql "$DB_URL" -c "SELECT count(*) FROM boardgamebuddy_plays WHERE photo_url LIKE '%supabase.co%';"
psql "$DB_URL" -c "SELECT count(*) FROM boardgamebuddy_games WHERE image_url LIKE '%supabase.co%' OR thumbnail_url LIKE '%supabase.co%';"

# Bundle actually ran (expect 1, not 121)
curl -s https://boardgamebuddy.com/ | grep -c '<script src='

# Service worker is stamped, not literal
curl -s https://boardgamebuddy.com/sw.js | grep -c '__BGB_BUILD_ID__'   # expect 0

# Edge caching images
curl -sI https://img.boardgamebuddy.com/<path> | grep -i cf-cache-status

# EXIF stripped
exiftool -gps:all downloaded.jpg   # expect no output

# API health
curl -s https://api.boardgamebuddy.com/api/v1/health
```

---

## Appendix C — Rollback

| Stage | Rollback | Window |
|---|---|---|
| 1 | Keep deploying from the monorepo | until you delete `projects/boardgame-buddy/` |
| 2 | Re-point DNS at Vercel | until the Vercel project is deleted |
| 3a | Revert `SUPABASE_URL` in both places; redeploy web | immediate |
| 3b | Re-point at the old project; redeploy both tiers | writes after the flip are lost — keep the old project read-only 2 weeks |
| 4 | Revert the code; the `replace()` UPDATE inverts | until the Supabase buckets are deleted |
| 5 | Re-point `api.` DNS at Railway | until the Railway service is deleted |

The general rule: **do not delete the thing you migrated off until the next
stage is done and verified.** All six of these rollbacks are cheap only because
the old thing is still there.

---

## Appendix D — What full Hetzner would take

This is Option B from `DEPLOYMENT_STRATEGY.md`, reached as Stage 6 after Stage 5.
It is the cheapest end state at every scale (~€35/mo flat, versus ~$47 for
Option D at 10k users and $328 for the status quo). It is not scheduled here
because the saving is ~$25/mo and the price is owning Postgres backups, and that
trade is only worth making once the bill is real.

**Trigger condition:** the Supabase bill passes ~$100/month. At 4–6 hours of
monthly ops, that is roughly where self-hosting starts paying more than minimum
wage.

### The one insight that makes it viable

**Self-host the Supabase *stack*, not bare Postgres.** Running GoTrue +
PostgREST + Storage + Postgres from Supabase's own `docker-compose` means all
199 `sb.table()` calls, all 55 `.rpc()` calls, the JS Auth SDK and the Storage
SDK keep working with a changed hostname and nothing else. Migrating to bare
Postgres instead means rewriting 254 data-access call sites — which is the same
work as moving to Cloud SQL, and is why "self-hosted Postgres" and "self-hosted
Supabase" are completely different projects despite sounding similar.

### What you would be running

| Service | Why | Notes |
|---|---|---|
| Postgres 15+ | the data | 60 BGB functions replay as-is |
| **GoTrue** | Supabase Auth | The frontend keeps `createClient()`; only the URL changes |
| **PostgREST** | the 199 `sb.table()` calls | This is the one that saves the rewrite |
| **Storage API** | only if you skipped Stage 4 | After Stage 4 photos are on R2 — **drop this service entirely** |
| Kong / Caddy | routes `/auth/v1`, `/rest/v1` under one host | GoTrue and PostgREST expect that prefix layout |
| `postgres-meta`, Studio | admin UI | optional; do not expose publicly |
| uvicorn (the API) | already there from Stage 5 | |

Doing Stage 4 first is what makes this tractable: **the Storage service is the
messiest part of the self-hosted stack, and R2 deletes the need for it.** That
ordering is not incidental — it is the reason Stage 4 comes before Stage 6.

### Sizing and cost

- 8 GB RAM minimum for Postgres + GoTrue + PostgREST + uvicorn with headroom;
  16 GB once plays are in the millions.
- Snapshots (~20% of server price) + a Storage Box for offsite WAL (from
  ~€3.20/TB, free egress).
- 20 TB of traffic is included with the server, so egress stays ~€0.
- Realistic all-in: **~€25–35/month, flat.**

### What you take on

The honest list, because this is the whole cost of the option:

1. **Postgres backups and PITR.** `pgBackRest` or `wal-g` shipping WAL to the
   Storage Box. **The backup is not done until you have restored from it into a
   scratch box and booted the app against it.** An unrehearsed backup is a
   rumour. Put the rehearsal on a calendar, quarterly.
2. **GoTrue upgrades.** Auth is the one service where falling behind on security
   patches is not survivable, and it now upgrades on your schedule, not
   Supabase's.
3. **Single point of failure.** One box means disk-full, a bad kernel upgrade and
   a failed migration are all total outages. Uptime monitoring with alerts to a
   phone, plus a documented rebuild path, is the minimum.
4. **You are on call.** There is no one else.

### Migration outline (Stage 6, when triggered)

1. Stand the stack up on the Stage 5 box (bigger, or a second box) — **from a
   pinned compose file, in git**, not by hand.
2. Replay migrations 001–024 on the self-hosted Postgres; verify 60 functions.
3. `pg_dump` data including `auth.users` (bcrypt hashes preserved, UUIDs
   preserved — same constraint as Stage 3b).
4. Route `/auth/v1` and `/rest/v1` under one hostname behind Cloudflare.
5. Point `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` at
   the self-hosted stack — in Railway/VPS **and** in the repo secrets that
   generate `config.js` — and redeploy both tiers.
6. **New signing keys means another global re-login**, same as Stage 3b. If you
   know you are eventually going here, the two logouts can be collapsed into one
   by skipping Stage 3b and going straight to self-hosted — but only if you are
   confident enough to run the auth stack that early, which the rest of this
   plan argues against.
7. Keep Supabase paid and read-only for a month. This is the one rollback that is
   genuinely expensive to lose.

### The honest summary

Full Hetzner is the right end state, and Option D's phases 1–5 are all *on the
way there* rather than detours: the repo extraction, the static host, the object
storage and the API container are all prerequisites you would need anyway. The
only thing Option D defers is running your own database and auth — which is
precisely the part that should be deferred until there are users whose data makes
it worth the trouble.
