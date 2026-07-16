// views/share-view.js — the Android share-target landing (/share?url=&text=&title=).
// The installed PWA appears in the share sheet; Android routes the share here.
// Capture is silent: fire the POST immediately and show a small "Saved"
// confirmation so the user can flick back to Instagram/Reddit/Maps. Android
// apps often put the URL inside `text`, so both params are checked.
'use strict';

const SHARE_STASH_KEY = 'ts-share-stash';
const SHARE_URL_RE = /https?:\/\/\S+/;

class ShareView extends View {
  constructor() {
    super('share');
    this._state = 'idle'; // idle | saving | saved | error
    this._sourceId = null;
    this._importScraps = [];
    this._importStatus = 'processing';
    this._pollTimer = null;
    this._pollSeq = 0;
  }

  _targetUrl() {
    if (this.params.url && SHARE_URL_RE.test(this.params.url)) return this.params.url;
    const m = (this.params.text || '').match(SHARE_URL_RE);
    return m ? m[0] : null;
  }

  async onMount() {
    document.body.classList.add('popup-mode');
    this._state = 'idle';
    this._sourceId = null;
    this._importScraps = [];
    this._importStatus = 'processing';

    // Survive an OAuth round-trip, same pattern as the bookmarklet popup.
    if (this.params.url || this.params.text) {
      try {
        localStorage.setItem(SHARE_STASH_KEY, JSON.stringify({
          url: this.params.url || '', text: this.params.text || '', title: this.params.title || '',
        }));
      } catch (_) {}
    } else {
      try {
        const stash = JSON.parse(localStorage.getItem(SHARE_STASH_KEY) || 'null');
        if (stash && (stash.url || stash.text)) this.params = { ...this.params, ...stash };
      } catch (_) {}
    }

    this.listen('user', () => {
      if (window.store.get('user') && this._state === 'idle') this._save();
      else this.render();
    });
    if (window.store.get('user')) await this._save();
  }

  async onUnmount() {
    document.body.classList.remove('popup-mode');
    this._stopImportPoll();
  }

  async _save() {
    const url = this._targetUrl();
    if (!url || this._state !== 'idle') { this.render(); return; }
    this._state = 'saving';
    this.render();
    try {
      const src = await window.api.capture({
        url,
        text: this.params.text || null,
        title: this.params.title || null,
        via: 'share',
      });
      this._sourceId = src?.id || null;
      try { localStorage.removeItem(SHARE_STASH_KEY); } catch (_) {}
      this._state = 'saved';
      window.SourceDomain?.refreshInboxCount();
    } catch (err) {
      console.warn('[travel-scrapbook] share capture failed:', err);
      this._state = 'error';
      this._error = err.message || 'Could not save';
    }
    this.render();
  }

  render() {
    const user = window.store.get('user');
    const url = this._targetUrl();

    if (!url) {
      this.container.innerHTML = `
        <div class="sticker-card" style="margin-top:2rem;text-align:center;">
          <p class="scrap-card__title">Nothing to save</p>
          <p class="scrap-card__sub">Share a link here from another app and it lands in your scrapbook.</p>
          <button class="ts-btn ts-btn--ghost ts-btn--sm" onclick="window.router.go('trips')" style="margin-top:0.6rem;">Go to my trips</button>
        </div>`;
      return;
    }

    if (!user) {
      this.container.innerHTML = `
        <div class="sticker-card washi" style="margin-top:1.5rem;padding-top:1.5rem;">
          <h2 style="font-size:1.7rem;margin:0 0 0.2rem;">Sign in to save this</h2>
          <p class="scrap-card__sub" style="margin-bottom:1rem;overflow-wrap:anywhere;">${escapeHtml(this.params.title || url)}</p>
          ${renderOAuthButtons()}
          <p class="scrap-card__sub" style="text-align:center;">One-time sign-in — after this, shares save instantly.</p>
        </div>`;
      this.refreshIcons();
      return;
    }

    if (this._state === 'saving' || this._state === 'idle') {
      this.container.innerHTML = `
        <div class="scrap-popup__success">
          <div class="sticker-card shimmer" style="width:72px;height:72px;border-radius:20px;"></div>
          <h2 style="font-size:1.6rem;margin:0.6rem 0 0;">Saving…</h2>
        </div>`;
      return;
    }

    if (this._state === 'error') {
      this.container.innerHTML = `
        <div class="sticker-card" style="margin-top:2rem;text-align:center;">
          <p class="scrap-card__title">Hmm, that didn't save</p>
          <p class="scrap-card__sub">${escapeHtml(this._error || 'Something went wrong')}</p>
          <button class="ts-btn ts-btn--mint ts-btn--sm" id="share-retry" style="margin-top:0.6rem;"><i data-lucide="rotate-ccw"></i>Try again</button>
        </div>`;
      this.refreshIcons();
      this.container.querySelector('#share-retry')?.addEventListener('click', () => {
        this._state = 'idle';
        this._save();
      });
      return;
    }

    // saved
    this.container.innerHTML = `
      <div class="scrap-popup__success">
        <img src="/assets/illustrations/travel-scrapbook-success.svg" alt="" />
        <h2 style="font-size:2rem;margin:0;">Saved!</h2>
        <p class="scrap-card__sub">We're finding the places in it. They'll be sorted into a trip
          or added to your Wander List — you can switch back to your app.</p>
        <button class="ts-btn ts-btn--blush ts-btn--sm" id="share-open-inbox" style="margin-top:0.8rem;">
          <i data-lucide="heart"></i>View Wander List
        </button>
      </div>
      <div id="share-import-cards" style="margin-top:1.2rem;"></div>
    `;
    this.refreshIcons();
    this.container.querySelector('#share-open-inbox')?.addEventListener('click', () => {
      document.body.classList.remove('popup-mode');
      window.router.go('inbox');
    });
    this._renderImportCards();
    if (this._sourceId) this._startImportPoll();
  }

  // Poll the just-captured source and show its scraps as they're extracted, so
  // the user watches the import happen (and a stuck/failed one is visible).
  _startImportPoll() {
    this._stopImportPoll();
    const seq = ++this._pollSeq;
    const startedAt = Date.now();
    const tick = async () => {
      if (seq !== this._pollSeq || !this._sourceId) return;
      try {
        const res = await window.api.sourceScraps(this._sourceId);
        if (seq !== this._pollSeq) return;         // navigated / re-saved
        this._importScraps = res.scraps || [];
        this._importStatus = res.status;
        this._renderImportCards();
        const done = res.status === 'ready' || res.status === 'failed';
        if (done || Date.now() - startedAt > 60000) this._stopImportPoll();
      } catch (_) { /* transient — keep polling */ }
    };
    tick();
    this._pollTimer = setInterval(tick, 2000);
  }

  _stopImportPoll() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  _renderImportCards() {
    const host = this.container.querySelector('#share-import-cards');
    if (!host) return;
    const scraps = this._importScraps || [];
    const stillReading = this._importStatus === 'processing';
    const failed = this._importStatus === 'failed';
    host.innerHTML = `
      ${scraps.length ? `
        <div class="card-grid card-grid--2col">
          ${scraps.map((s, i) => renderScrapCard(s, { index: i, variant: 'preview' })).join('')}
        </div>` : ''}
      ${stillReading ? `
        <p class="scrap-card__sub" style="text-align:center;margin-top:0.6rem;">
          <span class="shimmer" style="display:inline-block;width:16px;height:16px;border-radius:50%;vertical-align:-3px;"></span>
          Finding places…</p>` : ''}
      ${!scraps.length && failed ? `
        <p class="scrap-card__sub" style="text-align:center;">Couldn't read that one — it'll show in your Wander List to retry.</p>` : ''}
    `;
    this.refreshIcons(host);
  }
}
window.ShareView = ShareView;
