// views/trips-view.js — the trip grid (landing view).
'use strict';

class TripsView extends View {
  constructor() { super('trips'); }

  renderLoading() {
    this.container.innerHTML = `
      <div class="card-grid card-grid--2col">
        ${[0, 1].map((i) => `<div class="sticker-card shimmer" style="--i:${i};height:170px;"></div>`).join('')}
      </div>
    `;
  }

  async onMount() {
    this.listen('trips', () => this.render());
    try {
      await window.TripDomain.loadAll();
    } catch (err) {
      this.container.innerHTML = `<div class="error-banner"><i data-lucide="cloud-off"></i>${escapeHtml(err.message || 'Could not load trips')}</div>`;
      this.refreshIcons();
    }
  }

  render() {
    const trips = window.store.get('trips');
    if (!trips) return;

    if (trips.length === 0) {
      this.container.innerHTML = `
        <div class="empty-state">
          <img src="/assets/illustrations/travel-scrapbook-empty-trips.svg" alt="" />
          <p class="empty-title">Where to first?</p>
          <p class="empty-desc">Make a trip, then scrap every link you find while daydreaming about it.</p>
          <button class="ts-btn ts-btn--blush" id="new-trip-btn"><i data-lucide="plus"></i>New trip</button>
        </div>
      `;
    } else {
      this.container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h1 style="font-size:2rem;margin:0;">My trips</h1>
          <button class="ts-btn ts-btn--blush ts-btn--sm" id="new-trip-btn"><i data-lucide="plus"></i>New trip</button>
        </div>
        <div class="card-grid card-grid--2col">
          ${trips.map((t, i) => renderTripCard(t, { index: i })).join('')}
        </div>
      `;
    }
    this.refreshIcons();

    this.container.querySelector('#new-trip-btn')?.addEventListener('click', () => this._openNewTripModal());
    this.container.querySelectorAll('[data-trip-id]').forEach((el) => {
      el.addEventListener('click', () => window.router.go('trip', { tripId: el.dataset.tripId }));
    });
  }

  _openNewTripModal() {
    document.getElementById('new-trip-modal')?.remove();
    const covers = ['plane', 'beach', 'mountain', 'city', 'food', 'roadtrip'];
    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'new-trip-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="document.getElementById('new-trip-modal').remove()"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="New trip">
        <button class="ts-modal__close" onclick="document.getElementById('new-trip-modal').remove()" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">New trip</h2>
        <form id="new-trip-form">
          <label class="ts-label" for="nt-name">Trip name</label>
          <input class="ts-input" id="nt-name" required placeholder="e.g. Tokyo, spring!" maxlength="120" />
          <label class="ts-label" for="nt-dest">Destination</label>
          <input class="ts-input" id="nt-dest" placeholder="e.g. Tokyo, Japan" maxlength="160" />
          <label class="ts-label">Trip covers a whole…</label>
          <div id="nt-scope" class="ts-segmented" role="radiogroup" aria-label="Trip scope">
            ${[['city', 'City'], ['region', 'Region'], ['country', 'Country']].map(([val, label], i) => `
              <label class="ts-segmented__opt">
                <input type="radio" name="nt-scope" value="${val}" ${i === 0 ? 'checked' : ''} />
                <span>${label}</span>
              </label>`).join('')}
          </div>
          <p class="confidence-hint" style="margin-top:0.3rem;">Filters which of your saved places fit this trip. City matches nearby spots; Region/Country pulls in everything you've tagged there.</p>
          <label class="ts-label">Cover sticker</label>
          <div id="nt-covers" style="display:flex;gap:0.5rem;flex-wrap:wrap;">
            ${covers.map((c, i) => `
              <label style="cursor:pointer;">
                <input type="radio" name="nt-cover" value="${c}" ${i === 0 ? 'checked' : ''} style="position:absolute;opacity:0;" />
                <span class="cover-choice" data-cover="${c}" style="display:grid;place-items:center;width:58px;height:58px;border-radius:14px;border:2px solid ${i === 0 ? 'var(--blush-deep)' : 'var(--border)'};background:var(--card);">
                  ${renderSprite('cover', c, { size: 'md' })}
                </span>
              </label>`).join('')}
          </div>
          <div style="display:flex;gap:0.6rem;">
            <div style="flex:1;">
              <label class="ts-label" for="nt-start">Start date</label>
              <input class="ts-input" id="nt-start" type="date" />
            </div>
            <div style="flex:1;">
              <label class="ts-label" for="nt-end">End date</label>
              <input class="ts-input" id="nt-end" type="date" />
            </div>
          </div>
          <button class="ts-btn ts-btn--mint" type="submit" style="width:100%;margin-top:1.1rem;">
            <i data-lucide="sparkles"></i>Start scrapping
          </button>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });

    modal.querySelectorAll('input[name=nt-cover]').forEach((radio) => {
      radio.addEventListener('change', () => {
        modal.querySelectorAll('.cover-choice').forEach((el) => {
          el.style.borderColor = el.dataset.cover === radio.value ? 'var(--blush-deep)' : 'var(--border)';
        });
      });
    });

    modal.querySelector('#new-trip-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const trip = await window.TripDomain.create({
          name: modal.querySelector('#nt-name').value.trim(),
          destination: modal.querySelector('#nt-dest').value.trim() || null,
          scope_level: modal.querySelector('input[name=nt-scope]:checked').value,
          cover_icon: modal.querySelector('input[name=nt-cover]:checked').value,
          start_date: modal.querySelector('#nt-start').value || null,
          end_date: modal.querySelector('#nt-end').value || null,
        });
        modal.remove();
        window.router.go('trip', { tripId: trip.id });
      } catch (err) {
        toast(err.message || 'Could not create trip', { error: true });
      }
    });
  }
}
window.TripsView = TripsView;
