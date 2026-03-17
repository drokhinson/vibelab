'use strict';

function renderProteinVeggieSelector() {
  const carb = state.selectedCarb;
  const backScreen = state.preparations.length > 0 ? 'prep-selector' : 'carb-selector';
  const selectedIds = new Set(state.selectedAddons.map(a => a.id));
  const count = state.selectedAddons.length;

  const renderOptions = (items) => items.map((o, i) => {
    const isSelected = selectedIds.has(o.id);
    return `
    <button class="addon-option${isSelected ? ' addon-selected' : ''}" style="--i:${i}" onclick="toggleAddon('${o.id}')">
      ${isSelected ? '<span class="addon-check"><i data-lucide="check"></i></span>' : ''}
      <span class="addon-option-emoji">${o.emoji}</span>
      <div class="addon-option-info">
        <div class="addon-option-name">${o.name}</div>
        <div class="addon-option-desc">${o.desc}</div>
      </div>
      <span class="addon-option-time">~${o.estimatedTime}m</span>
    </button>`;
  }).join('');

  const continueBtnLabel = count > 0
    ? `Continue with ${count} selected →`
    : 'Continue — just the sauce →';

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('${backScreen}')"><i data-lucide="chevron-left"></i> Back</button>
      <div class="logo"><span>${carb.emoji}</span>Add proteins &amp; veggies?</div>
      <div class="subtitle">Optional — select any combination</div>
    </div>
    <div class="scroll-body">
      <p class="section-label">PROTEINS</p>
      <div class="addon-options-list">
        ${renderOptions((state.addons || PROTEIN_VEGGIE_OPTIONS).proteins)}
      </div>
      <p class="section-label" style="margin-top:16px">VEGGIES</p>
      <div class="addon-options-list">
        ${renderOptions((state.addons || PROTEIN_VEGGIE_OPTIONS).veggies)}
      </div>
      <button class="addon-continue-btn" onclick="navigate('sauce-selector')">${continueBtnLabel}</button>
    </div>
  `;
}

function toggleAddon(id) {
  const src = state.addons || PROTEIN_VEGGIE_OPTIONS;
  const all = [...src.proteins, ...src.veggies];
  const item = all.find(o => o.id === id);
  if (!item) return;
  const idx = state.selectedAddons.findIndex(a => a.id === id);
  if (idx >= 0) state.selectedAddons.splice(idx, 1);
  else state.selectedAddons.push(item);
  render();
}

// kept for any legacy references
function skipProteinVeggie() {
  state.selectedAddons = [];
  navigate('sauce-selector');
}
