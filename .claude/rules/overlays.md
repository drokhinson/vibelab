---
paths:
  - "projects/*/web/**"
---

# Overlays — Sheets Over Dropdowns

Any control that presents a list of choices — pick a game, pick players, set a
status, filter a shelf — is a **bottom sheet**, not a `position: absolute`
dropdown hung off an input.

The canonical implementation is `projects/boardgame-buddy/web/ui/bottom-sheet.js`
(the shell) plus the `.bgb-sheet__*` family in that project's `styles.css` (the
chrome), with five consumers: `ui/status-tag.js`, `widgets/game-picker-sheet.js`,
`widgets/player-picker-sheet.js`, `widgets/game-search-sheet.js`,
`widgets/country-picker-sheet.js`.

---

## 1. Why a sheet, and when a dropdown is still fine

The argument is geometric, not aesthetic. An absolute list anchored to an input
inherits every constraint of wherever that input happens to sit:

- It must be measured against the visible viewport and shrunk, or flipped above
  the input, by a fit pass that has to exist at all (`ui/dropdown-fit.js`).
- It races the app's docked chrome on z-index and needs an explicit override to
  paint over a fixed CTA.
- The software keyboard doesn't shrink it, because it isn't positioned against
  anything the keyboard affects.

Measured on Gather before the migration: a four-player roster pushed the Players
card low enough that its buddy list clamped to 168px — one and a half rows of
seven — sitting on the Continue button and running off the bottom edge, before
the keyboard was even up.

A sheet is `position: fixed` at the top of the z-scale, sized off the visible
viewport (`.claude/rules/mobile-web.md` §1). None of that geometry is
expressible: no fit pass, no flip, no z-index race, and the keyboard shrinks it
correctly for free.

> **The general signal:** the codebase had been patched three separate times to
> survive the absolute-dropdown geometry. Three patches to survive a layout
> choice is the signal to change the layout choice, not to write a fourth.

**A dropdown is still right when it is already inside a fixed,
viewport-sized panel** — a finder rendered as an ordinary block inside a sheet
or a modal, mounted with an `inlineDropdown`-style opt so the fit pass stands
down. Anywhere else, a dropdown needs the fit pass, and needing the fit pass is
the argument for a sheet.

## 2. One shell, many sheets — lifecycle shared, appearance not

Exactly one primitive per project. It owns the **lifecycle only**; each sheet
writes its own panel markup and its own CSS family. Nothing about how a sheet
*looks* lives in the shell.

Extract it at **instance #2**, per `.claude/rules/ui-object-design.md` §4 — the
second sheet is the moment, not the fourth.

```js
const sheet = new BottomSheet({
  id: "bgb-game-picker-sheet",     // unique DOM id for the backdrop
  className: "game-picker-sheet",  // this sheet's own class
  label: "Choose a game",          // default aria-label
});

sheet.open({
  html,                    // the panel markup, as a string
  label,                   // overrides the config label
  returnFocus,             // Element|null — usually event.currentTarget
  onClick(e),              // delegated; anything the shell didn't handle
  onEscape() -> boolean,   // return true to SWALLOW this Escape
  onOpen(root),            // after it's in the DOM and icons are hydrated
  onClose(),
});
sheet.close();
sheet.isOpen;  // getter
```

What the shell must do:

- **Create at `<body>` level**, so the sheet survives the
  `container.innerHTML = …` swap any view does, and so the page behind it never
  moves. (This is also why §8 of `theming.md` exists — read it.)
- `role="dialog"`, `aria-modal="true"`, an `aria-label`.
- **Lock body scroll** on open, restore the previous value on close.
- **Delegated click** on the root: the backdrop itself closes,
  `[data-action="close"]` closes, everything else forwards to `onClick`.
- **Capture-phase Escape** with the `onEscape` first-refusal hook below.
- **Guarded focus return** (§5).
- **Close animation** on an `.is-closing` class, with the timeout constant
  commented as *must match the CSS animation duration*.
- **Orphan teardown**: a second `open()` while one is closing must clear the
  pending timer and sweep any stale node with the same id, or the teardown
  removes the new sheet.

Call-site convention: a plain options object, no positional args; `returnFocus`
from `event.currentTarget`; callbacks receive the **domain object**, not an id.

## 3. Anatomy

```
.<backdrop>.<shared-sheet-class>.<sheet-class>   dim + blur, align-items: flex-end
└─ __panel                                       flex column
   ├─ __grip     44×4 pill, aria-hidden          [flex: none]
   ├─ __title    display face, ellipsised        [flex: none]
   ├─ __sub      muted count line                [flex: none]
   ├─ __search   the filter field                [flex: none]
   ├─ __list     role="listbox"                  [flex: 1 1 auto ← the ONLY growable child]
   │   ├─ rows           min-height: 56px
   │   ├─ __sec          section heading
   │   └─ __empty        "No games match …"
   ├─ __foot     host for a confirm button       [flex: none]
   └─ __cancel   52px, data-action="close"       [flex: none]
```

**The list is the only growable child.** That is what keeps the grip, title and
search field on screen while the list scrolls inside the panel.

Panel requirements:

- `box-sizing: border-box`, **explicitly**. `max-height` caps the content box,
  so padding and borders land outside the cap. Do not lean on Tailwind's
  preflight for fixed chrome.
- Bottom padding `max(16px, env(safe-area-inset-bottom))`.
- `overscroll-behavior: contain` on the list, so a flick at its end doesn't
  scroll the page behind.
- Rows are **56px**, not 44px: rows sit flush against each other, so a
  slightly-off thumb lands on the neighbour. Commit and cancel buttons are 52px.
  See `.claude/rules/mobile-web.md` §5.
- Focus rings on rows are **inset** (`outline-offset: -3px`) — the scroller
  clips an outset ring.
- Selection reads `aria-selected` inside `role="listbox"` for single-select and
  `aria-checked` for multi-select.

**Backdrop rules must be doubled up.** A backdrop rule added by a sheet's own
class must select `.<backdrop-class>.<sheet-class>`, not the bare sheet class:
the base backdrop rule is later in the stylesheet and sets
`align-items: center`, so a single-class selector *ties* and loses on source
order — and the sheet renders centred. Same trick applies to any inline variant
of a shared widget.

## 4. The software keyboard

**A panel ceiling expressed in `vh` is a bug.** `vh` is the *layout* viewport,
which the software keyboard does not shrink; the backdrop around it tracks the
*visible* viewport, which does. With `align-items: flex-end`, the overhang goes
off the **top** — carrying the title and the search field with it, leaving a
list you cannot search and a Cancel button. Measured at 390×844 with a 364px
keyboard: a 683px panel in a 480px box, overhanging 203px.

```css
.sheet__panel                        { max-height: min(80%, 660px); }  /* % of the backdrop */
:root.kb-open .sheet__panel          { max-height: 100%; }
```

Holding back 20% so the page peeks through is a luxury there is no room for once
a keyboard is on screen.

**An anti-jump pin must be a custom property, not an inline `min-height`.**
Pinning the list at the height it opened with stops the sheet walking up and
down the screen on every keystroke that narrows the results. But a pin measured
before the keyboard arrived is a floor the shrunken panel cannot honour, so the
stylesheet has to be able to drop it — and an inline style out-specifies any
rule trying to:

```js
if (list) list.style.setProperty("--sheet-list-min", list.clientHeight + "px");
```
```css
.sheet__list                  { min-height: var(--sheet-list-min, 0); }
:root.kb-open .sheet__list    { min-height: 0; }
```

Stability while typing matters less than staying on screen.

## 5. Focus and Escape

**Escape is layered.** The sheet gets first refusal via `onEscape` returning
`true` to swallow the event — a sheet with a search field wants the first Escape
to clear the query and only the second to close:

```js
onEscape: () => { if (!this._query) return false; this._clear(); return true; },
```

Escape clears the query; it does **not** unwind multi-select ticks. That is what
Cancel is for.

**Return focus only if focus is still inside the sheet.** A pick that
re-rendered the originating control leaves a detached node behind:

```js
if (back && back.isConnected && root.contains(document.activeElement)) back.focus();
```

Where a repaint destroyed the trigger, recover **only when focus actually fell
through** to `<body>` — never steal it from wherever the user has moved on to.

**Focus-on-open is a per-sheet judgement, and it gets argued in a comment.**
There is no default:

- A sheet the user opened to *read* focuses the current selection, not the
  search box — opening it should not throw a keyboard over the list. Tapping the
  field is the opt-in.
- A sheet where adding is a typing task as often as a picking one focuses the
  input, provided the list is short enough that the keyboard doesn't bury it.
- A radio-group sheet focuses the checked row, so a keyboard or screen-reader
  user hears their current state before the alternatives.

The shell is **not** a focus trap. Escape, backdrop tap, an explicit close
control, `aria-modal` and the scroll lock are the contract.

## 6. Repaint surgically

Filtering, ticking and picking patch **the list host only** — never the panel.
Re-rendering the panel blows away the input the user is typing into, along with
its focus and its caret.

```js
host.innerHTML = this._renderList();
host.scrollTop = keepScroll ? top : 0;
window.BgbIcons.render(host);   // re-hydrate icons after every innerHTML patch
```

- Ticking preserves scroll — it must not scroll the list out from under the
  thumb.
- A confirm button that shows a count lives in its own `__foot` host, so the
  count can be patched without touching the list being scrolled.
- Reserve the tick column whether or not a row is ticked, so ticking doesn't
  reflow the name beside it.

## 7. Centred modals are a separate family

A sheet is bottom-anchored and list-shaped. A modal is centred and card-shaped
(a wrap-up card, a confirm, an editor). They **share the backdrop and card CSS**
for visual consistency; they do not share the shell.

- Pick **one** destructive-confirm surface for the whole project and use it
  everywhere — see `.claude/rules/web-frontend.md` and
  `.claude/rules/ui-object-design.md` §3c. A bottom sheet is a legitimate choice
  of that surface, as long as it is the only one.
- **Known consolidation debt in boardgame-buddy:** `widgets/play-detail-popup.js`,
  `widgets/outbox-modal.js`, `widgets/add-game-modal.js` and
  `widgets/import-expansions-modal.js` each re-implement `_previousFocus`,
  `_escHandler` and singleton-by-id. That is instance #4 of a lifecycle the
  sheet shell already solves. Extract a modal shell the next time one of them is
  touched substantively.

## Anti-patterns to refactor away when touching a project

- Any `position: absolute` list anchored to an input that is **not** already
  inside a fixed, viewport-sized panel. If it needs a fit pass, a flip, or an
  explicit z-index to clear docked chrome, it wants to be a sheet.
- A picker that hides itself on zero matches. That is where the "add it as new"
  affordance belongs; hiding makes the escape hatch invisible unless the user
  already knew Enter would do it.
- A single-select combo used to pick N things one at a time. If the underlying
  model is a set (a roster, a tag list), the sheet is multi-select with one
  confirm — and tick order is preserved, because it is often the model's order.
- A per-screen bespoke dialog for a destructive action.

## Related rules

- `.claude/rules/mobile-web.md` — the visible-viewport contract a sheet sits on.
- `.claude/rules/theming.md` §8 — why a body-level sheet needs naming in the
  re-point list.
- `.claude/rules/ui-object-design.md` — extract at instance #2; one affordance
  per destination.
