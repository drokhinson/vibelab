'use strict';

function renderPrepSelector() {
  const carb = state.selectedCarb;
  const preps = state.preparations;
  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('carb-selector')">‹ Back</button>
      <div class="logo"><span>${carb.emoji}</span>${carb.name}</div>
      <div class="subtitle">How are you preparing it?</div>
    </div>
    <div class="scroll-body">
      <div class="carb-grid">
        ${preps.map(p => `
          <button class="carb-card" onclick="selectPrep('${p.id}')">
            <span class="carb-emoji">${p.emoji || carb.emoji}</span>
            <div class="carb-name">${p.name}</div>
            <div class="carb-desc">${p.cookTime || ''}</div>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function selectPrep(id) {
  state.selectedPrep = state.preparations.find(p => p.id === id) || null;
  navigate('protein-veggie-selector');
}
