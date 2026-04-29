'use strict';

// Swipe-to-reveal admin actions on .swipe-row[data-swipe] elements.
// Swipe right -> data-edit-action, swipe left -> data-delete-action,
// tap (no movement) -> data-tap-action. Bound once via delegation
// on the app root, so re-renders never lose the handler.

const SWIPE_TAP_MAX     = 8;    // px of movement still treated as a tap
const SWIPE_AXIS_LOCK   = 6;    // px before we decide horizontal vs vertical
const SWIPE_COMMIT_PX   = 60;   // past this, release commits the action
const SWIPE_MAX_REVEAL  = 120;  // hard clamp on translateX

let active = null;

function runAction(str) {
  if (!str) return;
  try { (new Function(str))(); }
  catch (err) { console.error('[swipe] action failed', str, err); }
}

function setTransform(contentEl, dx) {
  contentEl.style.transform = dx ? `translateX(${dx}px)` : '';
}

function endDrag(commit) {
  if (!active) return;
  const { row, contentEl, dx, axis } = active;
  row.releasePointerCapture?.(active.pointerId);
  row.classList.remove('swiping');
  setTransform(contentEl, 0);
  active = null;

  if (commit && axis === 'x') {
    if (dx <= -SWIPE_COMMIT_PX)      runAction(row.dataset.deleteAction);
    else if (dx >=  SWIPE_COMMIT_PX) runAction(row.dataset.editAction);
  }
}

function onPointerDown(e) {
  if (e.button !== undefined && e.button !== 0) return;
  const row = e.target.closest('.swipe-row[data-swipe]');
  if (!row) return;
  if (typeof state !== 'undefined' && !state.adminKey) return;
  const contentEl = row.querySelector('.swipe-content');
  if (!contentEl) return;

  active = {
    row, contentEl,
    pointerId: e.pointerId,
    startX: e.clientX, startY: e.clientY,
    dx: 0, axis: null,
  };
  try { row.setPointerCapture(e.pointerId); } catch (_) {}
}

function onPointerMove(e) {
  if (!active || e.pointerId !== active.pointerId) return;
  const dx = e.clientX - active.startX;
  const dy = e.clientY - active.startY;

  if (active.axis === null) {
    if (Math.abs(dy) > SWIPE_AXIS_LOCK && Math.abs(dy) > Math.abs(dx)) {
      // Vertical scroll wins — release the row.
      active.row.releasePointerCapture?.(active.pointerId);
      active = null;
      return;
    }
    if (Math.abs(dx) > SWIPE_AXIS_LOCK) {
      active.axis = 'x';
      active.row.classList.add('swiping');
    } else {
      return;
    }
  }

  e.preventDefault();
  const clamped = Math.max(-SWIPE_MAX_REVEAL, Math.min(SWIPE_MAX_REVEAL, dx));
  active.dx = clamped;
  setTransform(active.contentEl, clamped);
}

function onPointerUp(e) {
  if (!active || e.pointerId !== active.pointerId) return;

  if (active.axis === null) {
    // Never moved enough to lock — treat as tap.
    const row = active.row;
    active.row.releasePointerCapture?.(active.pointerId);
    active = null;
    runAction(row.dataset.tapAction);
    return;
  }
  endDrag(true);
}

function onPointerCancel(e) {
  if (!active || e.pointerId !== active.pointerId) return;
  endDrag(false);
}

function installSwipeHandlers(root) {
  if (!root || root.__swipeInstalled) return;
  root.__swipeInstalled = true;
  root.addEventListener('pointerdown',   onPointerDown);
  root.addEventListener('pointermove',   onPointerMove);
  root.addEventListener('pointerup',     onPointerUp);
  root.addEventListener('pointercancel', onPointerCancel);
}

window.installSwipeHandlers = installSwipeHandlers;
