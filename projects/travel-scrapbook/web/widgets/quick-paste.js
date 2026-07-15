// widgets/quick-paste.js — the paste-a-link box on the trip view.
'use strict';

function renderQuickPaste(tripId) {
  return `
    <form class="sticker-card washi--mint washi" id="quick-paste-form" data-trip-id="${escapeAttr(tripId)}"
          style="display:flex;gap:0.5rem;align-items:center;margin:1.1rem 0;padding-top:1.1rem;">
      <input class="ts-input" id="quick-paste-input" type="url" required
             placeholder="Paste a link — Reddit, Instagram, a blog…"
             style="flex:1;" inputmode="url" autocomplete="off" />
      <button class="ts-btn ts-btn--blush" type="submit" aria-label="Scrap it">
        <i data-lucide="scissors"></i><span class="hidden sm:inline">Scrap it</span>
      </button>
    </form>
  `;
}

function bindQuickPaste(container, { onCreated } = {}) {
  const form = container.querySelector('#quick-paste-form');
  if (!form) return;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = form.querySelector('#quick-paste-input');
    const url = input.value.trim();
    if (!url) return;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await window.ScrapDomain.capture(form.dataset.tripId, url);
      input.value = '';
      toast('Scrapped! Reading the page — it may add more than one place.');
      onCreated?.();
    } catch (err) {
      toast(err.message || 'Could not save that link', { error: true });
    } finally {
      btn.disabled = false;
    }
  });
}
