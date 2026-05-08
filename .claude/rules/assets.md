# Asset Storage & Naming Convention

Every project that ships visual assets (logos, illustrations, sprites, animations, third-party credits) follows the same layout and naming rules.

## Directory Layout

```
projects/<name>/web/assets/
├── brand/          ← logo, favicon, wordmark — the project's identity
├── illustrations/  ← hero art, empty states, loading, decorative SVGs
├── sprites/        ← data art (one image per item; e.g. plants/, monsters/)
├── animations/     ← Lottie .json, animated SVGs
└── credits/        ← third-party logos / required attribution assets
```

Subdirectories are created on demand. A project that has only a logo just needs `web/assets/brand/`.

## Naming

Files inside any project's `web/assets/` are **project-prefixed kebab-case**:

| Project          | Prefix | Example                     |
|------------------|--------|------------------------------|
| boardgame-buddy  | `bgb`  | `bgb-logo.svg`               |
| plant-planner    | `pp`   | `pp-logo.svg`, `pp-empty-garden.svg` |
| sauceboss        | `sb`   | `sb-logo.svg`                |
| daywordplay      | `dwp`  | `dwp-logo.svg`               |
| wealthmate       | `wm`   | `wm-logo.svg`                |
| spotme           | `spotme` | `spotme-logo.svg`          |
| admin            | `admin`| `admin-logo.svg`             |

Why prefixed even though the path already namespaces? So files survive being copied into the native bundle, the landing page, or any other shared location without colliding.

The brand mark is always called `<prefix>-logo.svg`. If a separate small-scale favicon mark is needed, use `<prefix>-favicon.svg`. By default the same `<prefix>-logo.svg` serves both.

## Inline SVG vs File SVG

Keep the existing rule from `web-frontend.md`:

- **Inline (in JS / HTML):** Lucide-style UI chrome icons (24×24 stroke icons), small one-off decorative shapes, inline icons used inside a single render function.
- **File (in `assets/`):** Anything that's part of the project's visual identity (logo, hero art) or that's referenced more than once (loading spinner, empty-state illustration, plant/monster sprites). These get a real `.svg`/`.png`/`.json` file under the relevant subdirectory.

Rough rule: if the asset has a name (not just "this triangle here"), it's a file.

## Linking from `index.html`

Favicon link goes immediately after `<title>`:

```html
<title>BoardgameBuddy</title>
<link rel="icon" type="image/svg+xml" href="assets/brand/bgb-logo.svg" />
```

## Native (`projects/<name>/app/`) Sharing

Native apps maintain their own copy of any asset they need. Two patterns are acceptable:

1. **JSX component** (current sauceboss pattern): the SVG is re-implemented as a `react-native-svg` component (`<Svg><Path .../></Svg>`). Used when the asset needs to be parameterized (color, scale) at runtime.
2. **Bundled asset**: the file lives at `projects/<name>/app/assets/<prefix>-logo.svg` (or `.png`) and is loaded via `require('./assets/...')`. Used for static logos, splash, app icons.

When duplicating a web asset into native, use the same filename so the link is obvious. There is **no automated sync today** — keep the two copies in step manually until / unless a build pipeline is added.

App-store-required icons (`icon.png`, `splash.png`, `adaptive-icon.png`, `feature-graphic.png`) keep their standard Expo names at `app/assets/`, not project-prefixed.

## Landing Page

The landing page (`landing/`) maintains its own asset copies under `landing/assets/illustrations/`. Hero illustrations on featured cards are tuned for the dark theme and may differ visually from the in-app logo; that is expected. When the source-of-truth in a project changes, the landing copy must be re-synced manually.

## Migration Checklist (when adding assets to an existing project)

1. Create the relevant subdirectory under `web/assets/`.
2. Use the project-prefixed name (`<prefix>-<asset>.<ext>`).
3. Reference via relative path (`assets/brand/<prefix>-logo.svg`) — no `/` prefix, since each project deploys at its own root.
4. If the asset is also needed in `app/`, copy it to `app/assets/<prefix>-<asset>.<ext>` and document in code that the two copies must stay in sync.
