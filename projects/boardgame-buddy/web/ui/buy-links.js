// ui/buy-links.js — the "Where to buy" section: one pill per live partner.
//
// RENDERS NOTHING FROM NOTHING. An empty list returns "" — not a heading with
// no pills, not a "coming soon", not the disclosure on its own. That is how
// the whole affiliate feature stays invisible until an admin switches a
// partner on (domain/affiliate.js), and tools/check-affiliate-links.mjs pins
// it.
//
// The disclosure is part of the component, not the page: the FTC line and any
// sentence a program requires beside its links (Amazon's "As an Amazon
// Associate…") travel with the pills, so no surface can show one without the
// other. Programs' sentences arrive on the link rows from the server; the
// generic line is here because it is ours.
//
// Lifecycle-free: returns a string. The tap is a real <a target="_blank">; the
// onclick only counts it (Affiliate.click is fire-and-forget) and never
// preventDefaults, so the retailer opens whether or not the count lands.

(function () {
  const DISCLOSURE =
    "Some links are affiliate links. If you buy through one, BoardgameBuddy may " +
    "earn a small commission at no extra cost to you.";

  /**
   * @param {Array<{partner_id:string, label:string, url:string, disclosure?:string|null}>} links
   * @param {{surface?: "game_detail"|"discover", gameId?: string|null}} [opts]
   * @returns {string} "" when there is nothing to show
   */
  function renderBuyLinks(links, opts) {
    const list = Array.isArray(links) ? links.filter((l) => l && l.url && l.partner_id) : [];
    if (!list.length) return "";
    const surface = (opts && opts.surface) || "game_detail";
    const gameId = (opts && opts.gameId) || "";
    const pills = list.map((l) => `
      <a class="buy-links__pill" href="${escapeAttr(l.url)}" target="_blank"
         rel="noopener nofollow sponsored"
         onclick="window.Affiliate && window.Affiliate.click('${escapeAttr(l.partner_id)}', '${escapeAttr(gameId)}', '${escapeAttr(surface)}')">
        <span class="buy-links__pill-label">${escapeHtml(l.label)}</span>
        <i data-icon="external-link" class="w-3.5 h-3.5"></i>
      </a>`).join("");
    // Each program's required sentence once, in partner order, after ours.
    const seen = new Set();
    const required = list
      .map((l) => (l.disclosure || "").trim())
      .filter((d) => d && !seen.has(d) && seen.add(d))
      .map((d) => `<span class="buy-links__required">${escapeHtml(d)}</span>`)
      .join(" ");
    return `
      <section class="game-detail__section buy-links" data-surface="${escapeAttr(surface)}">
        <h3 class="game-detail__section-title">
          <i data-icon="box" class="w-4 h-4"></i>
          Where to buy
        </h3>
        <div class="buy-links__row">${pills}</div>
        <p class="buy-links__disclosure">${escapeHtml(DISCLOSURE)} ${required}</p>
      </section>
    `;
  }

  window.renderBuyLinks = renderBuyLinks;
  window.renderBuyLinks.DISCLOSURE = DISCLOSURE;
})();
