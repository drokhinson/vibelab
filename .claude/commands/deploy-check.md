Check deployment status for project: $ARGUMENTS

## Steps

1. **Read `projects/$ARGUMENTS/STRUCTURE.md`** — note the backend URL and web URL.

2. **Check the backend health**:
   - If `backendUrl` is set: fetch `<backendUrl>/api/v1/$ARGUMENTS/health`
   - Expected response: `{"project": "$ARGUMENTS", "status": "ok"}`
   - Report: response status, latency, any error

3. **Check `registry.json`** for the project entry:
   - Verify `status`, `webUrl`, `backendUrl`, `hasNativeApp` are all current
   - Flag any fields that are still `null` but should be set

4. **Check `shared-backend/main.py`**:
   - Confirm the project's router is imported and registered
   - If not, report what needs to be added

5. **Check `shared-backend/routes/$ARGUMENTS.py`** (replacing hyphens with underscores):
   - List all routes defined
   - Verify they match what STRUCTURE.md says

6. **Check `db/migrations/$ARGUMENTS/`** (and `db/migrations/_shared/` for cross-app changes):
   - List migration files for this project (001_baseline.sql, optional 002_seed.sql, plus any later per-app migrations)
   - Note any that are present but not yet run (if you can tell from context)

7. **Check `.github/workflows/`**:
   - Confirm `deploy-frontend.yml` will pick up this project's web/ changes
   - Confirm the Vercel project secret name (`VERCEL_<PROJECT_ID_UPPERCASE>_PROJECT_ID`)

8. **Summary report**:
   ```
   Project: $ARGUMENTS
   ├── Backend:  [live/not deployed] — <URL or 'null'>
   ├── Web:      [live/not deployed] — <URL or 'null'>
   ├── Native:   [yes/no]
   ├── Registry: [up to date / needs update]
   └── Issues:   [list any problems found]
   ```
