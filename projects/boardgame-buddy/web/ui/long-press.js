// @ts-check
// ui/long-press.js — press-and-hold on a control that also has a tap action.
//
// Wired from inline attributes, so it survives any repaint that rebuilds the
// control's markup:
//
//   onpointerdown="BgbLongPress.start(event, () => …hold…)"
//   onpointermove="BgbLongPress.move(event)"
//   onpointerup="BgbLongPress.end()" onpointercancel="BgbLongPress.end()"
//   oncontextmenu="BgbLongPress.contextmenu(event, () => …hold…)"
//   onclick="…tap…"
//
// A hold that fired swallows the click its own release produces, wherever that
// click lands. It is not enough to ignore it on the control: the hold usually
// opens an overlay, the release then hit-tests onto that overlay's backdrop, and
// an unswallowed click there reads as a tap outside and closes it again.
//
// `contextmenu` is the second way in: Android raises it on a long touch, and a
// mouse right-click or the keyboard's menu key raise it too, which gives the
// hold action a non-touch path.
//
// The control needs `-webkit-touch-callout: none; user-select: none` in its CSS
// or iOS answers the same hold with its text-selection callout.
//
// One press at a time is all a thumb can make, so the state is module-level.

(function () {
  // Long enough that a deliberate tap never reaches it, short enough to land
  // before Android's own long-press (~500ms) raises contextmenu.
  const HOLD_MS = 450;
  // A finger that drifts further than this is scrolling, not holding.
  const SLOP_PX = 10;
  // The release's click follows the pointerup within a frame or two; anything
  // later is a new tap and must go through.
  const SWALLOW_MS = 600;

  let _timer = /** @type {any} */ (null);
  let _x = 0;
  let _y = 0;
  // A hold fired during the press now in progress (or just released).
  let _fired = false;
  // A primary press is down.
  let _active = false;
  let _upAt = 0;

  function cancel() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
  }

  function fire(/** @type {() => void} */ onHold) {
    cancel();
    _fired = true;
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) { /* unsupported */ } }
    onHold();
  }

  window.addEventListener("click", (e) => {
    if (!_fired) return;
    _fired = false;
    if (_active || Date.now() - _upAt < SWALLOW_MS) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  window.BgbLongPress = {
    /** @param {PointerEvent} e @param {() => void} onHold */
    start(e, onHold) {
      cancel();
      _fired = false;
      _active = false;
      if (e.button !== 0) return;
      _active = true;
      _x = e.clientX;
      _y = e.clientY;
      _timer = setTimeout(() => fire(onHold), HOLD_MS);
    },

    /** @param {PointerEvent} e */
    move(e) {
      if (!_timer) return;
      if (Math.abs(e.clientX - _x) > SLOP_PX || Math.abs(e.clientY - _y) > SLOP_PX) cancel();
    },

    end() {
      cancel();
      if (_active) _upAt = Date.now();
      _active = false;
    },

    /** @param {Event} e @param {() => void} onHold */
    contextmenu(e, onHold) {
      e.preventDefault();
      if (_fired) return;
      // Outside a press (right-click, the menu key) no click is coming to be
      // swallowed, so the hold runs without arming that.
      if (_active) fire(onHold);
      else onHold();
    },
  };
})();
