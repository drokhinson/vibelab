'use strict';

// Ingredient merge widget — the inline panel that the Ingredient Manager
// renders when state.foodMerge is active. Extracted from settings.js in
// the 2026-05-24 web/widgets/ carve-out.
//
// Mirrors widgets/sauce-merge-bar.js's role for the sauce side.

function renderMergePanel() {
  const merge = state.foodMerge;
  const keep = (state.adminIngredients || []).find(f => f.id === merge.keepId);
  return `
    <div class="food-merge-panel">
      <strong>Merging into: ${keep ? keep.name : '(unknown)'}</strong>
      <div style="font-size:12px;color:var(--text-mid);margin-top:4px">
        Tap other ingredients in the list to mark them as duplicates of this one.
        All recipes pointing at the duplicates will be repointed at <em>${keep ? keep.name : ''}</em>.
      </div>
    </div>`;
}
