// widgets/bookend-editor.js — the arrival/departure editor modal (create + edit).
// Since 026 a trip's arrival and departure are ordinary places that bookend the
// trip (role-NULL stops flagged is_arrival/is_departure) — shown to the user as
// checkpoints, but a different mechanism than stay/travel checkpoints. This
// modal names one, optionally pins it with a Maps link, and dates it. A
// departure can reuse the arrival place ("Same place as arrival") — you fly out
// of the airport you flew into. Submit hits the /trips/{id}/bookends API via
// TripDomain; the bookends live in ui/trip-timeline.js.
'use strict';

// Transport mode → Lucide icon (matches the backend CheckpointType enum).
const BOOKEND_TYPES = [
  { type: 'airport', label: 'Airport', lucide: 'plane' },
  { type: 'train_station', label: 'Train station', lucide: 'train-front' },
  { type: 'car_rental', label: 'Car rental', lucide: 'car' },
  { type: 'other', label: 'Other', lucide: 'map-pin' },
];

// A place's category → transport mode, to prefill the type select on edit.
const _CATEGORY_TO_TYPE = {
  airport: 'airport', train_station: 'train_station', car_rental: 'car_rental',
};

const BOOKEND_META = {
  arrival: { label: 'Arrival', icon: 'plane-landing', dateLabel: 'Arrival day' },
  departure: { label: 'Departure', icon: 'plane-takeoff', dateLabel: 'Departure day' },
};

const BookendEditor = {
  _tripId: null,

  // `which` is 'arrival' | 'departure'. `scrap` (the flagged stop) switches to
  // EDIT mode. In create mode a departure may reuse the arrival place.
  open(trip, { which = 'arrival', scrap = null } = {}) {
    this._tripId = trip.id;
    this.close();
    const editing = !!scrap;
    const meta = BOOKEND_META[which] || BOOKEND_META.arrival;
    const arrival = (trip.scraps || []).find((s) => s.is_arrival);
    const canSame = !editing && which === 'departure' && !!arrival;
    const dateBounds = `${trip.start_date ? `min="${escapeAttr(trip.start_date)}"` : ''} ${trip.end_date ? `max="${escapeAttr(trip.end_date)}"` : ''}`;

    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'bookend-editor-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="BookendEditor.close()"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="${editing ? 'Edit' : 'Set'} ${meta.label}">
        <button class="ts-modal__close" onclick="BookendEditor.close()" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">${editing ? `Edit ${meta.label}` : `Set the ${meta.label.toLowerCase()}`}</h2>
        <p class="scrap-card__sub">Where the trip ${which === 'arrival' ? 'begins' : 'ends'} — it bookends the timeline and the route.</p>
        <form id="bookend-editor-form">
          ${canSame ? `
          <div id="ep-same-row" style="margin-top:0.4rem;">
            <label class="bookend-same" style="display:flex;align-items:center;gap:8px;font-weight:700;cursor:pointer;">
              <input type="checkbox" id="ep-same" />
              <span>Same place as arrival <span class="bookend-same__hint">(${escapeHtml(arrival.place_name || 'arrival')})</span></span>
            </label>
          </div>` : ''}

          <div id="ep-place-fields">
            <label class="ts-label" for="ep-label">Name</label>
            <input class="ts-input" id="ep-label" required placeholder="e.g. Narita International Airport" />
            <label class="ts-label" for="ep-maps-url">Google Maps link (optional)</label>
            <input class="ts-input" id="ep-maps-url" placeholder="paste a maps link to pin the exact spot" />
          </div>

          <div id="ep-type-row">
            <label class="ts-label" for="ep-type">Travelling by</label>
            <select class="ts-select" id="ep-type">
              ${BOOKEND_TYPES.map((t) => `<option value="${t.type}">${t.label}</option>`).join('')}
            </select>
          </div>

          <div>
            <label class="ts-label" for="ep-date">${meta.dateLabel} (optional)</label>
            <input class="ts-input" type="date" id="ep-date" ${dateBounds} />
          </div>

          <button class="ts-btn ts-btn--mint" type="submit" style="width:100%;margin-top:1.1rem;">
            <i data-lucide="${editing ? 'check' : meta.icon}"></i>${editing ? 'Save' : 'Pin it'}
          </button>
          ${editing ? `
          <button class="ts-btn ts-btn--ghost" type="button" id="ep-remove" style="width:100%;margin-top:0.5rem;color:var(--rust,#B04A3A);">
            <i data-lucide="trash-2"></i>Remove ${meta.label.toLowerCase()}
          </button>` : ''}
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });

    const labelInput = modal.querySelector('#ep-label');
    const placeFields = modal.querySelector('#ep-place-fields');
    const typeRow = modal.querySelector('#ep-type-row');
    const sameCheckbox = modal.querySelector('#ep-same');

    // "Same place as arrival" hides the place fields (the arrival's place is
    // reused). Hidden required inputs block submit, so drop required while off.
    const setPlaceActive = (active) => {
      placeFields.hidden = !active;
      typeRow.hidden = !active;
      labelInput.required = active;
    };
    if (sameCheckbox) {
      sameCheckbox.addEventListener('change', () => setPlaceActive(!sameCheckbox.checked));
    }

    if (editing) {
      labelInput.value = scrap.place_name || '';
      modal.querySelector('#ep-maps-url').value = scrap.maps_url || '';
      const t = _CATEGORY_TO_TYPE[scrap.category] || 'other';
      modal.querySelector('#ep-type').value = t;
      const dateVal = which === 'arrival' ? scrap.plan_date : scrap.plan_end_date;
      if (dateVal) modal.querySelector('#ep-date').value = String(dateVal).slice(0, 10);

      modal.querySelector('#ep-remove').addEventListener('click', async () => {
        if (!confirmDestructive(`Remove the ${meta.label.toLowerCase()}? This can't be undone.`)) return;
        try {
          await window.TripDomain.removeBookend(this._tripId, which);
          toast(`${meta.label} cleared`);
          this.close();
        } catch (err) { toast(err.message || 'Could not remove that', { error: true }); }
      });
    }

    modal.querySelector('#bookend-editor-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = modal.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const same = !!(sameCheckbox && sameCheckbox.checked);
        const day = modal.querySelector('#ep-date').value || null;
        const body = {};
        if (same) {
          body.same_as_arrival = true;
        } else {
          const label = labelInput.value.trim();
          body.label = label;
          body.query = label;  // name doubles as the map search query
          const mapsUrl = modal.querySelector('#ep-maps-url').value.trim();
          if (editing) {
            if (mapsUrl !== (scrap.maps_url || '')) body.maps_url = mapsUrl || null;
          } else if (mapsUrl) {
            body.maps_url = mapsUrl;
          }
          body.type = modal.querySelector('#ep-type').value;
        }
        body.day = day;

        let saved;
        if (editing) {
          saved = await window.TripDomain.updateBookend(this._tripId, which, body);
        } else {
          body.which = which;
          saved = await window.TripDomain.addBookend(this._tripId, body);
        }
        const mapsProvided = !same && !!modal.querySelector('#ep-maps-url').value.trim();
        toast(saved && saved.geocode_confidence === 'none' && mapsProvided
          ? `${editing ? 'Saved' : 'Set'} — but couldn't pin that map link. Check it and try again.`
          : (editing ? 'Saved!' : (mapsProvided ? 'Pinned!' : 'Set!')));
        this.close();
      } catch (err) {
        toast(err.message || 'Could not save that', { error: true });
        btn.disabled = false;
      }
    });
  },

  close() {
    document.getElementById('bookend-editor-modal')?.remove();
  },
};
window.BookendEditor = BookendEditor;
