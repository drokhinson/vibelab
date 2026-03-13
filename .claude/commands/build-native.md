Build the React Native app for project: $ARGUMENTS

Use the `mobile-dr` skill for deep React Native expertise. This command sets context.

## Steps

1. **Read STRUCTURE.md** at `projects/$ARGUMENTS/STRUCTURE.md` completely — especially Screen Flow and API Endpoints.

2. **Read the web prototype** at `projects/$ARGUMENTS/web/app.js` to understand the UX flow and data shapes. The native app reproduces the same flow, not the same look.

3. **Verify the backend is deployed** — Check `STRUCTURE.md` for the Railway backend URL. If null, build-prototype must be completed and deployed first.

4. **Implement `src/api/client.js`** — One fetch wrapper per endpoint from STRUCTURE.md. Pattern from `_templates/app/src/api/client.js`.

5. **Implement screens** (`src/screens/`):
   - One file per screen from STRUCTURE.md Screen Flow
   - Reference SauceBoss screens (`projects/sauceboss/app/src/screens/`) for patterns
   - All data via `src/api/client.js` — no direct `fetch()` in screens
   - Always handle loading + error states

6. **Wire navigation** in `App.js` using `@react-navigation/native-stack`. Reference SauceBoss `App.js`.

7. **Add shared components** to `src/components/` if reused across screens.

8. **Configure app.json** — Set `expo.slug` to the project ID, `bundleIdentifier` to `com.vibelab.<project-id>`.

9. **Test with Expo Go**:
   ```bash
   cd projects/$ARGUMENTS/app
   npm install
   # Set EXPO_PUBLIC_API_URL in app/.env to Railway URL
   npx expo start
   ```
   Scan QR with Expo Go. Test on both iOS and Android simulators.

10. **Update STRUCTURE.md**:
    - Status: Live Native
    - hasNativeApp: true
    - expoSlug: <slug>

11. **Update registry.json** — Set `hasNativeApp: true`, `expoSlug`.

Do NOT use expo-sqlite or local data files. All data comes from the shared backend.
