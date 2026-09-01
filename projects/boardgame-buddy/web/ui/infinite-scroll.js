// ui/infinite-scroll.js — viewport sentinel + footer strip for windowed lists.
//
// The collection grids used to turn pages behind a docked prev/next footer.
// They now grow a batch at a time as the user scrolls, which needs two pieces
// every windowed list shares: an IntersectionObserver pointed at a sentinel
// below the last row, and the strip that sentinel lives in.
//
// Two things about the observer are deliberate and easy to get wrong:
//
//   * `observe()` re-points rather than adds. Every paint replaces the host's
//     contents (and a shell rebuild replaces the host itself), so a single
//     long-lived observation would end up watching a detached node.
//   * Re-observing is also what keeps the list moving. An observer whose
//     target stays intersecting across a batch never fires a second time on
//     its own, so a batch too short to push the sentinel out of range would
//     stall the list. A fresh observe() always delivers one initial callback
//     with the current intersection state, so the check repeats until the
//     sentinel is genuinely out of range or the list has run out.
//
// The margin means the next batch is fetched while the sentinel is still a
// screen or two below the fold, so rows are in place before the user arrives.

(function () {
  const ROOT_MARGIN = "600px 0px";

  class InfiniteScroll {
    /** @param {{ onLoadMore: () => void, rootMargin?: string }} opts */
    constructor({ onLoadMore, rootMargin = ROOT_MARGIN }) {
      this._onLoadMore = onLoadMore;
      this._el = null;
      this._io = InfiniteScroll.supported
        ? new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) this._onLoadMore();
          }, { rootMargin })
        : null;
    }

    /** Point the observer at `el` (or nothing, when there's no more to load). */
    observe(el) {
      if (!this._io) return;
      if (this._el) this._io.unobserve(this._el);
      this._el = el || null;
      if (this._el) this._io.observe(this._el);
    }

    disconnect() {
      if (this._io) this._io.disconnect();
      this._el = null;
    }
  }

  // Every browser the app targets has it; the manual-button fallback below
  // exists so a list can still be walked if one doesn't.
  InfiniteScroll.supported = typeof IntersectionObserver === "function";

  /**
   * The strip under a windowed grid. Exactly one of four states, and the
   * sentinel id is only ever attached to the "there is more" ones so a
   * finished list can't re-trigger a load.
   *
   * @param {Object} o
   * @param {string} o.id          Sentinel element id, unique per spoke.
   * @param {boolean} o.hasMore
   * @param {boolean} o.loading    A batch is in flight (server-fallback only).
   * @param {string|null} [o.error] Message from a failed batch.
   * @param {string} o.onRetry     JS expression for the retry / manual button.
   * @param {string} [o.endLabel]  Shown once the list is fully unrolled.
   * @returns {string}
   */
  function renderFooter({ id, hasMore, loading, error, onRetry, endLabel }) {
    if (error) {
      return `
        <div class="shelf-more shelf-more--error" role="alert">
          <span>${error}</span>
          <button class="btn btn-ghost btn-sm shelf-more__retry" onclick="${onRetry}">Retry</button>
        </div>
      `;
    }
    if (hasMore && (loading || InfiniteScroll.supported)) {
      return `
        <div class="shelf-more" id="${id}" aria-live="polite">
          <span class="shelf-more__spinner" aria-hidden="true"></span>
          <span>Loading more…</span>
        </div>
      `;
    }
    if (hasMore) {
      return `
        <div class="shelf-more">
          <button class="btn btn-primary shelf-more__btn" onclick="${onRetry}">Load more</button>
        </div>
      `;
    }
    return endLabel ? `<p class="shelf-more shelf-more--end">${endLabel}</p>` : "";
  }

  InfiniteScroll.renderFooter = renderFooter;
  window.InfiniteScroll = InfiniteScroll;
})();
