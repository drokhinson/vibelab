---
paths:
  - "projects/*/web/**"
---

# Web Prototype Conventions (`projects/[name]/web/`)

- No npm, no bundler. Vanilla HTML + vanilla JS. No build step.
- **Standard CDN stack** for new projects:
  - **DaisyUI v4** (Tailwind component library — cards, badges, bottom-nav, toasts, 30+ themes, no build step)
  - **Lucide Icons** (crisp SVG icon set, replaces emoji for UI chrome)
  - **Google Fonts: Inter** (body) + optional display font per project
- Existing projects on Pico.css are migrated to DaisyUI incrementally via `/ui-polish`.
- `config.js` sets `window.APP_CONFIG = { apiBase: "..." }`. Default: `http://localhost:8000`.
- Use `fetch()` for all data. Never inline data in JS globals.
- Mobile-first responsive. Max width 480px for single-column apps, 900px for dashboards.
- Loading states and error handling are required on every `fetch()`.
- **Icons:** Use Lucide SVG icons for all UI chrome (nav, buttons, back arrows, action icons). Keep emojis for content/data (food, plants, animals — things that *are* the data).
- **Illustrations:** Every empty state, loading screen, and app header should include an SVG illustration. Source from undraw.co (free, MIT). Download the SVG, inline it in the relevant JS render function, and customize the primary fill color to match the project accent.
- **Motion:** All card lists get entrance animations (`fadeUp` keyframe). Cards get hover lift (`translateY(-2px)` + shadow increase). Stagger list items with `animation-delay: calc(var(--i) * 40ms)`.
- **Design reference:** Use v0.app to generate visual mockups for complex screens. Do not copy its React code — extract the layout, spacing, and component structure decisions and implement them in DaisyUI + vanilla JS.

## Interaction & Accessibility

- **Navigation feels instantaneous.** A tap on a tab, nav item, or in-app link must update the active state, the visible screen, and the URL (via `history.pushState` — see Routing & URLs below) *in the same synchronous frame as the tap*. Any data fetching the destination view needs runs AFTER the visibility flip. Show a skeleton or loading spinner inside the destination view while the data loads — never block the navigation itself behind a `fetch()`. Concretely: the router toggles `.hidden` and the active-tab class before `await`-ing anything, and the destination view's `mount()` paints a placeholder (via `renderLoading()` or an early `render()` against empty state) before kicking off async work.
- **Tap targets ≥ 44×44 px.** Every interactive element — buttons, icons, list rows, nav tabs, close X's, dropdown items — must have at least a 44×44 px hit area (Apple HIG / WCAG 2.5.5 AAA). For small visual marks (e.g. a 14×14 lucide X), pad the wrapping button to 44×44 even when the glyph is smaller. Verify with DevTools' "Show layout" or by tapping with a fingertip on a real device, not just a mouse cursor. Adjacent tappables get ≥ 8 px of clear spacing between hit zones so users don't fat-finger the wrong one.
- **Destructive actions require secondary user confirmation.** Anything that loses user data — discarding a draft, deleting a play, abandoning a session, removing a friend, clearing a list — must require an explicit second tap before firing. The confirmation surface states (a) what will be lost, (b) whether the action is reversible, and (c) offers a Cancel that is the default focus / first read order. **Pick one confirmation surface for the whole project and use it everywhere:** either `window.confirm()` for every destructive gate, or a single project-themed modal (e.g. boardgame-buddy's `PolaroidPopup.confirm()`) for every destructive gate. Do **not** introduce per-screen bespoke dialogs — mixing surfaces within one project is the anti-pattern. If using a custom modal, the destructive button uses the project's destructive accent (e.g. rust / red) so the affordance reads as dangerous at a glance. Non-destructive irreversible actions (publishing, sharing) get a confirm too unless the project decides the cost of the confirm outweighs the cost of an accidental tap.

## Async state & race conditions

Any async work — a `fetch`, a poll, an auth callback, a timer — can resolve *after* the user has already moved on. The bug class to watch for: a late or stale async result silently overriding the state the user is currently in (a screen snapping back, a session dropping, a form showing someone else's data). Before applying *any* async result to state, confirm it's still relevant. Concretely:

- **Sequence-guard concurrent writes.** When the same user action can fire overlapping requests (rapid taps, retries, double-submits), stamp each invocation with a monotonic token captured *before* the `await` — `const seq = ++this._phaseSeq` — and bail in **both** the success and error paths when `seq !== this._phaseSeq`, so only the latest call reconciles state. Without this, an older request resolving last clobbers the newer one. See the rapid Gather/Play/Settle navigation fix in `projects/boardgame-buddy/web/views/play-flow-view.js`.
- **Pause background refreshers during a transition.** A poll or interval that overwrites local state from the server must skip its tick while a user-initiated change is in flight. Gate it on an in-flight counter — `if (this._pendingPhase > 0) return;` — so optimistic local state isn't clobbered by a stale server row mid-transition. This mirrors the existing `_pendingDeletes` guard that keeps a stale poll from re-adding a just-removed player.
- **Don't treat a transient blip as a real state change.** Distinguish a recoverable hiccup from a genuine transition *before* tearing down user state. Self-heal a 401 (refresh the token and retry once) instead of cascading into a sign-out; act on the actual event (`SIGNED_OUT`), not an incidental null session from a wake-up refresh; re-create a resource only on a definitive 404/410, not on a network error. See the screen-off resume fix across `domain/api.js`, `init.js`, and `_ensureLobbyOpen` in `play-flow-view.js`.
- **Reset transient state on every mount of a reused view.** Singleton / cached views survive logout→login and back-stack pops, so a prior session's form buffer, active tab, or edit target leaks into the next mount and renders under the new screen. Centralize all transient fields in one `_resetFormState()` called from the constructor **and** the top of `onMount` (plus `onUnmount`), and have `renderLoading()` read route `params` — never stale instance fields. See `projects/boardgame-buddy/web/views/reference-guide-add-view.js`.

## Routing & URLs

Every view has a real path. The address bar reflects what the user is looking at; the back button works; deep links survive refresh; sessions and profiles are shareable. The canonical implementation is `projects/boardgame-buddy/web/domain/view.js` — copy that `Router` class and adapt the path table.

**Required:**

- **Use the History API (`pushState` / `replaceState` / `popstate`).** Never hash-route (`location.hash`, `'#' + view`) for view changes, and never run a "URL-less" SPA that only toggles `.hidden` on `data-view` containers. Hash routing breaks the bookmarkable-URL contract and confuses the browser back button; URL-less routing makes refresh land everyone on the same starting view.
- **Declare a single path table** in the router: route name → URL template (`/play/:code`, `/game/:id`, `/u/:userId`, `/profile/{collection,wishlist,plays,buddies}`, etc.). Provide both directions — `pathFor(name, params)` builds a URL for a navigation, `matchPath(pathname)` resolves an incoming URL on initial load and popstate. One declarative array drives both so they can't drift.
- **Path params for identity, querystring for extras.** `/game/:gameId` is in the path because it determines what the page is. Display hints (`gameName`, `expansionIds`, `mode=edit`) ride as querystring so deep-link entries still hydrate the destination view's optional params without bloating the path template.
- **Restore the URL across auth.** On boot, parse `window.location.pathname` → stash the resolved route in store (`pendingRoute`) → show splash with `skipPush` so the original URL stays in the address bar → after Supabase auth resolves, route to the pending route (or the default landing view if none). A user who pastes `/play/{code}` while signed out must bounce through `/auth` and land back on `/play/{code}`.
- **SPA fallback at the host.** Ship a `vercel.json` (or equivalent for whatever static host the project uses) that rewrites every path to `/index.html`. Without it, refresh on `/play/{code}` returns 404. Use:
  ```json
  { "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
  ```
- **Browser back works.** `router.back()` defers to `history.back()`; a `popstate` listener replays the route from the state object (`{ name, params }` stashed at pushState time), falling back to `matchPath()` for entries that have no state (direct loads, browser-supplied history). Keep a parallel internal `_stack` only because the browser doesn't expose entry metadata — `peekBack()` reads it to label back affordances.
- **`replaceState` when the URL is already correct.** Common cases: post-auth landing on the user-typed deep link (don't push a duplicate adjacent entry), and per-view state catching up to identity it didn't know at navigation time (e.g. play-flow's host opens a lobby and only then knows the code — call `router.replaceUrl("play-flow", { code })`). Reserve `pushState` for forward navigations the user initiated.
- **Transient views stay out of the URL.** Loading splashes, auth-bounce screens, and other passive intermediates should not appear in the path or the back stack. Leave them out of the path table entirely so `pathFor` returns null and nothing pushes.

**Anti-patterns to refactor away when touching a project:**

- `'#' + name` hash routing (currently in `projects/sauceboss/web/tabs.js`).
- A `showView(name)` helper that only toggles `.hidden` and never touches the URL (currently in `projects/plant-planner/web/helpers.js`).

Both should migrate to the History-API pattern next time the project gets meaningful work — same `Router` class, same path table approach.

## Modular Frontend File Structure

No ES modules — use `<script>` tags sharing global scope. Load order matters: state → helpers → feature modules → init.

| File | Purpose |
|------|---------|
| `config.js` | API base URL |
| `state.js` | All global `let` variables (shared state) |
| `helpers.js` | Formatting, auth tokens, `apiFetch()`, `showView()`, navigation |
| `[feature].js` | One file per view/feature (e.g. `dashboard.js`, `accounts.js`, `checkin.js`) |
| `init.js` | `DOMContentLoaded` handler: all event listeners, startup logic. Loaded last. |

Add `<script>` tags to `index.html` in the order above. All functions remain global.

**When to split:** Start with a single file during initial prototyping. Split once any file exceeds ~300 lines or has 3+ distinct feature areas. Small apps (under 300 lines total) can stay as a single file.

## Type Contracts (editor-only)

When a file in `shared/` or `web/` reshapes a backend response or has a non-obvious return shape, document it with JSDoc `@typedef` + `// @ts-check`. See `.claude/rules/typed-js.md` for the convention — no build step, no npm, surfaced as squiggles in VS Code / Cursor / Claude.
