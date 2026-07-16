// views/settings-view.js — profile, bookmarklet install, logout.
'use strict';

class SettingsView extends View {
  constructor() {
    super('settings');
    this._tokenStatus = null;   // {active, created_at?, last_used_at?}
    this._freshToken = null;    // plaintext, shown once after creation
  }

  async onMount() {
    this._freshToken = null;
    this.listen('user', () => this.render());
    try {
      this._tokenStatus = await window.api.getCaptureToken();
      this.render();
    } catch (_) { /* section renders a retry-free fallback */ }
  }

  _bookmarkletHref() {
    const origin = window.location.origin;
    // One-liner: opens the /scrap popup with the current page's URL + title.
    return "javascript:(function(){window.open('" + origin +
      "/scrap?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)," +
      "'scrapit','width=420,height=640,popup=yes');})();";
  }

  _renderPhoneCapture() {
    const apiBase = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || 'http://localhost:8000';
    const captureUrl = `${apiBase}/api/v1/travel_scrapbook/capture`;
    const status = this._tokenStatus;
    const installed = window.matchMedia('(display-mode: standalone)').matches;

    let tokenBlock;
    if (this._freshToken) {
      tokenBlock = `
        <p class="scrap-card__sub" style="margin:0.5rem 0 0.3rem;"><strong>Your token</strong> — we only show this once:</p>
        <div style="display:flex;gap:0.5rem;align-items:flex-start;">
          <code id="capture-token-code" style="flex:1;background:var(--paper);border:1.5px solid var(--border);border-radius:10px;padding:0.5rem;font-size:0.75rem;overflow-wrap:anywhere;display:block;">Bearer ${escapeHtml(this._freshToken)}</code>
          <button class="ts-btn ts-btn--ghost ts-btn--sm" id="copy-capture-token" aria-label="Copy"><i data-lucide="copy"></i></button>
        </div>`;
    } else if (status?.active) {
      tokenBlock = `
        <p class="scrap-card__sub" style="margin:0.5rem 0;">
          <i data-lucide="check-circle-2" style="width:14px;height:14px;vertical-align:-2px;"></i>
          Shortcut token active${status.last_used_at ? ' · last used ' + escapeHtml(new Date(status.last_used_at).toLocaleDateString()) : ''}.
          Creating a new one replaces it.
        </p>`;
    } else {
      tokenBlock = `<p class="scrap-card__sub" style="margin:0.5rem 0;">No token yet — create one to set up the Shortcut.</p>`;
    }

    return `
      <div class="sticker-card washi washi--blush" style="padding-top:1.3rem;margin-top:1rem;">
        <h2 style="font-size:1.5rem;margin:0 0 0.3rem;">Save from your phone</h2>
        <p class="scrap-card__sub">Share from Instagram, Reddit, TripAdvisor, or Maps — the link lands in your scrapbook and we sort it into a trip.</p>

        <h3 style="font-size:1.05rem;margin:0.9rem 0 0.2rem;">iPhone — the "Scrap it" Shortcut</h3>
        ${tokenBlock}
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
          <button class="ts-btn ts-btn--sky ts-btn--sm" id="create-capture-token">
            <i data-lucide="key-round"></i>${status?.active || this._freshToken ? 'New token' : 'Create token'}
          </button>
          ${status?.active || this._freshToken ? `
            <button class="ts-btn ts-btn--ghost ts-btn--sm" id="revoke-capture-token"><i data-lucide="ban"></i>Revoke</button>` : ''}
        </div>
        <details style="margin-top:0.7rem;font-size:0.85rem;">
          <summary style="cursor:pointer;font-weight:800;">Set up the Shortcut (once, ~2 minutes)</summary>
          <ol style="font-size:0.85rem;padding-left:1.2rem;margin:0.6rem 0;line-height:1.7;">
            <li>Open the <strong>Shortcuts</strong> app → <strong>+</strong> → name it <strong>Scrap it</strong>.</li>
            <li>Tap the <strong>ⓘ</strong> info panel → turn on <strong>Show in Share Sheet</strong> → set input types to <strong>URLs and Text</strong>.</li>
            <li>Add the action <strong>Get Contents of URL</strong> and set:
              <ul style="padding-left:1rem;margin:0.2rem 0;">
                <li>URL: <code style="font-size:0.72rem;overflow-wrap:anywhere;">${escapeHtml(captureUrl)}</code></li>
                <li>Method: <strong>POST</strong></li>
                <li>Header: <code style="font-size:0.72rem;">Authorization</code> = the token above (starts with "Bearer tsc_")</li>
                <li>Request Body (JSON): field <code style="font-size:0.72rem;">text</code> = <strong>Shortcut Input</strong> (as Text)</li>
              </ul>
            </li>
            <li>Done — <strong>Scrap it</strong> now appears in the share sheet of every app.</li>
          </ol>
        </details>

        <h3 style="font-size:1.05rem;margin:1rem 0 0.2rem;">Android — install the app</h3>
        ${installed ? `
          <p class="scrap-card__sub" style="margin:0.4rem 0;">
            <i data-lucide="check-circle-2" style="width:14px;height:14px;vertical-align:-2px;"></i>
            Installed! "Travel Scrapbook" is in your share sheet — share any link to it.
          </p>` : `
          <p class="scrap-card__sub" style="margin:0.4rem 0;">In Chrome, open the <strong>⋮ menu → Add to Home screen → Install</strong>.
          Once installed, "Travel Scrapbook" appears in Android's share sheet.</p>`}
      </div>
    `;
  }

  render() {
    const user = window.store.get('user');
    if (!user) return;
    const href = this._bookmarkletHref();

    this.container.innerHTML = `
      <h1 style="font-size:2rem;">Settings</h1>

      <button class="sticker-card card-lift" id="open-tutorial" style="width:100%;text-align:left;display:flex;align-items:center;gap:0.8rem;cursor:pointer;border:2px solid var(--border);">
        <img src="/assets/illustrations/travel-scrapbook-tutorial-welcome.svg" alt="" style="width:56px;height:56px;flex-shrink:0;" />
        <span style="min-width:0;">
          <span style="display:block;font-weight:800;font-size:1.05rem;">How Travel Scrapbook works</span>
          <span class="scrap-card__sub">New here? Take the two-minute tour.</span>
        </span>
        <i data-lucide="chevron-right" style="margin-left:auto;flex-shrink:0;"></i>
      </button>

      ${this._renderPhoneCapture()}

      <div class="sticker-card washi" style="padding-top:1.3rem;margin-top:1rem;">
        <h2 style="font-size:1.5rem;margin:0 0 0.3rem;">The Scrap-It button</h2>
        <p class="scrap-card__sub">Save any page to your scrapbook in two taps — no extension needed.</p>
        <ol style="font-size:0.88rem;padding-left:1.2rem;margin:0.7rem 0;line-height:1.7;">
          <li><strong>Drag</strong> the sticker below onto your bookmarks bar.</li>
          <li>On any page you like, <strong>click it</strong> — a little window pops up.</li>
          <li>Pick the trip, hit save. Done.</li>
        </ol>
        <a class="bookmarklet-chip" href="${escapeAttr(href)}" onclick="event.preventDefault(); toast('Drag me to your bookmarks bar instead!');">
          <i data-lucide="scissors"></i>Scrap it
        </a>
        <details style="margin-top:0.9rem;font-size:0.85rem;">
          <summary style="cursor:pointer;font-weight:800;">Can't drag it? Copy it instead</summary>
          <p class="scrap-card__sub" style="margin:0.5rem 0;">Make a new bookmark, name it "Scrap it", and paste this as the URL:</p>
          <div style="display:flex;gap:0.5rem;align-items:flex-start;">
            <code id="bookmarklet-code" style="flex:1;background:var(--paper);border:1.5px solid var(--border);border-radius:10px;padding:0.5rem;font-size:0.7rem;overflow-wrap:anywhere;display:block;">${escapeHtml(href)}</code>
            <button class="ts-btn ts-btn--ghost ts-btn--sm" id="copy-bookmarklet" aria-label="Copy"><i data-lucide="copy"></i></button>
          </div>
        </details>
      </div>

      <div class="sticker-card" style="margin-top:1rem;">
        <h2 style="font-size:1.5rem;margin:0 0 0.3rem;">Profile</h2>
        <form id="profile-form">
          <label class="ts-label" for="pf-name">Display name</label>
          <div style="display:flex;gap:0.5rem;">
            <input class="ts-input" id="pf-name" value="${escapeAttr(user.display_name)}" maxlength="60" required style="flex:1;" />
            <button class="ts-btn ts-btn--mint ts-btn--sm" type="submit" style="align-self:center;">Save</button>
          </div>
        </form>
        <p class="scrap-card__sub" style="margin-top:0.6rem;">Signed in as <strong>@${escapeHtml(user.username)}</strong></p>
      </div>

      <button class="ts-btn ts-btn--ghost" id="logout-btn" style="width:100%;margin-top:1rem;">
        <i data-lucide="log-out"></i>Sign out
      </button>
    `;
    this.refreshIcons();

    this.container.querySelector('#open-tutorial')?.addEventListener('click', () => TutorialCarousel.open());

    this.container.querySelector('#create-capture-token')?.addEventListener('click', async (ev) => {
      if ((this._tokenStatus?.active || this._freshToken) &&
          !confirmDestructive('Create a new token? The old one stops working immediately.')) return;
      ev.target.disabled = true;
      try {
        const res = await window.api.createCaptureToken();
        this._freshToken = res.token;
        this._tokenStatus = { active: true, created_at: res.created_at };
        this.render();
      } catch (err) {
        toast(err.message, { error: true });
        ev.target.disabled = false;
      }
    });
    this.container.querySelector('#copy-capture-token')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(`Bearer ${this._freshToken}`);
        toast('Copied!');
      } catch (_) { toast('Copy failed — select the text manually', { error: true }); }
    });
    this.container.querySelector('#revoke-capture-token')?.addEventListener('click', async () => {
      if (!confirmDestructive('Revoke the token? The iPhone Shortcut will stop working.')) return;
      try {
        await window.api.revokeCaptureToken();
        this._freshToken = null;
        this._tokenStatus = { active: false };
        toast('Token revoked');
        this.render();
      } catch (err) { toast(err.message, { error: true }); }
    });

    this.container.querySelector('#copy-bookmarklet')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(this._bookmarkletHref());
        toast('Copied!');
      } catch (_) {
        toast('Copy failed — select the text manually', { error: true });
      }
    });

    this.container.querySelector('#profile-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const updated = await window.api.updateMe({ display_name: this.container.querySelector('#pf-name').value.trim() });
        currentUser = updated;
        window.store.set('user', updated);
        toast('Saved');
      } catch (err) { toast(err.message, { error: true }); }
    });

    this.container.querySelector('#logout-btn').addEventListener('click', () => handleLogout());
  }
}
window.SettingsView = SettingsView;
