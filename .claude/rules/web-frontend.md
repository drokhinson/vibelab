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
