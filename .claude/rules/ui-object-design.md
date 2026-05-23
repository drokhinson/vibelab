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
- **Read tokens, not literals.** Colors and fonts come from CSS variables (`var(--accent)`, `var(--font-display)`). Data-driven accents (per-game theme color, per-expansion source color) are the only legitimate inline-style use.

## 3. Visual continuity contract

Three rules keep the experience coherent across screens. Apply them on every new feature.

### 3a. Same object, same look

A `Game` on the home feed, in the collection grid, on the game-detail page, and embedded in a play card should all read as the same kind of thing. Size and density can differ; **typography, status badge, and accent treatment cannot.**

When you find yourself reaching for a new font on a known object — stop. Use the existing component's `opts`.

### 3b. Same action, same affordance

If two screens let the user open the same destination, they should use the same affordance. Maximize button vs full-card tap, swipe vs long-press, accept-button vs accept-via-row — pick one per destination and apply it everywhere.

The boardgame-buddy audit caught one case: `PlayDetailPopup` opens from the play card's maximize button (`ui/play-card.js`) but from a full-row tap in `views/plays-view.js`. Same destination, two affordances.

### 3c. Destructive actions are confirmed through the project's shared modal

Every project should expose exactly one confirm-dialog API (e.g. `PolaroidPopup.confirm()` in boardgame-buddy). Use it for: delete, abandon, remove, clear, leave, sign out from another device, link/unlink accounts. Per `.claude/rules/web-frontend.md`, ad-hoc dialogs are not acceptable.

## 4. When duplicates appear

When a code review (or `/ultrareview` run) reveals two implementations of the same UI, prefer fixing the root cause over patching one of them:

1. **Find the canonical component.** Does one already exist in `ui/`? If so, why didn't the second surface use it? Migrate the second surface.
2. **If no canonical exists, decide whether one should.** Apply the "core object" test from §1. If yes, extract the more-complete implementation into `ui/`, delete the other, then add `variant` opts as the third surface needs them.
3. **Document the canonical choice.** If the project has a `Docs/ARCHITECTURE.md`, update §3 ("One object → One canonical UI component"). Otherwise add a sentence to `STRUCTURE.md`.

## 5. When deleting dead components

Components that no surface uses are not free — they grow stale, propose themselves to new contributors as "the right thing to use" (only to fail), and accumulate parallel CSS. Delete them as soon as they go cold.

- Grep verify zero call sites: `grep -rn "<componentName>" projects/<app>/web --include="*.js" --include="*.html"`.
- Delete the function, the `window.foo = foo` export, and the `<script src=…>` tag in `index.html`.
- If the component had its own CSS family, delete that too. Check for orphan host classes (e.g. `.profile-hub__avatar` sizing a now-deleted `.avatar-bubble`).
- Update any `Docs/UI_AUDIT.md` "Cleanup log" section so the deletion is traceable.

The boardgame-buddy cleanup pass (2026-05-23) is the reference for what this looks like end-to-end: dead function, dead CSS family, dead script tag, stale comment, all removed in one commit.

## 6. Object-aware file layout

Every web project follows the same module shape so the OOD intent is visible from the directory listing:

```
projects/<app>/web/
├── domain/         ← One file per core object: <object>.js (Game.js, Play.js, …)
├── ui/             ← One canonical render function per object: <object>-card.js, <object>-row.js, …
├── widgets/        ← Stateful multi-component widgets (scoring grid, parchment scroll)
├── views/          ← One file per screen / route — thin, composes ui/ + widgets/
├── index.html      ← Shell only (header, nav, view containers)
├── init.js         ← Router registration, view construction, auth boot
└── styles.css      ← All CSS — one section per object's class family
```

If a project does not have this layout yet (e.g. early prototype), add it as soon as the project crosses the 300-line-per-file threshold from `.claude/rules/web-frontend.md`.

## 7. Checklist when adding a new surface that shows a core object

- [ ] Is there a canonical render function in `ui/` for this object? If yes, use it.
- [ ] Does the surface need a tweak the canonical function doesn't support? Add an `opts` variant — do not write a parallel implementation.
- [ ] Are typography, color, and status badge unchanged? If you reached for a new font or accent, stop and reconsider.
- [ ] Is the navigation affordance (tap to open detail, etc.) consistent with the other surfaces that route to the same destination?
- [ ] Is any destructive action wired through the project's shared confirm modal?
- [ ] If a parallel implementation already exists somewhere else, did this change make it the second one — or did you delete the duplicate?
- [ ] If the change introduced a new core object, did you update `Docs/ARCHITECTURE.md` (or `STRUCTURE.md`) so future contributors know it exists?

## Related rules

- `.claude/rules/web-frontend.md` — vanilla-JS conventions, accessibility, motion.
- `.claude/rules/assets.md` — asset directory + naming.
- `.claude/rules/typed-js.md` — JSDoc `@typedef` for component option contracts.
- `.claude/rules/auth-ui.md` — auth screen visual standard (a specific instance of the "same object, same look" rule applied to OAuth buttons).
