// views/inbox-view.js — the Wander List: sources still processing, sources
// that failed, and one filtered page of want-to-go places. A geo drill-down
// filter bar (region → country → city) keeps the view focused; "Load more"
// pages through the rest.
'use strict';

class InboxView extends View {
  constructor() {
    super('inbox');
    this._resetState();
    this.POLL_INTERVAL_MS = 2000;
    this.POLL_TIMEOUT_MS = 45000;
    this.PAGE_SIZE = 24;
  }

  _resetState() {
    this._pollTimer = null;
    this._pollStartedAt = 0;
    this._geo = { region: null, country: null, city: null };
    this._items = [];
    this._total = 0;
    this._facets = {};
    this._processing = [];
    this._failed = [];
    this._loaded = false;
    this._seq = 0;
  }

  renderLoading() {
    this.container.innerHTML = `
      <h1 style="font-size:2rem;">Wander List</h1>
      <div class="sticker-card shimmer" style="height:80px;"></div>
      <div class="sticker-card shimmer" style="height:80px;margin-top:0.8rem;"></div>
    `;
  }

  async onMount() {
    this._resetState();
    // Trips power the suggestion chips + the trip picker; non-blocking.
    window.TripDomain.loadAll().catch(() => {});
    await this._load();
  }

  async onUnmount() {
    this._stopPolling();
  }

  // Fetch one page with the current filters. append=true pages forward;
  // otherwise the list resets to page 0 (filter change / mutation reload).
  async _load({ append = false } = {}) {
    const seq = ++this._seq;
    try {
      const res = await window.api.getInbox({
        ...this._geo,
        limit: this.PAGE_SIZE,
        offset: append ? this._items.length : 0,
      });
      if (seq !== this._seq) return;
      this._processing = res.processing_sources || [];
      this._failed = res.failed_sources || [];
      this._items = append ? [...this._items, ...(res.scraps || [])] : (res.scraps || []);
      this._total = res.total || 0;
      this._facets = res.facets || {};
      this._loaded = true;
      this.render();
      window.SourceDomain.refreshInboxCount();
    } catch (err) {
      if (seq !== this._seq) return;
      this.container.innerHTML = `<div class="error-banner"><i data-lucide="cloud-off"></i>${escapeHtml(err.message || 'Could not load inbox')}</div>`;
      this.refreshIcons();
    }
  }

  _startPollingIfProcessing() {
    if (!this._processing.length) { this._stopPolling(); return; }
    if (this._pollTimer) return; // already running
    this._pollStartedAt = Date.now();
    this._pollTimer = setInterval(async () => {
      if (Date.now() - this._pollStartedAt > this.POLL_TIMEOUT_MS) { this._stopPolling(); return; }
      await this._load();
      if (!this._processing.length) this._stopPolling();
    }, this.POLL_INTERVAL_MS);
  }

  _stopPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  render() {
    if (!this._loaded) return;
    const filtered = !!(this._geo.region || this._geo.country || this._geo.city);
    const empty = !this._processing.length && !this._failed.length && !this._total && !filtered;

    this.container.innerHTML = `
      <h1 style="font-size:2rem;">Wander List</h1>
      ${empty ? `
        <div class="empty-state">
          <img src="/assets/illustrations/travel-scrapbook-empty-inbox.svg" alt="" />
          <p class="empty-title">Your list is wide open</p>
          <p class="empty-desc">Share a link from Instagram, Reddit, or Maps — new finds land here
            (or straight onto a matching trip).</p>
        </div>` : `
        ${this._processing.length ? `
          <h2 style="font-size:1.3rem;margin:1.1rem 0 0.5rem;">Reading…</h2>
          <div class="card-grid">
            ${this._processing.map((s, i) => renderSourceCard(s, { index: i, variant: 'processing' })).join('')}
          </div>` : ''}
        ${this._failed.length ? `
          <h2 style="font-size:1.3rem;margin:1.1rem 0 0.5rem;">Couldn't read</h2>
          <div class="card-grid">
            ${this._failed.map((s, i) => renderSourceCard(s, { index: i, variant: 'failed' })).join('')}
          </div>` : ''}
        ${renderFilterBar(this._geo, this._facets)}
        ${this._items.length ? `
          <div class="card-grid card-grid--2col">
            ${this._items.map((s, i) => renderScrapCard(s, { index: i, variant: 'inbox' })).join('')}
          </div>` : `
          <p class="scrap-card__sub" style="text-align:center;padding:1rem 0;">
            ${filtered ? 'Nothing here matches — clear a filter to widen the view.' : 'Nothing waiting right now.'}</p>`}
        ${this._items.length < this._total ? `
          <button class="ts-btn ts-btn--ghost" data-action="load-more" style="width:100%;margin-top:0.8rem;">
            <i data-lucide="chevrons-down"></i>Load more (showing ${this._items.length} of ${this._total})
          </button>` : ''}
      `}
      ${renderQuickPaste()}
    `;
    this.refreshIcons();
    this._bind();
    this._startPollingIfProcessing();
  }

  _bind() {
    const c = this.container;
    bindQuickPaste(c, { onCreated: () => this._load() });

    bindFilterBar(c, {
      geo: this._geo,
      onChange: (geo) => { this._geo = geo; this._load(); },
    });
    c.querySelector('[data-action=load-more]')?.addEventListener('click', (ev) => {
      ev.target.disabled = true;
      this._load({ append: true });
    });

    c.querySelectorAll('[data-action=retry-source]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await window.SourceDomain.retry(btn.dataset.sourceId); toast('Trying again…'); await this._load(); }
        catch (err) { toast(err.message, { error: true }); btn.disabled = false; }
      });
    });
    c.querySelectorAll('[data-action=dismiss-source]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirmDestructive('Dismiss this link? This can\'t be undone.')) return;
        try { await window.SourceDomain.dismiss(btn.dataset.sourceId); await this._load(); }
        catch (err) { toast(err.message, { error: true }); }
      });
    });

    c.querySelectorAll('[data-scrap-id]').forEach((el) => {
      const scrapId = el.dataset.scrapId;
      const scrap = this._items.find((s) => s.id === scrapId);
      if (!scrap) return;
      const action = el.dataset.action;
      if (el.classList.contains('sticker-card') && action === 'edit') {
        el.addEventListener('click', () => ScrapEditor.open(scrap, null, {
          onSaved: () => this._load(),
        }));
      }
      if (el.tagName !== 'BUTTON') return;
      el.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          if (action === 'rate-open') {
            PriorityPicker.open({
              activeLevel: scrap.visited_at ? 'visited' : (scrap.rating || null),
              verb: 'priority',
              withVisited: true,
              onPick: async (level) => {
                try {
                  await window.ScrapDomain.applyPriority(scrapId, null, level, !!scrap.visited_at);
                  if (level === 'visited') toast('Marked visited — see it under Visited');
                  await this._load();
                } catch (err) { toast(err.message, { error: true }); }
              },
            });
          } else if (action === 'notes') {
            NotePopup.open(scrap, { onSaved: () => this._load() });
          } else if (action === 'assign') {
            await window.SourceDomain.assignScrap(scrapId, el.dataset.tripId);
            toast('Added to the trip');
            await this._load();
          } else if (action === 'pick-trip') {
            this._openTripPicker(scrap);
          }
        } catch (err) { toast(err.message, { error: true }); }
      });
    });
  }

  _openTripPicker(scrap) {
    const trips = window.store.get('trips') || [];
    document.getElementById('inbox-trip-picker')?.remove();
    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'inbox-trip-picker';
    modal.innerHTML = `
      <div class="ts-modal__backdrop"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="Pick a trip">
        <button class="ts-modal__close" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">Add "${escapeHtml(scrap.place_name || 'this place')}" to…</h2>
        ${trips.length ? `
          <div style="display:flex;flex-direction:column;gap:0.5rem;margin-top:0.6rem;">
            ${trips.map((t) => `
              <button class="ts-btn ts-btn--ghost" data-pick-trip="${escapeAttr(t.id)}" style="justify-content:flex-start;">
                ${renderSprite('cover', t.cover_icon, { size: 'sm', alt: '' })}${escapeHtml(t.name)}
              </button>`).join('')}
          </div>` : `
          <p class="scrap-card__sub" style="margin-top:0.6rem;">No trips yet — create one from the Trips page first.</p>`}
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });
    const close = () => modal.remove();
    modal.querySelector('.ts-modal__backdrop').addEventListener('click', close);
    modal.querySelector('.ts-modal__close').addEventListener('click', close);
    modal.querySelectorAll('[data-pick-trip]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await window.SourceDomain.assignScrap(scrap.id, btn.dataset.pickTrip);
          toast('Added to the trip');
          close();
          await this._load();
        } catch (err) { toast(err.message, { error: true }); }
      });
    });
  }
}
window.InboxView = InboxView;
