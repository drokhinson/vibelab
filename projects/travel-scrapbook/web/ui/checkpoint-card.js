// ui/checkpoint-card.js — canonical Checkpoint render functions.
// A "checkpoint" is a STAY (lodging with check-in/out) or TRAVEL (a mid-trip
// leg for multi-city trips). Checkpoints render as simple typed cards in the
// trip's Stops tab; when two dated checkpoints leave a gap, a dashed
// placeholder invites filling the nights between. (026: arrival/departure are
// checkpoints too, but ride on the timeline as bookend stops.)
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
function _checkpointIcon(checkpoint) {
  if (checkpoint.role === 'stay') return 'home';
  const set = CHECKPOINT_TYPE_ICONS[checkpoint.type] || CHECKPOINT_TYPE_ICONS.other;
  return set[checkpoint.role] || set.default;
}

// The date range a checkpoint occupies: stays span check-in → check-out;
// travel checkpoints sit on their single day. Either end may be null.
function checkpointSpan(checkpoint) {
  if (checkpoint.role === 'stay') {
    return { start: checkpoint.stay_date || null, end: checkpoint.stay_end_date || checkpoint.stay_date || null };
  }
  return { start: checkpoint.checkpoint_date || null, end: checkpoint.checkpoint_date || null };
}

// Chronological order: dated checkpoints by their start day, undated ones
// after in creation order.
function sortCheckpoints(checkpoints) {
  const weight = { stay: 1, travel: 1 };
  return [...checkpoints].sort((a, b) => {
    const sa = checkpointSpan(a).start;
    const sb = checkpointSpan(b).start;
    if (!!sa !== !!sb) return sa ? -1 : 1;
    if (sa && sb && sa !== sb) return sa < sb ? -1 : 1;
    return (weight[a.role] ?? 1) - (weight[b.role] ?? 1);
  });
}

function _checkpointWhen(checkpoint) {
  if (checkpoint.role === 'stay') {
    if (!checkpoint.stay_date) return 'No dates yet';
    return formatDateRange(checkpoint.stay_date, checkpoint.stay_end_date || null);
  }
  if (!checkpoint.checkpoint_date) return 'No date yet';
  const time = checkpoint.checkpoint_time ? ' · ' + checkpoint.checkpoint_time.slice(0, 5) : '';
  return formatDateRange(checkpoint.checkpoint_date, null) + time;
}

/**
 * @param {object} checkpoint - CheckpointResponse row.
 * @param {{canWrite?: boolean}} opts
 */
function renderCheckpointCard(checkpoint, { canWrite = true } = {}) {
  const meta = CHECKPOINT_ROLE_META[checkpoint.role] || CHECKPOINT_ROLE_META.stay;
  const icon = _checkpointIcon(checkpoint);
  const unpinned = checkpoint.geocode_confidence === 'none';
  return `
    <div class="sticker-card checkpoint-card" data-checkpoint-id="${escapeAttr(checkpoint.id)}">
      <span class="checkpoint-card__icon checkpoint-card__icon--${meta.kind === 'Stay' ? 'stay' : 'travel'}">
        <i data-lucide="${icon}"></i>
      </span>
      <div class="checkpoint-card__body">
        <span class="checkpoint-card__type">${meta.kind}${meta.note ? ` · ${meta.note}` : ''}</span>
        <span class="checkpoint-card__name">${escapeHtml(checkpoint.label)}</span>
        <span class="scrap-card__sub">${escapeHtml(_checkpointWhen(checkpoint))}${unpinned ? ' · not on the map yet' : ''}</span>
      </div>
      ${canWrite ? `
        <button class="tl-row__btn" data-action="edit-checkpoint" data-checkpoint-id="${escapeAttr(checkpoint.id)}"
                aria-label="Edit ${escapeAttr(checkpoint.label)}" title="Edit checkpoint">
          <i data-lucide="pencil"></i>
        </button>
        <button class="tl-row__btn" data-action="remove-checkpoint" data-checkpoint-id="${escapeAttr(checkpoint.id)}"
                aria-label="Remove ${escapeAttr(checkpoint.label)}" title="Remove checkpoint">
          <i data-lucide="x"></i>
        </button>` : ''}
    </div>`;
}

/**
 * The trip's checkpoints in chronological order. Between two dated
 * checkpoints that don't touch (previous one ends before the next begins), a
 * dashed placeholder shows the uncovered dates — tapping it opens the
 * checkpoint editor prefilled with that gap.
 * @param {object[]} checkpoints
 * @param {{canWrite?: boolean}} opts
 */
function renderCheckpointList(checkpoints, { canWrite = true } = {}) {
  const sorted = sortCheckpoints(checkpoints);
  const parts = [];
  let prevEnd = null; // latest covered day so far (ISO string)
  for (const c of sorted) {
    const span = checkpointSpan(c);
    if (canWrite && prevEnd && span.start && span.start > prevEnd) {
      parts.push(`
        <button class="checkpoint-gap" data-action="add-checkpoint-gap"
                data-start="${escapeAttr(prevEnd)}" data-end="${escapeAttr(span.start)}">
          <i data-lucide="plus"></i>${escapeHtml(formatDateRange(prevEnd, span.start))} — nothing yet
        </button>`);
    }
    parts.push(renderCheckpointCard(c, { canWrite }));
    if (span.end && (!prevEnd || span.end > prevEnd)) prevEnd = span.end;
  }
  return `<div class="checkpoint-list">${parts.join('')}</div>`;
}
