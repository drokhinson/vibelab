# BoardgameBuddy Web UI Audit

A consistency audit of `projects/boardgame-buddy/web/`. Every claim cites code as `path:line` so each finding can be jumped to and verified. The scope is the web frontend only; the React Native app under `app/` is out of scope.

> **Status:** Original audit produced 2026-05-23. Four passes have been applied
> since; read the **Cleanup log** at the bottom, newest first:
> Pass 1 + 2 (dead code) 2026-05-23, Pass 2 2026-08-20 (§9),
> Pass 3 (feed-card rework) 2026-08-29, **Pass 4 (theme system + sheet system)
> 2026-08-30**.
>
> ⚠️ Every `file:line` citation in §§2-8 dates from 2026-05-23 and has drifted.
> Treat the *claims* as current only where a later pass confirms them; re-grep
> before acting on any line number. Where a section header says "Updated
> <date>", that section has been re-verified.
>
> For the systems rather than the debt, read `Docs/ARCHITECTURE.md` §4 (design
> tokens, the three surface kinds, bottom sheets, chrome and layering).

---

## 1. Executive summary

The original audit identified three drivers of consistency debt. After the cleanup pass:

1. ~~**The shared game-tile component is dead.**~~ **Resolved (deletion):** `renderGameCard` and its `.game-card` CSS family have been removed. The six bespoke tiles (`.collection-tile`, `.hot-game-tile`, `.preview-card__cover`, `.game-detail__polaroid`, `.plays-list__thumb`, `.game-polaroid`) still each own their markup. A future change can introduce a single canonical tile with a `variant` parameter; until then, the six implementations stand. See §6.
2. ~~**User avatars are half-migrated.**~~ **Resolved (migration):** `index.html:50` now renders a `<span class="user-badge">` placeholder which `init.js#syncGlobalAvatar` replaces with `BgbBadge.render(...)` on first user-store fire. All `.avatar-bubble*` CSS has been deleted; the "this is me" gold-rim treatment now lives on `.user-badge--me` inside `.bgb-global-header__avatar`.
3. ~~**The buddies panel exists in two near-identical copies.**~~ **Resolved (deletion):** `ui/buddies-panel.js` was deleted along with its `<script>` tag in `index.html`. The live route `views/buddies-view.js` is now the single source of truth.

Smaller findings remained or are addressed:

- ~~`.admin-tool*`, `.bgb-filter-panel`, `.book-hint/slot/spine*` are unreferenced.~~ **All deleted.** The cleanup also caught additional dead families adjacent to the original `.book-*` finding: the closet/shelf chrome (`.shelf__*`, `.closet-*`, `.skeleton-book`, `.book-spine__exp*`), the swipe gestures (`.swipe-wrap`, `.swipe-hint*`), and the documentation diagram styles (`.card-anatomy*`). All confirmed dead by grep, all removed.
- `renderStatusTag` is still called with three option shapes (`{ size: "xs" }`, `{ size: "lg", addLabel: ... }`, `{ compact: true }`). Not addressed in this pass; tracked in §6.
- Typography remains broadly consistent (Geist for chrome, Fraunces for display and polaroid headers, JetBrains Mono for scores — see §8.1 for the current map), but the `.plays-list__row` view still sidesteps the polaroid look. Tracked in §5b / §8.1.
- `.animate-fade` (without `Up`) does not exist (an earlier audit pass had assumed it did).

---

## 2. Screens & routes

The app is a single-page shell. `index.html` contains 18 `<main data-view="...">` containers; the router toggles `.hidden` between them. All 18 view classes are constructed and registered in `init.js`.

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

Bottom navigation is hard-coded in `index.html` and consists of three slots: Feed (route `feed`), Play (route `log-play` — stays lit through `play-flow` and `session-viewer`), Profile (route `profile-self`). The global header is sticky at the top: left side is the brand wordmark routing to `feed`, right side is a pair of 36px utilities — the outbox indicator and a gear routing to `settings`.

The five spokes off the Profile hub (`collection`, `wishlist`, `plays`, `buddies`, `stats`) plus `settings` share the `.bgb-spoke-screen` class and its pinned back row. Settings carries a trailing-edge close rather than a back arrow, because it is reachable from the global header on any screen — see `ARCHITECTURE.md` §4.4.

---

## 3. Reusable components

Components are global functions / classes attached to `window`. There is no module system. Reuse counts in this section are produced by grepping each name across `views/`, `widgets/`, `ui/`, `index.html`, and `init.js`; each row is exact.

### 3.1 ~~`renderGameCard`~~ — DELETED in cleanup pass
- **Was at:** `ui/game-card.js:11` (now removed).
- **Reuse count before deletion: 0 external call sites.**
- **What replaced it:** Six separate inline implementations (see §5c). No JS replacement was introduced — the function was simply orphaned and is now gone.

### 3.2 `renderGamePolaroid` — `ui/game-card.js`
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

### 3.7 ~~`.avatar-bubble` (legacy markup)~~ — DELETED in cleanup pass
- **Was at:** `index.html:50` (pre-hydration placeholder) and `init.js:140` (logged-out reset).
- **Action taken:** Both call sites now use `BgbBadge.render`. The placeholder `<span>` in `index.html:50` is a bare `.user-badge.user-badge--sm` shell that `syncGlobalAvatar` immediately replaces. The "this is me" gold-rim treatment moved to `.user-badge--me` inside `.bgb-global-header__avatar` (`styles.css`).
- All `.avatar-bubble*` CSS — including the duplicate `:2237 / :2555` blocks, `--xs`, `--lg`, `--md`, and `--me` — has been removed.

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

### 3.13 ~~`BuddiesPanel` (class)~~ — DELETED in cleanup pass
- **Was at:** `ui/buddies-panel.js:14` (entire file removed).
- **Reuse count before deletion: 0 instantiations.**
- The corresponding `<script src="ui/buddies-panel.js">` was removed from `index.html`. The live `buddies` route continues to use `views/buddies-view.js` as the single source of truth.

### 3.14 `PlayDetailPopup` — `widgets/play-detail-popup.js`
- **Reuse count: 6 call sites.** All `PlayDetailPopup.show(playId)` invocations:
  - Maximize button in `ui/play-card.js` (back side)
  - Tap on `.plays-list__row` in `views/plays-view.js`
  - Various edit / share flows internal to the widget itself
- **Visual style:** Full play detail in a modal overlay. Owns its own `.play-detail__*` CSS family (`styles.css:3659+`). Hosts a `renderRoundGrid` for the scoreboard.
- **How accessed:** Tap the maximize button on a play card; tap any row in the chronological plays view.
- **Inconsistency:** Calls `PolaroidPopup.confirm` (`widgets/play-detail-popup.js:646`) for delete-play confirmation but otherwise uses its own modal styling — i.e. the popup is **not** a `PolaroidPopup`, it is a separate modal system. Worth noting for future refactor.

### 3.15 Global header (brand + utilities) — `index.html`
- Hard-coded markup, no render function. Sticky at `top: 0`, `z-index: 30`. Left side is the brand lockup routing to `feed`; the right side is **two 36px utility controls** — the outbox indicator and a gear routing to `settings`.
- The gear replaced the user's avatar in `ad3fe8b`: an avatar there read as "my profile", duplicating the Profile bottom-nav tab while hiding the only entry into Settings. The two right-hand controls now read as a pair of utilities rather than "an icon and an identity".
- **Reuse count: 1 instance** (only one header).

### 3.16 Bottom nav (Feed / Play / Profile) — `index.html`
- Hard-coded markup using `.bgb-nav*` classes (`styles.css:2451+`).
- **Reuse count: 1 instance.** Three tabs; the centre "Play" disc is a raised gold tile that stays lit through `log-play`, `play-flow`, and `session-viewer`.

---

## 4. CSS class inventory

`styles.css` is ~7,664 lines and contains ~650 class blocks. The table below groups them by purpose and notes the font/token used per group plus any dead classes found.

| Group | Representative classes | Lives at | Fonts / tokens | Dead members |
| --- | --- | --- | --- | --- |
| Global layout | `.bgb-global-header*`, `.bgb-nav*`, `.bgb-spoke-screen` | `styles.css:2451+` | `--font-display`, `--accent`, `--polaroid-bg` | None |
| Game tile — canonical | `.game-card*` | DELETED | n/a | Was never styled or referenced. Function and class family removed in cleanup. |
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
| User badges (LEGACY) | `.avatar-bubble*` family | DELETED | n/a | All variants removed in cleanup; visual intent ported to `.user-badge--me` + `.bgb-global-header__avatar .user-badge--me`. |
| Modal popups | `.polaroid-popup__*`, `.avatar-cust__*` | `styles.css:200–500` block | `--font-polaroid` for title, `--font-display` for body headings | None |
| Cascade play flow | `.cascade-screen*`, `.cascade-card*`, `.cascade-game-chip`, `.cascade-player`, `.cascade-notes`, `.cascade-photo` | `styles.css:5028+` block | `--font-display` for headings | None |
| Scoring grid | `.scoring-table`, `.scoring-table-wrap`, `.scoring-cell`, `.scoring-cell--read`, `.scoring-total-row`, `.scoring-total-cell--winner`, `.scoring-head` | Inside scoring section | `--font-score` (JetBrains Mono) for all numbers | None |
| Profiles | `.profile-hub*`, `.profile-id*`, `.profile-collection-grid`, `.profile-collection__*`, `.profile-stats`, `.profile-stat-card*`, `.profile-empty`, `.profile-loading`, `.profile-panel__*` | `styles.css:3179–3500+` | `--font-display` for names + stats | None |
| Spoke / sub-pages | `.spoke-head*`, `.spoke-toggle*` | Inside collection / wishlist / plays | `--font-display` for title | None |
| Buddies | `.buddies-row`, `.buddies-row__avatar`, `.buddies-row__avatar--ghost`, `.buddy-tile`, `.buddy-tile__avatar`, `.search-hit` | Inside buddies section | `--font-sans` | None |
| Animations | `.animate-fadeUp` | `styles.css:88` | n/a | `.animate-fade` (without `Up`) does NOT exist — earlier audit notes that mentioned it as dead were incorrect; there is no class to delete |
| Admin (used) | `.admin-reports__*` | Inside admin block | `--font-sans` | None |
| Admin (DEAD) | `.admin-tool*` family | DELETED | n/a | Removed in cleanup. |
| Filter (DEAD) | `.bgb-filter-panel` | DELETED | n/a | Removed in cleanup. |
| Book metaphor (DEAD) | `.book-hint*`, `.book-slot*`, `.book-spine*`, `.shelf__*`, `.closet-*`, `.skeleton-book` | DELETED | n/a | Entire "closet/shelf" feature was already non-functional; all CSS removed in cleanup. |
| Swipe gestures (DEAD) | `.swipe-wrap`, `.swipe-hint`, `.swipe-hint--log`, `.swipe-hint--guide` | DELETED | n/a | No consuming view; removed in cleanup. |
| Card-anatomy diagram (DEAD) | `.card-anatomy`, `.card-anatomy-diagram`, `.card-anatomy-legend`, `.card-anatomy-num` | DELETED | n/a | Documentation diagram styling with no consumer; removed in cleanup. |
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

> All items in §7.1 below were deleted in the cleanup pass. They are retained in this document as a historical record. See "Cleanup log" at the end of the doc for the exact diff summary.

### 7.1 Confirmed dead (resolved by cleanup)

| Symbol / class | Was at | Resolution |
| --- | --- | --- |
| `renderGameCard` function | `ui/game-card.js:11` | DELETED |
| `BuddiesPanel` class + file | `ui/buddies-panel.js` | DELETED (entire file + `<script>` tag) |
| `.admin-tool*` cluster | `styles.css:3378–3405` | DELETED |
| `.bgb-filter-panel` | `styles.css:1711–1717` | DELETED |
| `.book-*` family (book-slot/spine/hint/art/title/plays + `book-spine__exp*`) | `styles.css:1791–2053` | DELETED |
| `.shelf__*`, `.closet-*`, `.skeleton-book` (full "closet" feature) | `styles.css:1719–2018` | DELETED |
| `.swipe-wrap`, `.swipe-hint*` | `styles.css:2055–2093` | DELETED |
| `.card-anatomy*` | `styles.css:2259–2305` | DELETED |
| `.avatar-bubble*` family (including duplicates) | various lines (was 2237/2253/2555/3211/4276/6691/...) | DELETED — visual intent ported to `.user-badge--me` |

### 7.2 Items previously suspected dead that are actually alive (do NOT delete)

| Item | Citation that proves it is alive |
| --- | --- |
| `findCardById` in `ui/play-card.js` | Called from `rerenderCard` (an in-place flip handler). |
| `.animate-fade` (without `Up`) | Not dead — it simply does not exist. `grep -n "animate-fade" styles.css` only returns `.animate-fadeUp`. Earlier audit pass had this listed as a dead class, but there is nothing to delete. |

---

## 8. Inconsistencies — fonts, inline styles, design tokens

### 8.1 Typography map

**Updated 2026-08-30.** The design now has **three** families, not four: `--font-display` was collapsed into an alias of `--font-polaroid`, so display and polaroid captions are one face.

| Role | Token | Family | Where it lives | Where it's used |
| --- | --- | --- | --- | --- |
| Body / chrome | `--font-sans` | Geist | Default `body` | Buttons, list rows, meta text, profile body |
| Display / headings | `--font-display` → `var(--font-polaroid)` | Fraunces | `.font-display` | Profile names, game-detail name, chapter titles, day dividers, stat values, sheet titles |
| Polaroid surfaces | `--font-polaroid` | Fraunces | `.game-polaroid__name`, `.play-card__caption-name`, `.play-card__back-title`, `.guide-text` body | The polaroid family of cards |
| Scoring | `--font-score` | JetBrains Mono | `.scoring-table`, `.scoring-cell`, `.play-card__back-player-score`, `.play-detail__player-score` | Every numeric score and session code (tabular numerals) |
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
| `views/play-flow-view.js:2717` | `--exp-color` | expansion's source color — **resolved,** see below |
| `widgets/play-detail-popup.js:260` | `--exp-color` | expansion's source color — **resolved,** see below |

**Verdict: legitimate uses.** Per-game and per-expansion accent colors are data; they must be set per-instance.

**Resolved in Pass 5** for the two `--exp-color` sites: they emit no `style` attribute at all when the expansion has no colour, so the CSS fallback already present at every consumer (`var(--exp-color, var(--accent))`, and `var(--exp-color, var(--accent-on-paper))` on the parchment) governs instead. That makes the default travel with the token rather than being frozen at a value that is neither theme's accent. The colour is now run through `escapeAttr` on the way in, which also closes a small CSS-injection hole — it was written raw into a `style` attribute.

Still open: `ui/game-card.js:20` and `domain/game.js:150` carry the same literal for `--game-accent`, a different token with its own `:root` default (`#6B3FA0`). See §8.3.

### 8.3 Design token coverage

**Updated for the two-theme system.** Tokens are no longer one `:root` block. They are three, in this order (`styles.css`, top of file):

1. `:root` — theme-**independent** values only: layout heights, `scroll-padding-top`, the three type families, the spacing and radius scales, `--ease`, and `--ghost-ink` (which is theme-independent precisely because it sits on paper, and paper is light in both themes).
2. `:root, :root[data-bgb="dark"]` — the dark palette, which is also the default.
3. `:root[data-bgb="light"]` — the light palette.

Then the `--polaroid-*` alias family at `:root`, pointed at the paper tokens, and the theme-agnostic chrome re-point. See `ARCHITECTURE.md` §4.2 / §4.2a for the full table and the rules.

**Auditing rule:** a colour declared outside blocks 2 and 3 is a claim that it is correct in *both* themes. Most such claims are wrong. Check for them by grepping for `#` and `rgba(` between the end of the light block and the end of the file.

Open items:

- **`--game-accent` has a `:root` default of `#6B3FA0`.** The live overrides set by JS (`ui/game-card.js`, `ui/play-card.js`) use the game's `theme_color`, so the default purple is a placeholder; a card rendering without an inline override would be purple, which no surface wants. Either point it at `var(--polaroid-accent)` or remove the default to force callers to supply one.
- ~~**Hex literals in JS**: `views/play-flow-view.js` and `widgets/play-detail-popup.js` both carry `"#C9922A"`.~~ **Resolved in Pass 5** — both now fall through to the CSS token fallback. The `--game-accent` literals in `ui/game-card.js:20` and `domain/game.js:150` remain, and are a separate change: different token, different default.

Otherwise tokens are used consistently. The cascade flow has its own derived token `--cascade-bottom-pad`, which is the right pattern: derive an offset by `calc()` from the height tokens rather than restating a measurement. `--warm-taupe`, `--rust` and `--warm-gray-mid` are used widely across guide chrome, destructive buttons and inactive toggles respectively.

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

---

## Cleanup log

### Pass 1 (initial audit) — 2026-05-23
Inventory only; no code changes.

### Pass 2 (cleanup) — 2026-05-23

**JS removed:**
- `renderGameCard` function from `ui/game-card.js` (and its `window` assignment).
- Whole file `ui/buddies-panel.js` (was 483 lines; the live `views/buddies-view.js` keeps the route).
- `<script src="ui/buddies-panel.js">` tag from `index.html`.

**HTML / JS migrated to single source of truth:**
- `index.html` global-header avatar placeholder now uses `<span class="user-badge user-badge--sm">` instead of `.avatar-bubble--me`.
- `init.js#syncGlobalAvatar` rewritten to render via `BgbBadge.render` for **both** signed-out and signed-in states. The legacy `el.className = "avatar-bubble avatar-bubble--me"` reset path is gone.

**CSS removed:**

| Block | Approximate former lines |
| --- | --- |
| `.bgb-filter-panel` | 7 lines |
| `.shelf__*`, `.skeleton-book`, `@keyframes skeleton-shimmer`, `.book-slot`, `.book-spine*`, `@keyframes pullDown`, `.book-hint*`, `.closet-*`, `.book-spine__exp*` | ~260 lines |
| `.swipe-wrap`, `.swipe-hint*` | ~38 lines |
| `.card-anatomy*` and its `@media (min-width: 480px)` companion | ~46 lines |
| `.admin-tool*` cluster | 26 lines |
| Duplicate `.avatar-bubble` + `.avatar-bubble--xs` block | 21 lines |
| Surviving `.avatar-bubble` family (`.avatar-bubble`, `--lg`, `--md`, `--xs`, `--me`, `.bgb-global-header__avatar .avatar-bubble*`) | ~70 lines |
| Union selectors that joined `.avatar-bubble` with `.user-badge` in the header | 8 lines |

**Net effect on `styles.css`:** 7,664 lines → 7,145 lines (519 lines removed, ~6.8%).

**Visual intent preserved:** The legacy `.avatar-bubble--me` gold-radial-coin treatment was a placeholder-only look on the brief pre-hydration "?" — after hydration, `BgbBadge.render` always rendered `.user-badge--me`. The gold rim on the dark header is now provided by `.bgb-global-header__avatar .user-badge--me` (`styles.css`), so the "me" badge still has its border. The subtle `.user-badge--me` self-highlight ring (defined in `styles.css:7384`-ish) is unchanged.

**Verification commands run after cleanup:**

```
grep -rn "renderGameCard|BuddiesPanel|buddies-panel|avatar-bubble" projects/boardgame-buddy/web   # → 0 matches
grep -rnE "admin-tool|bgb-filter-panel|book-(slot|spine|hint)|closet-|shelf__|swipe-(wrap|hint)|card-anatomy" projects/boardgame-buddy/web   # → 0 matches
wc -l projects/boardgame-buddy/web/styles.css   # → 7145
```

**Not addressed in this pass (tracked for future work):**
- The six bespoke game-tile implementations (`.collection-tile`, `.hot-game-tile`, `.preview-card__cover`, `.game-detail__polaroid`, `.plays-list__thumb`, `.game-polaroid`) remain. Consolidating them is a design decision, not a mechanical refactor; see §6 row 1 and the OOD architecture doc (`Docs/ARCHITECTURE.md`).
- `renderStatusTag` option-shape inconsistency (`compact: true` vs `size: "xs"`). Trivial refactor; out of scope here.
- `.plays-list__row` typography mismatch with the polaroid family. Design decision required.
- `PlayDetailPopup` is its own modal rather than a `PolaroidPopup`. Larger refactor.


---

## 9. Second cleanup pass — 2026-08-20

A repo-wide dead-code sweep across all three tiers. Frontend portion:

**Deleted modules** (globals with zero readers): `domain/status.js`
(`window.Status` — its ICON/LABEL/CYCLE maps are independently re-declared in
`ui/status-tag.js`, which is what actually renders status pills) and
`domain/search.js` (`window.Search` — views call `window.api.get("/search")`
directly). Both `<script>` tags removed from `index.html`.

**Deleted globals**: `bggImg`, `playerRange`, `formatTime`, the `window.showView`
legacy shim, and the `window.Router` / `window.StatusPicker` /
`window.renderScoringHead` exports (each class or function is used only via its
singleton or internally in the same file). `MAX_PHOTO_BYTES` was flagged by the
audit tooling but is live at `helpers.js:200` and was kept.

**Deleted statics**: `Bgg.processPending`, `Collection.updateStatus`,
`Collection.statusFor`, `Game.fromRaw`, `Game.fetch`, `PlaySession.abandonLobby`,
`Stats.format`.

**Dead CSS**: `styles.css` went 7988 → 6554 lines (~18%). Removal was done per
*selector*, not per rule, so shared rules kept their live selectors. Dynamically
built class names were held back explicitly: `.status-tag--{status}`,
`.user-badge--{size}`, `.bgg-log__step--{state}`, `.play-card--strip is-{orient}`.
Also removed a duplicate `@keyframes fadeIn` and six unread custom properties.

**Helper consolidation**: `helpers.js` had no HTML escaper, so 26 modules each
carried their own copy plus 18 `escapeAttr` aliases — 49 definitions, now one.
This also fixed a latent bug: five local `jsStr` shadows had drifted from the
canonical version, three of them omitting the `\n` escape, so a newline in a
value interpolated into an inline `onclick` broke the handler in those modules.

**A real bug, fixed**: `Collection.removeByGame` called
`DELETE /collection/by-game/{id}`, a route that does not exist. Clearing a game's
status from the tile picker always 404'd. It now calls `DELETE /collection/{id}`,
which already keys on `(user_id, game_id)`.

### Still open after this pass

The consolidation work in §6 was deliberately left alone — it carries
visual-regression risk across many screens and deserves its own change:

- **Six bespoke game tiles** (unchanged from §6 — all six were re-verified as
  live in this pass): `.collection-tile`, `.hot-game-tile`, `.preview-card__cover`,
  `.game-detail__polaroid`, `.plays-list__thumb`, `.game-polaroid`.
  `renderGamePolaroid` (`ui/game-card.js`) is used exactly once, by the Gather
  grid. Two of the six are outright copy-paste: `.collection-tile` is duplicated
  between `views/collection-view.js` and `views/wishlist-view.js`, and
  `.hot-game-tile` is duplicated *within* `views/feed-view.js` at two call sites.
  The native tier is the healthier model — `components/GameTile.js` is one
  component used everywhere. Fold the web side onto a single
  `renderGameTile(game, { variant })`.
- **`renderStatusTag` still takes three option shapes** (`{size:"xs"}`,
  `{size:"lg", addLabel}`, `{compact:true}`), two of which produce the same
  visual outcome. Collapse to a single `size` scale.
- **`.plays-list__row` still sidesteps the polaroid family** — same record as the
  feed's play cards, different idiom and different font. Decide whether the
  chronological log should render through `renderPlayCard`.
- **Two affordances for one destination**: `PlayDetailPopup` opens from a
  maximize button on a play card, but from a full-row tap in the plays list.

### Pass 3 (feed card rework) — 2026-08-29

Scope was the feed's play card, but two of the changes are app-wide.

**The status picker is now a bottom sheet.** `StatusPicker` in `ui/status-tag.js`
was a body-level popover positioned under whichever chip opened it. Both the chip
(24×24) and its rows (~30px) were under the 44×44 floor in
`.claude/rules/web-frontend.md`, and on a play card the popover landed near the
top of the screen. It rides the shared `.polaroid-popup__backdrop` chrome now,
bottom-anchored, with 56px radio rows — one surface for all seven
`renderStatusTag` call sites, per §3b/§3c. Three behaviour changes came with it:
the current status is listed and checked rather than omitted; `played` renders as
a read-only note (it is derived from logged plays, so there is no row to set); and
the write is optimistic with a rollback, replacing a UI that waited on the round
trip. The two bare `alert()` calls went to `PolaroidPopup.alert`.

**CSS removed:**
- `.status-picker` / `.status-picker__opt` / `--danger` (was `styles.css:3063–3090`).
- `.play-card__status-overlay` — the pill left the photo corner for the caption.
- Every `.has-long-meta` rule — the winner has its own caption row now, so the
  post-paint fit pass has nothing to decide.

**JS removed** (all in `ui/play-card.js`, all supporting the one-row caption):
`fitCaption`, `scheduleCaptionFit`, `captionFitQueued`, `stripTags`, the
`longThreshold` character-count guess, the `resize` listener and the
`document.fonts.ready` hook.

**Two positioning bugs of the same shape, fixed:** the expansion-count chip and
(previously) the status chip are absolutely positioned but were emitted as
siblings of the whole tile, so they resolved against the tile — whose
bottom-right is the title row. Collection and wishlist tiles gained a
`.collection-tile__art` host; `renderGamePolaroid` moved `badgeHtml` inside
`.game-polaroid__photo`, which also fixed the feed's hot-games rail.

**Still open, unchanged by this pass:** everything under "Still open after this
pass" above. Note that `renderStatusTag`'s option shapes grew rather than
shrank — `size: "sm-row"` joins `xs` / `lg` / `compact` for the pill on the
card's cream ground. The collapse to a single scale is still owed.

**Known web/native drift:** `app/src/components/PlayCard.js` has no status
control and a fixed 180px photo. It does not track this rework.

### Pass 4 (theme system + sheet system) — 2026-08-30

Two app-wide systems landed across ~40 commits. Both are now written up
properly in `Docs/ARCHITECTURE.md` §4 and generalized to the repo in
`.claude/rules/theming.md` and `.claude/rules/overlays.md`; this entry records
what moved and what was deleted.

**Light and dark became two first-class themes.** The lever is `data-bgb` on
`<html>`, set by a pre-paint inline script in `index.html` and owned thereafter
by `domain/theme.js`. `data-theme="luxury"` stays frozen — it is DaisyUI's
attribute, not ours. The palette split into three blocks (theme-independent
scales, dark, light), and `--b1/--b2/--b3/--bc` are overridden per theme, which
is what re-themed the ~158 rules painting with `oklch(var(--b*))` without
touching one of them.

Auto is the *absence* of a stored key rather than a third stored value, so
Settings needed a three-way segmented control instead of a toggle. Following
the OS turned out to need more than a `change` listener: WebKit does not
deliver media-query changes to a frozen or bfcached page, so appearance flipped
while the app was backgrounded never arrived. `domain/theme.js` re-derives on
`visibilitychange`, `pageshow` and `focus` instead, and holds its
`MediaQueryList` at module scope because a list held only in a function local
can be GC'd in WebKit while its listener is still registered.

**The third surface kind got a name.** Ground / paper / chrome, and the rule
that paper is light in *both* themes because photo paper is light in any light.
Five screens plus the profile hub had been borrowing the paper tokens, which
made the brightest surfaces in the app the ones furthest from its dark
identity.

**CSS removed / renamed in the theme work:**
- `.bgb-cream-screen` → `.bgb-spoke-screen`, 67 selectors plus 5 in
  `index.html`. The class had outlived the cream sheet it was named for.
- `--sheet-bg` deleted — transparent in both themes, so the declaration reading
  it was a no-op. `--sheet-ink` stays; it is not redundant with the inherited
  foreground.
- The whole `--chrome / --chrome-line / --chrome-emboss / --chrome-ok` family
  deleted, replaced by the theme-agnostic re-point. One stale comment reference
  survives in `styles.css` and is worth sweeping.
- Three overlapping dark-only re-point blocks at identical specificity (0,3,0)
  collapsed into one theme-agnostic block, net −120 lines. They had been
  rendering the profile screens at three different card tones with `--ok`
  defined twice in two different greens. **This is the lesson of the pass:** a
  dark-only branch is what let them drift; only genuinely per-theme values
  belong inside `[data-bgb="dark"]`.
- `.bgb-destructive-icon-btn` fixed — a bare class losing on specificity to
  `.bgb-cream-screen .btn.btn-ghost`, so remove-buddy's X had been rendering in
  ordinary ink on every spoke, in both themes. Its companion `i` rule was
  separately dead: `BgbIcons` swaps the `<i>` for an `<svg>`, so only the
  button's own colour reaches the glyph via `currentColor`.

**Bottom sheets replaced in-screen dropdowns.** `ui/bottom-sheet.js` was
extracted when the status sheet stopped being the only one, per
`.claude/rules/ui-object-design.md` §4. It owns the lifecycle only — body-level
creation, scroll lock, delegated clicks, capture-phase Escape with an
`onEscape` first-refusal hook, guarded focus return, close animation, orphan
teardown — and nothing about appearance. Four consumers: the status sheet
(`ui/status-tag.js`, its own chrome, deliberately paper in both themes), the
Stats by-game picker, and both Gather pickers.

When the panel chrome repeated a third time it was promoted from
`.game-picker__*` to a shared `.bgb-sheet__*` family rather than copied again.

**Deleted with the Gather dropdowns:** the `.cascade-buddy-*` CSS family and
five combo handlers in `views/play-flow-view.js`. `ui/dropdown-fit.js` survives
only for the finder in `.add-game-modal` and any finder mounted without
`inlineDropdown` — its whole reason for existing was to keep absolute dropdowns
on screen, and a sheet does not need it.

**Behaviour changes worth knowing:** the player picker is multi-select with one
confirm (a game night is a set of people, not one person picked five times),
tick order is preserved because the roster array *is* the scoring grid's column
order, and a typed name with no match gets an explicit "add as a guest" row —
the old dropdown hid itself on zero matches, which made the guest path
invisible unless you already knew Enter would do it.

**Two cross-cutting fixes the sheets forced out:**
- A panel ceiling in `vh` is a bug. `vh` is the layout viewport, which the
  software keyboard does not shrink, while the backdrop tracks `--bgb-vv-h`,
  which does — and with `align-items: flex-end` the overhang goes off the
  **top**, carrying the title and the search field with it. Measured at 390×844
  with a 364px keyboard: a 683px panel in a 480px box, overhanging 203px.
- The anti-jump list pin is written as a custom property rather than an inline
  `min-height`, so a `.bgb-kb-open` rule can drop it without an `!important`
  fight against inline style.

**Still open after this pass:** everything under "Still open after this pass"
above — the six bespoke game tiles, `renderStatusTag`'s four option shapes,
`.plays-list__row` sidestepping the polaroid family, and the two affordances
for `PlayDetailPopup`. Newly noted: four centred modals
(`play-detail-popup`, `outbox-modal`, `add-game-modal`,
`import-expansions-modal`) each re-implement `_previousFocus`, `_escHandler`
and singleton-by-id — instance #4 of a lifecycle `ui/bottom-sheet.js` already
solves. And the two `"#C9922A"` hex literals in JS (§8.3) are now doubly wrong:
that value is neither theme's `--accent`.

### Pass 5 (the play cascade joins the ground) — 2026-08-30

The cascade — Gather → Play → Settle Up, and the spectator's mirror — was the
last place in the app still handing the user a cream sheet in dark. It was never
an oversight in one rule: `.cascade-card` and ~50 siblings paint with
`--polaroid-*`, and Pass 4 deliberately left them there, with a comment saying
so. This pass decides they are UI, not photographs.

It is a **net deletion**, because the interesting part was not the re-point:

- **Two byte-identical `.scoring-*` override blocks deleted**, not edited. The
  grid renders on paper (the play-detail popup) and, after this, on chrome — so
  it had been re-skinned twice, once per view, and the popup's copy said
  outright that it "mirrors the `.cascade-card--scoring` overrides above". The
  base family now reads the *surface's* alias family per
  `.claude/rules/ui-object-design.md` §2, so it travels and neither copy is
  needed. `.play-mode-*` lost a third such block the same way. The base rules
  they shadowed had been dead on arrival — they only applied where neither
  override landed, which was nowhere.
- **`--paper*` stopped being re-pointed.** Exactly one rule in 9700 lines read
  it directly. Removing it from the chrome block is what makes a paper island
  expressible at all: `--paper*` is the real thing, `--polaroid-*` is the alias
  a chrome surface moves, and an island restores by pointing one back at the
  other. Written up in `ARCHITECTURE.md` §4.2b.
- **`.cascade-player--drag-clone` was escaping to `<body>`.** Same class of bug
  as the picker sheets in Pass 4 — `widgets/player-reorder.js` appends the clone
  to the body, so it left the screen it was lifted out of and kept the root
  paper aliases. Dragging a player in Gather would have raised a cream row out
  of an espresso list. It is now named in the re-point list, and the comment
  there asks for the next body-level *clone or popup*, not just the next sheet.
- **The parchment had to be made safe before it could be nested.**
  `.scroll-panel` is self-contained except for one rule: chapter links read
  `--accent-ink`, which the dark branch lifts to `var(--accent)` — 1.6:1 on
  parchment. Hoisted to `--accent-on-paper`, which nothing re-points.

Fixed on the way, each a pre-existing defect the re-point would otherwise have
carried forward or hidden:

- `.cascade-screen__title` / `.cascade-back-row__title` read `var(--polaroid-bg)`
  as **ink**. In light that is `#FFFFFF` on the `#F7F0E1` ground — 1.16:1. The
  three cascade headings and the Game Explorer's back-row title were invisible
  in light mode. Now 14.17:1.
- `.coop-outcome-*` painted with the DaisyUI base while rendering inside the
  cream scoring card: a near-black block on the scorepad in dark. Its neighbour
  `.play-mode-opt` had a paper override; this never did.
- `.cascade-player__grip` used `--polaroid-line` — a hairline — as ink, at
  1.2:1 on the row it is drawn on.
- `.session-viewer__host-tag` used `--accent` inside a player row: 1.96:1 dark.
- `.cascade-rulebook-cta` is a bare DaisyUI `.btn-outline` with no project CSS,
  so it painted cream ink on the cream card. Invisible in dark; fixed for free
  by the re-point.
- `.scoring-add-round` now sets `background: transparent` explicitly rather than
  leaning on `.btn-ghost`: a `<button>` with no background paints the UA's
  `buttonface`, which follows `color-scheme` — a dark block on a cream card.
- Four `#b4472b`, three `#fff`-on-`--accent` (4.1:1 in light), six
  `rgba(255,251,241,…)` washes and five `rgba(0,0,0,…)` shadows became tokens.

Verified by rendering `styles.css` headless in both themes and diffing computed
styles against `HEAD`: no change on any surface this pass did not intend to
touch (the five spokes, `[data-view="log-play"]`, the Stats and Collection
sheets, the status sheet, the play card, the game polaroid, the add-game modal,
the parchment). Every pair moved clears 4.5:1 in both themes.

### Still open after Pass 5

- **`--polaroid-accent` is `var(--win)`, and `--win` is tuned for the ground.**
  At its dark root value `#C8553D` it is 3.90:1 on `--paper`. That affects
  `.scoring-total` in the popup, `.cascade-invite__code`, the play card's winner
  ink and ~9 other rules. Paper is light in both themes, so this alias should be
  theme-independent the way `--ghost-ink` is; `#A8452F` takes all of them to
  ≥5.29. Its own change.
- **The parchment's chapter links are 4.30:1 mid-gradient, 3.90:1 at the darkest
  corner.** Unchanged by Pass 5 — `--accent-on-paper` carries exactly the value
  `--accent-ink` had — and left alone deliberately, with the rest of the scroll.
