// views/community-view.js — browse the community place pool (places any
// traveler has scrapped, aggregated + anonymized) with search, a category
// select, the geo drill-down filter bar, and load-more paging. Saves go to
// your own Wander List.
'use strict';

class CommunityView extends View {
  constructor() {
    super('community');
    this._resetState();
    this.PAGE_SIZE = 24;
  }

  _resetState() {
    this._q = '';
    this._category = '';
    this._geo = { region: null, country: null, city: null };
    this._items = [];
    this._total = 0;
    this._facets = {};
    this._loaded = false;
    this._seq = 0;
    this._debounce = null;
  }

  renderLoading() {
    this.container.innerHTML = `
      <h1 style="font-size:2rem;">Community</h1>
      <div class="card-grid card-grid--2col">
        <div class="sticker-card shimmer" style="height:150px;"></div>
        <div class="sticker-card shimmer" style="height:150px;"></div>
      </div>
    `;
  }

  async onMount() {
    this._resetState();
    await this._load();
  }

  async _load({ append = false } = {}) {
    const seq = ++this._seq;
    try {
      const res = await window.api.communityPlaces({
        q: this._q || undefined,
        category: this._category || undefined,
        ...this._geo,
        limit: this.PAGE_SIZE,
        offset: append ? this._items.length : 0,
      });
      if (seq !== this._seq) return;
      this._items = append ? [...this._items, ...(res.places || [])] : (res.places || []);
      this._total = res.total || 0;
      this._facets = res.facets || {};
      this._loaded = true;
      this.render();
    } catch (err) {
      if (seq !== this._seq) return;
      this.container.innerHTML = `<div class="error-banner"><i data-lucide="cloud-off"></i>${escapeHtml(err.message || 'Could not load the community pool')}</div>`;
      this.refreshIcons();
    }
  }

  render() {
    if (!this._loaded) return;
    const categories = window.store.get('categories') || [];
    const narrowed = !!(this._q || this._category || this._geo.region || this._geo.country || this._geo.city);
    this.container.innerHTML = `
      <h1 style="font-size:2rem;">Community</h1>
      <p class="scrap-card__sub" style="margin-top:-0.4rem;">Places other travelers have scrapped — only the places are shared, never their notes or ratings.</p>
      <div style="display:flex;gap:0.5rem;margin-top:0.8rem;">
        <input class="ts-input" id="community-q" placeholder="Search a place or city…" value="${escapeAttr(this._q)}" style="flex:1;margin:0;" />
        <select class="ts-select" id="community-category" style="width:auto;margin:0;">
          <option value="">All types</option>
          ${categories.map((c) => `<option value="${escapeAttr(c.slug)}" ${c.slug === this._category ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
        </select>
      </div>
      ${renderFilterBar(this._geo, this._facets)}
      ${this._total === 0 && !narrowed ? `
        <div class="empty-state">
          <img src="/assets/illustrations/travel-scrapbook-empty-inbox.svg" alt="" />
          <p class="empty-title">Nothing here yet</p>
          <p class="empty-desc">The pool fills up as travelers scrap places. Yours count too!</p>
        </div>` : this._items.length ? `
        <div class="card-grid card-grid--2col">
          ${this._items.map((p, i) => renderPlaceCard(p, { index: i })).join('')}
        </div>` : `
        <p class="scrap-card__sub" style="text-align:center;padding:1rem 0;">No community places match — clear a filter or widen the search.</p>`}
      ${this._items.length < this._total ? `
        <button class="ts-btn ts-btn--ghost" data-action="load-more" style="width:100%;margin-top:0.8rem;">
          <i data-lucide="chevrons-down"></i>Load more (showing ${this._items.length} of ${this._total})
        </button>` : ''}
    `;
    this.refreshIcons();
    this._bind();
  }

  _bind() {
    const c = this.container;
    const q = c.querySelector('#community-q');
    q?.addEventListener('input', () => {
      this._q = q.value.trim();
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this._load(), 300);
    });
    c.querySelector('#community-category')?.addEventListener('change', (ev) => {
      this._category = ev.target.value;
      this._load();
    });
    bindFilterBar(c, {
      geo: this._geo,
      onChange: (geo) => { this._geo = geo; this._load(); },
    });
    c.querySelector('[data-action=load-more]')?.addEventListener('click', (ev) => {
      ev.target.disabled = true;
      this._load({ append: true });
    });
    c.querySelectorAll('[data-action=save-community]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await window.api.saveCommunityPlace(btn.dataset.placeId);
          toast('Saved to your Wander List');
          window.SourceDomain?.refreshInboxCount();
          btn.outerHTML = '<span class="ts-btn ts-btn--ghost ts-btn--sm" style="opacity:0.6;"><i data-lucide="check"></i>Saved</span>';
          this.refreshIcons();
        } catch (err) { toast(err.message || 'Could not save', { error: true }); btn.disabled = false; }
      });
    });
  }
}
window.CommunityView = CommunityView;
