// widgets/quick-paste.js — the "scrap a link" box, rendered as a sticky
// footer at the bottom of the browse views (Wander List, Visited, Community)
// and the trip view, so capture is always one glance away. With a tripId the
// capture lands straight on that trip (and the trip polls for the results);
// without one it lands on the Wander List.
'use strict';

// Discovery + recording mark: a place pin being added. Older lucide builds
// may not know map-pin-plus, so fall back to bookmark-plus at icon time.
const QUICK_PASTE_ICON =
  (window.lucide?.icons && !window.lucide.icons.MapPinPlus && !window.lucide.icons['map-pin-plus'])
    ? 'bookmark-plus' : 'map-pin-plus';

function renderQuickPaste(tripId = null) {
  return `
    <form class="scrap-footer" id="quick-paste-form" ${tripId ? `data-trip-id="${escapeAttr(tripId)}"` : ''}>
      <input class="ts-input" id="quick-paste-input" type="url" required
             placeholder="${tripId ? 'Paste a link — a place, or a hotel/travel booking…' : 'Paste a link — Reddit, Instagram, a blog…'}"
             style="flex:1;margin:0;" inputmode="url" autocomplete="off" />
      <button class="ts-btn ts-btn--blush" type="submit" aria-label="Scrap it">
        <i data-lucide="${QUICK_PASTE_ICON}"></i><span class="hidden sm:inline">Scrap it</span>
      </button>
    </form>
  `;
}

// `onCapture(url)` lets a view own the capture instead of the default paths —
// e.g. the Visited tab captures the URL as *born visited* (ScrapDomain.
// captureVisited) and paints its own processing card. When given, the handler
// owns its own success toast.
function bindQuickPaste(container, { onCreated, onCapture } = {}) {
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
      const tripId = form.dataset.tripId;
      if (onCapture) {
        await onCapture(url);
      } else if (tripId) {
        // Trip capture: the trip polls until the new scraps land.
        await window.ScrapDomain.capture(tripId, url);
        toast('Scrapped! Reading the link — places land as plans, bookings as checkpoints.');
      } else {
        await window.api.capture({ url, via: 'paste' });
        window.SourceDomain?.refreshInboxCount();
        toast('Scrapped! Reading the page — it may add more than one place.');
      }
      input.value = '';
      onCreated?.();
    } catch (err) {
      toast(err.message || 'Could not save that link', { error: true });
    } finally {
      btn.disabled = false;
    }
  });
}
