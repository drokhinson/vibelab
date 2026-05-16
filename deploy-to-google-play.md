# Deploying a React Native App to Google Play

## One-Time Setup
- Create a **Google Play Developer Account** ($25 fee) at play.google.com/console
- Create your app in the Play Console (name, language, category)

## Prep Your Code
- Set a unique `package` name in `app.json` (e.g. `com.yourname.appname`) — permanent, choose carefully
- Set `version` and `versionCode` in `app.json`
- Add icons and a splash screen (Expo can generate these from a single image)

## Build the App Bundle
```bash
npm install -g eas-cli   # Install EAS CLI
eas login                # Log in to your Expo account
eas build:configure      # Generates eas.json
eas build --platform android --profile production  # Builds the .aab (~10–20 min)
```
Download the `.aab` file from the EAS dashboard when complete.

## Submit to Google Play
1. In Play Console: go to your app → **Production** → **Create new release**
2. Upload the `.aab` file (EAS can manage signing automatically)
3. Fill out the store listing:
   - Description
   - Screenshots (minimum 2)
   - Feature graphic
   - Content rating questionnaire
   - Privacy policy URL
4. Submit for review (first submission: a few hours to a few days)

## Time Estimate
- **First deployment:** half a day to a full day (mostly waiting on builds and review)
- **Subsequent updates:** ~30 minutes once familiar with the process

## Notes
- The store listing requirements (screenshots, privacy policy) are the most tedious part
- Once approved, subsequent updates skip the long review wait

---

## Publishing an Update / New Version

### 1. Bump Your Version Numbers
In `app.json`, update **both** fields before every release:
- `version` — human-readable (e.g. `"1.0.1"`), shown on the store listing
- `versionCode` — integer that must be **higher than the previous release** (e.g. `2`, `3`, `4`...)

```json
{
  "expo": {
    "version": "1.1.0",
    "android": {
      "versionCode": 2
    }
  }
}
```
> Google Play rejects uploads if `versionCode` is not strictly greater than the last published build.

### 2. Rebuild the App Bundle
```bash
eas build --platform android --profile production
```
Wait for the build to complete (~10–20 min) and download the new `.aab`.

### 3. Submit the New Release
1. Go to Play Console → your app → **Production** → **Create new release**
2. Upload the new `.aab`
3. Write **release notes** (what changed) — shown to users on the store listing
4. Click **Review release** → **Start rollout to Production**

### 4. Rollout Options
You can release to **100%** of users immediately, or use a **staged rollout**:
- e.g. release to 10% of users first, monitor crash reports, then expand to 100%
- Useful for catching issues before they affect everyone

### Review Time for Updates
- Minor updates: usually approved within **a few hours**
- Updates that change permissions, content, or core functionality may take **1–2 days**

---

## OTA Updates (Skip the Build Step for JS-Only Changes)

If your change is **JavaScript only** (no new native modules), you can push an update instantly without a new Play Store build using Expo's OTA (over-the-air) updates:

```bash
eas update --branch production --message "Fix login bug"
```

Users get the update silently in the background on next app launch — no store review needed. This only works for JS/asset changes, not native code changes.
