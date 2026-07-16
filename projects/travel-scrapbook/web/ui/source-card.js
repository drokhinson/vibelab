// ui/source-card.js — canonical Source render function (inbox surfaces).
// A source is one capture event: the URL and how it's doing. Variants:
// 'processing' (shimmer while the backend reads the page) and 'failed'
// (retry / dismiss affordances).
'use strict';

const _SOURCE_ERROR_COPY = {
  network: "Couldn't reach the page",
  blocked: 'The site blocked us',
  llm: "Couldn't read the page",
  no_place: 'No places found on this page',
};

/**
 * @param {Source} source
 * @param {{index?: number, variant?: 'processing'|'failed'}} opts
 */
function renderSourceCard(source, opts = {}) {
  const { index = 0 } = opts;
  const variant = opts.variant || (source.status === 'failed' ? 'failed' : 'processing');
  const domain = source.source_domain || 'link';

  if (variant === 'processing') {
    return `
      <div class="sticker-card source-card source-card--processing" style="--i:${index};" data-source-id="${escapeAttr(source.id)}">
        <div class="scrap-card__title shimmer" style="height:1rem;border-radius:6px;width:70%;"></div>
        <div class="scrap-card__row">
          <span class="source-badge"><i data-lucide="sparkles"></i>finding the places…</span>
          <span class="source-badge">${escapeHtml(domain)}</span>
        </div>
      </div>
    `;
  }

  const reason = _SOURCE_ERROR_COPY[source.error_kind] || "Couldn't read this one";
  return `
    <div class="sticker-card source-card source-card--failed" style="--i:${index};" data-source-id="${escapeAttr(source.id)}">
      <p class="scrap-card__title">${escapeHtml(reason)}</p>
      <p class="scrap-card__sub" style="overflow-wrap:anywhere;">${escapeHtml(source.url)}</p>
      <div class="scrap-card__row" style="margin-top:0.5rem;">
        <button class="ts-btn ts-btn--sm ts-btn--mint" data-action="retry-source" data-source-id="${escapeAttr(source.id)}">
          <i data-lucide="rotate-ccw"></i>Try again
        </button>
        <a class="ts-btn ts-btn--sm ts-btn--ghost" href="${escapeAttr(source.url)}" target="_blank" rel="noopener">
          <i data-lucide="external-link"></i>Open link
        </a>
        <button class="ts-btn ts-btn--sm ts-btn--ghost" data-action="dismiss-source" data-source-id="${escapeAttr(source.id)}" aria-label="Dismiss">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    </div>
  `;
}
