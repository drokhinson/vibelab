// @ts-check
// widgets/trip-suggestions.js — the unified "add to trip" picker. Both the
// "+ Todo" and "+ Checkpoint" buttons open THIS widget (distinguished only by
// `context`). It shows one proximity-ranked, paginated list merging the user's
// Wander List (higher priority, badged "Your list") with the Community pool,
// scoped to the trip and filterable by type. One tap adds:
//   • plan context      → the place joins the trip as a plan (todo)
//   • checkpoint context → the place joins as an (undated) stay/travel checkpoint
// A "Enter manually" / "Paste a link" fallback covers anything not suggested.
// Replaces the old two-tab AddPlans modal.
'use strict';

const TripSuggestions = {
  PAGE_SIZE: 6, // 3 rows of 2

  _trip: null,
  _onSaved: null,
  _context: 'plan',   // 'plan' | 'checkpoint'
  _category: null,    // null = All
  _page: 0,
  _items: null,       // null = loading
  _total: 0,
  _categories: [],    // type-filter facet
  _seq: 0,

  open(trip, { context = 'plan', onSaved } = {}) {
    this._trip = trip;
    this._onSaved = onSaved || null;
    this._context = context === 'checkpoint' ? 'checkpoint' : 'plan';
    this._category = null;
    this._page = 0;
    this._items = null;
    this._total = 0;
    this._categories = [];
    this._render();
    this._load();
  },

  close() {
    document.getElementById('trip-suggestions-modal')?.remove();
    this._trip = null;
  },

  // Checkpoint role + travel-type inferred from the place category (mirrors the
  // AnchorEditor enums: lodging is a stay, everything else in the checkpoint
  // pool is a travel leg).
  _roleForCategory(cat) {
    return cat === 'lodging' ? 'stay' : 'travel';
  },
  _anchorTypeForCategory(cat) {
    if (cat === 'airport') return 'airport';
    if (cat === 'train_station') return 'train_station';
    if (cat === 'car_rental') return 'car_rental';
    return 'other';
  },

  async _load() {
    const seq = ++this._seq;
    this._items = null;
    this._renderGrid();  // shimmer (chips + pager keep their last paint)
    this._renderPager();
    try {
      const res = await window.api.tripSuggestions(this._trip.id, {
        category: this._category || undefined,
        checkpoints: this._context === 'checkpoint',
        limit: this.PAGE_SIZE,
        offset: this._page * this.PAGE_SIZE,
      });
      if (seq !== this._seq) return;
      this._items = res.items || [];
      this._total = res.total || 0;
      this._categories = res.categories || [];
    } catch (_) {
      if (seq !== this._seq) return;
      this._items = [];
      this._total = 0;
    }
    if (!document.getElementById('trip-suggestions-modal')) return;
    this._renderChips();
    this._renderGrid();
    this._renderPager();
  },

  _render() {
    this.close();
    const cp = this._context === 'checkpoint';
    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'trip-suggestions-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="TripSuggestions.close()"></div>
      <div class="ts-modal__card ts-suggestions" role="dialog" aria-modal="true" aria-label="${cp ? 'Add a checkpoint' : 'Add a plan'}">
        <button class="ts-modal__close" onclick="TripSuggestions.close()" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">${cp ? 'Add a checkpoint' : 'Add a plan'}</h2>
        <p class="scrap-card__sub">${cp
          ? 'Nearest stays & transport for this trip — one tap to add.'
          : 'Nearest places for this trip, from your Wander List and the community.'}</p>
        <div id="ts-filter" class="filter-bar ts-suggestions__filter"></div>
        <div id="ts-grid"></div>
        <div id="ts-pager" class="ts-suggestions__pager"></div>
        <div class="ts-suggestions__footer">
          <button class="ts-btn ts-btn--ghost ts-btn--sm" id="ts-manual">
            <i data-lucide="pencil"></i>${cp ? 'Enter manually' : 'Paste a link'}
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });

    // One delegated click handler for chips, pager arrows, and add buttons.
    modal.querySelector('.ts-modal__card')?.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-action]');
      if (!el || !modal.contains(el)) return;
      const action = el.dataset.action;
      if (action === 'cat') {
        const next = el.dataset.cat || null;
        if (next === this._category) return;
        this._category = next;
        this._page = 0;
        this._renderChips();
        this._load();
      } else if (action === 'pg') {
        this._page = Math.max(0, this._page + Number(el.dataset.dir));
        this._load();
      } else if (action === 'suggest-add') {
        this._add(el);
      }
    });
    modal.querySelector('#ts-manual')?.addEventListener('click', () => this._manual());
  },

  _renderChips() {
    const host = document.getElementById('ts-filter');
    if (!host) return;
    const chip = (slug, label, icon, count, active) => `
      <button type="button" class="ts-chip ${active ? 'is-active' : ''}" data-action="cat" data-cat="${escapeAttr(slug)}"
              aria-pressed="${active ? 'true' : 'false'}">
        ${icon ? renderSprite('category', icon, { size: 'sm', alt: '' }) : '<i data-lucide="layout-grid"></i>'}
        <span>${escapeHtml(label)}</span>${count != null ? `<span class="ts-chip__count">${count}</span>` : ''}
      </button>`;
    const total = this._categories.reduce((n, c) => n + (c.count || 0), 0);
    host.innerHTML = chip('', 'All', null, total, !this._category)
      + this._categories.map((c) => chip(c.slug, c.label, c.icon, c.count, this._category === c.slug)).join('');
    host.hidden = this._categories.length === 0;
    window.lucide?.createIcons({ root: host });
  },

  _renderGrid() {
    const host = document.getElementById('ts-grid');
    if (!host) return;
    if (this._items === null) {
      host.innerHTML = `<div class="card-grid card-grid--2col">${
        Array.from({ length: 4 }).map(() => '<div class="sticker-card shimmer" style="height:150px;"></div>').join('')
      }</div>`;
      return;
    }
    if (!this._items.length) {
      const cp = this._context === 'checkpoint';
      host.innerHTML = `<p class="scrap-card__sub" style="text-align:center;padding:1.4rem 0;">${
        this._category
          ? 'Nothing in that type for this trip yet.'
          : (cp
            ? 'No stays or transport to suggest here yet — add one manually below.'
            : 'No nearby suggestions yet — paste a link below to scrap a place.')
      }</p>`;
      return;
    }
    host.innerHTML = `<div class="card-grid card-grid--2col ts-suggestions__grid">${
      this._items.map((it, i) => renderScrapCard(it, { index: i, variant: 'suggestion' })).join('')
    }</div>`;
    window.lucide?.createIcons({ root: host });
  },

  _renderPager() {
    const host = document.getElementById('ts-pager');
    if (!host) return;
    const pages = Math.max(1, Math.ceil(this._total / this.PAGE_SIZE));
    if (this._items === null || this._total <= this.PAGE_SIZE) { host.innerHTML = ''; return; }
    const hasPrev = this._page > 0;
    const hasNext = (this._page + 1) * this.PAGE_SIZE < this._total;
    host.innerHTML = `
      <button type="button" class="ts-suggestions__arrow" data-action="pg" data-dir="-1"
              aria-label="Previous suggestions" ${hasPrev ? '' : 'disabled'}><i data-lucide="chevron-left"></i></button>
      <span class="ts-suggestions__pageinfo">Page ${this._page + 1} of ${pages}</span>
      <button type="button" class="ts-suggestions__arrow" data-action="pg" data-dir="1"
              aria-label="More suggestions" ${hasNext ? '' : 'disabled'}><i data-lucide="chevron-right"></i></button>
    `;
    window.lucide?.createIcons({ root: host });
  },

  // One-tap add. Wander items assign the viewer's own scrap; community items
  // save the pool place. In checkpoint context both create an (undated) anchor.
  async _add(btn) {
    const source = btn.dataset.source;
    const scrapId = btn.dataset.scrapId || null;
    const placeId = btn.dataset.placeId || null;
    const item = (this._items || []).find(
      (it) => (scrapId && it.scrap_id === scrapId) || (placeId && it.ref_place_id === placeId));
    btn.disabled = true;
    try {
      if (this._context === 'checkpoint') {
        const cat = item ? item.category : 'other';
        const role = this._roleForCategory(cat);
        const body = { role, label: item ? item.name : '', query: item ? item.name : '' };
        if (item && item.maps_url) body.maps_url = item.maps_url;
        if (role !== 'stay') body.type = this._anchorTypeForCategory(cat);
        await window.api.createAnchor(this._trip.id, body);
      } else if (source === 'wander' && scrapId) {
        await window.api.assignScrap(scrapId, this._trip.id);
      } else {
        await window.api.saveCommunityPlace(placeId, this._trip.id);
        window.tsCache?.invalidate('community'); // saved_by_count changed
      }
      toast('Added to the trip');
      this._onSaved?.();
      // Swap the tapped button for an inline "Added" pill; leave the rest of the
      // page put (a re-fetch on paging naturally drops what's now on the trip).
      btn.outerHTML = '<span class="ts-btn ts-btn--sm ts-btn--ghost scrap-card__addtrip" style="opacity:0.6;"><i data-lucide="check"></i>Added</span>';
      const grid = document.getElementById('ts-grid');
      if (grid) window.lucide?.createIcons({ root: grid });
    } catch (err) {
      toast(err.message || 'Could not add', { error: true });
      btn.disabled = false;
    }
  },

  // Fallback for anything not in the list. Checkpoints open the manual editor;
  // plans drop the user on the trip's paste box (every place enters via a URL).
  _manual() {
    const trip = this._trip;
    this.close();
    if (this._context === 'checkpoint') {
      window.AnchorEditor?.open(trip, { role: 'stay' });
    } else {
      const input = document.getElementById('quick-paste-input');
      if (input) {
        input.scrollIntoView({ block: 'center', behavior: 'smooth' });
        input.focus();
      }
    }
  },
};
window.TripSuggestions = TripSuggestions;
