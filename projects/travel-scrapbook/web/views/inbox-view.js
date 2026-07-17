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
    // Captured once per visit so the "New" tags stay put across background
    // revalidates/polls; re-stamped on leave so they clear on the next visit.
    this._lastVisitAt = null;
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
    // Snapshot the previous visit time BEFORE anything repaints — items imported
    // after it get the "New" tag for this visit (see onUnmount for the re-stamp).
    this._lastVisitAt = window.SourceDomain?.getInboxLastVisit() || null;
    // Stale-while-revalidate: paint the cached page instantly on re-entry,
    // refresh in the background. (Suggestion chips ride on the scraps; the
    // trip picker lazy-loads trips when opened — no trips fetch here.)
    const cached = window.tsCache?.get('inbox', this._cacheKey());
    if (cached) {
      this._applyPage(cached);
      this.render();
      this._load().catch(() => {});
      return;
    }
    await this._load();
  }

  async onUnmount() {
    this._stopPolling();
    // Leaving the page = these items are no longer "new": stamp now, which also
    // resets the badge to 0 and clears the tags on the next visit.
    window.SourceDomain?.markInboxVisited();
  }

  _cacheKey() { return JSON.stringify(this._geo); }

  // A place is "new" when it was imported after the visit we snapshotted at mount.
  _isNew(scrap) {
    if (!this._lastVisitAt || !scrap.created_at) return false;
    return new Date(scrap.created_at) > new Date(this._lastVisitAt);
  }

  _applyPage(page) {
    this._processing = page.processing || [];
    this._failed = page.failed || [];
    this._items = page.items || [];
    this._total = page.total || 0;
    this._facets = page.facets || {};
    this._loaded = true;
  }

  // Fetch one page with the current filters (via the shared loader, which
  // also caches page 0 and feeds the nav badge). append=true pages forward;
  // otherwise the list resets to page 0 (filter change / mutation reload).
  async _load({ append = false } = {}) {
    const seq = ++this._seq;
    try {
      const page = await window.BrowsePages.loadInbox({
        geo: this._geo,
        limit: this.PAGE_SIZE,
        offset: append ? this._items.length : 0,
      });
      if (seq !== this._seq) return;
      // A revalidate that changed nothing must not repaint (the rebuild
      // replays entrance animations — the "blink").
      if (!append && this._loaded && JSON.stringify(page) === JSON.stringify({
        processing: this._processing, failed: this._failed,
        items: this._items, total: this._total, facets: this._facets,
      })) return;
      this._processing = page.processing;
      this._failed = page.failed;
      this._items = append ? [...this._items, ...page.items] : page.items;
      this._total = page.total;
      this._facets = page.facets;
      this._loaded = true;
      this.render();
    } catch (err) {
      if (seq !== this._seq || this._loaded) return; // keep stale content on a failed refresh
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
            ${this._items.map((s, i) => renderScrapCard(s, { index: i, variant: 'inbox', isNew: this._isNew(s) })).join('')}
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
    this.settleMotion();
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
            // Multi-select: a place can be in several trips at once, and stays
            // on the Wander List regardless.
            AddToTrips.open(scrap, { onSaved: () => this._load() });
          }
        } catch (err) { toast(err.message, { error: true }); }
      });
    });
  }
}
window.InboxView = InboxView;
