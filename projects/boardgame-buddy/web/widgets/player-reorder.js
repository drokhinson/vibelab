// widgets/player-reorder.js — press-and-hold-the-grip drag reorder for the
// host's Gather player list.
//
// Why this exists: the scoring grid's columns ARE the players array order.
// widgets/round-score-grid.js maps that array straight to <th>/<td> with no
// sort anywhere, so moving a row here moves a column there — and, once the
// order is pushed to the lobby roster (migration 056), on every spectator's
// mirror too. Seating order at the table rarely matches the order names got
// typed in.
//
// ONE delegated pointer machine per <ul>, not one per <li>. play-flow-view's
// _refreshPlayersList() rebuilds the list with `ul.innerHTML = …` on every poll
// tick that changes the roster, which would orphan per-row listeners; the <ul>
// itself survives that. bind() is therefore idempotent (it flags the node) and
// safe to call after every paint.
//
// Ported from projects/travel-scrapbook/web/widgets/timeline-gestures.js —
// same Pointer Events shape, same deferred pointer capture, same rAF edge
// auto-scroll, same capture-phase click swallower. What is new here is
// index-insertion: that widget drops onto a container, this one has to land
// between two rows, so the dragged <li> is moved through the live list as the
// finger passes each midpoint and the list itself parts around it. No separate
// drop indicator to keep in sync with anything.

(function () {
  // The grip is an explicit handle, so pick-up is fast — there is no "was that
  // a tap or a scroll?" to disambiguate the way a whole-row long-press has.
  // (game-detail-view's rulebook hold is 600ms for exactly that reason.)
  const HOLD_MS = 120;
  // …and any real movement starting on the grip is a drag, hold or no hold.
  const MOVE_START = 3;
  // Auto-scroll when the pointer comes within EDGE px of the scroller's edge.
  const EDGE = 80;
  const SCROLL_MAX = 14;

  // Module-level so the lobby poll can ask "is a drag in flight?" without
  // holding a reference to whichever list is bound.
  let active = null;

  function rowsOf(listEl, rowSelector, except) {
    return Array.prototype.filter.call(
      listEl.children,
      (el) => el.matches(rowSelector) && el !== except
    );
  }

  function indexOf(listEl, rowSelector, li) {
    return rowsOf(listEl, rowSelector, null).indexOf(li);
  }

  // The element that actually scrolls behind the list. Resolved per drag rather
  // than assumed: the cascade has been both a document scroller and an inner
  // one, and scrolling the wrong box during a drag does nothing at all.
  function scrollerFor(el) {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const st = window.getComputedStyle(n);
      if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight) return n;
    }
    return null; // → the window
  }

  function bind(listEl, handlers) {
    if (!listEl || listEl.dataset.reorderBound === "1") return;
    listEl.dataset.reorderBound = "1";

    const rowSelector = handlers.rowSelector || ".cascade-player";
    const handleSelector = handlers.handleSelector || ".cascade-player__grip";

    let mode = "idle";           // idle | pending | drag
    let pointerId = null;
    let pressTimer = null;
    let startX = 0, startY = 0, lastX = 0, lastY = 0;
    let li = null, fromIndex = -1, restoreRef = null;
    let clone = null, grabX = 0, grabY = 0;
    let rafId = null, scroller = null;
    let suppressClick = false;

    const clearTimer = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    };

    const positionClone = () => {
      if (clone) clone.style.transform =
        `translate(${lastX - grabX}px, ${lastY - grabY}px)`;
    };

    function makeClone() {
      const rect = li.getBoundingClientRect();
      grabX = lastX - rect.left;
      grabY = lastY - rect.top;
      clone = li.cloneNode(true);
      // cloneNode copies the value ATTRIBUTE, not the live property, so a
      // half-typed initials or team field would vanish from the clone while the
      // real row still holds it. Copy the live values across.
      const src = li.querySelectorAll("input");
      const dst = clone.querySelectorAll("input");
      for (let i = 0; i < src.length && i < dst.length; i++) dst[i].value = src[i].value;
      clone.classList.add("cascade-player--drag-clone");
      clone.classList.remove("is-dragging");
      clone.style.width = `${rect.width}px`;
      document.body.appendChild(clone);
      positionClone();
    }

    function autoScrollTick() {
      if (mode !== "drag") return;
      const top = scroller ? scroller.getBoundingClientRect().top : 0;
      const bottom = scroller
        ? scroller.getBoundingClientRect().bottom
        : window.innerHeight;
      let dy = 0;
      if (lastY - top < EDGE) dy = -SCROLL_MAX * (1 - Math.max(0, lastY - top) / EDGE);
      else if (bottom - lastY < EDGE) dy = SCROLL_MAX * (1 - Math.max(0, bottom - lastY) / EDGE);
      if (dy) {
        if (scroller) scroller.scrollTop += dy;
        else window.scrollBy(0, dy);
        reflow();
      }
      rafId = requestAnimationFrame(autoScrollTick);
    }

    // Slide the dragged row to wherever the pointer currently sits. The list
    // parts around it as it goes, so what the host sees mid-drag is the result.
    function reflow() {
      let ref = null;
      for (const el of rowsOf(listEl, rowSelector, li)) {
        const r = el.getBoundingClientRect();
        if (lastY < r.top + r.height / 2) { ref = el; break; }
      }
      if (ref !== li.nextElementSibling) listEl.insertBefore(li, ref);
    }

    function startDrag() {
      clearTimer();
      if (mode !== "pending" || !li || !li.isConnected) { reset(); return; }
      mode = "drag";
      active = { cancel };
      fromIndex = indexOf(listEl, rowSelector, li);
      restoreRef = li.nextElementSibling;
      scroller = scrollerFor(listEl);
      // Captured HERE, not on pointerdown: capturing before the gesture is real
      // swallows the taps that were only ever going to be taps.
      try { listEl.setPointerCapture(pointerId); } catch (_) {}
      makeClone();
      li.classList.add("is-dragging");
      listEl.classList.add("is-reordering");
      if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
      rafId = requestAnimationFrame(autoScrollTick);
    }

    function reset() {
      clearTimer();
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      if (pointerId != null) {
        try { listEl.releasePointerCapture(pointerId); } catch (_) {}
      }
      if (clone && clone.parentNode) clone.parentNode.removeChild(clone);
      clone = null;
      if (li) li.classList.remove("is-dragging");
      listEl.classList.remove("is-reordering");
      mode = "idle";
      pointerId = null;
      li = null;
      restoreRef = null;
      scroller = null;
      active = null;
    }

    // Abandon without committing — pointercancel, or an unmount mid-drag.
    function cancel() {
      if (mode === "drag" && li && li.isConnected) {
        listEl.insertBefore(li, restoreRef);
      }
      reset();
    }

    listEl.addEventListener("pointerdown", (e) => {
      if (mode !== "idle") return;
      // Mouse: primary button only. Touch and pen report button 0.
      if (e.button != null && e.button !== 0) return;
      const handle = e.target.closest && e.target.closest(handleSelector);
      if (!handle || !listEl.contains(handle)) return;
      const row = handle.closest(rowSelector);
      if (!row || row.parentElement !== listEl) return;
      li = row;
      pointerId = e.pointerId;
      startX = lastX = e.clientX;
      startY = lastY = e.clientY;
      mode = "pending";
      // Stops the mouse from starting a text selection across the row.
      e.preventDefault();
      pressTimer = setTimeout(startDrag, HOLD_MS);
    });

    listEl.addEventListener("pointermove", (e) => {
      if (mode === "idle" || e.pointerId !== pointerId) return;
      lastX = e.clientX;
      lastY = e.clientY;
      // Something repainted the list out from under the gesture. Shouldn't
      // happen — play-flow-view gates its poll on isDragging() — but a stranded
      // clone and a stuck capture are worse than a lost drag.
      if (li && !li.isConnected) { reset(); return; }
      if (mode === "pending") {
        if (Math.abs(e.clientX - startX) > MOVE_START ||
            Math.abs(e.clientY - startY) > MOVE_START) startDrag();
        return;
      }
      e.preventDefault();
      positionClone();
      reflow();
    });

    listEl.addEventListener("pointerup", (e) => {
      if (mode === "idle" || e.pointerId !== pointerId) return;
      if (mode !== "drag") { reset(); return; }   // a plain tap on the grip
      const row = li;
      const to = indexOf(listEl, rowSelector, row);
      const from = fromIndex;
      suppressClick = true;
      // Cleared on the next task, after the synthetic click would have fired.
      setTimeout(() => { suppressClick = false; }, 0);
      reset();
      if (to >= 0 && to !== from && handlers.onReorder) handlers.onReorder(from, to);
    });

    listEl.addEventListener("pointercancel", (e) => {
      if (e.pointerId !== pointerId) return;
      cancel();
    });

    // The click that lands under the finger after a drop would otherwise hit
    // whichever row ended up there — including its Remove button.
    listEl.addEventListener("click", (e) => {
      if (!suppressClick) return;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }

  window.PlayerReorder = {
    bind,
    /** True while a row is picked up. Read by play-flow-view's lobby poll. */
    isDragging() { return !!active; },
    /** Abandon any drag in flight, restoring the row. For onUnmount. */
    cancel() { if (active) active.cancel(); },
  };
})();
