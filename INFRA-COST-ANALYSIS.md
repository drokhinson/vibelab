# Infrastructure Cost & Platform Analysis

**Date:** 2026-08-21
**Question:** Is `Neon + Cloudflare Pages + Cloudflare R2` cheaper / more scalable than the
current `Railway + Supabase + Vercel` stack? And should the monorepo be split into
independent projects?

---

## TL;DR

1. **The proposed stack saves $0/month.** Every service it replaces is already free
   (Supabase free, Vercel Hobby). The only real money in the system is the **$20 Railway
   bill**, and the proposal doesn't touch it. Cloudflare Pages does not host FastAPI.
2. **The cheapest win is not on the list:** Railway **Pro → Hobby** is $5/mo instead of $20,
   same service, zero migration. That's **$180/year** for a plan change — do this first and
   verify actual usage in the Railway dashboard.
3. **The second-cheapest win is also not on the list:** `api_logs` and `analytics_events`
   grow forever with **no retention policy**. They are the most likely thing to hit the
   500 MB DB wall, and a `pg_cron` delete fixes it for free.
4. **R2 is worth doing.** It's a 10× storage headroom increase for ~2 call sites of work,
   and it directly answers the storage-limit risk. **Do this.**
5. **Neon is not worth doing yet — unless you split the monorepo.** Neon's free tier is
   *the same 0.5 GB* as Supabase for a single project. Its advantage only materializes at
   `0.5 GB × N projects`. Against that: **654 PostgREST calls, 57 RPC calls, 5 apps on
   Supabase Auth** all have to be rewritten.
6. **Cloudflare Pages is optional.** $0 → $0. Real but minor gains (unlimited bandwidth,
   no non-commercial ToS clause).
7. **The pause risk is already mitigated** by `supabase-keepalive.yml`. The residual
   exposure is narrow and documented below — it does not justify a database migration
   on its own.

---

## 1. What you are actually paying for today

| Service | Plan | Cost | Utilization |
|---|---|---|---|
| Railway | Pro ($20/seat, includes $20 usage) | **$20/mo** | One `uvicorn` service, one worker. Almost certainly using a fraction of the $20 credit. |
| Supabase | Free | $0 | 82 tables, 188 SQL functions, 2 storage buckets |
| Vercel | Hobby | $0 | 9 static sites, deployed via GH Actions |
| GitHub Actions | Free | $0 | 5 workflows incl. the keep-alive cron |
| **Total** | | **$20/mo** | |

**The finding:** Railway Pro is $20/seat/month and *includes* $20 of usage. Hobby is
$5/month and includes $5 of usage. A single always-on FastAPI container with hobby-level
traffic typically lands in the $3–6/month range. If your Railway usage graph shows under
$5/month of actual resource consumption, **you are paying a $15/month seat premium for
nothing.**

Check: Railway dashboard → Usage. If actual usage < $5/mo, downgrade to Hobby.

> Pro also buys higher memory/CPU ceilings, priority support, and team seats. If you're
> not using those, Hobby is the same runtime.

**This single change is larger than the entire savings of the proposed migration**, because
the proposed migration replaces services that already cost $0.

---

## 2. Risk 1 — Supabase pausing after inactivity

**Current exposure: low.** `.github/workflows/supabase-keepalive.yml` already pings
PostgREST every 2 days, which resets the 7-day inactivity timer.

The residual risk is a *second-order* one, and the workflow's own comment names it:

> GitHub disables scheduled workflows after 60 days without repo activity.

So the actual failure chain is: **you stop committing for 60 days → GH silently disables the
cron → 7 days later Supabase pauses → every app 500s until you manually unpause from the
dashboard.** Given 145 commits and active development, this is a "if I walk away for two
months" risk, not a "next Tuesday" risk.

**Cheap hardening (no migration):**
- Add a second keep-alive from a source that doesn't decay — Cloudflare Workers Cron
  Triggers (free, no inactivity expiry) or any always-on uptime pinger hitting
  `/api/v1/health`.
- Note that a Railway-hosted health endpoint that touches the DB also keeps it warm, if
  anything at all polls it.

**How Neon compares:** Neon **does not pause-and-require-manual-unpause**. Computes scale
to zero after 5 minutes of inactivity and wake automatically on the next connection. This
class of failure disappears entirely.

But the flip side is real: **scale-to-zero cannot be disabled on Neon's free plan.** You
trade "pauses after 7 days idle, warm otherwise" for "cold-starts after 5 minutes idle,
always." For 8 low-traffic hobby apps, that means most app opens pay a wake-up latency
(typically a few hundred ms to ~1s on the first query).

You also can't buy your way out with a keep-warm ping: 0.25 CU running continuously for a
month is ~182 CU-hours, well past the **100 CU-hours/project/month** free allowance. Free
Neon *requires* you to accept cold starts.

| | Supabase Free | Neon Free |
|---|---|---|
| Idle behavior | Warm indefinitely | Scales to zero after 5 min |
| Inactivity penalty | **Paused after 7 days, manual unpause** | Auto-wakes, no manual step |
| Cold start | None (until paused) | On every idle gap > 5 min |
| Keep-warm possible? | Yes (current cron) | No — exceeds 100 CU-h/mo |

---

## 3. Risk 2 — Storage limits

Two separate ceilings, with two different culprits.

### 3a. Database: 500 MB (Supabase free)

The app tables are small — 82 tables of hobby-scale relational data. **The threat is the
two unbounded log tables:**

| Table | Growth | Retention |
|---|---|---|
| `api_logs` | One row per outbound 3rd-party call (BGG, Perenual, image CDNs), with `body_excerpt` capped at **8 KB** | **None.** Manual "clear bodies" admin button only. Rows are never deleted. |
| `analytics_events` | One row per app open, fire-and-forget from every web + native client | **None.** Rows are never deleted. |

Back-of-envelope: at ~8.5 KB/row, **~60,000 `api_logs` rows fills the entire 500 MB
database.** A single BoardGameGeek collection sync fans out to many logged calls. The fact
that `POST /api-logs/clear-bodies` exists at all suggests this has already been felt.

**Fix — free, no migration, ~30 minutes:**
```sql
-- Nightly, via pg_cron (available on Supabase free)
DELETE FROM api_logs         WHERE sent_at    < now() - interval '30 days';
UPDATE api_logs SET body_excerpt = NULL
                             WHERE sent_at    < now() - interval '7 days'
                               AND body_excerpt IS NOT NULL;
DELETE FROM analytics_events WHERE created_at < now() - interval '180 days';
```
Or roll `analytics_events` into a daily aggregate table and drop the raw rows. Either way,
**bounding these two tables is a bigger win than changing database vendors**, because it
converts unbounded growth into a fixed ceiling. Migrating to Neon without fixing this just
moves the same leak to a database with the *same* 0.5 GB limit.

### 3b. File storage: 1 GB (Supabase free) — this is the real one

Two buckets, both with plausible paths past 1 GB:

| Bucket | Written by | Growth math |
|---|---|---|
| `plantplanner-plants` | `routes/plant_planner/image_mirror.py` | 3 sizes per species (thumbnail + medium + regular), ~250–300 KB/species. **1 GB ≈ 3,500 species.** Perenual's catalog is roughly 10,000 — a full catalog fill overruns the free bucket ~3×. |
| play photos | `routes/boardgame_buddy/play_routes.py` | User uploads capped at **5 MB each**. **1 GB ≈ 200 photos** worst case. |

200 photos is not a lot of headroom for a social play-logging app. **This is the concrete,
near-term version of your storage worry**, and it's the one the proposed stack actually
answers well.

**R2 free tier: 10 GB storage, 1M Class A (write) ops, 10M Class B (read) ops per month,
and zero egress fees, permanently.** That's 10× the storage and removes egress from the
equation entirely.

**Migration cost is genuinely small** — the Supabase Storage surface is only two call sites:
- `shared-backend/routes/plant_planner/image_mirror.py` (`sb.storage.from_(BUCKET).upload` / `get_public_url`)
- `shared-backend/routes/boardgame_buddy/play_routes.py` (same two methods)

Both become `boto3`/S3-compatible calls against R2 plus a public bucket URL (or a custom
domain). Existing objects copy over with `rclone`. The DB columns store full public URLs
already (`image_*_path`, `photo_url`), so old and new URLs can coexist during the cutover —
**no big-bang migration required.**

**Verdict: adopt R2. Highest value-to-effort ratio of the three proposed changes.**

---

## 4. Component-by-component verdict

### Cloudflare Pages vs Vercel Hobby — *optional, $0 → $0*

| | Vercel Hobby | Cloudflare Pages Free |
|---|---|---|
| Bandwidth | 100 GB/mo, **project paused** at the cap (no overage option) | Unlimited |
| Requests | — | Unlimited |
| Builds | 1 concurrent | 500/month, 1 concurrent |
| Files per site | — | 20,000 |
| Commercial use | **Not permitted** on Hobby | Permitted |
| Custom domains | Yes | Yes |

**Gains:** removes the 100 GB cliff (a Vercel overrun *pauses the project* rather than
billing you), removes the non-commercial ToS clause, unlimited bandwidth. If any of these
apps ever gets linked somewhere popular, Vercel's hard pause is a genuine outage mode.

**Costs:** rewriting 4 deploy workflows (`deploy-frontend.yml`,
`deploy-frontend-all.yml`, `deploy-landing.yml`, and the matrix logic) from `vercel deploy`
to `wrangler pages deploy`, and re-pointing DNS. Note **500 builds/month is account-wide** —
across 9 sites that's ~55 deploys per site per month, which is fine now but is a shared
budget where Vercel's is per-project.

**Verdict:** worth doing eventually for the bandwidth cap and ToS reasons, but it is a
lateral move on cost. **Do it after R2, not before.** Deploying to Pages also puts you in
the same account/CLI as R2, which is a modest ops simplification.

### Neon vs Supabase Postgres — *the expensive one*

**The headline number is a wash for a single database:**

| | Supabase Free | Neon Free |
|---|---|---|
| DB storage | 500 MB (one project) | 0.5 GB **per project**, up to **100 projects** |
| Projects | **2 active** | 100 |
| Branches | — | 10 per project |
| Compute | Always-on shared CPU | 100 CU-hours/project/mo, scale-to-zero |
| Egress | 5 GB/mo | 5 GB/mo |
| Auth included | Yes (GoTrue, 50K MAU) | Neon Auth (60K MAU) |
| File storage | 1 GB | **None** — needs R2 anyway |
| PostgREST auto-API | **Yes** | **No** |
| Backups | None on free | Point-in-time restore / branching |

For **one** database, Neon gives you the same 0.5 GB. The win is entirely in the
**per-project multiplier** — which only pays off if you split (see §5).

**What the migration actually costs.** The backend is not "a Postgres app" — it's a
*Supabase* app. Measured coupling:

| Coupling | Count | Portable to Neon? |
|---|---|---|
| `sb.table(...)` PostgREST calls | **654** across 64 files | **No.** Every one becomes SQL / an ORM call. This is the bulk of the work. |
| `sb.rpc(...)` calls | **57** | Partially — the *functions* port fine (they're plain `plpgsql`), the *invocation* doesn't. |
| SQL functions in migrations | 188 | **Yes** — plain Postgres, port as-is. |
| Tables | 82 | **Yes** — `pg_dump`/`pg_restore`. |
| RLS policies | **3** | Irrelevant — RLS is not load-bearing here (backend uses `service_role`). |
| Supabase Auth (GoTrue) | 5 web apps + `jwt_auth.py` JWKS verification + admin user management | **No.** Needs Neon Auth / Clerk / Auth0. User IDs, password hashes, and OAuth links all have to migrate. |
| Supabase Storage | 2 buckets | **No.** → R2 (which you'd want regardless). |

**Two things that make this much less scary than it looks:**

1. **The frontends never query the database directly.** Grep confirms the web clients use
   `supabaseClient` for *auth only* (`onAuthStateChange`, `signOut`, session restore) —
   there are zero `supabaseClient.from(...)` / `.rpc(...)` data calls in `projects/*/web/`.
   **The data layer is a pure backend concern**, so the DB swap touches no frontend code.
2. **`db.py` is a single-function singleton.** All 64 files import `get_supabase()`. A
   compatibility shim implementing the subset of the PostgREST fluent interface actually
   used (`.table().select().eq().order().execute()`) over `psycopg`/SQLAlchemy is a viable
   path that avoids rewriting all 654 call sites by hand — though it's real work and adds a
   layer you'd own forever.

**Realistic estimate:** the DB itself is a weekend (`pg_dump` → Neon, 188 functions come
along). The **654 data-access rewrites and the auth migration are the project** — call it
20–40 hours, plus the risk of subtle behavior changes in 5 live auth flows.

**Verdict: do not migrate to Neon to save money — there is none to save.** Migrate only if
you decide to split per-project (§5), or if you specifically want Neon's branching and
point-in-time restore (which are legitimately better than "no backups on Supabase free").

### What Cloudflare does *not* solve: the backend

The proposal has a hole. **Cloudflare Pages hosts static files; it does not run your
FastAPI service.** The $20 Railway bill has three possible fates:

| Option | Cost | Effort | Notes |
|---|---|---|---|
| **Railway Hobby** | **$5/mo** | **None** | Recommended. Same service, plan downgrade. |
| Cloudflare Workers (Python) | $0 (100K req/day free) | **Very high** | FastAPI now runs on Python Workers, but the runtime is Pyodide-based. `ingredient-parser-nlp`, `recipe-scrapers`, `bcrypt`, `cryptography`, and `supabase-py` are unlikely to all work. Free tier is also **10 ms CPU/request**, which Python cold starts blow through. Not realistic for this codebase. |
| Cloudflare Containers | $5/mo (requires Workers Paid) | Medium | Runs a real container, so the code ports. But it's the same $5 as Railway Hobby, with a migration attached. |
| Fly.io / Render free | $0 | Medium | Render's free tier spins down (~50s cold start). Fly's free allowance suits a small always-on service. Cheaper than $5 but adds a platform. |

**Railway Hobby at $5/mo is the right answer** — it's the cheapest option that requires zero
work and keeps a real Python runtime.

---

## 5. Splitting the monorepo

This is the question where the two stacks genuinely diverge, and it's the strongest
argument in the proposal's favor.

### The current stack *punishes* splitting

| Constraint | Effect on a split |
|---|---|
| **Supabase free = 2 active projects** | 8 apps cannot each have a database. A split forces Supabase Pro at **$25/mo**, plus **~$10/mo per additional project's compute**. Eight isolated databases is a **$100+/mo** proposition. |
| **Railway bills per service** | 8 always-on `uvicorn` services instead of 1 means ~8× the idle compute. The current $20 becomes real usage, not a seat fee. |
| **Vercel Hobby** | Already per-project — this part splits fine and free. |

**Splitting today costs roughly $100–150/month.** That is why the monorepo exists, and the
architecture is correctly optimized for the constraint it was built under.

### The proposed stack *rewards* splitting

| Constraint | Effect on a split |
|---|---|
| **Neon = 100 projects, 0.5 GB each** | 8 apps → **4 GB total free storage**, up from 500 MB shared. Each app gets its own **100 CU-hours/month**. Blast radius per app. |
| **Cloudflare Pages = unlimited sites** | 8 sites, free. |
| **R2 = 10 GB** | Shared or per-app prefixes, free either way. |
| **Backend** | Still the pinch point. 8 Railway services ≈ 8× cost. |

**This is the actual case for Neon**: not that it's cheaper for one database, but that it's
the only piece of the stack under which *splitting the data layer stops costing money*.
8 × 0.5 GB free is genuinely 8× your current DB headroom, and it removes the "one app's
runaway table takes down all eight" failure mode you have today.

### What a split costs you, in either world

These are architectural costs, independent of vendor:

1. **The admin dashboard breaks.** `routes/admin.py` is inherently cross-app: `APPS_WITH_USERS`
   spans 5 apps, `admin_table_sizes()` reports storage for all of them, and
   `analytics_summary_counts()` aggregates events across every app. With 8 separate
   databases, every one of those single queries becomes an 8-way fan-out — or the admin
   tooling gets rebuilt around a separate aggregation store.
2. **`api_logs` and `analytics_events` need a home.** They're cross-app by design. Either
   they stay in a 9th "shared" database (extra connection from every service), or they
   fragment and lose their cross-app value.
3. **27,500 lines of shared backend get duplicated or extracted.** `auth.py`, `db.py`,
   `cache.py`, `api_logger.py`, `shared_models.py`, `gemini.py`, `jwt_auth.py` are used by
   every route package. A split means publishing them as an internal package (versioning,
   release process) or copy-pasting them 8 times (drift).
4. **Env var sprawl.** `ENV.md` currently documents one Railway service and one Supabase
   project. A split multiplies every row by 8, and cross-cutting values
   (`GEMINI_API_KEY`, `ADMIN_API_KEY`) have to be rotated in 8 places.
5. **CI multiplies.** 5 workflows become 8 repos × ~3 workflows, and the neat
   changed-project matrix detection in `deploy-frontend.yml` becomes redundant.
6. **You lose atomic cross-project changes.** The recent pattern of shared-module edits
   landing with all their consumers in one commit stops working.

### Recommendation: split the *data*, not the *repo*

The benefit you actually want from a split is **isolation of the storage ceiling and the
blast radius**. You do not need 8 repos, 8 CI pipelines, or 8 backend services to get that.

**Middle path — one repo, one backend service, N databases:**

```
vibelab/                       ← unchanged monorepo
└── shared-backend/            ← ONE Railway Hobby service ($5/mo)
    └── db.py                  ← returns a per-app connection
         ├── neon: vibelab-sauceboss        (0.5 GB free)
         ├── neon: vibelab-boardgamebuddy   (0.5 GB free)
         ├── neon: vibelab-plantplanner     (0.5 GB free)
         ├── ...
         └── neon: vibelab-shared           (api_logs, analytics, admin)
```

- Keeps the monorepo's atomic-change and shared-module advantages (items 3–6 above cost you nothing).
- Gets the per-app storage ceiling and blast-radius isolation (the real goals).
- Costs $5/mo total, not $100+.
- The admin dashboard still fans out across 8 connections (item 1 remains), but from a
  single process, which is far simpler than 8 services doing it.

**Caveat worth weighing:** 9 Neon projects means 9 independently-cold computes. A user
opening SauceBoss after a quiet afternoon pays a wake-up on the SauceBoss project *and*
the shared project (for the analytics write). Batching or fire-and-forgetting the shared
writes mitigates this, but it's a real latency cost that a single always-warm Supabase
instance doesn't have.

Full repo-splitting is a **team-scaling** move — it pays off when different people own
different apps and want independent release cadences. As a solo operator, it's mostly
downside.

---

## 6. Recommended sequence

Ordered by value-per-hour, not by the order the proposal listed them.

| # | Action | Saves / Gains | Effort | Migration risk |
|---|---|---|---|---|
| 1 | **Railway Pro → Hobby** (verify usage first) | **−$15/mo ($180/yr)** | 5 min | None |
| 2 | **Bound `api_logs` + `analytics_events`** via `pg_cron` | Removes the likeliest path to the 500 MB wall | ~30 min | None |
| 3 | **Second keep-alive** not dependent on GH Actions cron | Closes the pause-risk gap | ~30 min | None |
| 4 | **Supabase Storage → R2** (2 call sites) | 1 GB → 10 GB, zero egress | ~half a day | Low — URLs coexist |
| 5 | **Vercel → Cloudflare Pages** (4 workflows) | Removes 100 GB pause cliff + ToS clause | ~1 day | Low — DNS cutover |
| 6 | **Supabase → Neon**, one project per app | 0.5 GB → 4 GB, isolation, branching, PITR | **20–40 hrs** | **High** — 654 call sites + 5 auth flows |

**Steps 1–3 cost about an hour and address both stated risks.** Step 4 is the one piece of
the proposed stack that's clearly worth adopting on its own merits. Steps 5–6 are
strategic, not economic — take them when the monorepo's shared 500 MB ceiling actually
starts to bind, or when you want branching/PITR badly enough to pay for the rewrite.

### Cost comparison at the end state

| Scenario | Monthly | Migration |
|---|---|---|
| Today | $20 | — |
| Steps 1–3 only | **$5** | ~1 hour |
| Steps 1–4 (recommended near-term) | **$5** | ~1 day |
| Full proposed stack (Neon + Pages + R2 + Railway Hobby) | **$5** | ~1 week |
| Stay on Supabase, outgrow free tier | $5 + $25 = **$30** | none |
| Split into 8 repos on the *current* stack | **$100–150** | weeks |

The proposed stack and the do-nothing-but-downgrade path **both land at $5/month.** The
migration's value is not savings — it's ~$25/mo of *avoided future spend* (the Supabase Pro
upgrade you'd otherwise need), plus branching, PITR, and 8× storage headroom. Priced
against 20–40 hours, that's roughly a 12-month payback, and only if you'd have hit the
free-tier ceiling anyway.

---

## Sources

Pricing verified 2026-08-21:
- [Neon free plan limits & quotas](https://neon.com/faqs/free-plan-limits-and-quotas) · [Neon plans](https://neon.com/docs/introduction/plans)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing) · [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [FastAPI on Python Workers](https://developers.cloudflare.com/workers/languages/python/packages/fastapi/) · [Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [Railway pricing](https://docs.railway.com/pricing)
- [Supabase pricing](https://supabase.com/pricing)
- [Vercel pricing](https://vercel.com/pricing)

Codebase measurements taken from this repo at commit time: 654 `sb.table()` calls / 57
`sb.rpc()` calls across 64 files, 82 tables, 188 SQL functions, 3 RLS policies, 2 storage
buckets, 5 apps on Supabase Auth, 27,531 lines of Python in `shared-backend/`.
