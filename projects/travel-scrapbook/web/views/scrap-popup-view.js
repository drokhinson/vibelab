// views/scrap-popup-view.js — the bookmarklet popup (/scrap?url=…&title=…).
// Chrome-less window opened from any third-party page. Because the popup is
// OUR origin, the Supabase session and API work normally — no tokens ever
// touch the page being scrapped (and no CSP fights).
'use strict';

const SCRAP_STASH_KEY = 'ts-scrap-stash';

class ScrapPopupView extends View {
  constructor() {
    super('scrap');
    this._saved = false;
  }

  async onMount() {
    document.body.classList.add('popup-mode');
    this._saved = false;

    // Preserve the target across an OAuth round-trip: /scrap → login →
    // (OAuth redirects straight back to) /scrap (params restored from the stash).
    if (this.params.url) {
      try { localStorage.setItem(SCRAP_STASH_KEY, JSON.stringify({ url: this.params.url, title: this.params.title || '' })); } catch (_) {}
    } else {
      try {
        const stash = JSON.parse(localStorage.getItem(SCRAP_STASH_KEY) || 'null');
        if (stash?.url) this.params = { ...this.params, ...stash };
      } catch (_) {}
    }

    this.listen('user', () => this.render());
    if (window.store.get('user')) {
      try { await window.TripDomain.loadAll(); } catch (_) {}
    }
  }

  async onUnmount() {
    document.body.classList.remove('popup-mode');
  }

  render() {
    const user = window.store.get('user');
    const url = this.params.url;

    if (!url) {
      this.container.innerHTML = `
        <div class="sticker-card" style="margin-top:2rem;text-align:center;">
          <p class="scrap-card__title">Nothing to save</p>
          <p class="scrap-card__sub">Open this from the bookmarklet on a page you want to save.</p>
          <button class="ts-btn ts-btn--ghost ts-btn--sm" onclick="window.router.go('trips')" style="margin-top:0.6rem;">Go to my trips</button>
        </div>`;
      return;
    }

    if (!user) {
      this.container.innerHTML = `
        <div class="sticker-card washi" style="margin-top:1.5rem;padding-top:1.5rem;">
          <h2 style="font-size:1.7rem;margin:0 0 0.2rem;">Sign in to scrap this</h2>
          <p class="scrap-card__sub" style="margin-bottom:1rem;overflow-wrap:anywhere;">${escapeHtml(this.params.title || url)}</p>
          ${renderOAuthButtons()}
          <p class="scrap-card__sub" style="text-align:center;">Email sign-in lives in the main app — this stays quick.</p>
        </div>`;
      this.refreshIcons();
      return;
    }

    if (this._saved) return; // success screen already showing

    const trips = window.store.get('trips') || [];
    let domain = '';
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {}

    this.container.innerHTML = `
      <div class="sticker-card washi washi--mint" style="margin-top:1.2rem;padding-top:1.4rem;">
        <h2 style="font-size:1.8rem;margin:0 0 0.5rem;">Save it</h2>
        <div class="sticker-card" style="padding:0.7rem;background:var(--paper);">
          <p class="scrap-card__title" style="margin:0;">${escapeHtml(this.params.title || url)}</p>
          <span class="source-badge" style="margin-top:0.3rem;"><i data-lucide="link-2"></i>${escapeHtml(domain)}</span>
        </div>
        <form id="scrap-popup-form">
          <label class="ts-label" for="sp-trip">Which trip?</label>
          ${trips.length ? `
            <select class="ts-select" id="sp-trip">
              ${trips.map((t, i) => `<option value="${escapeAttr(t.id)}" ${i === 0 ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
              <option value="__new__">＋ New trip…</option>
            </select>` : `
            <input class="ts-input" id="sp-new-trip" required placeholder="Name your first trip, e.g. Tokyo!" />`}
          <div id="sp-new-trip-wrap" class="hidden">
            <label class="ts-label" for="sp-new-trip-inline">New trip name</label>
            <input class="ts-input" id="sp-new-trip-inline" placeholder="e.g. Lisbon long weekend" />
          </div>
          <label class="ts-label" for="sp-note">Note (optional)</label>
          <input class="ts-input" id="sp-note" placeholder="why you're saving it…" maxlength="500" />
          <button class="ts-btn ts-btn--blush" type="submit" style="width:100%;margin-top:1rem;">
            <i data-lucide="scissors"></i>Save to scrapbook
          </button>
        </form>
      </div>
    `;
    this.refreshIcons();

    const select = this.container.querySelector('#sp-trip');
    select?.addEventListener('change', () => {
      this.container.querySelector('#sp-new-trip-wrap').classList.toggle('hidden', select.value !== '__new__');
    });

    this.container.querySelector('#scrap-popup-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = this.container.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        let tripId = select?.value;
        if (!tripId || tripId === '__new__' || !trips.length) {
          const nameInput = this.container.querySelector('#sp-new-trip-inline, #sp-new-trip');
          const name = nameInput?.value.trim();
          if (!name) { toast('Give the trip a name', { error: true }); btn.disabled = false; return; }
          const trip = await window.TripDomain.create({ name });
          tripId = trip.id;
        }
        const note = this.container.querySelector('#sp-note').value.trim() || null;
        await window.api.capture({
          url, title: this.params.title || null, trip_id: tripId,
          via: 'bookmarklet', notes: note,
        });
        try { localStorage.removeItem(SCRAP_STASH_KEY); } catch (_) {}
        this._showSuccess();
      } catch (err) {
        toast(err.message || 'Could not save', { error: true });
        btn.disabled = false;
      }
    });
  }

  _showSuccess() {
    this._saved = true;
    this.container.innerHTML = `
      <div class="scrap-popup__success">
        <img src="/assets/illustrations/travel-scrapbook-success.svg" alt="" />
        <h2 style="font-size:2rem;margin:0;">Saved!</h2>
        <p class="scrap-card__sub">We're reading the page — if it mentions several places, each one gets its own scrap.</p>
      </div>
    `;
    // window.close() works because the bookmarklet opened this window.
    setTimeout(() => { try { window.close(); } catch (_) {} }, 1400);
  }
}
window.ScrapPopupView = ScrapPopupView;
