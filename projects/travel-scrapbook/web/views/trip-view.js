// views/trip-view.js — trip detail: anchors, quick-paste, scraps, route panel.
'use strict';

class TripView extends View {
  constructor() {
    super('trip');
    this._resetState();
  }

  _resetState() {
    this._tripId = null;
    this._favoritesOnly = false;
    this._route = null;
    this._routeBusy = false;
  }

  renderLoading() {
    this.container.innerHTML = `
      <div class="sticker-card shimmer" style="height:90px;"></div>
      <div class="card-grid card-grid--2col" style="margin-top:1rem;">
        <div class="sticker-card shimmer" style="height:180px;"></div>
        <div class="sticker-card shimmer" style="height:180px;"></div>
      </div>
    `;
  }

  async onMount() {
    this._resetState();
    this._tripId = this.params.tripId;
    this.listen('trip:' + this._tripId, () => this.render());
    this.listen('pollTimedOut:' + this._tripId, () => this.render());
    await this._load();
  }

  async onParamsChange(params) {
    if (params.tripId !== this._tripId) {
      window.ScrapDomain.stopPolling();
      this._resetState();
      this._tripId = params.tripId;
      this.renderLoading();
      this.listen('trip:' + this._tripId, () => this.render());
      await this._load();
    }
  }

  async onUnmount() {
    window.ScrapDomain.stopPolling();
  }

  async _load() {
    try {
      await window.TripDomain.load(this._tripId);
    } catch (err) {
      this.container.innerHTML = `<div class="error-banner"><i data-lucide="cloud-off"></i>${escapeHtml(err.message || 'Could not load trip')}</div>`;
      this.refreshIcons();
    }
  }

  render() {
    const trip = window.store.get('trip:' + this._tripId);
    if (!trip) return;
    const allScraps = trip.scraps || [];
    const staged = trip.staged_scraps || [];
    const scraps = this._favoritesOnly ? allScraps.filter((s) => s.is_favorite) : allScraps;
    const geocodedCount = allScraps.filter((s) => s.lat != null).length;
    const dates = formatDateRange(trip.start_date, trip.end_date);

    this.container.innerHTML = `
      <button class="ts-btn ts-btn--ghost ts-btn--sm" id="trip-back"><i data-lucide="arrow-left"></i>Trips</button>
      <div style="display:flex;align-items:center;gap:0.8rem;margin-top:0.8rem;">
        ${renderSprite('cover', trip.cover_icon, { size: 'lg', alt: '' })}
        <div style="min-width:0;flex:1;">
          <h1 style="font-size:2.1rem;margin:0;">${escapeHtml(trip.name)}</h1>
          <p class="scrap-card__sub">${escapeHtml([trip.destination, dates].filter(Boolean).join(' · '))}</p>
        </div>
        <button class="ts-header__nav-btn ts-btn ts-btn--ghost ts-btn--sm" id="trip-delete" aria-label="Delete trip"><i data-lucide="trash-2"></i></button>
      </div>
      ${renderAnchorsStrip(trip)}
      ${renderQuickPaste(trip.id)}
      ${this._renderStaging(staged)}
      ${this._renderRoutePanel(trip, geocodedCount)}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:1.2rem;">
        <h2 style="font-size:1.5rem;margin:0;">Scraps</h2>
        <button class="ts-btn ts-btn--ghost ts-btn--sm ${this._favoritesOnly ? 'is-fav' : ''}" id="fav-filter"
                style="${this._favoritesOnly ? 'border-color:var(--blush);color:#E4557A;' : ''}">
          <i data-lucide="heart"></i>${this._favoritesOnly ? 'All scraps' : 'Favorites'}
        </button>
      </div>
      ${scraps.length === 0 ? `
        <div class="empty-state">
          <img src="/assets/illustrations/travel-scrapbook-empty-scraps.svg" alt="" />
          <p class="empty-title">${this._favoritesOnly ? 'No favorites yet' : 'Paste your first link'}</p>
          <p class="empty-desc">${this._favoritesOnly
            ? 'Tap the heart on scraps you love and they collect here.'
            : 'Found something on Reddit or Instagram? Paste it above — we\'ll figure out what place it is.'}</p>
        </div>` : `
        <div class="card-grid card-grid--2col">
          ${scraps.map((s, i) => renderScrapCard(s, { index: i })).join('')}
        </div>`}
    `;
    this.refreshIcons();
    this._bind(trip);
  }

  _renderStaging(staged) {
    if (!staged.length) return '';
    return `
      <div class="sticker-card washi washi--lavender" style="padding-top:1.2rem;margin-top:1.1rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.6rem;flex-wrap:wrap;">
          <div>
            <h2 style="font-size:1.5rem;margin:0;">Needs review</h2>
            <p class="scrap-card__sub">We think these belong in this trip — keep or move them.</p>
          </div>
          <button class="ts-btn ts-btn--mint ts-btn--sm" id="approve-all-staged">
            <i data-lucide="check-check"></i>Keep all ${staged.length}
          </button>
        </div>
        <div class="card-grid card-grid--2col" style="margin-top:0.8rem;">
          ${staged.map((s, i) => renderScrapCard(s, { index: i, variant: 'staged' })).join('')}
        </div>
      </div>
    `;
  }

  _renderRoutePanel(trip, geocodedCount) {
    if (geocodedCount < 2 && !this._route) return '';
    let body = '';
    if (this._route) {
      const r = this._route;
      const stops = [];
      const anchors = trip.anchors || [];
      const start = anchors.find((a) => a.role === 'start' && a.lat != null) ||
                    anchors.find((a) => a.role === 'stay' && a.lat != null);
      const end = anchors.find((a) => a.role === 'end' && a.lat != null);
      if (start) stops.push({ label: start.label, isAnchor: true });
      r.ordered_scraps.forEach((s) => stops.push({ label: s.place_name || 'Stop' }));
      if (end) stops.push({ label: end.label, isAnchor: true });
      let n = 0;
      body = `
        <div style="margin-top:0.8rem;">
          ${stops.map((stop, i) => {
            if (!stop.isAnchor) n += 1;
            const legKm = i < r.legs.length ? r.legs[i].distance_km : null;
            return renderRouteStop(stop, n, { legKm });
          }).join('')}
          <p class="scrap-card__sub" style="margin-top:0.5rem;">Total: ${formatKm(r.total_km)}
            ${r.skipped_scrap_ids.length ? ` · ${r.skipped_scrap_ids.length} scrap${r.skipped_scrap_ids.length === 1 ? '' : 's'} skipped (no map pin yet)` : ''}</p>
          <div style="display:flex;gap:0.6rem;flex-wrap:wrap;margin-top:0.7rem;">
            <button class="ts-btn ts-btn--sky ts-btn--sm" id="route-maps"><i data-lucide="map"></i>Open in Google Maps</button>
            <button class="ts-btn ts-btn--ghost ts-btn--sm" id="route-csv"><i data-lucide="download"></i>CSV for My Maps</button>
          </div>
          <div id="route-legs" style="display:flex;flex-direction:column;gap:0.4rem;margin-top:0.5rem;"></div>
        </div>
      `;
    }
    return `
      <div class="sticker-card washi washi--butter" style="padding-top:1.2rem;margin-top:1.1rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.6rem;">
          <div>
            <h2 style="font-size:1.5rem;margin:0;">Route</h2>
            <p class="scrap-card__sub">${geocodedCount} place${geocodedCount === 1 ? '' : 's'} on the map</p>
          </div>
          <button class="ts-btn ts-btn--mint ts-btn--sm" id="route-optimize" ${this._routeBusy ? 'disabled' : ''}>
            <i data-lucide="wand-2"></i>${this._route ? 'Re-sort' : 'Sort my route'}
          </button>
        </div>
        ${body}
      </div>
    `;
  }

  _bind(trip) {
    const c = this.container;
    c.querySelector('#trip-back')?.addEventListener('click', () => window.router.back('trips'));
    c.querySelector('#trip-delete')?.addEventListener('click', async () => {
      if (!confirmDestructive(`Delete "${trip.name}" and all its scraps? This can't be undone.`)) return;
      try {
        await window.TripDomain.remove(trip.id);
        toast('Trip deleted');
        window.router.go('trips');
      } catch (err) { toast(err.message, { error: true }); }
    });
    c.querySelector('#fav-filter')?.addEventListener('click', () => {
      this._favoritesOnly = !this._favoritesOnly;
      this.render();
    });

    bindQuickPaste(c);

    c.querySelector('[data-action=add-anchor]')?.addEventListener('click', () => AnchorEditor.open(trip));
    c.querySelectorAll('[data-action=remove-anchor]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try { await window.TripDomain.removeAnchor(trip.id, btn.dataset.anchorId); }
        catch (err) { toast(err.message, { error: true }); }
      });
    });

    // Staged review: keep all in one tap.
    c.querySelector('#approve-all-staged')?.addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try {
        await window.ScrapDomain.approveAll(trip.id);
        toast('All kept — welcome aboard!');
      } catch (err) { toast(err.message, { error: true }); }
    });

    // Scrap card actions (edit opens the editor; the rest are inline buttons).
    const findScrap = (id) =>
      (trip.scraps || []).find((s) => s.id === id) ||
      (trip.staged_scraps || []).find((s) => s.id === id);
    c.querySelectorAll('[data-scrap-id]').forEach((el) => {
      const scrapId = el.dataset.scrapId;
      const scrap = findScrap(scrapId);
      if (!scrap) return;
      const action = el.dataset.action;
      if (el.classList.contains('sticker-card') && action === 'edit') {
        el.addEventListener('click', () => ScrapEditor.open(scrap, trip.id));
      }
      if (el.tagName === 'BUTTON') {
        el.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          try {
            if (action === 'favorite') {
              await window.ScrapDomain.update(scrapId, trip.id, { is_favorite: !scrap.is_favorite });
            } else if (action === 'approve') {
              await window.ScrapDomain.approve(scrapId, trip.id);
              toast('Kept!');
            } else if (action === 'unassign') {
              await window.ScrapDomain.unassign(scrapId, trip.id);
              toast('Moved to your inbox');
            } else if (action === 'edit') {
              ScrapEditor.open(scrap, trip.id);
            } else if (action === 'delete') {
              if (!confirmDestructive('Delete this scrap? This can\'t be undone.')) return;
              await window.ScrapDomain.remove(scrapId, trip.id);
            }
          } catch (err) { toast(err.message, { error: true }); }
        });
      }
    });

    c.querySelector('#route-optimize')?.addEventListener('click', async () => {
      this._routeBusy = true;
      this.render();
      try {
        this._route = await window.RouteDomain.optimize(trip.id, { favorites_only: this._favoritesOnly });
      } catch (err) {
        toast(err.message || 'Route sorting failed', { error: true });
      } finally {
        this._routeBusy = false;
        this.render();
      }
    });

    c.querySelector('#route-maps')?.addEventListener('click', async () => {
      try {
        const res = await window.RouteDomain.mapsLinks(trip.id);
        if (!res.legs.length) { toast('Pin at least two stops first', { error: true }); return; }
        if (res.legs.length === 1) {
          window.open(res.legs[0].url, '_blank', 'noopener');
          return;
        }
        const legsEl = c.querySelector('#route-legs');
        legsEl.innerHTML = res.legs.map((leg) => `
          <a class="ts-btn ts-btn--ghost ts-btn--sm" href="${escapeAttr(leg.url)}" target="_blank" rel="noopener" style="justify-content:flex-start;">
            <i data-lucide="external-link"></i>${escapeHtml(leg.label)} (${leg.stop_count} stops)
          </a>`).join('');
        this.refreshIcons(legsEl);
      } catch (err) { toast(err.message, { error: true }); }
    });

    c.querySelector('#route-csv')?.addEventListener('click', async () => {
      try {
        await window.RouteDomain.downloadCsv(trip.id, trip.name);
        toast('CSV downloaded — import it in Google My Maps');
      } catch (err) { toast(err.message, { error: true }); }
    });
  }
}
window.TripView = TripView;
