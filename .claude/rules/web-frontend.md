---
paths:
  - "projects/*/web/**"
---

# Web Prototype Conventions (`projects/[name]/web/`)

- No npm, no bundler. Vanilla HTML + vanilla JS. No build step.
- **Standard CDN stack** for new projects:
  - **DaisyUI v4** (Tailwind component library — cards, badges, bottom-nav, toasts, no build step)
  - **An SVG icon set** vendored into the project, not loaded from a CDN — see Icons below
  - **Google Fonts: Inter** (body) + optional display font per project
- Existing projects on Pico.css are migrated to DaisyUI incrementally via `/ui-polish`.
- **Theming is not DaisyUI's named themes.** Every app ships light *and* dark from
  one semantic token set, with `data-theme` frozen and a separate project-owned
  attribute as the lever. See `.claude/rules/theming.md` — it is a precondition
  for most of this file, not an optional extra.
- `config.js` sets `window.APP_CONFIG = { apiBase: "..." }`. Default: `http://localhost:8000`.
- Use `fetch()` for all data. Never inline data in JS globals.
- Mobile-first responsive. Max width 480px for single-column apps, 900px for dashboards.
- Loading states and error handling are required on every `fetch()`.
- **Icons:** Use SVG icons for all UI chrome (nav, buttons, back arrows, action icons). **Do not use generic emojis anywhere in the UI** — not for content/data, not in headings, not in copy. Content/data marks (food, plants, animals, categories — things that *are* the data) get **custom-built SVG sprites** under `web/assets/sprites/` per `.claude/rules/assets.md`. (Older projects that still render emoji data marks are grandfathered; migrate opportunistically via `/ui-polish`.)
- **Icon delivery:** Vendor the icon set into the project rather than pulling a CDN at runtime. A CDN icon script is a third-party dependency on the critical render path that the service worker cannot precache, so icons disappear exactly when the app is offline — which for an offline-first app is when it matters most. The reference implementation is `projects/boardgame-buddy/web/ui/icons.js`: a name → path-data map plus a `render(root)` that swaps `<i data-icon="name">` placeholders for inline `<svg>`, carrying the class list across so Tailwind `w-N h-N` sizing keeps working. Prefer **Phosphor** over Lucide — the `design-taste-frontend` skill flags Lucide as the default AI icon choice and discourages it. Keep inline SVG rather than an icon font: a font sizes by `font-size`, and switching sizing models across every call site fails silently.
- **Icon names from the database:** if a name can come from a data column (e.g. a `*_types.icon` free-text column), the set is open — a vendored map must fall back to a neutral glyph for unknown names rather than rendering nothing.
- **Illustrations:** Every empty state, loading screen, and app header should include an SVG illustration. Prefer custom-built SVGs under `web/assets/illustrations/` that match the project's visual identity; undraw.co (free, MIT) is an acceptable fallback — download the SVG and customize the primary fill color to match the project accent. Never substitute an emoji for an illustration.
- **Motion:** All card lists get entrance animations (`fadeUp` keyframe). Stagger list items with `animation-delay: calc(var(--i) * 40ms)`. The primary press affordance is `:active`, not hover — these are touch apps, and a row with no press feedback reads as "the tap didn't register". Hover lift (`translateY(-2px)` + shadow increase) is a `@media (hover: hover)` enhancement on top, never the only feedback. Shadows come from the theme's shadow ramp (`var(--sh-2)`), never a literal `rgba(0,0,0,…)` — a black shadow is invisible on a dark ground.
- **Design reference:** Use v0.app to generate visual mockups for complex screens. Do not copy its React code — extract the layout, spacing, and component structure decisions and implement them in DaisyUI + vanilla JS.

## Interaction & Accessibility

- **Navigation feels instantaneous.** A tap on a tab, nav item, or in-app link must update the active state, the visible screen, and the URL (via `history.pushState` — see Routing & URLs below) *in the same synchronous frame as the tap*. Any data fetching the destination view needs runs AFTER the visibility flip. Show a skeleton or loading spinner inside the destination view while the data loads — never block the navigation itself behind a `fetch()`. Concretely: the router toggles `.hidden` and the active-tab class before `await`-ing anything, and the destination view's `mount()` paints a placeholder (via `renderLoading()` or an early `render()` against empty state) before kicking off async work.
- **Mutations feel instantaneous.** A state-changing interaction — setting priority/rating, toggling a status, reordering, drag-dropping, scheduling, checking a box — must reflect in the UI *in the same frame as the gesture*, with the network write flowing through in the background. Two rules, applied together:
  - **Paint optimistically, reconcile in the background.** Update local state and re-render *before* the request; when the echo arrives, reconcile with it; on error, roll back (prefer a field-level snapshot over a whole-bundle one so a concurrent edit to a different item isn't erased). Never `await` the server before the row moves, and never refetch the whole list after a mutation — patch the one changed item into local state. Guard overlapping writes with a monotonic per-item token and pause background pollers while a write is in flight (see **Async state & race conditions** below).
  - **Re-render surgically, not the whole screen.** A single-item mutation must not tear down and rebuild the entire view (`container.innerHTML = …` over the whole screen, re-running icon init and re-binding every listener over the full tree) — that wholesale teardown is itself the "laggy / it reloaded" feel, *even when the data update is already optimistic*. Wrap each re-renderable region in a stable host element, route bundle updates through a cheap structural-vs-field diff, and on a field-only change re-render just the affected host and re-bind just its handlers; reserve the full render for structural changes (add/remove, membership, dates). Factor the region's bindings into their own helper so exactly one path binds each region per paint (no double-binding after a partial swap). Canonical implementation: `ScrapDomain.schedule` (optimistic + sequence guard) in `projects/travel-scrapbook/web/domain/scrap.js` and the `#tl-content` / `#stops-content` host + `_onTripUpdate` / `_structuralSig` / `_patchTimeline` / `_patchStops` surgical path in `projects/travel-scrapbook/web/views/trip-view.js`.
- **Tap targets ≥ 44×44 px.** Every interactive element — buttons, icons, list rows, nav tabs, close X's — must have at least a 44×44 px hit area (Apple HIG / WCAG 2.5.5 AAA). **List and picker rows get 56 px**, not 44: rows sit flush against each other, so a slightly-off thumb lands on the neighbour. Commit buttons (a sheet's Cancel/Confirm, a screen's primary CTA) get 52 px. For small visual marks (e.g. a 14×14 X glyph), pad the hit area to 44×44 with a negatively-inset `::before` rather than inflating the visible control. Verify with DevTools' "Show layout" or by tapping with a fingertip on a real device, not just a mouse cursor. Adjacent tappables get ≥ 8 px of clear spacing between hit zones so users don't fat-finger the wrong one. Full detail in `.claude/rules/mobile-web.md` § Tap targets.
- **Choice lists are bottom sheets, not in-screen dropdowns.** A `position: absolute` list hung off an input inherits every constraint of wherever that input sits — it needs a fit pass, a flip, and a z-index override to clear docked chrome, and the software keyboard doesn't shrink it. A sheet is `position: fixed`, sized off the visible viewport, and none of that geometry can occur. See `.claude/rules/overlays.md`.
- **Destructive actions require secondary user confirmation.** Anything that loses user data — discarding a draft, deleting a play, abandoning a session, removing a friend, clearing a list — must require an explicit second tap before firing. The confirmation surface states (a) what will be lost, (b) whether the action is reversible, and (c) offers a Cancel that is the default focus / first read order. **Pick one confirmation surface for the whole project and use it everywhere:** `window.confirm()` for every destructive gate, or a single project-themed modal (e.g. boardgame-buddy's `PolaroidPopup.confirm()`), or a single bottom sheet — but one of them, for all of them. Do **not** introduce per-screen bespoke dialogs — mixing surfaces within one project is the anti-pattern. If using a custom surface, the destructive button reads `var(--rust)` so the affordance looks dangerous at a glance in both themes. Non-destructive irreversible actions (publishing, sharing) get a confirm too unless the project decides the cost of the confirm outweighs the cost of an accidental tap.

## Loading, empty and error states

Three states, three branches. Conflating any two of them is a bug class, not a polish item.

- **Never render an empty state while a fetch for that list is in flight.** `loaded` alone is not the gate: a cache or bundle seed can set it true on an empty list, and a reset (`_load({reset:true})` for a search or a pull-refresh) clears the list *before* the request goes out. Both paths fall straight through to "Nothing here yet" next to a spinning refresh icon. Mark the fetch in flight **before the first paint**, and gate on the count as well as both flags — `count === 0 && (!loaded || loading)` renders the loader; the empty state and "No matches." render only when nothing is running. See `views/plays-view.js` in boardgame-buddy.
- **A failed first load is not an empty state.** Falling through to "Your feed is quiet" on a failed fetch is wrong, looks permanent, and leaves the viewer no way to ask again short of relaunching the app. Give it its own branch with a retry button, **and** subscribe to connectivity so it retries automatically when the network returns. See `_renderLoadError` / `_retryInitial` in `views/feed-view.js`.
- **Every request needs a deadline.** A dead network rejects `fetch()` promptly; a *stalled* one never settles, and no browser imposes a useful timeout — so every awaited first-paint call is a potential permanent hang. Put every request under an `AbortController` deadline that stays armed **through the body read**, and give the boot path its own watchdog: a splash screen is the one view with no nav to escape from.
- **Label a suggestion by its reason, not by the number that ranked it.** The count did its job server-side; "You've played together" tells the user why the tile is there, "3 mutuals" does not.

## App chrome & layering

Pinned chrome is a system, not a per-screen decision. Get these five things right once per project.

- **One documented z-index ladder**, written in a comment at the top of the stylesheet and referenced by every rule that joins it. Boardgame-buddy's, as an example to copy the *shape* of: view content `< 20` pinned sub-header `< 30` global header `< 35` docked footers (pager, CTA, install prompt) `< 36` docked error `< 40` bottom nav `< 45` toasts `< 90–100` modals and sheets. Never sprinkle arbitrary `z-50`/`z-10`.
- **Heights are tokens; derived offsets are `calc()` off those tokens.** Declare `--nav-height` and `--header-height`, then derive `scroll-padding-top: calc(var(--header-height) + 8px)` so `scrollIntoView({block:"start"})` targets clear the pinned header, and derive every docked bar's offset the same way. No literal ever duplicates a measurement that lives in a token.
- **`body { overflow-x: clip }`, never `hidden`.** `<html>`'s overflow is the one that propagates to the viewport, so once it is non-visible, `<body>`'s own `overflow-x` applies to `<body>` itself — which turns it into a scroll container. `<body>` has no fixed height and therefore never scrolls, so every `position: sticky` in the app resolves against a dead scrollport and rides off-screen. `clip` suppresses the same horizontal overflow without establishing a scrollport.
- **Docked chrome is `position: fixed`, not `sticky`.** A sticky bottom bar is released by a padding calibration whose release point has to stay in sync with every other bottom offset in the app — and it drifts: boardgame-buddy's missed `#app`'s own `padding-bottom`, so the button climbed 64px at the end of every screen. Fixed has no release point. The recipe: `bottom: calc(var(--nav-height) + env(safe-area-inset-bottom))`, `left: 50%` + `translateX(-50%)` + `max-width` to pin to the content column rather than the viewport, explicit `box-sizing: border-box`, a background gradient so content passes *under* the bar, and `pointer-events: none` on the wrapper with `auto` on the control.
- **A pinned sub-header parks under the global header**, at `top: var(--header-height)`, sharing its visual treatment so the two read as one stack of chrome. Because it is a direct child of a horizontally-padded `<main>`, it needs a negative inline margin plus matching padding so the band bleeds to the column edges and rows can't slide past it through the gutters. Scope it to **direct children only** — the same class nested inside a card or a modal must not pin.

**Close vs back.** A screen reachable from *anywhere* (opened from global chrome — a gear in the header, a global search) gets a **close ×** on the trailing edge calling `router.back(fallback)`, so dismissing it returns to whatever screen it was opened from. A screen reachable only from its parent gets a **back ←** on the leading edge naming its destination. A hardcoded `router.go(parent)` on a globally-reachable screen is the bug — it dumps anyone who opened it from elsewhere onto a screen they weren't on. The fallback argument covers the cold deep link, where there is no previous entry.

## Async state & race conditions

Any async work — a `fetch`, a poll, an auth callback, a timer — can resolve *after* the user has already moved on. The bug class to watch for: a late or stale async result silently overriding the state the user is currently in (a screen snapping back, a session dropping, a form showing someone else's data). Before applying *any* async result to state, confirm it's still relevant. Concretely:

- **Sequence-guard concurrent writes.** When the same user action can fire overlapping requests (rapid taps, retries, double-submits), stamp each invocation with a monotonic token captured *before* the `await` — `const seq = ++this._phaseSeq` — and bail in **both** the success and error paths when `seq !== this._phaseSeq`, so only the latest call reconciles state. Without this, an older request resolving last clobbers the newer one. See the rapid Gather/Play/Settle navigation fix in `projects/boardgame-buddy/web/views/play-flow-view.js`.
- **Pause background refreshers during a transition.** A poll or interval that overwrites local state from the server must skip its tick while a user-initiated change is in flight. Gate it on an in-flight counter — `if (this._pendingPhase > 0) return;` — so optimistic local state isn't clobbered by a stale server row mid-transition. This mirrors the existing `_pendingDeletes` guard that keeps a stale poll from re-adding a just-removed player.
- **Don't treat a transient blip as a real state change.** Distinguish a recoverable hiccup from a genuine transition *before* tearing down user state. Self-heal a 401 (refresh the token and retry once) instead of cascading into a sign-out; act on the actual event (`SIGNED_OUT`), not an incidental null session from a wake-up refresh; re-create a resource only on a definitive 404/410, not on a network error. See the screen-off resume fix across `domain/api.js`, `init.js`, and `_ensureLobbyOpen` in `play-flow-view.js`.
- **Give every focusable field a stable id on a surface that restores focus by id.** If a surface re-renders by replacing `innerHTML` and puts focus back by looking the element up, then a field without an id is the one field the restore can never find — and the user gets dropped out of it on every unrelated repaint. Boardgame-buddy's play-detail popup had exactly one such field. (Caret restore is separate and may not be possible: `selectionStart` reads `null` on `<input type=number>`, so guard on `caret != null`.)
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

## The `design-taste-frontend` skill — scope and precedence

`.claude/skills/design-taste-frontend/` is a vendored third-party skill pinned in
`skills-lock.json` (do not edit it in place; a sync would overwrite the change).
It scopes itself to *"landing pages, portfolios, and redesigns — not dashboards,
not data tables, not multi-step product UI"*, which is most of `projects/*/web/`.

Where it agrees with these rules, it is useful corroboration: its dark-mode
protocol says to design for both modes from the start, define semantic tokens and
swap them under a theme attribute, keep hierarchy parity across modes, and never
desaturate the brand into dark — all of which is `.claude/rules/theming.md`.

Where it disagrees, **these rules win**:

- Its icon guidance ("no hand-rolled SVG icons; Phosphor / HugeIcons / Radix /
  Tabler") predates the vendoring rule above. Vendor the set into the project;
  never load an icon CDN.
- Its component and animation advice assumes React, Tailwind's build step, and a
  motion library. This repo has no npm and no bundler.
- Its aesthetic prescriptions are per-brand and must not override a project's own
  token system.

Use it for taste on `landing/`. Use these rules for the apps.

## Related rules

- `.claude/rules/theming.md` — light/dark, the token vocabulary, surface kinds.
- `.claude/rules/overlays.md` — bottom sheets, modals, and the retired dropdown.
- `.claude/rules/mobile-web.md` — visible viewport, zoom locks, tap targets, iOS icons.
- `.claude/rules/ui-object-design.md` — one object, one canonical component.
- `.claude/rules/assets.md` — asset layout, naming, and both-theme legibility.
- `.claude/rules/typed-js.md` — JSDoc type contracts.
