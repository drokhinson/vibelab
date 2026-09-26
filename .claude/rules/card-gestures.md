---
paths:
  - "projects/*/web/**"
---

# Expandable Cards — Open, Swipe, Pull to Close

A card in a feed or reel that opens into a detail view, which can be swiped
between neighbours and pulled down to close. The reference implementation is
boardgame-buddy's play-detail popup:

| Concern | File |
|---|---|
| The popup (shell, render, `show`/`load`, `renderCardFor`) | `web/widgets/play-detail-popup.js` |
| Photo flight between card and popup, both ways | `web/widgets/play-detail-flight.js` |
| Pull down to close | `web/widgets/play-detail-collapse.js` |
| Swipe / arrows / keys between neighbours, preload | `web/widgets/play-detail-pager.js` |
| The card | `web/ui/play-card.js` |

It sits on the modal shell and the four exits in `.claude/rules/overlays.md`.
Nothing here replaces that file; this one covers the gestures and the motion.

---

## 1. The detail view IS the card, expanded

The user should read it as one object growing, not as a new screen appearing.
Three things make that true:

- **Same layout order.** The expanded view keeps the card's reading order: if
  the card is photo-then-caption, so is the detail view (and its edit form). A
  detail view that leads with the title a card puts under its photo reads as a
  different object.
- **A shared-element flight both ways.** On open, the card's image lifts out of
  the card and grows into its place in the detail view. On close it shrinks back
  into the same card. Write the keyframes **once**, card-end to detail-end, and
  run them reversed for the other direction, so opening and closing are
  visibly one motion.
- **The flight has a snap.** At about 20% of the flight the image lifts a few
  px, swells about 5% and tilts a degree or two off whatever it is *leaving*,
  then settles flat into where it's going. The small lift is what reads as
  physical.

## 2. Flyer mechanics

The flyer is a **body-level, `position: fixed`** copy of the image: a wrapper
holding an `<img>` plus any overlay the card paints on its photo. Rules that
each fixed a visible bug:

- **Animate every visual difference between the two ends INTO its resting
  value.** The drop shadow (the detail image casts one, the card's doesn't), the
  card's shade gradient, the corner radius. A property left fixed on the flyer
  changes in the single frame the flyer is swapped for the real element, and
  reads as a blink.
- **When the flyer matches what's under it, remove it in one frame.** A
  cross-fade shows the destination's own landing animation through a copy that
  isn't doing it.
- **Land on where the image actually is, not on its frame.** A photo shown with
  `object-fit: contain` is letterboxed. Compute the contained rect from
  `naturalWidth/Height`, or the flight ends stretched to the frame's edges.
- **Clip the flyer to what's visible of the card.** Nothing clips a fixed flyer
  the way a sideways rail clips the card inside it. Intersect the card's rect
  with every ancestor whose overflow isn't `visible` and with the viewport
  (`visibleRect`), and animate a `clip-path: inset()` to those insets at the
  card's end. Start the other end at a **negative** inset, because a clip-path
  also cuts the drop shadow.
- **Reveal a half-hidden card before a landing.** Scroll it into view first,
  with `behavior: "instant"`, while the detail view's backdrop still covers the
  page. With mandatory scroll-snap, scroll to the **snap's own alignment**
  (`inline: "start"` for `scroll-snap-align: start`). Any other stop gets
  re-snapped after you've measured, and the flyer lands where the card used to
  be.
- **Every image the card and the detail view share flies, each as its own
  flyer.** The photo, and anything laid ON it: a box-art badge on a polaroid's
  photo is covered by the photo flyer, and appears the moment that flyer is
  removed. Fly it too, one layer above, from its plate on the card to its twin
  in the detail view (the plate's border and shadow keyframed in and out). Hide
  the covered element for the flight and reveal it in the frame its flyer
  lands. Clip BOTH ends to what's visible: the detail end can be half scrolled
  out of its own scroller.
- **A card with no visible area is not a landing target.** Skip the flight and
  just close.
- **Measure the detail end where it will FINISH.** The detail card's usual
  entrance (a rise) moves the image mid-flight. While flying, the entrance is
  fade-only (a root class that swaps the animation name). Keep that class on:
  removing it would restart the entrance.
- **Don't hold the open back for a slow image.** Wait for `decode()`, capped at
  about 150ms, then skip the flight rather than stall.
- **Reduced motion: no flight, no slide.** Swap or close instantly.

## 3. Gesture state lives on the ROOT, not the card

If the detail view repaints by morphing or innerHTML, it rewrites the card's own
attributes. A revalidation landing mid-drag wipes an inline `transform` or a
class on the card and snaps it back. Put drag state on the **morph root** (the
backdrop, whose own attributes are never patched) as custom properties, and let
CSS read them:

```css
.backdrop.is-pulled .card {
  animation: none;
  transform: translate(var(--dx, 0px), var(--drag, 0px)) scale(var(--scale, 1));
}
```

- **One transform for every axis.** Two rules each setting `transform` for their
  own gesture undo each other.
- **`animation: none` as soon as a gesture starts, and never back on.** An
  entrance animation with `fill: both` outranks the drag transform. Removing
  `none` later replays the entrance.
- **Anything added beside the card during a gesture goes on `<body>`**, not
  inside the morph root. The next repaint would delete a child it didn't paint.

## 4. Pull down to close

- **Track only when the content is at its top**, or when the drag starts on the
  header (which never scrolls). Mid-scroll, a downward drag is the scroll going
  back up.
- **Commit on distance or on a flick:** about 110px, or ≥0.55 px/ms over the
  last moves with at least ~36px travelled. Otherwise spring back on the same
  curve the card uses elsewhere.
- **Feedback while pulling:** the card follows the finger with a slight shrink
  (≤6%), and the dim lifts with the pull.
- **Close = fly back (§1–2) + the card drops away + the backdrop fades.**
  Measure everything before calling close, because the reset clears state the
  markup reads.

## 5. Swipe between neighbours

- **The sequence is the set the card sits in.** Use its own visual group (a
  session row, one reel), in DOM order, which is the order the user was
  reading. Never the whole screen: a card logged on its own is a separate thing
  to open, not the next page of the group above it.
- **A set of one gets no pager.** No arrows, no count, no gesture listener. The
  same goes for an open from somewhere with no card behind it (a notification,
  a text list).
- **Grouped cards that open a different surface** (a "12 identical plays" run
  card that opens a sheet) are left out of the sequence.
- **Show the neighbour DURING the drag.** Waiting for the current card to leave
  before the next appears reads as a page load.
  - When a sideways drag starts, lay a copy of each neighbouring card beside the
    real one (card width + ~16px gap) and move them with the finger.
  - On commit, animate the real card out and the incoming copy to centre
    together.
  - Then, **in one frame**: load the neighbour into the real card, reset its
    scroll, put it back at centre with no transition, and remove the copies.
  - The copies must be the detail view's **exact markup** for that item, from
    the same pure `renderCardFor(item)` the real render uses. That's what makes
    the swap invisible.
- **The neighbours are persistent: never create or destroy a card where it can
  be seen.** Building the copies on drag start and dropping them after each
  turn looked fine on a phone, where "beside the card" is off-screen, and
  blinked on an iPad, where it isn't.
  - Keep one copy per neighbour for as long as the view is open, reconciled by
    an idempotent `sync()` after every repaint. There are none while editing,
    saving or covered.
  - Copies fade in when they appear and fade out on exit.
  - A turn rebuilds them only at positions where identical content already
    sits (a copy of the item just left, in the slot the real card just shrank
    into, with its scroll offset carried over).
  - Verify with a per-frame check: any card that leaves the screen must be
    replaced in the same frame by one at the same rect.
- **On wide screens it's a carousel.**
  - The offset is `max(cardW/2 + peekScale·cardW/2 + gap, viewportW/2)`, so a
    tablet shows half a card at each edge while a phone keeps them off-screen.
  - Scale and opacity are functions of distance from centre (about 0.85 and
    0.65 at rest), applied to the real card too, so a card grows as it slides
    in.
  - Every card shares ONE vertical centre line: centre the detail view on
    tablet tiers and pin each copy with `top: centreLine` +
    `translateY(-50%)`, scaling about its centre. A top computed from the
    copy's height drifts, because the height isn't final until its image has
    laid out.
  - Tapping a peek turns to it. Put `inert` on the copy's children, not the
    copy, so the copy still takes the tap.
- **Reserve a copy's image box before it loads.** A freshly inserted `<img>` is
  not complete in its first frame, even when cached and decoded, so it lays
  out 0px tall. Remember natural sizes (from the preload and from images already
  on screen) and stamp `aspect-ratio` on the copy's images. Don't use
  `width`/`height` attributes, which pin the natural width where the real image
  stretches.
- **Copies never carry a scroll offset.** A play read to the bottom otherwise
  comes back in scrolled there and snaps when it arrives. Instead the leaving
  card eases to its top during the slide, so it lands in the side slot matching
  its copy. Kill iOS momentum first with `overflow: hidden`: Safari ignores a
  `scrollTop` written mid-flick.
- **Commit a start state before the first turn's transition.** Taking the
  card off its entrance animation, giving it the gesture transform and asking
  it to transition, all in one style change, starts no transition. The card
  jumps. Add the gesture class, paint the rest position and force a reflow
  first.
- **End a turn on `transitionend`,** with a timer only as the backstop. A timer
  set to the duration can fire before the last frame, and the swap then snaps
  the final few px.
- **Preload the whole set when the detail view opens:** fetch *and*
  `decode()` every image a page turn can reach. Feed images are usually
  `loading="lazy"`, so cards off the side of a rail have never been fetched,
  and a copy that slides in under the finger has no time to wait.
- **Rubber-band at the ends.** The card still moves, at about a quarter of the
  finger, and springs back. It says "that's the last one" instead of ignoring
  the touch.
- **Commit on ~72px or a flick** in the drag's direction.
- **Arrows and a count** ("2 of 3") in the header: 44px targets, disabled at the
  ends. They're the whole feature for a mouse, and the count is how a touch user
  learns there's anything to swipe to. The ←/→ keys use the same turn, but not
  from inside a field.
- **Keep the current item's card in view behind the backdrop** after each turn
  (instant `scrollIntoView`, snap alignment as in §2), so a pull-to-close from
  the third item still flies back into a visible card.
- **A page turn swaps content inside the same overlay.** It's not a close and a
  reopen: the back guard, the scroll lock and the gestures all stay.

## 6. Gestures must not fight each other or the content

- **Axis lock after the slop (~8px).** Whichever axis wins first owns the touch
  until it ends. Re-deciding mid-drag hijacks a scroll that's already under way.
- **`preventDefault()` on every move once a gesture is yours.** One
  un-prevented move hands the touch back to the scroller or to iOS's rubber
  band. Listen to `touchmove` with `{ passive: false }`, and keep
  `touchstart`/`touchend` passive.
- **Stand down over content that owns the axis:** a sideways scroller (a scores
  grid) for horizontal, any form field for both.
- **Stand down while editing, saving, or while another overlay is stacked on
  top.** A pull would discard a draft, and a turn would swap the record out from
  under a form.
- **Touches outside the card aren't drags.** A tap on the dim backdrop is the
  outside-tap exit (`overlays.md` §8a).
- **Touch-only gestures, with an equivalent for everyone else.** Pull-to-close
  already has ×/Escape/back/outside tap. Swipe gets its arrows and keys.

## 7. The page behind must actually be still

- **Check the scroll lock reaches the viewport.** `body { overflow: hidden }`
  only locks the page when `<html>`'s overflow is `visible`. Boardgame-buddy's
  `<html>` has `overflow-x: hidden`, so every overlay's lock silently did nothing
  and the feed scrolled behind the card. The fix was one rule:
  `html:has(> body[style*="overflow: hidden"]) { overflow: hidden; }`.
- **`overscroll-behavior: contain`** on the detail view's scroller.
- **Script can still scroll a locked page.** That's how §2's reveal and §5's
  keep-in-view work, so don't reach for a lock that blocks it.

- **The detail view opens at its top and stays there until the reader
  scrolls.** Keep a "pinned" flag from open (and from each page turn) until
  the first real scroll intent inside the scroller: a vertical drag, the
  wheel, a scrolling key, or focus moving in. Until then, re-pin to 0 after
  every repaint, when any image in it loads, and one frame after showing.
  Never pin in edit mode, because focusing a field scrolls the form to it. Also
  set `overflow-anchor: none` on the scroller and reserve image boxes, so
  nothing the reader didn't do can move what they're reading.

## 8. The card itself on touch

- **Hover transforms go under `@media (hover: hover)`.** On touch, a tap leaves
  the element "hovered" until the next tap elsewhere, so a hover lift sticks
  after the detail view opens and closes.
- **Keep an `:active` press state** (a ~0.985 scale) unconditionally
  (`web-frontend.md`).

## 9. Verifying it

These are timing bugs, and a screenshot usually lands after the interesting
frame. What worked:

- Playwright with a phone profile (`devices['iPhone 13']`), driving touches with
  CDP `Input.dispatchTouchEvent` (`touchStart` / `touchMove` in ~15px steps /
  `touchEnd`). `page.touchscreen` only taps.
- Load the real `index.html`, inject cards into the view container, and stub the
  domain's seed/get functions. That exercises the real popup, not a mock.
- **Sample, don't screenshot:** read the flyer's `getBoundingClientRect()`
  every ~50ms inside one `page.evaluate` to see the whole flight. Assert the
  end state too: no flyer, no leftover copies, the card's transform back to
  identity, the image `visibility: visible`.
- Aim touches **inside the card** (compute its rect first). A short test card
  leaves fixed coordinates on the backdrop, and the gesture correctly ignores
  them.
- Cover the edges: a card half off its rail, a rail too narrow to show the whole
  card, a set of one, both ends of a set, and pull-to-close after a page turn.

## Related rules

- `.claude/rules/overlays.md` — the modal shell, the four exits, the back guard.
- `.claude/rules/mobile-web.md` — visible viewport, tap targets, the back gesture.
- `.claude/rules/web-frontend.md` — motion, press states, surgical repaint.
- `.claude/rules/ui-object-design.md` — one object, one card; same action, same
  affordance.
