// widgets/trip-editor.js — edit an existing trip's name, destination, scope,
// and dates. Scope is editable here (the New-Trip modal only sets it at create),
// so e.g. a "Crete" trip can be switched to Country scope to collect all of
// Greece. Save → PATCH /trips/{id} (re-geocodes a changed destination).
'use strict';

const TripEditor = {
  open(trip, { onSaved } = {}) {
    document.getElementById('trip-editor-modal')?.remove();
    const scopes = [['city', 'City'], ['region', 'Region'], ['country', 'Country']];
    const level = trip.scope_level || 'city';
    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'trip-editor-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="document.getElementById('trip-editor-modal').remove()"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="Edit trip">
        <button class="ts-modal__close" onclick="document.getElementById('trip-editor-modal').remove()" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">Edit trip</h2>
        <form id="trip-editor-form">
          <label class="ts-label" for="te-name">Trip name</label>
          <input class="ts-input" id="te-name" required maxlength="120" value="${escapeAttr(trip.name || '')}" />
          <label class="ts-label" for="te-dest">Destination</label>
          <input class="ts-input" id="te-dest" maxlength="160" value="${escapeAttr(trip.destination || '')}" placeholder="e.g. Crete, Greece" />
          <label class="ts-label">Trip covers a whole…</label>
          <div id="te-scope" class="ts-segmented" role="radiogroup" aria-label="Trip scope">
            ${scopes.map(([val, lbl]) => `
              <label class="ts-segmented__opt">
                <input type="radio" name="te-scope" value="${val}" ${val === level ? 'checked' : ''} />
                <span>${lbl}</span>
              </label>`).join('')}
          </div>
          <p class="confidence-hint" style="margin-top:0.3rem;">Which of your saved places fit this trip. <strong>City</strong> = nearby spots; <strong>Country</strong> = anywhere in that country (pick this for a whole-Greece / Crete trip); <strong>Region</strong> = the wider world region.</p>
          <div style="display:flex;gap:0.6rem;">
            <div style="flex:1;">
              <label class="ts-label" for="te-start">Start date</label>
              <input class="ts-input" id="te-start" type="date" value="${escapeAttr(trip.start_date || '')}" />
            </div>
            <div style="flex:1;">
              <label class="ts-label" for="te-end">End date</label>
              <input class="ts-input" id="te-end" type="date" value="${escapeAttr(trip.end_date || '')}" />
            </div>
          </div>
          <button class="ts-btn ts-btn--mint" type="submit" style="width:100%;margin-top:1.1rem;">
            <i data-lucide="check"></i>Save changes
          </button>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });

    modal.querySelector('#trip-editor-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = modal.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await window.TripDomain.update(trip.id, {
          name: modal.querySelector('#te-name').value.trim(),
          destination: modal.querySelector('#te-dest').value.trim() || null,
          scope_level: modal.querySelector('input[name=te-scope]:checked').value,
          start_date: modal.querySelector('#te-start').value || null,
          end_date: modal.querySelector('#te-end').value || null,
        });
        toast('Trip updated');
        modal.remove();
        onSaved?.();
      } catch (err) {
        toast(err.message || 'Could not save', { error: true });
        btn.disabled = false;
      }
    });
  },
};
window.TripEditor = TripEditor;
