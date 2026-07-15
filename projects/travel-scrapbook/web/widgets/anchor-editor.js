// widgets/anchor-editor.js — start/end/stay anchors strip + add modal.
'use strict';

const ANCHOR_ROLES = [
  { role: 'start', label: 'Start', hint: 'e.g. arrival airport', lucide: 'plane-landing' },
  { role: 'end', label: 'End', hint: 'e.g. departure airport', lucide: 'plane-takeoff' },
  { role: 'stay', label: 'Stay', hint: 'hotel or Airbnb', lucide: 'home' },
];

function renderAnchorsStrip(trip) {
  const anchors = trip.anchors || [];
  const chips = anchors.map((a) => {
    const meta = ANCHOR_ROLES.find((r) => r.role === a.role) || ANCHOR_ROLES[2];
    const unpinned = a.geocode_confidence === 'none' ? ' title="Couldn\'t find this on the map — remove and retry with a fuller name"' : '';
    return `
      <span class="anchor-chip"${unpinned}>
        <i data-lucide="${meta.lucide}"></i>
        <span class="anchor-chip__role">${meta.label}</span>
        <span>${escapeHtml(a.label)}</span>
        ${a.geocode_confidence === 'none' ? '<i data-lucide="map-pin-off" style="opacity:0.5;"></i>' : ''}
        <button data-action="remove-anchor" data-anchor-id="${escapeAttr(a.id)}" aria-label="Remove ${escapeAttr(a.label)}"
                style="border:none;background:none;cursor:pointer;display:grid;place-items:center;width:24px;height:24px;color:var(--ink-muted);">
          <i data-lucide="x"></i>
        </button>
      </span>
    `;
  }).join('');
  return `
    <div style="display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;margin:0.6rem 0;">
      ${chips}
      <button class="ts-btn ts-btn--ghost ts-btn--sm" data-action="add-anchor">
        <i data-lucide="anchor"></i>Airports &amp; stays
      </button>
    </div>
  `;
}

const AnchorEditor = {
  _tripId: null,

  open(trip) {
    this._tripId = trip.id;
    this.close();
    const taken = new Set((trip.anchors || []).filter((a) => a.role !== 'stay').map((a) => a.role));
    const options = ANCHOR_ROLES.filter((r) => r.role === 'stay' || !taken.has(r.role));
    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'anchor-editor-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="AnchorEditor.close()"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="Add anchor">
        <button class="ts-modal__close" onclick="AnchorEditor.close()" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">Pin your route</h2>
        <p class="scrap-card__sub">Airports and stays shape how the route gets sorted — the route starts at your Start and finishes at your End.</p>
        <form id="anchor-editor-form">
          <label class="ts-label" for="ae-role">What is it?</label>
          <select class="ts-select" id="ae-role">
            ${options.map((r) => `<option value="${r.role}">${r.label} — ${r.hint}</option>`).join('')}
          </select>
          <label class="ts-label" for="ae-label">Name</label>
          <input class="ts-input" id="ae-label" required placeholder="e.g. Narita Airport" />
          <label class="ts-label" for="ae-query">Where is it? (searched on the map)</label>
          <input class="ts-input" id="ae-query" required placeholder="e.g. Narita International Airport, Japan" />
          <button class="ts-btn ts-btn--mint" type="submit" style="width:100%;margin-top:1.1rem;">
            <i data-lucide="map-pin"></i>Pin it
          </button>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });

    const labelInput = modal.querySelector('#ae-label');
    const queryInput = modal.querySelector('#ae-query');
    labelInput.addEventListener('input', () => {
      if (!queryInput.dataset.touched) queryInput.value = labelInput.value;
    });
    queryInput.addEventListener('input', () => { queryInput.dataset.touched = '1'; });

    modal.querySelector('#anchor-editor-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = modal.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const anchor = await window.TripDomain.addAnchor(this._tripId, {
          role: modal.querySelector('#ae-role').value,
          label: labelInput.value.trim(),
          query: queryInput.value.trim(),
        });
        toast(anchor.geocode_confidence === 'none'
          ? 'Added — but couldn\'t find it on the map. Try a fuller name.'
          : 'Pinned!');
        this.close();
      } catch (err) {
        toast(err.message || 'Could not add that', { error: true });
        btn.disabled = false;
      }
    });
  },

  close() {
    document.getElementById('anchor-editor-modal')?.remove();
  },
};
window.AnchorEditor = AnchorEditor;
