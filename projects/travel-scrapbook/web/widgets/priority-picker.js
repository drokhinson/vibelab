// widgets/priority-picker.js — pick a priority/vibe level from a popup.
// The card shows one chip with the current level; tapping it opens this
// picker with the four levels plus Clear. onPick receives the chosen level
// (or null for clear) — explicit target state, no toggle semantics.
// withVisited adds a fifth "Visited" option (own ratings only, not vibes) —
// visited is a chip state like any priority, not a separate card control.
'use strict';

const PriorityPicker = {
  open({ activeLevel = null, verb = 'priority', withVisited = false, onPick } = {}) {
    this.close();
    const options = withVisited ? [...VIBE_META, VISITED_META] : VIBE_META;
    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'priority-picker-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="PriorityPicker.close()"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="Pick a ${verb}">
        <button class="ts-modal__close" onclick="PriorityPicker.close()" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">${verb === 'vibe' ? 'Your vibe' : 'How badly do you want this?'}</h2>
        <div class="priority-options">
          ${options.map((v) => `
            <button class="priority-option priority-option--${v.level} ${activeLevel === v.level ? 'is-on' : ''}"
                    data-level="${v.level}" aria-pressed="${activeLevel === v.level}">
              <i data-lucide="${v.icon}"></i><span>${v.label}</span>
              ${activeLevel === v.level ? '<i data-lucide="check" class="priority-option__check"></i>' : ''}
            </button>`).join('')}
          ${activeLevel ? `
            <button class="priority-option priority-option--clear" data-level="">
              <i data-lucide="eraser"></i><span>Clear</span>
            </button>` : ''}
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });
    modal.querySelectorAll('.priority-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        const level = btn.dataset.level || null;
        this.close();
        onPick?.(level);
      });
    });
  },

  close() {
    document.getElementById('priority-picker-modal')?.remove();
  },
};
window.PriorityPicker = PriorityPicker;
