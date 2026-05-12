Create a new vibelab project. Arguments: $ARGUMENTS

## Steps

1. **Clarify the idea** — If the user described an idea, ask any essential clarifying questions before proceeding:
   - What is the core problem being solved?
   - Who is the user?
   - What is the primary action (the one thing the user does in the app)?
   - Does it need user accounts / login?
   - Does it need to store user-generated data, or is it read-only?

2. **Determine the project ID** — Derive a lowercase-hyphenated ID from the idea name (e.g. "Recipe Finder" → "recipe-finder"). Confirm with the user if unsure.

3. **Run the scaffold script**:
   ```bash
   bash scaffold.sh <project-id> "<Project Title>" "<One sentence description>"
   ```
   This creates `projects/<project-id>/`, adds a route stub to `shared-backend/routes/`, updates `registry.json`, and drops a placeholder vibelab-pipeline brand mark at `projects/<project-id>/web/assets/brand/<project-id>-logo.svg` (the `<link rel="icon">` in the template already points at it). Replace this placeholder with the project's real logo before launch — see `.claude/rules/assets.md` for the asset convention.

4. **Fill in STRUCTURE.md** — Open `projects/<project-id>/STRUCTURE.md` and fill in ALL sections:
   - What This App Does
   - Data Model (design the Supabase tables with `<project-id>_` prefix)
   - API Endpoints (at minimum: health + one data endpoint)
   - Screen / Page Flow (ASCII diagram or prose)
   - Key Business Logic

5. **Write the initial DB migration** — Create `db/migrations/<project-id>/001_baseline.sql` with CREATE TABLE statements for the designed schema. Use `<project-id>_` prefix on all table names. Mirror the structure of an existing app's baseline (CREATE ROLE block at top, RLS + GRANT after every table). If the app needs reference data, add `002_seed.sql` alongside.

6. **Create the function inventory stub** — Create `db/functions/<project-id>.sql` with the standard header and a "No RPC functions defined" comment. If the baseline includes any `CREATE FUNCTION` statements, add entries for each one (see an existing file like `db/functions/sauceboss.sql` for the format).

6. **Show the user** the completed STRUCTURE.md and migration SQL for review before writing any code.

Do NOT write any implementation code until the user approves the STRUCTURE.md.
