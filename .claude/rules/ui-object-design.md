---
paths:
  - "projects/*/web/**"
  - "projects/*/app/**"
---

# UI Object-Oriented Design — One Object, One Component

The vibelab apps are object-driven: each project has a small set of **core domain objects** (the things the user thinks about) and the UI is the visual representation of those objects across many surfaces. This rule codifies how to keep that representation consistent.

The boardgame-buddy audit (`projects/boardgame-buddy/Docs/UI_AUDIT.md`) is the canonical case study — read it once to see what the failure mode looks like in practice (six bespoke game-tile implementations, a dead "canonical" function, and a half-migrated avatar component).

## 1. Identify the core objects first

Before writing any UI for a new feature, name the objects the user is interacting with. For boardgame-buddy that is **Game**, **Play**, **Buddy**, **User**, **Session**. For sauceboss it is **Sauce**, **Ingredient**. For plant-planner it is **Plant**, **Bed**, **Task**. For wealthmate it is **Account**, **Transaction**.

A "core object" is something the user can:
- See on multiple surfaces (list view, detail view, embedded in another object)
- Navigate to (tap → routes into a detail screen)
- Mutate independently (CRUD operations exist for it)

If exactly one screen shows the thing and nothing else references it, it is probably not a core object — it is a view-local detail. Don't promote it.

Write the object set down in the project's `STRUCTURE.md` or `Docs/ARCHITECTURE.md` so future contributors know which things deserve canonical components.

## 2. One canonical component per core object

For every core object, build exactly one render function (or class) in `web/ui/`. Every surface that displays the object uses that function.

```
ui/
├── play-card.js     → renderPlayCard(play, opts)        # the Play object
├── user-badge.js    → BgbBadge.render(opts)             # the User object
├── game-tile.js     → renderGameTile(game, opts)        # the Game object
└── buddy-row.js     → renderBuddyRow(buddy, opts)       # the Buddy object
```

**Variants are parameters, not parallel implementations.** When a new surface needs a slightly different presentation, add an `opts` field:

```js
// GOOD — single function, opt-driven variants
renderGameTile(game, { variant: "tile" })       // collection grid
renderGameTile(game, { variant: "preview" })    // profile preview
renderGameTile(game, { variant: "hero" })       // game-detail page
renderGameTile(game, { variant: "thumb" })      // plays list row
renderGameTile(game, { variant: "polaroid" })   // Gather grid

// BAD — six parallel implementations, none sharing a base
class="collection-tile"  …  // collection-view.js
class="hot-game-tile"    …  // feed-view.js
class="preview-card__cover" …  // profile-self-view.js
class="game-detail__polaroid"  …  // game-detail-view.js
class="plays-list__thumb"  …  // plays-view.js
class="game-polaroid"  …  // ui/game-card.js  (the only one in ui/)
```

The bad pattern is the boardgame-buddy state captured in `UI_AUDIT.md`. It happens organically when each view "just renders some markup" instead of going through a shared function.

### Component contract

Each canonical component should:

- **Take the domain object as its first argument** (the shape declared in `domain/<object>.js`).
- **Take an `opts` object as its second argument** with documented variants and JSDoc `@typedef`.
- **Return an HTML string** (no DOM manipulation, no side effects). This keeps it usable inside `view.render()` template literals and inside `view.innerHTML =`.
- **Own its CSS class family** — `.play-card`, `.play-card--strip`, `.play-card__photo`, etc. The class family lives in one section of `styles.css` and is not redefined elsewhere.
- **Read the *surface's* token family, not literals.** Colors and fonts come from CSS variables. Which variables depends on what kind of surface the component lands on — ground, paper or chrome — because a token tuned for the app ground inverts on a light card and vice versa. If the component is used on exactly one surface, a scoped override is fine; if it is shared across surfaces, define it in surface tokens in its own class family so it travels. See `.claude/rules/theming.md` §6 for the substitution table. Data-driven accents (per-game theme color, per-expansion source color) are the only legitimate inline-style use, and they are set as a custom property, never as a literal `color:`.

## 3. Visual continuity contract

Three rules keep the experience coherent across screens. Apply them on every new feature.

### 3a. Same object, same look

A `Game` on the home feed, in the collection grid, on the game-detail page, and embedded in a play card should all read as the same kind of thing. Size and density can differ; **typography, status badge, and accent treatment cannot.**

When you find yourself reaching for a new font on a known object — stop. Use the existing component's `opts`.

### 3b. Same action, same affordance

If two screens let the user open the same destination, they should use the same affordance. Maximize button vs full-card tap, swipe vs long-press, accept-button vs accept-via-row — pick one per destination and apply it everywhere.

The boardgame-buddy audit caught one case: `PlayDetailPopup` opens from the play card's maximize button (`ui/play-card.js`) but from a full-row tap in `views/plays-view.js`. Same destination, two affordances.

### 3c. Destructive actions are confirmed through one project-wide surface

Every destructive action requires a secondary user confirmation (see `.claude/rules/web-frontend.md`). Pick one confirmation surface for the whole project and use it everywhere: `window.confirm()` for every destructive gate, or a single shared modal API (e.g. `PolaroidPopup.confirm()` in boardgame-buddy), or a single bottom sheet (`.claude/rules/overlays.md`) — but one of them, for all of them. Mixing per-screen bespoke dialogs is the anti-pattern.

### 3d. A list that grows without bound is windowed

Any list that grows with user activity — plays, buddies, a collection — reveals a bounded window rather than rendering everything it has. Two shapes, and the list's own shape picks between them:

**Infinite scroll** for a single uniform run of rows or tiles the user reads top to bottom — a collection grid, a wishlist, a feed. An `IntersectionObserver` on a sentinel below the last row reveals the next batch; the batch is sized in **rows of the grid** (6–8 of them), not in items, so it fills a comparable amount of screen whatever the column count. The reference implementation is `ui/infinite-scroll.js` in boardgame-buddy, shared by `collection-view.js` and `wishlist-view.js`. Four rules that are easy to miss:

- **Re-observe the sentinel after every paint.** An observer whose target stays intersecting never fires a second time on its own, so a batch too short to push the sentinel past the observer's margin stalls the list. A fresh `observe()` always delivers one initial callback with the current state, which is what makes the check repeat.
- **Compare against what the client can actually draw from**, not against the reported total. A partial seed (a bundle's first page) knows the real size while holding one page of it; a sentinel gated on the total then asks forever for rows nobody has.
- **Guard against re-entry.** The sentinel re-arms on every paint and so can fire while a batch is still in the air; and a *failed* batch must block the sentinel until the user asks again, or the list retries the same failing request on every scroll.
- **Stand the observer down on unmount.** A hidden view keeps its markup, so an unparked sentinel keeps pulling batches nobody is looking at.

**Pagination** for anything else — a screen that stacks several lists (each pager has to sit with the list it drives), or a list the user navigates by position rather than by reading. Three rules there:

- **Clamp the page on every render**, not just on the page-turn handler. A delete under the user, or a filter that narrows the result set, otherwise strands them on a page that no longer exists.
- **Render the pager only when there is more than one page.**
- **Paging away closes any open inline panel**, or the user is left with invisible state attached to a row they can no longer see.

Heterogeneous rows (accounts and ghosts, owned and wishlisted) page **as one sequence** so every page is a full page. Factor one `_renderPager(page, pages, handler, label)` and reuse it — see `views/buddies-view.js` in boardgame-buddy.

Either shape narrows back to the first window on a search or filter change. Leaving a deep window over a freshly narrowed list drops the user into the middle of results they never scrolled to.

## 4. When duplicates appear

When a code review (or `/ultrareview` run) reveals two implementations of the same UI, prefer fixing the root cause over patching one of them:

1. **Find the canonical component.** Does one already exist in `ui/`? If so, why didn't the second surface use it? Migrate the second surface.
2. **If no canonical exists, decide whether one should.** Apply the "core object" test from §1. If yes, extract the more-complete implementation into `ui/`, delete the other, then add `variant` opts as the third surface needs them.
3. **Document the canonical choice.** If the project has a `Docs/ARCHITECTURE.md`, update §3 ("One object → One canonical UI component"). Otherwise add a sentence to `STRUCTURE.md`.

### Extract at instance #2

The moment to extract is the **second** occurrence, not the fourth. By instance #4 the copies have diverged and the extraction becomes a redesign.

When you extract, split along **lifecycle vs appearance**, not along "the shared bits":

- The extracted shell owns the *lifecycle* — construction, mounting, scroll lock, delegated events, keyboard handling, focus, teardown. It is the part that is genuinely identical and genuinely hard to get right twice.
- Each caller keeps its **own markup and its own CSS family**. Nothing about how the thing *looks* moves into the shell. That is what lets the third and fourth callers differ visually without forking the shell or growing an options matrix.

`projects/boardgame-buddy/web/ui/bottom-sheet.js` is the reference: 165 lines, four consumers, and its header states outright that "nothing about how a sheet LOOKS lives here." It was extracted when the status sheet stopped being the only one — and when the panel chrome then repeated a third time, that too was promoted out of one sheet's class family into a shared `.bgb-sheet__*` family rather than copied.

A corollary for naming: when a module's job splits in two, split the module. `ui/viewport-lock.js` *measures* the visible viewport and `ui/zoom-lock.js` *prevents* the scale changing; folding the second into the first would have made the first file's name a lie.

## 5. When deleting dead components

Components that no surface uses are not free — they grow stale, propose themselves to new contributors as "the right thing to use" (only to fail), and accumulate parallel CSS. Delete them as soon as they go cold.

- Grep verify zero call sites: `grep -rn "<componentName>" projects/<app>/web --include="*.js" --include="*.html"`.
- Delete the function, the `window.foo = foo` export, and the `<script src=…>` tag in `index.html`.
- If the component had its own CSS family, delete that too. Check for orphan host classes (e.g. `.profile-hub__avatar` sizing a now-deleted `.avatar-bubble`).
- Update any `Docs/UI_AUDIT.md` "Cleanup log" section so the deletion is traceable.

The boardgame-buddy cleanup log in `Docs/UI_AUDIT.md` is the reference for what this looks like end-to-end — dead function, dead CSS family, dead script tag, stale comment, all removed in one commit. Read the most recent pass, not the first.

A class name that describes a surface which no longer exists is the same kind of debt: `.bgb-cream-screen` outlived the cream sheet it was named for by two themes. Renaming it to `.bgb-spoke-screen` was a 67-selector sweep that should have happened when the surface changed.

## 6. Object-aware file layout

Every web project follows the same module shape so the OOD intent is visible from the directory listing:

```
projects/<app>/web/
├── domain/         ← One file per core object: <object>.js (game.js, play.js, …)
│   ├── view.js         the View base class + Router
│   └── theme.js        light/dark controller (.claude/rules/theming.md)
├── ui/             ← Canonical render functions AND app-wide primitives
│   ├── <object>-card.js, <object>-row.js, …   one per core object
│   ├── bottom-sheet.js     the sheet shell (.claude/rules/overlays.md)
│   ├── icons.js            the vendored icon set + render pass
│   ├── viewport-lock.js    publishes the visible viewport
│   └── zoom-lock.js        holds the page at 1x on iOS
├── widgets/        ← Stateful multi-component widgets (scoring grid, picker sheets, modals)
├── views/          ← One file per screen / route — thin, composes ui/ + widgets/
├── index.html      ← Shell only (theme boot, header, nav, view containers)
├── init.js         ← Router registration, view construction, auth boot
└── styles.css      ← All CSS — tokens first, then one section per class family
```

`ui/` holds two kinds of thing: the canonical component per core object, and the app-wide primitives every surface leans on. Both belong there because both have exactly one implementation by construction.

If a project does not have this layout yet (e.g. early prototype), add it as soon as the project crosses the 300-line-per-file threshold from `.claude/rules/web-frontend.md`.

## 7. Checklist when adding a new surface that shows a core object

- [ ] Is there a canonical render function in `ui/` for this object? If yes, use it.
- [ ] Does the surface need a tweak the canonical function doesn't support? Add an `opts` variant — do not write a parallel implementation.
- [ ] Are typography, color, and status badge unchanged? If you reached for a new font or accent, stop and reconsider.
- [ ] Does it read correctly in **both** themes, on the surface it actually lands on? Grep its CSS for ground tokens on a paper surface (`.claude/rules/theming.md` §6).
- [ ] Is any choice list a bottom sheet rather than an absolute dropdown (`.claude/rules/overlays.md`)?
- [ ] Is the navigation affordance (tap to open detail, etc.) consistent with the other surfaces that route to the same destination?
- [ ] Is any destructive action wired through the project's shared confirm modal?
- [ ] If a parallel implementation already exists somewhere else, did this change make it the second one — or did you delete the duplicate?
- [ ] If the change introduced a new core object, did you update `Docs/ARCHITECTURE.md` (or `STRUCTURE.md`) so future contributors know it exists?

## Related rules

- `.claude/rules/web-frontend.md` — vanilla-JS conventions, accessibility, motion.
- `.claude/rules/theming.md` — the token vocabulary a component must read.
- `.claude/rules/overlays.md` — the sheet shell, and the shell/appearance split above.
- `.claude/rules/mobile-web.md` — tap-target sizes for rows and commit buttons.
- `.claude/rules/assets.md` — asset directory + naming.
- `.claude/rules/typed-js.md` — JSDoc `@typedef` for component option contracts.
- `.claude/rules/auth-ui.md` — auth screen visual standard (a specific instance of the "same object, same look" rule applied to OAuth buttons).
