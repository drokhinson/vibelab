# Day WordPlay Web UI Audit

A consistency audit of `projects/daywordplay/web/`. Every claim cites code as `path:line` so each finding can be jumped to and verified. The scope is the web frontend only; the React Native app under `app/` and the FastAPI routes under `shared-backend/routes/daywordplay/` are out of scope.

> **Status:** Original audit produced 2026-05-25. **Cleanup pass applied 2026-05-25**: dead `web/app.js` removed, dead exports stripped from `groups.js`, 13 verified-dead CSS class families deleted, and 3 duplicate CSS blocks consolidated. See "Cleanup log" at the bottom for the exact diff.

---

## 1. Executive summary

The daywordplay web codebase is small (13 JS files + `styles.css` + `index.html`, ~4,500 lines total) and is flat at `web/` root (no `domain/` / `ui/` / `views/` / `widgets/` split per `.claude/rules/ui-object-design.md` §6 — defensible at this size). It has three core domain objects (Word, Sentence, Group) and the OOD discipline is mixed:

1. **Word — mostly canonical.** `renderWordDisplay(word)` (`home.js:204`) is the hero presentation, reused on both home sub-tabs. The Dictionary list and Admin proposal rows render their own word headers inline — for the dictionary this is a defensible density tradeoff (list vs hero); for the admin proposal it is a one-off that should reuse `renderWordDisplay`. See §5a.
2. **Sentence — four parallel presentations, no canonical.** A "Sentence" is rendered four distinct ways: vote card (`renderSentenceCard`, `vote.js:50`), submitted card (inline in `renderSentenceSection`, `home.js:226-233`), dict-winning and dict-my-sentence blocks (inline in `renderDictCard`, `dictionary.js:88-106`), and reusable-pill (`renderReusablePills`, `home.js:34-67`). Only the `<span class="word-highlight">` atom (`styles.css:1267-1272`, applied via `highlightWord` `helpers.js:84`) is shared across all four — the surrounding chrome is bespoke per surface. See §5b.
3. **Group — six presentations across the app; two are dead.** Live: `renderGroupSwitcher` (chip row, `home.js:191`), `renderBrowseGroupCard` (search result, `home.js:495`), `renderProfileGroupCard` (swipe card, `profile.js:61`), `renderAdminGroupRow` (admin card, `admin.js:76`). Dead: `renderMyGroupCard` + `renderDiscoveryGroupCard` (`groups.js:57, 70`) plus `renderGroupsView` (`groups.js:20`) — `renderCurrentPage` (`helpers.js:224-233`) has no `'groups'` case so the whole route renderer is unreachable. See §5c and §7.

Smaller findings:

- **Destructive actions** — 4 `confirm()` + 4 `alert()` + 1 `prompt()`, all browser-native dialogs. **Compliant with `.claude/rules/web-frontend.md`** "pick one confirmation surface and use it everywhere." See §7.
- **Auth UI** — daywordplay IS the canonical reference cited by `.claude/rules/auth-ui.md` (`auth.js:96-122` + `styles.css:969-1010`). Other apps copy from here. Nothing to change. See §9.
- **Design tokens** — `styles.css:3-26` declares a clean `:root` palette (`--bg`, `--bg-card`, `--text-*`, `--accent`, `--accent-light`, `--accent-hover`, `--border`, `--shadow`, `--radius`, `--radius-sm`, `--tab-h`, `--header-h`). Two gaps: medal colors (`#C8A84B` gold, `#A0A0A8` silver, `#B07A50` bronze) and danger reds (`#dc3545`, `#E53935`) are hardcoded at multiple sites. See §8.3.
- **Typography** — Playfair Display (display) + Inter (chrome). Clean separation, no fragmentation. One legitimate per-data outlier: `'Courier New', monospace` on `.group-code-badge` (`styles.css:541`) for the 4-letter join codes. See §8.1.
- **Dead code at cleanup time**: full `web/app.js` (a 56-line scaffold leftover from `scaffold.sh` template, not in `index.html` script tags), 6 dead exports + 3 dead state vars in `groups.js`, 13 dead CSS class families, and 3 duplicate-defined modal CSS blocks. All deleted in cleanup. See §7 + Cleanup log.

---

## 2. Screens & routes

The app is a single-page shell. `index.html:15` contains a single `<div id="root">`; `renderApp()` (`helpers.js:104`) rebuilds `root.innerHTML` from `renderShell()` (`helpers.js:117`) on every state change. Navigation dispatcher is `renderCurrentPage()` (`helpers.js:224-233`), which switches on the `currentView` global.

| Route (`currentView`) | Renderer | File:line | How user reaches it | Primary content |
| --- | --- | --- | --- | --- |
| `home` | `renderHomeView` | `home.js:97` | Bottom-nav center "Word" (default after boot) | Group switcher chips + two sub-tabs (today / vote) |
| `dictionary` | `renderDictionaryView` | `dictionary.js:21` | Bottom-nav left "Dictionary" | Alphabetical Word list with Played / All filter + "Propose word" modal |
| `leaderboard` | `renderLeaderboardView` | `leaderboard.js:24` | Bottom-nav right "Stats" | Group switcher + group-name/code header + ranked player list |
| `profile` | `renderProfileView` | `profile.js:3` | Top-right settings button (`#profile-btn`) | Avatar + stats + group list (swipe to share / leave) + logout + admin entry |
| `admin` | `renderAdminView` | `admin.js:27` | Profile → "Admin" link (gated by admin key prompt) | Add Word form + pending proposals list + all-groups list |

There is also a 6th screen — the **auth screen** — at `renderAuthScreen` (`auth.js:92`), which `renderApp` (`helpers.js:108-110`) renders instead of the shell when `currentUser` is null.

Within the home view, two sub-tabs are rendered by `renderWordTabs` (`home.js:70-77`) and dispatched via the `activeWordTab` global (`home.js:105`):

| Sub-tab (`activeWordTab`) | Renderer | File:line | Content |
| --- | --- | --- | --- |
| `today` | `renderTodayTab` | `home.js:109` | `renderWordDisplay` + `renderEtymologyCard` + `renderSentenceSection` (submit-or-submitted) |
| `vote` | `renderVoteTab` | `home.js:128` | `renderWordDisplay` + vote date + grid of `renderSentenceCard` |

There is **no `groups` route** — the `groups.js` file's `renderGroupsView` (line 20) is never invoked. Group operations live inside the profile view (`profile.js:36-46` lists my groups) and the home no-group prompt (`home.js:158-184` offers browse / join / create).

Three modals are mounted into shared overlay containers and toggled via global booleans:

| Modal | Renderer | Triggered from | Lives in |
| --- | --- | --- | --- |
| Join group (4-letter code) | `renderJoinModal` (`groups.js:86`) | home no-group prompt + profile + (dead) groups view | `showJoinGroupModal` global |
| Create group | `renderCreateModal` (`groups.js:105`) | home no-group prompt + profile + (dead) groups view | `showCreateGroupModal` global |
| Propose word | `renderProposeModal` (`dictionary.js:111`) | "+ Propose word" button on dictionary header | `#propose-modal-container` div |
| How to play | `renderHelpModal` (`helpers.js:147`) | Top-left help button (`#help-btn`) | Injected via `document.body.insertAdjacentHTML` in `init.js:135` |

Bottom navigation (`renderTabBar`, `helpers.js:187-208`) is hard-coded to three tabs (Dictionary, Word, Stats). The top header (`renderTopHeader`, `helpers.js:129-145`) is fixed: help button on the left, "Day WordPlay" wordmark center, settings/avatar button right.

---

## 3. Reusable components

Components are global functions attached via implicit `<script>`-tag scope (no module system). Counts in this section are produced by grepping each name across `*.js` and `*.html` files; each row is exact (definition site is excluded from the call-site count).

### 3.1 `renderWordDisplay` — `home.js:204`

- **Returns:** HTML string (a `<div class="word-display">`).
- **Reuse count: 2 external call sites.** `home.js:117` (today tab), `home.js:149` (vote tab).
- **Visual style:** Centered hero with Playfair Display 700 at clamp(2.4rem, 10vw, 3.2rem) for the word, italic POS prefix, definition body. CSS at `styles.css:283-310`.
- **Object:** Word.
- **Note:** This is the **closest daywordplay has to a canonical "object → component" mapping.** It reads `word.word`, `word.part_of_speech`, `word.definition` — the exact shape returned by `/groups/{id}/today` and `/groups/{id}/yesterday`. The Dictionary surface deliberately bypasses it (see §5a).

### 3.2 `renderEtymologyCard` — `home.js:216`

- **Returns:** HTML string (a `<div class="etymology-card">`).
- **Reuse count: 1 external call site.** `home.js:118` (today tab only, conditional on `word.etymology`).
- **Visual style:** Tan card with "Etymology:" bold label + body text. CSS at `styles.css:421-431`.
- **Object:** Word (etymology field).
- **Inconsistency:** Dictionary renders the same field inline at `dictionary.js:87` as `<div class="dict-def" style="font-size:13px; color:var(--text-muted); margin-top:8px;"><strong>Origin:</strong> ${escHtml(w.etymology)}</div>` — different label ("Origin" vs "Etymology"), different surface chrome, inline styles instead of a class. Should reuse the etymology card or be unified under a single Word-etymology component.

### 3.3 `renderSentenceCard` — `vote.js:50`

- **Returns:** HTML string (a `<div class="sentence-card ...">`).
- **Reuse count: 1 external call site.** `home.js:152` (vote sub-tab, mapped over `sentences`).
- **Visual style:** Beige card with italic sentence quote + author chip + thumbs-up vote button. Modifier classes: `.voted` (teal border) or `.winner` (gold border + cream background). CSS at `styles.css:448-504`.
- **Object:** Sentence (vote-flow variant).
- **Opts shape:** `(sentence, has_voted, maxVotes, wordText)` — positional, no opts object. The `has_voted` flag drives whether author names are revealed and whether the vote button is disabled. See §5b for the inconsistency this creates.

### 3.4 `renderSentenceSection` — `home.js:224`

- **Returns:** HTML string. Two variants:
  - `submitted=true`: a `<div class="submitted-card">` with checkmark, heading "Your sentence for today", quoted sentence with `highlightWord`, "come back tomorrow" subtitle. `home.js:226-233`.
  - `submitted=false`: a `<div class="sentence-section">` with H3 label, `renderReusablePills`, textarea, submit row. `home.js:242-256`.
- **Reuse count: 1 external call site.** `home.js:121` (today tab).
- **Visual style:** Submitted state uses `.submitted-card` + `.submitted-sentence-text` (cream pill with italic body). CSS at `styles.css:396-418`.
- **Object:** Sentence (submitted-confirmation variant) + composition affordance.
- **Inconsistency:** The "submitted" branch is the only place in the app where a Sentence the user just wrote is shown back to them; the same record is later shown in `renderSentenceCard` (vote tab) and `renderDictCard` (dictionary) — three different surfaces, no shared base. See §5b.

### 3.5 `renderReusablePills` — `home.js:34`

- **Returns:** HTML string (a `<div class="reusable-sentences">` with N `<button class="reusable-pill">` children).
- **Reuse count: 1 external call site.** `home.js:246` (inside `renderSentenceSection`, only when the user hasn't yet submitted and they have past sentences from other groups for today's word).
- **Visual style:** Tinted teal container holding white pill buttons; each pill contains the past sentence text (with the daily word highlighted) plus a "from {group names}" attribution. CSS at `styles.css:1215-1264`.
- **Object:** Sentence (reusable-suggestion variant).
- **Note:** This is the **fourth** distinct Sentence presentation in the app — a tappable suggestion that, when clicked, populates the textarea (`home.js:330-340`). It shares only the `.word-highlight` atom with the other three. See §5b.

### 3.6 `renderDictCard` — `dictionary.js:79`

- **Returns:** HTML string (a `<div class="dict-card">`).
- **Reuse count: 1 external call site.** `dictionary.js:66` (mapped per word inside `renderDictionaryAlpha`).
- **Visual style:** Cream card with Word header (`.dict-word` in Playfair Display 1.5rem) + italic POS + definition body + optional "Origin" line + two optional sub-blocks:
  - `.dict-my-sentence` (teal-tinted, `styles.css:1372-1389`) — shown when the user submitted a sentence for this word AND didn't win.
  - `.dict-winning-sentence` (border-top divider) OR `.dict-winning-mine` (gold gradient, `styles.css:717-726`) — shown when there is a winning sentence; gold variant when the viewer's sentence won.
- **Object:** Word (list-view density) + 2 Sentence sub-presentations.
- **Inconsistency:** This card inlines its own Word presentation (`.dict-word` + `.dict-pos` + `.dict-def`) instead of reusing `renderWordDisplay`. **Defensible** — a 1-per-word hero in a long alphabetical list would be too tall — but the divergence is unowned. A `renderWordDisplay(word, { variant: 'hero' | 'card' })` would let the list reuse the canonical component at lower density.

### 3.7 `renderGroupSwitcher` — `home.js:191`

- **Returns:** HTML string (a `<div class="group-switcher">` of `<button class="group-chip">`s).
- **Reuse count: 2 external call sites.** `home.js:103` (home view, above the word-tabs), `leaderboard.js:28` (leaderboard view, above the section header).
- **Visual style:** Horizontal scrolling row of pills; active group has a dark border + tinted background. CSS at `styles.css:1135-1159`.
- **Object:** Group (selector variant — name only, no code, no actions).
- **Behavior:** Tap a chip → swap `activeGroupId` and re-fetch the destination view's data. Bound by `data-group-switch="{groupId}"` handlers in `home.js:278` and `leaderboard.js:78`.
- **Note:** Only rendered when `myGroups.length > 1` (`home.js:192`). Single-group users never see chips.

### 3.8 `renderBrowseGroupCard` — `home.js:495`

- **Returns:** HTML string (a `<div class="group-card">`).
- **Reuse count: 1 external call site.** `home.js:488` (no-group browse panel results).
- **Visual style:** Beige row card with group name + member count + right-slot action: `<span class="browse-status joined">` (already member) / `<span class="browse-status pending">` (request pending) / `<button class="join-btn" data-request-join>` (otherwise).
- **Object:** Group (discovery + request-to-join semantic).
- **Inconsistency:** The "joined / pending / Request to Join" tri-state action slot is unique to this surface. The discovery card in the (dead) `groups.js:70` had a binary "Joined" / "Join" affordance with no request flow — implying the request-to-join was added as a feature and the parallel implementation got abandoned. See §5c.

### 3.9 `renderProfileGroupCard` — `profile.js:61`

- **Returns:** HTML string (a `<div class="swipe-card-wrap">` wrapping a `<div class="group-card swipe-card">`).
- **Reuse count: 1 external call site.** `profile.js:41` (mapped over `myGroups`).
- **Visual style:** Same `.group-card` chrome as the browse card, but wrapped in a swipe-action container. Swipe-left reveals red "Leave" action (`profile.js:259-263` → `leaveGroup`); swipe-right copies an invite link and triggers Web Share (`profile.js:249-258`). CSS at `styles.css:1170-1212`.
- **Object:** Group (member-list-with-actions variant).
- **Inconsistency:** Doesn't show member count (browse does); shows code badge (browse doesn't). See §5c.

### 3.10 `renderAdminGroupRow` — `admin.js:76`

- **Returns:** HTML string (a `<div class="card">`).
- **Reuse count: 1 external call site.** `admin.js:97` (mapped over `groups` after `adminFetch('/admin/groups')`).
- **Visual style:** Plain `.card` (`styles.css:1475-1480`) with group name, code + member count subline, full-width red Delete button (`.danger-btn`).
- **Object:** Group (admin-CRUD variant).
- **Inconsistency:** Uses the generic `.card` family instead of `.group-card`, so it visually diverges from the browse/profile cards. The card lacks the row-card hover-lift treatment. See §5c.

### 3.11 `renderAdminProposalRow` — `admin.js:105`

- **Returns:** HTML string (a `<div class="card">`).
- **Reuse count: 1 external call site.** `admin.js:138` (mapped over `proposals` after `adminFetch('/admin/proposed-words')`).
- **Visual style:** Plain `.card` with **inline-styled** Word header (`<div style="font-weight:700; font-size:15px;">`), POS subline, definition body, optional etymology, two action buttons (Approve / Reject). All typography is inline-styled rather than using shared classes.
- **Object:** Word (admin moderation variant).
- **Inconsistency:** This is the **single largest in-app divergence from canonical Word presentation.** Both the heading style (font-weight:700, font-size:15px inline) and the etymology label ("Origin" inline-italic via `<em>` tag) ignore the existing CSS classes (`.dict-word`, `.dict-def`, `.etymology-card`). All seven `escHtml(p.x)` inserts at `admin.js:111-114` should be replaced with `renderWordDisplay(p, { variant: 'admin' })` or similar. See §5a.

### 3.12 `renderAuthScreen` — `auth.js:92`

- **Returns:** HTML string (a `<div class="auth-screen">`).
- **Reuse count: 1 external call site.** `helpers.js:109` (the `!currentUser` early branch of `renderApp`).
- **Visual style:** Brand mark + title, subtitle copy, OAuth buttons (Google + Apple) via the auth-ui.md canonical pattern, "or use email" divider, login/signup tabs, email + password form. CSS at `styles.css:921-1060`.
- **Object:** N/A (chrome).
- **Note:** This is the **canonical reference cited by `.claude/rules/auth-ui.md`.** The rule explicitly says: "The canonical reference is daywordplay (`projects/daywordplay/web/auth.js:96-122` + `projects/daywordplay/web/styles.css:960-1001`)." Other apps copy from here. See §9.

### 3.13 `renderHelpModal` — `helpers.js:147`

- **Returns:** HTML string (a `.modal-overlay` + `.modal-sheet` with 4 numbered help steps and an example).
- **Reuse count: 1 external call site.** `init.js:135` (`document.body.insertAdjacentHTML('beforeend', renderHelpModal())` on help-btn click).
- **Visual style:** Bottom-sheet modal with rounded teal step-number badges (`.help-step-num`) and a `.help-example` block showcasing the word-highlight treatment on an example sentence.
- **Object:** N/A (onboarding).
- **Note:** The example sentence in `helpers.js:174-175` ("The <span class=\"word-highlight\">ephemeral</span> rainbow vanished…") is a fifth informal Sentence rendering — a hard-coded literal, not parameterized. Defensible since it's onboarding chrome, not user data.

### 3.14 `renderProposeModal` — `dictionary.js:111`

- **Returns:** HTML string (a `.modal-overlay` + `.modal-sheet`).
- **Reuse count: 1 external call site.** `dictionary.js:246` (injected into `#propose-modal-container` on "+ Propose word" tap).
- **Visual style:** Bottom-sheet with title, explanatory subtitle, 4 form inputs (word, POS, definition textarea, etymology textarea), error/success message slot, submit button. CSS shared with the other modals at `styles.css:1325-1369`.
- **Object:** Word (proposal-form variant).
- **Inconsistency:** Each input carries an identical inline style: `style="width:100%; box-sizing:border-box;"` (`dictionary.js:123-126`). Same inline blob also appears 4 times in `admin.js:42-45` (the admin add-word form). Should be a `.form-input` class. See §8.2.

### 3.15 `renderJoinModal` — `groups.js:86`

- **Returns:** HTML string (a `.modal-overlay` + `.modal-sheet`).
- **Reuse count: 3 external call sites.** `home.js:181` (no-group prompt), `profile.js:56`, plus `groups.js:52` (which is itself dead — see §7).
- **Visual style:** Same modal chrome as Propose; one large `<input>` for the 4-character code with uppercased monospace styling (inline `text-transform:uppercase; font-family:monospace; font-size:20px; letter-spacing:4px; text-align:center;` at `groups.js:95`).
- **Object:** Group (join-by-code form).

### 3.16 `renderCreateModal` — `groups.js:105`

- **Returns:** HTML string (a `.modal-overlay` + `.modal-sheet`).
- **Reuse count: 3 external call sites.** `home.js:182`, `profile.js:57`, `groups.js:53` (dead).
- **Visual style:** Same modal chrome as Join; one `<input>` for group name. CSS shared.
- **Object:** Group (create form).

### 3.17 `renderError` — `helpers.js:65`

- **Returns:** HTML string (a `<div class="error-banner">`).
- **Reuse count: 24 external call sites** across `home.js`, `vote.js`, `groups.js`, `profile.js`, `dictionary.js`, `admin.js`. Universal in-line error display.
- **Visual style:** Red-tinted banner, `styles.css:1114-1122`.
- **Note:** Single source of truth for inline error rendering. Modals use it; full screens use it. Consistent across the project.

### 3.18 `renderSuccess` — `helpers.js:69`

- **Returns:** HTML string (a `<div class="success-banner">`).
- **Reuse count: 2 external call sites.** `dictionary.js:294` (propose-word success), `admin.js:248` (add-word success).
- **Visual style:** Teal-tinted banner mirroring `renderError`, `styles.css:1124-1132`.

### 3.19 `highlightWord` — `helpers.js:84`

- **Returns:** HTML string (escapes input, then wraps case-insensitive whole-word occurrences in `<span class="word-highlight">`).
- **Reuse count: 5 external call sites.** `dictionary.js:93` (dict-my-sentence), `dictionary.js:102` (dict-winning-text), `home.js:61` (reusable pill text), `home.js:230` (submitted-sentence-text), `vote.js:62` (sentence-card-text). Plus one internal use in the help modal example (`helpers.js:174-175`).
- **Visual style:** Inline span styled at `styles.css:1267-1272` — italic Georgia, bold weight, teal color.
- **Note:** This is the **shared visual atom** for Sentence rendering. Every Sentence surface routes the body text through this. The atom is consistent; the surrounding chrome is what diverges (see §5b).

### 3.20 `escHtml` — `helpers.js:73`

- **Returns:** String (HTML-escapes `&`, `<`, `>`, `"`).
- **Reuse count: ~45 call sites across every JS file** that renders user-supplied content (group names, sentences, words, display names, error messages).
- **Note:** Universal HTML escape utility, no inconsistency.

### 3.21 `renderTopHeader` / `renderTabBar` / `renderShell` — `helpers.js:117, 129, 187`

Shell chrome, each with exactly 1 call site (`renderApp` and `renderShell`). Not "reusable" in the §3.1-3.20 sense — single-purpose render frames.

### 3.22 The `icons` constant — `helpers.js:43-62`

- 17 inline SVG icons assigned to keys (`person`, `bookmark`, `bookmarkFill`, `heart`, `share`, `info`, `grid`, `trophy`, `users`, `dwpMark`, `search`, `plus`, `check`, `volume`, `chevronRight`, `back`, `thumbsUp`, `settings`).
- Used as `${icons.info}`, `${icons.thumbsUp}` etc. across every surface.
- **Note:** Replaces the Lucide CDN dependency. Per `.claude/rules/web-frontend.md`, new projects use Lucide; daywordplay's earlier vintage ships them inline. Functionally identical (same stroke-width-1.8 24×24 set).

### 3.23 Dead components — see §7

`renderGroupsView`, `renderMyGroupCard`, `renderDiscoveryGroupCard`, `searchGroups`, `initGroupsListeners`, `attachDiscoveryJoinListeners` in `groups.js` had zero callers. Plus the entire `app.js` file (56 lines, never script-tagged). All removed in cleanup.

---

## 4. CSS class inventory

`styles.css` was 1,480 lines before cleanup (post-cleanup: see Cleanup log). The table below groups class blocks by purpose and notes the font/token used per group plus any dead classes found.

| Group | Representative classes | Lives at | Fonts / tokens | Dead members |
| --- | --- | --- | --- | --- |
| Tokens (`:root`) | `--bg`, `--bg-card`, `--bg-pill`, `--text-primary`, `--text-secondary`, `--text-muted`, `--accent`, `--accent-light`, `--accent-hover`, `--border`, `--shadow`, `--radius`, `--radius-sm`, `--tab-h`, `--header-h`, + Pico overrides | `:3-26` | n/a | None |
| Loading | `.loading-screen`, `.loading-spinner`, `@keyframes spin` | `:47-64` | Inter | None |
| App shell | `#app-shell`, `.top-header`, `.header-left`, `.header-right`, `.app-title`, `.avatar-btn`, `.help-btn`, `.page-content` | `:67-198` | Playfair Display (`.app-title`), Inter | `.bookmark-pill` — DELETED in cleanup (no consumer); `.progress-bar`, `.progress-fill` — DELETED (no consumer) |
| Help modal | `.help-content`, `.help-step`, `.help-step-num`, `.help-example` | `:160-190` | Inter | None |
| Bottom tab bar | `.tab-bar`, `.tab-btn`, `.tab-btn.active`, `.tab-btn.tab-center` | `:201-241` | Inter | `.new-badge` — DELETED (no consumer) |
| Word sub-tabs | `.word-tabs`, `.word-tab-btn`, `.word-tab-btn.active` | `:257-281` | Inter | None |
| Word display (canonical) | `.word-display`, `.word-main`, `.word-definition`, `.word-pos` | `:283-310` | Playfair Display (`.word-main`), italic Inter (`.word-pos`) | None |
| Action row | `.action-row`, `.action-btn`, `.action-btn.active`, `.action-btn:hover`, `.action-btn svg` | `:312-337` | n/a | **All DELETED** — no consumer in any JS or HTML file |
| Sentence input + submit | `.sentence-section`, `.sentence-input-wrap`, `.sentence-submit-row`, `.btn-primary`, `.submitted-card`, `.submitted-sentence-text` | `:339-418` | Inter | None |
| Etymology | `.etymology-card` | `:421-431` | Inter | None |
| Sentence cards (vote) | `.sentence-card`, `.sentence-card.voted`, `.sentence-card.winner`, `.sentence-card-text`, `.sentence-card-footer`, `.sentence-author`, `.vote-btn`, `.vote-btn.voted`, `.vote-btn.mine`, `.winner-badge` | `:441-504` | Inter; `#C8A84B` (gold) on `.winner` + `.winner-badge` | None — but the gold literals should become `--gold-accent` |
| Vote header (DEAD) | `.vote-page-header`, `.vote-word` | `:434-438` | n/a | **All DELETED** — vote view uses `.vote-date` only |
| Group cards | `.section-header`, `.section-title`, `.group-list`, `.group-card`, `.group-card.active`, `.group-card:hover`, `.group-card-info`, `.group-name`, `.group-meta`, `.group-code-badge`, `.join-btn`, `.icon-btn` | `:507-578` | Inter; `'Courier New', monospace` on `.group-code-badge` | None |
| Search input | `.search-wrap`, `.search-wrap input`, `.search-icon` | `:580-606` | Inter | None |
| Leaderboard | `.leaderboard-list`, `.leaderboard-entry`, `.leaderboard-entry.top-1`, `.top-2`, `.top-3`, `.rank-badge`, `.rank-1`, `.rank-2`, `.rank-3`, `.lb-name`, `.lb-votes` | `:608-643` | Inter; medal colors `#C8A84B` gold, `#A0A0A8` silver, `#B07A50` bronze | `.lb-username` — DELETED (no consumer) |
| Dictionary scroll | `.page-content.dict-active`, `.dict-sticky-header`, `.dict-scroll-area`, `.dictionary-list`, `.dict-letter-section`, `.dict-letter-header`, `.dict-card`, `.dict-word`, `.dict-pos`, `.dict-def`, `.dict-winning-sentence`, `.dict-winning-label`, `.dict-winning-text`, `.dict-winning-author`, `.dict-winning-mine`, `.dict-my-sentence`, `.dict-my-sentence-label`, `.dict-filter-row`, `.dict-filter-btn` | `:645-726`, `:1282-1305`, `:1371-1389` | Playfair Display for `.dict-letter-header` + `.dict-word`, Inter elsewhere; `.dict-winning-mine` uses inline `#FFF8E1`/`#FFE082`/`#FFD54F`/`#B8860B` gradient | None |
| Alpha index | `.dictionary-container`, `.alpha-index`, `.alpha-index-letter`, `.alpha-index-letter.active`, `.alpha-index-letter:hover` | `:728-781` | Inter | None |
| Profile | `.profile-header`, `.profile-avatar`, `.profile-name`, `.profile-username`, `.stats-row`, `.stat-card`, `.stat-value`, `.stat-label` | `:783-817` | Inter | None |
| Buttons | `.btn-primary`, `.btn-secondary`, `.btn-link`, `.danger-btn`, `.join-btn`, `.icon-btn` | `:382-395`, `:551-578`, `:819-860` | Inter; `#dc3545` on `.danger-btn` (danger red literal) | None |
| Browse status pills | `.browse-status`, `.browse-status.joined`, `.browse-status.pending` | `:861-867` | Inter; `#c59000` pending color literal | None |
| Join-request bubbles (live) | `.group-join-reqs`, `.join-req-loading`, `.join-req-bubble`, `.join-req-name`, `.join-req-actions`, `.approve-btn-sm`, `.deny-btn-sm` | `:1413-1472` | Inter; `#dc3545` on `.deny-btn-sm:hover` | None |
| Join-request cards (DEAD) | `.join-request-card`, `.join-request-info`, `.join-request-name`, `.join-request-user`, `.join-request-actions`, `.approve-btn`, `.deny-btn` | `:869-919` | n/a | **All DELETED** — live join-request markup uses the `.join-req-*` family (different names); the `.join-request-*` family has zero consumer |
| Auth screen (canonical) | `.auth-screen`, `.auth-brand`, `.auth-logo`, `.auth-title`, `.auth-subtitle`, `.auth-card`, `.auth-oauth-btn`, `.auth-oauth-google`, `.auth-oauth-apple`, `.auth-oauth-logo`, `.auth-divider`, `.auth-tabs`, `.auth-tab`, `.auth-tab.active`, `.form-field`, `.auth-submit` | `:921-1060` | Playfair Display (`.auth-title`); brand colors `#4285F4`, `#34A853`, `#FBBC05`, `#EA4335` inlined in SVG paths (intentional per auth-ui.md) | None |
| No-group prompt | `.no-group-prompt` | `:1062-1069` | Inter | None |
| Modal (canonical) | `.modal-overlay`, `.modal-sheet`, `.modal-handle`, `.modal-title`, `.modal-close-btn`, `.modal-form-group`, `@keyframes slideUp` | `:1325-1369` | Inter | `.modal-close` (non-`-btn` variant) — DELETED (no consumer; live close buttons use `.modal-close-btn`) |
| Modal (duplicate/dead) | `.modal-overlay`, `.modal-sheet`, `.modal-title` | `:1072-1101` | n/a | **All DELETED** — duplicate declaration of the same classes from `:1325+`, kept the later (more complete) block which includes `slideUp` animation |
| Error / success banners | `.error-banner`, `.success-banner` | `:1114-1132` | Inter; `#dc3545` (danger), `var(--accent)` (success) | None |
| Group switcher | `.group-switcher`, `.group-switcher::-webkit-scrollbar`, `.group-chip`, `.group-chip.active`, `.group-chip:hover` | `:1135-1159` | Inter | None |
| Utility | `.text-center`, `.text-muted`, `.mt-8`, `.mt-16`, `.mt-24`, `.full-width` | `:1161-1168` | n/a | None |
| Swipe cards | `.swipe-card-wrap`, `.swipe-action`, `.swipe-action-left`, `.swipe-action-right`, `.swipe-card` | `:1170-1212` | Inter; `#E53935` (red literal) on `.swipe-action-right` | None |
| Reusable sentence pills | `.reusable-sentences`, `.reusable-header`, `.reusable-icon`, `.reusable-label`, `.reusable-pills`, `.reusable-pill`, `.reusable-pill-text`, `.reusable-pill-source` | `:1214-1264` | Inter | None |
| Word highlight (shared atom) | `.word-highlight` | `:1267-1272` | italic Georgia, teal | None |
| Submit hint | `.submit-hint` | `:1275-1280` | Inter | None |
| Propose-word button | `.propose-word-btn` | `:1308-1323` | Inter | None |
| Settings badge | `.settings-badge`, `.avatar-btn` (position augment) | `:1392-1411` | Inter; `#e53e3e` (red literal) | None |
| Admin card | `.card` | `:1475-1480` | Inter | None |

---

## 5. Cross-cutting consistency findings

This section answers the three object-driven questions: do all surfaces that show a **Word**, a **Sentence**, or a **Group** look and act the same?

### 5a. Do all Word surfaces look and act the same?

A Word is shown on 5 surfaces. Three reach for the canonical component, two re-implement.

| Surface | File:line | Component used | Visual idiom |
| --- | --- | --- | --- |
| Home — today tab hero | `home.js:117` | `renderWordDisplay(word)` | Centered Playfair hero, 2.4-3.2rem clamp |
| Home — vote tab hero | `home.js:149` | `renderWordDisplay(word)` | Same as above |
| Home — submitted card recap | `home.js:228-232` | inline — only the word **inside a sentence**, via `highlightWord` | Italic Georgia teal span inside a cream pill |
| Dictionary — list card header | `dictionary.js:83-87` | inline `.dict-word` + `.dict-pos` + `.dict-def` | Smaller Playfair (1.5rem) row, density-tuned |
| Dictionary — etymology line | `dictionary.js:87` | inline `<div class="dict-def" style="font-size:13px; ...">` | "Origin:" prefix, muted italic |
| Admin — proposal row | `admin.js:111-114` | **fully inline-styled**: `<div style="font-weight:700; font-size:15px;">`, `<em>Origin:</em>` | Inline-styled bold Inter, no Playfair |

**Verdict: mostly consistent on the hero surfaces; inconsistent on Dictionary + Admin.**

- The two home surfaces share `renderWordDisplay` exactly. This is the canonical Word component.
- The dictionary list deliberately bypasses the hero — defensible at list density. But the etymology line (`dictionary.js:87`) ignores the existing `.etymology-card` chrome AND ignores the `renderEtymologyCard` function — it uses an inline-styled `.dict-def` with the label "Origin" instead of "Etymology". Two surfaces (today-tab card vs dict-card line) show the same field with two labels and two visuals.
- The admin proposal row is the most egregious. Word headers should use Playfair Display (per the canonical pattern); the admin row uses Inter bold (inline). Definition body has no shared class. Etymology uses `<em>Origin:</em>` (vs canonical `<strong>Etymology:</strong>`). This is the lowest-priority surface visually (admin only) but the highest-value cleanup: it ignores three existing patterns and would become one line if it called `renderWordDisplay`.

**Recommendation:** Extract `renderWordDisplay(word, { variant: 'hero' | 'card' | 'admin' })`:
- `hero` — current behavior, used on home today + vote.
- `card` — Playfair 1.5rem, used by dict cards (replacing the inline `.dict-word` markup).
- `admin` — Playfair (NOT Inter bold), used by admin proposal rows (replacing all 4 inline-styled lines).

Etymology should similarly collapse into `renderEtymologyField(word, { variant })` with a single label decision (recommend "Etymology" everywhere — it's the more precise term and matches the existing canonical card).

### 5b. Do all Sentence surfaces look and act the same?

A Sentence is shown on 5 surfaces (4 user-data, 1 onboarding). **No canonical component.**

| Surface | File:line | Markup | Author shown? | Action affordance |
| --- | --- | --- | --- | --- |
| Vote — anonymous shuffled card | `vote.js:60-74` | `.sentence-card` flip with `.voted` / `.winner` modifiers, italic body, thumbs-up vote button | No (until you vote) | Vote button |
| Vote — voted/winner card | same | same as above, modifier class changes | Yes (after vote) | Disabled vote button (locked) |
| Home — submitted confirmation | `home.js:226-233` | `.submitted-card` with checkmark, "Your sentence for today" heading, italic body in `.submitted-sentence-text` pill | n/a (it's your own) | None |
| Home — reusable suggestion pill | `home.js:59-64` | `.reusable-pill` button, italic body + "from {group}" attribution | n/a (it's your own, from another group) | Tap to populate textarea |
| Dictionary — winning sentence | `dictionary.js:97-105` | `.dict-winning-sentence` (or `.dict-winning-mine` gold variant) with "🏆 Best sentence" / "👑 Your winning sentence" label, italic body, optional `— Author` attribution | Yes | None |
| Dictionary — your sentence (didn't win) | `dictionary.js:90-95` | `.dict-my-sentence` with "✍️ Your sentence" label, italic body | n/a (yours) | None |
| Help modal — example | `helpers.js:174-175` | inline literal: `<div style="font-style:italic; line-height:1.5;">"The <span class="word-highlight">ephemeral</span> rainbow…"</div>` | n/a | None |

**Verdict: inconsistent. Five user-data surfaces, five bespoke renders.**

The only common atom is `<span class="word-highlight">` (via `highlightWord`, `helpers.js:84`), which all five surfaces use to emphasize the daily word. Beyond that:

- **Italic body** is consistent — every Sentence body is italic. Good.
- **Quote marks** are consistent — all five wrap the body in `"…"`. Good.
- **Card chrome diverges entirely.** Vote uses `.sentence-card`. Submitted uses `.submitted-card`. Reusable uses `.reusable-pill`. Dict-winning uses `.dict-winning-sentence`. Dict-mine uses `.dict-my-sentence`. Each has its own border, padding, background, and label conventions.
- **Author attribution** uses three different conventions: `.sentence-author` (vote), `<div class="dict-winning-author">— {Author}</div>` (dictionary), or no author at all (submitted / reusable / help).
- **Winner indication** uses two different conventions: `.winner-badge` ("🏆 Top pick" pre-text + gold card border) on vote view; `.dict-winning-label` ("🏆 Best sentence") in the dictionary. Same emoji, different label, different chrome.

**Recommendation:** Extract `renderSentenceQuote(sentence, opts)` where `opts.mode` ∈ `{vote-anonymous, vote-revealed, submitted, reusable-pill, dict-winning, dict-mine}` and own these decisions in one place:

- **Body**: always italic, always wrapped in `"…"`, always `highlightWord` over the daily word — already consistent, just centralize it.
- **Label**: per-mode prefix ("🏆 Best sentence", "✍️ Your sentence", etc.) using a shared `.sentence-quote__label` class.
- **Author**: revealed-or-not by mode flag (vote-anonymous hides, vote-revealed/dict-winning show, others omit).
- **Chrome**: outer card class set by mode (`.sentence-quote--vote`, `.sentence-quote--submitted`, etc.) — but inner body uses one shared `.sentence-quote__body` class.

This is the highest-leverage refactor in the codebase. Six bespoke surfaces collapse into one parameterized component with one CSS family.

### 5c. Do all Group surfaces look and act the same?

A Group is shown on 6 surfaces. Only the chip variant (switcher) is intentionally distinct; the four "card" surfaces share a class (`.group-card`) but diverge on what they show inside it. Two of the six are dead (deleted in cleanup, see §7).

| Surface | File:line | Component | Fields shown | Action affordance |
| --- | --- | --- | --- | --- |
| Home/Leaderboard switcher chip | `home.js:191-201` | `renderGroupSwitcher` → `.group-chip` | Name only | Tap to swap active group |
| Home no-group browse panel | `home.js:495-510` | `renderBrowseGroupCard` → `.group-card` | Name + member count | Request-to-Join button OR "Joined" / "Pending" pill |
| Profile My Groups list | `profile.js:61-79` | `renderProfileGroupCard` → `.group-card` inside `.swipe-card-wrap` | Name + code badge | Swipe right → share, swipe left → leave |
| Admin All Groups list | `admin.js:76-85` | `renderAdminGroupRow` → `.card` (NOT `.group-card`) | Name + code + member count | Full-width Delete button |
| ~~Groups view My Groups~~ | ~~`groups.js:57-68`~~ | ~~`renderMyGroupCard`~~ — **DELETED in cleanup** | ~~Name + meta + code badge + active state~~ | ~~Tap to switch~~ |
| ~~Groups view Discovery~~ | ~~`groups.js:70-84`~~ | ~~`renderDiscoveryGroupCard`~~ — **DELETED in cleanup** | ~~Name + member count + "Joined" or "Join" button~~ | ~~Direct join via code~~ |

**Verdict: inconsistent across the four live surfaces.**

- **Fields shown vary by surface.** Browse shows `member count` but no code. Profile shows `code badge` but no member count. Admin shows both. Switcher shows neither. No surface shows the same set.
- **CSS family varies.** Three surfaces use `.group-card` (browse, profile, plus the dead two). Admin uses the generic `.card` class — visually heavier (no row-hover-lift, different padding).
- **Action affordance varies.** Switcher: tap-to-switch. Browse: request-to-join (3-state). Profile: swipe gestures. Admin: full-width destructive button. Four destinations, four distinct interaction models.
- **Code-badge styling** is consistent across the surfaces that show it: `.group-code-badge` (`styles.css:540-549`) — Courier monospace, teal, tinted pill. Good. But the dead `groups.js:65, 76` also used it; the modal at `groups.js:95` uses inline monospace styling instead of the class. Drift.
- **The two dead implementations were yet another variant.** `renderMyGroupCard` (`groups.js:57`) added an "active group" / "Tap to switch" `.group-meta` line that the live `renderProfileGroupCard` does not have. `renderDiscoveryGroupCard` (`groups.js:70`) had a binary Join button with no request flow, whereas the live `renderBrowseGroupCard` (`home.js:495`) has the 3-state Request-to-Join action. Together they suggest a never-shipped "Groups" tab that was replaced by inline browse in the no-group prompt — leaving the old code behind. Cleanup removes them.

**Recommendation:** Extract `renderGroupCard(group, { variant: 'switcher' | 'browse' | 'profile' | 'admin' })`:

- `switcher` keeps the chip shape (it's legitimately a different visual role — selector, not card).
- `browse | profile | admin` all use `.group-card` (drop the `.card` outlier in admin) and parameterize the field set + action slot.
- The right-slot action is the only thing that should differ per variant.

Lower priority than the Sentence refactor — the live surfaces serve genuinely different jobs and the cards don't visually clash today. But unifying them prevents the kind of drift that produced the two dead `groups.js` parallels.

### 5d. Other cross-cutting checks

**Modals.** Three modal renderers exist (`renderJoinModal`, `renderCreateModal`, `renderProposeModal`, plus `renderHelpModal`). All share the `.modal-overlay` / `.modal-sheet` chrome (`styles.css:1325-1369`). All close on overlay click + close button. Consistent. The only inconsistency was a duplicate CSS block (`styles.css:1072-1101` defining the same three classes) — removed in cleanup.

**Animations.** `slideUp` keyframe is the only modal animation (`styles.css:1345-1348`). The card-list entrance + hover-lift recommended in `.claude/rules/web-frontend.md` is **not implemented** — no `fadeUp`, no `--i` stagger, no `.card:hover { transform: translateY(-2px) }`. The codebase has `transition: border-color 0.15s, box-shadow 0.15s` on `.group-card:hover` (`styles.css:533`) which is a lighter affordance. Tracked as a `/ui-polish` follow-up.

**Loading states.** Three patterns: `.loading-screen` (`styles.css:47-53`, used at boot + leaderboard fetch), `.loading-spinner` inline (used for in-place spinners with inline sizing), and a one-off `.loading` div with inline `style="height:60vh"` (`home.js:111`) that has no CSS class at all — it's just an empty 60vh-tall div. The `.loading` class has no definition in styles.css — it's a no-op. Should be removed and `.loading-spinner` used instead, or `.loading` should be defined.

---

## 6. Component reuse summary

A list of every place where ad-hoc markup duplicates an available (or intended-to-be-available) component. Each row maps the concern → the component that exists → the surface(s) that bypass it → a one-sentence recommendation.

| Concern | Component that exists | Surface(s) that bypass it | Recommendation |
| --- | --- | --- | --- |
| Word display | `renderWordDisplay` (`home.js:204`) | `dictionary.js:83-87` (dict-word header), `admin.js:111-114` (admin proposal — inline-styled) | Add `variant: 'hero' \| 'card' \| 'admin'` and migrate the two bypassers. The admin one is highest value (most divergent). |
| Etymology display | `renderEtymologyCard` (`home.js:216`) | `dictionary.js:87` ("Origin:" inline), `admin.js:114` (`<em>Origin:</em>` inline) | Decide on one label ("Etymology"), extract `renderEtymologyField(text, { variant })` and migrate the two inline sites. |
| Sentence quote (the largest debt) | _(no canonical)_ | 5 surfaces — `vote.js:50`, `home.js:226-233`, `home.js:34-67`, `dictionary.js:90-95`, `dictionary.js:97-105` | Extract `renderSentenceQuote(sentence, { mode })` covering all five modes. Highest-value refactor in the codebase. See §5b. |
| Group card | _(no canonical)_ | 4 surfaces — `home.js:495`, `profile.js:61`, `admin.js:76`, plus the (now-deleted) `groups.js:57`/`:70` | Extract `renderGroupCard(group, { variant })` covering browse / profile / admin. Drop admin's `.card` outlier and use `.group-card` everywhere. The switcher chip is intentionally separate. See §5c. |
| Modal chrome | `.modal-overlay` + `.modal-sheet` class family (`styles.css:1325-1369`) | None — all three modal renderers (`renderJoinModal`, `renderCreateModal`, `renderProposeModal`) plus `renderHelpModal` use it consistently. | No action. Removed the duplicate CSS block in cleanup. |
| Form input chrome | _(no canonical class — `.form-field` exists but only for auth-screen labels)_ | 4 inputs in `renderProposeModal` (`dictionary.js:123-126`) and 4 inputs in `renderAdminView` (`admin.js:42-45`) all carry identical inline `style="width:100%; box-sizing:border-box;"` | Extract `.form-input { width: 100%; box-sizing: border-box; ... }` and use it on every input across modals and admin forms. |
| Error / Success banner | `renderError` (`helpers.js:65`), `renderSuccess` (`helpers.js:69`) | None bypassed for errors. **`admin.js:158` inlines a `<div class="success-banner" style="margin:0;">` instead of calling `renderSuccess`.** | Migrate the one admin site to `renderSuccess(...)`. |
| Word highlight | `highlightWord` (`helpers.js:84`) → `.word-highlight` (`styles.css:1267-1272`) | None — universally adopted (5 call sites + 1 inline in the help-modal example). | No action. This is the model atom for the codebase. |
| Destructive confirmation | `window.confirm()` | None — all 4 destructive gates use it. **Compliant** with `.claude/rules/web-frontend.md`. | No action. A future `/ui-polish` could migrate to a project-themed modal, but the rule explicitly allows native `confirm()` everywhere. |
| Settings/avatar markup | inline `<div class="profile-avatar">${initial}</div>` (`profile.js:11-12`) | n/a — only one surface shows a user identity. | No action until a user-attribution surface (e.g. sentence author chip) is added. |

---

## 7. Dead code (verified)

> All items in §7.1 below were deleted in the cleanup pass. They are retained in this document as a historical record. See "Cleanup log" at the end for the diff summary.

### 7.1 Confirmed dead — resolved by cleanup

Verified by per-symbol grep across `*.js` and `*.html` returning zero external call sites.

**JavaScript:**

| Symbol / file | Was at | Reason dead | Resolution |
| --- | --- | --- | --- |
| Entire `web/app.js` (56 lines) | `web/app.js` | Not in `index.html` script tags (`index.html:21-33`). Leftover from `scaffold.sh` template; `helpers.js`/`init.js`/`home.js` etc. replaced it entirely. | **DELETED** — whole file removed |
| `renderGroupsView` function | `groups.js:20` | `helpers.js#renderCurrentPage` (`:224-233`) has no `'groups'` case; no tab routes there; no caller anywhere. | **DELETED** |
| `renderMyGroupCard` function | `groups.js:57` | Only called from `renderGroupsView` (which is itself dead). | **DELETED** |
| `renderDiscoveryGroupCard` function | `groups.js:70` | Only called from `renderGroupsView` + `attachDiscoveryJoinListeners` (both dead). | **DELETED** |
| `searchGroups` function | `groups.js:9` | Only called from `initGroupsListeners` (dead). | **DELETED** |
| `initGroupsListeners` function | `groups.js:124` | No caller — `init.js#initPageListeners` (`:68-86`) has no `'groups'` case. | **DELETED** |
| `attachDiscoveryJoinListeners` function | `groups.js:261` | Only called from `initGroupsListeners` (dead). | **DELETED** |
| `groupSearchQuery`, `groupsSearchResults`, `groupsLoading` (3 `let` vars) | `groups.js:5-7` | Only read by the dead renderers above. | **DELETED** |

**KEPT (alive, used by `home.js` and `profile.js`):**
- `showJoinGroupModal` / `showCreateGroupModal` state vars (`groups.js:3-4`)
- `renderJoinModal` (`groups.js:86`) — called by `home.js:181`, `profile.js:56`
- `renderCreateModal` (`groups.js:105`) — called by `home.js:182`, `profile.js:57`

**CSS classes** (verified by `grep -rn '<class>' projects/daywordplay/web --include="*.js" --include="*.html"` returning zero non-stylesheet hits):

| Class family | styles.css lines | Resolution |
| --- | --- | --- |
| `.action-row`, `.action-btn` (+ `.action-btn.active`, `:hover`, ` svg`) | `:312-337` | **DELETED** |
| `.bookmark-pill` (+ `:hover`, ` svg`) | `:101-117` | **DELETED** |
| `.progress-bar`, `.progress-fill` | `:119-131` | **DELETED** |
| `.new-badge` | `:243-254` | **DELETED** |
| `.vote-page-header`, `.vote-word` | `:434-438` | **DELETED** |
| `.lb-username` | `:636` | **DELETED** |
| `.modal-close` (non-`-btn` variant — only `.modal-close-btn` is live) | `:1102-1111` | **DELETED** |
| `.approve-btn`, `.deny-btn` (non-`-sm` variants — only `-sm` are live) | `:897-919` | **DELETED** |
| `.join-request-card`, `.join-request-info`, `.join-request-name`, `.join-request-user`, `.join-request-actions` (live join-request markup uses the `.join-req-*` family at `:1413-1472`, different names) | `:869-896` | **DELETED** |
| Duplicate `.modal-overlay` / `.modal-sheet` / `.modal-title` block (the more complete declaration with `slideUp` keyframe lives at `:1325-1369`) | `:1072-1101` | **DELETED** |

### 7.2 Items previously suspected dead but verified alive (do NOT delete)

| Item | Citation that proves it is alive |
| --- | --- |
| `.auth-tabs`, `.auth-tab` | Used at `auth.js:126-128` (the login/signup tab toggle inside the auth modal). |
| `.modal-close-btn` | Used at `dictionary.js:117` (propose modal close) and `helpers.js:153` (help modal close). |
| `.approve-btn-sm`, `.deny-btn-sm` | Used at `profile.js:333-334` (join-request approve/deny buttons in profile). |
| `.join-req-bubble`, `.join-req-name`, `.join-req-actions`, `.group-join-reqs` | Used at `profile.js:330-336` (inline join-request bubbles under group cards). |
| `.dict-winning-mine` | Conditionally applied at `dictionary.js:100` when the viewer's own sentence won. |
| `.rank-1`, `.rank-2`, `.rank-3`, `.rank-other` | Used at `leaderboard.js:63` via `class="rank-badge rank-${entry.rank <= 3 ? entry.rank : 'other'}"`. (`.rank-other` is not styled but the class is harmless.) |

---

## 8. Inconsistencies — fonts, inline styles, design tokens

### 8.1 Typography map

The design has two type roles and one outlier:

| Role | Family | Where it lives | Where it's used |
| --- | --- | --- | --- |
| Display / headings | `'Playfair Display', Georgia, serif` (700) | `.app-title` (`:134`), `.word-main` (`:290`), `.dict-letter-header` (`:667`), `.dict-word` (`:685`), `.auth-title` (`:949`) | All Word displays and titled chrome |
| Body / chrome | `'Inter', -apple-system, sans-serif` (`--pico-font-family`, applied to body at `:40`) | Default everywhere | Every non-display surface |
| Code badges (data-driven) | `'Courier New', monospace` | `.group-code-badge` (`:541`) | The 4-character join codes |
| Word highlight (data-driven) | `Georgia, 'Times New Roman', serif` italic bold | `.word-highlight` (`:1268`) | The daily word as it appears inside any rendered Sentence |

**Findings:**

- **The vote-tab heading at `home.js:150` does NOT use `renderWordDisplay`.** It only renders the date line. The word above it IS via `renderWordDisplay` (`home.js:149`) — consistent.
- **The submitted-card heading "Your sentence for today" at `home.js:229`** uses inline `style="font-weight:600; font-size:15px; color:var(--text-secondary);"`. Reaches for Inter (correctly inherited) but bypasses any class. Should be `.submitted-card__heading` or similar.
- **The Admin proposal Word header uses Inter bold (inline) instead of Playfair.** `admin.js:111`: `<div style="font-weight:700; font-size:15px;">${escHtml(p.word)}</div>`. This breaks the "all Words are Playfair" rule. See §5a.
- **Typography is otherwise homogeneous** — 2 type roles + 2 legitimate data-driven outliers (Courier on group codes, Georgia italic on word-highlight). Compared to BoardgameBuddy (4 type roles), daywordplay is on the simpler end.

### 8.2 Inline-style audit

`grep -cE 'style="' projects/daywordplay/web/*.js` reports **104 inline-style occurrences**:

```
admin.js:        38
home.js:         15
groups.js:       14
dictionary.js:   13
profile.js:      12
leaderboard.js:   5
helpers.js:       4
vote.js:          2
auth.js:          1
```

(`app.js` had 0, but was deleted entirely in cleanup.)

**Three categories:**

1. **Legitimate CSS-variable inline-style — data-driven, can't come from CSS.**
   - `vote.js:56-57` — `style="color:var(--text-muted)"` on the conditional "(you)" / "Your sentence" labels.
   - `leaderboard.js:66` — `style="font-size:11px; color:var(--accent)"` on the leaderboard "(you)" label.
   - `leaderboard.js:48` — `style="font-family:monospace; letter-spacing:2px; color:var(--accent)"` on the group-code inline display (could be `.group-code-inline`).
   - `profile.js:276` — toast at the bottom of `showCopiedToast`: full inline CSS blob (`position:fixed;bottom:90px;...`) — should be a `.toast` class.

2. **Layout adjustments that should be classes.** Many `style="width:100%; box-sizing:border-box;"` repeated for form inputs (8 sites across `dictionary.js:123-126` and `admin.js:42-45`); many `style="margin-top:24px;"` / `style="display:flex; gap:8px;"` reaching for utility spacing. Suggests a small set of utility classes (`.form-input`, `.row-gap-8`) would cut volume by ~30%.

3. **Inline-styled admin chrome.** `admin.js` carries 38 `style=` attributes — the most of any file. Most are form labels, card headings, and proposal-row sublines that have no shared class. Migrating them to `.card-heading`, `.card-meta`, `.form-label` classes would reduce inline volume by a third and unify the admin look-and-feel with the rest of the app.

**Verdict: legitimate uses are a small minority.** Most inline styles are layout shortcuts that the codebase has not yet decided to promote into classes. None are correctness bugs — flagged for a future `/ui-polish` pass.

### 8.3 Design token coverage

`:root` (`styles.css:3-26`) is well-organized with **15 design tokens** covering backgrounds, text colors, accent, border, shadow, radii, and layout dimensions. The token discipline is good — `var(--accent)`, `var(--text-muted)`, `var(--border)` are used pervasively across all surfaces.

**Gaps — hex literals that should become tokens:**

| Literal | Sites in styles.css | Used for | Recommended token |
| --- | --- | --- | --- |
| `#C8A84B` | `:457` (winner card border), `:498`, `:501` (winner badge), `:620` (top-1 border), `:631` (rank-1 color) | Gold/winner | `--gold-accent` or `--rank-1` |
| `#FDFAF0` | `:457` (winner card bg), `:620` (top-1 bg) | Winner card background | `--gold-bg` or `--winner-bg` |
| `#A0A0A8` | `:621` (top-2 border), `:632` (rank-2 color) | Silver | `--silver-accent` or `--rank-2` |
| `#B07A50` | `:622` (top-3 border), `:633` (rank-3 color) | Bronze | `--bronze-accent` or `--rank-3` |
| `#FFF8E1`, `#FFE082`, `#FFD54F`, `#B8860B` | `:718-726` (dict-winning-mine gradient) | "Your sentence won" celebration | could collapse to `--gold-bg` + `--gold-accent` if the dict-mine gradient is simplified |
| `#dc3545` | `:822, 832, 919 (deleted), 1119, 1472` | Danger red | `--danger` |
| `#E53935` | `:1202` (`.swipe-action-right` background) | Same danger red, slightly different shade | `--danger` (unify) |
| `#e53e3e` | `:1402` (`.settings-badge` background) | Same danger family, third shade | `--danger` (unify) |
| `#c59000` | `:867` (`.browse-status.pending` color) | Pending amber | `--pending` |
| `rgba(220,53,69,...)` | `:821, 832, 916, 1115, 1116` | `#dc3545` with alpha | mix `var(--danger)` via `color-mix()` or define `--danger-light` / `--danger-bg` |
| `rgba(74,124,124,...)` | `:1218, 1243, 1257` (`.reusable-*`) | `--accent` with alpha | use `var(--accent-light)` (already defined at `:11`) — would unify with the rest of the codebase |

**Verdict: tokens are well-established for the warm beige palette, but the medal colors and danger red have grown literals.** Tracked as future work — promoting these would let the codebase be themed (e.g. a dark mode) by editing only `:root`.

---

## 9. Auth UI — canonical reference

`projects/daywordplay/web/auth.js:96-122` + `styles.css:969-1010` IS the canonical reference cited by `.claude/rules/auth-ui.md`. Specifically:

- Provider logos are inline SVG (4-color Google G, monochrome Apple — `currentColor` inheriting button text color). `auth.js:97-106`.
- Logos are 18×18 via `.auth-oauth-logo` (`styles.css:992`).
- Buttons are full-width pills (`border-radius: 999px`, `width: 100%`) via `.auth-oauth-btn` (`styles.css:969-991`).
- `.auth-oauth-google` and `.auth-oauth-apple` variants exist; the Apple variant rebinds `color` on `.auth-oauth-logo` so the monochrome glyph follows the button text color (`styles.css:993`).
- The "or use email" divider lives at `.auth-divider` (`styles.css:995-1010`) — hairline rule + centered text.

**Verdict: nothing to change.** Other apps should copy from here.

---

## Appendix — how this audit was produced

Every component count and dead-code claim in this document is `grep`-verified. Key search commands used:

```
# Component reuse counts
for fn in renderWordDisplay renderSentenceCard renderSentenceSection \
          renderReusablePills renderDictCard renderBrowseGroupCard \
          renderProfileGroupCard renderAdminGroupRow renderGroupSwitcher \
          renderEtymologyCard renderHelpModal renderProposeModal \
          renderAdminProposalRow renderAuthScreen renderError \
          renderSuccess highlightWord escHtml; do
  echo "=== $fn ==="
  grep -rn "$fn" projects/daywordplay/web --include="*.js" --include="*.html"
done

# Dead JS verification
for sym in renderGroupsView renderMyGroupCard renderDiscoveryGroupCard \
           searchGroups initGroupsListeners attachDiscoveryJoinListeners \
           groupSearchQuery groupsSearchResults groupsLoading; do
  echo "=== $sym ==="
  grep -rn "$sym" projects/daywordplay/web --include="*.js" --include="*.html"
done

# Dead CSS class verification (must return zero non-stylesheet hits)
for cls in action-row action-btn bookmark-pill progress-bar progress-fill \
           new-badge vote-page-header vote-word lb-username; do
  echo "=== .$cls ==="
  grep -rn "$cls" projects/daywordplay/web --include="*.js" --include="*.html"
done
grep -rEn 'class="[^"]*\bmodal-close\b[^"]*"' projects/daywordplay/web --include="*.js" --include="*.html"
grep -rEn 'class="[^"]*\bapprove-btn\b[^"]*"|class="[^"]*\bdeny-btn\b[^"]*"' projects/daywordplay/web --include="*.js" --include="*.html"

# Inline style audit
grep -cE 'style="' projects/daywordplay/web/*.js

# Destructive dialog audit
grep -nE '\bconfirm\(|\balert\(|\bprompt\(' projects/daywordplay/web/*.js

# Duplicate CSS declarations
grep -nE '^\.modal-overlay\b|^\.modal-sheet\b|^\.modal-title\b|^\.avatar-btn\b' \
  projects/daywordplay/web/styles.css

# Hex literal census
grep -oE '#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b' projects/daywordplay/web/styles.css | sort -u
```

To reproduce or extend: re-run those greps after any refactor and update the counts in §3 and §6.

---

## Cleanup log

### Pass 1 (initial audit) — 2026-05-25
Inventory only; no code changes.

### Pass 2 (cleanup) — 2026-05-25

**JS removed:**
- Entire file `projects/daywordplay/web/app.js` (56 lines) — leftover from `scaffold.sh`, never script-tagged.
- Dead exports from `projects/daywordplay/web/groups.js`: `searchGroups`, `renderGroupsView`, `renderMyGroupCard`, `renderDiscoveryGroupCard`, `initGroupsListeners`, `attachDiscoveryJoinListeners`, plus the three associated `let` vars (`groupSearchQuery`, `groupsSearchResults`, `groupsLoading`). Total: ~210 lines removed from `groups.js`.

**JS kept (verified live, used by home.js + profile.js):**
- `showJoinGroupModal` / `showCreateGroupModal` state vars.
- `renderJoinModal` (called by `home.js:181`, `profile.js:56`).
- `renderCreateModal` (called by `home.js:182`, `profile.js:57`).

**CSS removed:** 13 verified-dead class families + 1 duplicate modal block.

| Block | Approx. former lines |
| --- | --- |
| `.action-row`, `.action-btn` (+ modifiers) | 26 |
| `.bookmark-pill` family | 18 |
| `.progress-bar`, `.progress-fill` | 14 |
| `.new-badge` | 12 |
| `.vote-page-header`, `.vote-word` | 6 |
| `.lb-username` | 1 |
| `.modal-close` (non-`-btn`) | 10 |
| `.approve-btn`, `.deny-btn` family | 23 |
| `.join-request-*` family (5 classes) | 27 |
| Duplicate `.modal-overlay` / `.modal-sheet` / `.modal-title` block (`:1072-1101`) | 30 |

**Net effect:**
- `web/styles.css`: 1,480 → 1,315 lines (**165 lines removed, ~11.1%**).
- `web/groups.js`: 289 → 45 lines (**244 lines removed, ~84%**; the file now contains only the two modal renderers and their state vars).
- `web/app.js`: 56 → 0 lines (file deleted).
- Web `.js` total (12 files post-cleanup): 4,543 - 56 - 244 - 165 = ~4,078 lines.

**Verification commands run after cleanup (all pass):**

```
grep -rn "renderGroupsView\|renderMyGroupCard\|renderDiscoveryGroupCard\|searchGroups\|initGroupsListeners\|attachDiscoveryJoinListeners\|groupSearchQuery\|groupsSearchResults\|groupsLoading" projects/daywordplay/web
# → 0 matches

ls projects/daywordplay/web/app.js 2>&1
# → No such file or directory

for cls in action-row action-btn bookmark-pill progress-bar progress-fill \
           new-badge vote-page-header vote-word lb-username \
           join-request-card join-request-info join-request-name \
           join-request-user join-request-actions; do
  echo "=== $cls ==="
  grep -rn "$cls" projects/daywordplay/web --include="*.js" --include="*.html" --include="*.css"
done
# → 0 matches each

grep -rEn 'class="[^"]*\bmodal-close\b[^"]*"' projects/daywordplay/web
# → only .modal-close-btn (kept)

grep -rEn 'class="[^"]*\b(approve|deny)-btn\b[^"]*"' projects/daywordplay/web
# → only .approve-btn-sm and .deny-btn-sm (kept)

# Modal helpers still alive
grep -rn "renderJoinModal\|renderCreateModal\|showJoinGroupModal\|showCreateGroupModal" \
  projects/daywordplay/web --include="*.js"
# → returns hits in home.js + profile.js + groups.js (own definitions)
```

**Not addressed in this pass (tracked for future work):**

- Extracting `renderSentenceQuote(sentence, { mode })` to consolidate the 5 bespoke Sentence renderings. See §5b — highest-value refactor in the codebase.
- Extracting `renderGroupCard(group, { variant })` for the 3 live card surfaces (browse, profile, admin). See §5c.
- Adding `variant` opts to `renderWordDisplay` so the dictionary card and admin proposal row can reuse it instead of inlining. See §5a.
- Migrating the ~104 inline `style="..."` attributes into shared classes (most-impactful: a `.form-input` class for the 8 repeated `style="width:100%; box-sizing:border-box;"` sites and a `.toast` class for the inline-CSS toast at `profile.js:276`).
- Promoting hex literals (`#C8A84B` gold, `#FDFAF0` winner-bg, `#A0A0A8` silver, `#B07A50` bronze, `#dc3545`/`#E53935`/`#e53e3e` danger reds, `#c59000` pending amber) into `:root` design tokens.
- Adding the `fadeUp` + `--i` stagger animation + `:hover { translateY(-2px) }` lift recommended by `.claude/rules/web-frontend.md` for card lists.
- Adding `web/types.d.ts` per `.claude/rules/typed-js.md` to give the cross-file globals (`currentView`, `myGroups`, `todayData`, etc.) editor-side type contracts.
- Migrating the `<div class="loading" style="height:60vh">` placeholder at `home.js:111` to a real `.loading-placeholder` class (the `.loading` class is undefined — the div is a no-op except for the inline height).
