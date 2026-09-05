# BoardgameBuddy — Repo & Database Separation Scope

Scoping document for extracting BoardgameBuddy out of the `vibelab` monorepo into
its own repository, and (later, separately) off the shared Supabase database.

**Status:** proposal. Nothing here has been executed.

---

## 0. Recommendation in one paragraph

Do this as **two independent projects, months apart if you like**, not one.
Splitting the repo is mostly mechanical: BoardgameBuddy is already vertically
isolated — its own route package, its own `boardgamebuddy_` table prefix, its own
`bgb_` RPC prefix, its own Vercel project, its own bundle script. The shared code
it actually imports is ~825 lines of generic infrastructure that can be copied
wholesale. **Splitting the database is the expensive half**, and the cost is
concentrated in one place: `auth.users`. BoardgameBuddy shares Supabase Auth with
six other apps, so moving the data means moving the accounts, which means a new
Supabase project ref, a new JWKS, and every user signed out once. Do the repo
split first, keep pointing at the shared database, prove the new deploy pipeline
in production, and only then take on the database.

---

## 1. What BoardgameBuddy actually is today

| Surface | Location | Size |
| --- | --- | --- |
| Web app | `projects/boardgame-buddy/web/` | 129 JS files, ~75.5k lines JS/CSS/HTML, 4 MB with assets |
| Backend | `shared-backend/routes/boardgame_buddy/` | 60 Python files, ~16.1k lines (**43% of the entire shared backend**) |
| Tests | `shared-backend/tests/` | 7 files, ~1.6k lines — **all seven are BoardgameBuddy tests** |
| Migrations | `db/migrations/boardgamebuddy/` | 12 active files (~8.5k lines) + 73 archived |
| Schema/function docs | `db/schema/boardgamebuddy.sql`, `db/functions/boardgamebuddy.sql` | ~1.2k lines of inventory |
| Docs | `projects/boardgame-buddy/Docs/`, `STRUCTURE.md` | STRUCTURE.md alone is 181 KB |
| Database objects | 23 tables (`boardgamebuddy_*`), 58 RPCs (`bgb_*` + `boardgamebuddy_search_games`) | one Supabase Storage bucket, `boardgamebuddy-games` |
| Native app | — | does not exist yet (`hasNativeApp: false`, no `app/` dir) |

Roughly 89 of the repo's 146 commits touch BoardgameBuddy paths. `.git` is 6.7 MB
total, so history rewriting is cheap.

---

## 2. Coupling inventory

### 2.1 Code the backend borrows from `shared-backend/`

Seven modules, ~825 lines total, all generic infrastructure:

| Module | Lines | What BGB uses it for |
| --- | --- | --- |
| `db.py` | 23 | `get_supabase()` singleton (service-role client) — imported by ~20 BGB files |
| `jwt_auth.py` | 115 | Supabase JWT verification / JWKS fetch (`dependencies.py`, `profile_routes.py`) |
| `auth.py` | 57 | `create_token` / `decode_token` for buddy QR codes; `ADMIN_API_KEY`. The bcrypt half is legacy-password code BGB never touches |
| `cache.py` | 136 | In-process TTL cache (BGG client, game routes, sync progress) |
| `api_logger.py` | 259 | Writes `api_logs` rows for BGG external calls; `set_request_user` |
| `gemini.py` | 219 | Chapter drafting + play-import parsing |
| `shared_models.py` | 16 | `HealthResponse` |

**Nothing outside `routes/boardgame_buddy/` imports BoardgameBuddy code** except
`main.py` (router registration, OpenAPI tag, api-logger prefix map) and the test
suite. The dependency is entirely one-directional, which is what makes this easy.

### 2.2 Runtime / infrastructure

- **Railway:** one service for all ten apps, root dir `shared-backend`, deployed via
  Railway's native GitHub integration (`deploy-backend.yml` is just a notifier).
- **Vercel:** BGB already has its own project (`VERCEL_BOARDGAME_BUDDY_PROJECT_ID`)
  at `vibelab-boardgamebuddy.vercel.app`. `web/build.sh` generates `config.js` from
  `API_BASE` / `SUPABASE_URL` / `SUPABASE_ANON_KEY`.
- **GitHub Actions:** `deploy-frontend.yml` and `deploy-frontend-all.yml` each carry
  three `if: matrix.project == 'boardgame-buddy'` steps — Tailwind/DaisyUI precompile,
  JS/CSS bundle+minify via `.github/scripts/bgb-bundle.mjs` (enforces a 450 KB gzip
  budget), and service-worker build-id stamping. `supabase-keepalive.yml` pings
  `boardgamebuddy_games`.
- **Env vars** (all in `ENV.md`): `BGB_QR_SECRET`, `BGG_API_TOKEN`,
  `BGG_CREDENTIAL_KEY`, `BGG_PUSH_DRY_RUN`, `BGG_WEB_USER_AGENT`,
  `BGG_THROTTLE_SECONDS`, `BGG_PUSH_THROTTLE_SECONDS`, plus shared
  `GEMINI_API_KEY` (also used by Travel Trove), `SUPABASE_*`, `ALLOWED_ORIGINS`,
  `ADMIN_API_KEY`.
- **requirements.txt:** BGB needs fastapi, uvicorn, supabase, httpx, PyJWT,
  cryptography, truststore, python-dotenv, python-multipart. It can drop
  `recipe-scrapers`, `ingredient-parser-nlp` (a heavy NLP dep), `beautifulsoup4`
  and `bcrypt` — all sauceboss/legacy. Smaller image, faster cold boot.
- **Landing page:** `landing/registry.json` entry, a brand mapping in
  `landing/app.js`, and a bundled copy of `bgb-hero.svg`.
- **Local dev:** `local_dev/setup-local.py` fans `config.js` out to every project.
- **Claude context:** root `CLAUDE.md`, `.claude/rules/*` (1,781 lines — BGB relies on
  web-frontend, theming, overlays, ui-object-design, typed-js, mobile-web, assets,
  auth-ui, backend-python, database-supabase, performance-caching).

### 2.3 Shared database objects

This is the list that matters for Phase 2:

| Object | How BGB depends on it |
| --- | --- |
| `auth.users` | `boardgamebuddy_profiles.id` is a FK to it, `ON DELETE CASCADE`. Shared with six other apps. |
| `auth.uid()` | Used in the RLS policies on the two tables the web client reaches directly |
| `supabase_realtime` publication | `boardgamebuddy_play_sessions` + `_play_session_scores` are published for live-session sync |
| `boardgamebuddy_role` | Per-project read-only login role, created by the baseline and password-set by `_shared/003_project_roles.sql` |
| `analytics_events` | The web app fire-and-forgets to `/api/v1/analytics/track` |
| `api_logs` | Every BGG outbound call and the boot-critical self-timing rows |
| Admin RPCs | The vibelab admin dashboard's storage view groups tables by prefix; user management reads `boardgamebuddy_profiles` + `auth.admin` via `APPS_WITH_USERS` |
| Storage bucket `boardgamebuddy-games` | Mirrored BGG tile art; `image_url` columns store **absolute** public URLs containing the project ref |

**Important nuance:** the web client uses supabase-js for **auth and realtime only**.
All data reads/writes go through the FastAPI service on the service-role key. Only
`boardgamebuddy_play_sessions` and `boardgamebuddy_play_session_scores` have real
RLS policies and Data API grants. That significantly narrows the blast radius of a
database move.

---

## 3. Phase 1 — Repo separation

**Goal:** `boardgame-buddy` is a standalone repo with its own CI, its own Railway
service and its own Vercel project, still reading and writing the *existing* shared
Supabase database. No data migration, no user-visible change, instant rollback.

### 3.1 Target layout

```
boardgame-buddy/
├── CLAUDE.md                    ← distilled from vibelab CLAUDE.md + STRUCTURE.md
├── .claude/rules/               ← copied subset (drop react-native until app/ exists)
├── web/                         ← verbatim from projects/boardgame-buddy/web/
├── api/
│   ├── main.py                  ← new, ~60 lines: CORS, gzip, APIError handler,
│   │                              api-logger middleware, self-timing, health
│   ├── db.py auth.py jwt_auth.py cache.py api_logger.py gemini.py shared_models.py
│   ├── routes/                  ← from routes/boardgame_buddy/ (see note below)
│   ├── tests/                   ← all 7 test files move
│   ├── requirements.txt         ← trimmed
│   ├── railway.toml, Procfile
├── db/
│   ├── migrations/              ← 001–012 + archive/ + the _shared bits BGB needs
│   ├── schema/boardgamebuddy.sql
│   └── functions/boardgamebuddy.sql
├── docs/                        ← ARCHITECTURE.md, UI_AUDIT.md, mocks/, release notes
└── .github/
    ├── workflows/deploy-web.yml, keepalive.yml
    └── scripts/bgb-bundle.mjs
```

**Do not rename anything on the wire in this phase.** Keep the
`/api/v1/boardgame_buddy/...` URL prefix and the `boardgamebuddy_` / `bgb_` database
prefixes exactly as they are — the frontend has those paths hard-coded in ~129 files
and the database is unchanged. Directory flattening and prefix cleanup are a separate,
optional follow-up once the split is proven.

### 3.2 Work items

| # | Item | Notes | Rough size |
| --- | --- | --- | --- |
| 1 | Create repo, extract history | `git filter-repo --path projects/boardgame-buddy --path shared-backend/routes/boardgame_buddy --path shared-backend/tests --path db/migrations/boardgamebuddy ...` with `--path-rename` to the new layout. Preserves blame across 89 commits. | S |
| 2 | Copy the 7 shared infra modules | Verbatim copy; delete the bcrypt helpers in `auth.py`. Accept that they now fork from vibelab's copies. | S |
| 3 | Write the new `api/main.py` | Strip the nine other routers, the sauceboss registry loaders, and the multi-app prefix map down to one app. | S |
| 4 | Trim `requirements.txt` | Drops recipe-scrapers + ingredient-parser-nlp + bs4 + bcrypt | S |
| 5 | New Railway service | Point at `api/`, copy the BGB env vars + `SUPABASE_URL`/service key from the existing service. New public URL. | S |
| 6 | New CI workflows | Single-project deploy (no matrix, no `if: matrix.project ==` guards); port the Tailwind precompile, `bgb-bundle.mjs`, SW stamping steps as unconditional steps. Add a `pytest` job — the tests currently run nowhere in CI. | M |
| 7 | Vercel | Either re-point the existing project at the new repo (keeps the URL and any custom domain) or create a new one and update DNS. | S |
| 8 | `ALLOWED_ORIGINS` | Set on the new Railway service. Leave BGB's origin on the old service during the overlap. | S |
| 9 | `CLAUDE.md` + rules | Distil the monorepo instructions to one app. Split the 181 KB `STRUCTURE.md` — it violates the repo's own ~300-line rule by two orders of magnitude and is expensive to load every session. | M |
| 10 | Cutover | Flip `API_BASE` in `web/build.sh` to the new Railway URL, deploy, watch. Both services can serve the same database simultaneously, so rollback is one env var. | S |
| 11 | Clean up vibelab | See 3.4. | M |

### 3.3 Cutover sequence (zero downtime)

1. New repo + new Railway service live, same database, not yet receiving traffic.
2. Smoke-test the new API directly (health, `/bootstrap`, a feed page, a BGG search).
3. Deploy the frontend from the new repo to a Vercel preview pointed at the new API.
4. Flip production `API_BASE` to the new service.
5. Watch `api_logs` and the boot-critical timing rows for a day.
6. Remove the BGB router from vibelab's `main.py`, delete the route package, tests,
   and project dir; keep the database untouched.

Rollback at any point before step 6 is a single env-var flip.

### 3.4 What has to change in vibelab afterwards

- `shared-backend/main.py` — drop the import, the OpenAPI tag, the prefix-map entry, the `include_router`
- `shared-backend/routes/boardgame_buddy/` — delete (16k lines)
- `shared-backend/tests/` — becomes empty; either delete or leave a README noting the suite moved
- `.github/workflows/deploy-frontend*.yml` — remove the three BGB-only steps from both
- `.github/scripts/bgb-bundle.mjs` — delete
- `.github/workflows/supabase-keepalive.yml` — repoint the ping at another app's table
- `landing/registry.json` — keep the entry (it's just a link) but note the app is externally hosted
- `ENV.md` — move the seven BGB/BGG vars to the new repo's ENV doc; keep `GEMINI_API_KEY` in both
- `shared-backend/routes/admin.py` — `APPS_WITH_USERS` entry still works in Phase 1 (same DB); it breaks in Phase 2
- `CLAUDE.md`, `db/migrations/README.md`, `.claude/rules/*` — remove BGB examples

**Watch out:** `gemini.py`'s module docstring references BGB paths, and
`db/migrations/_shared/003_project_roles.sql` names `boardgamebuddy_role`. Both stay
valid in Phase 1 (the database is shared) and need revisiting in Phase 2.

---

## 4. Phase 2 — Database separation

**Goal:** BoardgameBuddy runs on its own Supabase project.

### 4.1 The crux: shared Supabase Auth

`boardgamebuddy_profiles.id` is a FK into `auth.users`, and seven apps share that
table. There is no clean way to keep the accounts where they are and move only the
data:

- A second Supabase project cannot point its GoTrue at another project's user store.
- Verifying the *old* project's JWTs in the new backend is possible (just fetch the
  old JWKS) — but **Realtime on the new project would reject those tokens**, and BGB's
  live-session sync depends on Realtime. That kills the hybrid.

So the accounts move with the data. Concretely:

1. New Supabase project. Rebuild the schema by replaying
   `001_baseline.sql` → `002_seed.sql` → `003_rpcs.sql` → `004`–`012` plus the
   `_shared` pieces BGB needs (`003_project_roles.sql`, and `api_logs`/`analytics`
   if you keep them). The baseline is explicitly a fresh-DB rebuild, generated by
   replaying the 73 archived migrations — **this is the single biggest asset in the
   whole plan.** The realtime publication setup is already idempotent in it.
2. Copy `auth.users` + `auth.identities` for the BGB cohort only (users who have a
   `boardgamebuddy_profiles` row). `pg_dump` of the auth schema subset preserves
   bcrypt password hashes and OAuth provider ids, so Google sign-in keeps working —
   but the Google OAuth client needs the new project's callback URL added, and every
   existing session is invalidated (the JWT signing key changes). **Everyone gets
   signed out once.** Plan the announcement.
3. Copy the 23 data tables in FK order. At ~current scale this is a `pg_dump`/`psql`
   of a few tables, not a streaming migration.
4. Copy the `boardgamebuddy-games` Storage bucket. `image_url` columns hold
   **absolute** URLs containing the old project ref, so either rewrite them with an
   UPDATE after the copy, or re-mirror from BGG. Rewriting is the cheap option.
5. Re-point the new Railway service's `SUPABASE_URL` / service key, and the frontend's
   `SUPABASE_URL` / anon key.
6. Freeze writes during the copy. Realistically a short maintenance window (tens of
   minutes) rather than a live dual-write; the app has no SLA that justifies more.

### 4.2 What the vibelab admin dashboard loses

After the split, BoardgameBuddy disappears from vibelab's admin tooling: user
management (`APPS_WITH_USERS`), the storage-by-prefix view, `analytics_events`, and
`api_logs`. Three options, pick one before starting Phase 2:

- **(a) Self-contained** *(recommended)* — duplicate `analytics_events` and `api_logs`
  into BGB's own database and grow BGB's existing in-app admin screens
  (`admin-reports-view`, `admin-backfill-view`, `admin-gate.js` are already there).
  One more surface to maintain, zero cross-repo coupling.
- **(b) Keep reporting home** — leave the analytics ping and api-logger writing to
  vibelab's backend cross-origin. Needs a CORS entry and keeps a permanent tether.
- **(c) Accept the loss** — cheapest, and honest if the dashboard isn't actually load-bearing.

### 4.3 Other Phase 2 details

- `boardgamebuddy_role` moves with the baseline; regenerate its password.
- The keepalive ping needs to run against the new project too (free-tier pausing).
- RLS: only the two session tables have real policies. Verify them against the new
  `auth.uid()` after the auth copy — a silently-failing policy shows up as an empty
  live-score grid, not an error.
- The 58 RPCs come across with `003_rpcs.sql`; diff the deployed set against
  `db/functions/boardgamebuddy.sql` **before** the move, since that inventory is
  hand-maintained and may have drifted.

---

## 5. Risks

| Risk | Phase | Mitigation |
| --- | --- | --- |
| Shared infra modules fork and drift | 1 | Accept it. They're 825 lines of stable glue; a shared package isn't worth the release overhead for one consumer. |
| A BGB path is referenced somewhere unaudited | 1 | The grep sweep in §2 found only `main.py`, the tests, a `gemini.py` docstring, the workflows and the landing page. Re-run it at cutover. |
| Vercel URL change breaks installed PWAs | 1 | Keep the existing Vercel project and URL; re-point its git source instead of creating a new one. |
| Everyone signed out | 2 | Unavoidable. Announce it; make sure the re-login path (Google + email) is tested against the new project first. |
| Google OAuth breaks | 2 | New callback URL in Google Cloud console before cutover; test with a throwaway account. |
| Storage URLs point at the dead project | 2 | Post-copy `UPDATE` rewriting the project ref in `image_url`; the mirror-from-BGG path is the fallback. |
| Migration inventory drift | 2 | Diff live schema/functions against `db/schema` + `db/functions` before the copy. |
| Losing admin visibility silently | 2 | Decide 4.2 up front, not after. |

---

## 6. Open questions

1. **Domain** — does BoardgameBuddy get a real domain as part of this, or stay on
   `vibelab-boardgamebuddy.vercel.app`? A domain change is much cheaper to do at the
   same time as the Vercel re-point than separately.
2. **Vercel project** — re-point the existing one (keeps URL, keeps installed PWAs) or
   start fresh?
3. **Landing page** — keep the BoardgameBuddy card in the vibelab registry, or does the
   app stop being presented as part of the lab?
4. **Admin dashboard** — which of 4.2 (a)/(b)/(c)?
5. **History** — preserve the 89 commits via `filter-repo` (recommended, cheap at this
   repo size), or start the new repo with a single import commit?
6. **User count** — how many `boardgamebuddy_profiles` rows are there today? Under a few
   hundred, the Phase 2 copy is a `pg_dump` and a coffee; that number decides whether a
   maintenance window is acceptable.
7. **Timing** — is Phase 2 driven by something concrete (cost, blast radius, a native app,
   an eventual handover), or is it "eventually"? If eventually, Phase 1 alone gets most of
   the benefit and none of the risk.

---

## 7. Suggested order

1. Answer §6 questions 1–3, 5.
2. Phase 1, items 1–4 (extraction) — one PR in the new repo.
3. Phase 1, items 5–8 (infrastructure) — new Railway service + CI, nothing user-visible.
4. Phase 1, item 10 (cutover) — flip `API_BASE`, soak for a day.
5. Phase 1, item 11 (vibelab cleanup) — one PR in vibelab.
6. Live on the split repo for a while. Confirm the pipeline is comfortable before touching data.
7. Answer §6 questions 4, 6, 7.
8. Phase 2 rehearsal — build a throwaway Supabase project from the migrations, copy a
   snapshot into it, point a local frontend at it, sign in. This rehearsal is what makes
   the real cutover boring.
9. Phase 2 cutover in a maintenance window.
