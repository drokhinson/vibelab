# Google Sign-In setup

The "Continue with Google" button in the AuthModal needs configuration in **Google Cloud Console** + **Supabase Auth** before it works end-to-end. Here's the order of operations.

## 1. Create OAuth credentials in Google Cloud Console

1. <https://console.cloud.google.com/> → make a project (or pick an existing one)
2. **APIs & Services → OAuth consent screen**
   - User Type: **External**
   - App name, support email, dev contact email — fill in
   - Add scopes: `userinfo.email`, `userinfo.profile`, `openid`
   - Add yourself as a test user while it's in "Testing" mode
3. **APIs & Services → Credentials → + Create Credentials → OAuth client ID**
   - Application type: **Web application** (yes — even for native; Supabase brokers the flow on its own domain)
   - Name: `SauceBoss web`
   - **Authorized redirect URIs**: `https://<your-project-ref>.supabase.co/auth/v1/callback`
   - Click Create. Copy the **Client ID** + **Client secret**.

## 2. Wire the credentials into Supabase

1. Supabase Dashboard → your project → **Authentication → Providers → Google**
2. Toggle **Enable**
3. Paste the **Client ID** and **Client Secret** from step 1
4. The "Callback URL" Supabase shows you must match the redirect URI you added to Google Cloud (one round-trip — the values must be identical)
5. Save

## 3. Allowlist the app's redirect URI

This is the URL Google redirects to *after* Supabase finishes its leg of the OAuth dance — i.e. the URL that opens our app.

1. Supabase Dashboard → **Authentication → URL Configuration → Redirect URLs**
2. Add **all** of these:
   - `sauceboss://auth-callback` — used by EAS dev/preview/production builds
   - `exp://**.exp.direct/**` — used by Expo Go's tunnel mode (the one `npx expo start --tunnel` opens)
   - `exp://192.168.*.*:*` — used by Expo Go on a LAN

   The wildcards are intentional; Supabase supports them.

## 4. Test it

### From Expo Go

```powershell
cd C:\CodeProjects\vibelab\projects\sauceboss\app
git pull
npm install
npx expo start --tunnel
```

Tap "Continue with Google" in the AuthModal. The system browser opens, picks your Google account, and redirects back to Expo Go. The avatar pill should replace the Sign-in button on the home header.

If the redirect fails: re-check that `exp://**.exp.direct/**` is in Supabase's allowlist and that the project's "Site URL" (also under URL Configuration) is set to one of your allowed redirects.

### From an EAS build

```powershell
npm install -g eas-cli
eas login
eas build:configure
eas build --profile preview --platform android
```

The preview APK uses `sauceboss://auth-callback` as the redirect — that one is already in your allowlist after step 3.

## Common issues

- **"Invalid redirect URL"** in the browser after Google returns: the URL the browser ended up at isn't in Supabase's allowlist. Open the URL in the error message and add it (or its wildcard form) to Authentication → URL Configuration.
- **"Provider is not enabled"**: forgot to toggle Google on in Authentication → Providers.
- **Redirect succeeds but signs me out immediately**: the Supabase session is stored in `expo-secure-store`, which fails silently on iOS Simulator without a Keychain passcode. Either set a passcode in the simulator's settings or run on a real device. (Our `secureStorage` adapter falls back to AsyncStorage but the failure mode there can confuse Supabase's session validator.)
- **Hangs in "Sign-in is not configured for this build"**: `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` aren't set in `app/.env`, or have stray quotes/whitespace.

## Apple Sign-In note

If/when you ship this on the App Store and Google Sign-In is offered, **App Store Review Guideline 4.8 requires Apple Sign-In to be offered alongside.** Apple sign-in needs `expo-apple-authentication` (different package, different setup) and only works on a real device or EAS build. We haven't wired it yet — open a follow-up when you're ready to submit to TestFlight.
