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
| **Play** | `domain/play.js` | A single recorded session of a Game by one or more Users (and possibly ghost players). Owns players, scores, winner, notes, photo, duration, and the country it was played in (migration 065, resolved by `domain/geo.js` from the device's timezone, or by `domain/geo-grid.js` from a photo's own coordinate when the play came in through the importer's photos branch). |
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
| **Game** | `renderGamePolaroid` (partial) | `ui/game-card.js` | ⚠️ Six bespoke tiles (`.collection-tile`, `.hot-game-tile`, `.preview-card__cover` — now drawn once, in `ui/preview-card.js`, for both profile screens — `.game-detail__polaroid`, `.plays-list__thumb`, `.game-polaroid`) still exist. Every game-detail navigation is one handler, `helpers.js#gameDetailJs`, escaped by `renderGamePolaroid` or at the attribute. `renderGamePolaroid` now serves three surfaces through its `variant` opt — `polaroid` (Gather grid, explorer), `rail` (feed rails) and `row` (the Collection spoke's Expansions tree, and the Add Games catalog scroll). The tree went through the canonical component rather than becoming a seventh bespoke tile; `showStatus` and `interactive` opts exist for it (every tree row is owned, and a `role="button"` tile can't nest inside the group's disclosure button). Add Games reused that same row shape — tile plus a sibling quick action, `showStatus: false` because the row's own button already reports the state — so a whole new screen landed with no new Game tile. |
| **Buddy** | _(no canonical row)_ | n/a | ⚠️ Buddy rows are rendered via `BgbBadge.render` for the avatar but the surrounding row markup is duplicated in `views/buddies-view.js`, `views/feed-view.js` (suggestions), and the profile preview. Less severe than Game because the avatar — the visual identity — is shared. |
| **Chapter** | (none yet) | `widgets/reference-guide-scroll.js` renders chapters into the parchment scroll | Chapters are not surfaced outside the scroll, so the rule does not need to be enforced. The one near-miss is the RULEBOOK LINK (migration 052): a game page, a play cascade and a spectator's mirror all used to draw their own rulebook button, and the fix was to delete all three and let the scroll's Rulebook section be the surface — with `Chapter.resolveRulebook` as the single answer to "which link", so two screens can never send the same person to different URLs. If a future change shows a single chapter in a tooltip / preview, that would be the moment to extract a `renderChapter` function. |
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

### 4.3 Bottom sheets and modals

Every choice list in the app is a **bottom sheet**, not a `position: absolute` dropdown. The shell is `ui/bottom-sheet.js` (`window.BgbBottomSheet`) — 165 lines that own the lifecycle only: body-level creation so the sheet survives a view's `innerHTML` swap, scroll lock, delegated clicks, capture-phase Escape with an `onEscape` first-refusal hook, guarded focus return, the close animation, orphan teardown. **Nothing about how a sheet looks lives there.** Each sheet writes its own markup, on the shared `.bgb-sheet__*` panel chrome plus its own row family.

A searchable sheet hands its field to the shell: `open({ search: { listSel, onQuery } })` binds the input, pins the list at its opening height and gives Escape first refusal to clearing the query, so the four picker sheets keep only their list patch. The centred-card sibling is `ui/modal-shell.js` (`window.BgbModal`) — same contract, plus `canDismiss` for a card mid-save — hosting the play-detail popup, the outbox, the expansion importer, the add-buddies card and the release-notice deck. **The release-notice deck is the one BgbModal consumer with a slide track inside it** (`widgets/release-notice-deck.js`): several unseen what's-new notices are one card the reader pages through, not a queue of modals. The reason is mechanical rather than aesthetic — a queue would hit the shell's orphan-teardown path ("a second open while one is closing") N-1 times by design, and would arm N back-guard entries, so the phone's back gesture would walk *backwards through the announcement* instead of dismissing it. The slide mechanics are `widgets/onboarding-deck.js`'s (one track at `width: N*100%`, one transform, the panel count published to CSS as `--rel-panels` so it lives in one place); what is deliberately **not** borrowed is that deck's Escape rule, which refuses Escape because the onboarding deck is the app's own first screen and the only way out is Skip. A release notice is dismissible by design, so all four exits close it and all four mean the same thing. Marking-seen hangs off `onClose`, which is the single funnel the x, the outside tap, Escape, the back gesture and Done all reach — that is what makes closing on slide one and finishing on slide three have identical consequences, and it is the property `tools/check-release-notices.mjs` drives through the shell's own click handler. `ui/polaroid-popup.js` stays its own family (wrap-up, confirm, alert, prompt, avatar customizer): it is a singleton with an in-place `update()` path.

### 4.3d Repainting a card without rebuilding it

`ui/dom-patch.js` (`window.BgbDomPatch.morph(host, html)`) walks a live subtree
against freshly rendered markup and writes only what differs — changed text,
changed attributes, added and removed nodes. Everything else keeps its identity,
and with it the things a rebuild destroys: a photo `<img>`'s decoded bitmap, the
card's entrance animation, a scroller's offset, `:active` under a finger
mid-press, and the focus and caret of the field being typed into.

The play-detail popup is its first consumer, because it is the surface where the
cost was loudest: it paints from a feed seed and then repaints from a confirming
fetch a second later, so a user watched the card they had just opened tear itself
down and come back. `render()` keeps its byte-identity fast path in front of the
morph — when the seed and the row agree there is nothing to do at all — and falls
back to a plain `innerHTML` only on the first paint, where there is nothing to
patch against.

Two things about it are load-bearing beyond the diff itself:

- **Icons are hydrated on the NEW tree before comparing.** `BgbIcons.render`
  swaps `<i data-icon>` for an inline `<svg data-icon-name>`, so the live DOM
  never holds the placeholder a template emits; without that pass every icon
  reads as a tag mismatch and is rebuilt on every morph.
- **`ui/modal-shell.js`'s outside-tap test had to change with it.** It used to
  rely on a repaint detaching the *whole* card, so `closest()` on a detached
  target still found it. A surgical repaint detaches small subtrees instead, so a
  button that removes itself — "Track per-round scores", "Add a photo" — left its
  own click target in an orphan fragment and the press that caused the repaint
  read as a tap outside. The shell now asks `event.composedPath()` first, which
  is fixed at dispatch and cannot be rewritten by a handler. See
  `.claude/rules/overlays.md` §8a.

Matching is positional, except in a container whose element children all carry
`data-morph-key` — the play-detail card's optional sections do, so one appearing
or disappearing cannot slide its siblings by one and pair the photo `<img>`
against a `<section>`.

Eight consumers today (this table had drifted at four — grep `BgbBottomSheet`
rather than trusting a count):

| Sheet | File | Shape |
|---|---|---|
| Status picker | `ui/status-tag.js` | radio group, its own `.status-sheet__*` chrome, deliberately paper in both themes |
| Stats by-game picker | `widgets/game-picker-sheet.js` | single-select, client-side filter |
| Gather players | `widgets/player-picker-sheet.js` | **multi-select**, footer confirm, tick order preserved, ticked rows pinned under **Selected** and filtered by the query |
| Gather game | `widgets/game-search-sheet.js` | hosts `widgets/game-finder.js` with `inlineDropdown` |
| Settle Up country | `widgets/country-picker-sheet.js` | single-select over 247 rows, filter matches name **and** code, plus a pinned opt-out row |
| Collection expansions | `widgets/expansion-picker-sheet.js` | single-select over one base game's catalog expansions (`.exp-picker`) |
| Shelf of shame | `widgets/shelf-of-shame-sheet.js` | the unplayed-games list behind the Stats card, with a played-before toggle per row (`.shelf-sheet`) |
| Add a buddy by QR | `widgets/buddy-qr-sheet.js` | two tabs on one sheet — show my code, or scan theirs (`.buddy-qr-sheet`) |

`views/achievements-view.js` also opens one directly (`.ach-sheet`) rather than
through a widget module.

They replaced dropdowns because the dropdown geometry was unwinnable: `ui/dropdown-fit.js` existed only to measure a dropdown against the visible viewport and shrink or flip it, `.cascade-buddy-dropdown` carried an explicit z-index to paint over the docked Continue CTA, and its max-height had already been raised once. Measured: a four-player roster clamped the buddy list to 168px — one and a half rows of seven — sitting on the Continue button and running off the bottom edge, before the keyboard was even up. A sheet is `position: fixed` at z-index 100, sized off `--bgb-vv-h`, so none of that is expressible.

`ui/dropdown-fit.js` survives only for a finder mounted without `inlineDropdown`. The last centred host it actually served — the BGG import popup — is a sheet now (`widgets/bgg-import-sheet.js`), so nothing in the app takes that path today; the file goes when the option does.

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

### 4.3a-ii The on/off switch

`ui/switch.js` is the third of the same family: **one control, many surfaces.**
`BgbSwitch.render({on, onclick, label?, paper?, compact?})` emits the button and
the `.bgb-switch` class family owns the look — a `role="switch"` +
`aria-checked` button, because the effect is immediate and a checkbox would
promise a form to submit.

It was extracted at instance #2 (`.claude/rules/ui-object-design.md` §4): the
collection's "Show all expansions" wrote the original markup, and the scoring
card's template bar wanted the same control. The geometry is the reason a second
hand-written copy was a bad idea — the knob's travel is *derived* from the track
(width, minus its two borders, minus the padding, minus the knob), so a copy
drifts on the first tweak to either.

The template bar has since given its switch back: the scorepad pills answer
on/off by deselecting, and two controls for one question could disagree about
the answer. The collection is the one consumer again — which does not
argue for folding the shell back into it, for the same reason it was extracted:
the next surface that needs a switch must not write the geometry a third time.

Two variants, and they are the two axes a switch actually differs on here:

| Opt | For |
|---|---|
| `paper` | a photo-paper surface (§4.2a). Re-points the three colours the control is made of at `--polaroid-*`; ground tokens would render a dark box on cream. |
| `compact` | a dense strip whose own type is smaller than a 44px control. Shrinks the track and buys the tap target back with an inset `::before`, the same move `.scoring-tplpill` makes. |

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

**Its last step counts plays it did not import.** The sync stopped writing plays
when the play importer grew a BoardGameGeek source; it reads `/plays` only to say
how many are missing, and the done screen's *Import N plays* button hands that
number to the wizard. So step 5 narrates a **finding** rather than an outcome,
and it has three faces — a count, "already up to date", and a read that failed.
The third is the one worth keeping: `plays_new = 0` because BoardGameGeek would
not answer looks exactly like `plays_new = 0` because there is nothing new, and
telling somebody with four hundred plays waiting that they are up to date is the
worse of the two lies. It renders through `bggLogStep`'s `error` state rather
than `done`, which is the state that exists precisely so a step that finished
and achieved nothing does not draw a checkmark.

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

The BGG card grew a second direction, and with it three components; the sync flow added a fourth. `ui/bgg-log-step.js` is the step row promoted out of the import log the moment a second log needed it (`.claude/rules/ui-object-design.md` §4, extract at instance #2) — the three logs narrate different sequences but a step is a step.

`ui/bgg-push-log.js` is deliberately **not** a variant of `renderBggImportLog`. That one walks five import-specific counters (`collection_imported`, `plays_new`, `unique_games_to_import`) with no push analogue; parameterising it would be the options-matrix anti-pattern §2 warns about. Two components, one shared step primitive, one CSS family.

`ui/bgg-check-log.js` is the third on the same argument. Both existing logs narrate a QUEUE draining — n of m games, by name — where this narrates a fixed sequence of PHASES with no per-item counters at all. It reads `GET /bgg/check/progress`, which is a ledger the handler writes to an in-process cache as it sweeps: real per-phase progress, including the warm-up backoff, rather than a client-side timer pretending to know. `state: "unknown"` there means the record is gone (a restart, or a second worker) while the request is still alive — it renders as *still working*, never as done, because completion comes from the POST's own resolution.

`ui/bgg-diff-list.js` is the opposite call — one renderer with two variants, because there are two surfaces from day one: `card` is the comparison screen's table, `sheet` is the per-direction confirm screen's. It also takes a `direction`, since the push and pull sheets are the same comparison read opposite ways.

**It renders a three-column table — game, what BgB has, what BGG has — not a list grouped under a verb.** The grouped form said "18 to add" without naming the side being written, which left the one question the card exists to answer ("do I push these up or pull them down?") unanswerable from the card. A column of `Owned` opposite a column of `—` answers it by construction, and a legend below states each row kind as a direction rather than a verb. The two lists the API returns are merged by `bgg_id` into one row per game; `push_changes` is the complete set today, but `pull_changes` is merged in rather than assumed redundant.

Three details that are load-bearing rather than cosmetic. Both columns print **one** vocabulary (Owned / Prev. owned / Wishlist), not BgB's labels opposite BGG's raw flag names — two spellings of the same state read as a disagreement, which is the confusion the table exists to kill; the push footnote still names the real flags, which is where that detail matters. The pull sheet's `held` rows — games kept at Prev. owned that `_hold_prev_owned` refuses to resurrect — are a *reassurance*, not a change: they are excluded from the count and the commit label and carry a neutral `kept` tag, because a destructive treatment would read as though the sheet were about to delete the thing it is promising to keep. And the sync buttons spell their direction with the two brand marks, so each carries a real `aria-label` and a verb caption under the marks: two SVGs and an arrow tell a screen reader nothing, and told the user very little either.

### 4.3c The first-run deck, and the badge picker

First-run setup used to be three modals opened back to back, each awaiting its
own write before the next appeared. It is now **one mounted deck** —
`widgets/onboarding-deck.js` (the shell, the queue and the ledger) plus
`widgets/onboarding-deck-slides.js` (four of the five panels) — and the split
between those two files is the same lifecycle-vs-appearance seam the
bottom-sheet shell uses: the shell owns the track, the counter and the write
queue and knows nothing about what a slide contains; a slide says
`deck.next()` and stops caring. The buddies slide is a third file,
`widgets/onboarding-buddies-slide.js`, because it is the one panel with real
state — a query, a debounce, a sequence guard, two lists and a promotion rule
— and CLAUDE.md's ~300-line split falls naturally between that and four panels
of markup.

**Slide 2 is the same screen as `widgets/add-buddies-modal.js`, deliberately.**
Both put one question to the user, both render the canonical select-mode tile
from `ui/buddy-suggestion-rail.js`, both reach past the ranked suggestions
through `GET /profiles/search` with the same 300ms debounce and the same
capture-after-the-timer sequence guard, and both promote the second hop through
`domain/buddy-network.js`. What they do **not** share is the shell: a modal and
a deck slide have different lifecycles, which is the split §4 of
`ui-object-design.md` asks for. Two behaviours are worth naming because they
are easy to lose. A tick made inside a search result is held in a `picked` map
and **pinned above the suggestions** when the query clears, or the footer would
count somebody the grid no longer shows. And a promotion that lands while a
query is up is **deferred, not skipped** — the rows go into `list` and the next
full paint renders them, because a suggestion tile does not belong in a list of
search hits.

The five counted steps are **name and badge → buddies → collection import →
notifications → all set**. The last carries both the ledger and the hand-off
into the feature tour: "You're all set", and a choice between the walkthrough
(`/tour`, §4.3e) and diving straight in. It used to be uncounted, on the
grounds that it asks for nothing — but it does ask now, and a deck that
announces four steps and then shows a fifth screen has under-counted itself at
exactly the moment the person is deciding whether they are done. So `STEPS`
is the panel count rather than the panel count minus one, and the only thing
that still marks the finale out is that Back is hidden on it: every write
behind it has already fired, and walking back into a step whose job is queued
would offer to do it twice. The tour is a *routed
screen*, so "Show me around" is `deck.finish({ tour: true })` — the deck tears
itself down, releases the scroll lock, and only then calls `router.go("tour")`,
because a routed screen painted under a deck that still owns the scroll lock is
the same bug as an overlay arming a guard over a screen that has one.

Four properties are load-bearing, and each is a rule this codebase already had:

- **No handler awaits.** Continue and Skip queue a write through `deck.queue()`
  and move the track in the same frame. An `await` in a button handler here is
  the bug; the ledger on the finale is where an outcome belongs.
- **A promotion appends.** Ticking a suggestion inserts the people they know
  below the grid rather than re-rendering it, so the tile under the thumb
  survives (`.claude/rules/overlays.md` §6). Untick takes nothing back for the
  same reason, and `BuddyNetworkIndex` records what it has issued so a second
  tick of somebody who knows the same people offers them once.
- **The deck is chrome, the picker is paper.** `.ob-deck` joins the re-point
  lists in `styles.css`, so its tiles and fields follow the ground in both
  themes; `.ob-paper` restores the alias family for the badge carousel at
  (0,4,0), for the reason §4.2b spells out.
- **The notifications slide asks last, and before the browser does.** It sits
  at position four so the offer lands on things the person just did — buddy
  requests sent, a collection import in flight — rather than as an abstract
  question. Notifications stay off by default (`push_tier: 'none'`,
  migration 017) — this slide and
  `ui/push-prompt.js` are how an opt-in nobody would otherwise find becomes a
  choice somebody actually makes. It asks in the app's own words first because a
  browser answers the real question exactly once: a "block" can never be re-asked
  from script, so only a yes here reaches `Notification.requestPermission()`.
  "Not now" changes nothing on the account and writes the decline receipt
  `ui/push-prompt.js` reads (`bgb.push.askDeclines`), which is shared so the two
  surfaces spend one budget of at most two asks between them rather than one
  each. This is also the one handler in the file with a second reason not to
  await: the permission prompt needs the tap's own transient activation, which
  an `await` spends.

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

**`domain/name-match.js` (`BgbNameMatch`)** is the same shape again, for "is
this the same person?". A pasted note writes people as they are said out loud —
"Jas", "dave r", "@marcus" — and the play importer has to answer that against a
buddy list twice: once to pre-fill each parsed name (`PlayImport.suggestPlayers`,
above `MIN_AUTO`) and once to rank the picker sheet it opens
(`domain/import-people.js#closestTo`, above `MIN_SUGGEST`). The score is a ladder of
named cases, not an edit distance: "Jas"/"Jasmine" is a confident match at three
characters while "Sean"/"Shea" is four characters apart the other way and is not
a match at all, and only a PREFIX rung can tell those apart. Both the display
name and the username are matched, display name first — a tie goes to the name
people actually see.

That picker is now the app's single answer to "which person is this?", shared
by the importer's Players step and the Buddies screen's ghost-link control —
same sheet, same ranking, same candidates (the viewer's buddies, everyone they
have shared a table with, and their own ghosts). The Buddies screen passes
`allowGuest: false`, because a typed name matching nobody is an answer the
importer can take (keep them as a ghost) and the link flow cannot.

The importer's picker also reaches past the buddy list: the local rows filter
in memory off `Buddy.allBuddies()`'s day-long cache and so feel instant, and
`PlayerPickerSheet`'s `searchAll` opt puts everyone else on BoardgameBuddy
behind an explicit button (`/profiles/search`) rather than a debounce that would
spend that instantness on every keystroke. `Buddy.toPlayerCandidates()` is the
one mapping from the `/play-partners` bundle to picker rows — `accounts` there
are buddy EDGES (`other_user_id`, `other_display_name`), and reading them as
profiles is what made that sheet show nothing but ghost players.

The note itself need not be typed: the source step takes photographs of the
page, up to four, inline as base64 on the parse request. They are read once and
dropped — never stored, and never written to the saved draft, which is the one
piece of the wizard's state too large for the localStorage quota. A photographed
note goes to `GEMINI_MODEL_STRONG` rather than Flash-Lite, because it is OCR and
arithmetic rather than restructuring, and a miscounted tally is invisible to the
reviewer unless the model says which row it was unsure of.

Those answers then decide the review list. `PlayImport#rowKeyFor` keys a review
row on what a play RESOLVED to — the catalog game, the day, the note, and the
seats by account id — never on how the note wrote them, so two spellings of one
buddy read as the one player the user said they were. `groupKeyFor` returns the
same key (minus the plays with a score or a note of their own, which the feed's
collapsed card could not speak for), so the row a user reviews and the card that
lands in the feed cannot disagree.

### 4.3e The feature tour, and the vignettes

`/tour` is the app's marketing surface: five chapters — community, guides,
scoring, stats, discover — and an uncounted closer, on one horizontal track.
`views/tour-view.js` is the deck, `widgets/tour-chapters.js` is every word of
it, and each chapter hosts an animated *vignette*. It exists because the
sign-in screen was the only thing a stranger could see and it sold nothing but
a logo and a seven-word tagline.

Four decisions carry it.

**It is a route, not an overlay, and that is why it arms nothing.** It looks
like `widgets/onboarding-deck.js` and is deliberately not one: the onboarding
deck is a *mode* thrown over the app's own first screen, this is a
*destination* reachable from two places with a shareable URL. A routed screen
already owns a history entry, so arming `BgbBackGuard` over it is the
double-entry bug the chapter wizard shipped (`.claude/rules/overlays.md` §8b);
`tools/check-tour.mjs` asserts the tour arms nothing. The chapter rides as
`?c=<slug>` and each move **replaces** the entry rather than pushing one —
`/tour?c=scoring` deep-links, and leaving is one back press rather than six.

**The two decks share no module, on purpose.** What `ui-object-design.md` §4
says to extract at instance #2 is the *lifecycle* — scroll lock, back guard,
close animation, orphan teardown — and these two have different lifecycles by
construction, one being a body-level overlay and the other a screen the router
mounts. What they have in common is about fifteen lines of track geometry.
Pulling that out alone would mean rewiring first-run setup to share a
transform, so both files carry a pointer at the other instead.

**A beat is a state, not a keyframe.** `ui/tour-vignette.js` is the shell; a
scene declares an ordered list of beats, each of which puts the scene into a
named state and is safe to apply twice. Reaching beat N is always *reset, then
apply 0..N* — never *wait for N transitions*. Three things fall out of that one
decision, and none of them needed code of their own: `prefers-reduced-motion`
is a seek to the last beat and no clock; looping cannot drift, because every
cycle starts from `reset()`; and `seek("template-on")` lands on exactly one
frame, deterministically, which is what lets `Docs/STORE_LISTING.md` cite a
*beat* per screenshot instead of a timestamp. Transitions are suppressed around
a seek by a class on the root, added and removed either side of a forced
reflow, so the destination paints rather than animating towards it.

Two mistakes are already paid for here and are worth not repeating. The shell
hands `reset()` and `apply()` the **screen wrapper** (`.vig__screen`), whose
children are the scene's title bar and its body; every state selector in
`styles.css` is written against the body (`.vscore[data-stage="pad"]`,
`.vguide.is-open`), so a class put on what `apply()` was handed matches
nothing — the title bar updates and the stage under it stays blank. And the
`View` lifecycle **paints twice** on a cold mount (`renderLoading()` then
`render()`), so the second paint detaches whatever the lazily-loaded scenes
were just mounted into; `render()` therefore destroys every scene before it
repaints, exactly as the sign-in screen's hero does.

**The stats scene assembles a board, one card at a time.** Four quadrants —
the podium and win rate, one game's numbers, a head-to-head, and an
achievement. Each arrives centre-stage at 1.75x and holds while it is the only
thing to read, then settles into its corner as the next one arrives; the last
beat leaves all four up. Three of those arrivals are the chapter's three
bullets, in the order the bullets make them.

**A card never leaves its grid cell.** Centre-stage is a *transform* — half a
cell towards the middle, then a scale — not a change of `position`. Absolute
while centred and back to the grid to dock cannot animate, because `position`
is not an animatable property, and under the beat model that jump would happen
on every loop rather than once. The four hero rules differ only in the sign of
the translate, and the sign is the corner. The achievement's pop is on the
**badge**, not the card: a keyframe animation on the card's own `transform`
would overwrite the hero translate and drop it back into its corner mid-flight
— the two cannot share the property.

`widgets/tour-vignette-guides.js` is its own module for the same reason, and
took `tour-vignette-scripted.js` with it: that file held guides and scoring,
and the pair crossed the ~300-line guideline when guides grew. What was left
is the scoring scene, so the file is `tour-vignette-scoring.js` now — a module
called "scripted" holding one of the two scripted scenes is the kind of name
that outlives what it described (`ui-object-design.md` §5).

The stats scene lives in `widgets/tour-vignette-stats.js`, its own module, for
the same reason — it outgrew a loop: `tour-vignette-ambient.js` was at the ~300-line guideline
with it inside. It duplicates two four-line DOM helpers rather than sharing
them, and that is the intended answer, not laziness — `ui-object-design.md` §4
puts the *lifecycle* in the shell and leaves each caller its own markup, so
sugar for setting text on a scene's own nodes is the caller's side of the line.
The badge is the achievements screen's own sprite for a real seeded
achievement (`wins_10`, "Crowned"), and it keeps its dark medallion ground in
both themes by design — a coin on the table, not a mark drawn against the
surface.

**The scenes are not on the boot path.** All five vignette modules are
`<link rel="prefetch" as="script">` in `index.html` rather than `<script src>`,
and load through `ui/lazy-script.js` when somebody opens the tour. That keeps
them out of `scripts/bgb-bundle.mjs`'s manifest (which reads `<script src>`)
while keeping them inside `sw.js`'s precache sweep (which reads `src=`/`href=`),
so the tour works offline and no signed-out visitor pays for it. The same
reasoning governs the sign-in screen's hero vignette, which mounts *after*
first paint and degrades to nothing on a dead connection or under reduced
motion.

**And a stable url is one `sw.js` cannot refresh — which froze this scene for
three releases.** The worker serves same-origin subresources `cacheFirst`, and
it used to do so with revalidation *off*, on the argument that the cache is
keyed by build id so a hit is by construction this build's file. That holds
only while the **active worker** is this build's worker. A new worker replaces
the cache when it installs and activates, and an iOS standalone PWA can keep
an old one indefinitely.

Meanwhile **navigations are network-first**, so the shell is always current
and with it the content-hashed bundle, whose url changes every deploy. The
result is the worst shape a caching bug can take: an app that looks updated,
serving lazily-loaded modules frozen at some older build. A device showed the
pre-#751 feed scene beside that same release's chapter copy, and the only
symptom was a screen that resembled an older version of itself —
indistinguishable from work that was never done.

Two mechanisms fix it, and the first is the one that does not depend on the
worker updating:

- **The deploy stamps `?v=<sha>`** on every stable url the page fetches by
  name — the seven `rel=prefetch` modules and `assets/bgb-tw.css`, which is
  regenerated each deploy at a stable name under a rule that pins `/assets/*`
  immutable for a year. A stamped url is one no cache has ever held, so the
  fresh shell's reference reaches the network whatever state the worker is in.
  `ui/lazy-script.js` resolves a bare path through those links, so the stamp
  arrives without any call site knowing it exists, and local dev keeps the
  bare path.
- **The worker revalidates anything whose url does not identify its own
  bytes** — no content hash, no `?v=`. Stale-while-revalidate, so nothing
  blocks and an already-frozen entry heals on the next open.

`tools/check-lazy-assets.mjs` pins the join: that the stamp step runs after
the bundler and fails loudly on a drifted shell, that every lazily-loaded
module has a prefetch link to carry the stamp (including the three
`tour-view.js` holds in an array rather than passing as literals), that
`extractHtmlRefs` and `sameOriginPath` keep the query, and that the loader
resolves through the links without prefix-matching a longer path.

The tour is **chrome** and joins the re-point lists in `styles.css` — with one
paper island covering the two things inside it that are photographs: the
Arboretum scorepad in the scoring scene, and the play cards in the feed scene.
Both point `--polaroid-*` back at `--paper*`, class doubled to out-specify the
`(0,3,0)` dark chrome branch, for the reason §4.2b spells out. The island also
restores `--polaroid-accent` (the dark branch lightens it for a dark *ground*,
and on cream that is 2.6:1) and `--card-border` (dark declares it
`transparent`, which is right for a card on the app's own ground and leaves a
cream card on that ground with no edge at all).

**The feed scene scrolls through four game nights, and two of them are not
yours** — because one night on a rail demonstrates a rail, and a feed of
nothing but your own table is a log. Today is a multi-game night whose rail
slides sideways; Yesterday and Fri 12 are nights the viewer was not at; Sat 13
is a single-game night, which takes the *game name* in its header rather than
"1 game", centres its lone card the way `.play-session--single` does, and
carries **no** Good game footer because the real one is omitted when every play
in the night is the viewer's own. Sections are a uniform height so one vertical
step is one section — the scene sets an index and the stylesheet owns the
pixels, which is the same contract the horizontal rail has.

Two things follow from the friends-only nights rather than being decided
separately. **No card on them carries a crown**, because the crown marks plays
the *viewer* won and there are none — a mark that would have appeared anyway
says nothing. And the Good game footer arrives **already populated**: somebody
else has said good game before you get there, so the `kudos` beat is you
*pressing the button* rather than the footer appearing from nowhere. The line
goes from `Marcus said good game` to `You and 1 other said good game`, which is
the shape `_reactionSentence` actually produces — the viewer always leads and
the others are counted, never named. One deliberate divergence: the real pill
drops the words for a bare count the moment anyone reacts, and the mock keeps
them, because a handshake and the numeral "1" tells a stranger nothing.

**The face stack is the app's own avatar, and was not.** `ui/user-badge.js`
paints every default badge as an opaque `#2a1812` disc with `#C9922A`
initials, in both themes, plus a hairline and a top highlight — an avatar is an
identity mark, not a surface. The scene had invented `--accent-quiet` +
`--accent-ink` instead, which was wrong twice: a different object from the one
the feed shows, and **translucent**, so an overlapped stack showed the disc
behind straight through the disc in front, initials and all. The highlight is
what separates two adjacent discs at this size — the ring behind them is close
in value to both — so a rule that restates the ring has to restate the
highlight with it.

**The two tracks must not share a custom property.** They did, and because
custom properties inherit, the vertical index set on the outer track reached
every inner rail: scrolling to the third night shoved that night's cards
sideways out of their clip, leaving a header, a Good game pill and no games.
Vertical is `--vig-vstep`, horizontal is `--vig-step`. Relatedly, the clip
carries no vertical padding: `overflow: hidden` clips at the padding box, so a
top pad is a strip the outgoing section keeps showing through mid-scroll.

**The feed scene is a miniature of `ui/play-card.js`, not an impression of
one.** Paper body, a photo frame whose empty state is the same flat
`--polaroid-line` rectangle the real card's is, the game name in the display
face, and the winner under a hairline — laid out the way `views/feed-view.js`
lays a night out: day divider, session header, a sideways rail of cards, and
one *Good game* pill for the whole night, outside the cards because it reacts
to the night rather than to any one play. The ground/paper contrast is what
makes the frame read as the feed at all, so it is the part to preserve.

Two of its numbers are load-bearing rather than taste. The rail carries **six**
cards and its clip is **capped at 330px**: the slide beats only read as a
slide while the rail is wider than what shows of it, and the tour panel is
448px on a tablet against 342 on a phone — enough spread to turn two honest
steps into one step and a gap. And every child of `.vfeed` is `flex: none`,
because the clip was otherwise the one that gave on a short frame, and it gave
by cutting each card off below its game name — taking the winner line, which
is the thing the cards are there for. `.tour__stage`'s floor is set by this
scene for the same reason.

**A chapter may carry no `body`.** The community, scoring and stats chapters
have none: the scene under each makes the same point the paragraph used to.
`views/tour-view.js` guards the field, and `check-tour.mjs` pins both the guard
and the fact that a chapter actually exercises it — an unguarded `${ch.body}`
prints the string "undefined" into the panel, which nothing reports.

**The guides scene is a pool over a guide that fills up.** Four community
rows, each carrying a **visible empty tick** — the control used to appear only
once it had been used, so the first beat read as a row lighting up rather than
as a choice — and the scoring-grid row already ticked, which is why the scroll
underneath starts with it. Two of the other three tick during the scene and
land in the scroll as collapsed chapters; **one never ticks**, so both states
of the control are on screen at the end. The last beats open a chapter and
scroll its body.

Three things it borrows from `widgets/reference-guide-scroll.js`. A **scoring
grid is a chapter of a different kind and is drawn last** — that file's header
explains why (by `display_order` it came first, and a table above the rule
somebody opened the scroll for is the wrong thing at the top), so chapters land
*above* it here. Chapters are **collapsed** by default, because a guide is a
short list you open rather than a wall of text. And the scroll is **paper**:
the real one is parchment, light in both themes, and on the chrome ground the
two lists of rows read as one column with nothing to say that two of them
moved. It is the third paper island in the tour, alongside the scorepad and
the feed's play cards.

The list carries **its own clip**, inside the padded box rather than around
it. It translates by a row when a chapter opens, which is what a real guide
does and what keeps the scoring grid — deliberately last — from being pushed
out by the expanding body above it. Clipping the whole box instead slid the
rows up *over* the "Your guide" heading, because the heading is a sibling that
does not move.

**The scoring scene is three stages**, in the order the chapter's three
bullets claim them: Gather, the live rounds, then a community grid.

**A chapter's bullets are on screen the whole time, and that was tried the
other way.** For one release the scoring and stats points each named a beat
and the deck held them back until the scene reached it — a claim arriving as
its evidence did. It reads worse than it sounds. A reader landing on the panel
sees one line where there are three, the block under the scene grows while
they are reading it, and anyone who glances away has no way to know whether
they have seen everything. So the bullets paint with the panel, on the
`fadeUp` + `--i` stagger every list in the app uses, and `opts.onBeat` came
back off `ui/tour-vignette.js` with them — it had exactly one consumer. Don't
reintroduce it without a reason that survives being watched.

One thing about what that scene shows: **a template relabels rows, it does not
add a second kind of row**: `rowLabels` are index-aligned to the round index, so
applying one renames the R1/R2 the players already filled in and may make the
table longer. The scores stay exactly where they are — which is what the
confirm sheet promises in so many words, and why the scene can keep its
numbers across the template beat. The row tints are the live scorepad's own
two rules, down to the 14% mix and the 3px inset: the left edge says what the
row **is**, the right says which box it **came from**, and the expansion chip
carries that same right-edge colour from the moment it is picked, so by the
time a row turns up with one the reader has been told what it means.

**The ghost-player line is constrained by what the flow actually does.** A
ghost is a `play_players` row with a null user id and a typed name, owned by
whoever logged the play. The person it names can **claim** it once they sign
up, and the owner approves — `widgets/ghost-claim-sheet.js` says "Nothing
changes until they say yes." So the chapter says *can claim*, never *are
linked*, and never "merge accounts", which is not vocabulary this app uses.
"Ghost" itself is safe: the Buddies claim list and every import step already
say it out loud.

One mark in the tour has no equivalent in the app: the **crown** on a feed
card. It is there because at 96px wide the caption's winner line is 8.5px of
muted rust, which reads as texture rather than as a fact, and it marks the
plays the *viewer* won rather than "this play has a winner" — which is true of
every card and would make the mark say nothing. The shipped card is unchanged.

**The scripted scenes are paced, and the pacing is the content.** Roughly two
seconds a beat, and the longest dwell of all sits on the *generic* scorepad
before the template rewrites it: you have to register that the grid is generic
before it changes, or the change is just a grid appearing. At one beat a second
the whole sequence read as a flicker. A long cycle costs nothing, because the
shell pauses a scene the moment its panel scrolls off and every panel restarts
from beat zero when it comes back — nobody lands mid-story.

Content lives in exactly one file. `widgets/tour-chapters.js` carries the
chapters, their marks and the one-line claims the sign-in strip shows, so the
tour, the strip and `Docs/STORE_LISTING.md` cannot drift into advertising three
different products.

### 4.4 Chrome, layering and mobile

The pinned chrome is a system, documented in `.claude/rules/web-frontend.md` (§ App chrome & layering) and `.claude/rules/mobile-web.md`. The parts specific to this app:

- **z-index ladder:** view content < 15 the scoring grid's pinned column headers (`.rg__head`) < 20 pinned spoke back-row and the cascade step header < 30 global header < 35 docked footers (`.cascade-cta-wrap`, `.bgb-install`) < 36 `.cascade-error` < 40 `.bgb-nav` < 45 toasts < 100 `.polaroid-popup__backdrop` (every modal and sheet).
- **Heights are tokens:** `--bgb-nav-height: 64px`, `--bgb-header-height: 53px`, `--bgb-spoke-head-height: 59px`, `--bgb-cascade-head-height: 55px`, with `:root { scroll-padding-top: calc(var(--bgb-header-height) + 8px) }` derived off the second so `scrollIntoView({block:"start"})` clears the sticky header. The first two are re-declared to `0px` on the wide layout tier (§4.6), where there is no bottom bar and no header — every offset derived from them collapses without those rules changing.
- **Widths are tokens too:** `--bgb-col-max` is the content column (`#app`'s `max-width`, 480 / 720 / 1040px by tier), `--bgb-rail-width` the wide tier's nav rail (0 elsewhere), and `--bgb-col-center` the column's centre line. Docked chrome pins to the column with `left: var(--bgb-col-center); transform: translateX(-50%); width: calc(100% - var(--bgb-rail-width)); max-width: var(--bgb-col-max)` — never a literal width. A `<main>` that wants a narrower column on a monitor re-declares `--bgb-col-max` on itself, and the fixed bars inside it inherit the narrower value.
- **The global header is sticky at `top: 0`; each spoke's back row is sticky at `top: var(--bgb-header-height)`**, sharing the header's treatment so the two read as one stack. Scoped to direct children of `<main data-view>` — the same class nested in a card must not pin.
- **The cascade's step header pins the same way** (`.cascade-screen > .cascade-screen__header`, `top: var(--bgb-header-height)`, z 20), so the back chevron and the End-session × stay one tap away however far down a long scoring grid you are. Direct children only, for the same reason. Only one `.cascade-screen` is ever unlocked, so these never stack.
- **The scoring grid's column headers pin under both** at `calc(var(--bgb-header-height) + var(--bgb-cascade-head-height))`. That grid has no inner scroller at all — it is three column-aligned regions (`.rg__head` / `.rg__body` / `.rg__foot`) so the header can pin against the page while the body keeps a horizontal scroller, and so the header's containing block ends where the Total row begins and can never cover it. The full argument is the block comment above `.rg` in `styles.css`; the design board is `Docs/mocks/sticky-scoring-header-mock.html`.
- **Settings closes, spokes go back.** Settings is reachable from the gear in the global header, i.e. from any screen, so it dismisses with a trailing-edge × calling `router.back('profile-self')`; the fallback only covers a cold `/settings` deep link. The five spokes are reachable only from the hub, so they carry a leading-edge ← .
- **`body { overflow-x: clip }`, never `hidden`** — see the comment in `styles.css`; `hidden` made `<body>` a scroll container with no height and every `position: sticky` in the app rode off-screen.
- **`ui/viewport-lock.js`** publishes `--bgb-vv-h` / `--bgb-vv-top` / `--bgb-kb-inset` and the `.bgb-kb-open` root class from `visualViewport`; **`ui/zoom-lock.js`** holds the page at 1x in an iOS Safari tab. Deliberately two modules: one measures, one prevents.
- **The 16px input floor must stay the last block in `styles.css`** — its selectors tie on specificity with the component rules they override, so the win comes purely from source order.

### 4.5 Motion

Two motion patterns are codified in `.claude/rules/web-frontend.md` ("Motion" section) and applied via the `.animate-fadeUp` class with `animation-delay: calc(var(--i) * 40ms)` for staggered entrance. `--ease` is the project's shared curve. The play card no longer flips — a tap opens `PlayDetailPopup`; sheets animate in and out on `sheetIn` / `sheetOut`, whose duration must stay in step with `CLOSE_MS` in `ui/bottom-sheet.js`. Press feedback is `:active` — the polaroid tilt animation was removed.

### 4.6 Layout tiers

The app is drawn for a phone and has to hold on an iPad, a monitor, and a phone turned on its side, without a second codebase. Four tiers, one attribute, the same lever shape as the theme:

| Tier | Viewport | Column | Nav | Header |
|---|---|---|---|---|
| `phone` | < 768px | 480px | bottom bar | sticky at top |
| `tablet` | 768–1023px | 720px | bottom bar | sticky at top |
| `wide` | ≥ 1024px | 1040px | 88px left rail, on the window's left edge | hidden — the rail carries its lockup, bell and gear |
| `land` | landscape, ≤ 560px tall, ≥ 640px wide | fills the space beside the rail | 64px left rail, compact | hidden — same as `wide` |

`land` is the one tier that is not a width, and it is asked first because a phone held sideways (852×393) satisfies the `tablet` width test too. Width cannot tell an iPad standing up (768×1024) from a phone lying down; height can. Without it a landscape phone spends 117px of a 393px screen — a sticky header and a bottom bar, a third of the short axis — on chrome it has a better place for. The query reads the **layout** viewport, which iOS does not shrink for the software keyboard, so focusing a field cannot flip the tier.

- **The lever is `<html data-bgb-layout="…">`.** An inline boot in `index.html` sets it before first paint from the viewport; `domain/layout.js` (`window.BgbLayout`) owns it after that — three `MediaQueryList`s held at module scope — the two width breakpoints and `LAND_QUERY`, a resync on `orientationchange` and every foreground event, and `store.set("layout", tier)` on each change so a view can `this.listen("layout", …)`. Per-tier CSS goes through two named, greppable selector groups documented at the top of `styles.css` — **split tiers** (`tablet`, `wide`, `land`: enough room for two panes) and **rail tiers** (`wide`, `land`: the bar is a left rail and the header is folded into it, so both height tokens are 0px). There are no `min-width` media queries, so every tier goes through the same rules.
- **The tier is the viewport's, and nothing overrides it.** There was a Settings → Layout control (Auto / Phone / Tablet) that stored `bgb.layout` and let it outrank the viewport, plus a 600px floor under a pinned `tablet` so a two-pane play cascade never landed on a real phone. The card is gone and so is every reader of that key — `resolved()`, `stored()`, `isAuto()`, `set()` and `clear()` with it, in both `domain/layout.js` and the inline boot. If a pin is ever wanted back, it comes back **with** its control: a stored override and no UI to clear it strands whoever set it. `wide` and `land` were never pinnable anyway — a rail is not something a 700px screen can hold.
- **The rail is the same `nav.bgb-nav`,** restyled under the rail tiers: fixed at the window's left edge (`left: 0`), `body` padded by `--bgb-rail-width` so `#app` centres in what is left. It used to slide inward to hug the content column on a monitor wider than rail + column, which floated it in open ground with nothing to its left; every other rail-aware rule (`--bgb-col-center`, both `.bgb-fab` offsets, the locked chapter editor) already derived the column's edges as rail + the centring gap, which is only true of a flush-left rail. Its brand link and its two utility buttons (`.bgb-nav__tab--util`, `data-toggle="notifications|settings"`) are `display: none` on the bar tiers. The header's bell and gear carry the same `data-toggle` names, and `view.js#go` and `init.js#syncHeaderDots` select by that attribute across every copy — so whichever copy is on screen lights and wears the dot.
- **What each screen does with the width** — the cascade's `.cascade-cols > .cascade-col + .cascade-col--aside` wrappers (`display: contents` on a phone, a two-pane grid with a sticky aside from tablet up, and the docked CTA bar taking the same column template); the feed's JS partition of the rail cards into `<aside class="feed-aside">`; the Play tab's Host | Join grid; 4- then 6-column polaroid grids with the collection batch and explorer page sized in rows × columns; game detail's sticky cover column; the profile hubs' and Stats' paired cards (on the hub: the account card beside the stats block, Collection beside Achievements, Recent plays beside Buddies — the two cards that repaint in place carry a `.preview-card-host` wrapper, which has to be named in the pairing selector or those two take a full row each); wrapping achievement rails; and a 720px cap for reading screens on wide — is all in one block of `styles.css` ("Every other screen on the tablet and wide tiers") plus the cascade and feed blocks beside their families. `land` joins each of those splits and takes the six-column grid, but not the 720px reading cap or the feed's centred 560+300 pair: both hand width back to a monitor, and a phone on its side has none to give. Its `--bgb-col-max` is 1024px — a cap that can never bind, kept a real length because two rules feed it into a `calc()` that `none` would make invalid. The design boards are `Docs/mocks/tablet-layout-mock.html` and, for `land`, the live `Docs/mocks/landscape-phone-mock.html`.
- **Sheets and modals do not change.** `.bgb-sheet__panel` is already capped at 520px and centred; the polaroid popups are centred already. They hold at 393px tall because every one of them sizes off the `--bgb-vv-h` ladder (§1 of `.claude/rules/mobile-web.md`) rather than a fixed height — cramped on a landscape phone, but never overflowing.

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

### 5.1a The session boundary

Signing in and out is a **route change, not a reload** — every view and `ui/`
module is constructed once per tab. Three consequences are wired into the
router rather than left to each screen, and all three come from one reported
sequence: *login screen → Google account picker → login screen again → loader
→ feed with no bottom bar → back gesture → the login screen, with a working
nav bar on it.*

**The chrome follows the account, not the navigation.** The global header and
the bottom nav are `[data-auth-only]` in `index.html`, and
`Router._applyAuthChrome` is both called from `go()` and subscribed to the
`user` store key. It has to be both: `init.js` routes a valid session forward
even when `/bootstrap` has not answered yet (a signed-in user must never be
stranded on the splash) and recovers the profile in the background, so the
first screen of a session can paint before there is a user to read. Computed
only at navigation time, that screen got no nav — and the next navigation,
whatever it happened to be, was what turned it on.

**The sign-in screen hands over when the popup OPENS.** On Android the popup is
a whole tab, so the app is visible again the moment Google's closes — which is
before the credential arrives over `postMessage`. Handing over on the resolved
promise still left the login form on screen for that leg, which reads as a
failure and invites the one response that breaks a working sign-in: a second
popup makes Firebase reject the first with `auth/cancelled-popup-request`.
`views/auth-view.js#oauth` therefore routes to the splash as soon as the popup
is open, and `_backToForm` navigates back on a cancel or a failure. The
provider call itself stays in the tap's own task — a `window.open` one task
later is a blocked popup, i.e. every Google sign-in handed to the redirect
fallback. `BgbAuth.signInPending()` exists so the boot watchdog does not mistake
that splash for a stalled boot.

**Back cannot cross the boundary.** A route into the app from `/auth` spends
that history entry (`replaceState`, not `pushState`), so the login screen is
not sitting under the first screen of the session; walking off to `/privacy`
does not, because that document's × needs somewhere to return to. For entries
`pushState` cannot reach — an `/auth` pushed by a mid-session sign-out with the
previous account's screens still stacked below it — `Router._gateBack` refuses
the popped route and replaces it: the login screen is not a destination while
signed in, and an app screen is not one while signed out. It honours everything
mid-boot, where `user` is null only because the session is still restoring.

`tools/check-session-handoff.mjs` §7 drives the real router over a fake shell
and a walking history for all of it.

### 5.2 The three "tab" routes

The bottom nav has three slots — they are the user's home base. On the wide layout tier the same nav is a left rail (§4.6); the slots and their routes are unchanged.

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
way through all three write paths — solo log, hosted finalize, and offline
outbox flush.

Nothing reads it yet. It exists so that "what gets played in Germany" is
answerable later, and that answer can only be built from data collected
forwards: a play logged with no country can never be given one. `null` is a
first-class value throughout — an unresolvable device, a host who opted out,
and every play predating the column all land there, and any future aggregate
filters them out and reports its own coverage.

**The roster is the draft's, and the lobby never adds to it.** Two arrays
describe who is at the table: `_ps.players`, which is the play (it becomes
`toPlayCreate().players`, which `bgb_log_play` stores verbatim), and the lobby's
`participants`, which exists so joiners and spectators can see the table. The
Gather poll reads the second and may promote a genuinely new joiner into the
first — that is the one direction it flows, and it flowed too far. Removing a
seat is local and its `DELETE` is not, so for a round trip the lobby still lists
someone the draft does not, and *any* bundle fetched inside that window used to
seat them again: at the END of the roster, i.e. the rightmost off-screen column
of the grid, on a play the host then saved without ever seeing the extra seat.
(`biggest_table` counts seats, so a table of four unlocked *Full Table*.)

So a removal is recorded on the draft — `PlaySession.forgetSeat` /
`rememberSeat` / `isRemovedParticipant`, persisted with the roster — and the
poll refuses any participant matching a tombstone, on the branch that would
create a row and nowhere else (a participant that matches a seat is the ordinary
`participant_id` backfill and is untouched). The identity rule is same lobby row,
same account, or same name **ghost-to-ghost only**: an account sharing a removed
ghost's name is the swap a host makes on purpose. Everything else is cleanup
around that invariant — the poll re-reads its guards after its fetch, a push
whose seat left during the round trip deletes the row it created, and a stale row
the poll meets is reaped once per mount so the spectators' list converges too.
`tools/check-roster-removal.mjs` drives the real modules through all three
resurrection paths.

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

> The second corollary for *mutations*: **restructure only on an interaction that has already broken continuity** — a mount, a page turn, a search, a confirm dialog — and **patch in place on one that hasn't**, i.e. a single tap on a list control. `.claude/rules/web-frontend.md` exempts membership changes from the surgical-repaint rule, but that exemption is about a repaint's *scope* and says nothing about its *timing*. The Buddies screen repainted the whole container in the tap's own frame, which slid the suggestion rail sideways and sent the next tap — already on its way down — to the wrong person. The affordance corollary is the visible half: a control that has been acted on shows a **verb** for what happened (Sent, Accepted, Declined), never a state like "Buddies" that its own section heading contradicts, because the row has deliberately not moved yet. See the rule block above `_personFor` in `views/buddies-view.js`, and `ui/buddy-suggestion-rail.js`'s `state` opt, which is what keeps the Feed rail, the Buddies rail and the onboarding grid agreeing on what a Sent tile looks like. The one action that *does* take a tile out of the rail is the ×, "stop suggesting this person" — and that follows the rule rather than excepting it: removal is the whole request there rather than a side effect of a send, and `removeBuddySuggestionTile` collapses the tile over ~220ms instead of repainting in the tap's own frame, so nothing slides under a finger already on its way down.

> The corollary for *mutations*: there are two ways to shelve a game and they are deliberately different tasks, not two affordances for one. The **status sheet** behind a tile's corner chip is "where does this one game sit?" — a radio group over owned / wishlist / remove, reachable from any tile anywhere. The **Add Games** row button is "fill my shelf" — one tap, one shelf, stated by the page's own toggle, repeated down a list. Add Games therefore turns the tile's corner chip off (`showStatus: false`): two controls on one 44px row, one of them opening a sheet that says what the other already shows, is the version of this that would violate the rule.

### Rule 3 — Destructive actions are confirmed through `PolaroidPopup.confirm`

Per `.claude/rules/web-frontend.md`, all destructive actions go through the project's single confirm modal. No view rolls its own confirm dialog. This applies to: delete a play, remove a buddy, abandon a session, abandon a Gather draft, clear a collection, delete an account.

**One carve-out: a confirm whose subject is a LIST is a sheet.** Both BGG syncs are destructive — the push overwrites the user's BoardGameGeek collection, the import overwrites their BgB shelf — and the only honest confirmation names every row it will touch. `PolaroidPopup.confirm`'s `body` is a plain string that gets `escapeHtml`'d, so it cannot render a list at all, and a 500-row list in a centred card is the geometry `.claude/rules/overlays.md` §1 exists to prevent. That carve-out has since outgrown a sheet entirely: the confirm is now a full screen in `views/bgg-sync-view.js`, because the comparison became a three-column table and a bottom sheet could not hold it without scrolling sideways. The principle is unchanged and is why the screen exists — **the commit button is the second tap**, on a surface that names every row it will touch. Any future confirm that needs to enumerate rather than assert belongs on a screen too; anything that fits in a sentence stays a `PolaroidPopup.confirm`.

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
│   ├── layout.js           ← phone/tablet/wide tier controller (see §4.6)
│   ├── net.js, cache.js, outbox.js, bootstrap.js          ← Offline + caching
│   ├── game.js, play.js, buddy.js, user.js, collection.js, profile.js, stats.js, achievements.js, …
│   ├── geo.js + geo-data.js        ← device timezone → country, for a play logged live
│   ├── geo-grid.js + geo-grid-data.js ← coordinate → country, for a play read off a
│   │     photo. Generated by tools/build-geo-grid.py; the data half is lazy-loaded
│   │     (ui/lazy-script.js) on the same terms as the QR codecs
│   ├── exif.js             ← a photo's own date and coordinate, read on the device
│   ├── play-import.js      ← the import wizard's NOTES draft
│   ├── photo-import.js     ← the import wizard's PHOTOS draft
│   ├── bgg-play-import.js  ← the import wizard's BOARDGAMEGEEK draft. Keys games
│   │     by BGG id rather than by name, and sends bgg_play_id beside client_key
│   ├── import-draft.js     ← which source is live, + the ImportSource typedef
│   │     all three models answer — it is what lets one review render any of them
│   ├── import-people.js    ← who an importer can seat (shared by every branch)
│   ├── bgg-import.js       ← the BGG catalog-import queue: outlives the sheet that
│   │                          started a job, and keeps importing apart from shelving
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
│   ├── bgg-import-toast.js  → the "it landed" notification a finished catalog import
│   │     pops wherever the user is, carrying the add-to-a-shelf step with it
│   ├── icons.js             → BgbIcons — the vendored Phosphor set + render pass
│   ├── dom-patch.js         → BgbDomPatch.morph — repaint a subtree by writing only
│   │     the nodes that differ, instead of replacing its innerHTML (§4.3d)
│   ├── viewport-lock.js     → publishes the visible viewport as CSS properties
│   ├── zoom-lock.js         → holds the page at 1x on iOS Safari
│   ├── dropdown-fit.js      → the residual fit pass, for a finder mounted as a dropdown
│   ├── install-prompt.js    → the PWA install bar
│   ├── achievement-popup.js → queues the "Achievement unlocked!" polaroid
│   └── outbox-indicator.js  → the queued-writes badge in the header
│
├── widgets/                ← Composite stateful widgets (see §6)
│   ├── reference-guide-scroll.js   → ReferenceGuideScroll class (Chapter rendering)
│   ├── round-score-grid.js          → renderRoundGrid (Session scoring)
│   ├── game-info-bar.js             → renderGameInfoBar (Session header on Play)
│   ├── game-finder.js               → the game search: on-device catalog index first, /search fallback, BGG escalation
│   ├── player-reorder.js            → drag-to-reorder the Gather roster
│   ├── game-picker-sheet.js, game-search-sheet.js, player-picker-sheet.js  ← sheets (§4.3)
│   ├── bgg-import-sheet.js          → search BoardGameGeek, import into the catalog
│   │     Opened from views/add-games-view.js, which is the way in to a shelf.
│   │     Importing does NOT shelve: domain/bgg-import.js keeps the two steps
│   │     apart and outlives the sheet, and ui/bgg-import-toast.js announces the
│   │     finish wherever the user has got to.
│   ├── import-expansions-modal.js, outbox-modal.js      ← modals

│   ├── join-panel.js
│   ├── onboarding-deck.js    → first-run setup: the shell, the write queue, the ledger
│   ├── onboarding-deck-slides.js    → its six panels (§4.3c)
│   ├── add-buddies-modal.js  → the Buddies screen's Add button: search or pick, one
│   │     batched send. Was also first-run step 2 until the deck replaced it, and
│   │     still shares the deck's promote logic (domain/buddy-network.js)
│   │     (widgets/onboarding-bgg-modal.js was deleted here — the deck's slide 3
│   │      replaced its only caller, and Settings could already link and sync)
│   ├── import-notes-steps.js        → the notes branch's four step bodies
│   ├── import-photos-steps.js       → the photos branch's two step bodies
│   ├── import-bgg-steps.js          → the BGG branch's three step bodies. Its
│   │     first has four faces (reading, no link, nothing new, a count), which
│   │     are four screens rather than a flag over one
│   ├── import-notes-branch.js       → the notes branch's handlers + contract
│   ├── import-photos-branch.js      → the photos branch's handlers + contract
│   ├── import-bgg-branch.js         → the BGG branch's handlers + contract
│   ├── import-source-step.js        → the wizard's source picker. The BGG row is
│   │     four rows, keyed on auth_state, and never live before that is known
│   ├── import-review-step.js        → the review, summary and progress EVERY
│   │     source ends on — one implementation, three screens
│   ├── import-review-host.js        → that review's handler half
│   ├── play-detail-popup.js         → PlayDetailPopup namespace (full Play detail modal):
│   │     the modal, the fetch, and the read-only card
│   └── play-detail-edit.js          → the same popup's edit half — draft, form, write
│         handlers, save/delete. Loads first; the shell wires it and folds its
│         handler set into the one PlayDetailPopup namespace the markup names
│
├── views/                  ← One file per screen / route
│   ├── feed-view.js, log-play-view.js, play-flow-view.js, stats-view.js, …
│   ├── add-games-view.js   → the catalog scroll behind both spokes' "+ Add"
│   ├── import-wizard-view.js → Settings → Play importer. One shell over two
│   │     branches: a source picker, that source's own steps, then the shared
│   │     review and summary. Owns the lifecycle only — see its header.
│
└── assets/                 ← Brand, illustrations, credits, sprites (per .claude/rules/assets.md)
    └── sprites/achievements/  ← bgb-ach-<slug>.svg — one medallion per badge
```

`tools/` beside `web/` holds the one-off generators whose output is checked in —
today just `build-geo-grid.py`, which rebuilds `web/domain/geo-grid-data.js` from
public boundary data. Nothing there runs at request or deploy time.

`Docs/` next to this file holds the audit (`UI_AUDIT.md`), the standalone screen mocks (`mocks/`) and release notes.
