// widgets/add-to-trips.js — the Wander List "Add to trips" multi-select.
// A place can belong to several trips at once; this popup shows every trip with
// a checkbox pre-checked for the ones it's already in, and reconciles the set on
// save (PUT /scraps/{id}/trips). The place stays on the Wander List regardless —
// it only leaves once it's marked visited.
'use strict';

const AddToTrips = {
  open(scrap, { onSaved } = {}) {
    this.close();
    const trips = window.store.get('trips') || [];
    const inTrips = new Set(scrap.trip_ids || []);
    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'add-to-trips-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="AddToTrips.close()"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="Add to trips">
        <button class="ts-modal__close" onclick="AddToTrips.close()" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">Add “${escapeHtml(scrap.place_name || 'this place')}” to…</h2>
        ${trips.length ? `
          <form id="att-form">
            <div class="att-list">
              ${trips.map((t) => `
                <label class="att-row">
                  <input type="checkbox" value="${escapeAttr(t.id)}" ${inTrips.has(t.id) ? 'checked' : ''} />
                  ${renderSprite('cover', t.cover_icon, { size: 'sm', alt: '' })}
                  <span>${escapeHtml(t.name)}</span>
                </label>`).join('')}
            </div>
            <button class="ts-btn ts-btn--mint" type="submit" style="width:100%;margin-top:1rem;">
              <i data-lucide="check"></i>Save
            </button>
            <p class="scrap-card__sub" style="text-align:center;margin-top:0.6rem;">It stays on your Wander List either way.</p>
          </form>`
        : `<p class="scrap-card__sub" style="margin-top:0.6rem;">No trips yet — create one from the Trips page first.</p>`}
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });
    modal.querySelector('#att-form')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const ids = [...modal.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
      try {
        await window.api.setScrapTrips(scrap.id, ids);
        toast(ids.length ? 'Saved to your trips' : 'Removed from every trip');
        window.SourceDomain?.refreshInboxCount();
        this.close();
        onSaved?.();
      } catch (err) { toast(err.message || 'Could not save', { error: true }); }
    });
  },

  close() {
    document.getElementById('add-to-trips-modal')?.remove();
  },
};
window.AddToTrips = AddToTrips;
