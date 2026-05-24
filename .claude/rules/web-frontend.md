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

- **Navigation feels instantaneous.** A tap on a tab, nav item, or in-app link must update the active state, the visible screen, and the URL/store *in the same synchronous frame as the tap*. Any data fetching the destination view needs runs AFTER the visibility flip. Show a skeleton or loading spinner inside the destination view while the data loads — never block the navigation itself behind a `fetch()`. Concretely: the router toggles `.hidden` and the active-tab class before `await`-ing anything, and the destination view's `mount()` paints a placeholder (via `renderLoading()` or an early `render()` against empty state) before kicking off async work.
- **Tap targets ≥ 44×44 px.** Every interactive element — buttons, icons, list rows, nav tabs, close X's, dropdown items — must have at least a 44×44 px hit area (Apple HIG / WCAG 2.5.5 AAA). For small visual marks (e.g. a 14×14 lucide X), pad the wrapping button to 44×44 even when the glyph is smaller. Verify with DevTools' "Show layout" or by tapping with a fingertip on a real device, not just a mouse cursor. Adjacent tappables get ≥ 8 px of clear spacing between hit zones so users don't fat-finger the wrong one.
- **Destructive actions require secondary user confirmation.** Anything that loses user data — discarding a draft, deleting a play, abandoning a session, removing a friend, clearing a list — must require an explicit second tap before firing. The confirmation surface states (a) what will be lost, (b) whether the action is reversible, and (c) offers a Cancel that is the default focus / first read order. **Pick one confirmation surface for the whole project and use it everywhere:** either `window.confirm()` for every destructive gate, or a single project-themed modal (e.g. boardgame-buddy's `PolaroidPopup.confirm()`) for every destructive gate. Do **not** introduce per-screen bespoke dialogs — mixing surfaces within one project is the anti-pattern. If using a custom modal, the destructive button uses the project's destructive accent (e.g. rust / red) so the affordance reads as dangerous at a glance. Non-destructive irreversible actions (publishing, sharing) get a confirm too unless the project decides the cost of the confirm outweighs the cost of an accidental tap.

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
