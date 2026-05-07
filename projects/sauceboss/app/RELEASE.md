# Releasing SauceBoss to the Play Store

Android-only walkthrough — Apple Sign-In + iOS submission are deferred. Everything below assumes you're working from `projects/sauceboss/app/` and you've already merged the feature branch into `main`.

## One-time setup

### 1. Tooling

```powershell
npm install -g eas-cli
eas login
```

Use the same Expo account that owns the `sauceboss` slug.

### 2. Connect this repo to an EAS project

From the app directory:

```powershell
eas init
```

That command creates a project on your Expo account, drops its UUID into `app.json` → `expo.extra.eas.projectId`, and prints the dashboard link. Commit the resulting `app.json` change.

### 3. Google Play Console

- Create a Google Play Developer account at <https://play.google.com/console> — one-time $25.
- Create the app: name "SauceBoss", default language English, free.
- Fill out the required content rating + privacy policy + data safety surveys (Play won't approve a release without them).
- Create a service account so EAS can push builds:
  1. Play Console → Setup → API access → "Create new service account"
  2. Follow the link to Google Cloud Console, create a service account with the `Service Account User` role
  3. Generate a JSON key, download it
  4. Back in Play Console, grant the service account access (Admin role for the SauceBoss app)
  5. Move the JSON file to `projects/sauceboss/app/play-service-account.json` (gitignored — see below)

The `eas.json` `submit.production.android.serviceAccountKeyPath` field already points at this file.

### 4. Gitignore the service account JSON

Add to the root `.gitignore` (next to the `.env` entries):

```
play-service-account.json
```

Don't commit it.

## Building

### Development build (unlocks features Expo Go can't run)

A dev build replaces Expo Go with an APK that uses your real `sauceboss://` scheme. Useful for testing OAuth flows that don't survive Expo Go's `exp://` proxying, native modules added later, etc.

```powershell
eas build --profile development --platform android
```

EAS prints a download link when done; install the APK on your phone, then run `npx expo start --dev-client` instead of plain `expo start`.

### Internal preview build

What you'll hand to early testers. Uses the same `production` configuration but distributes the APK directly via a download link instead of going through Play.

```powershell
eas build --profile preview --platform android
```

### Production build (Play Store binary)

Generates an `.aab` (Android App Bundle) signed by EAS:

```powershell
eas build --profile production --platform android
```

Wait for it to finish (typically 10-20 minutes). The dashboard shows a `Download` link — but you don't need to download it; `eas submit` does it for you.

## Submitting

After a successful production build, submit straight to Play Internal Testing:

```powershell
eas submit --profile production --platform android
```

EAS reads `eas.json` `submit.production.android`, picks up the latest build, uses the service account JSON to upload to the Internal track. From Play Console you can promote the release through Closed Testing → Open Testing → Production once you've checked it in real conditions.

## Versioning

`appVersionSource: "remote"` in `eas.json` means EAS owns the version code (`android.versionCode`) automatically. The first production build will be `1`, subsequent ones increment. The `version` field in `app.json` (the user-facing string like `1.0.0`) you bump manually before each release.

## Updating icons / splash later

The actual PNGs Expo uses are committed to `assets/`. To regenerate them after editing the SVG sources:

```powershell
cd projects/sauceboss/app
npm i -D sharp
node scripts/generate-icons.mjs
git add assets/*.png
git commit -m "[sauceboss] regenerate app icons"
```

The `sharp` package only needs to be installed when you're regenerating; you can drop it from `devDependencies` afterwards if you don't want a heavy native module in normal installs.

## Things to set up before going to production

These are tracked in the audit but not strictly blocking for an Internal testing release:

- **Privacy policy URL** — Play Console requires it before any production release. Host one on the SauceBoss web app or any other domain you control.
- **App Store listing assets** — Play wants a 512x512 icon, 1024x500 feature graphic, and at least 2 phone screenshots. Capture screenshots from a real preview build.
- **Crash reporting** — Sentry / EAS Insights / similar. We're not wiring this yet.
- **Analytics opt-in** — the analytics ping in `src/utils/analytics.js` fires on every app open; if Play's data-safety form prompts you, declare it.

## When you're ready for iOS

You'll need:
- Apple Developer account ($99/yr)
- Mac (or [EAS-hosted iOS builds](https://docs.expo.dev/build/setup/) which work without one)
- `expo-apple-authentication` package wired into the AuthModal alongside the Google button
- Update `eas.json` to add `ios` blocks under each profile
- Add an `ios.bundleIdentifier`, `ios.appStoreUrl`, etc.

Open a separate task when that day comes.
