---
paths:
  - "projects/*/app/**"
---

# React Native / Expo Conventions (`projects/[name]/app/`)

- Expo managed workflow (bare only when a native module requires it).
- All API calls go through `src/api/client.js`. Never call `fetch()` directly in a screen.
- Navigation: `@react-navigation/native-stack`.
- Theme tokens go in `src/theme.js`.
- Do NOT use `expo-sqlite`. Use the shared API client.
- Set `EXPO_PUBLIC_API_URL` in `app/.env` for the Railway backend URL.

## Add a React Native screen
1. Create `projects/[name]/app/src/screens/[ScreenName].js`
2. Register in the navigator in `App.js`
3. Add any new API calls to `src/api/client.js`
4. Update STRUCTURE.md → Screen Flow section
