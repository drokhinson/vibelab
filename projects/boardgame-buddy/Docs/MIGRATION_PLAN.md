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

## Status — 2026-09-16

**Stages 1, 2, 2b and 3-ALT are done and live.** The app serves from Cloudflare
Pages at `bgbuddy.app`, the API from its own Railway service at
`api.bgbuddy.app`, and auth from GCP Identity Platform at `auth.bgbuddy.app`
with all 23 accounts imported under their original Supabase UUIDs. The
pre-launch gate and the landing view are removed; the old Vercel origin serves
a static notice. Console-by-console detail, including every correction that
doing it for real produced, is in `SETUP_HOSTING.md`.

**Two pieces of the migration are deliberately still in the tree**, and both
are the rollback path rather than leftovers:

* `api/jwt_auth.py` verifies **both** issuers, Supabase and Identity Platform.
* `web/domain/auth.js` keeps its Supabase Auth branch, selected when the four
  `BGB_FIREBASE_*` variables are unset.

Together they mean rollback is unsetting four repo variables and re-running the
deploy. **Remove them when that stops being true**, which is when post-cutover
signups exist only in Identity Platform in numbers you would not hand-migrate
back — rolling back would orphan those accounts, so the escape hatch has
already stopped working and is then only extra verifier surface. Delete both
sides in one commit, with `test_jwt_auth_dual_issuer.py` reduced to the
Identity Platform cases.

**Stage 4's code has landed and is inert.** `api/object_store.py`, both upload
call sites and `038_r2_photo_urls.sql` are in the tree; with the R2 variables
unset the API still writes to Supabase Storage, so nothing changed in
production. What remains is console work and a data copy: two buckets, two
custom domains, one API token, seven Railway variables, `rclone`, then the
migration. §4.2 onward is the order.

**Still open:** Email Routing (§3.8 of `SETUP_HOSTING.md`), Stage 4's console
half, and the two photo gaps the privacy policy discloses — play photos readable by anyone with the link, and
image files surviving the row that referenced them.

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

## Decided design (2026-09-15)

The domain is bought and three questions are settled. These decisions override
anything below that contradicts them.

### One origin, forever: the app lives at the apex

`web/index.html` carries `<base href="/">`, `manifest.json` declares
`start_url: "/"` and `scope: "/"`, and `sw.js` derives its entire precache from
root-relative `src=`/`href=` references. **The app must sit at an origin root —
never a subpath.** So the apex serves the real app from day one, gated by a
`COMING_SOON` flag, and cutover is dropping that flag rather than moving a
domain. The apex never moves again.

Native apps are planned later, with links to the respective stores. Those links
are landing-page content, and they go in the same place the coming-soon copy
goes — see the landing view below. The app staying at the apex is what makes
that free: a marketing page at the apex *and* an app at the apex would otherwise
collide, forcing the app onto `app.<domain>` and costing a second cutover.

Three hostnames total:

| Host | Serves | Set up in |
|---|---|---|
| `<domain>` (apex) | the app, Cloudflare Pages | Stage 2 |
| `auth.<domain>` | GCP Identity Platform auth handler, on Firebase Hosting | Stage 3-ALT |
| `img.<domain>` | R2 custom domain for photos and cover art | Stage 4 |

### The landing is a new view, not the splash

**`views/splash-view.js` is the boot loader** — the spinner that paints while the
session resolves — and the signed-out destination is `views/auth-view.js`, a bare
login form. Neither is a landing surface, so one has to be built: a
`views/landing-view.js` registered as the signed-out root, carrying the
coming-soon copy now and the store badges later, with the sign-in affordance on
it. `auth-view.js` stays exactly what it is, one tap deeper.

Waitlist capture on that view writes to its own table and **creates no identity**
— see the signup decision below.

> **What shipped, and what is gone.** The view and the `COMING_SOON` gate were
> built, did their job through the DNS and auth cutover, and were **removed at
> cutover** — the merge now lands the app live, so a permanent conditional in
> the boot path bought nothing. `boardgamebuddy_waitlist` (migration 035) and
> `api/routes/waitlist_routes.py` briefly outlived the view and are **also gone
> now**, dropped by migration `037_drop_waitlist.sql` — see below.
>
> The store badges this section parks on the landing view need a new home when
> the native apps ship. The app's own root is the obvious one.

### No per-user migration gateway

A self-service "migrate my data" screen on first sign-in was considered and
**rejected**. Nothing needs migrating per user, because both credential types
survive a bulk import:

- **Email/password** — Supabase stores bcrypt in `auth.users.encrypted_password`;
  Firebase's `importUsers` accepts bcrypt hashes directly. Same password.
- **Google** — `importUsers` takes `providerData` with `providerId: 'google.com'`
  and the provider's own `uid`. Supabase holds the Google `sub` in
  `auth.identities`, so importing the linkage makes the same Google account
  resolve to the same Firebase user.

Import the Supabase UUID as the Firebase `uid` and a user signs in exactly as
before, on their own account, with their own plays. What the gateway would have
cost instead:

1. **An account-takeover surface.** Matching a new GCP identity to an old
   Supabase account means matching on email — so anyone who signs up with an
   existing user's email claims that account and its history. Defending it means
   Google-verified-email-only or a challenge against the old password, i.e.
   rebuilding by hand what the import gives for free.
2. **Dual auth in the hot path.** `jwt_auth.py` would verify two issuers on every
   request for the whole window.
3. **N cutovers instead of one**, with both systems live indefinitely — the
   opposite of the goal.
4. **It cannot cover the cover art anyway.** The plays bucket is
   `{user_id}/{uuid}.{ext}` and is per-user separable; the games bucket is
   `{bgg_id}_{kind}.{ext}`, shared across all users. That half needs a bulk copy
   regardless.

**Keep one small fallback claim flow** for the real edge case — someone who used
email/password before and clicks Google after, landing on a fresh profile. That
is an escape hatch on a support page, not a step in the happy path.

### Waitlist only before launch: no pre-import accounts

The public landing captures emails and **writes no identity**. Auth is rehearsed
on a `staging.` hostname against a throwaway GCP project.

This is a correctness constraint, not caution. Firebase's import "processes users
without checking for uid, email, phoneNumber or other identifier duplication" —
it will cheerfully create a second account for an email that already exists. Any
real signup taken before the user import becomes a duplicate identity to
reconcile by hand. Waitlist-only removes the collision entirely and decouples
"when is the landing up" from "when is the import ready".

> **Held, and now spent.** The import ran with the gate up: 23 accounts, all
> under their original Supabase UUIDs, verified 23/23. With the import done the
> collision this constraint existed to prevent cannot happen again, which is
> what made removing the gate safe rather than merely convenient.
>
> **The capture half of this was wasted effort, and that is the better
> outcome.** The waitlist took **zero** addresses: the gate was up for hours,
> not weeks, and nobody found the form. So there was no launch email to send
> and no list to export — migration `037_drop_waitlist.sql` dropped the table
> empty, and the route, its test and the privacy policy's two clauses about it
> went with it. The constraint still earned its place: it was insurance against
> a duplicate identity, and insurance that pays out nothing is insurance that
> worked.

---

## Stage order and what each one costs

| Stage | Does | Cost after | Downtime | Reversible? |
|---|---|---|---|---|
| 1 | **Isolate in place** (one tree, own workflows + Railway service) | no change | none | yes — it is a file move |
| 2 | Vercel → Cloudflare Pages, apex, `COMING_SOON` on | −$0, unblocks revenue | none (DNS swap) | yes — Pages keeps every deploy, one-click rollback |
| 2b | Landing view + waitlist capture | $0 | none | yes — it is one view |
| 3 | **Decide the auth path** (§ Stage 3) | — | — | — |
| 3a | Path A: Supabase custom domain + SMTP | +$10/mo | none, **no logout** | yes — revert `supabaseUrl` |
| 3-ALT | Path B: auth on GCP Identity Platform | **$0** to 50k MAU | one window, **everyone re-signs in** | hard |
| 3b | Own Supabase project | +$25/mo when needed | one window, **everyone re-signs in** | hard — old project is read-only fallback |
| 4 | Photos → R2 | ~$0, kills the growth curve | none (dual-read) | yes — Supabase objects stay |
| 5 | API → Hetzner VPS | ~−$0 to −$15/mo | none (DNS swap) | yes — Railway service until deleted |
| 6 | Cutover: URL rewrite, remove the gate, moved notice on the old origin | — | none | yes — Pages deployment rollback |
| 7 | Full Hetzner (Appendix D) | flat ~€35/mo | one window | hard |

**Revised order, given the decided design.** Two constraints reorder the stages:
the landing and auth code live in the new repo, so **extraction comes first**;
and Google's brand review takes business days, so **start it early and let it run
in the background**.

1. **Stage 1 — isolate in place.** Consolidate the three trees into
   `projects/boardgame-buddy/`. Zero risk, unblocks everything else, and turns a
   future standalone repo into one `git` command instead of a port.
2. **Stage 4 — R2 + bulk `rclone`**, while the old app is still live on Supabase.
   The copy is incremental and re-runnable, so it can be verified at leisure
   instead of inside a cutover window. Only the URL rewrite waits for Stage 6.
3. **Stage 3-ALT — GCP Identity Platform**: auth handler on `auth.<domain>`,
   branding, domain verification in Search Console. **Kick off the Google brand
   review on day one of this stage** — it is the only item with a queue you do
   not control.
4. **Stage 2 — Cloudflare Pages on the apex**, `COMING_SOON` on. Then **2b**, the
   landing view and waitlist table.
5. **Wire Supabase third-party auth** so the three `auth.uid()` policies keep
   evaluating under a GCP-issued JWT. Non-negotiable — see the four traps below.
6. **Import the users** — bcrypt hashes, Google `providerData`, preserved UUIDs —
   and verify the whole app against it on `staging.`.
7. **Stage 6 — cut over**: run the URL-rewrite migration, delete the
   `COMING_SOON` gate and landing view, and replace the old Vercel deployment
   with `projects/boardgame-buddy/moved/` (SETUP_HOSTING.md §6, step 14).

### Four things that break silently if missed

1. **Wire GCP Identity into Supabase as a third-party auth provider.** Three
   `auth.uid()` RLS policies sit on the live play-session tables, which the
   client reads directly with the anon key. Skip this and they fail closed — the
   spectator mirror goes blank, and nothing else looks wrong.
2. **Preserve the UUIDs.** `boardgamebuddy_profiles.id` FKs `auth.users(id)` and
   every play, buddy edge and achievement hangs off that column. A regenerated
   id orphans the entire account, silently, at import time.
3. **Dropping that FK loses `ON DELETE CASCADE`.** Account deletion becomes
   explicit backend work. Write it before you need it, not after someone asks.
4. **`views/auth-view.js:101` hardcodes `redirectTo: window.location.origin`.**
   That has to become the Firebase auth handler on `auth.<domain>`.

**Stages 1, 2 and 4 are pure wins with no user-visible risk. Do those three
first regardless of anything else** — between them they settle two of the three
deciding needs (photo-storage growth, and the ability to monetize) for $0.

**Any stage that forces a global re-login gets more expensive the longer you
wait** — 3b and 3-ALT both do, and it costs nothing at 50 users while being a
support incident at 5,000. That is the argument for settling the auth path early
rather than deferring it.

---

## Stage 1 — Isolate in place (not a new repo)

**Revised 2026-09-15.** This stage originally said "create a standalone repo".
Isolating BoardgameBuddy *inside* vibelab is the better first move, and a
standalone repo becomes an optional `git` command afterwards rather than a port.

### Why in-place first

**It is the same work either way.** BoardgameBuddy currently lives in **three
separate trees** — `projects/boardgame-buddy/` (4.9 MB),
`shared-backend/routes/boardgame_buddy/` (820 KB) and
`db/migrations/boardgamebuddy/` (1.4 MB). Consolidating those into one directory
is the bulk of the effort, and it has to happen whether the destination is this
repo or a new one.

**It is what makes a clean extraction possible.** `git subtree split` operates on
**one** prefix. A project spread across three trees cannot be split — which is
why extracting today would be a copy-paste port that abandons history.
Consolidate first and extraction becomes mechanical:

```bash
# after consolidation — one prefix, history for that path preserved
git subtree split -P projects/boardgame-buddy -b bgb-standalone
```

One caveat, stated precisely: `subtree split` carries the history of commits that
touched *that path*, so the backend's history from before the move (under
`shared-backend/…`) does not come along — those files appear as of the move
commit. If you want that history too, use `git filter-repo` with explicit
renames instead:

```bash
git filter-repo \
  --path projects/boardgame-buddy \
  --path shared-backend/routes/boardgame_buddy \
  --path-rename shared-backend/routes/boardgame_buddy:projects/boardgame-buddy/api/routes
```

Either way it is a command, not a migration.

**The seam is already clean.** Nothing in the monorepo depends on
BoardgameBuddy's code — it is a leaf. The only inbound references are
registration wiring, and there are nine lines of them:

| Where | Lines | What |
|---|---|---|
| `shared-backend/main.py` | 4 | import, `openapi_tags` entry, api-logger prefix map, `include_router` |
| `shared-backend/routes/admin.py` | 4 | `_delete_boardgamebuddy_user` + the `APPS_WITH_USERS` entry |
| `shared-backend/gemini.py` | 1 | a docstring reference |
| `landing/app.js`, `landing/registry.json` | — | the landing card |

**And the duplication argument inverts.** The objection to in-place isolation is
that BoardgameBuddy would carry its own copy of the ~1,078 lines of shared
modules, which could drift. But Stage 3-ALT *requires* that drift:
`jwt_auth.py` has to start verifying Google-issued tokens, and the other eight
apps must keep verifying Supabase ones. The module has to fork regardless. A
duplicate that is *supposed* to diverge is not debt.

**Everything downstream is indifferent to repo layout.** R2, GCP Identity, the
Pages project, the landing view and the Supabase project split all work
identically either way. Nothing later in this plan depends on a separate repo.

### Target layout — one tree

```
projects/boardgame-buddy/
├── CLAUDE.md               ← NEW: nested, BGB-only context (root CLAUDE.md still loads)
├── ENV.md                  ← NEW: BGB's variables only (Appendix A)
├── api/                    ← from shared-backend/
│   ├── main.py             ← REWRITE: own FastAPI app, one router
│   ├── db.py  jwt_auth.py  cache.py  api_logger.py  gemini.py  auth.py  shared_models.py
│   ├── requirements.txt    ← REWRITE: drop the 3 sauceboss deps
│   ├── Procfile  railway.toml
│   ├── routes/             ← from routes/boardgame_buddy/, flattened (`..models` → `.models`)
│   └── tests/
├── db/migrations/          ← from db/migrations/boardgamebuddy/ + the 2 _shared files
├── scripts/
│   └── bgb-bundle.mjs      ← from .github/scripts/
├── web/                    ← unchanged
├── Docs/  tools/           ← unchanged
```

The rest of §1.2–1.4 below still applies verbatim — the `main.py` rewrite, the
seven shared modules, the import flattening, the `_shared` migrations, the
`requirements.txt` trim. Only the destination changed.

### What stays shared, and it is not optional

**`.github/workflows/` cannot be isolated.** GitHub only reads workflows from
that one directory at the repo root, so BoardgameBuddy's two workflows live
there alongside the others, scoped by path filter:

```yaml
on:
  push:
    branches: [main]
    paths:
      - projects/boardgame-buddy/**
```

Add the inverse exclusion to the existing `deploy-frontend.yml` and
`deploy-backend.yml` (`paths-ignore`, or drop `boardgame-buddy` from the detect
matrix) so a BoardgameBuddy commit stops redeploying the other eight apps and
vice versa. Without that, isolation is only on disk.

**GitHub Actions secrets are repo-wide.** BoardgameBuddy's Cloudflare and R2
credentials sit in the same store as everything else. That is not a security
boundary, and it is the one honest argument for eventually splitting the repo —
worth acting on when there is revenue to protect, not now.

**Two backend services from one repo.** The isolated `api/` needs its own
Railway service with Root Directory `projects/boardgame-buddy/api`, beside the
existing one pointed at `shared-backend`. Railway supports this directly.

### Monorepo cleanup

Remove the nine wiring lines above in a **separate commit** from the move, so a
revert is cheap. Keep `supabase-keepalive.yml` pointed at a non-BGB table.
Update `ENV.md` in the same commit that moves the eight `BGB_*` / `BGG_*` rows
into the project's own `ENV.md`. The landing card can stay until cutover.

### Acceptance

- `uvicorn main:app` boots from `projects/boardgame-buddy/api/`; `/api/v1/health`
  returns 200; `/docs` lists only BGB routes; tests pass.
- `shared-backend` still boots with the other eight apps and no BGB references.
- A commit touching only `projects/boardgame-buddy/**` triggers **only** the BGB
  workflows. A commit touching only `shared-backend/**` does not trigger them.
- The live app still works after a deploy from the isolated tree — and
  **verify the bundle ran**: one hashed JS file in the page source, not 121 tags.
- `git subtree split -P projects/boardgame-buddy -b bgb-standalone` succeeds and
  the branch contains a complete, buildable project. Do not push it anywhere —
  this is the check that the isolation is real.

### The original standalone-repo layout, for reference


**Goal:** a new repo that builds, runs locally, and deploys the same app to the
same Vercel + Railway + Supabase it uses today. Zero infrastructure change. This
stage is only about the code moving house.

### 1.1 Repo skeleton (superseded — kept because §1.2–1.6 reference it)

*This was the layout when Stage 1 created a new repo. It is still the shape of
the isolated tree, one level down under `projects/boardgame-buddy/`, and the
sub-sections after it are unchanged and still correct.*

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

## Stage 3 — Pick the auth path first

*(Added 2026-09-14. The three deciding needs are photo-storage growth, branded
custom-domain auth "ideally free", and the ability to monetize. Needs 1 and 3 are
settled by Stages 2 and 4. Need 2 is a fork, and it has to be decided before
either Stage 3a or 3b is worth starting.)*

The auth surface is far smaller than the 254-call-site data layer implies, which
is what makes a free path viable:

| Surface | Size | Where |
|---|---|---|
| Frontend auth call sites | **8** | `views/auth-view.js` (3), `init.js` (3), `domain/api.js` (2) |
| Distinct SDK methods | 7 | `signUp`, `signInWithPassword`, `signInWithOAuth`, `signOut`, `getSession`, `refreshSession`, `onAuthStateChange` |
| Backend files | **2** | `jwt_auth.py`, `routes/dependencies.py` |
| `REFERENCES auth.users` | **1** | `boardgamebuddy_profiles.id` (`001_baseline.sql:116`) |
| RLS policies using `auth.uid()` | **3** | live play-session tables — the realtime spectator mirror, read client-side with the anon key |

| Path | Monthly | Work | Forced re-logins on the way to Hetzner | Run it |
|---|---|---|---|---|
| **A · Supabase custom domain** | $10 | ~1 hour, zero code | **two** (Stage 3b, then Stage 6) | Stage 3a, then 3b |
| **B · GCP Identity Platform**, branded via a free Firebase Hosting auth handler, wired to Supabase as third-party auth | **$0** to 50k MAU | ~1 day | **one** (now) | Stage 3-ALT, then 3b |
| **C · Self-hosted GoTrue** on the Stage-5 VPS | $0 | ~1 day + ops | one | Appendix D, early |

**Recommendation: path B if "$0" is a real requirement or Hetzner is a real
destination; path A if you would rather pay $120/year than add a vendor.** Path B
is the only one that satisfies "ideally free" literally, and the only one where
auth stops moving — Identity Platform does not care where Postgres lives, so the
eventual Hetzner migration never touches it.

Do not run 3a and 3-ALT both. Pick one.

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

---

## Stage 3-ALT — Auth on GCP Identity Platform (the free branded path)

*(Alternative to Stage 3a. Skip this if you took path A.)*

**Goal:** a branded consent screen on your own domain for **$0**, with auth
permanently decoupled from where the database lives. Free to 50,000 MAU for
tier-1 providers (email, phone, social); $0.0055/MAU from 50k–100k.

**Cost:** one forced re-login, now. Do it at the lowest user count you will ever
have.

### 3-ALT.1 Stand it up

1. Enable **Identity Platform** in a GCP project. Enable Email/Password and
   Google as providers.
2. Enabling it auto-creates a Firebase Hosting subdomain
   (`<project>.firebaseapp.com`) which handles OAuth redirects by default — and
   which is exactly the unbranded string you are trying to get rid of. So:
   connect a **custom domain** in the Firebase console (`auth.boardgamebuddy.com`),
   add it to **Authorized Domains** under Identity Platform → Identity providers,
   and update the Google OAuth client's redirect URI to
   `https://auth.boardgamebuddy.com/__/auth/handler`. Firebase Hosting's free tier
   covers this — it is serving one auth handler, not a site.
3. Configure the OAuth consent screen branding (name, logo, support email) and
   verify the domain in Google Search Console, same as Stage 3a.5.

### 3-ALT.2 Keep RLS working

**Wire Identity Platform into Supabase as a third-party auth provider.** Supabase
trusts externally-issued JWTs the same way it trusts its own, so the
`auth.uid()` predicates on the live play-session tables keep working and the
realtime spectator mirror is unaffected. Without this step they fail closed and
the spectator mirror goes blank — it is not optional. (The count here used to
read "3 policies"; the schema snapshot carries 12 `auth.uid()` predicates
across the session tables. Same conclusion, larger blast radius.)

**The dashboard setting is only half of it — the client has to send the token.**
`window.supabaseClient` must still be created after the swap, because Identity
Platform replaces Supabase *Auth*, not Supabase: `domain/live-scores.js` and
`domain/session-phase.js` subscribe to realtime channels and read and write the
live-session tables through that client directly. Both are written as
`if (!window.supabaseClient) return;`, so a build that stops creating it does
not error — live scores silently stop updating with nothing in the console.

`domain/auth.js#init` therefore creates it on both paths, and on the Firebase
path passes an `accessToken` callback instead of letting supabase-js own a
session:

```js
window.supabaseClient = window.supabase.createClient(url, anonKey, {
  accessToken: async () => {
    const user = firebase.auth().currentUser;
    return user ? await user.getIdToken() : null;
  },
});
```

Returning `null` when signed out rather than throwing is deliberate: reads fall
back to the anon key, which is what a spectator opening a public session link
needs.

**Check Supabase's TP-MAU (third-party monthly active user) billing line before
assuming $0 on the Supabase side.** Third-party auth is metered separately from
Supabase Auth MAU. This is the one number in this stage worth confirming against
the current pricing page rather than trusting this document.

### 3-ALT.3 Import the users

Supabase stores passwords as **bcrypt** in `auth.users.encrypted_password`.
Firebase's Admin SDK `importUsers()` accepts bcrypt hashes directly, so **nobody
has to reset a password**:

```js
await admin.auth().importUsers(
  users.map(u => ({ uid: u.id, email: u.email, passwordHash: Buffer.from(u.encrypted_password) })),
  { hash: { algorithm: 'BCRYPT' } }
);
```

**Preserve the UUIDs.** Pass Supabase's `auth.users.id` as Firebase's `uid`.
`boardgamebuddy_profiles.id` FKs `auth.users(id)`, and every play, buddy edge and
achievement hangs off that column — a regenerated id orphans the entire account.

The script is `tools/import-users-to-firebase.mjs`. It defaults to a dry run,
has a `--verify` pass that reads every uid back and fails on a mismatch, and
handles the case this snippet does not: a **Google account has no usable
password**, so it needs `providerData` carrying the Google `sub` or Firebase
mints a brand-new uid at first sign-in and orphans the profile just as surely
as a regenerated UUID would.

Then drop the FK, since `auth.users` is no longer the authority. That is
migration `036_drop_profiles_auth_users_fk.sql`, and it has to run BEFORE the
frontend swap: a user who signs up through Identity Platform has no
`auth.users` row, so the profile insert violates the constraint and signup
fails as a generic error.

Keep the column, the type, and every value.

**An earlier version of this section warned that dropping the FK loses the
`ON DELETE CASCADE` and that "account deletion becomes explicit backend work —
write it before you need it". That was wrong.** `DELETE /profile`
(`api/routes/profile_routes.py`) already deletes the *profile* row, and the ~20
child tables cascade from their own FKs to `boardgamebuddy_profiles(id)`. None
of it touches this constraint. What actually changes is that deleting a user
from the Supabase dashboard no longer removes their profile — and, after the
swap, that the identity record in Identity Platform survives an account
deletion, exactly as the `auth.users` row does today.

### 3-ALT.4 Change the code

**Neither half is a swap. Both providers stay live, selected at runtime.** A
swap has no rollback shorter than another deploy, and on the backend it 401s
every signed-in browser the moment it lands.

- **Frontend: one new module, `domain/auth.js`.** It presents `init`,
  `onChange`, `signInWithPassword`, `signUp`, `signInWithGoogle`, `signOut` and
  `refresh`, and picks Firebase or Supabase from whether `config.js` carries a
  complete `firebase` block — so rollback is flipping the `BGB_FIREBASE_*` repo
  variables off, and local dev (which has no Firebase config) keeps working.
  The six call sites in `init.js`, `views/auth-view.js` and `domain/api.js` go
  through it and know nothing about either provider.

  It publishes ONE session shape, `{ access_token, user: { id, email } }`,
  because that is what `domain/api.js#_authHeader` and `domain/outbox.js`
  already read off `window.session`. Three things needed real handling rather
  than a rename:

  - `domain/api.js`'s `getSession()` → `refreshSession()` ladder collapses to
    `refresh(true)`. The `force` is not optional: the token that just got a 401
    is the one Firebase would hand back from cache, so the retry would fail
    identically.
  - **Signup's "already registered" signal is completely different.** Firebase
    throws `auth/email-already-in-use`; Supabase *resolves* with a synthetic
    user carrying an empty `identities` array. `signUp` normalises both to an
    `existing` flag.
  - **Google sign-in uses `signInWithPopup`, not redirect.** With a custom
    `authDomain` the handler is on another origin, and `signInWithRedirect`
    needs to read state back from that origin's storage — which Safari's ITP
    and Firefox's total cookie protection block, returning the user to a
    signed-out app with no error. A popup runs that origin first-party and
    posts the credential back. Redirect stays as the fallback for a blocked
    popup.

  `views/auth-view.js` also maps Firebase's `auth/*` codes to plain sentences —
  its raw strings look like `Firebase: Error (auth/invalid-credential).` — with
  wrong-password and unknown-account deliberately sharing one message so the
  form is not an account-enumeration oracle.

- **Backend: one file, `jwt_auth.py`, verifying both issuers.** Select the
  verifier from the token's `iss`, then check the signature against that
  provider's JWKS: Supabase's with `aud=authenticated`, or Google's shared set
  (`https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`)
  with `aud` AND `iss` both scoped to `GCP_PROJECT_ID`.

  **Both claims are required, and this is the part to get right.** Every
  Firebase project signs with the same Google keys, so a verifier that checks
  the signature without a project-scoped `aud` accepts a token minted by
  anyone's free Firebase project — a full authentication bypass that passes a
  naive "valid signature" test. `tests/test_jwt_auth_dual_issuer.py` mints
  exactly that token and requires a 401.

  Reading `iss` unverified to route is safe *because* the selected verifier
  re-checks it under the signature. An unset `GCP_PROJECT_ID` answers 500, not
  401: it is an operator error, and 401 would send a correctly signed-in user
  to the login screen while hiding the cause.

  `role` has no Firebase equivalent, and grep across `api/` finds **nothing**
  reading it — this document previously said `routes/dependencies.py` does; it
  does not. BGB's admin check reads the profile row.
- Keep the `SupabaseUser` model shape, or the change leaks into 30 route files
  for no reason. Rename it later, separately, if at all.

### 3-ALT.5 Acceptance

- Consent screen reads "continue to **auth.boardgamebuddy.com**".
- An **existing** user signs in with their **existing** password — proves the
  bcrypt import worked.
- That user lands on their **own** profile with their real play count — proves
  the UUID survived. If it creates a fresh profile, stop and roll back.
- Join a live play session as a spectator and watch the grid update — proves the
  3 RLS policies still evaluate under a third-party JWT.
- A signed-in session survives an hour idle — proves the token-refresh path.
- Supabase usage report: confirm what the TP-MAU line actually bills.

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
2. Attach **a custom domain to each** — `img.bgbuddy.app` → `bgb-plays`,
   `covers.bgbuddy.app` → `bgb-games`. Two hostnames rather than one bucket
   with `plays/` and `games/` prefixes, and that is the decision in this stage
   most worth not reversing: a play photo is user content whose URL the privacy
   policy discloses as open to anyone holding the link, and the fix for that is
   signed URLs — i.e. taking the public domain off the plays bucket. Behind a
   shared hostname that fix costs a re-key and a second URL rewrite. Split, it
   costs a console change that never touches cover art.
   **Serve images from the R2 custom domain, not through Pages.** R2 is a paid
   product and is the clean way to push a lot of image bytes through
   Cloudflare; Cloudflare's terms have historically discouraged serving a
   disproportionate share of non-HTML content on free plans.
3. Create an R2 API token (Object Read & Write, scoped to those buckets).
4. Seven Railway variables, already documented in `ENV.md`: `R2_ACCOUNT_ID`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PLAYS_BUCKET`,
   `R2_GAMES_BUCKET`, `R2_PLAYS_PUBLIC_BASE`, `R2_GAMES_PUBLIC_BASE`.
   **Set them only once the buckets AND their custom domains resolve.** All
   seven are required per store; with any one missing the API goes on writing
   to Supabase Storage and says nothing, because that is the designed
   fallback.

### 4.3 Code — DONE, and what it actually looks like

`api/object_store.py` exists: 220 lines, `put()` and `public_url()`, `boto3`
against `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com` at region `auto`,
with `boto3>=1.36` in `requirements.txt` (1.36 is the floor because
`Config(request_checksum_calculation=…)` does not exist before it, and
botocore's default CRC32 on every PUT is worth turning off across
S3-compatible providers).

Both upload blocks now branch on `object_store.configured(kind)` and keep
every guard that was already there — the MIME allowlist, the 5 MiB cap, the
empty-file check, the `logger.warning` + `502`, and `_upload_to_storage`'s
fallback of returning the original BGG URL.

Three things the original sketch did not anticipate, all of which changed the
design:

**1. Unconfigured is a supported state.** The plan implied a cutover: code
ships, variables get set, Supabase Storage is dead. In practice the merge and
the console session are hours apart and a deploy is not something you hold. So
`configured()` answers False when the variables are absent and both call sites
use Supabase Storage exactly as before. That removes the ordering constraint
entirely and makes rollback "unset one variable", the same lever Stage 3-ALT
uses.

**2. A configured-but-failing R2 must NOT fall back.** The fallback is for an
absent R2, never a broken one. Falling back on error would write a
supabase.co URL into a play *after* `038` has rewritten every other row —
new data quietly landing back on the origin this whole stage exists to leave.
So a failing R2 is a 502 on the photo path and the untouched BGG URL on the
cover path. `tests/test_object_store.py` pins exactly this.

**3. Cache-Control differs per store, because the two path shapes differ.** A
photo path carries a uuid4, so its bytes never change: `max-age=31536000,
immutable`. A cover path is `{bgg_id}_{kind}.{ext}`, which a re-import
**overwrites in place** — a year-long TTL there would pin a stale cover in
every edge cache, so covers get `max-age=86400`. Supabase's upload accepts a
`cache-control` option too and neither call site ever passed one; the headers
go on the R2 branch only, so the fallback behaves exactly as it did before.

**Read path tolerates both.** Old rows hold `…supabase.co/storage/v1/…` URLs;
new rows hold `img.bgbuddy.app/…`. Both are absolute URLs the client just
loads, so nothing needs a code branch — but do not delete the Supabase buckets
until §4.5 confirms every row is rewritten. The buckets staying up *are* the
rollback.

### 4.4 Copy the objects

```
rclone copy supabase:boardgamebuddy-plays r2:bgb-plays --progress
rclone copy supabase:boardgamebuddy-games r2:bgb-games --progress
```

Then rewrite the stored URLs — three columns, one migration, which is written
and lives at `db/migrations/038_r2_photo_urls.sql`. **Edit the four prefixes at
the top before running it**; it refuses to run while a placeholder is still in
place, and the refusal survives a global find/replace (the guard looks for a
double underscore, not for the placeholder text, precisely so editing it the
obvious way does not neuter the check).

Two departures from the sketch above, both of which matter:

* `starts_with(col, prefix)`, not `col LIKE prefix || '%'`. A `LIKE` pattern
  reads `_` as a single-character wildcard, and a Supabase project ref or a
  path can carry one.
* `new || substr(col, length(old) + 1)`, not `replace(col, old, new)`.
  `replace()` substitutes *every* occurrence; this only ever rewrites the front
  of the string.

Run the `rclone copy` **before** the migration and re-run it after (it is
incremental) to catch uploads that landed mid-flight. Order matters: a rewritten
URL whose object has not copied yet is a broken image. The migration is
re-runnable — every UPDATE is guarded on the row still carrying the old prefix,
so a second run reports zero rows instead of double-rewriting.

Note that `boardgamebuddy_games.image_url` may also hold un-rehosted BGG URLs
(the `_upload_to_storage` fallback), and those must be left alone — the prefix
guards handle it.

### 4.5 Acceptance

- Upload a new play photo → the returned URL is on the R2 domain, and the image
  loads. This one is worth doing **before** the migration, with old rows still
  pointing at Supabase: new writes on R2 while old reads stay on Supabase is
  the expected intermediate state, and seeing it work is what says the
  variables are right before any row is rewritten.
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
