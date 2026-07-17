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
    this.listen('invitations', () => this.render());
    // Stale-while-revalidate: paint the cached grid instantly on re-entry,
    // refresh in the background.
    const cached = window.store.get('trips') || window.tsCache?.get('trips', '');
    if (cached) {
      if (!window.store.get('trips')) window.store.set('trips', cached);
      this.render();
      window.TripDomain.loadAll().catch(() => {});
      window.ShareDomain.loadInvitations().catch(() => {});
      return;
    }
    try {
      await window.TripDomain.loadAll();
      window.ShareDomain.loadInvitations().catch(() => {});
    } catch (err) {
      this.container.innerHTML = `<div class="error-banner"><i data-lucide="cloud-off"></i>${escapeHtml(err.message || 'Could not load trips')}</div>`;
      this.refreshIcons();
    }
  }

  _renderInvitations() {
    const invites = window.store.get('invitations') || [];
    if (!invites.length) return '';
    return `
      <div class="sticker-card washi washi--mint" style="padding-top:1.1rem;margin-bottom:1rem;">
        <h2 style="font-size:1.3rem;margin:0 0 0.6rem;"><i data-lucide="mail"></i> Trip invites</h2>
        ${invites.map((inv) => `
          <div class="crew-row" data-invite-trip="${escapeAttr(inv.trip_id)}">
            ${renderSprite('cover', inv.cover_icon, { size: 'md', alt: '' })}
            <div style="min-width:0;flex:1;">
              <div style="font-weight:700;">${escapeHtml(inv.trip_name)}</div>
              <div class="scrap-card__sub">${escapeHtml(inv.owner_display_name ? `from ${inv.owner_display_name}` : '')} · as ${escapeHtml(inv.role)}</div>
            </div>
            <button class="ts-btn ts-btn--mint ts-btn--sm" data-invite-accept="${escapeAttr(inv.trip_id)}"><i data-lucide="check"></i>Join</button>
            <button class="ts-btn ts-btn--ghost ts-btn--sm" data-invite-decline="${escapeAttr(inv.trip_id)}" aria-label="Decline"><i data-lucide="x"></i></button>
          </div>`).join('')}
      </div>`;
  }

  _bindInvitations() {
    this.container.querySelectorAll('[data-invite-accept]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await window.ShareDomain.respond(btn.dataset.inviteAccept, 'accept');
          toast('Joined the trip!');
        } catch (err) { toast(err.message, { error: true }); }
      });
    });
    this.container.querySelectorAll('[data-invite-decline]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await window.ShareDomain.respond(btn.dataset.inviteDecline, 'decline');
          toast('Invite declined');
        } catch (err) { toast(err.message, { error: true }); }
      });
    });
  }

  render() {
    const trips = window.store.get('trips');
    if (!trips) return;
    const invitesHtml = this._renderInvitations();

    if (trips.length === 0) {
      this.container.innerHTML = `
        ${invitesHtml}
        <div class="empty-state">
          <img src="/assets/illustrations/travel-scrapbook-empty-trips.svg" alt="" />
          <p class="empty-title">Where to first?</p>
          <p class="empty-desc">Make a trip, then scrap every link you find while daydreaming about it.</p>
          <button class="ts-btn ts-btn--blush" id="new-trip-btn"><i data-lucide="plus"></i>New trip</button>
        </div>
      `;
    } else {
      const { upcoming, past } = this._partitionTrips(trips);
      // One running index across both sections so washi rotation + entrance
      // stagger stay continuous (renderTripCard keys animation on it).
      let idx = 0;
      const section = (label, list) => list.length ? `
        <h2 class="trips-section"><span>${label}</span><span class="trips-section__count">${list.length}</span></h2>
        <div class="card-grid card-grid--2col">
          ${list.map((t) => renderTripCard(t, { index: idx++ })).join('')}
        </div>` : '';
      this.container.innerHTML = `
        ${invitesHtml}
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h1 style="font-size:2rem;margin:0;">My trips</h1>
          <button class="ts-btn ts-btn--blush ts-btn--sm" id="new-trip-btn"><i data-lucide="plus"></i>New trip</button>
        </div>
        ${section('Upcoming', upcoming)}
        ${section('Past', past)}
      `;
    }
    this.refreshIcons();
    this.settleMotion();
    this._bindInvitations();

    this.container.querySelector('#new-trip-btn')?.addEventListener('click', () => this._openNewTripModal());
    this.container.querySelectorAll('[data-trip-id]').forEach((el) => {
      el.addEventListener('click', () => window.router.go('trip', { tripId: el.dataset.tripId }));
    });
  }

  // A trip's sortable timestamp (start preferred, else end); null if undated.
  _tripStamp(t) {
    const d = t.start_date || t.end_date;
    return d ? new Date(d + 'T00:00:00').getTime() : null;
  }

  // Past = the trip's end (or start, if no end) is before today. Undated trips
  // are still-being-planned, so they stay in Upcoming (per product decision).
  _partitionTrips(trips) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    const upcoming = [];
    const past = [];
    for (const t of trips) {
      const end = t.end_date || t.start_date;
      const isPast = !!end && new Date(end + 'T00:00:00').getTime() < todayMs;
      (isPast ? past : upcoming).push(t);
    }
    // Upcoming: soonest first, undated last. Past: most recent first.
    upcoming.sort((a, b) => {
      const ka = this._tripStamp(a);
      const kb = this._tripStamp(b);
      if (ka == null && kb == null) return 0;
      if (ka == null) return 1;
      if (kb == null) return -1;
      return ka - kb;
    });
    past.sort((a, b) => (this._tripStamp(b) || 0) - (this._tripStamp(a) || 0));
    return { upcoming, past };
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
