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
    this._items = [];
    this._total = 0;
    this._facets = {};
    this._loaded = false;
    this._seq = 0;
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
    // Stale-while-revalidate: cached page paints instantly, refresh follows.
    const cached = window.tsCache?.get('visited', this._cacheKey());
    if (cached) {
      this._items = cached.items || [];
      this._total = cached.total || 0;
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
      const res = await window.api.listVisited({
        ...this._geo,
        limit: this.PAGE_SIZE,
        offset: append ? this._items.length : 0,
      });
      if (seq !== this._seq) return;
      this._items = append ? [...this._items, ...(res.scraps || [])] : (res.scraps || []);
      this._total = res.total || 0;
      this._facets = res.facets || {};
      this._loaded = true;
      if (!append) {
        window.tsCache?.set('visited', this._cacheKey(),
          { items: this._items, total: this._total, facets: this._facets });
      }
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
    this.container.innerHTML = `
      <h1 style="font-size:2rem;">Visited</h1>
      ${renderFilterBar(this._geo, this._facets)}
      ${this._total === 0 && !filtered ? `
        <div class="empty-state">
          <img src="/assets/illustrations/travel-scrapbook-empty-inbox.svg" alt="" />
          <p class="empty-title">Nothing visited yet</p>
          <p class="empty-desc">Mark a saved place as visited — from your wishlist or a trip — and it collects here.</p>
        </div>` : this._items.length ? `
        <div class="card-grid card-grid--2col">
          ${this._items.map((s, i) => renderScrapCard(s, { index: i, variant: 'trip' })).join('')}
        </div>` : `
        <p class="scrap-card__sub" style="text-align:center;padding:1rem 0;">Nothing here matches — clear a filter to widen the view.</p>`}
      ${this._items.length < this._total ? `
        <button class="ts-btn ts-btn--ghost" data-action="load-more" style="width:100%;margin-top:0.8rem;">
          <i data-lucide="chevrons-down"></i>Load more (showing ${this._items.length} of ${this._total})
        </button>` : ''}
      ${renderQuickPaste()}
    `;
    this.refreshIcons();
    this._bind();
  }

  _bind() {
    const c = this.container;
    bindQuickPaste(c);
    bindFilterBar(c, {
      geo: this._geo,
      onChange: (geo) => { this._geo = geo; this._load(); },
    });
    c.querySelector('[data-action=load-more]')?.addEventListener('click', (ev) => {
      ev.target.disabled = true;
      this._load({ append: true });
    });
    c.querySelectorAll('[data-scrap-id]').forEach((el) => {
      const scrap = this._items.find((s) => s.id === el.dataset.scrapId);
      if (!scrap) return;
      const action = el.dataset.action;
      if (el.classList.contains('sticker-card') && action === 'edit') {
        el.addEventListener('click', () => ScrapEditor.open(scrap, scrap.trip_id || null, {
          onSaved: () => this._load(),
        }));
      }
      if (el.tagName !== 'BUTTON') return;
      el.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          if (action === 'rate-open') {
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
          } else if (action === 'notes') {
            NotePopup.open(scrap, { onSaved: () => this._load() });
          }
        } catch (err) { toast(err.message, { error: true }); }
      });
    });
  }
}
window.VisitedView = VisitedView;
