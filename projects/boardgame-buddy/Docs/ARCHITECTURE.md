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
| **Play** | `domain/play.js` | A single recorded session of a Game by one or more Users (and possibly ghost players). Owns players, scores, winner, notes, photo, duration. |
| **Buddy** | `domain/buddy.js` | A directed friendship between two Users. Carries request state (pending in/out, accepted) and recent-play history together. Ghost buddies are placeholders for non-account players. |
| **User** | `domain/user.js` | A profile (display name, avatar customization, BGG link). The viewer is the implicit `User.current()`. |
| **Session** | `domain/play-session.js` + `domain/session-phase.js` + `domain/live-scores.js` | The live state of a game-in-progress. Phases (`gather` → `play` → `settle`) drive the cascading host UX; Realtime keeps joiners in sync. When the host saves, the Session finalizes into a Play and is discarded. |
| **Chapter** | `domain/chapter.js` | A user-built reference excerpt for a Game (rule summary, setup notes, scoring quirks). Pooled across users; the player merges chapters from base + expansions into a "guide" for that game. |
| **Collection** | `domain/collection.js` | Per-user `(game, status)` mapping — owned / wishlist / played-not-owned. Drives the status badges everywhere a Game appears. |
| **Profile** | `domain/profile.js` | Public projection of a User: stats, recent plays, owned games, favourite game. |
| **Feed** | `domain/feed.js` | Composite chronological stream of plays + algorithmic rails (hot games, suggested buddies, time-to-revisit). Lives in its own object because the response is heterogeneous. |

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
| **Game** | _(no canonical tile)_ | n/a | ⚠️ Six bespoke tiles (`.collection-tile`, `.hot-game-tile`, `.preview-card__cover`, `.game-detail__polaroid`, `.plays-list__thumb`, `.game-polaroid`). `renderGamePolaroid` exists in `ui/game-card.js` but only the Gather grid uses it. |
| **Buddy** | _(no canonical row)_ | n/a | ⚠️ Buddy rows are rendered via `BgbBadge.render` for the avatar but the surrounding row markup is duplicated in `views/buddies-view.js`, `views/feed-view.js` (suggestions), and the profile preview. Less severe than Game because the avatar — the visual identity — is shared. |
| **Chapter** | (none yet) | `widgets/reference-guide-scroll.js` renders chapters into the parchment scroll | Chapters are not surfaced outside the scroll, so the rule does not need to be enforced. If a future change shows a single chapter in a tooltip / preview, that would be the moment to extract a `renderChapter` function. |
| **Session** | `widgets/round-score-grid.js` + the cascading `play-flow-view` screens | The scoring grid is shared between host (live edit) and joiner (read-only mirror). | ✅ Single source for the scoring view. The Gather/Settle screens are unique to the host. |

The rule manifests at three levels:

1. **JS:** A single `render*` function or class with a documented option set. Variants are parameters, not parallel implementations.
2. **CSS:** The component's class family (`.play-card*`, `.user-badge*`) lives in one section of `styles.css` and is not redefined elsewhere. Layout host classes (e.g. `.profile-hub__avatar` sizing a `.user-badge`) tune the component without re-styling it.
3. **Data:** The object's shape comes from one file in `domain/`. Views adapt by passing the existing shape through; if the API surface differs (e.g. `bundle.recent_plays` vs `feed.plays`), the view writes a small adapter (see `views/game-detail-view.js#_toFeedPlayCard`).

---

## 4. UI styles & design tokens

The visual language has four type roles and a small palette. They are all declared at the top of `styles.css` so any view that needs them can pull them in.

### 4.1 Type roles (declared in `styles.css:23–46`)

| Token | Family | Used for |
| --- | --- | --- |
| `--font-sans` | Poppins | Body text, button labels, list rows, profile body |
| `--font-display` | Crimson Text | Page titles, section headings, game / profile names, stat values |
| `--font-polaroid` | Fraunces | Polaroid-card captions (game tiles, play cards, guide body) |
| `--font-score` | JetBrains Mono | All numeric scores, cascade step counters |

The "polaroid family" is the project's signature: cream-paper background, soft drop shadow, tilt animation, Fraunces caption. It is the visual treatment for **Play** in the feed and for **Game** in the Gather grid.

### 4.2 Color tokens (declared in `styles.css:8–53`)

| Token | Default | Used for |
| --- | --- | --- |
| `--accent` | `#C9922A` (gold) | Primary brand color, "owned" status, live scoreboards |
| `--accent-hover` | `#B8820E` | Hover state of accent buttons |
| `--game-accent` | per-game `theme_color`, set inline | The hairline accent on a specific Game's tile / detail / play card |
| `--exp-color` | per-expansion, set inline | The colored dot identifying a chapter's source expansion |
| `--polaroid-bg`, `--polaroid-ink`, `--polaroid-line`, `--polaroid-accent`, `--polaroid-muted` | cream / dark-brown / etc. | The polaroid surface |
| `--warm-taupe`, `--warm-taupe-soft`, `--warm-taupe-strong` | sandy brown | Reference-guide hints, inactive toggles |
| `--rust`, `--rust-soft`, `--rust-strong` | rust red | Destructive accents (delete, abandon, remove buddy) |

`--game-accent` and `--exp-color` are the only tokens routinely set inline; they have to be because they are data-derived. Every other color comes from the stylesheet.

### 4.3 Motion

Two motion patterns are codified in `.claude/rules/web-frontend.md` ("Motion" section) and applied via the `.animate-fadeUp` class with `animation-delay: calc(var(--i) * 40ms)` for staggered entrance. The play card adds a flip animation managed inside `ui/play-card.js` (state Map keyed by `play_id`).

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
collection /     plays      session-viewer (joiner)
wishlist                    play-flow (host) ◀───────── Bottom-nav "Play"
(spokes from profile-self)


Bottom-nav "Profile"
        │
        ↓
┌─────────────────┐
│  profile-self   │ ◀── stats hub
└────────┬────────┘
         │
         ├── See all → collection
         ├── See all → wishlist
         ├── See all → plays
         ├── See all → buddies
         └── Settings icon → settings → admin (gated)
```

The two key observations:

1. **`game-detail`, `profile-self/other`, and `play-flow` are the "destination" screens.** Everything else either lists them or details them.
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

### Rule 3 — Destructive actions are confirmed through `PolaroidPopup.confirm`

Per `.claude/rules/web-frontend.md`, all destructive actions go through the project's single confirm modal. No view rolls its own confirm dialog. This applies to: delete a play, remove a buddy, abandon a session, abandon a Gather draft, clear a collection, delete an account.

> Today's state: respected. See UI_AUDIT.md §3.8.

---

## 8. File map

```
projects/boardgame-buddy/web/
├── index.html              ← single-page shell: header + bottom nav + 18 view containers
├── init.js                 ← view construction, router registration, Supabase boot
├── helpers.js              ← jsStr, buddyLoader, formatDate, toast
├── config.js               ← API base URL
├── styles.css              ← all CSS (~7,145 lines after 2026-05-23 cleanup)
│
├── domain/                 ← Domain objects (see §2)
│   ├── api.js              ← HTTP client + auth headers
│   ├── store.js            ← Cross-cutting state with subscribe()
│   ├── view.js             ← Base View class
│   ├── game.js, play.js, buddy.js, user.js, collection.js, …
│   └── play-session.js, session-phase.js, live-scores.js   ← Session state
│
├── ui/                     ← Canonical render functions per object (see §3)
│   ├── play-card.js         → renderPlayCard         (Play)
│   ├── user-badge.js        → BgbBadge.render        (User)
│   ├── game-card.js         → renderGamePolaroid     (Game — Gather grid only)
│   ├── status-tag.js        → renderStatusTag, renderExpansionBadge (Collection status)
│   ├── polaroid-popup.js    → show/dismiss/confirm/alert/avatarCustomizer
│   ├── markdown.js          → renderMarkdown
│   └── oauth-buttons.js     → oauthButtons
│
├── widgets/                ← Composite stateful widgets (see §6)
│   ├── reference-guide-scroll.js   → ReferenceGuideScroll class (Chapter rendering)
│   ├── round-score-grid.js          → renderRoundGrid (Session scoring)
│   └── play-detail-popup.js         → PlayDetailPopup namespace (full Play detail modal)
│
├── views/                  ← One file per screen / route (17 total)
│   ├── feed-view.js, log-play-view.js, play-flow-view.js, …
│
└── assets/                 ← Brand, illustrations, credits (per .claude/rules/assets.md)
```

`Docs/` next to this file holds the audit (`UI_AUDIT.md`) and release notes.
