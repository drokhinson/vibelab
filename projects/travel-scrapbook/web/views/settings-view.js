// views/settings-view.js — profile, bookmarklet install, logout.
'use strict';

class SettingsView extends View {
  constructor() { super('settings'); }

  onMount() {
    this.listen('user', () => this.render());
  }

  _bookmarkletHref() {
    const origin = window.location.origin;
    // One-liner: opens the /scrap popup with the current page's URL + title.
    return "javascript:(function(){window.open('" + origin +
      "/scrap?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)," +
      "'scrapit','width=420,height=640,popup=yes');})();";
  }

  render() {
    const user = window.store.get('user');
    if (!user) return;
    const href = this._bookmarkletHref();

    this.container.innerHTML = `
      <h1 style="font-size:2rem;">Settings</h1>

      <div class="sticker-card washi" style="padding-top:1.3rem;">
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
