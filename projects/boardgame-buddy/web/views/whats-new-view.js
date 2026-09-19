// views/whats-new-view.js — everything that has shipped, kept.
//
// The recovery path for the popup. Someone who closed the deck on slide one —
// which the deck treats as a decision, not an accident, and marks the whole
// batch seen — comes here to read what they skipped. Without this the popup's
// dismissal would be lossy, and a lossy dismissal is what makes a popup feel
// like something to survive rather than something to read.
//
// Reached from the top row of Settings' "What's new & what's next" card, above
// Feedback & bugs. The two read in time order — what landed, then what you make
// of it — which is why the archive shares that section rather than carrying one
// of its own: they are one errand, talking to whoever builds this. (There were
// three rows until the feedback board's two shortcuts collapsed into one; the
// time order is what survived, not the count.)
//
// It is still its own SPOKE rather than a card rendered inline there, for three
// reasons: settings-view.js is already 1258 lines (4x the CLAUDE.md cap),
// Settings' entire vocabulary is the one-line .set-card__row while this is a
// list of cards with rendered markdown in them, and it needs its own loading /
// empty / error branches — which is a screen, not a card.
//
// AdminGate.head() is admin-only chrome, so the header here is the same
// .spoke-head shape written out: a back arrow, because this screen is reachable
// only from Settings and back names a real destination.

(function () {
  const CACHE_NS = "whatsNew";
  const CACHE_KEY = "published";
  // Six hours. The archive changes when someone publishes a release notice —
  // on the order of once a month — so the default five minutes would be a
  // round trip bought for nothing on a list that is almost never stale. The
  // fetch still runs on every mount; this is only what the first paint reads.
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  class WhatsNewView extends window.View {
    constructor() {
      super("whats-new");
      this._bound = false;
      this._reset();
    }

    _reset() {
      this._notices = [];
      this._loading = false;
      this._loaded = false;
      this._failed = false;
      this._open = null; // the id of the expanded row, or null
    }

    async onMount() {
      // Singleton view: a previous visit's expansion must not paint under this
      // one (.claude/rules/web-frontend.md).
      this._reset();
      // Paint from whatever an earlier visit warmed — the archive changes about
      // monthly, so a cached copy is almost always current.
      const warm = window.bgbCache && window.bgbCache.get(CACHE_NS, CACHE_KEY);
      if (warm) {
        this._notices = warm;
        this._loaded = true;
      }
      this._bindOnce();
      await this._load();
    }

    /**
     * One delegated listener for the "take me there" buttons.
     *
     * On the CONTAINER, which is the stable [data-view] element, so it survives
     * every innerHTML swap below and only ever needs binding once — hence the
     * flag, since onMount runs again on every visit to a singleton view.
     * ui/release-notice-body.js emits the button with data-act rather than an
     * inline onclick so the stored route never reaches a handler string.
     */
    _bindOnce() {
      if (this._bound) return;
      this._bound = true;
      this.container.addEventListener("click", (e) => {
        const hit = e.target.closest && e.target.closest('[data-act="go"]');
        if (hit) this._go(hit.dataset.route);
      });
    }

    onUnmount() {
      this._reset();
    }

    async _load() {
      this._loading = true;
      this._failed = false;
      this.render();
      try {
        this._notices = await window.ReleaseNotices.archive();
        this._loaded = true;
        if (window.bgbCache) {
          window.bgbCache.set(CACHE_NS, CACHE_KEY, this._notices, CACHE_TTL_MS);
        }
      } catch (e) {
        // Only a failure with nothing to show is an error state; a failed
        // refresh over a warm list leaves the list alone.
        if (!this._loaded) this._failed = true;
      } finally {
        this._loading = false;
        this.render();
      }
    }

    renderLoading() {
      this.render();
    }

    render() {
      this.container.innerHTML = `
        <header class="spoke-head">
          <button class="spoke-head__back" type="button" aria-label="Back to settings"
                  onclick="window.router.back('settings')">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="spoke-head__title font-display">What's new</h2>
        </header>
        <section class="admin-spoke__body whats-new">
          ${this._renderBody()}
        </section>
      `;
      this.refreshIcons();
    }

    _renderBody() {
      // Gated on the count as well as both flags, so a refresh that cleared the
      // list before its request went out cannot fall through to the empty state.
      if (!this._notices.length && (!this._loaded || this._loading)) {
        return window.buddyLoader({ size: 80 });
      }
      if (this._failed) {
        return `
          <div class="p-6 text-center">
            <p class="opacity-60 mb-3">Couldn't load this just now.</p>
            <button class="btn btn-sm btn-primary"
                    onclick="window.whatsNewView._load()">Try again</button>
          </div>`;
      }
      if (!this._notices.length) {
        return `<div class="whats-new__empty">
          <p>Nothing here yet.</p>
          <p class="whats-new__emptysub">
            When something big lands, it'll show up once when you open the app —
            and stay here afterwards.
          </p>
        </div>`;
      }
      return `<ul class="whats-new__list">
        ${this._notices.map((n) => this._renderRow(n)).join("")}
      </ul>`;
    }

    _renderRow(n) {
      const open = this._open === n.id;
      return `
        <li class="whats-new__row ${open ? "is-open" : ""}">
          <button class="whats-new__summary" type="button" aria-expanded="${open}"
                  onclick="window.whatsNewView._toggle('${escapeAttr(n.id)}')">
            <span class="whats-new__meta">
              <span class="whats-new__date">${escapeHtml(formatDate(n.published_at))}</span>
              <span class="whats-new__title">${escapeHtml(n.title)}</span>
            </span>
            <i data-icon="${open ? "chevron-up" : "chevron-down"}" class="w-4 h-4"></i>
          </button>
          ${open
            ? `<div class="whats-new__body" data-notice="${escapeAttr(n.id)}">
                 ${window.ReleaseNoticeBody.render(n)}
               </div>`
            : ""}
        </li>
      `;
    }

    /**
     * Expand one row, collapsing any other.
     *
     * Repaints the LIST host only, not the screen: the header and the scroll
     * position stay put, so expanding a row four down does not throw the reader
     * back to the top.
     */
    _toggle(id) {
      this._open = this._open === id ? null : id;
      const host = this.container.querySelector(".whats-new");
      if (!host) return this.render();
      host.innerHTML = this._renderBody();
      this.refreshIcons(host);
    }

    /** The CTA inside an expanded notice. */
    _go(route) {
      if (route && window.router) window.router.go(route);
    }
  }

  window.WhatsNewView = WhatsNewView;
})();
