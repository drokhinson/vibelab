---
paths:
  - "db/**"
  - "shared-backend/**"
  - "projects/*/STRUCTURE.md"
---

# Database Conventions (Supabase)

- ONE shared Supabase project for all apps. Tables are app-prefixed: `sauceboss_carbs`, `spotme_locations`.
- All migrations go in `db/migrations/` as numbered SQL: `001_sauceboss_schema.sql`, `002_sauceboss_seed.sql`.
- Run migrations in Supabase dashboard → SQL Editor → New Query → Run.
- Use RPCs (`supabase.rpc()`) for complex multi-table reads.
- Backend uses `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS). Never expose it to the frontend.
- **Always enable RLS on new tables.** Add `ALTER TABLE public.<table> ENABLE ROW LEVEL SECURITY;` immediately after every `CREATE TABLE`. No policies are needed — the backend uses service role key which bypasses RLS. This blocks direct anon-key access to Supabase's REST API.
- **Grant new tables to the project role.** Each project has a read-only Postgres login role (`<prefix>_role`, e.g. `sauceboss_role`) used for direct DB access via psql/TablePlus. After every `CREATE TABLE public.<prefix>_x;` in a migration, add `GRANT SELECT ON public.<prefix>_x TO <prefix>_role;`. Without this, the new table is invisible to the project role. See `db/migrations/061_project_roles.sql` for role setup. New projects must add a `CREATE ROLE <prefix>_role LOGIN PASSWORD '...' NOINHERIT;` + `GRANT USAGE ON SCHEMA public` block in their first migration. Note: Supabase Studio's SQL Editor always runs as `postgres`; exercise these roles via desktop clients only.
- **Keep `db/schema/[project].sql` in sync.** When a migration adds, removes, or alters a table, update the corresponding snapshot file in `db/schema/`. These files give Claude instant schema context without reading all migration files — always check `db/schema/` first when you need to understand a project's tables.
- **Data belongs in the database, not in code.** Any named list, option set, lookup table, or configurable preset (e.g. skill levels, categories, status values, tags) must be stored as rows in a Supabase table with a migration, not as a Python dict/list or JS array in application code. Hard-coded constants require a deploy to change; a DB row does not. The only things that belong in `constants.py` are secrets, algorithm identifiers, and other true compile-time values.

## Run a Supabase migration
1. Write SQL in `db/migrations/[NNN]_[project]_[description].sql`
2. Paste into Supabase dashboard → SQL Editor → Run
3. Commit the file
