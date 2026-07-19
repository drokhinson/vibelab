// ui/checkpoint-card.js — canonical Checkpoint render functions.
// A "checkpoint" is an anchor: a STAY (lodging with check-in/out) or TRAVEL
// (a mid-trip leg for multi-city trips). Checkpoints render as simple typed
// cards in the trip's Plans tab; when two dated checkpoints leave a gap, a
// dashed placeholder invites filling the nights between. (026: arrival/
// departure are no longer checkpoints — they're bookend plans on the timeline.)
// Render-only; trip-view binds the [data-action=...] buttons.
'use strict';

// role → presentation. The icon comes from _checkpointIcon (transport-mode
// aware), not from here.
const CHECKPOINT_ROLE_META = {
  travel: { kind: 'Travel', note: null },
  stay: { kind: 'Stay', note: null },
};

// transport `type` → Lucide icon. Travel legs reuse one mode icon.
const CHECKPOINT_TYPE_ICONS = {
  airport: { default: 'plane' },
  train_station: { default: 'train-front' },
  car_rental: { default: 'car' },
  other: { default: 'map-pin' },
};

// The icon for a checkpoint: stays are a home; travel legs pick their
// transport-mode icon (a train leg shows a train, not a plane).
function _checkpointIcon(anchor) {
  if (anchor.role === 'stay') return 'home';
  const set = CHECKPOINT_TYPE_ICONS[anchor.type] || CHECKPOINT_TYPE_ICONS.other;
  return set[anchor.role] || set.default;
}

// The date range a checkpoint occupies: stays span check-in → check-out;
// travel checkpoints sit on their single day. Either end may be null.
function checkpointSpan(anchor) {
  if (anchor.role === 'stay') {
    return { start: anchor.stay_date || null, end: anchor.stay_end_date || anchor.stay_date || null };
  }
  return { start: anchor.anchor_date || null, end: anchor.anchor_date || null };
}

// Chronological order: dated checkpoints by their start day, undated ones
// after in creation order.
function sortCheckpoints(anchors) {
  const weight = { stay: 1, travel: 1 };
  return [...anchors].sort((a, b) => {
    const sa = checkpointSpan(a).start;
    const sb = checkpointSpan(b).start;
    if (!!sa !== !!sb) return sa ? -1 : 1;
    if (sa && sb && sa !== sb) return sa < sb ? -1 : 1;
    return (weight[a.role] ?? 1) - (weight[b.role] ?? 1);
  });
}

function _checkpointWhen(anchor) {
  if (anchor.role === 'stay') {
    if (!anchor.stay_date) return 'No dates yet';
    return formatDateRange(anchor.stay_date, anchor.stay_end_date || null);
  }
  if (!anchor.anchor_date) return 'No date yet';
  const time = anchor.anchor_time ? ' · ' + anchor.anchor_time.slice(0, 5) : '';
  return formatDateRange(anchor.anchor_date, null) + time;
}

/**
 * @param {object} anchor - AnchorResponse row.
 * @param {{canWrite?: boolean}} opts
 */
function renderCheckpointCard(anchor, { canWrite = true } = {}) {
  const meta = CHECKPOINT_ROLE_META[anchor.role] || CHECKPOINT_ROLE_META.stay;
  const icon = _checkpointIcon(anchor);
  const unpinned = anchor.geocode_confidence === 'none';
  return `
    <div class="sticker-card checkpoint-card" data-anchor-id="${escapeAttr(anchor.id)}">
      <span class="checkpoint-card__icon checkpoint-card__icon--${meta.kind === 'Stay' ? 'stay' : 'travel'}">
        <i data-lucide="${icon}"></i>
      </span>
      <div class="checkpoint-card__body">
        <span class="checkpoint-card__type">${meta.kind}${meta.note ? ` · ${meta.note}` : ''}</span>
        <span class="checkpoint-card__name">${escapeHtml(anchor.label)}</span>
        <span class="scrap-card__sub">${escapeHtml(_checkpointWhen(anchor))}${unpinned ? ' · not on the map yet' : ''}</span>
      </div>
      ${canWrite ? `
        <button class="tl-row__btn" data-action="edit-anchor" data-anchor-id="${escapeAttr(anchor.id)}"
                aria-label="Edit ${escapeAttr(anchor.label)}" title="Edit checkpoint">
          <i data-lucide="pencil"></i>
        </button>
        <button class="tl-row__btn" data-action="remove-anchor" data-anchor-id="${escapeAttr(anchor.id)}"
                aria-label="Remove ${escapeAttr(anchor.label)}" title="Remove checkpoint">
          <i data-lucide="x"></i>
        </button>` : ''}
    </div>`;
}

/**
 * The trip's checkpoints in chronological order. Between two dated
 * checkpoints that don't touch (previous one ends before the next begins), a
 * dashed placeholder shows the uncovered dates — tapping it opens the
 * checkpoint editor prefilled with that gap.
 * @param {object[]} anchors
 * @param {{canWrite?: boolean}} opts
 */
function renderCheckpointList(anchors, { canWrite = true } = {}) {
  const sorted = sortCheckpoints(anchors);
  const parts = [];
  let prevEnd = null; // latest covered day so far (ISO string)
  for (const a of sorted) {
    const span = checkpointSpan(a);
    if (canWrite && prevEnd && span.start && span.start > prevEnd) {
      parts.push(`
        <button class="checkpoint-gap" data-action="add-checkpoint-gap"
                data-start="${escapeAttr(prevEnd)}" data-end="${escapeAttr(span.start)}">
          <i data-lucide="plus"></i>${escapeHtml(formatDateRange(prevEnd, span.start))} — nothing yet
        </button>`);
    }
    parts.push(renderCheckpointCard(a, { canWrite }));
    if (span.end && (!prevEnd || span.end > prevEnd)) prevEnd = span.end;
  }
  return `<div class="checkpoint-list">${parts.join('')}</div>`;
}
