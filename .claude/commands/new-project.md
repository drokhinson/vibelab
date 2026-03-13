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
   This creates `projects/<project-id>/`, adds a route stub to `shared-backend/routes/`, and updates `registry.json`.

4. **Fill in STRUCTURE.md** — Open `projects/<project-id>/STRUCTURE.md` and fill in ALL sections:
   - What This App Does
   - Data Model (design the Supabase tables with `<project-id>_` prefix)
   - API Endpoints (at minimum: health + one data endpoint)
   - Screen / Page Flow (ASCII diagram or prose)
   - Key Business Logic

5. **Write the initial DB migration** — Create `db/migrations/NNN_<project-id>_schema.sql` with CREATE TABLE statements for the designed schema. Use `<project-id>_` prefix on all table names.

6. **Show the user** the completed STRUCTURE.md and migration SQL for review before writing any code.

Do NOT write any implementation code until the user approves the STRUCTURE.md.
