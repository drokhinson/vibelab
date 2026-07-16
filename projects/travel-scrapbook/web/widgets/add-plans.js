// widgets/add-plans.js — the trip's "+ Add plans" modal. Two ways to add:
//   • From your Wander List — multi-select saved places (scope-fits sort first,
//     but you can add anything).
//   • Add manually — type a place name; it geocodes into a plan.
'use strict';

const AddPlans = {
  _trip: null,
  _onSaved: null,
  _tab: 'wishlist',
  _selected: new Set(),
  _wishlist: null, // null = loading

  open(trip, { onSaved } = {}) {
    this._trip = trip;
    this._onSaved = onSaved || null;
    this._tab = 'wishlist';
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
        <div class="ts-segmented ts-segmented--sm" role="tablist" style="margin:0.6rem 0 0.9rem;">
          <label class="ts-segmented__opt"><input type="radio" name="ap-tab" value="wishlist" ${this._tab === 'wishlist' ? 'checked' : ''} /><span>From Wander List</span></label>
          <label class="ts-segmented__opt"><input type="radio" name="ap-tab" value="manual" ${this._tab === 'manual' ? 'checked' : ''} /><span>Add manually</span></label>
        </div>
        <div id="add-plans-body"></div>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });
    modal.querySelectorAll('input[name=ap-tab]').forEach((r) => {
      r.addEventListener('change', () => { if (r.checked) { this._tab = r.value; this._renderBody(); } });
    });
    this._renderBody();
  },

  _renderBody() {
    const body = document.getElementById('add-plans-body');
    if (!body) return;
    if (this._tab === 'manual') { this._renderManual(body); return; }

    // From Wander List
    if (this._wishlist === null) {
      body.innerHTML = `<div class="sticker-card shimmer" style="height:80px;"></div>`;
      return;
    }
    if (!this._wishlist.length) {
      body.innerHTML = `<p class="scrap-card__sub" style="text-align:center;padding:1rem 0;">Your Wander List is empty — import some places first, or add one manually.</p>`;
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

  _renderManual(body) {
    const categories = window.store.get('categories') || [];
    body.innerHTML = `
      <form id="ap-manual-form">
        <label class="ts-label" for="ap-name">Place name</label>
        <input class="ts-input" id="ap-name" required maxlength="200" placeholder="e.g. Cave of Zeus" />
        <div style="display:flex;gap:0.6rem;">
          <div style="flex:1;"><label class="ts-label" for="ap-city">City</label><input class="ts-input" id="ap-city" placeholder="optional" /></div>
          <div style="flex:1;"><label class="ts-label" for="ap-country">Country</label><input class="ts-input" id="ap-country" placeholder="optional" /></div>
        </div>
        <label class="ts-label" for="ap-category">Category</label>
        <select class="ts-select" id="ap-category">
          ${categories.map((c) => `<option value="${escapeAttr(c.slug)}" ${c.slug === 'sight' ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
        </select>
        <label class="ts-label" for="ap-notes">Note (optional)</label>
        <input class="ts-input" id="ap-notes" maxlength="500" placeholder="why you're adding it…" />
        <button class="ts-btn ts-btn--mint" type="submit" style="width:100%;margin-top:1rem;"><i data-lucide="plus"></i>Add plan</button>
      </form>
    `;
    window.lucide?.createIcons({ root: body });
    body.querySelector('#ap-manual-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const name = body.querySelector('#ap-name').value.trim();
      if (!name) return;
      const btn = body.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await window.api.addPlan(this._trip.id, {
          name,
          city: body.querySelector('#ap-city').value.trim() || null,
          country: body.querySelector('#ap-country').value.trim() || null,
          category: body.querySelector('#ap-category').value,
          notes: body.querySelector('#ap-notes').value.trim() || null,
        });
        toast('Plan added');
        this._onSaved?.();
        this.close();
      } catch (err) { toast(err.message || 'Could not add', { error: true }); btn.disabled = false; }
    });
  },
};
window.AddPlans = AddPlans;
