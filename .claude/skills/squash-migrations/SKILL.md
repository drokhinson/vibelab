---
name: squash-migrations
description: Squash one app's SQL migration history into a generated baseline — 001_baseline_tables.sql (tables, RLS, grants), one NNN_baseline_functions_<topic>.sql per topic, and NNN_seed.sql (reference rows) — replayed from the history and verified against it, with the old files moved into a dated archive generation. Run it when an app's migration directory holds 50 or more migrations past its baseline, or when asked to squash, compact, collapse or consolidate migrations.
---

# Squash Migrations

A migration directory grows by one file per schema change and nothing ever
shrinks it. Past about 50 files, reading the schema means replaying the
history in your head. This skill folds that history into a generated baseline
and archives it, so the directory reads as the schema again:

```
001_baseline_tables.sql              roles, extensions, tables, indexes, grants,
                                     RLS policies and the functions they call
002_baseline_functions_<topic>.sql   one file per --function-group, callees first
003_baseline_functions_<topic>.sql
NNN_seed.sql                         reference rows
```

Split the functions into topics that keep each file around 3,000 lines or
less. A single file of every function is hard to read.

## When

Count the live migrations past the baseline:

```bash
ls <migrations-dir>/[0-9][0-9][0-9]_*.sql | grep -vE '_(baseline|seed)(_[a-z_]+)?\.sql$' | wc -l
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
- **Topics** → `--function-group NAME REGEX DESCRIPTION`, repeated. Files come
  out in the order given. A function goes to the first group whose regex
  matches its name, except that a `.*` catch-all is always tried last. Every
  function must land in one group.

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
- **Size**: generated files run long, and the ~300-line guideline is for
  hand-written code. If one functions file is far larger than the others,
  rebalance the `--function-group` regexes.

### 5. Archive and install

```bash
cd <migrations-dir>
mkdir -p archive/<YYYY-MM-DD>
git mv [0-9][0-9][0-9]_*.sql archive/<YYYY-MM-DD>/   # every live file, the old baseline included
cp <scratchpad>/squash/*.sql .
```

If `archive/` still holds loose files from an older squash, first move them
into their own dated subdirectory and fix the references to them (step 6).

Add a row to `archive/README.md` for the new generation (create the README on
the first squash, modelled on BoardgameBuddy's), with the number range, what
it squashed into, and the date.

### 6. No comment points at a migration

Comments cite no migration (`.claude/rules/database-supabase.md`), and after
a squash any that slipped in point into the archive. Find them:

```bash
grep -rnE '[Mm]igrations? #?[0-9]{3}|archive/|\b0[0-9]{2}_[a-z][a-z0-9_]+\.sql|\b(per|since|as of|pre-)[ ]?0[0-9]{2}\b|\(0[0-9]{2}\)' \
  <app dir> --exclude-dir=archive --exclude-dir=Docs
```

Rewrite each one to name the table, column or function it is about and to
state what is true now (read the archived file to find out). Leave the
`STRUCTURE.md` changelog, `Docs/` and the archived files alone: they are
history. A SQL test named after a migration (`db/tests/057_x.sql`) is renamed
after what it tests.

Comments inside the database are the one catch. A `COMMENT ON` string or a
comment in a function body is part of production's state, so the squash
reproduces it verbatim. To change one, write a migration (`COMMENT ON …`,
`CREATE OR REPLACE FUNCTION` with only comments changed), then regenerate with
`--migrations archive/<date> --migrations <that file>` so the baseline
includes it. Keep the migration live until production has run it. Before you
commit, check that stripping `--` comments leaves every function body
unchanged.

### 7. Continue the counter

The next migration takes the number after the highest archived one (or after
the highest live one, if a migration from step 6 is live), not the number after
the baseline. That way an archived file and a live one never share a number,
and the changelog and commit messages that cite numbers stay unambiguous.
Update the "next number" guidance wherever the app documents it (its
`CLAUDE.md`, `STRUCTURE.md`, `db/migrations/README.md`).

### 8. Snapshots, docs, commit

- `db/schema/<app>.sql` and `db/functions/<app>.sql` do not change shape, but
  every "Defined in" entry in the functions inventory now names a baseline
  file. Update those.
- Add a changelog line to the app's `STRUCTURE.md` and a paragraph under
  "Production state" in `db/migrations/README.md`.
- Commit as `[<app>] squash migrations NNN–MMM into baseline + seed`, with the
  verify line (`verified: squashed database matches the replay …`) in the
  body. Put the exact `squash.py` command in the PR description so the next
  squash can reuse it.

## Known invocations

**BoardgameBuddy**, last squashed 2026-09-28 (`001`–`058` →
`archive/2026-09-28/`). The next squash adds `--skip` for any new data-only
files, adds a `--function-group` if a new topic has grown, and keeps the rest:

```bash
B=projects/boardgame-buddy/db/migrations
python3 .claude/skills/squash-migrations/squash.py \
  --migrations $B \
  --prereq $B/_shared/001_analytics.sql --prereq $B/_shared/004_api_logs.sql \
  --prereq $B/_shared/005_api_sessions.sql --prereq $B/_shared/006_drop_api_sessions.sql \
  --tables 'boardgamebuddy\_%' \
  --functions 'bgb\_%' --functions 'boardgamebuddy\_%' \
  --function-group play '.*' 'Games and the table: logging and importing plays, live sessions, ghost players and claims, the catalog, collection shelves, ranks, discover and BGG sync.' \
  --function-group social '^bgb_(admin_|bootstrap|delete_account|feed|mark_|notifications|onboarding_|play_partners|play_stats|plays_page|profile_bundle|release_notices|suggested_buddies|sync_achievements|user_stats)' 'People and what they see: profiles, the feed, buddies and suggestions, notifications, stats, achievements, account deletion, admin usage.' \
  --extra-seed "storage.buckets(id,name,public,file_size_limit,allowed_mime_types):id LIKE 'boardgamebuddy-%'" \
  --role-password change-me-via-shared-003 \
  --app boardgamebuddy --archive archive/<YYYY-MM-DD> \
  --out <scratchpad>/squash --verify
```

The prerequisites are the project's own byte-identical copies of the root
`_shared/` files. `005` and `006` are there because `bgb_admin_usage_stats`
reads `api_logs.user_id`. The migrations directory opens with the previous
baseline, which the replay picks up like any other `NNN_*.sql`.
