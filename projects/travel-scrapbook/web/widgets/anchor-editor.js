// widgets/anchor-editor.js — start/end/stay anchors strip + add modal.
'use strict';

const ANCHOR_ROLES = [
  { role: 'start', label: 'Start', hint: 'e.g. arrival airport', lucide: 'plane-landing' },
  { role: 'end', label: 'End', hint: 'e.g. departure airport', lucide: 'plane-takeoff' },
  { role: 'stay', label: 'Stay', hint: 'hotel or Airbnb', lucide: 'home' },
];

// How you arrive at / depart from a start or end point. Frontend-owned icon map
// mirroring ANCHOR_ROLES (matches the backend AnchorType enum). Lucide chrome
// icons — no sprites, since these are UI marks not data art.
const ANCHOR_TYPES = [
  { type: 'airport', label: 'Airport', lucide: 'plane' },
  { type: 'train_station', label: 'Train station', lucide: 'train-front' },
  { type: 'car_rental', label: 'Car rental', lucide: 'car' },
  { type: 'other', label: 'Other', lucide: 'map-pin' },
];

function renderAnchorsStrip(trip) {
  const anchors = trip.anchors || [];
  const chips = anchors.map((a) => {
    const meta = ANCHOR_ROLES.find((r) => r.role === a.role) || ANCHOR_ROLES[2];
    const typeMeta = a.type ? ANCHOR_TYPES.find((t) => t.type === a.type) : null;
    const unpinned = a.geocode_confidence === 'none' ? ' title="Couldn\'t find this on the map — remove and retry with a fuller name"' : '';
    return `
      <span class="anchor-chip"${unpinned}>
        <i data-lucide="${meta.lucide}"></i>
        <span class="anchor-chip__role">${meta.label}</span>
        <span>${escapeHtml(a.label)}</span>
        ${typeMeta ? `<i data-lucide="${typeMeta.lucide}" class="anchor-chip__type" title="${escapeAttr(typeMeta.label)}"></i>` : ''}
        ${a.role === 'stay' && a.stay_date ? `<span class="anchor-chip__day">${escapeHtml(formatDateRange(a.stay_date, null))}</span>` : ''}
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
    const start = (trip.anchors || []).find((a) => a.role === 'start');
    const dateBounds = `${trip.start_date ? `min="${escapeAttr(trip.start_date)}"` : ''} ${trip.end_date ? `max="${escapeAttr(trip.end_date)}"` : ''}`;
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

          <div id="ae-same-row" hidden style="margin-top:0.8rem;">
            <label class="anchor-same" style="display:flex;align-items:center;gap:8px;font-weight:700;cursor:pointer;">
              <input type="checkbox" id="ae-same-as-start" ${start ? '' : 'disabled'} />
              <span>Same as arrival${start ? ` <span class="anchor-same__hint">(${escapeHtml(start.label)})</span>` : ''}</span>
            </label>
            ${start ? '' : '<p class="anchor-same__note">Add an arrival point first to reuse it here.</p>'}
          </div>

          <div id="ae-place-fields">
            <label class="ts-label" for="ae-label">Name</label>
            <input class="ts-input" id="ae-label" required placeholder="e.g. Narita Airport" />
            <label class="ts-label" for="ae-query">Where is it? (searched on the map)</label>
            <input class="ts-input" id="ae-query" required placeholder="e.g. Narita International Airport, Japan" />
          </div>

          <div id="ae-type-row">
            <label class="ts-label" for="ae-type">Getting there by</label>
            <select class="ts-select" id="ae-type">
              ${ANCHOR_TYPES.map((t) => `<option value="${t.type}">${t.label}</option>`).join('')}
            </select>
          </div>

          <div id="ae-stay-date-row" hidden>
            <label class="ts-label" for="ae-stay-date">Check-in day</label>
            <input class="ts-input" type="date" id="ae-stay-date" ${dateBounds} />
          </div>

          <button class="ts-btn ts-btn--mint" type="submit" style="width:100%;margin-top:1.1rem;">
            <i data-lucide="map-pin"></i>Pin it
          </button>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });

    const roleSelect = modal.querySelector('#ae-role');
    const labelInput = modal.querySelector('#ae-label');
    const queryInput = modal.querySelector('#ae-query');
    const placeFields = modal.querySelector('#ae-place-fields');
    const typeRow = modal.querySelector('#ae-type-row');
    const stayDateRow = modal.querySelector('#ae-stay-date-row');
    const sameRow = modal.querySelector('#ae-same-row');
    const sameCheckbox = modal.querySelector('#ae-same-as-start');

    labelInput.addEventListener('input', () => {
      if (!queryInput.dataset.touched) queryInput.value = labelInput.value;
    });
    queryInput.addEventListener('input', () => { queryInput.dataset.touched = '1'; });

    // Toggle place fields on/off (used by the same-as-arrival checkbox). Hidden
    // required inputs block form submit, so required is dropped while hidden.
    const setPlaceFieldsActive = (active) => {
      placeFields.hidden = !active;
      typeRow.hidden = !active || roleSelect.value === 'stay';
      labelInput.required = active;
      queryInput.required = active;
    };

    // Show only the fields relevant to the selected role.
    const syncRoleFields = () => {
      const role = roleSelect.value;
      sameRow.hidden = role !== 'end';
      if (role !== 'end') sameCheckbox.checked = false;
      stayDateRow.hidden = role !== 'stay';
      const sameActive = role === 'end' && sameCheckbox.checked;
      setPlaceFieldsActive(!sameActive);
    };

    roleSelect.addEventListener('change', syncRoleFields);
    sameCheckbox.addEventListener('change', () => setPlaceFieldsActive(!sameCheckbox.checked));
    syncRoleFields();

    modal.querySelector('#anchor-editor-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = modal.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const role = roleSelect.value;
        const sameAsStart = role === 'end' && sameCheckbox.checked;
        const body = { role };
        if (sameAsStart) {
          body.same_as_start = true;
        } else {
          body.label = labelInput.value.trim();
          body.query = queryInput.value.trim();
          if (role === 'start' || role === 'end') body.type = modal.querySelector('#ae-type').value;
          if (role === 'stay') body.stay_date = modal.querySelector('#ae-stay-date').value || null;
        }
        const anchor = await window.TripDomain.addAnchor(this._tripId, body);
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
