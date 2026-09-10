# BoardgameBuddy — Production Deployment Strategy

> Decision document. Written 2026-09-10 against the app as it stands at
> `9a6d60b`. Prices verified against vendor pages and pricing trackers the same
> day; every one of them is a moving target, and the Hetzner numbers moved twice
> in 2026 — re-check before signing up for anything.

---

## 1. What is actually deployed today

| Tier | Where | What it is | Bill today |
|---|---|---|---|
| Web app | Vercel (Hobby), deployed by `deploy-frontend.yml` | 67k lines of vanilla JS, bundled + minified at deploy to one ~215 KB gzipped file; installable PWA with a service worker | $0 |
| API | Railway, one shared FastAPI service for all 9 monorepo apps | 18k lines of Python in `shared-backend/routes/boardgame_buddy/` | ~$5 |
| Database | Supabase Postgres (Free), one project shared by all 9 apps, tables prefixed `boardgamebuddy_*` | 23 migrations, **60 Postgres functions**, 4 RLS policies | $0 |
| Auth | Supabase Auth — email/password + Google OAuth | Client-side via the Supabase JS SDK; backend verifies the JWT against cached JWKS | $0 |
| Photos | Supabase Storage, two buckets (play photos, BGG cover cache) | Client pre-resizes to 1600 px @ q0.82 (~300 KB), strips EXIF, 5 MiB hard cap | $0 |
| Push | Self-hosted Web Push (VAPID) | No vendor | $0 |
| Cron | GitHub Actions | Keep-alive ping every 2 days so the free Supabase project doesn't auto-pause | $0 |
| LLM | Gemini free tier | Chapter drafting, play-note import | $0 |

**Total today: about $5/month.** That is the number every option below has to be
compared against, and it is why nothing here is going to look "cheap".

### The couplings that decide how expensive a move is

Two numbers matter more than any price on this page:

- **199 `sb.table(...)` calls and 55 `.rpc(...)` calls** in the BGB route
  package. The backend talks to Postgres through **PostgREST**, not SQL. Any
  move to a plain Postgres (Cloud SQL, RDS, a Postgres you run yourself
  *without* PostgREST) is not a config change — it is a rewrite of every data
  access path in the app.
- **60 Postgres functions.** These are portable to *any* Postgres, and they are
  where the app's hard logic lives (`bgb_log_play`, `bgb_profile_bundle`,
  `bgb_user_stats`). They are an argument for staying on Postgres forever, and
  no argument at all about *whose* Postgres.

By contrast the things people assume are hard are cheap here:

- **Photos: 2 call sites.** `play_routes.py:516` and `game_routes.py:95` upload;
  `get_public_url` derives the URL twice. Moving object storage is a day's work.
- **Static hosting: zero code.** The deploy artifact is static files. The host
  is a line in a workflow.

---

## 2. The two things actually forcing this decision

Neither is a hosting problem, and it is worth separating them from the hosting
question before spending money.

### 2a. Branded auth

The problem is real and specific: with Supabase Auth, Google's consent screen
reads **"continue to `<project-ref>.supabase.co`"**, because that is the host of
the OAuth redirect URI. Supabase's own docs name this as the reason custom
domains exist. Auth emails have the same problem — they come from Supabase's
shared sender.

Three ways to fix it, in ascending cost:

1. **Google brand verification, $0.** Configure name + logo under Branding in
   the Google Auth Platform console and verify the domain in Search Console.
   This fixes the *app name* on the consent screen. Takes a few business days
   and does not change the host string.
2. **Supabase custom domain add-on, $10/month per project.** Points
   `auth.boardgamebuddy.com` at the Supabase project, so the consent screen and
   every auth link is on your domain. This is the intended fix and it is the
   whole answer.
3. **Move auth to GCP Identity Platform, $0 up to 50k MAU** (tier-1 providers:
   email, phone, social; $0.0055/MAU from 50k–100k). Branded because the auth
   handler sits on your own Firebase Hosting domain. Supabase stores passwords
   as **bcrypt**, which Firebase's `importUsers` accepts directly, so a
   migration would not force password resets.

**Branded auth does not require moving to GCP.** It costs $10/month where you
already are. Option 3 is worth knowing about, but as a *later, separate* choice —
it is not a reason to move the database or the API.

### 2b. Monetization

This one is a hard blocker and you read it correctly. Vercel's Hobby plan
prohibits commercial use; revenue means **Vercel Pro at $20/seat/month**. But the
alternative is not "pay Vercel" — it is **Cloudflare Pages, which is free,
allows commercial use, and has no bandwidth cap at all**. For a bundle of static
files with a service worker, Vercel is providing nothing Pages doesn't.

So: dropping Vercel unblocks monetization and *saves* $20/month versus complying
on Vercel. That decision is independent of everything else on this page and you
should make it regardless of which option you pick.

One more monetization note: BoardgameBuddy has **no `app/` directory** — it is a
PWA, not a native app. Stripe takes ~3%; the App Store and Play would take 15–30%
of subscriptions. Staying a PWA is currently worth more than a native app is.

---

## 3. What actually scales with users in *this* app

This app is a photo feed. That single fact decides the cost comparison, so it is
worth making the numbers explicit before comparing vendors.

Per-user-per-month assumptions (derived from the code, not from a spreadsheet):

| Quantity | Value | Where it comes from |
|---|---|---|
| Photo size | ~300 KB | `PHOTO_IMPORT_OPTS`: 1600 px long edge, quality 0.82 |
| Plays logged | 6/month, photo on ~half | Estimate |
| **New storage** | **~0.9 MB/user/month** | 3 photos × 300 KB |
| Feed photos viewed | ~900/month | ~20 sessions × ~30 cards |
| **Image egress** | **~270 MB/user/month** | 900 × 300 KB |
| API JSON to client | ~10 MB/month | `/feed`, `/bootstrap`, gzipped |
| App shell | ~2 MB/month | 215 KB gzip, service-worker cached |

**Image bytes are ~93% of all egress.** Whoever charges you for egress is the
provider that decides your bill. That is the entire analysis in one line:

| Provider | Egress price | 3 TB/month (10k MAU) costs |
|---|---|---|
| Cloudflare R2 / Pages | **$0.00/GB** | **$0** |
| Hetzner (VPS traffic / Object Storage) | €0 up to 20 TB / €1.00 per TB | ~$0 |
| Supabase | 250 GB included, then $0.09/GB | ~$248 |
| GCP Cloud CDN | $0.08/GB (+$0.0075/10k lookups) | ~$247 |
| GCP direct internet egress | $0.12/GB | ~$360 |

Storage itself barely matters — a thousand users for a year is ~11 GB. **Egress
is 20–100x the storage cost at every scale.** A plan optimized for "plenty of
free storage" that ignores egress optimizes the wrong number; R2 happens to win
both (10 GB free, then $0.015/GB, egress never billed).

Two secondary limits worth knowing now:

- Supabase Free is **500 MB database + 5 GB egress**. At ~15 MB/user/month of
  Postgres→backend traffic, **the free tier's egress cap breaks at roughly 300
  monthly users** — before the size cap does, and long before the 50k MAU auth
  cap. Free tier is not a plan for a launch; it is a plan for today.
- Free Supabase projects **auto-pause after 7 days idle**, which is why
  `supabase-keepalive.yml` exists. That workflow disappears the moment you're on
  Pro, and it should — a paid project doesn't pause.

---

## 4. The four options

Costs below are all-in monthly, at 100 / 1,000 / 10,000 monthly active users,
using §3's traffic model and 12 months of accumulated photos at that scale.

### Option A — Stay where you are, made legal and branded

Vercel Pro + Railway + Supabase Pro + custom domain.

| | 100 MAU | 1k MAU | 10k MAU |
|---|---|---|---|
| Vercel Pro (1 seat) | $20 | $20 | $20 |
| Railway (Hobby → usage) | $5 | $10 | $25 |
| Supabase Pro | $25 | $25 | $25 |
| Supabase custom domain | $10 | $10 | $10 |
| Supabase egress over 250 GB | $0 | $5 | **$248** |
| Supabase storage over 100 GB | $0 | $0 | $0 |
| **Total** | **$60** | **$70** | **$328** |

**Zero migration work.** Also the option that pays $20/month for a static file
host and lets Supabase meter every photo view. Fine as a stopgap; a bad
destination.

### Option B — Fully self-hosted on Hetzner

One VPS running FastAPI + Caddy + Postgres + the **self-hosted Supabase stack**
(GoTrue, PostgREST, Storage). That last part is the key insight for this option:
self-hosting *Supabase* rather than self-hosting *Postgres* means the 199
PostgREST calls, 55 RPC calls, the Auth SDK and the Storage SDK all keep working
untouched. Full self-hosting is only viable here because of it.

| | 100 MAU | 1k MAU | 10k MAU |
|---|---|---|---|
| VPS (shared vCPU, 4 GB → 8 GB → 16 GB) | ~€6 | ~€9 | ~€20–30 |
| Snapshots + offsite Storage Box (1 TB) | ~€5 | ~€5 | ~€5 |
| Object Storage (1 TB + 1 TB egress incl.) | €5 | €5 | €5 + ~€2 egress |
| **Total** | **~€16 (~$18)** | **~€19 (~$21)** | **~€35 (~$39)** |
| **Plus: your time** | 3–6 h/month | 3–6 h/month | 6–10 h/month |
| **Plus: one-time setup** | 20–40 hours | | |

**Genuinely the cheapest at every scale, and the curve is nearly flat** — 20 TB
of traffic is included with the server. It is also the only option where you own
Postgres backups and PITR, TLS renewal, GoTrue upgrades, disk-full at 2am, and
the fact that there is exactly one machine.

Two caveats specific to 2026: Hetzner raised cloud prices on **April 1 and again
on June 15**, with shared-vCPU plans up 30–38% and **dedicated-vCPU plans up
113–175%** (CCX13 €15.99 → ~€43). And in early September 2026 several
shared-vCPU lines were showing as *unavailable* on hetzner.com. The "Hetzner is
4x cheaper" reflex is still true for shared vCPU and no longer true for
dedicated. Verify current prices and availability before planning around them.

### Option C — Fully on GCP

Cloud Run + Cloud SQL + GCS/Cloud CDN + Identity Platform.

| | 100 MAU | 1k MAU | 10k MAU |
|---|---|---|---|
| Cloud Run, 1 vCPU/512 MB, **min-instances=1** | ~$42 | ~$42 | ~$60 |
| Cloud SQL Postgres (db-f1-micro + 20 GB SSD) | ~$15 | ~$15 | ~$55 (real instance) |
| GCS storage | $0.02 | $0.22 | $2.20 |
| Cloud CDN egress + lookups | ~$2.50 | ~$25 | ~$254 |
| Identity Platform (≤50k MAU) | $0 | $0 | $0 |
| **Total** | **~$60** | **~$82** | **~$371** |
| **Plus: migration** | **3–6 weeks** | | |

Four things make this the worst fit, in order of severity:

1. **Egress pricing is exactly backwards for a photo feed.** $0.08/GB via CDN,
   $0.12/GB direct. GCP also doubled peering/CDN-interconnect egress rates on
   2026-05-01 — direct-to-user rates were untouched, but the direction of travel
   is not your friend.
2. **The rewrite.** 199 PostgREST calls and 55 RPC calls have to become SQL (or
   you run PostgREST yourself on GCP, at which point you are self-hosting
   Supabase on the most expensive infrastructure in this document).
3. **Cloud Run's economics fight this app.** The backend keeps in-process
   per-worker caches (`cache.py`, the 60 s profile cache, cached JWKS) and fires
   `BackgroundTasks` after responses — 18 call sites. Scale-to-zero drops
   in-flight background work and cold-starts every cache. So you set
   `min-instances=1` and pay ~$42/month for what Railway does for $5.
4. **Cloud SQL's cheap tier isn't a production tier.** db-f1-micro is
   shared-core, carries **no SLA**, and is ineligible for committed-use
   discounts. The first real instance is ~$50/month.

The one genuine GCP win — **Identity Platform, free to 50k MAU, branded** — is
available à la carte without any of the above.

### Option D — Price-optimized combination ✅

Put each workload on the provider that prices it at zero, and leave the
hard-to-migrate parts where the code already works.

| Concern | Where | Why |
|---|---|---|
| Static web app | **Cloudflare Pages** | Free, **commercial use allowed**, unlimited bandwidth, free custom domain + TLS. Replaces Vercel with no code change. |
| Photos + cover cache | **Cloudflare R2** | 10 GB free forever, then $0.015/GB, **$0 egress, ever**. 2 upload call sites to change. |
| API | **Railway** now → **Hetzner VPS** later | $5 covers 100–1,000 users. Move when the bill or the cold starts hurt, not before. |
| Postgres + Auth + RLS | **Supabase**, + custom domain | Keeps 199 PostgREST calls, 55 RPCs, 60 functions and the Auth SDK working. $10 buys the branded consent screen. |
| Push, LLM | unchanged | Already free and self-hosted / free-tier. |

| | 100 MAU | 1k MAU | 10k MAU |
|---|---|---|---|
| Cloudflare Pages | $0 | $0 | $0 |
| Cloudflare R2 (10 GB free) | $0 | $0.02 | $1.50 |
| Railway → Hetzner | $5 | $10 | ~€9 (~$10) |
| Supabase (Free → Pro) | $0 | $25 | $25 |
| Supabase custom domain | $10 | $10 | $10 |
| Supabase egress over 250 GB | $0 | $0 | $0 (images bypass it) |
| **Total** | **$15** | **$45** | **~$47** |

**The curve is flat from 1,000 to 10,000 users**, because the only thing growing
— image bytes — is billed at zero. Compare the same growth on Option A ($70 →
$328) or Option C ($82 → $371).

On image variants: the client already resizes to 1600 px before upload, so serve
originals and skip Cloudflare Images entirely ($0). If you later want proper
`srcset` thumbnails, generate the second size **client-side at upload** rather
than paying per transformation — Images gives 5,000 unique transformations free
per month, then $0.50/1,000, and at 10k MAU you'd be minting ~30k new photos a
month.

---

## 5. Recommendation

**Take Option D, in four phases, and treat Option B as its destination rather
than its rival.**

The reasoning in three lines:

- **GCP is the wrong platform for this specific app.** Its egress pricing is the
  most expensive in the comparison for the one resource this app spends, its
  serverless model fights the backend's in-process caches and background tasks,
  and reaching it means rewriting 254 data-access call sites. The one thing you
  wanted from it — branded auth — costs $10/month where you already are.
- **Full Hetzner is right, and it is too early.** It wins on price at every
  scale and stays flat, and self-hosting the *Supabase stack* (not bare Postgres)
  means it costs almost no code. But today it would save ~$25/month in exchange
  for you personally owning Postgres backups and auth uptime before there are
  users. Buy that trade when Supabase's bill passes ~$100/month, which is where
  4–6 hours of monthly ops starts paying for itself.
- **The high-value moves are cheap and independent.** Vercel → Pages unblocks
  monetization and saves $20/month. Supabase Storage → R2 removes the only cost
  line that grows with success. Neither touches the database, the auth, or the
  60 Postgres functions.

### Phasing

> Step-by-step execution of these phases — file manifests, workflow diffs, cutover
> order, acceptance criteria and rollback per stage — is in
> [`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md), written to be pasted one stage at a
> time into a fresh session. Its Appendix D covers what full Hetzner would take.

**Phase 0 — Extract the repo (§6). No cost change.** Do this first; every later
phase is easier from a standalone repo.

**Phase 1 — Get branded and legal. ~$15/month.**
- Buy the domain (Cloudflare Registrar sells at cost); DNS on Cloudflare.
- Deploy the existing bundle to **Cloudflare Pages**; point the apex at it.
  Delete the Vercel project and its four GitHub secrets. *Monetization unblocked.*
- Buy the **Supabase custom domain add-on ($10)**; move OAuth redirect URIs to
  `auth.boardgamebuddy.com`; verify the domain and upload a logo in the Google
  Auth Platform console. *Branded consent screen done.*
- Set **custom SMTP** on Supabase (Resend's free tier is 3k emails/month; SES is
  $0.10/1k). Supabase's built-in mailer is rate-limited for development and
  sends from a shared address — branded auth means branded email too, and this
  is the half people forget.
- Move to **Supabase Pro ($25)** when the DB passes ~400 MB or egress passes
  ~4 GB/month, whichever comes first. Leave the Spend Cap **on**. Delete
  `supabase-keepalive.yml` — paid projects don't pause.

**Phase 2 — Move photos to R2. ~$0/month, and it is the phase that pays.**
- Two upload call sites, one URL-derivation helper, one bucket policy, an R2
  custom domain (`img.boardgamebuddy.com`), a one-time `rclone` copy of existing
  objects, and a migration rewriting stored `photo_url` values. Serve images
  from the **R2 custom domain**, not from Pages — R2 is a paid product and is
  the clean way to serve a lot of image bytes through Cloudflare.
- After this, no cost line in the system grows with photo traffic.

**Phase 3 — Move the API to a Hetzner VPS. When Railway's bill or its cold
starts justify it.** Docker + uvicorn + Caddy behind Cloudflare, on a
shared-vCPU CX-class box. Cheap, reversible, and it does not touch the database.

**Phase 4 — Self-host the Supabase stack. Only past ~$100/month of Supabase
bill.** Postgres + GoTrue + PostgREST + Storage on the same (bigger) Hetzner
box, with `pgBackRest` or `wal-g` shipping WAL to a Storage Box and a restore
you have *actually rehearsed*. This is Option B, arrived at with users already
on the app and every other variable already settled. If you ever want to split
auth back out instead, GCP Identity Platform is free to 50k MAU and imports your
bcrypt hashes without password resets.

### What I would not do

- Don't buy Vercel Pro. It is $20/month for something Pages does free.
- Don't put Postgres on Cloud SQL. It costs more than Supabase Pro, has no SLA
  at the cheap tier, and breaks 254 call sites on the way in.
- Don't move auth in the same change as anything else. It is the one migration
  that can lock users out, and it is independently reversible only if it's alone.
- Don't self-host before Phase 2. Owning backups is a real job; take it on when
  the savings are real.

---

## 6. Extracting BoardgameBuddy from the monorepo

The extraction is mostly mechanical. What comes along:

**Backend** — `shared-backend/routes/boardgame_buddy/` (18k lines) plus the
shared modules it imports, all small and all copyable rather than shareable:

| Module | Lines | Note |
|---|---|---|
| `db.py` | 23 | Supabase client singleton |
| `jwt_auth.py` | 115 | JWKS verification |
| `cache.py` | 136 | In-process per-worker cache |
| `api_logger.py` | 259 | Writes `api_logs`; keep or drop |
| `gemini.py` | 219 | Shared LLM caller |
| `auth.py` | 57 | Admin bearer token |
| `shared_models.py` | 16 | `HealthResponse` |
| `main.py` | 253 | Rewrite: one router, not nine |

Total shared surface is ~1,078 lines. Copy them into the new repo's root; do not
try to publish them as a package for one consumer.

**Frontend** — `projects/boardgame-buddy/web/` verbatim, plus the two deploy-time
build steps from `deploy-frontend.yml` that the app genuinely depends on:
`.github/scripts/bgb-bundle.mjs` (121 script tags → 1 hashed file, with the
450 KB gzip budget gate) and the Tailwind precompile. Neither is optional — the
checked-in `index.html` deliberately keeps the CDN pair for local dev.

**Database** — this is the only interesting decision. Today one Supabase project
holds all nine apps' tables. Options:

1. **Leave the tables where they are** and point the extracted app at the same
   project. Zero migration; BGB's traffic and the monorepo's stay coupled on one
   bill and one instance.
2. **New Supabase project, own tables** (recommended). `pg_dump` the
   `boardgamebuddy_*` tables plus the 60 functions plus `auth.users`, restore
   into a fresh project. Supabase Free allows 2 active projects, so this costs
   nothing to stage. The 23 migrations already live in their own
   `db/migrations/boardgamebuddy/` directory numbered from 001, so they replay
   cleanly.
   - Bring along what BGB reads from `_shared/`: `001_analytics.sql` (the app.js
     tracking ping) and `004_api_logs.sql` (`api_logger.py`). Drop
     `002_admin_rpcs.sql` and `003_project_roles.sql` unless you want the admin
     dashboard to follow.
   - **Auth is what makes this a real migration, not a copy.** Moving
     `auth.users` to a new project means new JWKS and new refresh tokens; every
     signed-in session is invalidated and everyone signs in again once. Do it in
     one window, announce it, and do it before you have many users — which is an
     argument for doing the extraction *now* rather than after launch.

**What stays behind in the monorepo:** the admin dashboard's BGB entry in
`APPS_WITH_USERS` (`shared-backend/routes/admin.py`), the BGB row in
`registry.json` and the landing page's card, `db/schema/boardgamebuddy.sql`, and
BGB's slice of the shared analytics tables. Per repo convention, update `ENV.md`
in the same commit that removes each variable, and delete the eight `BGB_*` /
`BGG_*` variables from Railway once the new service owns them.

**New repo's CI:** one frontend workflow (bundle → Tailwind → Pages) and one
backend workflow, plus the two secrets the frontend build needs
(`SUPABASE_URL`, `SUPABASE_ANON_KEY`) and a Cloudflare API token. Eight
workflows and ~15 secrets become two and four.

---

## 7. Open questions and things I could not verify

- **Current database size.** The 500 MB free cap is the nearest real limit and I
  can't read the instance from here. `STRUCTURE.md` mentions a 201k-play
  measurement, which at ~1 KB/row of play + roster is already ~200 MB *for the
  shared table*. Check Supabase → Reports → Database before assuming Phase 1's
  "$0 until you need Pro" holds; it may be "Pro on day one".
- **Actual egress and photo counts.** §3 is a model, not a measurement. The
  `api_logs` table and Supabase's usage reports have the real numbers, and the
  conclusion (image bytes dominate; put them on R2) survives being wrong by 3x
  in either direction.
- **Hetzner's current price list.** hetzner.com is unreachable from this
  environment, so the Option B numbers come from third-party trackers that
  disagree with each other on a few lines, in a year with two price increases
  and some plans showing as unavailable. Treat them as ±30% and confirm before
  Phase 3.
- **Cloudflare free-plan ToS on serving image bytes.** Cloudflare's terms have
  historically discouraged serving a disproportionate share of non-HTML content
  on free plans. Serving photos from an **R2 custom domain** (a paid product)
  rather than through Pages is the clean answer, and is what Phase 2 specifies.
