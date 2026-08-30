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

4. **Implement the web prototype** (`projects/<project>/web/`). DaisyUI v4 + Tailwind, no build step. Five things ship in the first commit, because retrofitting any of them later is a sweep across every file:
   - `index.html` — the shell only (theme boot, header, nav, one `<main data-view>` per screen). Semantic DaisyUI markup, not Pico.
   - `styles.css` — the token blocks first (theme-independent scales, then dark and light), *then* class families. Every colour is a token from the start; see `.claude/rules/theming.md`.
   - `domain/theme.js` — the light/dark controller, wired from `init.js`.
   - `ui/icons.js` — the vendored Phosphor subset and its render pass. Never an icon CDN.
   - `domain/view.js` — the `View` base class and the History-API `Router` with its path table, per `.claude/rules/web-frontend.md` § Routing & URLs. Ship `vercel.json`'s SPA rewrite with it.

   Then the app itself: `domain/<object>.js` per core object, one canonical render function in `ui/` per object, `views/<screen>-view.js` per route. Start single-file only if the whole app is under 300 lines; split at the threshold in `.claude/rules/web-frontend.md`.

   Mobile-first, max-width 480px for single-column apps. Loading, empty and error are three separate branches on every fetch. Choice lists are bottom sheets (`.claude/rules/overlays.md`).

5. **Test locally**, in both themes:
   ```bash
   cd shared-backend && uvicorn main:app --reload --port 8000
   # In another terminal:
   npx serve projects/<project>/web -l 5500 --no-clipboard
   ```
   Verify: data loads; the loading state shows and is not the empty state; a network failure shows the error branch with a retry; the page paints the right theme with no flash on reload; toggling the OS appearance follows live; every screen is legible in both themes; no request goes to an icon CDN.

6. **Update STRUCTURE.md** — Fill in:
   - Status: Prototype
   - Active Development Notes with what was built and what remains

Follow all conventions in the root CLAUDE.md, and the domain rules in `.claude/rules/` — for the web tier that means `web-frontend.md`, `theming.md`, `overlays.md`, `mobile-web.md`, `ui-object-design.md` and `assets.md`.
