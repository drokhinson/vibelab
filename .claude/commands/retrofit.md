Retrofit an existing project into the vibelab pipeline structure.

Project to retrofit: $ARGUMENTS

## Steps

1. **Read the existing project** at `projects/$ARGUMENTS/` (or wherever it currently lives). Understand:
   - Current file structure
   - Tech stack and data layer
   - What files exist vs what the vibelab structure expects

2. **Gap analysis** — Compare against the expected structure:
   ```
   projects/$ARGUMENTS/
   ├── STRUCTURE.md  ← exists?
   ├── web/          ← exists? uses fetch() or inline data?
   └── app/          ← exists? uses local DB or API?
   shared-backend/routes/$ARGUMENTS.py  ← exists?
   db/migrations/*_$ARGUMENTS_*.sql     ← exists?
   registry.json entry                  ← exists?
   ```

3. **Propose a migration plan** — List:
   - Files to move (with source → destination)
   - Files to create (what they need to contain)
   - Files to modify (what specific changes are needed)
   - What existing code is preserved (zero changes)
   - Estimated risk level for each change

4. **Show the plan to the user and wait for approval** before making any changes.

5. **Execute the approved plan**:
   - Move files
   - Create STRUCTURE.md (draw from existing docs if available)
   - Create FastAPI routes in `shared-backend/routes/`
   - Register the router in `shared-backend/main.py`
   - Write DB migrations if moving from SQLite/local data to Supabase
   - Update web frontend to use `fetch()` instead of inline data
   - Update React Native app to use `src/api/client.js` instead of local DB
   - Add entry to `registry.json`

6. **Test the retrofit**:
   - Backend: `curl http://localhost:8000/api/v1/$ARGUMENTS/health`
   - Web: Open `projects/$ARGUMENTS/web/index.html` and verify data loads
   - App: `npx expo start` and verify screens load data

Use SauceBoss as the reference implementation for the target state.
