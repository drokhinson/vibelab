'use strict';

// Sauce merge widget — the sticky bar + the inline panel that the Sauce
// Manager renders when state.sauceMerge is active. Extracted from
// settings.js in the 2026-05-24 web/widgets/ carve-out so the manager
// view doesn't carry the merge-mode markup directly.
//
// Action handlers (startSauceMerge, toggleSauceMergePick, cancelSauceMerge,
// submitSauceMerge) stay in settings.js for now — they mutate the same
// admin lists the rest of the manager owns. A future refactor could pull
// them into widgets/ alongside the renderers if the manager view grows.

function renderSauceMergePanel() {
  const merge = state.sauceMerge;
  const keep = (state.adminSauces || []).find(s => s.id === merge.keepId);
  return `
    <div class="food-merge-panel">
      <strong>Variant family parent: ${keep ? keep.name : '(unknown)'}</strong>
      <div style="font-size:12px;color:var(--text-mid);margin-top:4px">
        Tap other sauces to mark them as variants of this one. They'll appear together as a single
        family in the sauce list, with this recipe as the default version.
      </div>
    </div>`;
}

function renderSauceMergeBar() {
  const merge = state.sauceMerge;
  const keep = (state.adminSauces || []).find(s => s.id === merge.keepId);
  const count = merge.mergeIds.size;
  const summary = count === 0
    ? `Long-press other sauces to add — parent: <strong>${keep ? keep.name : '?'}</strong>`
    : `${count} to assign as ${count === 1 ? 'variant' : 'variants'} of <strong>${keep ? keep.name : '?'}</strong>`;
  return `
    <div class="food-merge-bar">
      <span>${summary}</span>
      <div style="display:flex;gap:6px">
        <button class="builder-secondary-btn" onclick="cancelSauceMerge()">Cancel</button>
        <button class="builder-primary-btn" onclick="submitSauceMerge()" ${count === 0 || merge.saving ? 'disabled' : ''}>
          ${merge.saving ? '<span class="spinner-sm"></span> Saving…' : 'Assign as variants'}
        </button>
      </div>
      ${merge.error ? `<div class="settings-error" style="flex-basis:100%">${merge.error}</div>` : ''}
    </div>`;
}
