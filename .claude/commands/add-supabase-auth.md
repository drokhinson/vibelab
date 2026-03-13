Add Supabase Auth to project: $ARGUMENTS

## Steps

1. **Read STRUCTURE.md** — confirm auth is appropriate for this project. Note which endpoints need protection.

2. **Supabase setup** (user must do this in Supabase dashboard):
   - Enable Email auth (or chosen provider) in Authentication → Providers
   - Inform the user: "Please enable authentication in your Supabase dashboard before I proceed."

3. **Web prototype auth** (`projects/$ARGUMENTS/web/`):
   - Add Supabase JS client via CDN: `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>`
   - Add to `config.js`: `supabaseUrl` and `supabaseAnonKey`
   - Add login/signup form to `index.html`
   - Add auth state management to `app.js` using `supabase.auth.onAuthStateChange()`
   - Add the JWT to fetch requests: `Authorization: Bearer <token>` header

4. **FastAPI auth middleware** (`shared-backend/`):
   - Add `PyJWT` and `httpx` to requirements.txt
   - Create `shared-backend/auth.py` with a `verify_token(credentials)` dependency
   - Add `Depends(verify_token)` to endpoints that require auth
   - The middleware validates the Supabase JWT using the project's JWT secret

5. **React Native auth** (`projects/$ARGUMENTS/app/`):
   - `npm install @supabase/supabase-js`
   - Create `src/api/supabase.js` with a Supabase client using `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`
   - Add login and registration screens
   - Update `App.js` to check `supabase.auth.getSession()` on startup and redirect accordingly
   - Pass JWT in API client requests

6. **Row Level Security** (write SQL for user to run in Supabase dashboard):
   - Enable RLS on tables that contain user data: `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;`
   - Write policies for read/write based on `auth.uid()`

7. **Update STRUCTURE.md**:
   - Auth: enabled
   - Document which endpoints require auth
   - Add `SUPABASE_JWT_SECRET` to Environment Variables table

8. **Update `.env.example`** with new required variables.
