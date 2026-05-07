# Google Sign-In setup

The native app's "Continue with Google" button uses a **web-bridge** flow because
the vibelab Supabase project is shared across multiple apps. Supabase's OAuth
callback rejects non-https `redirectTo` values like `exp://...` even when
they're in the allowlist — falling back to the project's Site URL (which is
currently boardgame buddy). Routing through `https://sauceboss-omega.vercel.app/auth-callback.html`
sidesteps that entirely.

## How the flow works

1. Native app → asks Supabase for an OAuth URL with
   `redirectTo = https://sauceboss-omega.vercel.app/auth-callback.html#native_url=<encoded sauceboss:// or exp:// URL>`.
2. Supabase → opens Google's consent screen.
3. Google → redirects to Supabase's OAuth callback.
4. Supabase → redirects browser to the bridge with `?code=...`.
5. Bridge JS → reads `code` from query, `native_url` from fragment, redirects browser to
   `<native_url>?code=...`.
6. OS → opens SauceBoss app via `sauceboss://` deep link (or Expo Go via `exp://`).
7. App's Linking listener → catches the URL, parses `code`, calls
   `supabase.auth.exchangeCodeForSession(code)`. Session lands.

## 1. Create OAuth credentials in Google Cloud Console

1. <https://console.cloud.google.com/> → make a project (or pick an existing one).
2. **APIs & Services → OAuth consent screen**:
   - User Type: **External**.
   - App name, support email, dev contact email — fill in.
   - Add scopes: `userinfo.email`, `userinfo.profile`, `openid`.
   - Add yourself as a test user while it's in "Testing" mode.
3. **APIs & Services → Credentials → + Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Name: `SauceBoss web`.
   - **Authorized redirect URIs**: `https://<your-project-ref>.supabase.co/auth/v1/callback`.
   - Click Create. Copy the **Client ID** + **Client secret**.

## 2. Wire the credentials into Supabase

1. Supabase Dashboard → your project → **Authentication → Providers → Google**.
2. Toggle **Enable**.
3. Paste the **Client ID** and **Client Secret**.
4. Save.

## 3. Allowlist the bridge URL

Supabase Dashboard → **Authentication → URL Configuration → Redirect URLs**.
Add:

```
https://sauceboss-omega.vercel.app/**
```

That single entry covers both the bridge page (`/auth-callback.html`) and any
future https-served helpers. You don't need any `exp://...` or `sauceboss://...`
entries — those targets are handled client-side by the bridge JS, never seen by
Supabase's allowlist.

## 4. Deploy the bridge HTML

The bridge page lives at `projects/sauceboss/web/auth-callback.html`. The
SauceBoss web app deploys via `bash projects/sauceboss/web/build.sh` and the
Vercel auto-deploy on `main`. So:

1. Merge the branch to `main`.
2. Vercel redeploys `https://sauceboss-omega.vercel.app/`.
3. The bridge becomes live at `https://sauceboss-omega.vercel.app/auth-callback.html`.

You can verify the bridge is live by opening the URL with a fake code:

```
https://sauceboss-omega.vercel.app/auth-callback.html?code=test#native_url=sauceboss%3A%2F%2Fauth-callback
```

The page should briefly show "Returning you to SauceBoss" and then offer the
fallback button.

## 5. Test

### Expo Go

```powershell
cd C:\CodeProjects\vibelab\projects\sauceboss\app
git pull
npm install
npx expo start --tunnel
```

Tap "Continue with Google" → Google consent screen → bridge appears for ~1
second → app reopens with the avatar pill replacing the Sign-in button.

If Expo Go shows a "How do you want to open this link?" dialog — pick **Expo Go**.

### EAS dev / preview builds

The bridge sets `native_url` to `sauceboss://auth-callback`, which is registered
via the `scheme` + `intentFilters` in `app.json`. Once you build with EAS, the
flow works the same way; the only difference is the bridge sends the user to
`sauceboss://...` instead of `exp://...`.

## Common issues

- **"Couldn't reach the kitchen" right after sign-in**: the session is in,
  but the API client retried the initial-load before the auth token was
  attached. Pull-to-refresh or restart the app.
- **Bridge page shows "No auth code returned"**: Supabase didn't append `code`
  to the redirect — usually means Google redirect URI in step 1 doesn't match
  the project's `https://<project>.supabase.co/auth/v1/callback`.
- **Bridge page never opens, browser stays on Supabase**: the bridge URL isn't
  allowlisted (step 3). Add `https://sauceboss-omega.vercel.app/**`.
- **"Open with…" dialog every time on Android**: tap the option to set as
  default for `sauceboss://` URLs and it'll stop prompting.

## Apple Sign-In

If/when you ship to the App Store with Google Sign-In offered, **App Store
Review Guideline 4.8 requires Apple Sign-In as well.** That needs
`expo-apple-authentication` (different package, real device or EAS build only).
Open a follow-up before TestFlight.
