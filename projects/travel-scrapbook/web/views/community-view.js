// views/community-view.js — browse the community place pool (places any
// traveler has scrapped, aggregated + anonymized) with the same geo filter
// bar as the Wander List and Visited views, and load-more paging. Saves go
// to your own Wander List.
'use strict';

class CommunityView extends View {
  constructor() {
    super('community');
    this._resetState();
    this.PAGE_SIZE = 24;
  }

  _resetState() {
    this._geo = { region: null, country: null, city: null };
    this._tab = 'places';          // 'places' | 'checkpoints' (Stays & transport)
    this._items = [];
    this._total = 0;
    this._facets = {};
    this._loaded = false;
    this._seq = 0;
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
    // Stale-while-revalidate: cached page paints instantly, refresh follows.
    const cached = window.tsCache?.get('community', this._cacheKey());
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

  // Mirrors BrowsePages.loadCommunity's cache key: the two tabs cache apart.
  _cacheKey() { return JSON.stringify({ ...this._geo, checkpoints: this._tab === 'checkpoints' }); }

  async _load({ append = false } = {}) {
    const seq = ++this._seq;
    try {
      const page = await window.BrowsePages.loadCommunity({
        geo: this._geo,
        limit: this.PAGE_SIZE,
        offset: append ? this._items.length : 0,
        checkpoints: this._tab === 'checkpoints',
      });
      if (seq !== this._seq) return;
      // Unchanged revalidate → no repaint (avoids the entrance-anim blink).
      if (!append && this._loaded && JSON.stringify(page) === JSON.stringify(
        { items: this._items, total: this._total, facets: this._facets })) return;
      this._items = append ? [...this._items, ...page.items] : page.items;
      this._total = page.total;
      this._facets = page.facets;
      this._loaded = true;
      this.render();
    } catch (err) {
      if (seq !== this._seq || this._loaded) return; // keep stale content on a failed refresh
      this.container.innerHTML = `<div class="error-banner"><i data-lucide="cloud-off"></i>${escapeHtml(err.message || 'Could not load the community pool')}</div>`;
      this.refreshIcons();
    }
  }

  render() {
    if (!this._loaded) return;
    const narrowed = !!(this._geo.region || this._geo.country || this._geo.city);
    const onCheckpoints = this._tab === 'checkpoints';
    this.container.innerHTML = `
      <h1 style="font-size:2rem;">Community</h1>
      <div class="ts-segmented ts-segmented--sm" style="margin:0.4rem 0 0.6rem;">
        <label class="ts-segmented__opt"><input type="radio" name="community-tab" value="places" ${onCheckpoints ? '' : 'checked'} /><span>Places</span></label>
        <label class="ts-segmented__opt"><input type="radio" name="community-tab" value="checkpoints" ${onCheckpoints ? 'checked' : ''} /><span>Stays &amp; transport</span></label>
      </div>
      ${renderFilterBar(this._geo, this._facets)}
      ${this._total === 0 && !narrowed ? `
        <div class="empty-state">
          <img src="/assets/illustrations/travel-scrapbook-empty-inbox.svg" alt="" />
          <p class="empty-title">Nothing here yet</p>
          <p class="empty-desc">${onCheckpoints
            ? 'Hotels, airports, and stations collect here as travelers pin their trips.'
            : 'The pool fills up as travelers scrap places. Yours count too!'}</p>
        </div>` : this._items.length ? `
        <div class="card-grid card-grid--2col">
          ${this._items.map((p, i) => renderScrapCard(p, { index: i, variant: 'community', communityWishlist: true })).join('')}
        </div>` : `
        <p class="scrap-card__sub" style="text-align:center;padding:1rem 0;">No community places match — clear a filter to widen the view.</p>`}
      ${this._items.length < this._total ? `
        <button class="ts-btn ts-btn--ghost" data-action="load-more" style="width:100%;margin-top:0.8rem;">
          <i data-lucide="chevrons-down"></i>Load more (showing ${this._items.length} of ${this._total})
        </button>` : ''}
      ${renderQuickPaste()}
    `;
    this.refreshIcons();
    this.settleMotion();
    this._bind();
  }

  _bind() {
    const c = this.container;
    bindQuickPaste(c);
    c.querySelectorAll('input[name=community-tab]').forEach((input) => {
      input.addEventListener('change', () => {
        this._tab = input.value;
        // Paint the other tab's cached page instantly, then revalidate.
        const cached = window.tsCache?.get('community', this._cacheKey());
        if (cached) {
          this._items = cached.items || [];
          this._total = cached.total || 0;
          this._facets = cached.facets || {};
          this.render();
          this._load().catch(() => {});
        } else {
          // Cold tab: flip the visible state in the tap's frame (skeleton),
          // then fetch — never leave the other tab's cards on screen.
          this._items = [];
          this._loaded = false;
          this.renderLoading();
          this._load();
        }
      });
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
          this._afterCommunitySave(btn);
        } catch (err) { toast(err.message || 'Could not save', { error: true }); btn.disabled = false; }
      });
    });
    // Fix-location pencil: the aggregated community pin can be wrong. Saving it
    // makes it your own scrap, so the editor (paste a Maps link → re-geocode)
    // can correct the location.
    c.querySelectorAll('[data-action=community-edit]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const scrap = await window.api.saveCommunityPlace(btn.dataset.placeId);
          this._afterCommunitySave(btn);
          ScrapEditor.open(scrap, null, { onSaved: () => this._load() });
        } catch (err) { toast(err.message || 'Could not save', { error: true }); btn.disabled = false; }
      });
    });
  }

  // Invalidate caches + flip the tapped card to its saved state (drop the
  // pencil, swap the action button for a "Saved" pill). Shared by the plain
  // "Want to go" save and the fix-location pencil.
  _afterCommunitySave(btn) {
    window.tsCache?.invalidate('inbox');
    window.tsCache?.invalidate('community'); // saved_by_count changed
    window.SourceDomain?.refreshInboxCount();
    const card = btn.closest('.sticker-card');
    card?.querySelector('[data-action=community-edit]')?.remove();
    const saveBtn = card?.querySelector('[data-action=save-community]');
    // Match the render-time "Saved" pill (scrap-card.js community variant):
    // full-width via scrap-card__addtrip so a lone pill fills the card row.
    if (saveBtn) saveBtn.outerHTML = '<span class="ts-btn ts-btn--sm ts-btn--ghost scrap-card__addtrip" aria-disabled="true" style="opacity:0.6;"><i data-lucide="check"></i>Saved</span>';
    this.refreshIcons();
  }
}
window.CommunityView = CommunityView;
