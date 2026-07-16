// views/visited-view.js — places you've marked visited (any trip or the
// wishlist). Tapping the check moves a place back to the wishlist.
'use strict';

class VisitedView extends View {
  constructor() {
    super('visited');
    this._groupBy = localStorage.getItem('ts.visited.groupBy') || 'region';
    this._collapsed = new Set();
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
    this.listen('visited', () => this.render());
    await this._load();
  }

  async _load() {
    try {
      const res = await window.api.listVisited();
      window.store.set('visited', res.scraps || []);
    } catch (err) {
      this.container.innerHTML = `<div class="error-banner"><i data-lucide="cloud-off"></i>${escapeHtml(err.message || 'Could not load your visited places')}</div>`;
      this.refreshIcons();
    }
  }

  render() {
    const scraps = window.store.get('visited');
    if (!scraps) return;
    this.container.innerHTML = `
      <h1 style="font-size:2rem;">Visited</h1>
      <p class="scrap-card__sub" style="margin-top:-0.4rem;">Places you've been. Tap the check to move one back to your wishlist.</p>
      ${scraps.length === 0 ? `
        <div class="empty-state">
          <img src="/assets/illustrations/travel-scrapbook-empty-inbox.svg" alt="" />
          <p class="empty-title">Nothing visited yet</p>
          <p class="empty-desc">Mark a saved place as visited — from your wishlist or a trip — and it collects here.</p>
        </div>` : `
        <div class="visited-grid">
          ${renderGroupedList(scraps, {
            dims: ['region', 'country', 'city'], active: this._groupBy,
            collapsed: this._collapsed, variant: 'trip', name: 'visited-groupby',
          })}
        </div>`}
    `;
    this.refreshIcons();
    this._bind(scraps);
  }

  _bind(scraps) {
    const c = this.container;
    bindScrapGroups(c, {
      name: 'visited-groupby',
      collapsed: this._collapsed,
      onChange: (dim) => {
        this._groupBy = dim;
        this._collapsed = new Set();
        localStorage.setItem('ts.visited.groupBy', dim);
        this.render();
      },
    });
    c.querySelectorAll('[data-scrap-id]').forEach((el) => {
      const scrap = scraps.find((s) => s.id === el.dataset.scrapId);
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
          if (action === 'visited') {
            await window.ScrapDomain.toggleVisited(scrap.id, scrap.trip_id || null, true);
            toast('Back on your wishlist');
            await this._load();
          } else if (action === 'notes') {
            NotePopup.open(scrap, { onSaved: () => this._load() });
          }
        } catch (err) { toast(err.message, { error: true }); }
      });
    });
  }
}
window.VisitedView = VisitedView;
