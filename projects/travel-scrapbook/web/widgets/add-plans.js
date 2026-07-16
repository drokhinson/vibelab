// widgets/add-plans.js — the trip's "+ Add plans" modal. Two sources:
//   • Wander List — multi-select your saved places (scope-fits sort first,
//     but you can add anything).
//   • Community — places other travelers have scrapped, searchable, one-tap
//     add straight into the trip.
// Everything else enters the app via a URL capture — no manual place entry.
'use strict';

const AddPlans = {
  _trip: null,
  _onSaved: null,
  _tab: 'wishlist',
  _selected: new Set(),
  _wishlist: null,   // null = loading
  _community: null,  // null = loading
  _communityQ: '',
  _communitySeq: 0,

  open(trip, { onSaved } = {}) {
    this._trip = trip;
    this._onSaved = onSaved || null;
    this._tab = 'wishlist';
    this._selected = new Set();
    this._wishlist = null;
    this._community = null;
    this._communityQ = '';
    this._render();
    this._loadWishlist();
  },

  close() {
    document.getElementById('add-plans-modal')?.remove();
    this._trip = null;
  },

  async _loadWishlist() {
    try {
      const res = await window.api.tripWishlist(this._trip.id);
      this._wishlist = res.scraps || [];
    } catch (_) {
      this._wishlist = [];
    }
    if (document.getElementById('add-plans-modal')) this._renderBody();
  },

  // Community search, pre-filtered to the trip's destination country.
  // Sequence-guarded: typing fast fires overlapping fetches.
  async _loadCommunity() {
    const seq = ++this._communitySeq;
    try {
      const res = await window.api.communityPlaces({
        q: this._communityQ || undefined,
        country: this._trip.dest_country || undefined,
      });
      if (seq !== this._communitySeq) return;
      this._community = res.places || [];
    } catch (_) {
      if (seq !== this._communitySeq) return;
      this._community = [];
    }
    if (document.getElementById('add-plans-modal') && this._tab === 'community') this._renderBody();
  },

  _render() {
    this.close();
    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'add-plans-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="AddPlans.close()"></div>
      <div class="ts-modal__card add-plans" role="dialog" aria-modal="true" aria-label="Add plans">
        <button class="ts-modal__close" onclick="AddPlans.close()" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">Add plans</h2>
        <div class="ts-segmented ts-segmented--sm" role="tablist" style="margin:0.6rem 0 0.9rem;">
          <label class="ts-segmented__opt"><input type="radio" name="ap-tab" value="wishlist" ${this._tab === 'wishlist' ? 'checked' : ''} /><span>Wander List</span></label>
          <label class="ts-segmented__opt"><input type="radio" name="ap-tab" value="community" ${this._tab === 'community' ? 'checked' : ''} /><span>Community</span></label>
        </div>
        <div id="add-plans-body"></div>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });
    modal.querySelectorAll('input[name=ap-tab]').forEach((r) => {
      r.addEventListener('change', () => {
        if (!r.checked) return;
        this._tab = r.value;
        if (this._tab === 'community' && this._community === null) this._loadCommunity();
        this._renderBody();
      });
    });
    this._renderBody();
  },

  _renderBody() {
    const body = document.getElementById('add-plans-body');
    if (!body) return;
    if (this._tab === 'community') { this._renderCommunity(body); return; }

    // From Wander List
    if (this._wishlist === null) {
      body.innerHTML = `<div class="sticker-card shimmer" style="height:80px;"></div>`;
      return;
    }
    if (!this._wishlist.length) {
      body.innerHTML = `<p class="scrap-card__sub" style="text-align:center;padding:1rem 0;">Your Wander List is empty — scrap a few links first, or paste one straight into the trip.</p>`;
      return;
    }
    const fitCount = this._wishlist.filter((s) => s.fits_scope).length;
    body.innerHTML = `
      ${fitCount ? `<button class="ts-btn ts-btn--ghost ts-btn--sm" id="ap-select-fit" style="margin-bottom:0.6rem;"><i data-lucide="sparkles"></i>Select the ${fitCount} that fit</button>` : ''}
      <div class="card-grid card-grid--2col" id="ap-wishlist">
        ${this._wishlist.map((s, i) => renderScrapCard(s, {
          index: i, variant: 'select', selected: this._selected.has(s.id), fits: !!s.fits_scope,
        })).join('')}
      </div>
      <div class="add-plans__footer">
        <button class="ts-btn ts-btn--mint" id="ap-add" ${this._selected.size ? '' : 'disabled'}>
          <i data-lucide="plus"></i>Add ${this._selected.size || ''} plan${this._selected.size === 1 ? '' : 's'}
        </button>
      </div>
    `;
    window.lucide?.createIcons({ root: body });
    body.querySelector('#ap-select-fit')?.addEventListener('click', () => {
      this._wishlist.forEach((s) => { if (s.fits_scope) this._selected.add(s.id); });
      this._renderBody();
    });
    body.querySelectorAll('#ap-wishlist [data-action=select]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.scrapId;
        if (this._selected.has(id)) this._selected.delete(id); else this._selected.add(id);
        this._renderBody();
      });
    });
    body.querySelector('#ap-add')?.addEventListener('click', async (ev) => {
      if (!this._selected.size) return;
      ev.target.disabled = true;
      try {
        await window.api.assignScraps(this._trip.id, [...this._selected]);
        toast(`Added ${this._selected.size} to the trip`);
        this._onSaved?.();
        this.close();
      } catch (err) { toast(err.message || 'Could not add', { error: true }); ev.target.disabled = false; }
    });
  },

  _renderCommunity(body) {
    const dest = this._trip.dest_country;
    body.innerHTML = `
      <input class="ts-input" id="ap-community-q" placeholder="Search places${dest ? ` in ${escapeAttr(dest)}` : ''}…"
             value="${escapeAttr(this._communityQ)}" style="margin-bottom:0.7rem;" />
      <div id="ap-community-results">
        ${this._community === null
          ? '<div class="sticker-card shimmer" style="height:80px;"></div>'
          : this._community.length
            ? `<div class="card-grid card-grid--2col" style="margin:0;">
                ${this._community.map((p, i) => renderPlaceCard(p, { index: i })).join('')}
              </div>`
            : `<p class="scrap-card__sub" style="text-align:center;padding:1rem 0;">Nothing from other travelers${dest ? ` in ${escapeHtml(dest)}` : ''} yet${this._communityQ ? ' for that search' : ''}.</p>`}
      </div>
    `;
    window.lucide?.createIcons({ root: body });
    const input = body.querySelector('#ap-community-q');
    let debounce = null;
    input.addEventListener('input', () => {
      this._communityQ = input.value.trim();
      clearTimeout(debounce);
      debounce = setTimeout(() => this._loadCommunity(), 300);
    });
    body.querySelectorAll('[data-action=save-community]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await window.api.saveCommunityPlace(btn.dataset.placeId, this._trip.id);
          toast('Added to the trip');
          this._onSaved?.();
          btn.outerHTML = '<span class="ts-btn ts-btn--ghost ts-btn--sm" style="opacity:0.6;"><i data-lucide="check"></i>Saved</span>';
          window.lucide?.createIcons({ root: body });
        } catch (err) { toast(err.message || 'Could not add', { error: true }); btn.disabled = false; }
      });
    });
  },
};
window.AddPlans = AddPlans;
