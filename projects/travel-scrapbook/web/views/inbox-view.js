// views/inbox-view.js — captured links land here: sources still processing,
// sources that failed, and scraps that need a home (with trip suggestions).
'use strict';

class InboxView extends View {
  constructor() {
    super('inbox');
    this._pollTimer = null;
    this._pollStartedAt = 0;
    this.POLL_INTERVAL_MS = 2000;
    this.POLL_TIMEOUT_MS = 45000;
  }

  renderLoading() {
    this.container.innerHTML = `
      <h1 style="font-size:2rem;">Inbox</h1>
      <div class="sticker-card shimmer" style="height:80px;"></div>
      <div class="sticker-card shimmer" style="height:80px;margin-top:0.8rem;"></div>
    `;
  }

  async onMount() {
    this.listen('inbox', () => this.render());
    try {
      await window.SourceDomain.loadInbox();
      try { await window.TripDomain.loadAll(); } catch (_) {}
    } catch (err) {
      this.container.innerHTML = `<div class="error-banner"><i data-lucide="cloud-off"></i>${escapeHtml(err.message || 'Could not load inbox')}</div>`;
      this.refreshIcons();
    }
  }

  async onUnmount() {
    this._stopPolling();
  }

  _startPollingIfProcessing() {
    const inbox = window.store.get('inbox');
    const hasProcessing = (inbox?.processing_sources || []).length > 0;
    if (!hasProcessing) { this._stopPolling(); return; }
    if (this._pollTimer) return; // already running
    this._pollStartedAt = Date.now();
    this._pollTimer = setInterval(async () => {
      if (Date.now() - this._pollStartedAt > this.POLL_TIMEOUT_MS) { this._stopPolling(); return; }
      try {
        const inbox2 = await window.SourceDomain.loadInbox();
        if (!(inbox2.processing_sources || []).length) this._stopPolling();
      } catch (_) {}
    }, this.POLL_INTERVAL_MS);
  }

  _stopPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  render() {
    const inbox = window.store.get('inbox');
    if (!inbox) return;
    const processing = inbox.processing_sources || [];
    const failed = inbox.failed_sources || [];
    const scraps = inbox.scraps || [];
    const empty = !processing.length && !failed.length && !scraps.length;

    this.container.innerHTML = `
      <h1 style="font-size:2rem;">Inbox</h1>
      <p class="scrap-card__sub" style="margin-top:-0.4rem;">Everything you've saved that isn't in a trip yet.</p>
      ${empty ? `
        <div class="empty-state">
          <img src="/assets/illustrations/travel-scrapbook-empty-inbox.svg" alt="" />
          <p class="empty-title">All sorted!</p>
          <p class="empty-desc">Share a link from Instagram, Reddit, or Maps — new finds land here
            (or straight onto a matching trip).</p>
        </div>` : `
        ${processing.length ? `
          <h2 style="font-size:1.3rem;margin:1.1rem 0 0.5rem;">Reading…</h2>
          <div class="card-grid">
            ${processing.map((s, i) => renderSourceCard(s, { index: i, variant: 'processing' })).join('')}
          </div>` : ''}
        ${failed.length ? `
          <h2 style="font-size:1.3rem;margin:1.1rem 0 0.5rem;">Couldn't read</h2>
          <div class="card-grid">
            ${failed.map((s, i) => renderSourceCard(s, { index: i, variant: 'failed' })).join('')}
          </div>` : ''}
        ${scraps.length ? `
          <h2 style="font-size:1.3rem;margin:1.1rem 0 0.5rem;">Needs a home</h2>
          <div class="card-grid card-grid--2col">
            ${scraps.map((s, i) => renderScrapCard(s, { index: i, variant: 'inbox' })).join('')}
          </div>` : ''}
      `}
    `;
    this.refreshIcons();
    this._bind(scraps, failed);
    this._startPollingIfProcessing();
  }

  _bind(scraps, failed) {
    const c = this.container;

    c.querySelectorAll('[data-action=retry-source]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await window.SourceDomain.retry(btn.dataset.sourceId); toast('Trying again…'); }
        catch (err) { toast(err.message, { error: true }); btn.disabled = false; }
      });
    });
    c.querySelectorAll('[data-action=dismiss-source]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirmDestructive('Dismiss this link? This can\'t be undone.')) return;
        try { await window.SourceDomain.dismiss(btn.dataset.sourceId); }
        catch (err) { toast(err.message, { error: true }); }
      });
    });

    c.querySelectorAll('[data-scrap-id]').forEach((el) => {
      const scrapId = el.dataset.scrapId;
      const scrap = scraps.find((s) => s.id === scrapId);
      if (!scrap) return;
      const action = el.dataset.action;
      if (el.classList.contains('sticker-card') && action === 'edit') {
        el.addEventListener('click', () => ScrapEditor.open(scrap, null, {
          onSaved: () => window.SourceDomain.loadInbox().catch(() => {}),
        }));
      }
      if (el.tagName !== 'BUTTON') return;
      el.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          if (action === 'assign') {
            await window.SourceDomain.assignScrap(scrapId, el.dataset.tripId);
            toast('Added to the trip');
          } else if (action === 'pick-trip') {
            this._openTripPicker(scrap);
          } else if (action === 'delete') {
            if (!confirmDestructive('Delete this find? This can\'t be undone.')) return;
            await window.SourceDomain.removeScrap(scrapId);
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
        } catch (err) { toast(err.message, { error: true }); }
      });
    });
  }
}
window.InboxView = InboxView;
