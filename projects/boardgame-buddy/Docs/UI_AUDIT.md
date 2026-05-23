# BoardgameBuddy Web UI Audit

A consistency audit of `projects/boardgame-buddy/web/`. Every claim cites code as `path:line` so each finding can be jumped to and verified. The scope is the web frontend only; the React Native app under `app/` is out of scope.

---

## 1. Executive summary

Three findings drive most of the consistency debt:

1. **The shared game-tile component is dead.** `renderGameCard` (`ui/game-card.js:11`) and its `.game-card` CSS class are defined but have zero call sites outside the definition file. Every surface that shows a game tile re-implements the markup inline (`.collection-tile`, `.hot-game-tile`, `.preview-card__cover`, `.game-detail__polaroid`, `.plays-list__thumb`, `.game-polaroid`). That is **six distinct game-tile styles** for the same data, none of them sharing a base.
2. **User avatars are half-migrated.** `BgbBadge.render` (`ui/user-badge.js:131`) is the canonical single-source-of-truth and is used in 30+ call sites. But the global header still ships `.avatar-bubble--me` markup (`index.html:50`, `init.js:140`), and the supporting CSS for `.avatar-bubble` is defined **twice in `styles.css` with conflicting values** (lines 2237 and 2555). The `--me` markup is alive only as a pre-hydration placeholder — `init.js:143` replaces it with a `BgbBadge` element as soon as the user store loads.
3. **The buddies panel exists in two near-identical copies.** `ui/buddies-panel.js` (483 lines) exports a `BuddiesPanel` class that is never instantiated anywhere; `views/buddies-view.js` (430 lines) is a separate reimplementation of the same UI used by the actual `buddies` route. They share helper structure and most render strings.

Smaller findings: `.animate-fade` (without `Up`) does not exist (an earlier audit pass had assumed it did); `.admin-tool*`, `.bgb-filter-panel`, and `.book-hint/slot/spine*` CSS classes are unreferenced; `renderStatusTag` is called with three different option shapes (`{ size: "xs" }`, `{ size: "lg", addLabel: ... }`, `{ compact: true }`) depending on the host surface; typography is broadly consistent (Crimson for display, Poppins for chrome, Fraunces for polaroid-style headers, JetBrains Mono for scores) but the `.plays-list__row` view sidesteps the polaroid look entirely.

---

## 2. Screens & routes

The app is a single-page shell. `index.html` contains 18 `<main data-view="...">` containers; the router toggles `.hidden` between them. All 17 view classes are constructed and registered in `init.js:11–48`.

| Route (`data-view`) | View class | File | Lines | How user reaches it | Primary content |
| --- | --- | --- | --- | --- | --- |
| `splash` | `SplashView` | `views/splash-view.js` | 16 | Auto on boot | Loading screen pre-auth |
| `auth` | `AuthView` | `views/auth-view.js` | 143 | Sign out, unauthenticated boot | Email form + Google + Apple OAuth |
| `feed` | `FeedView` | `views/feed-view.js` | 475 | Bottom-nav "Feed", post-login default | Chronological play cards + hot-games rail + buddy suggestions |
| `log-play` | `LogPlayView` | `views/log-play-view.js` | 426 | Bottom-nav center "Play" disc | Host-or-Join chooser + "Find a Game" Polaroid grid |
| `play-flow` | `PlayFlowView` | `views/play-flow-view.js` | 1513 | Host choice from `log-play` | 3-screen cascade: Gather → Play → Settle |
| `join-session` | `JoinSessionView` | `views/join-session-view.js` | 222 | Join choice from `log-play` | Session code field + joinable sessions list |
| `game-detail` | `GameDetailView` | `views/game-detail-view.js` | 464 | Tap any game thumbnail/tile | Hero polaroid + status + expansions + reference guide + recent plays |
| `reference-guide-add` | `ReferenceGuideAddView` | `views/reference-guide-add-view.js` | 1004 | "Add chapter" FAB on `game-detail` or the guide scroll | Create / Browse chapter tabs with markdown editor |
| `profile-self` | `ProfileSelfView` | `views/profile-self-view.js` | 277 | Bottom-nav "Profile" | Stats + collection preview + recent-plays preview + buddies preview |
| `profile-other` | `ProfileOtherView` | `views/profile-other-view.js` | 279 | Tap player name on a play card | Public profile w/ buddy-state CTA |
| `collection` | `CollectionView` | `views/collection-view.js` | 461 | "See all" from profile collection preview | Filterable owned-games grid |
| `wishlist` | `WishlistView` | `views/wishlist-view.js` | 326 | "See all" from profile wishlist preview | Wishlisted-games grid |
| `plays` | `PlaysView` | `views/plays-view.js` | 301 | "See all" from profile recent-plays preview | Chronological log grouped by day |
| `buddies` | `BuddiesView` | `views/buddies-view.js` | 430 | Profile buddies preview "See all" / +1 chip | Mutual friends + incoming / outgoing requests + ghost linker |
| `session-viewer` | `SessionViewerView` | `views/session-viewer-view.js` | 591 | Join a session via `join-session` | Read-only mirror of host's Play / Settle screens |
| `settings` | `SettingsView` | `views/settings-view.js` | 589 | Tap top-right avatar | Account, avatar customizer, BGG link, admin-key, delete account |
| `admin` | `AdminView` | `views/admin-view.js` | 297 | Settings → admin tools (gated) | Chapter moderation list |

Bottom navigation is hard-coded in `index.html` and consists of three slots: Feed (route `feed`), Play (route `log-play` — stays lit through `play-flow` and `session-viewer`), Profile (route `profile-self`). The global header is fixed at the top: left side is the brand wordmark routing to `feed`, right side is the user avatar button routing to `settings`.

---

## 3. Reusable components

Components are global functions / classes attached to `window`. There is no module system. Reuse counts in this section are produced by grepping each name across `views/`, `widgets/`, `ui/`, `index.html`, and `init.js`; each row is exact.

### 3.1 `renderGameCard` — `ui/game-card.js:11`
- **Returns:** HTML string (an `<article class="game-card">`).
- **Reuse count: 0 external call sites.** The only references are the definition (`ui/game-card.js:11`) and the `window` assignment (`ui/game-card.js:75`). Grep across `views/`, `widgets/`, `index.html` returns nothing.
- **Status:** **DEAD.** Both the JS function and the `.game-card` CSS family (which has no class definitions in `styles.css`) appear orphaned. Cross-reference: `grep -n "\.game-card" styles.css` returns no matches; the only `game-card` styling in `styles.css` is implicit via the never-used class.
- **What replaced it:** Six separate inline implementations (see §5c).

### 3.2 `renderGamePolaroid` — `ui/game-card.js:44`
- **Returns:** HTML string (an `<article class="game-polaroid">`).
- **Reuse count: 1 call site.** `views/log-play-view.js:294` — used to populate the "Find a Game that fits" grid on the Host/Join landing.
- **Visual style:** Cream Polaroid card (Fraunces caption via `--font-polaroid` in `styles.css:6181`), tilt animation by default, status pill in top-right.
- **How accessed:** User taps the bottom-nav "Play" disc, sees the host/join chooser overlaid on a polaroid grid of recent games.
- **Inconsistency:** This is the only reusable game-tile component in the codebase that is actually used. Every other surface re-implements its tile inline.

### 3.3 `renderPlayCard` — `ui/play-card.js:63`
- **Returns:** HTML string (an `<article class="play-card">`).
- **Reuse count: 2 external call sites.** `views/feed-view.js:181` (single-card session), `views/feed-view.js:223` (multi-card strip session), `views/game-detail-view.js:182` (game-detail recent-plays reel). The function is also called by its own internal `rerenderCard` (`ui/play-card.js:396`) for in-place flip updates.
- **Visual style:** Two-faced flip card (`.play-card` + `.play-card__front` + `.play-card__back`), polaroid-style cream surface, photo at top, caption row with game name + winner. Strip vs single variant chosen by the `__sessionPlayCount` hint (`ui/play-card.js:74–78`); 1-card sessions use `strip` so a solo play renders at the same size as a multi-play rail. Per-card state (flipped, hydrated payload) lives in a module-level `Map` keyed by `play_id` (`ui/play-card.js:22`).
- **How accessed:** Scroll the feed; visit game-detail and look at "Recent plays".
- **Outlier check:** Earlier audit notes flagged `findCardById` (`ui/play-card.js:405`) as dead — **NOT dead**, it is the registry lookup used by `rerenderCard` at `ui/play-card.js:394`. The `plays` view, `play-flow` Settle screen, and `session-viewer` do **not** render `renderPlayCard` — they each have their own play presentation. See §5b for the consequences.

### 3.4 `renderStatusTag` — `ui/status-tag.js:59`
- **Returns:** HTML string (a `<span class="status-tag">`).
- **Reuse count: 8 external call sites** across 7 files.
  - `ui/game-card.js:55` — inside `renderGamePolaroid`
  - `ui/play-card.js:137` — overlay on `.play-card__photo`
  - `views/collection-view.js:311` — `.collection-tile`
  - `views/wishlist-view.js:198` — same tile shape as collection
  - `views/feed-view.js:242` — `.hot-game-tile`
  - `views/feed-view.js:293` — `.hot-game-tile` (featured-from-collection rail)
  - `views/game-detail-view.js:131` — game-detail hero polaroid
  - `views/plays-view.js:193` — `.plays-list__row`
- **Visual style:** Pill badge: owned (library icon) / wishlist (star) / played (checkmark) / null (renders an "Add" button when `addLabel` opt is passed). Sizes: `xs` (compact), default, `lg` (full).
- **How accessed:** Every surface that shows a game thumbnail.
- **Inconsistency:** Three distinct option shapes in use:
  - `{ size: "xs" }` — collection, wishlist, feed hot-games (3 surfaces).
  - `{ compact: true }` — play-card overlay, plays-view row, polaroid (3 surfaces).
  - `{ size: "lg", addLabel: "Add" }` — game-detail hero (1 surface).
  
  The `compact: true` flag is a legacy name; based on usage it produces a similar size to `size: "xs"`. Worth collapsing into a single `size` parameter.

### 3.5 `renderExpansionBadge` — `ui/status-tag.js:46`
- **Returns:** HTML string.
- **Reuse count: 4 call sites.** `views/collection-view.js:316`, `views/wishlist-view.js:203`, `views/feed-view.js:251`, `views/feed-view.js:302`.
- **Visual style:** Small count chip on a game tile with an `--exp-color` CSS variable set inline.
- **Outlier check:** `views/game-detail-view.js` does not call this; expansions are rendered as a collapsible section instead — that is intentional, not an inconsistency.

### 3.6 `BgbBadge.render` — `ui/user-badge.js:131`
- **Returns:** HTML string (a `<span class="user-badge">`).
- **Reuse count: 30 call sites** across 11 files (the canonical user-avatar component):
  - `init.js:143` (global header sync)
  - `ui/play-card.js:315, 327` (ghost + signed player badges on back side)
  - `ui/buddies-panel.js:180, 199, 262, 331, 348, 377` (6 sites — but file is itself unused, see §3.13)
  - `ui/polaroid-popup.js:341` (avatar customizer carousel)
  - `views/buddies-view.js:128, 147, 170, 243, 260, 289` (6 sites — duplicate of buddies-panel)
  - `views/collection-view.js:173` (header for someone-else's-collection)
  - `views/feed-view.js:269` (`.buddy-tile` suggestion card)
  - `views/play-flow-view.js:412, 1438` (Gather player chip + buddy chooser)
  - `views/plays-view.js:126` (header for someone-else's-plays)
  - `views/profile-self-view.js:73, 184` (profile hub + buddies preview)
  - `views/profile-other-view.js:106` (profile hub)
  - `views/session-viewer-view.js:392, 446` (player chip + scoring grid columns)
  - `views/settings-view.js:118` (settings avatar edit button)
  - `widgets/round-score-grid.js:140` (scoring-grid column headers)
  - `widgets/play-detail-popup.js:259` (modal player list)
- **Visual style:** Colored circle with initials or one of 10 board-game-themed icons (`buddy`, `meeple`, `die`, `sword`, `shield`, `crown`, `spade`, `heart`, `rook`, `hourglass`). 12-swatch palette defined in `ui/user-badge.js:36–49`. Sizes: `xs` (20px), `sm` (28px), `md` (40px), `lg` (72px). Ghost players (no account) render a light grey baseline (`ui/user-badge.js:28–32`); the viewer's own badge can get a highlight ring via `isMe: true` (`ui/user-badge.js:143`). CSS lives at `styles.css:7352–7395`.
- **How accessed:** Every player surface — feed cards, buddies list, scoring grid, profile headers, header avatar, modals.
- **Note:** This is the model component for the codebase. It owns its tokens (`DEFAULT_AVATAR`, `GHOST_AVATAR`, `PALETTE`, `ICONS`, `ITEMS`) and exposes them on `window.BgbBadge` so callers like the customizer in `ui/polaroid-popup.js` can render the same items in the same colors. Other components could be reorganized similarly.

### 3.7 `.avatar-bubble` (legacy markup) — `index.html:50`, `init.js:140`
- **Reuse count: 2 sites.** Used as the initial markup of `#bgb-global-avatar`. `init.js:143` calls `BgbBadge.render` and `outerHTML`-replaces the bubble as soon as the user store fires its first event.
- **Visual style:** Initially a brown 28px circle (`styles.css:2237` definition wins until the second one fires at `styles.css:2555`).
- **DUPLICATE CSS DEFINITION:** `.avatar-bubble` is declared twice in `styles.css`:
  - `styles.css:2237` — 28px square, oklch palette colors, uppercase letter spacing.
  - `styles.css:2555` — 36px circle (`border-radius: 999px`), different fill, no letter spacing.
  
  The later definition (`:2555`) wins in source order. The earlier one is effectively shadowed. `.avatar-bubble--xs` is similarly duplicated at `styles.css:2253` (20px) and `styles.css:4276` (26px).
- **Recommendation:** Remove the bubble markup from `index.html:50` and let `init.js:143` mount a `BgbBadge.render({ isMe: true, size: "sm" })` directly. Delete both `.avatar-bubble` blocks and `.avatar-bubble--xs` / `--lg` / `--md` from CSS.

### 3.8 `PolaroidPopup.{show, dismiss, update, confirm, alert, avatarCustomizer}` — `ui/polaroid-popup.js`
- **Reuse count:** 16 call sites across 10 files.
  - `show`: `views/session-viewer-view.js:226` (a single mount of the joiner's session-finished modal)
  - `dismiss`: `views/session-viewer-view.js:65, 218`, `views/play-flow-view.js:89`
  - `update`: `views/session-viewer-view.js:202`
  - `confirm`: `views/log-play-view.js:391` (abandon session), `views/play-flow-view.js:667` (abandon mid-play), `views/game-detail-view.js:415` (remove from collection), `widgets/play-detail-popup.js:646` (delete play)
  - `alert`: `init.js:113`, `views/settings-view.js:173`, `views/play-flow-view.js:1485`, `widgets/play-detail-popup.js:741`
  - `avatarCustomizer`: `init.js:94` (first-time setup), `views/settings-view.js:152` (edit avatar)
- **Visual style:** Polaroid card on a backdrop, X close button, optional title/body/buttons. Confirm is the canonical destructive-action gate (per `.claude/rules/web-frontend.md` "Destructive actions are confirmed").
- **How accessed:** Through code only — not directly via a user action. Triggered by long-press / delete buttons / abandon flows.
- **Note:** Single source of truth, no competing modal system. The avatar customizer specifically shares state via `BgbBadge.PALETTE` and `BgbBadge.ICONS` (`ui/polaroid-popup.js:237–238`), so picker swatches stay in sync with rendered badges.

### 3.9 `renderMarkdown` — `ui/markdown.js:49`
- **Returns:** HTML string.
- **Reuse count: 3 call sites.** `views/reference-guide-add-view.js:513` (preview pane in chapter editor), `views/reference-guide-add-view.js:623` (live preview), `widgets/reference-guide-scroll.js:261` (chapter content on the guide scroll).
- **Visual style:** Output wrapped in `.guide-text` (`styles.css` — referenced in §4).
- **How accessed:** Reference guide expand / chapter create-or-edit.

### 3.10 `oauthButtons` — `ui/oauth-buttons.js:16`
- **Returns:** HTML string.
- **Reuse count: 1 call site.** `views/auth-view.js:30`.
- **Visual style:** Google + Apple OAuth buttons with inline SVG logos.
- **How accessed:** Sign-in / sign-up screen.

### 3.11 `ReferenceGuideScroll` (class) — `widgets/reference-guide-scroll.js:18`
- **Reuse count: 3 instantiations.** `views/game-detail-view.js:287`, `views/play-flow-view.js:1350`, `views/session-viewer-view.js:564`.
- **Visual style:** Parchment scroll that collapses to rolled edges and expands to a full chapter list. Floating "Add chapter" FAB. Per-chapter source-game pills (`.scroll-chapter__source-dot` with `--exp-color` set inline). Loading state uses the global `buddyLoader` helper.
- **How accessed:** Game detail (always available on game pages), play-flow Play screen, session-viewer Play screen.
- **Note:** This is the only widget where state is bound to a single global (`window.referenceGuideScroll`, `widgets/reference-guide-scroll.js:32`) — meaning two simultaneous instances would clobber each other. Today only one is mounted at a time, so the constraint is implicit but not enforced.

### 3.12 `renderRoundGrid` — `widgets/round-score-grid.js:35`
- **Returns:** HTML string (a `<table class="scoring-table">`).
- **Reuse count: 3 call sites.** `views/play-flow-view.js:485` (host scoring during Play phase), `widgets/play-detail-popup.js:236` (modal scoreboard), `widgets/play-detail-popup.js:397` (edit-mode scoreboard).
- **Visual style:** Players × rounds matrix. Numbers in `--font-score` (JetBrains Mono, `styles.css:2826, 2960`). Totals row at bottom; winner total highlighted. `host` arg is the name of the global view instance that owns the score-update handlers (`window.playFlowView`, `window.PlayDetailPopup`).
- **How accessed:** Live during a play; in the popup when opening any past play.

### 3.13 `BuddiesPanel` (class) — `ui/buddies-panel.js:14`
- **Reuse count: 0 instantiations.** Grep for `BuddiesPanel\b` (`ui/buddies-panel.js:8, 14, 482`) returns only declarations.
- **Status:** **DEAD** as a runtime component. The class is fully built and exported (`ui/buddies-panel.js:482`) but no view ever does `new BuddiesPanel(...)`.
- **What replaced it:** `views/buddies-view.js` (430 lines) is a separate implementation of the same UI used by the actual `buddies` route. The two files share most of their structure (`grep BgbBadge.render ui/buddies-panel.js views/buddies-view.js` shows 6 calls each in the same `buddies-row__avatar` shape). They were either built in parallel or one was kept as a "panel" copy intended for inclusion in another view that never landed.
- **Recommendation:** Delete `ui/buddies-panel.js` after confirming no embedded use; or, if a panel re-use is planned, delete `views/buddies-view.js` and re-mount `BuddiesPanel` as the route. Today both maintain costs.

### 3.14 `PlayDetailPopup` — `widgets/play-detail-popup.js`
- **Reuse count: 6 call sites.** All `PlayDetailPopup.show(playId)` invocations:
  - Maximize button in `ui/play-card.js` (back side)
  - Tap on `.plays-list__row` in `views/plays-view.js`
  - Various edit / share flows internal to the widget itself
- **Visual style:** Full play detail in a modal overlay. Owns its own `.play-detail__*` CSS family (`styles.css:3659+`). Hosts a `renderRoundGrid` for the scoreboard.
- **How accessed:** Tap the maximize button on a play card; tap any row in the chronological plays view.
- **Inconsistency:** Calls `PolaroidPopup.confirm` (`widgets/play-detail-popup.js:646`) for delete-play confirmation but otherwise uses its own modal styling — i.e. the popup is **not** a `PolaroidPopup`, it is a separate modal system. Worth noting for future refactor.

### 3.15 Global header (logo + avatar) — `index.html:36–53`
- Hard-coded markup, no render function. Logo links to `feed`; avatar button links to `settings`. The avatar is initially `<span class="avatar-bubble avatar-bubble--me">?</span>` and is replaced by `BgbBadge.render` once the user loads (`init.js:143`).
- **Reuse count: 1 instance** (only one header).
- **Recommendation:** Inline-render the avatar through `BgbBadge.render({ size: "sm", isMe: true })` from the start, removing the legacy bubble.

### 3.16 Bottom nav (Feed / Play / Profile) — `index.html`
- Hard-coded markup using `.bgb-nav*` classes (`styles.css:2451+`).
- **Reuse count: 1 instance.** Three tabs; the centre "Play" disc is a raised gold tile that stays lit through `log-play`, `play-flow`, and `session-viewer`.

---

## 4. CSS class inventory

`styles.css` is ~7,664 lines and contains ~650 class blocks. The table below groups them by purpose and notes the font/token used per group plus any dead classes found.

| Group | Representative classes | Lives at | Fonts / tokens | Dead members |
| --- | --- | --- | --- | --- |
| Global layout | `.bgb-global-header*`, `.bgb-nav*`, `.bgb-cream-screen` | `styles.css:2451+` | `--font-display`, `--accent`, `--polaroid-bg` | None |
| Game tile — canonical (DEAD) | `.game-card*` | _no definitions in styles.css_ | n/a | The entire family — the JS renders these classes but no CSS targets them |
| Game tile — Polaroid | `.game-polaroid`, `.game-polaroid__*` | `styles.css:6124–6195` | `--font-polaroid` (Fraunces) | None |
| Game tile — collection | `.collection-tile`, `.collection-tile__*` | `styles.css:3536–3542`, `:4156–4157` | `--font-sans` | None |
| Game tile — hot games | `.hot-game-tile`, `.hot-game-tile__*` | Inside feed section | `--font-sans` | None |
| Game tile — profile preview | `.preview-card`, `.preview-card__*` | `styles.css:6611–6700+` | `--font-display` for title, `--font-sans` for body | None |
| Game tile — game detail hero | `.game-detail__polaroid*` | Inside `game-detail__*` block | `--font-display` for name | None |
| Plays list row | `.plays-list__row`, `.plays-list__thumb`, `.plays-list__top`, `.plays-list__sub`, `.plays-list__status` | Inside plays-view section | `--font-sans`, `--font-display` for day divider | None |
| Play cards | `.play-card`, `.play-card--single`, `.play-card--strip`, `.play-card__front`, `.play-card__back`, `.play-card__photo`, `.play-card__caption*`, `.play-card__status-overlay`, `.play-card__game-overlay`, `.play-card__maximize`, `.play-card__back-*` | `styles.css:2680+` cluster | `--font-polaroid` for caption, `--font-display` for back title, `--font-score` for scores | None |
| Reference guide | `.scroll-panel*`, `.scroll-panel--rolled`, `.scroll-chapter*`, `.scroll-section*`, `.guide-controls`, `.guide-search`, `.guide-pill*`, `.guide-text` | `styles.css:1150–1350+` block | `--font-display` for chapter titles, `--font-polaroid` for guide-text body | None |
| Chapter editor | `.chapter-edit__*`, `.chapter-add__*` | `styles.css:610–940` block | `--font-display` for titles, mono for chapter-edit toolbar icons | None |
| Status badges | `.status-tag`, `.status-badge`, `.status-badge--owned`, `.status-badge--wishlist`, `.status-badge--played`, `.expansion-count-badge`, `.expansion-dot` | `styles.css:4100+` cluster | `--font-sans`, `--accent`, `--exp-color` (inline) | None |
| User badges (canonical) | `.user-badge`, `.user-badge--xs`, `.user-badge--sm`, `.user-badge--md`, `.user-badge--lg`, `.user-badge--me`, `.user-badge--ghost`, `.user-badge__initials`, `.user-badge__icon` | `styles.css:7352–7395` | `--font-sans` for initials | None |
| User badges (LEGACY) | `.avatar-bubble`, `.avatar-bubble--xs`, `.avatar-bubble--lg`, `.avatar-bubble--md`, `.avatar-bubble--me` | **Duplicated:** `:2237` and `:2555` (`.avatar-bubble`), `:2253` and `:4276` (`.avatar-bubble--xs`) | `--font-sans` | `--md` (`:3211`) is referenced only by old bubble markup; once `index.html:50` is migrated this whole group can be deleted |
| Modal popups | `.polaroid-popup__*`, `.avatar-cust__*` | `styles.css:200–500` block | `--font-polaroid` for title, `--font-display` for body headings | None |
| Cascade play flow | `.cascade-screen*`, `.cascade-card*`, `.cascade-game-chip`, `.cascade-player`, `.cascade-notes`, `.cascade-photo` | `styles.css:5028+` block | `--font-display` for headings | None |
| Scoring grid | `.scoring-table`, `.scoring-table-wrap`, `.scoring-cell`, `.scoring-cell--read`, `.scoring-total-row`, `.scoring-total-cell--winner`, `.scoring-head` | Inside scoring section | `--font-score` (JetBrains Mono) for all numbers | None |
| Profiles | `.profile-hub*`, `.profile-id*`, `.profile-collection-grid`, `.profile-collection__*`, `.profile-stats`, `.profile-stat-card*`, `.profile-empty`, `.profile-loading`, `.profile-panel__*` | `styles.css:3179–3500+` | `--font-display` for names + stats | None |
| Spoke / sub-pages | `.spoke-head*`, `.spoke-toggle*` | Inside collection / wishlist / plays | `--font-display` for title | None |
| Buddies | `.buddies-row`, `.buddies-row__avatar`, `.buddies-row__avatar--ghost`, `.buddy-tile`, `.buddy-tile__avatar`, `.search-hit` | Inside buddies section | `--font-sans` | None |
| Animations | `.animate-fadeUp` | `styles.css:88` | n/a | `.animate-fade` (without `Up`) does NOT exist — earlier audit notes that mentioned it as dead were incorrect; there is no class to delete |
| Admin (used) | `.admin-reports__*` | Inside admin block | `--font-sans` | None |
| Admin (DEAD) | `.admin-tool`, `.admin-tool-list`, `.admin-tool__icon`, `.admin-tool__body`, `.admin-tool__title`, `.admin-tool__blurb`, `.admin-tool__chev` | `styles.css:3381–3405` | n/a | **All dead** — zero references in any JS/HTML file |
| Filter (DEAD) | `.bgb-filter-panel` | `styles.css:1712` | n/a | **Dead** — only CSS, no usage |
| Book metaphor (DEAD) | `.book-hint`, `.book-slot`, `.book-spine`, `.book-spine__art`, `.book-spine__title`, `.book-spine__plays`, `.book-spine.pulling`, `.book-spine__art--blank` | `styles.css:1792–1924+` | n/a | **All dead** — no consuming view |
| Typography helpers | `.font-display` (`styles.css:68`), `.font-score` (used inline via `var(--font-score)`), `.guide-text` | various | declared at `:23–46` | None |

---

## 5. Cross-cutting consistency findings

This section answers the user's three specific questions.

### 5a. Do all game play cards look and act the same?

The actual `.play-card` component (via `renderPlayCard`) renders on exactly **two** surfaces. There are no other surfaces that use the play-card markup — earlier audit notes that listed "play-flow Settle" and "session-viewer Settle" as play-card surfaces were incorrect, neither calls `renderPlayCard`.

| Surface | File:line | Variant | Hydrates on flip? | Maximize button? | Notes |
| --- | --- | --- | --- | --- | --- |
| Feed — single play | `views/feed-view.js:181` | `single` (no `__sessionPlayCount`) | Yes (`window.Play.get`) | Yes | Caption: game name + winner |
| Feed — multi-play session strip | `views/feed-view.js:223` | `strip` (`__sessionPlayCount=n`) | Yes | Yes | Group header above strip |
| Game detail — recent plays | `views/game-detail-view.js:182` | `strip` (forced `__sessionPlayCount=2`) | Yes | Yes | Same flip / hydrate behavior; uses `_toFeedPlayCard` adapter |

**Verdict: consistent across all three call sites.** Same component, same flip semantics, same maximize → `PlayDetailPopup.show` route. The forced `__sessionPlayCount=2` on game-detail is deliberate (per the comment at `views/game-detail-view.js:170–180`) and keeps single plays from rendering bigger than their multi-play neighbours.

### 5b. Are all play session displays consistent?

Plays show up in **five distinct presentations**, each with its own markup:

| Surface | Component | Visual idiom |
| --- | --- | --- |
| Feed — session of plays | `renderPlayCard` (strip / single) | Polaroid flip card |
| Game detail — recent plays | `renderPlayCard` (forced strip) | Polaroid flip card |
| Plays view — chronological log | Inline `.plays-list__row` (`views/plays-view.js:196`) | Compact horizontal row: thumb + game name + date |
| PlayDetailPopup | `PlayDetailPopup.show` | Full-screen modal with scoreboard table, notes, photo, players list |
| Session viewer (active session) | No play card; renders the host's scoring grid (`widgets/round-score-grid.js`) + reference guide | Read-only mirror of the host's Play screen — there is **no** play-card representation of an in-progress session |

**Verdict: inconsistent.** The four "play summary" surfaces (feed, game-detail, plays list, popup) use three different visual idioms (polaroid flip card, compact list row, modal table) — none of them share base markup. The compact `.plays-list__row` in particular looks nothing like the polaroid cards even though it shows the same record. Worth deciding whether the chronological log should also use `renderPlayCard` (in strip variant) so plays read consistently with the feed.

A second inconsistency is the entry point to `PlayDetailPopup`: from a play card it is opened via the maximize button on the back side (`ui/play-card.js:262`); from the plays list it is opened by tapping the row directly. Two affordances for the same destination, depending on which surface you start from.

### 5c. Do screens showing the same information look and feel the same?

Six paired surfaces compared.

**Profile-self vs Profile-other** — `views/profile-self-view.js` (277 lines) and `views/profile-other-view.js` (279 lines). Both render a `.profile-hub` header, a `.profile-stat-card` strip, and a body of preview cards. Profile-other's stats grid uses `.profile-stat-card--static` (no clickable tiles), profile-self's are clickable. Otherwise the visual structure is consistent. Both views use `BgbBadge.render` for the header avatar (`profile-self-view.js:73`, `profile-other-view.js:106`). **Verdict: consistent.**

**Collection vs Wishlist** — Both use `.profile-collection-grid` and `.collection-tile`, with `collection-view.js:299` and `wishlist-view.js:186` identical except for status filter. Both call `renderStatusTag` and `renderExpansionBadge` with identical `{ size: "xs" }` options. **Verdict: consistent.**

**Game detail vs game polaroid (Gather screen)** — Same game, two different presentations:
- Game detail (`views/game-detail-view.js:120–158`): hero polaroid with title in Crimson display, meta pills (players, time, expansion flag, coop flag), action row.
- Game polaroid in Gather (`ui/game-card.js:44`): smaller Polaroid with Fraunces caption, no meta pills, status overlay only.

**Verdict: intentional difference, not an inconsistency.** Game-detail is a "full record" page; the Gather grid is a chooser. Visual differentiation is appropriate.

**Buddies view vs Settings buddies panel** — `views/buddies-view.js` is the live route. `ui/buddies-panel.js` is a separate class that was apparently intended for embedding (settings? profile?) but is never instantiated. They share render strings (compare `views/buddies-view.js:128` and `ui/buddies-panel.js:180` — identical `BgbBadge.render` calls into a `buddies-row` shell). **Verdict: dead duplicate, not a visual inconsistency.** See §3.13.

**Reference guide scroll vs chapter editor preview pane** — Both render via `renderMarkdown` into `.guide-text` containers. The scroll has parchment chrome (`.scroll-panel--rolled`); the editor preview is a flat pane. **Verdict: shared component, intentional chrome difference.**

**Profile preview tiles vs collection grid tiles** — `views/profile-self-view.js:138` renders `.preview-card__cover` (tiny image-only thumbnails, ≤ 6 shown). `views/collection-view.js:310` renders `.collection-tile` (full image + name + status pill). These show the same data at different densities. There is **no shared base** between them. **Verdict: minor inconsistency** — both could render through one `renderGameTile(game, { variant: "preview" | "full" })` if the canonical tile component were resurrected.

---

## 6. Component reuse summary

A list of every place where ad-hoc markup duplicates an available (or intended-to-be-available) component. Each row maps the concern → the component that exists → the surface that bypasses it → a one-sentence recommendation.

| Concern | Component that exists | Surface(s) that bypass it | Recommendation |
| --- | --- | --- | --- |
| Game tile | `renderGameCard` (`ui/game-card.js:11`) — dead but defined | `.collection-tile` (`views/collection-view.js:310`, `views/wishlist-view.js`); `.hot-game-tile` (`views/feed-view.js:240, 290`); `.preview-card__cover` (`views/profile-self-view.js:138`); `.game-detail__polaroid` (`views/game-detail-view.js:125`); `.plays-list__thumb` (`views/plays-view.js:198`); `.game-polaroid` (`ui/game-card.js:44`) | Either delete `renderGameCard` + its (already non-existent) CSS, or resurrect it as the canonical tile with a `variant` parameter (`full` / `tile` / `preview` / `thumbnail`) and migrate the six call sites. The current state — six bespoke tiles + a dead "canonical" — is the worst of both worlds. |
| User avatar | `BgbBadge.render` (`ui/user-badge.js:131`) | Global header initial markup (`index.html:50`, `init.js:140`) uses `.avatar-bubble--me` until the user store loads | Replace the initial markup with `BgbBadge.render({ size: "sm", isMe: true, displayName: "" })` so the placeholder uses the same component. Delete `.avatar-bubble` CSS and the duplicate definitions at `styles.css:2237 / 2555 / 2253 / 4276`. |
| Buddies UI | `BuddiesPanel` class (`ui/buddies-panel.js:14`) — dead but defined | `views/buddies-view.js` (430 lines, mirror implementation) | Pick one. If panels are needed in other surfaces (settings, profile), keep `BuddiesPanel` and make `buddies-view` a thin wrapper; otherwise delete `ui/buddies-panel.js`. |
| Status tag options | `renderStatusTag(gameId, status, opts)` (`ui/status-tag.js:59`) | Three call shapes: `{ size: "xs" }`, `{ size: "lg", addLabel }`, `{ compact: true }` | Collapse `compact` and `size: "xs"` into a single canonical option set (e.g. only `size` ∈ `xs | sm | md | lg`). Today the same visual outcome can be requested two ways. |
| Modal system | `PolaroidPopup` (`ui/polaroid-popup.js`) | `PlayDetailPopup` (`widgets/play-detail-popup.js`) is its own modal | The play-detail popup uses `PolaroidPopup.confirm` for delete confirmation (`widgets/play-detail-popup.js:646`) but does not nest itself in a `PolaroidPopup`. If "play detail" is conceptually a polaroid (and the play cards it shows are polaroids), it could be rebuilt as a `PolaroidPopup.show({ body: renderPlayCard(card) })` and skip the second modal stack. Out of scope for this audit; flagged for future consideration. |
| Play summary | `renderPlayCard` (`ui/play-card.js:63`) | `.plays-list__row` in `views/plays-view.js:196` renders the same record as a list row, not a polaroid | If the chronological plays view should look like the feed, render it through `renderPlayCard` (strip variant). If the design intent is a compact list (denser than the feed), keep the divergence but document it in `STRUCTURE.md`. |

---

## 7. Dead code & low-confidence candidates

### 7.1 Confirmed dead (zero references outside the definition file)

| Symbol / class | Defined at | Grep evidence |
| --- | --- | --- |
| `renderGameCard` function | `ui/game-card.js:11` | Only `:11` (def) and `:75` (window assignment). No view consumers. |
| `.game-card`, `.game-card__*` CSS | _no definitions in `styles.css`_ | `grep -n "\.game-card" styles.css` returns no matches. The JS function emits the class names but no stylesheet targets them. |
| `BuddiesPanel` class | `ui/buddies-panel.js:14` | `grep -rn "BuddiesPanel\b"` returns only `:8` (comment), `:14` (class), `:482` (window assignment). |
| `.admin-tool`, `.admin-tool-list`, `.admin-tool__icon`, `.admin-tool__body`, `.admin-tool__title`, `.admin-tool__blurb`, `.admin-tool__chev` | `styles.css:3381–3405` | Zero JS/HTML references. The admin view uses `.admin-reports__*` only. |
| `.bgb-filter-panel` | `styles.css:1712` | Zero JS/HTML references. |
| `.book-hint`, `.book-slot`, `.book-spine`, `.book-spine__art`, `.book-spine__art--blank`, `.book-spine__title`, `.book-spine.pulling`, `.book-spine__plays`, `.book-slot:hover .book-spine`, `.book-spine:focus-visible` | `styles.css:1792–1924+` | Zero JS/HTML references. A "book / spine" pattern that the codebase no longer uses. |
| Duplicate `.avatar-bubble` CSS | `styles.css:2237` (shadowed by `:2555`) | The first block is unreachable in source order. |
| Duplicate `.avatar-bubble--xs` CSS | `styles.css:2253` (shadowed by `:4276`) | Same — the earlier block is unreachable. |

### 7.2 Low-confidence — verify before deleting

| Candidate | Why it might be in use | Verification step |
| --- | --- | --- |
| `.avatar-bubble`, `.avatar-bubble--me` (the surviving definitions) | Used by `#bgb-global-avatar` pre-hydration. After 50–150ms it is `outerHTML`-replaced (`init.js:143`). Keeping it only matters if the placeholder is visually important during boot. | If you migrate `index.html:50` to render via `BgbBadge` directly, this entire family becomes deletable. |
| `.avatar-bubble--lg`, `.avatar-bubble--md` | No live JS uses these sizes. Could be referenced by string-built selectors not found by grep. | `grep -rnE 'avatar-bubble--(lg\|md)'` to confirm before deletion. |

### 7.3 Items previously suspected dead that are actually alive (do NOT delete)

| Item | Citation that proves it is alive |
| --- | --- |
| `findCardById` in `ui/play-card.js:405` | Called from `rerenderCard` at `ui/play-card.js:394` (an in-place flip handler). |
| `.animate-fade` (without `Up`) | Not dead — it simply does not exist. `grep -n "animate-fade" styles.css` only returns `:88` (`.animate-fadeUp`). Earlier audit pass had this listed as a dead class, but there is nothing to delete. |

---

## 8. Inconsistencies — fonts, inline styles, design tokens

### 8.1 Typography map

The design has four type roles and one helper:

| Role | Token | Family | Where it lives | Where it's used |
| --- | --- | --- | --- | --- |
| Body / chrome | `--font-sans` (`styles.css:23`) | Poppins | Default `body` (`styles.css:64`) | Buttons, list rows, meta text, profile body |
| Display / headings | `--font-display` (`styles.css:24`) | Crimson Text | `.font-display` (`styles.css:68`) | Profile names, game-detail name, chapter titles, day dividers, profile stat values |
| Polaroid surfaces | `--font-polaroid` (`styles.css:45`) | Fraunces | `.game-polaroid__name`, `.play-card__caption-name`, `.play-card__back-title`, `.guide-text` body | The polaroid family of cards |
| Scoring | `--font-score` (`styles.css:46`) | JetBrains Mono | `.scoring-table`, `.scoring-cell`, `.play-card__back-player-score`, `.play-detail__player-score` | Every numeric score |
| Step indicator | inherits `--font-score` | JetBrains Mono | `.cascade-screen__step` | Cascade screen step counter |

**Findings:**

- **The plays list breaks the polaroid family.** `.plays-list__row` (`views/plays-view.js:196`) uses `--font-sans` for game name + meta — every other "play summary" surface uses the polaroid family (`--font-polaroid` for captions). Listed in §5b as a duplicate-of-component concern; flagged here as a typography mismatch too.
- **Markdown body inside polaroid surfaces.** `renderMarkdown` output is wrapped in `.guide-text`, which sets `font-family: var(--font-polaroid, var(--font-display))` (`styles.css:875, 905`). Inside a `.scroll-panel` (the parchment scroll), that's consistent with the surrounding chrome. Inside the chapter editor preview pane (a flat surface), it produces a polaroid-styled body next to non-polaroid input controls. Minor visual mismatch; users may not notice.
- **`.chapter-edit__tbtn--ital` uses `--font-display`** instead of an italic variant of `--font-sans` (`styles.css:831`). Decision-y rather than wrong; flagged for completeness.

### 8.2 Inline-style audit — `style="--<token>:..."` sites

Eight sites set CSS variables inline. All eight are either per-game accent colors (which must come from the data, not the stylesheet) or per-expansion accent colors (same reason). None is a hardcoded literal that should be in CSS.

| Site | Variable | Source |
| --- | --- | --- |
| `ui/game-card.js:20` | `--game-accent` | `game.theme_color ?? '#C9922A'` |
| `ui/play-card.js:96` | `--game-accent` | `card.game.theme_color ?? var(--polaroid-accent)` |
| `views/game-detail-view.js:120` | `--game-accent` | per-game theme color |
| `widgets/reference-guide-scroll.js:239` | `--exp-color` | expansion's source color |
| `views/reference-guide-add-view.js:480, 733` | `--exp-color` | expansion's source color |
| `views/play-flow-view.js:1295` | `--exp-color` | expansion's source color |
| `widgets/play-detail-popup.js:284` | `--exp-color` | expansion's source color |

**Verdict: legitimate uses.** Per-game and per-expansion accent colors are data; they must be set per-instance. The fallback `#C9922A` in `ui/game-card.js:20` and `views/play-flow-view.js:1295` matches `--accent` (`styles.css:8`); could be replaced with `var(--accent)` directly so the fallback travels with the design token.

### 8.3 Design token coverage

Tokens declared in `:root` at `styles.css:8–53`. Two patterns to flag:

- **`--game-accent` is declared at `:root` with a default `#6B3FA0`** (`styles.css:12`) and a soft variant `--game-accent-light` (`:13`). But the live overrides set by JS (`ui/game-card.js:20`, `ui/play-card.js:96`, etc.) use the game's `theme_color`. So the default purple is essentially placeholder; if a card ever renders without an inline override it would be purple, which the feed and game-detail surfaces never want. Worth either tightening (`--game-accent: var(--polaroid-accent)` as the default) or removing the default to force callers to supply one.
- **Hex literals in JS** appear at `views/play-flow-view.js:1295` (`"#C9922A"`) and `widgets/play-detail-popup.js:284` (`"#C9922A"`). Both should reference `var(--accent)` so a brand-color change in CSS propagates.

Otherwise tokens are used consistently. The cascade flow has its own derived token `--cascade-bottom-pad` (`styles.css:5028`) which is fine. `--warm-taupe`, `--rust`, `--warm-gray-mid` are used widely across guide chrome, destructive buttons, and inactive toggles respectively.

---

## Appendix — How this audit was produced

Every component count and dead-code claim in this document is `grep`-verified. Key search commands used:

```
# component reuse
grep -rn "renderGameCard\|renderGamePolaroid\|renderPlayCard\|renderStatusTag\|renderExpansionBadge\|BgbBadge\|renderMarkdown\|oauthButtons\|PolaroidPopup\.\|ReferenceGuide\|renderRoundGrid\|PlayDetailPopup\|BuddiesPanel" \
  projects/boardgame-buddy/web/ --include="*.js" --include="*.html"

# dead CSS candidates
grep -rn "admin-tool\|bgb-filter-panel\|book-(hint\|slot\|spine)" \
  projects/boardgame-buddy/web/ --include="*.js" --include="*.html"

# duplicate definitions
grep -n "^\.avatar-bubble\b\|^\.avatar-bubble--" projects/boardgame-buddy/web/styles.css

# inline style="--var:" usages
grep -rnE 'style="--[a-z-]+:' projects/boardgame-buddy/web/ --include="*.js" --include="*.html"

# typography
grep -nE "font-family|Crimson|Fraunces|Poppins|JetBrains|font-display|font-score" \
  projects/boardgame-buddy/web/styles.css
```

To reproduce or extend: re-run those greps after any refactor and update the counts in §3 and §6.
