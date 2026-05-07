Build the React Native app for project: $ARGUMENTS

Use the `mobile-dr` skill for deep React Native expertise. This command sets context.

## Steps

1. **Read `projects/$ARGUMENTS/STRUCTURE.md`** completely — especially Screen Flow and API Endpoints.

2. **Read the web prototype** at `projects/$ARGUMENTS/web/` to understand the UX flow and data shapes. The native app reproduces the same flow, not the same look. Pay attention to the global `state` shape (`web/state.js`) — you'll mirror it in a `useReducer` Context.

3. **Verify the backend is deployed** — check `STRUCTURE.md` for the Railway URL. If null, run `/build-prototype` first.

4. **Set up the `shared/` layer** at `projects/$ARGUMENTS/shared/`. This is the single source of truth for everything web and native both need. Common modules:
   - `constants.js` — UI lists, palette, lookup tables, category orderings
   - `units.js` — domain conversions, scaling functions
   - `colors.js` — palette / color-picking helpers
   - `families.js` — domain grouping helpers (e.g., parent-variant trees)
   - `filter.js` — list filter / query helpers + any "attach derived field" wrappers
   - `fuzzy.js` — autocomplete + known-name checks
   - `pieMath.js` (etc.) — pure geometry / math used by visualizations
   - `validation.js` — form validation rules
   - `builder.js` — domain-form transforms (e.g., URL import → form state)
   - `api.js` — `makeApi({ fetchFn, getAuthToken, baseUrl })` factory; one place that knows every backend endpoint
   - `themeTokens.js`, `copy.js` — palette tokens + UI strings
   - `index.js` — convenience re-exports
   - `package.json` — `{ "name": "<project>-shared", "type": "module", "main": "index.js" }`

   Modules MUST be pure ESM, with no DOM and no React Native imports. State is passed in as parameters — the modules never read globals.

5. **Wire native to consume `shared/` via Metro alias**:
   - `app/metro.config.js`: alias `#shared` → `../shared`, add to `watchFolders`
   - In screens: `import { fooBar, bazQux } from '#shared';` or `from '#shared/units'`

6. **Bridge `shared/` into the web app** so web and native run the same logic. Web uses vanilla `<script>` tags (no bundler), so a single ES-module bridge does the work:
   - Create `web/shared-bridge.js`:
     ```js
     import * as constants from './shared/constants.js';
     import * as units from './shared/units.js';
     // ...repeat for each module
     // Identical-signature helpers → flat globals
     Object.assign(window, constants, units, colors, pieMath);
     // State-coupled helpers → namespaced (web shims bind state, then delegate)
     window.SBShared = { families, filter, fuzzy, builder, api };
     ```
   - In `web/index.html`, load the bridge as a module BEFORE all classics, and add `defer` to every existing `<script>` tag:
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

   For functions whose signatures match across platforms, expose them as flat globals via the bridge and delete web's duplicates. For helpers whose web version reads from `state` while shared takes context as a parameter, keep one-line shims in web that bind the state slice and delegate to `SBShared.<module>.<name>`.

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

8. **Set up state**: React Context + `useReducer`. Split read/write contexts to avoid blanket re-renders. Define one slice per top-level concern from the web's global `state` shape.

9. **Implement screens** (`src/screens/`) — one per Screen Flow entry. Common patterns:
   - **List/grid screens** — `FlatList numColumns={2}` for tile grids; `SectionList` with manual expand/collapse for accordion grouping
   - **Detail screens** — pull data from context + render visualizations using shared math helpers
   - **Form/wizard screens** — `react-hook-form` with `useFieldArray` for repeating sections; validate via the shared `validation.js`
   - **Settings/profile screens** — auth-dependent UI, sign-out, become-admin (if applicable), delete account

   All data via `apiClient`. No direct `fetch()` in screens. Always render loading + error states (build a `LoadingState` and `EmptyState` component).

10. **Wire navigation** in `App.js` using `@react-navigation/native-stack`. Wrap in your `AppProvider`, load fonts, register every screen.

11. **Auth (Supabase)**:
    - `src/auth/supabase.js` — `createClient(URL, ANON_KEY, { auth: { storage: secureStorageAdapter, persistSession: true, autoRefreshToken: true, flowType: 'pkce' } })`
    - `src/auth/secureStorage.js` — adapter wrapping `expo-secure-store` (encrypts at rest)
    - `AuthModal` — email + password + (optionally) Google "Continue with Google" button using a real 4-color G mark via `react-native-svg`
    - `onAuthStateChange` listener → dispatch `SET_SESSION` → fetch `/profile` (auto-create on 404) → fetch any per-user data the app needs

12. **Google OAuth via `expo-auth-session` + a web bridge** (Apple Sign-In needs a real device — defer if you don't have one):
    - Supabase rejects non-`https` `redirectTo`, so route through a hosted bridge page on the web app:
      `redirectTo: 'https://<project>.vercel.app/auth-callback.html?native_url=' + encodeURIComponent(makeRedirectUri({ scheme }))`
    - The bridge HTML extracts the `code` (PKCE) or `access_token`/`refresh_token` (implicit) from the URL and forwards them to the native deep link
    - Allowlist `https://<project>.vercel.app/**` in Supabase Auth → URL Configuration → Redirect URLs

13. **Configure `app.json`**:
    - `expo.slug` → project id; `scheme` → URL scheme name (single word, no dashes); `bundleIdentifier`/`android.package` → `com.<project>.app`
    - Adaptive icon: `foregroundImage` over `backgroundColor` (must match the icon BG)
    - `intentFilters` for the OAuth scheme on Android, `CFBundleURLTypes` on iOS
    - Plugins: `expo-secure-store`, `expo-web-browser`, etc. — declare every native module that has a config plugin
    - `userInterfaceStyle: "light"` (or `"automatic"`); `splash.backgroundColor` matches your accent color

14. **Generate icons + splash + store assets** via `app/scripts/generate-icons.mjs` (`sharp` SVG → PNG). See the **App icons & store assets** section below for the full asset list, dimensions, and safe-area rules.

15. **Test with Expo Go**:
    ```bash
    cd projects/$ARGUMENTS/app
    npm install
    # Set EXPO_PUBLIC_API_URL, EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY in .env
    npx expo start
    ```
    Scan QR with Expo Go. Test on iOS + Android simulators in addition to a real device.

16. **EAS production build pipeline** (Android first; iOS submission needs an Apple Developer account):
    - `eas init` → populates `extra.eas.projectId` in `app.json`
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

17. **Play Store / App Store listing assets** — see the **App icons & store assets** section. Privacy policy and delete-account URLs are required by both stores; host them on the web app.

18. **Update STRUCTURE.md and registry.json**:
    - Status: Live Native
    - `hasNativeApp: true`, `expoSlug: <slug>`
    - Document any deferred features (admin tools, OAuth providers, EAS Update channels, iOS submission)

Do NOT use `expo-sqlite` or local data files. All data comes from the shared backend.

---

## App icons & store assets

Master each asset as an **SVG** in `app/assets/`, then bake to PNG via `app/scripts/generate-icons.mjs`. Commit the generated PNGs so EAS doesn't depend on contributors having `sharp`. Re-run the script whenever the SVG sources change.

### Bundled with the app (referenced from `app.json`)

| Asset | File | Dimensions | Notes |
|---|---|---|---|
| App icon (iOS + generic Android) | `icon.png` | 1024×1024 | Square, no rounded corners — the OS masks. Solid background recommended. Same image used for the App Store listing. |
| Adaptive icon foreground (Android) | `adaptive-icon.png` | 1024×1024 | Transparent background. Content MUST stay inside the inner ~660×660 safe area — Android masks aggressively (circle / squircle / rounded square / teardrop depending on launcher). The OS composites it over `android.adaptiveIcon.backgroundColor`. |
| Splash screen | `splash.png` | 1284×2778 | Sized for iPhone Pro Max + Android phablets. Expo auto-scales for narrower / shorter devices via `splash.resizeMode: "contain"`. Background colour comes from `splash.backgroundColor` in `app.json` — match your brand. |
| Web favicon | `favicon.png` | 64×64 | Used by `expo export --platform web`. Keep the silhouette readable at 16×16. |

### Google Play Store listing assets (required for submission)

| Asset | File | Dimensions | Notes |
|---|---|---|---|
| **High-res icon** | (uploaded in console) | 512×512 PNG | Different from `icon.png` — Play Console wants its own copy. Re-export from the icon SVG at 512px. |
| **Feature graphic** | `feature-graphic.png` | 1024×500 PNG | Sits at the top of the listing on phone + tablet store pages. Critical text in the upper 70% — Play overlays the install button + dev name on the bottom 30% on some surfaces. Don't put readable text near edges (gets cropped on tablet). |
| **Phone screenshots** | uploaded directly | 1080×1920 (or higher), portrait | Minimum 2, max 8. Capture from Expo Go on a phone simulator. Show the app's primary value prop on the first 1–3 screens. |
| 7-inch tablet screenshots | optional | 1200×1920 | Recommended if the app supports tablet layouts. |
| 10-inch tablet screenshots | optional | 1920×1200 | Same. |
| Promo video | optional | YouTube URL | Boosts conversion when present. |

### Apple App Store assets (when iOS submission is in scope)

| Asset | Dimensions | Notes |
|---|---|---|
| **App icon (App Store)** | 1024×1024 PNG | No transparency, no rounded corners, no alpha. Apple rejects icons with alpha channels — flatten to a solid background colour. |
| **iPhone screenshots — 6.7"** | 1290×2796 | Required. Capture on iPhone 15 Pro Max simulator. |
| **iPhone screenshots — 6.5"** | 1242×2688 | Required (legacy). iPhone 11 Pro Max sim. Apple may auto-derive these from the 6.7" set. |
| **iPad screenshots — 12.9"** | 2048×2732 | Required only if `supportsTablet: true`. iPad Pro sim. |

### Listing copy (both stores)

| Field | Length | Notes |
|---|---|---|
| Short description (Play) | ≤ 80 chars | Appears under the icon in search results. Lead with the value prop, not the brand. |
| Full description (Play) | ≤ 4000 chars | First 2–3 sentences are what users see before "Read more". Plain text — minimal markdown. |
| App Store subtitle | ≤ 30 chars | Equivalent of Play's short description. |
| App Store description | ≤ 4000 chars | Same shape as Play's. |
| Promotional text (App Store) | ≤ 170 chars | Editable without a new build review — use it for "what's new" beats. |
| Keywords (App Store) | ≤ 100 chars total | Comma-separated, no spaces between tags. Don't repeat words from the title. |

### Required hosted URLs

Both stores reject submissions without these. Host them on the web app at stable URLs:

| Page | Path | Purpose |
|---|---|---|
| Privacy policy | `web/privacy.html` | Required by Play and App Store. Cover what data you collect, how it's stored, and how to contact you. Link to the same page from the app's Settings screen and from `AuthModal`. |
| Account deletion | `web/delete-account.html` | Required by Play (separate field from privacy URL — can't reuse). Walk users through deleting their account, either via in-app Settings → Delete Profile, or by emailing you. |
| Terms of service | `web/terms.html` | Optional but recommended. Required if you charge or run user-generated content. |
| Support / contact | mailto: link or `web/support.html` | A working email address is enough for Play. |

### Generation script template

`app/scripts/generate-icons.mjs`:

```js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assets = resolve(__dirname, '..', 'assets');

const targets = [
  { src: 'icon.svg',            out: 'icon.png',            width: 1024, height: 1024 },
  { src: 'adaptive-icon.svg',   out: 'adaptive-icon.png',   width: 1024, height: 1024 },
  { src: 'splash.svg',          out: 'splash.png',          width: 1284, height: 2778 },
  { src: 'favicon.svg',         out: 'favicon.png',         width: 64,   height: 64   },
  { src: 'feature-graphic.svg', out: 'feature-graphic.png', width: 1024, height: 500  },
];

mkdirSync(assets, { recursive: true });
for (const t of targets) {
  const svg = readFileSync(resolve(assets, t.src));
  const buf = await sharp(svg, { density: 384 })
    .resize(t.width, t.height, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(resolve(assets, t.out), buf);
  console.log(`✓ ${t.out} (${t.width}x${t.height})`);
}
```

Run with: `cd projects/$ARGUMENTS/app && npm i -D sharp && node scripts/generate-icons.mjs`

### Design tips

- **Same silhouette across icon, splash, and feature graphic.** Reuse the same SVG primitives — users build recognition from repeated shapes, not from a single canonical render.
- **Layer order matters.** When the icon has overlapping shapes (e.g. a frame on top of content), render the frame layer LAST so it visibly clips the inner content. Match this exact layer order in any animated version of the same illustration so the brand stays consistent.
- **Contrast against the background.** Outline strokes and frames should be 2–3 shades darker than the background fill, not the brand accent — accents tend to blend.
- **Test at small sizes.** Render the icon at 48×48 to check it still reads. Fine details (text, thin strokes < 4px on the 1024 master) disappear.
- **Adaptive icon safe area.** Sketch a 660×660 circle centered in the 1024×1024 canvas before designing — anything outside gets clipped on aggressive launchers.

---

## Common gotchas

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
- **Pydantic 422 errors render as "[object Object]"** in RN. The shared API client should coerce FastAPI's `detail` (string | dict | array) to a single readable string in a `formatErrorDetail` helper.
- **`description: null` vs `""`** — Pydantic non-Optional `str` rejects `null`. Send empty string when the field is unset.
- **Array → dict normalization**: backend endpoints that return `[{ key, value }, ...]` arrays often need to be a `{ key: value }` dict in client code. Normalize once in `shared/api.js` so the shape is the same on both platforms.
- **URL recipe / external import field names**: any time the backend exposes a third-party-shape response, document the exact field names in the shared module — small mismatches (`steps` vs `instructions`, `name` vs `foodRaw`) silently drop data.
- **Owner-or-admin DELETE routes**: prefer the public route that authorizes either owner OR admin over an admin-only route, so non-admins can delete their own content.

**EAS / production**
- **Local `.env` is NOT bundled** — push every `EXPO_PUBLIC_*` var to EAS production environment via `eas env:create` or the dashboard.
- **expo-doctor "No lock file detected"** — commit `app/package-lock.json` (with the `.gitignore` carve-out above).
- **`eas.json` `channel` field** without `expo-updates` triggers an "install expo-updates?" prompt on every build. Drop it or wire updates.
- **Manual Play Console upload** is fine for a first release — service-account JSON is only needed if you want `eas submit` to push the `.aab` automatically.
- **Play Console "service account" lives at the developer-account level**, not inside an app. Setup → API access → Create new service account → links to GCP Console for the actual key.

**UX parity**
- **Same layout primitives across web + native.** When the web renders a viz + legend in a row, the native screen should too — don't let the platforms diverge on information density.
- **Order-sensitive content** (e.g. timing-dependent steps) should compute its order inside the shared module, not in each renderer — otherwise web and native drift.
- **Default selection / favorite-aware defaults**: if a user has favorited a variant of an item, that variant should be the default rendered version on both platforms. Centralize the picker in `shared/`.
- **Diagnostic logs**: leave dev `console.log`s in production-bound code only when they're cheap and safe. Strip noisy ones once the flow is stable.
