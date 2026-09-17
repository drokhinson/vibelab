// ui/release-notice-body.js — one release notice's contents, rendered once.
//
// Two surfaces show the same thing: the popup deck's slide and the Settings
// "What's new" archive row. Extracted at instance #2, which
// .claude/rules/ui-object-design.md §4 names as the moment — by #4 the copies
// have diverged and the extraction becomes a redesign.
//
// Contents only. Neither the slide's track geometry nor the archive row's
// disclosure chrome lives here, which is the split that lets the two surfaces
// look different without this file growing an options matrix.

(function () {
  /**
   * The "take me there" button, or "" when it cannot be built.
   *
   * Asked of the ROUTER, not of the stored string. link_route outlives the
   * route table — someone retires a route and every notice pointing at it
   * keeps its button — and a dead button is worse than no button: it reads as
   * the app being broken on the one screen that was announcing new work.
   * pathFor() returning null is the only honest test, and it costs one call.
   */
  function cta(notice) {
    if (!notice || !notice.link_route) return "";
    if (!window.router || !window.router.pathFor(notice.link_route, {})) return "";
    const label = (notice.link_label || "").trim() || "Take me there";
    return `
      <button class="rel-note__cta" type="button"
              data-act="go" data-route="${escapeAttr(notice.link_route)}">
        <span>${escapeHtml(label)}</span>
        <i data-icon="arrow-right" class="w-4 h-4"></i>
      </button>
    `;
  }

  /**
   * One notice as markup.
   *
   * @param {Object} notice  a ReleaseNotice row
   * @param {Object} [opts]
   * @param {boolean} [opts.cta=true]  render the "take me there" button
   * @returns {string}
   */
  function render(notice, opts) {
    if (!notice) return "";
    const o = opts || {};
    const withCta = o.cta !== false;
    // body_md goes through renderMarkdown, which escapes everything first and
    // lets only http(s), mailto and root-relative hrefs back through — so an
    // admin cannot smuggle script into a card every user is shown.
    return `
      <div class="rel-note__date">${escapeHtml(formatDate(notice.published_at))}</div>
      <h3 class="rel-note__title font-display">${escapeHtml(notice.title || "")}</h3>
      <div class="rel-note__body">${renderMarkdown(notice.body_md || "")}</div>
      ${withCta ? cta(notice) : ""}
    `;
  }

  window.ReleaseNoticeBody = { render, cta };
})();
