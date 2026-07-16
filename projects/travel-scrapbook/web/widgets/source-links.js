// widgets/source-links.js — the scrap card's two link affordances:
//   • SourceLinks.open()     — a picker listing every source by website name
//                              (not the raw URL); tapping one opens it.
//   • SourceLinks.openMaps() — a yes/no confirm before leaving for Google Maps.
// Both are driven by inline onclick on the card buttons (data rides in data-*
// attributes), so they self-wire on every surface a scrap card renders — no
// view needs to bind them.
'use strict';

const SourceLinks = {
  // `sourcesAttr` is the JSON string from the button's data-sources attribute:
  // [{ name, url }, …].
  open(sourcesAttr) {
    let sources = [];
    try { sources = JSON.parse(sourcesAttr) || []; } catch { sources = []; }
    if (!sources.length) return;
    this.close();
    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'source-links-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="SourceLinks.close()"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="Open a source">
        <button class="ts-modal__close" onclick="SourceLinks.close()" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">Which source?</h2>
        <div class="source-links__list">
          ${sources.map((s) => `
            <a class="ts-btn ts-btn--ghost source-links__item" href="${escapeAttr(s.url)}"
               target="_blank" rel="noopener" onclick="SourceLinks.close()">
              <i data-lucide="link-2"></i><span>${escapeHtml(s.name || 'link')}</span>
            </a>`).join('')}
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });
  },

  openMaps(url) {
    if (!url) return;
    if (window.confirm('Open in Google Maps?')) {
      window.open(url, '_blank', 'noopener');
    }
  },

  close() {
    document.getElementById('source-links-modal')?.remove();
  },
};
window.SourceLinks = SourceLinks;
