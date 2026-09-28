---
name: squash-migrations
description: Squash one app's SQL migration history back to two files — 001_baseline.sql (tables, functions, policies, grants) and 002_seed.sql (reference rows) — generated from a replay and verified against it, with the old files moved into a dated archive generation. Run it when an app's migration directory holds 50 or more migrations past its baseline, or when asked to squash, compact, collapse or consolidate migrations.
---

# Squash Migrations

A migration directory grows by one file per schema change and nothing ever
shrinks it. Past about 50 files, reading the schema means replaying the
history in your head. This skill folds that history into two generated files
and archives it, so the directory reads as the schema again.

## When

Count the live migrations past the baseline:

```bash
ls <migrations-dir>/[0-9][0-9][0-9]_*.sql | grep -vE '/00[12]_(baseline|seed)\.sql$' | wc -l
```

**50 or more → squash.** Check this whenever you add a migration to a
directory, and say so in your reply when the count crosses 50. Squash as a
change of its own, never mixed into a feature branch.

Migration directories: `db/migrations/<app>/` for most apps, and
`projects/boardgame-buddy/db/migrations/` for BoardgameBuddy, which keeps its
own tree (`db/migrations/README.md`).

## Contract

The squashed files must reproduce, on an empty database, exactly what
replaying the archived migrations produces. `squash.py --verify` proves that
by building both and diffing them: schema, grants, RLS policies, comments,
function bodies, extensions, realtime publication membership and the seeded
rows. **Never commit a squash that did not verify.**

Production is not touched. It is already at the end state; the squash only
changes how a fresh database gets there. Never run the new baseline on the
live database.

## Steps

### 1. Confirm production has every live migration

Nothing tracks which files have run (`db/migrations/README.md`), so ask the
user: "Have all of `<first>`–`<last>` been applied to production?" A file that
has not run would be absorbed into a baseline nobody applies, and its change
would never reach production. Do not proceed on a guess.

### 2. Read the directory for the three inputs

- **Data-only migrations that need live data** → `--skip`. The tell is a
  placeholder or a guard that refuses to run unedited (BoardgameBuddy's
  `036_r2_photo_urls.sql` raises until four URLs are filled in). A migration
  that only UPDATEs or DELETEs existing rows is a no-op on an empty database,
  so skipping it loses nothing. Anything that also changes shape cannot be
  skipped. Stop and ask.
- **Cross-app prerequisites** → `--prereq`. Tables or functions the app reads
  but does not own (`api_logs`, `analytics_events`) come from
  `db/migrations/_shared/`. The replay tells you what is missing: it stops
  with `relation "…" does not exist`.
- **What the app owns** → `--tables` / `--functions`, as SQL `LIKE` patterns
  (`'sauceboss\_%'`). Rows outside `public` that the migrations seed, such as
  storage buckets, go in `--extra-seed 'storage.buckets(id,name,…):id LIKE …'`.
  The column list keeps the stub's own columns out of the seed.

### 3. Generate and verify into a scratch directory

```bash
python3 .claude/skills/squash-migrations/squash.py \
  --migrations <migrations-dir> \
  --prereq ... --skip ... --tables ... --functions ... \
  --app <app> --archive archive/<YYYY-MM-DD> \
  --out <scratchpad>/squash --verify
```

It needs the PostgreSQL server binaries (`initdb`, `pg_ctl`, `pg_dump`), and
starts and removes its own throwaway cluster. Nothing in the repo is written.
`--archive` is only the path the headers cite: use today's date, which is
where step 5 puts the files.

If the replay fails on a Supabase object (`auth.…`, `storage.…`), add it to
`supabase_stubs.sql`. If the script refuses an object kind it cannot emit
(views, triggers, custom types, serial columns), extend `squash.py`, then
re-verify.

### 4. Read what it wrote

- **Seed**: every table listed should be reference data. A row that looks like
  user data means a migration inserts something on an empty database that it
  should not. Ask before keeping it.
- **Grants**: written as the difference from Supabase's defaults. Every
  `SECURITY DEFINER` function should show `REVOKE ... FROM PUBLIC, anon,
  authenticated` (`.claude/rules/database-supabase.md`).
- **Size**: the baseline is one large generated file. That is expected; the
  ~300-line guideline is for hand-written code.

### 5. Archive and install

```bash
cd <migrations-dir>
mkdir -p archive/<YYYY-MM-DD>
git mv [0-9][0-9][0-9]_*.sql archive/<YYYY-MM-DD>/   # every live file, old 001/002 included
cp <scratchpad>/squash/00[12]_*.sql .
```

If `archive/` still holds loose files from an older squash, first move them
into their own dated subdirectory and fix the references to them (step 6).

Add a row to `archive/README.md` for the new generation (create the README on
the first squash, modelled on BoardgameBuddy's), with the number range, what
it squashed into, and the date.

### 6. Keep every reference resolving

- **Paths to moved files** (`db/migrations/046_x.sql` in docs, runbooks,
  `db/tests/`, `db/functions/`, `.claude/rules/`): rewrite them to the archive
  path. Find them with
  `grep -rnE "db/migrations/[0-9]{3}_" --exclude-dir=archive --exclude-dir=.git .`,
  and for an app under `db/migrations/<app>/`, search for that prefix too.
- **`archive/NNN` paths** from an earlier squash that you moved in step 5:
  rewrite them to `archive/<old-date>/NNN`.
- **Bare numbers** ("migration 045") in code comments: leave them. They stay
  unambiguous because of the counter rule below, and the archive README says
  which generation they live in.
- Leave the text of the archived files alone. They are history.

### 7. Continue the counter

The next migration takes the number after the highest archived one, not
`003`. If the counter restarted, "migration 012" would mean two different
files, and code comments cite migrations by number. Update the "next number"
guidance wherever the app documents it (its `CLAUDE.md`, `STRUCTURE.md`,
`db/migrations/README.md`).

### 8. Snapshots, docs, commit

- `db/schema/<app>.sql` and `db/functions/<app>.sql` do not change shape.
  Point their "Last updated" line at the squash.
- Add a changelog line to the app's `STRUCTURE.md` and a paragraph under
  "Production state" in `db/migrations/README.md`.
- Commit as `[<app>] squash migrations NNN–MMM into baseline + seed`, with the
  verify line (`verified: squashed database matches the replay …`) in the
  body. Put the exact `squash.py` command in the PR description so the next
  squash can reuse it.

## Known invocations

**BoardgameBuddy**, last squashed 2026-09-28 (`001`–`058` →
`archive/2026-09-28/`). The next squash adds `--skip` for any new data-only
files and keeps the rest:

```bash
python3 .claude/skills/squash-migrations/squash.py \
  --migrations projects/boardgame-buddy/db/migrations \
  --prereq db/migrations/_shared/001_analytics.sql \
  --prereq db/migrations/_shared/004_api_logs.sql \
  --prereq db/migrations/_shared/005_api_sessions.sql \
  --prereq db/migrations/_shared/006_drop_api_sessions.sql \
  --tables 'boardgamebuddy\_%' \
  --functions 'bgb\_%' --functions 'boardgamebuddy\_%' \
  --extra-seed "storage.buckets(id,name,public,file_size_limit,allowed_mime_types):id LIKE 'boardgamebuddy-%'" \
  --role-password change-me-via-shared-003 \
  --app boardgamebuddy --archive archive/<YYYY-MM-DD> \
  --out <scratchpad>/squash --verify
```

The `_shared/005`/`006` prerequisites are there because
`bgb_admin_usage_stats` reads `api_logs.user_id`. The migrations directory now
opens with the previous baseline, which the replay picks up like any other
`NNN_*.sql`.
