// widgets/checkpoint-editor.js — the checkpoint editor modal (create + edit).
// A checkpoint is a STAY (lodging, check-in/out dates) or a TRAVEL leg (a
// mid-trip hop for multi-city trips, any number per trip). (026:
// arrival/departure are checkpoints too, but use a different mechanism —
// they're bookend stops edited via widgets/bookend-editor.js.)
'use strict';

const CHECKPOINT_ROLES = [
  { role: 'stay', label: 'Stay', hint: 'hotel or Airbnb', lucide: 'home' },
  { role: 'travel', label: 'Travel', hint: 'flight, train, ferry to the next city', lucide: 'plane' },
];

// How you travel at a travel checkpoint. Frontend-owned icon map (matches the
// backend CheckpointType enum). Lucide chrome icons — no sprites.
const CHECKPOINT_TYPES = [
  { type: 'airport', label: 'Airport', lucide: 'plane' },
  { type: 'train_station', label: 'Train station', lucide: 'train-front' },
  { type: 'car_rental', label: 'Car rental', lucide: 'car' },
  { type: 'other', label: 'Other', lucide: 'map-pin' },
];

// Roles that carry checkpoint_date/checkpoint_time + type (everything except lodging).
const TRAVEL_ROLES = ['travel'];

const CheckpointEditor = {
  _tripId: null,

  // Create mode by default; `role` preselects; `prefill` seeds the date fields
  // (gap placeholders); `checkpoint` switches to EDIT mode — role locked, fields
  // prefilled, submit PATCHes instead of creating.
  open(trip, { checkpoint = null, role = null, prefill = null } = {}) {
    this._tripId = trip.id;
    this.close();
    const editing = !!checkpoint;
    const options = editing
      ? CHECKPOINT_ROLES.filter((r) => r.role === checkpoint.role)
      : CHECKPOINT_ROLES;
    const preselect = editing ? checkpoint.role : (role || 'stay');
    const roleLabel = (r) => (CHECKPOINT_ROLES.find((m) => m.role === r) || {}).label || 'checkpoint';
    const dateBounds = `${trip.start_date ? `min="${escapeAttr(trip.start_date)}"` : ''} ${trip.end_date ? `max="${escapeAttr(trip.end_date)}"` : ''}`;
    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'checkpoint-editor-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="CheckpointEditor.close()"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="${editing ? 'Edit checkpoint' : 'Add a checkpoint'}">
        <button class="ts-modal__close" onclick="CheckpointEditor.close()" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">${editing ? `Edit ${escapeHtml(roleLabel(checkpoint.role))}` : 'Add a checkpoint'}</h2>
        <p class="scrap-card__sub">Stays and travel are your trip's checkpoints — they frame the timeline and the route.</p>
        <form id="checkpoint-editor-form">
          <div ${editing ? 'hidden' : ''}>
            <label class="ts-label" for="ae-role">What is it?</label>
            <select class="ts-select" id="ae-role">
              ${options.map((r) => `<option value="${r.role}" ${r.role === preselect ? 'selected' : ''}>${r.label} — ${r.hint}</option>`).join('')}
            </select>
          </div>

          <div id="ae-place-fields">
            <label class="ts-label" for="ae-label">Name</label>
            <input class="ts-input" id="ae-label" required placeholder="e.g. Hôtel des Grands Boulevards" />
            <label class="ts-label" for="ae-maps-url">Google Maps link (optional)</label>
            <input class="ts-input" id="ae-maps-url" placeholder="paste a maps link to pin the exact spot" />
          </div>

          <div id="ae-type-row">
            <label class="ts-label" for="ae-type">Travelling by</label>
            <select class="ts-select" id="ae-type">
              ${CHECKPOINT_TYPES.map((t) => `<option value="${t.type}">${t.label}</option>`).join('')}
            </select>
          </div>

          <div id="ae-when-row">
            <div style="display:flex;gap:0.6rem;">
              <div style="flex:1;">
                <label class="ts-label" for="ae-date" id="ae-date-label">Travel day</label>
                <input class="ts-input" type="date" id="ae-date" ${dateBounds} />
              </div>
              <div style="flex:1;">
                <label class="ts-label" for="ae-time">Time (optional)</label>
                <input class="ts-input" type="time" id="ae-time" />
              </div>
            </div>
          </div>

          <div id="ae-stay-date-row" hidden>
            <div style="display:flex;gap:0.6rem;">
              <div style="flex:1;">
                <label class="ts-label" for="ae-stay-date">Check-in day</label>
                <input class="ts-input" type="date" id="ae-stay-date" ${dateBounds} />
              </div>
              <div style="flex:1;">
                <label class="ts-label" for="ae-stay-end-date">Check-out day</label>
                <input class="ts-input" type="date" id="ae-stay-end-date" ${dateBounds} />
              </div>
            </div>
          </div>

          <button class="ts-btn ts-btn--mint" type="submit" style="width:100%;margin-top:1.1rem;">
            <i data-lucide="${editing ? 'check' : 'map-pin'}"></i>${editing ? 'Save' : 'Pin it'}
          </button>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });

    const roleSelect = modal.querySelector('#ae-role');
    const typeRow = modal.querySelector('#ae-type-row');
    const whenRow = modal.querySelector('#ae-when-row');
    const stayDateRow = modal.querySelector('#ae-stay-date-row');

    // Show only the fields relevant to the selected role.
    const syncRoleFields = () => {
      const stay = roleSelect.value === 'stay';
      stayDateRow.hidden = !stay;
      whenRow.hidden = stay;
      typeRow.hidden = stay;
    };
    roleSelect.addEventListener('change', syncRoleFields);
    syncRoleFields();

    // Edit mode: prefill from the existing checkpoint.
    if (editing) {
      modal.querySelector('#ae-label').value = checkpoint.label || '';
      modal.querySelector('#ae-maps-url').value = checkpoint.maps_url || '';
      if (checkpoint.type) modal.querySelector('#ae-type').value = checkpoint.type;
      if (checkpoint.role === 'stay') {
        modal.querySelector('#ae-stay-date').value = checkpoint.stay_date || '';
        modal.querySelector('#ae-stay-end-date').value = checkpoint.stay_end_date || '';
      } else {
        modal.querySelector('#ae-date').value = checkpoint.checkpoint_date || '';
        modal.querySelector('#ae-time').value = (checkpoint.checkpoint_time || '').slice(0, 5);
      }
    } else if (prefill) {
      // Gap placeholder: seed the dates of the uncovered stretch.
      if (prefill.stay_date) modal.querySelector('#ae-stay-date').value = prefill.stay_date;
      if (prefill.stay_end_date) modal.querySelector('#ae-stay-end-date').value = prefill.stay_end_date;
      if (prefill.checkpoint_date) modal.querySelector('#ae-date').value = prefill.checkpoint_date;
    }

    modal.querySelector('#checkpoint-editor-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = modal.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const role = roleSelect.value;
        const label = modal.querySelector('#ae-label').value.trim();
        const body = editing ? {} : { role };
        body.label = label;
        // The name doubles as the map search query (no separate "where is it"
        // field) — a pasted Maps link still overrides it for the exact pin.
        body.query = label;
        // On edit only send the link when changed, so an unchanged link doesn't
        // re-resolve every save.
        const mapsUrl = modal.querySelector('#ae-maps-url').value.trim();
        if (editing) {
          if (mapsUrl !== (checkpoint.maps_url || '')) body.maps_url = mapsUrl || null;
        } else if (mapsUrl) {
          body.maps_url = mapsUrl;
        }
        if (TRAVEL_ROLES.includes(role)) {
          body.type = modal.querySelector('#ae-type').value;
          body.checkpoint_date = modal.querySelector('#ae-date').value || null;
          body.checkpoint_time = modal.querySelector('#ae-time').value || null;
        }
        if (role === 'stay') {
          body.stay_date = modal.querySelector('#ae-stay-date').value || null;
          body.stay_end_date = modal.querySelector('#ae-stay-end-date').value || null;
        }
        const saved = editing
          ? await window.TripDomain.updateCheckpoint(this._tripId, checkpoint.id, body)
          : await window.TripDomain.addCheckpoint(this._tripId, body);
        // Location comes only from a Maps link. A name with no link intentionally
        // has no pin — only warn when a link was given but didn't resolve.
        const mapsProvided = !!mapsUrl;
        toast(saved.geocode_confidence === 'none' && mapsProvided
          ? `${editing ? 'Saved' : 'Added'} — but couldn't pin that map link. Check it and try again.`
          : (editing ? 'Saved!' : (mapsProvided ? 'Pinned!' : 'Added!')));
        this.close();
      } catch (err) {
        toast(err.message || 'Could not save that', { error: true });
        btn.disabled = false;
      }
    });
  },

  close() {
    document.getElementById('checkpoint-editor-modal')?.remove();
  },
};
window.CheckpointEditor = CheckpointEditor;
