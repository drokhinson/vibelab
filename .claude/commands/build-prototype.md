Build the web prototype for project: $ARGUMENTS

## Steps

1. **Read STRUCTURE.md first** — Open `projects/$ARGUMENTS/STRUCTURE.md` completely. Do not write a single line of code until you have read it in full. If any sections are empty or say "TODO", ask the user to fill them in first.

2. **Implement the FastAPI routes** (`shared-backend/routes/<project>.py`):
   - One `async def` handler per endpoint listed in STRUCTURE.md
   - All data from Supabase via `get_supabase()` from `db.py`
   - Always include `GET /api/v1/<project>/health`
   - Register the router in `shared-backend/main.py` if not already there
   - Follow the sauceboss routes as the reference implementation

3. **Write Supabase migrations** if not already done (per-app counter, in `db/migrations/<project>/`):
   - Schema + RPCs: `db/migrations/<project>/001_baseline.sql`
   - Seed data: `db/migrations/<project>/002_seed.sql` (if applicable)
   - Subsequent changes: `db/migrations/<project>/003_<description>.sql`, etc.

4. **Implement the web prototype** (`projects/<project>/web/`):
   - `config.js` — sets `window.APP_CONFIG.apiBase` (already from template)
   - `styles.css` — add project-specific overrides below the design system
   - `index.html` — structure with semantic Pico.css HTML
   - `app.js` — fetch-based data loading, loading/error states on every fetch
   - Mobile-first, max-width 480px for single-column apps

5. **Test locally**:
   ```bash
   cd shared-backend && uvicorn main:app --reload --port 8000
   # In another terminal: open projects/<project>/web/index.html
   ```
   Verify: data loads, loading spinner shows, error state handles network failure.

6. **Update STRUCTURE.md** — Fill in:
   - Status: Prototype
   - Active Development Notes with what was built and what remains

Follow all conventions in the root CLAUDE.md.
