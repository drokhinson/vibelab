// widgets/timeline-gestures.js — swipe + press-and-hold gestures for the trip
// Timeline's plan rows. Render (ui/trip-timeline.js) emits the scaffold:
//   .tl-swipe[data-scrap-id][data-plan-date]  → one plan
//     .tl-swipe__action--schedule             → revealed on swipe RIGHT
//     .tl-swipe__action--remove               → revealed on swipe LEFT (scheduled only)
//     .tl-row.tl-row--draggable               → the sliding foreground
// Day cards carry .tl-day[data-day-date] and act as drop targets.
//
// One pointer state machine per row disambiguates three gestures:
//   • horizontal drag past a threshold → swipe (schedule / unschedule),
//   • press-and-hold (stationary) then move → pick the card up and drop on a day,
//   • everything else → snap back (vertical moves fall through to native scroll).
// Buttons inside a row (the checkbox, the "keep here" pin) are left alone so
// their native click still fires. Uses Pointer Events + pointer capture, so no
// window-level listeners leak across the view's frequent re-renders.
'use strict';

const TimelineGestures = (function () {
  const LONGPRESS_MS = 320;   // hold this long (stationary) → pick the card up
  const MOVE_TOLERANCE = 8;   // px of movement that ends the "is it a hold?" window
  const SWIPE_COMMIT = 72;    // px past which a swipe fires its action
  const SWIPE_MAX = 132;      // px clamp on how far the row slides
  const GRIP_HOLD_MS = 120;   // grip is an explicit handle → pick up fast
  const GRIP_MOVE = 3;        // px of movement from the grip that starts a drag
  const EDGE = 80;            // px from viewport edge that auto-scrolls while dragging
  const SCROLL_MAX = 14;      // px/frame auto-scroll speed at the very edge

  function bindRow(swipeEl, handlers, canWrite) {
    const fg = swipeEl.querySelector('.tl-row');
    if (!fg) return;
    const scrapId = swipeEl.dataset.scrapId;
    const scheduled = !!swipeEl.dataset.planDate;

    let startX = 0, startY = 0, dx = 0, dy = 0;
    let mode = 'idle';           // idle | pending | swipe | drag
    let pointerId = null;
    let pressTimer = null;
    let fromGrip = false;        // did this gesture start on the drag handle?
    let clone = null, grabX = 0, grabY = 0, dropDayEl = null;
    let rafId = null, lastClientX = 0, lastClientY = 0;

    const clearTimer = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };

    const snapBack = () => {
      fg.style.transition = '';
      fg.style.transform = '';
      swipeEl.classList.remove('is-swiping', 'is-swipe-schedule', 'is-swipe-remove');
    };

    const positionClone = (e) => {
      if (clone) clone.style.transform = `translate(${e.clientX - grabX}px, ${e.clientY - grabY}px)`;
    };

    const highlightDay = (e) => {
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const dayEl = under && under.closest('.tl-day[data-day-date]');
      if (dayEl === dropDayEl) return;
      dropDayEl?.classList.remove('tl-day--drop');
      if (dayEl) dayEl.classList.add('tl-day--drop');
      dropDayEl = dayEl;
    };

    // While dragging, scroll the page when the finger nears the top/bottom edge
    // so off-screen days (e.g. Anytime → Day 2) become reachable. The clone is
    // position:fixed, so it stays under the finger as the page scrolls beneath.
    const autoScrollTick = () => {
      if (mode !== 'drag') { rafId = null; return; }
      const h = window.innerHeight;
      let step = 0;
      if (lastClientY < EDGE) step = -Math.ceil(SCROLL_MAX * (EDGE - lastClientY) / EDGE);
      else if (lastClientY > h - EDGE) step = Math.ceil(SCROLL_MAX * (lastClientY - (h - EDGE)) / EDGE);
      if (step) {
        window.scrollBy(0, step);
        highlightDay({ clientX: lastClientX, clientY: lastClientY });
      }
      rafId = requestAnimationFrame(autoScrollTick);
    };

    const startDrag = (e) => {
      mode = 'drag';
      swipeEl.classList.add('is-dragging');
      fg.style.touchAction = 'none';   // best-effort for the body long-press path
      const r = fg.getBoundingClientRect();
      grabX = e.clientX - r.left;
      grabY = e.clientY - r.top;
      clone = fg.cloneNode(true);
      clone.classList.add('tl-drag-clone');
      clone.style.width = `${r.width}px`;
      document.body.appendChild(clone);   // icons are already rendered SVGs — clone carries them
      lastClientX = e.clientX; lastClientY = e.clientY;
      positionClone(e);
      highlightDay(e);
      navigator.vibrate?.(10);
      if (!rafId) rafId = requestAnimationFrame(autoScrollTick);
    };

    const cleanupDrag = () => {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      dropDayEl?.classList.remove('tl-day--drop');
      dropDayEl = null;
      if (clone) { clone.remove(); clone = null; }
      swipeEl.classList.remove('is-dragging');
      fg.style.touchAction = '';
      fromGrip = false;
    };

    const onDown = (e) => {
      if (!canWrite || mode !== 'idle') return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('button')) return;   // checkbox / pin keep their click
      fromGrip = !!e.target.closest('.tl-row__grip');   // the explicit drag handle
      pointerId = e.pointerId;
      startX = e.clientX; startY = e.clientY; dx = 0; dy = 0;
      mode = 'pending';
      fg.style.transition = 'none';
      clearTimer();
      pressTimer = setTimeout(() => { if (mode === 'pending') startDrag(e); },
                              fromGrip ? GRIP_HOLD_MS : LONGPRESS_MS);
      try { fg.setPointerCapture(e.pointerId); } catch { /* older engines */ }
    };

    const onMove = (e) => {
      if (e.pointerId !== pointerId) return;
      dx = e.clientX - startX;
      dy = e.clientY - startY;
      if (mode === 'pending') {
        if (fromGrip) {
          // The grip (touch-action:none) is an explicit handle — any real move,
          // in any direction, picks the card up. No swipe/scroll disambiguation.
          if (Math.abs(dx) <= GRIP_MOVE && Math.abs(dy) <= GRIP_MOVE) return;
          clearTimer();
          e.preventDefault();
          startDrag(e);   // positions the clone; skip the swipe/idle branches
          return;
        }
        if (Math.abs(dx) <= MOVE_TOLERANCE && Math.abs(dy) <= MOVE_TOLERANCE) return;
        clearTimer();
        if (Math.abs(dx) > Math.abs(dy)) {
          mode = 'swipe';
          swipeEl.classList.add('is-swiping');
        } else {
          // Vertical intent → let the page scroll; abandon the gesture.
          mode = 'idle';
          try { fg.releasePointerCapture(e.pointerId); } catch { /* noop */ }
          pointerId = null;
          snapBack();
          return;
        }
      }
      if (mode === 'swipe') {
        e.preventDefault();
        let d = dx;
        if (!scheduled && d < 0) d *= 0.28;   // no "unschedule" for unscheduled rows: rubber-band
        d = Math.max(-SWIPE_MAX, Math.min(SWIPE_MAX, d));
        fg.style.transform = `translateX(${d}px)`;
        swipeEl.classList.toggle('is-swipe-schedule', d > 0);
        swipeEl.classList.toggle('is-swipe-remove', d < 0);
      } else if (mode === 'drag') {
        e.preventDefault();
        lastClientX = e.clientX; lastClientY = e.clientY;
        positionClone(e);
        highlightDay(e);
      }
    };

    const onUp = (e) => {
      if (e.pointerId !== pointerId) return;
      clearTimer();
      try { fg.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      const wasMode = mode;
      const dropDate = dropDayEl?.dataset.dayDate || null;
      mode = 'idle';
      pointerId = null;
      fromGrip = false;
      if (wasMode === 'swipe') {
        const commit = Math.abs(dx) >= SWIPE_COMMIT;
        snapBack();
        if (commit && dx > 0) handlers.onSchedule?.(scrapId);
        else if (commit && dx < 0 && scheduled) handlers.onUnschedule?.(scrapId);
      } else if (wasMode === 'drag') {
        cleanupDrag();
        if (dropDate) handlers.onMoveToDay?.(scrapId, dropDate);
      } else {
        snapBack();
      }
    };

    const onCancel = (e) => {
      if (e.pointerId !== pointerId) return;
      clearTimer();
      cleanupDrag();
      snapBack();
      mode = 'idle';
      pointerId = null;
    };

    fg.addEventListener('pointerdown', onDown);
    fg.addEventListener('pointermove', onMove);
    fg.addEventListener('pointerup', onUp);
    fg.addEventListener('pointercancel', onCancel);
  }

  return {
    /**
     * Wire every plan row in `container`. Safe to call after each render — it
     * only touches freshly-rendered nodes, and captured listeners die with them.
     * @param {HTMLElement} container
     * @param {{canWrite?: boolean,
     *          onSchedule?: (scrapId: string) => void,
     *          onUnschedule?: (scrapId: string) => void,
     *          onMoveToDay?: (scrapId: string, date: string) => void}} handlers
     */
    bind(container, handlers = {}) {
      const canWrite = handlers.canWrite !== false;
      if (!canWrite) return;
      container.querySelectorAll('.tl-swipe').forEach((el) => bindRow(el, handlers, canWrite));
    },
  };
})();
window.TimelineGestures = TimelineGestures;
