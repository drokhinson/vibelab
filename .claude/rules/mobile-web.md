---
paths:
  - "projects/*/web/**"
---

# Mobile Web Hardening

The web prototypes are phone-first and several are installed as PWAs. iOS Safari
breaks a handful of things that look fine in desktop Chromium, and each break
has exactly one correct fix. This rule is the list.

Reference implementations, all in `projects/boardgame-buddy/web/`:
`ui/viewport-lock.js`, `ui/zoom-lock.js`, `ui/icons.js`, and the Layout block
plus the final block of `styles.css`.

---

## 1. The visible-viewport contract

**iOS Safari overlays the software keyboard without shrinking the layout
viewport.** `100vh`, `100dvh`, `position: fixed` and `position: sticky` all
resolve against that layout viewport, so a bottom action row sized by any of
them ends up underneath the keyboard. `dvh` does not cover it either: the
dynamic viewport tracks retractable browser UI (the URL bar), not interactive
widgets — whether the keyboard participates is governed by the viewport meta's
`interactive-widget` key, whose default is `resizes-visual` and which Safari
does not support.

`window.visualViewport` is the only API that reports the box actually on screen.
Publish it once, on `:root`, and let CSS read it:

```js
ROOT.style.setProperty("--vv-h",    Math.round(vv.height) + "px");
ROOT.style.setProperty("--vv-top",  Math.round(vv.offsetTop) + "px");
ROOT.style.setProperty("--kb-inset", inset + "px");   // innerHeight - height - offsetTop
ROOT.classList.toggle("kb-open", inset > KB_OPEN_PX);
```

Consumers read a **fallback ladder**, never a bare `var()`, so a browser without
`visualViewport` degrades cleanly:

```css
height: 100vh;                 /* no-dvh fallback   */
height: 100dvh;                /* drops the URL bar */
height: var(--vv-h, 100dvh);   /* drops the keyboard too */
```

Details that matter:

- **`KB_OPEN_PX ≈ 120`** — taller than any browser URL bar, shorter than any
  software keyboard. So `.kb-open` means "a keyboard is up", not "the URL bar
  retracted".
- **Listen to `resize` *and* `scroll`** on `visualViewport` — a scroll changes
  `offsetTop` without changing height — plus `orientationchange`.
- **Bail while pinch-zoomed** (`vv.scale > 1.01`): a zoomed page reports a
  shrunken box that has nothing to do with the keyboard. Hold the last good
  values; zooming out fires another event and refreshes them. Make this an early
  return, not an unsubscribe.
- Two passive listeners on the document is cheaper than making every modal
  acquire and release a lock, and it means the consuming fixes are pure CSS.

## 2. Three iOS zoom triggers, three unrelated fixes

Do not try to solve these with one mechanism. They are independent.

| Trigger | Fix | Where |
|---|---|---|
| **pinch** | `preventDefault()` on `gesturestart` / `gesturechange` / `gestureend` | a JS module (`ui/zoom-lock.js`) |
| **double-tap** | `touch-action: manipulation` on `html` | the stylesheet's Layout block |
| **focus auto-zoom** on a sub-16px control | a **16px font-size floor** | the last block of the stylesheet |

The viewport meta's `user-scalable=no` covers Android and iOS standalone, but
iOS Safari in a tab ignores it — hence the JS.

- **Gate the pinch blocker on `navigator.maxTouchPoints > 0`.** It reports 0 on
  desktop Safari, so a trackpad pinch still zooms as the user expects.
- **Do not add a multi-touch `touchstart` guard.** It looks like belt-and-braces
  and it breaks drag-to-reorder: WebKit can answer a `preventDefault()`ed second
  finger with `pointercancel`, and a drag handler routes `pointercancel` into its
  revert path — so a stray finger mid-drag silently reverts the drag.
- **`touch-action` goes on the root element on purpose.** It resolves by
  *intersecting* up the tree, so `manipulation` at the root cannot loosen a drag
  handle's `touch-action: none` further down. A JS double-tap suppressor would
  have to `preventDefault()` the second `touchend` and so would guess wrong about
  taps meant for a control — a swallowed click is a much worse bug than a stray
  zoom.
- Pin `-webkit-text-size-adjust: 100%` on `html`: WebKit inflates text on
  rotation to landscape otherwise. `100%` means "render at the author's size",
  not "ignore the user" — system Zoom and Dynamic Type are unaffected.

**Keep measuring and preventing in separate modules.** One publishes the visible
viewport; the other stops the scale changing. Folding the second into the first
would make that file's name a lie.

## 3. Specificity is managed by hand

The project stylesheet is the **last** stylesheet in the document, after the
DaisyUI/Tailwind pair. That means a `0,1,0` selector **ties** with a utility
class rather than losing to it, and the tie is decided by source order — which
the project always wins. Three idioms exist for this, and the right one depends
on which way you need the tie to go:

- **`:where()` to demote.** A size floor must be `0,0,0` or it beats every
  utility that was supposed to override it. A bare `[data-icon-name] { width: 1em }`
  tied with `.w-5`, won on source order, and made ~120 `w-N h-N` call sites do
  nothing — a `w-10` glyph rendered at 13px. `:where([data-icon-name])` is the
  fix. **Do not unwrap it.**
- **Class-doubling to win.** `.backdrop.my-sheet` beats a later base `.backdrop`
  rule that a bare `.my-sheet` would tie with and lose to. Same for
  `.widget.widget--inline`.
- **"This block must stay last in the file."** The 16px input floor is a set of
  `0,1,0` selectors whose win comes purely from source order. Adding a new
  sub-16px control means adding it *there*, not next to its component. A blanket
  `input, textarea, select { font-size: max(16px, 1em) }` does **not** work:
  element selectors are `0,0,1` and lose to every component class.

When a comment claims "the call sites still win on specificity", verify it by
computing both selectors. That claim was wrong once and cost every icon in the
app its size.

## 4. Icons must be built through the XML parser

**Never set `innerHTML` on an SVG-namespaced element.** It relies on the HTML
fragment parser's foreign-content path to create `<path>` in the SVG namespace.
Blink does; WebKit does not — so an `<svg>` full of HTML `<path>` elements sits
in the DOM, matches CSS, and lays out as nothing. Every icon in the app rendered
blank on iPhone, with no error.

```js
const doc = parser.parseFromString(
  '<svg xmlns="' + SVG_NS + '" viewBox="0 0 256 256">' + pathData + "</svg>",
  "image/svg+xml");
const root = doc.documentElement;
if (root && root.namespaceURI === SVG_NS && !doc.querySelector("parsererror")) {
  svg = document.importNode(root, true);
}   // else fall back to the innerHTML build rather than dropping the icon
```

Build each glyph **once per name and clone per call site**, rather than
re-parsing on every render pass. Re-run the icon pass after any `innerHTML`
patch — including inside sheets and modals.

See `.claude/rules/web-frontend.md` for the rest of the icon contract (vendored,
never CDN; Phosphor; a neutral fallback for names that come from the database).

## 5. Tap targets

Three sizes, used consistently:

| Size | For |
|---|---|
| **44px** | the floor for anything interactive (Apple HIG / WCAG 2.5.5 AAA) |
| **52px** | commit buttons — a sheet's Cancel/Confirm, a screen's primary CTA |
| **56px** | rows in a list, sheet or picker |

Rows get 56px rather than 44px because they sit flush against each other, so a
slightly-off thumb lands on the neighbour. 56px gives each row real separation.

**Enlarge the hit area without inflating the visible control** using a
pseudo-element with a negative inset:

```css
/* 44×44 hit area without changing how big the control looks. */
.small-icon-btn { position: relative; }
.small-icon-btn::before { content: ""; position: absolute; inset: -8px; }
```

Adjacent tappables keep ≥ 8px of clear space between hit zones.

**`:active` states are mandatory on every touch surface.** Touch has no hover, so
a row with no press feedback reads as *the tap didn't register* — far more
strongly than any millisecond count does. Relatedly: rebuilding a container
destroys the control under the user's finger before `:active` can apply, which
is one more reason to repaint surgically (`.claude/rules/overlays.md` §6).

## 6. The back gesture belongs to whatever is on top

The phone's back button (Android) and the edge swipe (iOS) are the same gesture
to the user as the × on the overlay they are looking at. An overlay is a
body-level element painted over a screen that never navigated, so unless
something claims that gesture the router answers it: the page *behind* the sheet
walks back and the sheet is left sitting on top of the wrong screen.

Claiming it costs **one history entry per overlay**, pushed at the same url as
the screen below so nothing about the address bar or a reload changes. The
mechanism, the router hand-off and the consumer list are
`.claude/rules/overlays.md` §8b; two things about it are phone facts rather than
design choices, and belong here:

- **With a keyboard up it takes two presses — the keyboard, then the overlay.**
  Android's own back-with-keyboard is swallowed by the system and never reaches
  the page, so this is what makes iOS and desktop agree with Android rather than
  what implements it.
- **The signal is the visible-viewport class from §1** (`.bgb-kb-open`), not "is
  a field focused". Android hides the keyboard on its back press *without*
  blurring anything, so a focus test would demand a third press for a keyboard
  that is already gone. A browser with no `visualViewport` never sets the class
  and closes on the first press — right for a device with no software keyboard.

Related: an overlay must not focus a text input on open (`overlays.md` §5). The
keyboard it raises buries the list the overlay exists to show, and on iOS a
sub-16px field also zooms the page (§2).

## 7. Fixed chrome

Every piece of fixed or sticky chrome:

- Sets **`box-sizing: border-box` explicitly**. Don't lean on Tailwind's
  preflight here — a `max-height` caps the content box, and padding plus borders
  land outside the cap.
- Offsets from the bottom as `calc(<nav-height-token> + env(safe-area-inset-bottom))`.
- Pins to the app's content column (`left: 50%` + `translateX(-50%)` +
  `max-width`), not the viewport — unless it is deliberately edge-to-edge, like
  the bottom nav itself.

See `.claude/rules/web-frontend.md` § App chrome & layering for the z-index
ladder and the sticky-vs-fixed rule.

**`viewport-fit=cover` is a deliberate, device-tested change, not a drive-by.**
Without it every `env(safe-area-inset-*)` resolves to 0px; turning it on shifts
the nav, the app's bottom padding, every docked bar and every modal at once.
Land it on its own, on a real device.

## Related rules

- `.claude/rules/overlays.md` — sheets, which depend on §1 of this file.
- `.claude/rules/web-frontend.md` — chrome, layering, icons, interaction.
- `.claude/rules/theming.md` — `color-scheme` and `meta[name=theme-color]`.
