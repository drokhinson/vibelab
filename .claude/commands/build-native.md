Build the React Native app for project: $ARGUMENTS

Use the `mobile-dr` skill for deep React Native expertise. This command sets context.

The SauceBoss conversion (Phases 1–3 of the agent design + production shipping)
is the canonical reference. Mirror its directory layout and patterns when
converting a project unless STRUCTURE.md explicitly diverges.

## Steps

1. **Read `projects/$ARGUMENTS/STRUCTURE.md`** completely — especially Screen Flow and API Endpoints.

2. **Read the web prototype** at `projects/$ARGUMENTS/web/` to understand the UX flow and data shapes. The native app reproduces the same flow, not the same look. Pay attention to the global `state` shape (`web/state.js`) — you'll mirror it in a `useReducer` Context.

3. **Verify the backend is deployed** — check `STRUCTURE.md` for the Railway URL. If null, run `/build-prototype` first.

4. **Set up the shared/ layer** at `projects/$ARGUMENTS/shared/`. This is the single source of truth for everything web and native both need:
   - `constants.js` — UI lists, palette, unit-conversion tables, category order
   - `units.js` — `toTsp`, `cumulativeStepTsp`, `tspToDisplay`, `convertUnit`, `formatAmount`, `scaleAmount`, `prepareItems`
   - `colors.js` — ingredient color picker
   - `families.js` — variant/family grouping (`buildSauceFamilies`, `pickDisplayedFromFamily`, `familyHasFavorite`)
   - `filter.js` — sauce/ingredient filter helpers + `withIngredientNames`
   - `fuzzy.js` — autocomplete + ingredient-known check
   - `pieMath.js` — `polarToCartesian`, `arcPath`
   - `validation.js` — builder validation
   - `builder.js` — URL-import → builder transform (`applyParsedRecipe`, `unitDisplayFromParsed`, `ingNameInInstruction`)
   - `api.js` — `makeApi({ fetchFn, getAuthToken, baseUrl })` factory; one place that knows every backend endpoint
   - `themeTokens.js`, `copy.js` — palette + UI strings
   - `index.js` — convenience re-exports
   - `package.json` — `{ "name": "<project>-shared", "type": "module", "main": "index.js" }`

   Modules MUST be pure ESM, with no DOM and no React Native imports. State is passed in as parameters — the modules never read globals.

5. **Wire native to consume `shared/` via Metro alias**:
   - `app/metro.config.js`: alias `#shared` → `../shared`, add to `watchFolders`
   - In screens: `import { toTsp, ingColor } from '#shared';` or `from '#shared/units'`

6. **Bridge `shared/` into the web app** so web and native run the same logic:
   - Create `web/shared-bridge.js`:
     ```js
     import * as constants from './shared/constants.js';
     import * as units from './shared/units.js';
     // ...
     Object.assign(window, constants, units, /* identical-signature exports */);
     window.SBShared = { families, filter, fuzzy, builder, api };  // state-coupled
     ```
   - In `web/index.html`, load it as a module BEFORE all classics, and add `defer` to every existing `<script>` tag:
     ```html
     <script type="module" src="shared-bridge.js"></script>
     <script defer src="config.js"></script>
     <script defer src="state.js"></script>
     <!-- ...etc -->
     ```
     Module scripts and deferred classic scripts both run after parsing, in document order — globals are populated before `state.js` executes.
   - `web/build.sh` snapshots `../shared/` → `web/shared/` (Vercel only uploads files inside `web/`):
     ```bash
     HERE="$(cd "$(dirname "$0")" && pwd)"
     rm -rf "$HERE/shared" && cp -R "$HERE/../shared" "$HERE/shared"
     ```
     Add `projects/*/web/shared/` to root `.gitignore` — the snapshot is build output, not source.

   For functions whose signatures match across platforms (`toTsp`, `arcPath`, `levenshtein`, `buildSauceFamilies`, `withIngredientNames`, `ingColor`), expose them as flat globals via the bridge and delete web's duplicates. For helpers whose web version reads from `state` while shared takes context as a parameter (`isSauceAvailable`, `pickDisplayedFromFamily`, `applyParsedRecipe`, etc.), keep one-line shims in web that bind the state slice and delegate to `SBShared.<module>.<name>`.

7. **Implement `src/api/client.js`** — wrap `makeApi` from `#shared/api`:
   ```js
   import { makeApi } from '#shared/api';
   export const apiClient = makeApi({
     fetchFn: fetch,
     getAuthToken: () => supabase.auth.getSession().then(s => s.data.session?.access_token),
     baseUrl: process.env.EXPO_PUBLIC_API_URL,
   });
   ```
   Token-getter MUST read from `supabase.auth.getSession()`, NOT from React state — there's a render race on first sign-in where the React `session` lags behind Supabase's persisted session.

8. **Set up state**: React Context + `useReducer`, split read/write contexts to avoid blanket re-renders. Slices: `meal`, `selection`, `sauces`, `filter`, `favorites`, `auth`, `builder`. Mirror the web's global `state` shape from `web/state.js`.

9. **Implement screens** (`src/screens/`) — one per Screen Flow entry. Reference SauceBoss patterns:
   - `MealBuilderScreen` — `FlatList numColumns={2}` of items, animated `PotIllustration` hero, category tabs
   - `SauceSelectorScreen` — `SectionList` of cuisine accordions, family grouping via `buildSauceFamilies`, ingredient filter panel
   - `MealRecipeScreen` — step cards with pie charts, servings stepper, unit toggle, marinade ordering
   - `SauceBuilderScreen` (+ items + review) — multi-step wizard, `react-hook-form` with `useFieldArray`, URL import via `applyParsedRecipe`
   - `SettingsScreen` — profile, become-admin, sign-out, delete-profile

   All data via `apiClient`. No direct `fetch()` in screens. Always render loading + error states (use `LoadingPot` and an EmptyState component).

10. **Wire navigation** in `App.js` using `@react-navigation/native-stack`. Wrap in `AppProvider`, load Inter fonts, register every screen.

11. **Auth (Supabase)**:
    - `src/auth/supabase.js` — `createClient(URL, ANON_KEY, { auth: { storage: secureStorageAdapter, persistSession: true, autoRefreshToken: true, flowType: 'pkce' } })`
    - `src/auth/secureStorage.js` — adapter wrapping `expo-secure-store` (encrypts at rest)
    - `AuthModal` — email + password + Google "Continue with Google" button (real 4-color G via `react-native-svg`)
    - `onAuthStateChange` listener → dispatch `SET_SESSION` → fetch `/profile` (auto-create on 404) → fetch `/favorites`

12. **Google OAuth via `expo-auth-session` + a web bridge** (Apple Sign-In needs a real device — defer if you don't have one):
    - Supabase rejects non-`https` `redirectTo`, so route through a hosted bridge page on the web app:
      `redirectTo: 'https://<project>.vercel.app/auth-callback.html?native_url=' + encodeURIComponent(makeRedirectUri({ scheme }))`
    - The bridge HTML extracts the `code` (PKCE) or `access_token`/`refresh_token` (implicit) from the URL and forwards them to the native deep link
    - Allowlist `https://<project>.vercel.app/**` in Supabase Auth → URL Configuration → Redirect URLs

13. **Configure `app.json`**:
    - `expo.slug` → project id; `scheme` → project name; `bundleIdentifier`/`android.package` → `com.<project>.app`
    - Adaptive icon: `foregroundImage` over `backgroundColor` (must match the icon BG)
    - `intentFilters` for the OAuth scheme on Android, `CFBundleURLTypes` on iOS
    - Plugins: `expo-secure-store`, `expo-web-browser`, etc.

14. **Generate icons** via `app/scripts/generate-icons.mjs` (`sharp` SVG → PNG):
    - `icon.svg` → `icon.png` 1024×1024
    - `adaptive-icon.svg` → `adaptive-icon.png` 1024×1024 (transparent BG, content inside the inner ~660×660 safe area)
    - `splash.svg` → `splash.png` 1284×2778
    - `favicon.svg` → `favicon.png` 64×64
    - `feature-graphic.svg` → `feature-graphic.png` 1024×500 (Play Store listing)
    - Commit the generated PNGs so EAS doesn't depend on contributors having `sharp`

15. **Test with Expo Go**:
    ```bash
    cd projects/$ARGUMENTS/app
    npm install
    # Set EXPO_PUBLIC_API_URL, EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY in .env
    npx expo start
    ```
    Scan QR with Expo Go. Test on iOS + Android simulators in addition to a real device.

16. **EAS production build pipeline** (Android first; iOS submission needs an Apple Developer account):
    - `eas init` → populates `extra.eas.projectId` in app.json
    - **Push env vars to EAS** — local `.env` is NOT bundled into builds:
      ```bash
      eas env:create --environment production --name EXPO_PUBLIC_API_URL --value "..." --visibility plaintext
      eas env:create --environment production --name EXPO_PUBLIC_SUPABASE_URL --value "..." --visibility plaintext
      eas env:create --environment production --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "..." --visibility sensitive
      ```
    - **Commit `app/package-lock.json`** — EAS Build runs expo-doctor which fails with "No lock file detected". The repo `.gitignore` excludes lock files globally; carve an exception:
      ```
      package-lock.json
      !projects/*/app/package-lock.json
      ```
    - **Drop `channel` from `eas.json` profiles** unless `expo-updates` is wired — otherwise EAS prompts to install it on every production build
    - `eas build --profile production --platform android` → download the `.aab` → upload manually via Play Console → Internal Testing → Create new release
    - Service account JSON for `eas submit` is optional; manual upload works indefinitely

17. **Play Store assets**:
    - Privacy policy URL — host at `web/privacy.html`
    - Delete-account URL — host at `web/delete-account.html` (separate field, can't reuse the privacy URL)
    - Short description (≤ 80 chars) + full description (≤ 4000 chars)
    - Feature graphic 1024×500
    - Screenshots from Expo Go on simulator

18. **Update STRUCTURE.md and registry.json**:
    - Status: Live Native
    - `hasNativeApp: true`, `expoSlug: <slug>`
    - Document any deferred features (admin manager, OAuth providers, EAS Update channels)

Do NOT use `expo-sqlite` or local data files. All data comes from the shared backend.

---

## Common gotchas (collected from the SauceBoss conversion)

**Native runtime / boot**
- **Hermes URL polyfill**: `Cannot assign to property 'protocol' of undefined` on launch. Add `import 'react-native-url-polyfill/auto';` at the very top of `App.js` (before any other import).
- **"main has not been registered"** masks the real load error. Wrap the main module in a try/catch boundary in `App.js`:
  ```js
  let MainApp;
  try { MainApp = require('./src/MainApp').default; }
  catch (err) { /* render error screen with err.stack */ }
  ```
  Keep the boundary in place permanently — it surfaces useful diagnostics later.
- **Reanimated 4** requires `react-native-worklets/plugin` in `babel.config.js` (last in the plugin list).

**Supabase + OAuth**
- **Sanitize Supabase env vars** — strip quotes, whitespace, trailing slashes. "Invalid path specified in url" on signup usually means the URL has a stray newline.
- **PKCE vs implicit flow**: setting `flowType: 'pkce'` makes redirects return `?code=`; without it you get `#access_token=`. The bridge HTML must handle both shapes.
- **Concurrent `exchangeCodeForSession` calls**: WebBrowser's auth-session result AND a Linking listener may both try to exchange the same code. Dedupe via a `Map<code, promise>`.
- **Token-getter race on first sign-in**: read directly from `supabase.auth.getSession()` — not from a React state ref. The auth state propagates through Supabase before React renders.
- **Email auto-confirm**: if Supabase email confirmation is OFF, sign up should auto-sign in. Don't show a "check your email" screen unconditionally.

**API + data shapes**
- **Pydantic 422 errors render as "[object Object]"** in RN. The shared API client coerces FastAPI's `detail` (string | dict | array) to a single readable string in `formatErrorDetail`.
- **`description: null` vs `""`** — Pydantic non-Optional `str` rejects `null`. Send empty string when the field is unset.
- **Array → dict normalization**: `/ingredient-categories` and `/substitutions` return arrays from the backend, but the web/native consumers expect a dict. Normalize in `shared/api.js` so it's the same shape everywhere.
- **URL recipe import field names**: backend sends `parsed.instructions[]` (strings), `parsed.ingredients[].foodRaw`, `quantity`, `unitRaw` — NOT `steps`/`name`/`amount`/`unit`. Match `ParsedRecipeResponse` exactly in the importer.
- **DELETE `/sauces/{id}` vs `/admin/sauces/{id}`**: the public route is owner-or-admin; the admin route bypasses the owner check. Use the public one for "delete my sauce" flows so non-admins succeed.

**EAS / production**
- **Local `.env` is NOT bundled** — push every `EXPO_PUBLIC_*` var to EAS production environment via `eas env:create` or the dashboard.
- **expo-doctor "No lock file detected"** — commit `app/package-lock.json` (with the `.gitignore` carve-out above).
- **`eas.json` `channel` field** without `expo-updates` triggers an "install expo-updates?" prompt on every build. Drop it or wire updates.
- **Manual Play Console upload** is fine for a first release — service-account JSON is only needed if you want `eas submit` to push the `.aab` automatically.
- **Play Console "service account" lives at the developer-account level**, not inside an app. Setup → API access → Create new service account → links to GCP Console for the actual key.

**Native UX parity**
- **Pie chart layout**: web and native should both render pie + ingredient list side-by-side, not stacked. Web uses `display: flex; flex-direction: row` on `.pie-container`; native uses the same in `StepCard`.
- **Marinade ordering**: when `sauceType === 'marinade'`, render the marinade section BEFORE the item-prep section. Reverse for sauce/dressing.
- **Family default favorite**: when a user has favorited a variant, that variant becomes the default displayed sauce in selector + recipe. `pickDisplayedFromFamily` from `shared/families.js` handles the precedence.
- **Diagnostic logs**: leave behind dev `console.log`s in production-bound code only when they're cheap and safe. Strip noisy ones once the flow is stable.
