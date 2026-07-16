// views/community-view.js — browse the community place pool (places any
// traveler has scrapped, aggregated + anonymized) and save finds to your
// own Wander List.
'use strict';

class CommunityView extends View {
  constructor() {
    super('community');
    this._resetState();
  }

  _resetState() {
    this._q = '';
    this._category = '';
    this._places = null; // null = loading
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

  async _load() {
    const seq = ++this._seq;
    try {
      const res = await window.api.communityPlaces({
        q: this._q || undefined,
        category: this._category || undefined,
      });
      if (seq !== this._seq) return;
      this._places = res.places || [];
      this.render();
    } catch (err) {
      if (seq !== this._seq) return;
      this.container.innerHTML = `<div class="error-banner"><i data-lucide="cloud-off"></i>${escapeHtml(err.message || 'Could not load the community pool')}</div>`;
      this.refreshIcons();
    }
  }

  render() {
    const categories = window.store.get('categories') || [];
    const places = this._places;
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
      ${places === null ? `
        <div class="card-grid card-grid--2col">
          <div class="sticker-card shimmer" style="height:150px;"></div>
          <div class="sticker-card shimmer" style="height:150px;"></div>
        </div>` : places.length === 0 ? `
        <div class="empty-state">
          <img src="/assets/illustrations/travel-scrapbook-empty-inbox.svg" alt="" />
          <p class="empty-title">Nothing here yet</p>
          <p class="empty-desc">${this._q || this._category
            ? 'No community places match — try a broader search.'
            : 'The pool fills up as travelers scrap places. Yours count too!'}</p>
        </div>` : `
        <div class="card-grid card-grid--2col">
          ${places.map((p, i) => renderPlaceCard(p, { index: i })).join('')}
        </div>`}
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
