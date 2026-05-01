# Database migrations

One shared Supabase project backs every app in this monorepo. Migrations are
organized **per app** under this directory, plus a `_shared/` subdirectory for
cross-app concerns (analytics, admin RPCs, project roles).

## Layout

```
db/migrations/
  _shared/        cross-app: analytics, admin RPCs, project roles
  <app>/          one subdirectory per app (sauceboss, boardgamebuddy, …)
    001_baseline.sql   tables + indexes + RLS + grants + RPCs
    002_seed.sql       reference data (optional; some apps have none)
    003_<desc>.sql     future migrations, per-app counter
```

The schema-final form for each app also lives in `db/schema/<app>.sql` as a
read-only snapshot. Snapshot stays in sync with the latest migration —
update it whenever a migration changes table shape.

## Execution order on a fresh DB

Run per-app baselines first, then `_shared/` last so the project-roles
migration can `GRANT SELECT` on tables that already exist and `REVOKE EXECUTE`
on app-defined RPCs.

```
db/migrations/<app>/001_baseline.sql   (every app)
db/migrations/<app>/002_seed.sql       (where present)
db/migrations/_shared/001_analytics.sql
db/migrations/_shared/002_admin_rpcs.sql
db/migrations/_shared/003_project_roles.sql
```

Within an app subdirectory, run files in numeric order.

## Production state

Production was migrated from a flat layout (`001_…sql` … `064_…sql`) on
2026-05-01. The pre-consolidation HEAD is tagged `pre-migration-consolidation`
for recovery. The consolidated baselines reproduce the production end state
when run against an empty DB — they are **not** re-run on the live database.

## Adding a new migration

1. Pick the next number for the app: `db/migrations/<app>/NNN_<desc>.sql`.
2. Run the SQL in Supabase Dashboard → SQL Editor → New Query.
3. Update `db/schema/<app>.sql` if table shape changed.
4. Commit the migration + snapshot together.

See `.claude/rules/database-supabase.md` for RLS, grant, and naming conventions.
