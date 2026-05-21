Add Supabase Auth to project: $ARGUMENTS

## Steps

1. **Read STRUCTURE.md** — confirm auth is appropriate for this project. Note which endpoints need protection.

2. **Supabase setup** (user must do this in Supabase dashboard):
   - Enable Email auth (or chosen provider) in Authentication → Providers
   - **For OAuth providers (Google, Apple, etc.):** add the project's deployed URL to Authentication → URL Configuration → **Redirect URLs** allow-list. Both the bare origin and a `/**` wildcard entry:
     ```
     https://vibelab-<project>.vercel.app
     https://vibelab-<project>.vercel.app/**
     ```
     Without this, Supabase silently ignores the code's `redirectTo` and falls back to **Site URL** (default `http://localhost:3000`) — OAuth will appear to succeed then land on an unreachable localhost page on mobile.
   - Inform the user: "Please enable authentication in your Supabase dashboard before I proceed."

3. **Web prototype auth** (`projects/$ARGUMENTS/web/`):
   - Add Supabase JS client via CDN: `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>`
   - Add to `config.js`: `supabaseUrl` and `supabaseAnonKey`
   - Add login/signup form to `index.html`
   - Add auth state management to `app.js` using `supabase.auth.onAuthStateChange()`
   - Add the JWT to fetch requests: `Authorization: Bearer <token>` header
   - **OAuth button visuals:** if Google / Apple sign-in is enabled, follow `.claude/rules/auth-ui.md` for the canonical inline-SVG provider logos, full-width pill buttons (`.auth-oauth-btn` + `.auth-oauth-google` / `.auth-oauth-apple`), and the "or use email" hairline divider. Reference implementation: `projects/daywordplay/web/auth.js` + `styles.css`. Do **not** use Lucide icons or emoji for provider marks.
   - **Handle the duplicate-email silent success.** All vibelab apps share one Supabase `auth.users` table, so it's *common* (not edge) for a user who signed up for one app to "sign up" again on another. `supabase.auth.signUp()` does NOT return an error in that case — it returns a synthetic user with `identities: []` and sends no email (anti-enumeration). Detect this and flip the UI to sign-in mode so the user can link their existing password instead of waiting for a confirmation email that will never come:
     ```js
     const { data, error } = await supabase.auth.signUp({ email, password });
     if (error) throw error;
     if (data?.user && (data.user.identities?.length ?? 0) === 0) {
       // Existing vibelab user — switch to sign-in with email pre-filled.
       state.authMode = 'login';
       state.authError = 'An account with this email already exists in another vibelab app. Sign in with your existing password to link <App>.';
     }
     ```
     Reference implementations: `projects/boardgame-buddy/web/views/auth-view.js` (`submit()`) and `projects/sauceboss/web/auth.js` (`handleEmailSubmit()`).

4. **FastAPI auth middleware** (`shared-backend/`):
   - Add `PyJWT` and `httpx` to requirements.txt
   - Create `shared-backend/auth.py` with a `verify_token(credentials)` dependency
   - Add `Depends(verify_token)` to endpoints that require auth
   - The middleware validates the Supabase JWT using the project's JWT secret
   - **Auto-create the app's profile on first authenticated request.** Because every vibelab app shares one `auth.users` table, a user may have a valid JWT but no `<app>_profiles` row yet (signed up via another app, or via OAuth straight into yours). Don't let `GET /profile` 404 the first request — wire **every** authenticated endpoint (including `GET /profile`) through a `get_current_user` dependency that SELECTs the profile and INSERTs it if missing. Canonical reference: `shared-backend/routes/boardgame_buddy/dependencies.py` (the `get_current_user` dep + `_derive_username` collision-safe handle generator). The simpler upsert variant lives in `shared-backend/routes/sauceboss/profile_routes.py` (`POST /profile` with `on_conflict="id"`).

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
