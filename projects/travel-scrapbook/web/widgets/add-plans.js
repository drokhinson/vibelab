// widgets/add-plans.js — the trip's "+ Add plans" modal: multi-select saved
// places from your Wander List (scope-fits sort first, but you can add
// anything). Everything enters the app via a URL capture — there is no
// manual place entry.
'use strict';

const AddPlans = {
  _trip: null,
  _onSaved: null,
  _selected: new Set(),
  _wishlist: null, // null = loading

  open(trip, { onSaved } = {}) {
    this._trip = trip;
    this._onSaved = onSaved || null;
    this._selected = new Set();
    this._wishlist = null;
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
        <p class="scrap-card__sub" style="margin:0.3rem 0 0.9rem;">From your Wander List — places that fit this trip sort first.</p>
        <div id="add-plans-body"></div>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });
    this._renderBody();
  },

  _renderBody() {
    const body = document.getElementById('add-plans-body');
    if (!body) return;

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
};
window.AddPlans = AddPlans;
