// views/visited-view.js — places you've marked visited (any trip or the
// wishlist), with the geo drill-down filter bar and load-more paging.
// The Visited chip opens the priority picker — picking a rating (or Clear)
// moves the place back to the wishlist.
'use strict';

class VisitedView extends View {
  constructor() {
    super('visited');
    this._resetState();
    this.PAGE_SIZE = 24;
  }

  _resetState() {
    this._geo = { region: null, country: null, city: null };
    this._tab = 'places';          // 'places' | 'checkpoints' — segmented toggle
    this._items = [];
    this._checkpoints = [];        // visited "Stays & transport" section
    this._total = 0;
    this._checkpointTotal = 0;
    this._facets = {};
    this._loaded = false;
    this._seq = 0;
    // Processing cards for in-flight "scrap into Visited" captures (mirrors the
    // trip's capturePending shimmer). Sourced from the capturePending:visited
    // store key so a capture survives navigating away and back.
    this._pending = [];
  }

  renderLoading() {
    this.container.innerHTML = `
      <h1 style="font-size:2rem;">Visited</h1>
      <div class="card-grid card-grid--2col">
        <div class="sticker-card shimmer" style="height:150px;"></div>
        <div class="sticker-card shimmer" style="height:150px;"></div>
      </div>
    `;
  }

  async onMount() {
    this._resetState();
    // Adopt any capture already in flight (e.g. started, navigated away, came
    // back) and repaint / reload as its processing card comes and goes.
    this._pending = window.store.get('capturePending:visited') || [];
    this.listen('capturePending:visited', () => this._onVisitedPending());
    // Stale-while-revalidate: cached page paints instantly, refresh follows.
    const cached = window.tsCache?.get('visited', this._cacheKey());
    if (cached) {
      this._items = cached.items || [];
      this._checkpoints = cached.checkpoints || [];
      this._total = cached.total || 0;
      this._checkpointTotal = cached.checkpointTotal || 0;
      this._facets = cached.facets || {};
      this._loaded = true;
      this.render();
      this._load().catch(() => {});
      return;
    }
    await this._load();
  }

  _cacheKey() { return JSON.stringify(this._geo); }

  async _load({ append = false } = {}) {
    const seq = ++this._seq;
    try {
      const page = await window.BrowsePages.loadVisited({
        geo: this._geo,
        limit: this.PAGE_SIZE,
        offset: append ? this._items.length : 0,
      });
      if (seq !== this._seq) return;
      // Unchanged revalidate → no repaint (avoids the entrance-anim blink).
      if (!append && this._loaded && JSON.stringify(page) === JSON.stringify({
        items: this._items, checkpoints: this._checkpoints,
        total: this._total, checkpointTotal: this._checkpointTotal,
        facets: this._facets,
      })) return;
      this._items = append ? [...this._items, ...page.items] : page.items;
      this._checkpoints = page.checkpoints;
      this._total = page.total;
      this._checkpointTotal = page.checkpointTotal;
      this._facets = page.facets;
      this._loaded = true;
      this.render();
    } catch (err) {
      if (seq !== this._seq || this._loaded) return; // keep stale content on a failed refresh
      this.container.innerHTML = `<div class="error-banner"><i data-lucide="cloud-off"></i>${escapeHtml(err.message || 'Could not load your visited places')}</div>`;
      this.refreshIcons();
    }
  }

  render() {
    if (!this._loaded) return;
    const filtered = !!(this._geo.region || this._geo.country || this._geo.city);
    // A capture into Visited paints a processing card on the Places tab until the
    // place lands (born visited) and the list reloads.
    const hasPending = this._pending.length > 0;
    const emptyAll = this._total === 0 && this._checkpointTotal === 0 && !filtered && !hasPending;
    const onCheckpoints = this._tab === 'checkpoints';
    const processingCards = hasPending
      ? this._pending.map((s, i) => renderSourceCard(s, { index: i, variant: 'processing' })).join('')
      : '';
    this.container.innerHTML = `
      <h1 style="font-size:2rem;">Visited</h1>
      ${emptyAll ? `
        <div class="empty-state">
          <img src="/assets/illustrations/travel-scrapbook-empty-inbox.svg" alt="" />
          <p class="empty-title">Nothing visited yet</p>
          <p class="empty-desc">Mark a saved place as visited — from your wishlist or a trip — and it collects here.</p>
        </div>` : `
        <div class="ts-segmented ts-segmented--sm" style="margin:0.4rem 0 0.6rem;">
          <label class="ts-segmented__opt"><input type="radio" name="visited-tab" value="places" ${onCheckpoints ? '' : 'checked'} /><span>Places</span></label>
          <label class="ts-segmented__opt"><input type="radio" name="visited-tab" value="checkpoints" ${onCheckpoints ? 'checked' : ''} /><span>Stays &amp; transport</span></label>
        </div>
        ${renderFilterBar(this._geo, this._facets)}
        ${onCheckpoints ? `
          <p class="scrap-card__sub" style="margin:0 0 0.5rem;">Hotels, airports, and stations from trips you've taken.</p>
          ${this._checkpoints.length ? `
            <div class="card-grid card-grid--2col">
              ${this._checkpoints.map((s, i) => renderScrapCard(s, { index: i, variant: 'trip', checkpoint: true })).join('')}
            </div>` : `
            <p class="scrap-card__sub" style="text-align:center;padding:1rem 0;">No visited stays or transport yet.</p>`}
        ` : `
          ${(this._items.length || hasPending) ? `
            <div class="card-grid card-grid--2col">
              ${processingCards}
              ${this._items.map((s, i) => renderScrapCard(s, { index: i, variant: 'trip', showRemove: false, showAddTrip: true })).join('')}
            </div>` : `
            <p class="scrap-card__sub" style="text-align:center;padding:1rem 0;">Nothing here matches — clear a filter to widen the view.</p>`}
          ${this._items.length < this._total ? `
            <button class="ts-btn ts-btn--ghost" data-action="load-more" style="width:100%;margin-top:0.8rem;">
              <i data-lucide="chevrons-down"></i>Load more (showing ${this._items.length} of ${this._total})
            </button>` : ''}
        `}
      `}
      ${renderQuickPaste()}
    `;
    this.refreshIcons();
    this.settleMotion();
    this._bind();
  }

  // A capture's processing card was added or cleared. Repaint to show/hide the
  // shimmer; when it clears (place landed → born visited), reload so the new
  // visited card appears in place of the shimmer.
  _onVisitedPending() {
    const pending = window.store.get('capturePending:visited') || [];
    const shrank = pending.length < this._pending.length;
    this._pending = pending;
    if (shrank) this._load(); else this.render();
  }

  _bind() {
    const c = this.container;
    // Quick-paste here captures the URL as *born visited* (it lands in this
    // list, not the Wander List) and paints its own processing card.
    bindQuickPaste(c, {
      onCapture: async (url) => {
        await window.ScrapDomain.captureVisited(url);
        toast('Saved! It’ll appear here as visited once the link is read.');
      },
    });
    // Places / Stays & transport toggle — both sets load in one page, so the
    // switch is a pure client-side re-render (no refetch).
    c.querySelectorAll('input[name=visited-tab]').forEach((input) => {
      input.addEventListener('change', () => { this._tab = input.value; this.render(); });
    });
    bindFilterBar(c, {
      geo: this._geo,
      onChange: (geo) => { this._geo = geo; this._load(); },
    });
    c.querySelector('[data-action=load-more]')?.addEventListener('click', (ev) => {
      ev.target.disabled = true;
      this._load({ append: true });
    });
    c.querySelectorAll('[data-scrap-id]').forEach((el) => {
      const scrap = this._items.find((s) => s.id === el.dataset.scrapId)
        || this._checkpoints.find((s) => s.id === el.dataset.scrapId);
      if (!scrap) return;
      const action = el.dataset.action;
      if (el.tagName !== 'BUTTON') return;
      el.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          if (action === 'edit') {
            ScrapEditor.open(scrap, scrap.trip_id || null, { onSaved: () => this._load() });
          } else if (action === 'pick-trip') {
            AddToTrips.open(scrap, { onSaved: () => this._load() });
          } else if (action === 'rate-open') {
            PriorityPicker.open({
              activeLevel: 'visited',
              verb: 'priority',
              withVisited: true,
              onPick: async (level) => {
                try {
                  await window.ScrapDomain.applyPriority(scrap.id, scrap.trip_id || null, level, true);
                  if (level !== 'visited') toast('Back on your wishlist');
                  await this._load();
                } catch (err) { toast(err.message, { error: true }); }
              },
            });
          }
        } catch (err) { toast(err.message, { error: true }); }
      });
    });
  }
}
window.VisitedView = VisitedView;
