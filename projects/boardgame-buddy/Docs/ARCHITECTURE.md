# BoardgameBuddy — Architecture & Object-Oriented Design

This document explains the architecture of the BoardgameBuddy web app: the domain objects the user experience centers on, the UI styles that present them, the screens that compose them, and the rules that keep everything coherent.

Companion document: `Docs/UI_AUDIT.md` — every UI inconsistency and dead-code finding cited at component level.

---

## 1. The core idea

BoardgameBuddy is a **Strava-style log for board game plays**. The user's mental model is:

> "I play games with my buddies. I want to remember what I played, who I played it with, and what we knew about the rules."

Three concrete objects come out of that sentence — **Game**, **Play**, **Buddy** — and the entire app is built around presenting and editing them. Two supporting objects (**User** and **Session**) carry identity and live-play state. Two specialized objects (**Chapter**, **PlaySession**) extend the core three with reference material and host-side state. Everything else in the app is a view, a list, or a detail of one of these objects.

If a screen does not show one of these objects, it is either chrome (settings, auth) or it is a candidate for deletion.

---

## 2. Domain objects

Each object has a JS file in `web/domain/` that wraps its API surface, normalizes responses, and exposes a class or namespace.

| Object | File | Role in the experience |
| --- | --- | --- |
| **Game** | `domain/game.js` | The thing being played. Owns metadata (name, year, players, playtime, BGG link, image). Also owns the relationship to Chapters (rules excerpts) and Expansions. |
| **Play** | `domain/play.js` | A single recorded session of a Game by one or more Users (and possibly ghost players). Owns players, scores, winner, notes, photo, duration, and the country it was played in (migration 065, resolved by `domain/geo.js`). |
| **Buddy** | `domain/buddy.js` | A directed friendship between two Users. Carries request state (pending in/out, accepted) and recent-play history together. Ghost buddies are placeholders for non-account players. |
| **User** | `domain/user.js` | A profile (display name, avatar customization, BGG link). The viewer is the implicit `User.current()`. |
| **Session** | `domain/play-session.js` + `domain/session-phase.js` + `domain/live-scores.js` | The live state of a game-in-progress. Phases (`gather` → `play` → `settle`) drive the cascading host UX; Realtime keeps joiners in sync. When the host saves, the Session finalizes into a Play and is discarded. |
| **Chapter** | `domain/chapter.js` | A user-built reference excerpt for a Game (rule summary, setup notes, scoring quirks). Pooled across users; the player merges chapters from base + expansions into a "guide" for that game. |
| **Collection** | `domain/collection.js` | Per-user `(game, status)` mapping — owned / wishlist / played-not-owned. Drives the status badges everywhere a Game appears. |
| **Profile** | `domain/profile.js` | Public projection of a User: stats, recent plays, owned games, favourite game. |
| **Feed** | `domain/feed.js` | Composite chronological stream of plays + algorithmic rails (hot games, suggested buddies). Lives in its own object because the response is heterogeneous. |
| **Achievement** | `domain/achievements.js` | A badge in the nineteen-item catalog, resolved against the viewer's own progress. The *catalog* lives in the database (`boardgamebuddy_achievements`), not in this file — retuning a tier is an UPDATE, not a deploy. What the module owns beyond the fetch is the half the server cannot know, in two separate device-side sets: `known` (which badges this device has ever observed as earned — a badge earned but not known is one that landed just now, which announces the unlock polaroid) and `seen` (which the user has actually looked at on the shelf, which drives the "New" ribbons). Unlocks are announced on a window event, not by calling into the UI, so the domain layer does not need to know a polaroid exists. |

The `domain/store.js` file is the cross-cutting state container. Views call `window.store.subscribe(key, fn)` to listen for changes and `window.store.set(key, value)` to publish. The `user`, `feed`, and `myCollectionMap` keys are the high-traffic ones; everything else is view-local.

The base class for views is in `domain/view.js`. Every view extends `window.View` and implements `mount`, `render`, `onMount`, `onUnmount` (see §5).

---

## 3. The "one object → one canonical UI component" rule

The most important design principle in this codebase is: **for each core object, there should be exactly one canonical render function that produces its visual representation, and every surface that shows the object should use it.**

Today the codebase honours this rule for two of the four object families and breaks it for the other two. The state below is the **target state**; see UI_AUDIT.md §6 for the gap analysis.

| Object | Canonical component | File | Status |
| --- | --- | --- | --- |
| **Play** | `renderPlayCard` | `ui/play-card.js` | ✅ Single source of truth on 3 surfaces (feed single, feed strip, game-detail recent). The chronological plays view (`.plays-list__row`) is the outlier — flagged in audit §5b. |
| **User** | `BgbBadge.render` | `ui/user-badge.js` | ✅ Single source of truth on 30+ call sites. As of the 2026-05-23 cleanup the global header also routes through it; no other code path exists. |
| **Game** | `renderGamePolaroid` (partial) | `ui/game-card.js` | ⚠️ Six bespoke tiles (`.collection-tile`, `.hot-game-tile`, `.preview-card__cover`, `.game-detail__polaroid`, `.plays-list__thumb`, `.game-polaroid`) still exist. `renderGamePolaroid` now serves three surfaces through its `variant` opt — `polaroid` (Gather grid, explorer), `rail` (feed rails) and `row` (the Collection spoke's Expansions tree, and the Add Games catalog scroll). The tree went through the canonical component rather than becoming a seventh bespoke tile; `showStatus` and `interactive` opts exist for it (every tree row is owned, and a `role="button"` tile can't nest inside the group's disclosure button). Add Games reused that same row shape — tile plus a sibling quick action, `showStatus: false` because the row's own button already reports the state — so a whole new screen landed with no new Game tile. |
| **Buddy** | _(no canonical row)_ | n/a | ⚠️ Buddy rows are rendered via `BgbBadge.render` for the avatar but the surrounding row markup is duplicated in `views/buddies-view.js`, `views/feed-view.js` (suggestions), and the profile preview. Less severe than Game because the avatar — the visual identity — is shared. |
| **Chapter** | (none yet) | `widgets/reference-guide-scroll.js` renders chapters into the parchment scroll | Chapters are not surfaced outside the scroll, so the rule does not need to be enforced. If a future change shows a single chapter in a tooltip / preview, that would be the moment to extract a `renderChapter` function. |
| **Session** | `widgets/round-score-grid.js` + `widgets/game-info-bar.js`, plus the cascading `play-flow-view` screens | The scoring grid is shared between host (live edit) and joiner (read-only mirror); the Play step's game-info strip is shared by the same pair. | ✅ Single source for both the scoring view and the Play header. The Gather/Settle screens are unique to the host. |

The rule manifests at three levels:

1. **JS:** A single `render*` function or class with a documented option set. Variants are parameters, not parallel implementations.
2. **CSS:** The component's class family (`.play-card*`, `.user-badge*`) lives in one section of `styles.css` and is not redefined elsewhere. Layout host classes (e.g. `.profile-hub__avatar` sizing a `.user-badge`) tune the component without re-styling it.
3. **Data:** The object's shape comes from one file in `domain/`. Views adapt by passing the existing shape through; if the API surface differs (e.g. `bundle.recent_plays` vs `feed.plays`), the view writes a small adapter (see `views/game-detail-view.js#_toFeedPlayCard`).

---

## 4. UI styles & design tokens

The design system is called **"Lamplight Study"** — game night under a warm lamp: espresso ground, amber glow, terracotta wins. It has three type families, a small semantic palette, and **two themes**. Everything is declared at the top of `styles.css`, in three blocks and no other order:

```
:root                          scales + typography (theme-independent)
:root, :root[data-bgb=dark]    dark palette (the default)
:root[data-bgb=light]          light palette
```

### 4.1 Type roles

| Token | Family | Used for |
| --- | --- | --- |
| `--font-sans` | Geist | Body text, button labels, list rows, profile body |
| `--font-polaroid` | Fraunces | Display face — page titles, section headings, game / profile names, polaroid captions |
| `--font-display` | *alias of `--font-polaroid`* | Kept so every existing `.font-display` call site still works |
| `--font-score` | JetBrains Mono | All numeric scores, session codes, cascade step counters (tabular numerals) |

The "polaroid family" is the project's signature: cream-paper background, soft drop shadow, Fraunces caption. It is the visual treatment for **Play** in the feed and for **Game** in the Gather grid. (The tilt animation was removed — the tiles sit square now.)

### 4.2 Color tokens

Declared per theme. Dark is the default; light overrides under `[data-bgb="light"]`.

| Token | Dark | Light | Used for |
| --- | --- | --- | --- |
| `--bg-0` / `--bg-1` / `--bg-2` | `#1A1310` / `#251C16` / `#33261C` | `#F7F0E1` / `#FFFBF2` / `#FFFFFF` | app ground / raised / elevated |
| `--ink` / `--ink-muted` / `--ink-faint` | `#F0E7D8` / `#B0A18E` / `#847665` | `#2A2016` / `#6F6252` / `#93856F` | the foreground ramp |
| `--line` / `--line-strong` | white 8% / 16% | ink 11% / 20% | hairlines |
| `--accent` / `--accent-hover` | `#E0A94A` / `#EFBC62` | `#A87215` / `#8E5F10` | brand gold **on the ground** |
| `--accent-quiet` | gold 14% | gold 13% | the amber wash behind pills |
| `--accent-ink` | `#8A5F0B` | `#7F540D` | gold **as text on a card or paper surface** |
| `--accent-fill` / `--on-accent` | `#E0A94A` / `#2B1E06` | `#8E5F10` / `#FFFFFF` | a solid gold chip, and what is legible on it |
| `--win` | `#C8553D` | `#A8452F` | terracotta — winners, in-progress |
| `--ok` / `--warn` / `--rust` | `#1F6B2E` / `#A05A12` / `#C8553D` | `#1B6029` / `#96520E` / `#A8452F` | success / warning / destructive |
| `--paper`, `--paper-ink`, `--paper-muted`, `--paper-line` | `#F8F2E5` / `#211A12` / … | `#FFFFFF` / `#2A2016` / … | the photo-paper surface — light in **both** themes |
| `--card-border` | `transparent` | ink 12% | dark needs no border; light does |
| `--card-emboss` | white 6% | white 65% | top highlight on a raised strip |
| `--shadow-c`, `--sh-1/2/3` | `rgba(12,5,0,.62)` | `rgba(120,88,44,.20)` | shadow ramp, tinted to the ground, never pure black |
| `--well` | `var(--bg-0)` | `var(--bg-0)` | a field sunk *into* a card (set by the re-point, §4.2a) |
| `--ghost-ink` | `var(--ghost-ink-paper)` | ← | ghost-player silhouettes. An alias, so a paper island can restore it (§4.2b) |
| `--accent-on-paper` | `#8A5F0B` | `#7F540D` | the value behind `--accent-ink`, and the one thing a paper island needs back |
| `--ghost-ink-paper` | `#3B2A1C` | `#3B2A1C` | ditto for `--ghost-ink`; theme-independent, because paper is light in both |
| `--rust-ink` / `--on-rust` | `#A8452F` / `#FFFFFF` | ← | rust as ink on paper — the negative-score marker. Theme-independent |
| `--photo-plate` / `--on-photo` | `rgba(255,251,241,.9)` / `#211A12` | ← | a control sitting on an uploaded **photograph**. Never follows the theme |
| `--b1` / `--b2` / `--b3` / `--bc` | oklch, dark | oklch, light | **the DaisyUI base.** Overriding these per theme is what re-themes the ~158 rules painting with `oklch(var(--b*))` without touching one of them |
| `--game-accent` | per-game `theme_color`, set inline | ← | the hairline accent on a specific Game's tile / detail / play card |
| `--exp-color` | per-expansion, set inline | ← | the colored dot identifying a chapter's source expansion |

`--polaroid-*` is an alias family pointed at the paper tokens at `:root`, so the 69 rules that paint with it follow both themes without being edited.

`--game-accent` and `--exp-color` are the only tokens routinely set inline; they have to be, because they are data-derived. Every other color comes from the stylesheet. The two `#C9922A` literals that used to be set inline for `--exp-color` are gone; the remaining JS literals are `--game-accent`'s, tracked in `UI_AUDIT.md` §8.3.

The repo-wide statement of this vocabulary is `.claude/rules/theming.md`.

### 4.2a Ground tokens vs paper vs chrome

The app has two themes, switched by `data-bgb` on `<html>` (`domain/theme.js`, with a pre-paint boot inline in `index.html`). `--b1`/`--b2`/`--b3`/`--bc` are redefined per theme, so anything painting with `oklch(var(--b*))` follows the theme automatically. `<html data-theme="luxury">` is DaisyUI's own attribute and is deliberately *not* the light/dark lever — leave it alone.

The trap is not dark-vs-light, it is **what kind of surface this is**. There are three:

| Surface | What it is | Light | Dark |
|---|---|---|---|
| **Ground** (`--b*`, `--bg-*`, `--ink*`, `--line*`) | the page itself | warm cream | espresso |
| **Paper** (`--paper*` → `--polaroid-*`) | things that are *photographs* — play cards, the Gather grid, the parchment scroll | cream | **cream** |
| **Chrome** (`--sheet-*`, `--well`) | plain UI cards — the profile hub, the spokes, Settings, the picker sheets | white | espresso |

Paper is the odd one: it is light in **both** themes, because photo paper is light in any light. That is the trap. Point a ground token at a paper surface and it inverts — `oklch(var(--b2))` becomes a black box on cream, `--accent-hover` becomes pale gold text at 1.6:1. Both of those shipped.

Chrome is the counterpart added when the profile hub and spokes were darkened: they had been borrowing the paper tokens, which made the brightest screens in the app the ones furthest from its dark identity. Chrome follows the ground; paper does not.

There is no separate `--chrome*` token family any more. Chrome is produced by **re-pointing** the alias tokens a surface already reads, in one block, at the ground tokens:

```css
:is(.set-card, .profile-stat-card, .statsblock, .preview-card, .bgb-spoke-screen,
    .game-picker-sheet, .player-picker-sheet, .game-search-sheet,
    .exp-picker, .import-exp-modal, .cascade-player--drag-clone,
    [data-view="log-play"], [data-view="play-flow"], [data-view="session-viewer"]) {
  --polaroid-bg: var(--bg-1);  --polaroid-ink: var(--ink);  --polaroid-line: var(--line);
  --card-border: var(--line);
  --sheet-card: var(--bg-1);   --sheet-ink: var(--ink);     --sheet-line: var(--line);
  --well: var(--bg-0);         /* fields sink into the card, not onto it */
}
```

**`--paper*` is deliberately not in that list.** The split is load-bearing:
`--paper*` is the real thing and is never re-pointed; `--polaroid-*` is the alias
family a chrome surface re-points. That is the whole mechanism behind §4.2b —
an island restores itself by pointing the alias family back at `--paper*`, which
it could not do if this block moved `--paper*` too.

**Every value is a `var()`, so this block is not theme-scoped** — each theme supplies its own and both work by construction. Only values that genuinely differ by theme live in the `[data-bgb="dark"]` branch beside it (`--accent-ink`, `--polaroid-accent`, `--ghost-ink`, `--ok`, `--warn`, `--rust`), because "gold that survives a light card" and "gold on espresso" are different colours.

This is a rule, not a style preference. Two PRs each shipped a dark-only re-point for the same problem; they targeted overlapping selectors at identical specificity (0,3,0), so the cascade settled it on source order and the profile screens rendered at three different card tones with `--ok` defined in two different greens. Collapsing to one theme-agnostic block was −120 lines.

**The play cascade sits one step brighter.** `[data-view="play-flow"]` and
`[data-view="session-viewer"]` take everything above and then lift the card from
`--bg-1` to `--bg-2` in a small second block, so the three screens you only see
during a live game read as raised under the lamp. It sets four values —
`--polaroid-bg`, `--polaroid-bg-soft`, `--sheet-card`, `--well` — and nothing the
dark branch sets, so the two never interact. It carries `.player-picker-sheet`
and `.game-search-sheet` with it because Gather is their only call site; a sheet
must never land a step below the card that opened it. `.game-picker-sheet`
(Stats) and `.exp-picker` (Collection) stay at `--bg-1`. **If a sheet ever gains
a second call site across that line, it can no longer sit in either list and has
to take its tone from the screen that opened it.**

**The picker sheets are in that list by name on purpose.** `ui/bottom-sheet.js` appends to `<body>`, so a sheet lands *outside* the screen that opened it and keeps the root paper aliases — which in dark meant tapping a control on an espresso screen threw up a cream sheet. **Add the next searchable sheet to that list by name.** Do not sweep them in by the shared `.bgb-sheet` class: that class is also on the collection status sheet, which is a deliberate sheet of paper and is cream in both themes.

Also worth knowing: custom properties substitute **where they are declared, not where they are used**, so a re-point has to restate every alias it wants changed.

On a paper **or** chrome surface, use the surface tokens rather than the ground ones:

| Ground token | Paper / chrome equivalent |
|---|---|
| `oklch(var(--b1))`, `oklch(var(--b2))` | `--polaroid-bg`, `--polaroid-bg-soft`, `--sheet-card` |
| `oklch(var(--bc))`, `--ink` | `--polaroid-ink` |
| `--ink-muted` | `--polaroid-muted` |
| `--line`, `oklch(var(--b3))` | `--polaroid-line`, `--sheet-line` |
| `--accent`, `--accent-hover` (as text) | `--accent-ink` |
| `--accent` (as a solid fill) | `--accent-fill` + `--on-accent` for what sits on it |

`--sheet-*` is the `.bgb-spoke-screen` family specifically. Neither theme paints a full-bleed sheet any more — the page ground shows through and the cards carry the separation (white + `--card-border` in light, `--bg-1` + a hairline in dark). The class was called `.bgb-cream-screen` until the cream sheet it was named for stopped existing; the rename was a 67-selector sweep that should have happened when the surface changed.

Because the re-point above sets these aliases, a rule written in polaroid tokens travels correctly onto those screens without knowing it — which is why a *genuine* photo surface nested inside one used to be flatly forbidden. The play cascade is the first screen that nests two, so the rule is now conditional rather than absolute. See §4.2b.

No re-pointed screen renders a `.play-card` or a `.game-polaroid`; that half still holds, and is still worth checking before you add the first one.

### 4.2b Paper islands — nesting a photo surface inside a chrome screen

A nested paper surface is safe **iff it reads no alias the re-point moves**. There are two ways to get there, and the play cascade uses one of each:

- **Hoist its ink out of the alias families.** The parchment reference scroll (`.scroll-panel`) paints from literals — a fixed gradient and `#2B1D0A` ink — because a scroll is a photograph and photographs are light in every theme. It read exactly one token, `--accent-ink` on chapter links, which the re-point lifts to `var(--accent)`: gold tuned for espresso, ~1.6:1 on parchment. That link now reads `--accent-on-paper`, which nothing re-points, so the scroll is immune by construction rather than by luck.
- **Restore the alias family, pointing it back at `--paper*`.** The scoring grid is a deliberate cream scorepad — a score sheet on the table — so `.cascade-card--scoring` re-points `--polaroid-*` back onto `--paper*`, plus `--accent-ink` → `--accent-on-paper` and `--ghost-ink` → `--ghost-ink-paper`. Every value is a `var()`, so it is theme-agnostic exactly like the block it counteracts. It must also restate `--well`, which the screen set to `var(--bg-0)`: a well cut into cream paper is not the espresso ground.

Two values needed a source token of their own before this worked at all, because the dark branch supplies them as **literals** rather than as `var()`s — an island cannot restore what it cannot name. Hence `--accent-on-paper` and `--ghost-ink-paper`, with `--accent-ink` and `--ghost-ink` now aliases of them.

**Specificity is load-bearing.** The dark branch is `(0,3,0)`. A bare `.cascade-card--scoring` is `(0,1,0)` and would lose `--accent-ink`, `--ghost-ink` and `--polaroid-accent` to it in dark — a cream grid wearing espresso-tuned gold. The island doubles the class (`.cascade-card.cascade-card--scoring`) to reach `(0,4,0)` and win outright rather than on source order. Do not "simplify" that back: settling this on source order is exactly how #533 and #534 left three screens at three different card tones.

**Before nesting any other paper surface**, grep its rules for `--polaroid-*`, `--paper*`, `--accent-ink`, `--ghost-ink`, `--ok`, `--warn` and `--rust`. If it reads one, either it must not nest, or that value has to leave the alias families the way `--accent-on-paper` did.

**Rule of thumb:** before placing any element on a paper surface, grep its CSS for `oklch(var(--b` and `--accent-hover` — if either is there, re-point it at the paper column above.

This is **not just an input problem**. Any element whose default styles reach for the DaisyUI base palette will hit it: inputs, textareas, selects, dropdown menus, suggestion rows, autocomplete items, list rows. Even a card written for the dark feed and then rendered inside a spoke screen suffers — which is why ~20 of the `.bgb-spoke-screen X` rules exist purely to undo the DaisyUI base for `X`.

Existing canonical overrides to copy — grep the class name rather than trusting a line number:

| Surface | Pattern |
|---|---|
| `<input class="input input-bordered">` | `.bgb-spoke-screen .input` — scoped override |
| `.buddies-row` (the Buddies / Sent / Incoming rows) | `.bgb-spoke-screen .buddies-row` — scoped override |
| `.game-finder-dropdown` (Log play → pick game) | own class family, polaroid tokens by default |
| `.buddies-link-results` (Buddies → Link ghost) | own class family, polaroid tokens by default |
| `.bgb-sheet__*` (every bottom sheet) | own class family, plus the sheet's class named in the re-point list |
| `.scoring-*` (the round grid) | **the cleanest example of the rule below.** Renders on paper (the play-detail popup) *and* chrome, so it is defined once in surface tokens in its own family and travels to both. It used to carry two byte-identical per-view override blocks; both were deleted, not edited |

If a component is **only ever used on one surface** (like `.buddies-row` today), the scoped override pattern is fine. If a component is shared across surfaces (like `.game-finder-*`), define it in surface tokens directly in its own class family so it travels.

*(`.cascade-buddy-dropdown` used to be listed here. It was deleted when the Gather player picker became a sheet — see §4.4. `.search-hit` was listed here too, as the one-surface example, until the Buddies screen's profile-search bar became the Add button and the family went with it.)*

### 4.2b Contrast

Every colour change states its ratio, in both themes, in the commit that makes it. The comments in `styles.css` carry the failures they fixed — `#1F6B2E is 1.4:1 here`, `the paper gold is 1.5:1 here`, `only 4.2:1 on the cream above` — because a token that reads fine in the theme you happened to have open is the whole failure mode. The theme unification pass recorded a minimum of 4.82 dark / 4.54 light across every pair it touched; treat that as the floor.

### 4.3 Bottom sheets

Every choice list in the app is a **bottom sheet**, not a `position: absolute` dropdown. The shell is `ui/bottom-sheet.js` (`window.BgbBottomSheet`) — 165 lines that own the lifecycle only: body-level creation so the sheet survives a view's `innerHTML` swap, scroll lock, delegated clicks, capture-phase Escape with an `onEscape` first-refusal hook, guarded focus return, the close animation, orphan teardown. **Nothing about how a sheet looks lives there.** Each sheet writes its own markup, on the shared `.bgb-sheet__*` panel chrome plus its own row family.

Eight consumers today (this table had drifted at four — grep `BgbBottomSheet`
rather than trusting a count):

| Sheet | File | Shape |
|---|---|---|
| Status picker | `ui/status-tag.js` | radio group, its own `.status-sheet__*` chrome, deliberately paper in both themes |
| Stats by-game picker | `widgets/game-picker-sheet.js` | single-select, client-side filter |
| Gather players | `widgets/player-picker-sheet.js` | **multi-select**, footer confirm, tick order preserved |
| Gather game | `widgets/game-search-sheet.js` | hosts `widgets/game-finder.js` with `inlineDropdown` |
| Settle Up country | `widgets/country-picker-sheet.js` | single-select over 247 rows, filter matches name **and** code, plus a pinned opt-out row |
| Collection expansions | `widgets/expansion-picker-sheet.js` | single-select over one base game's catalog expansions (`.exp-picker`) |
| Shelf of shame | `widgets/shelf-of-shame-sheet.js` | the unplayed-games list behind the Stats card, with a played-before toggle per row (`.shelf-sheet`) |
| Add a buddy by QR | `widgets/buddy-qr-sheet.js` | two tabs on one sheet — show my code, or scan theirs (`.buddy-qr-sheet`) |

`views/achievements-view.js` also opens one directly (`.ach-sheet`) rather than
through a widget module.

They replaced dropdowns because the dropdown geometry was unwinnable: `ui/dropdown-fit.js` existed only to measure a dropdown against the visible viewport and shrink or flip it, `.cascade-buddy-dropdown` carried an explicit z-index to paint over the docked Continue CTA, and its max-height had already been raised once. Measured: a four-player roster clamped the buddy list to 168px — one and a half rows of seven — sitting on the Continue button and running off the bottom edge, before the keyboard was even up. A sheet is `position: fixed` at z-index 100, sized off `--bgb-vv-h`, so none of that is expressible.

`ui/dropdown-fit.js` survives for the two finders still mounted as dropdowns (inside `.add-game-modal`, and any finder without `inlineDropdown`).

The repo-wide statement is `.claude/rules/overlays.md`.

### 4.3a The search field's ×

`ui/search-field.js` is the sheet shell's smaller sibling, and it exists for the
same reason: **one lifecycle, many looks.** Fourteen search boxes across the app
— five of which had each grown their own clear button, with three different
`data-*-action` spellings — now share two delegated `document` listeners:

- `input` inside a `[data-search-host]` shows or hides that host's ×.
- a click on the × empties the input, hides itself, **dispatches a real
  bubbling `input` event**, and re-resolves the field by id to restore focus.

That dispatch is the whole design. Every call site already had an input handler
— an inline `oninput`, an `addEventListener`, a debounced search — so a
synthetic event runs it unchanged and *no screen needs a clear path of its own*.
Escape handlers that used to duplicate the clear call `BgbSearchField.clear(root)`
and land in the same place.

Delegation on `document`, rather than binding per field, is not a shortcut:
nearly every host here repaints by replacing `innerHTML`, so a bound listener
would need re-attaching after each paint, and the one call site that forgot
would have a dead ×.

Two entry points, split the way §4 splits everything else — the shell owns the
behaviour, the caller owns the markup:

| | For |
|---|---|
| `render(opts)` | a plain box with no chrome of its own (the Collection / Plays / Buddies / Add Games searches). Emits `.search-field`. |
| `clearButton(opts)` | a host that already draws its own field — `.game-finder`, the parchment scroll's search row. Those add `data-search-host` to the wrapper they have. |

The × itself is one class, `.field-clear-btn`, 44×44 whatever the field's own
height, so the hit area is the tap target and the glyph inside it is the
control. It reads `--polaroid-*`, so it follows whichever surface it lands on —
except on the parchment scroll, which is a paper island (§4.2b) and scopes the
button to the parchment's own ink.

### 4.3b The BGG import log, and the polaroid field

Two more extractions of the same shape, both landed when the first-run
"Link BoardGameGeek" step (`widgets/onboarding-bgg-modal.js`) became the second
place in the app that needed something Settings already had. Instance #2 is the moment
(`.claude/rules/ui-object-design.md` §4), not instance #4.

**`ui/bgg-import-log.js` (`window.renderBggImportLog`)** is the live readout of a
BGG import — five steps from "asking BoardGameGeek" through the streaming list of
game titles the worker is fetching to the final totals. It is a **pure function of
two payloads**: the `POST /bgg/sync` summary (what landed immediately, how much
was queued) and the latest `GET /bgg/sync/status` (how far the worker has drained
that queue). No fetching, no timers, no DOM — the caller owns the poll and
re-renders the host on each tick. It was `SettingsView._renderBggProgress`; both
surfaces now render the same function, differing only in a layout class
(`bgg-log--card` supplies the Settings card's gutters).

Two behaviours came out with it, onto `domain/bgg.js`, because they are the same
question asked twice rather than shared markup:

- `Bgg.importDrained(status)` — the single definition of "the queue is empty".
  It reads the **session** counters, never the lifetime `pending_count`, so a row
  left behind by an earlier failed sync cannot pin a poll open forever.
- `Bgg.invalidateImportedData()` — the single post-sync cache drop (the
  collection status map and the feed).

`Bgg.sync()` also carries its own deadline. `POST /bgg/sync` walks an entire BGG
collection and play history *inside the handler* before it answers, so the API
client's 15s default aborted mid-size accounts routinely — and the abort was a
lie, because the handler finishes the sync and queues the background worker
whether or not anyone is still listening. `api.post` grew a `timeoutMs` opt for
it (120s), and both surfaces report a tripped deadline as *the import is still
running*, never as a failure.

**`.polaroid-field*`** is the CSS half of the same story: a labelled text field on
a polaroid card, shared by the avatar customizer's display-name input and the BGG
step's credentials. Callers keep their own layout class and their own JS hook
class; the shared family owns the look. It reads `--polaroid-*` because the card
is **paper** (§4.2a) — light in both themes, which is also why its white fill is a
deliberate literal. Extracting it fixed a tap target on the way: DaisyUI's
`input-sm` is a 32px control, under the 44px floor, so the family releases the
fixed height and sizes against a `min-height`.

It has since acquired one caller that is *not* on paper — the first-run deck
(§4.3c) — and that is exactly the trap §4.2a describes: on a chrome surface
`--polaroid-ink` resolves to `--ink`, which is cream text on the family's white
literal. The deck scopes its own fields to the ground's `--well` rather than
changing the shared rule, which still has three callers that are genuinely on
paper.

### 4.3b-ii The comparison, the push log, and the sync sheet

The BGG card grew a second direction, and with it three components. `ui/bgg-log-step.js` is the step row promoted out of the import log the moment a second log needed it (`.claude/rules/ui-object-design.md` §4, extract at instance #2) — both logs narrate different sequences but a step is a step.

`ui/bgg-push-log.js` is deliberately **not** a variant of `renderBggImportLog`. That one walks five import-specific counters (`collection_imported`, `plays_pending`, `unique_games_to_import`) with no push analogue; parameterising it would be the options-matrix anti-pattern §2 warns about. Two components, one shared step primitive, one CSS family.

`ui/bgg-diff-list.js` is the opposite call — one renderer with two variants, because there are two surfaces from day one: `card` is the summary under Check status, `sheet` is the grouped review list. It also takes a `direction`, since the push and pull sheets are the same comparison read opposite ways.

Two details that are load-bearing rather than cosmetic. The pull sheet's `held` group — games kept at Prev. owned that `_hold_prev_owned` refuses to resurrect — is a *reassurance*, not a change: it is excluded from the count and the commit label, and wears a neutral stripe, because the destructive red would read as though the sheet were about to delete the thing it is promising to keep. And the sync buttons spell their direction with the two brand marks rather than acronyms, so each needs a real `aria-label`: two SVGs and an arrow tell a screen reader nothing.

### 4.3c The first-run deck, and the badge picker

First-run setup used to be three modals opened back to back, each awaiting its
own write before the next appeared. It is now **one mounted deck** —
`widgets/onboarding-deck.js` (the shell, the queue and the ledger) plus
`widgets/onboarding-deck-slides.js` (the four panels) — and the split between
those two files is the same lifecycle-vs-appearance seam the bottom-sheet shell
uses: the shell owns the track, the counter and the write queue and knows
nothing about what a slide contains; a slide says `deck.next()` and stops
caring.

Three properties are load-bearing, and each is a rule this codebase already had:

- **No handler awaits.** Continue and Skip queue a write through `deck.queue()`
  and move the track in the same frame. An `await` in a button handler here is
  the bug; the ledger on the finale is where an outcome belongs.
- **A promotion appends.** Ticking a suggestion inserts the people they know
  below the grid rather than re-rendering it, so the tile under the thumb
  survives (`.claude/rules/overlays.md` §6). Untick takes nothing back for the
  same reason.
- **The deck is chrome, the picker is paper.** `.ob-deck` joins the re-point
  lists in `styles.css`, so its tiles and fields follow the ground in both
  themes; `.ob-paper` restores the alias family for the badge carousel at
  (0,4,0), for the reason §4.2b spells out.

**`ui/avatar-picker.js` (`BgbAvatarPicker.mount`)** is the third extraction of
the shape described above: the icon carousel, the Icon/Background target toggle
and the swatch grid, lifted out of `PolaroidPopup.avatarCustomizer` the moment
the deck's first slide became its second caller. The customizer keeps its
polaroid chrome and its Cancel/Save; the deck keeps its slide and its Continue;
neither owns the carousel any more. It kept the `.avatar-cust__*` class family
deliberately — the CSS was already right, and renaming it would have been a
sweep with no reader. `refresh()` exists because a picker mounted off-screen
measures its reel as zero.

**`domain/buddy-network.js` (`BuddyNetwork`)** is the same kind of extraction
applied to a *decision* rather than a component: which people a tick has earned,
deduped across seeds, in rank order. The deck and the Buddies-screen card share
it, so "who does ticking Priya introduce" cannot answer differently on the two
surfaces that ask.

### 4.4 Chrome, layering and mobile

The pinned chrome is a system, documented in `.claude/rules/web-frontend.md` (§ App chrome & layering) and `.claude/rules/mobile-web.md`. The parts specific to this app:

- **z-index ladder:** view content < 20 pinned spoke back-row < 30 global header < 35 docked footers (`.cascade-cta-wrap`, `.bgb-install`) < 36 `.cascade-error` < 40 `.bgb-nav` < 45 toasts < 100 `.polaroid-popup__backdrop` (every modal and sheet).
- **Heights are tokens:** `--bgb-nav-height: 64px`, `--bgb-header-height: 53px`, with `:root { scroll-padding-top: calc(var(--bgb-header-height) + 8px) }` derived off the second so `scrollIntoView({block:"start"})` clears the sticky header.
- **The global header is sticky at `top: 0`; each spoke's back row is sticky at `top: var(--bgb-header-height)`**, sharing the header's treatment so the two read as one stack. Scoped to direct children of `<main data-view>` — the same class nested in a card must not pin.
- **Settings closes, spokes go back.** Settings is reachable from the gear in the global header, i.e. from any screen, so it dismisses with a trailing-edge × calling `router.back('profile-self')`; the fallback only covers a cold `/settings` deep link. The five spokes are reachable only from the hub, so they carry a leading-edge ← .
- **`body { overflow-x: clip }`, never `hidden`** — see the comment in `styles.css`; `hidden` made `<body>` a scroll container with no height and every `position: sticky` in the app rode off-screen.
- **`ui/viewport-lock.js`** publishes `--bgb-vv-h` / `--bgb-vv-top` / `--bgb-kb-inset` and the `.bgb-kb-open` root class from `visualViewport`; **`ui/zoom-lock.js`** holds the page at 1x in an iOS Safari tab. Deliberately two modules: one measures, one prevents.
- **The 16px input floor must stay the last block in `styles.css`** — its selectors tie on specificity with the component rules they override, so the win comes purely from source order.

### 4.5 Motion

Two motion patterns are codified in `.claude/rules/web-frontend.md` ("Motion" section) and applied via the `.animate-fadeUp` class with `animation-delay: calc(var(--i) * 40ms)` for staggered entrance. `--ease` is the project's shared curve. The play card adds a flip animation managed inside `ui/play-card.js` (state Map keyed by `play_id`); sheets animate in and out on `sheetIn` / `sheetOut`, whose duration must stay in step with `CLOSE_MS` in `ui/bottom-sheet.js`. Press feedback is `:active` — the polaroid tilt animation was removed.

---

## 5. Screen flow

The app is a single-page shell. `index.html` contains 18 `<main data-view="...">` containers and a single global header + bottom nav. The router toggles `.hidden` between containers — `init.js` registers every view at boot.

### 5.1 The View base class (`domain/view.js`)

Every screen extends `window.View`:

```
class FeedView extends window.View {
  async onMount() { … fetch + subscribe to store … }
  async onUnmount() { … unsubscribe … }
  render() { … paint into this.host … }
}
```

The router calls `mount(hostEl)` → `onMount()` → `render()` synchronously when the user navigates. **Navigation is instantaneous** (per `.claude/rules/web-frontend.md`): the destination view's `render()` paints an empty/loading shell before any `await` fires.

### 5.2 The three "tab" routes

The bottom nav has three slots — they are the user's home base.

```
  Feed (home icon)     Play (gold disc)        Profile (user icon)
  ─────────────        ───────────────         ─────────────
  feed                 log-play   (entry)      profile-self
                        ↓
                       play-flow (cascade)
                        OR
                       join-session
                        ↓
                       session-viewer
```

### 5.3 Object-centred navigation

Most navigation between screens is **drill-into-an-object**. The graph below shows the typical paths.

```
                       ┌─────────────────┐
                       │      feed       │ ◀───────────── Bottom-nav "Feed"
                       └────────┬────────┘
              tap play card     │     tap game name on play card
              maximize          │     ↓
              ↓                 │   ┌─────────────────┐
        ┌─────────────────┐     │   │   game-detail   │ ◀── Tap any game tile, anywhere
        │  PlayDetailPopup│     │   └────────┬────────┘
        │      (modal)    │     │            │
        └─────────────────┘     │            │ tap "Add chapter"
                                │            ↓
              tap player name   │   ┌─────────────────────┐
              ↓                 │   │ reference-guide-add │
        ┌─────────────────┐     │   └─────────────────────┘
        │  profile-other  │     │
        └────────┬────────┘     │
                 │              │
                 │              │
  ┌──────────────┴──┐           │
  ↓                 ↓           ↓
collection       plays      session-viewer (joiner)
?shelf=owned|               play-flow (host) ◀───────── Bottom-nav "Play"
 wishlist|played|
 expansions
(spokes from profile-self)
  │
  │ "+ Add"
  ↓
add-games  ── the whole catalog as one scroll; one tap per row shelves a game.
              Its own toggle says which shelf the tap fills, so it is one
              screen rather than two near-copies — the same argument that
              later collapsed the wishlist spoke into `collection`.


Bottom-nav "Profile"
        │
        ↓
┌─────────────────┐
│  profile-self   │ ◀── the hub
└────────┬────────┘
         │
         ├── Your stats  → stats     (podium + per-game breakdown)
         ├── See all → achievements  (nineteen badges, five groups)
         ├── See all → collection
         ├── See all → collection?shelf=wishlist
         ├── See all → plays
         ├── See all → buddies
         └── Settings icon → settings → admin (gated)
```

The two key observations:

1. **`game-detail`, `profile-self/other`, and `play-flow` are the "destination" screens.** Everything else either lists them or details them. `add-games` is the one screen that deliberately isn't a drill-in: it is a *catalog*, and its rows mutate the viewer's relationship to a Game rather than navigating to one — though the tile inside each row still drills into `game-detail`, because deciding whether you want a game is what the game page is for.
2. **The chronological `feed` is the main loop.** A user opens the app, sees recent plays from their buddies (Play objects), maybe taps a player avatar (→ User), maybe taps a game name (→ Game), maybe maximizes a play card (→ Play detail). All four flows are object-drilling.

### 5.4 The Play cascade

Logging a Play is the most elaborate flow because it edits a live Session. It is intentionally separate from the rest of the app's "drill into object" pattern — it's a transient editing surface, not a view of an existing thing.

```
log-play (Host or Join?)
   │
   ├── Host → play-flow (Gather phase)
   │            ↓ all players added, game picked
   │          play-flow (Play phase)         ← Reference guide visible
   │            ↓ host taps "Wrap up"
   │          play-flow (Settle phase)       ← Photo + notes + scores
   │            ↓ host taps "Save"
   │          finalizes into a Play, lands back on feed
   │
   └── Join → join-session (pick by code or list)
                ↓
              session-viewer  (read-only mirror; own column editable)
                ↓ host finalizes
              flips into PlayDetailPopup with finalized play
```

The cascading three screens use snap-scroll so the host can swipe back to revisit a previous phase. The joiner's `session-viewer` mirrors the host's phase via polling + Realtime.

**Where the play happened** (migration 065). The draft is born carrying an ISO
3166-1 alpha-2 country, resolved by `domain/geo.js` from the device's IANA
timezone — no location permission, no network, no third-party service, and a
granularity that cannot say where anybody lives. Settle Up shows it on a Where
card and the host can change it through `widgets/country-picker-sheet.js`; a
hand-pick is remembered against the timezone it was made in, so a correction
sticks at home without following the host to a convention abroad. The value
rides `PlaySession.toPlayCreate()`, which means it reaches the column the same
way through all four write paths — solo log, hosted finalize, offline outbox
flush, and the native app (`app/src/models/geo.js`, detection only for now).

Nothing reads it yet. It exists so that "what gets played in Germany" is
answerable later, and that answer can only be built from data collected
forwards: a play logged with no country can never be given one. `null` is a
first-class value throughout — an unresolvable device, a host who opted out,
and every play predating the column all land there, and any future aggregate
filters them out and reports its own coverage.

---

## 6. How OOD shows up in the code

A new contributor reading the codebase should expect to find:

1. **One file per object in `domain/`.** Don't add domain logic to a view; if a view needs to reshape data, write an adapter method on the view (private), or push the reshape into the domain file.
2. **One canonical render function per object in `ui/`.** When you need to show an object on a new surface, **find the existing render function and reuse it.** Add a `variant` option if the surface needs a tweak; do not write a parallel implementation.
3. **Views are thin.** A view's job is to: fetch data via `domain/*.js`, subscribe to relevant `store` keys, and compose UI components. A view should rarely emit raw markup for an object — that is the component's job.
4. **Composite widgets in `widgets/`** are the place for stateful, multi-component UIs that don't represent a single object (e.g. the parchment-scroll guide widget, the scoring grid). Each one names a class or object with a `mount(host)` + `render()` lifecycle.
5. **Inline DOM markup in `index.html` is rare and intentional.** The global header and the bottom nav are the only places we hard-code structure because they persist across all routes. Everything else is built by JS.

If you are adding a feature and find yourself emitting `<article class="some-new-card">…</article>` directly inside a view, stop and ask: is there an existing card for this object? If yes, use it. If no, is this object a core object that deserves a canonical component? If yes, write one in `ui/` and migrate existing surfaces toward it.

---

## 7. The visual continuity contract

Three rules that hold the experience together. They are derived from the audit findings and codified here for new contributors.

### Rule 1 — Same object, same look

A Game in the feed's "hot games" rail, a Game in the collection grid, and a Game on the game-detail page should all read as **the same kind of thing**. The size and density can differ; the typography, the status badge, and the accent color must not.

> Today's state: the six bespoke tiles violate this rule. See UI_AUDIT.md §5c.

### Rule 2 — Same action, same affordance

If two surfaces let the user open the same destination, they should use the same affordance. If maximizing a play card opens the `PlayDetailPopup`, then tapping a row in the chronological plays view should open the same popup the same way — either by the same icon button or by the same full-card tap.

> Today's state: maximize button on the play card vs full-row tap on `.plays-list__row` (same destination, different affordance). See UI_AUDIT.md §5b.

> The second corollary for *mutations*: **restructure only on an interaction that has already broken continuity** — a mount, a page turn, a search, a confirm dialog — and **patch in place on one that hasn't**, i.e. a single tap on a list control. `.claude/rules/web-frontend.md` exempts membership changes from the surgical-repaint rule, but that exemption is about a repaint's *scope* and says nothing about its *timing*. The Buddies screen repainted the whole container in the tap's own frame, which slid the suggestion rail sideways and sent the next tap — already on its way down — to the wrong person. The affordance corollary is the visible half: a control that has been acted on shows a **verb** for what happened (Sent, Accepted, Declined), never a state like "Buddies" that its own section heading contradicts, because the row has deliberately not moved yet. See the rule block above `_personFor` in `views/buddies-view.js`, and `ui/buddy-suggestion-rail.js`'s `state` opt, which is what keeps the Feed rail, the Buddies rail and the onboarding grid agreeing on what a Sent tile looks like.

> The corollary for *mutations*: there are two ways to shelve a game and they are deliberately different tasks, not two affordances for one. The **status sheet** behind a tile's corner chip is "where does this one game sit?" — a radio group over owned / wishlist / remove, reachable from any tile anywhere. The **Add Games** row button is "fill my shelf" — one tap, one shelf, stated by the page's own toggle, repeated down a list. Add Games therefore turns the tile's corner chip off (`showStatus: false`): two controls on one 44px row, one of them opening a sheet that says what the other already shows, is the version of this that would violate the rule.

### Rule 3 — Destructive actions are confirmed through `PolaroidPopup.confirm`

Per `.claude/rules/web-frontend.md`, all destructive actions go through the project's single confirm modal. No view rolls its own confirm dialog. This applies to: delete a play, remove a buddy, abandon a session, abandon a Gather draft, clear a collection, delete an account.

**One carve-out: a confirm whose subject is a LIST is a sheet.** Both BGG syncs are destructive — the push overwrites the user's BoardGameGeek collection, the import overwrites their BgB shelf — and the only honest confirmation names every row it will touch. `PolaroidPopup.confirm`'s `body` is a plain string that gets `escapeHtml`'d, so it cannot render a list at all, and a 500-row list in a centred card is the geometry `.claude/rules/overlays.md` §1 exists to prevent. So `widgets/bgg-sync-sheet.js` is a `BgbBottomSheet`, and **the sheet's commit button is the second tap** — one overlay for one decision, not a sheet with a confirm stacked on top of it. Any future confirm that needs to enumerate rather than assert belongs here too; anything that fits in a sentence does not.

> Today's state: respected. See UI_AUDIT.md §3.8.

---

## 8. File map

```
projects/boardgame-buddy/web/
├── index.html              ← single-page shell: header + bottom nav + 19 view containers
├── init.js                 ← view construction, router registration, Supabase boot
├── helpers.js              ← jsStr, buddyLoader, formatDate, toast
├── config.js               ← API base URL
├── styles.css              ← all CSS: token blocks first, then one section per class family
│
├── domain/                 ← Domain objects (see §2)
│   ├── api.js              ← HTTP client + auth headers + request deadlines
│   ├── store.js            ← Cross-cutting state with subscribe()
│   ├── view.js             ← Base View class + Router
│   ├── theme.js            ← light/dark controller (see §4.2a)
│   ├── net.js, cache.js, outbox.js, bootstrap.js          ← Offline + caching
│   ├── game.js, play.js, buddy.js, user.js, collection.js, profile.js, stats.js, achievements.js, …
│   ├── shelf-controller.js, shelf-filter.js               ← Client-side shelf paging
│   └── play-session.js, session-phase.js, live-scores.js, score-write-queue.js  ← Session state
│
├── ui/                     ← Canonical render functions per object (§3) + app-wide primitives
│   ├── play-card.js         → renderPlayCard         (Play)
│   ├── user-badge.js        → BgbBadge.render        (User)
│   ├── game-card.js         → renderGamePolaroid     (Game — Gather grid only)
│   ├── status-tag.js        → renderStatusTag, renderExpansionBadge, the status sheet
│   ├── buddy-suggestion-rail.js → the rail shared by Feed and Buddies
│   ├── avatar-picker.js     → BgbAvatarPicker.mount — the badge carousel, shared by
│   │     the avatar customizer and the first-run deck's slide 1 (§4.3c)
│   ├── polaroid-popup.js    → show/dismiss/isOpen/achievement/confirm/alert/avatarCustomizer
│   ├── markdown.js          → renderMarkdown
│   ├── oauth-buttons.js     → oauthButtons
│   ├── bottom-sheet.js      → BgbBottomSheet — the shell every sheet shares (§4.3)
│   ├── search-field.js      → BgbSearchField — the × every search box clears with
│   ├── bgg-import-log.js    → renderBggImportLog — the BGG import readout (§4.3b)
│   ├── icons.js             → BgbIcons — the vendored Phosphor set + render pass
│   ├── viewport-lock.js     → publishes the visible viewport as CSS properties
│   ├── zoom-lock.js         → holds the page at 1x on iOS Safari
│   ├── dropdown-fit.js      → the residual fit pass for the two remaining dropdowns
│   ├── install-prompt.js    → the PWA install bar
│   ├── achievement-popup.js → queues the "Achievement unlocked!" polaroid
│   └── outbox-indicator.js  → the queued-writes badge in the header
│
├── widgets/                ← Composite stateful widgets (see §6)
│   ├── reference-guide-scroll.js   → ReferenceGuideScroll class (Chapter rendering)
│   ├── round-score-grid.js          → renderRoundGrid (Session scoring)
│   ├── game-info-bar.js             → renderGameInfoBar (Session header on Play)
│   ├── game-finder.js               → the network game search, dropdown or inline
│   ├── player-reorder.js            → drag-to-reorder the Gather roster
│   ├── game-picker-sheet.js, game-search-sheet.js, player-picker-sheet.js  ← sheets (§4.3)
│   ├── add-game-modal.js, import-expansions-modal.js, outbox-modal.js      ← modals
│   │     add-game-modal is no longer the way in to a shelf — views/add-games-view.js
│   │     is. It survives as that page's BGG-import escape hatch.

│   ├── join-panel.js
│   ├── onboarding-deck.js    → first-run setup: the shell, the write queue, the ledger
│   ├── onboarding-deck-slides.js    → its four panels (§4.3c)
│   ├── add-buddies-modal.js  → the Buddies screen's Add button: search or pick, one
│   │     batched send. Was also first-run step 2 until the deck replaced it, and
│   │     still shares the deck's promote logic (domain/buddy-network.js)
│   │     (widgets/onboarding-bgg-modal.js was deleted here — the deck's slide 3
│   │      replaced its only caller, and Settings could already link and sync)
│   └── play-detail-popup.js         → PlayDetailPopup namespace (full Play detail modal)
│
├── views/                  ← One file per screen / route
│   ├── feed-view.js, log-play-view.js, play-flow-view.js, stats-view.js, …
│   ├── add-games-view.js   → the catalog scroll behind both spokes' "+ Add"
│
└── assets/                 ← Brand, illustrations, credits, sprites (per .claude/rules/assets.md)
    └── sprites/achievements/  ← bgb-ach-<slug>.svg — one medallion per badge
```

`Docs/` next to this file holds the audit (`UI_AUDIT.md`), the standalone screen mocks (`mocks/`) and release notes.
