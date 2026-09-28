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
// of its own: they are one errand, talking to whoever builds this.
//
// It is its own SPOKE rather than a card rendered inline there, for three
// reasons: settings-view.js is already several times the CLAUDE.md ~300-line cap,
// Settings' entire vocabulary is the one-line .set-card__row while this is a
// list of cards with rendered markdown in them, and it needs its own loading /
// empty / error branches — which is a screen, not a card.
//
// It is also where an admin writes them. For an admin the list is every
// notice, drafts included, under a filter and a New button, and each row carries
// Edit / Publish / Delete (widgets/release-notice-admin.js); Edit swaps the list
// for widgets/release-notice-editor.js. A reader's screen is untouched by any of
// it. /admin/release-notices is an alias of this route.
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
      this._admin = false;
      this._status = "all"; // admin filter: "all" | "draft" | "published"
      this._editing = null; // admin: a notice being edited, {} for a new one, or null
      this._saving = false;
    }

    async onMount() {
      // Singleton view: a previous visit's expansion must not paint under this
      // one (.claude/rules/web-frontend.md).
      this._reset();
      this._admin = window.AdminGate.allowed();
      // Paint from whatever an earlier visit warmed — the archive changes about
      // monthly, so a cached copy is almost always current. The cache holds the
      // published archive only, so an admin's list (drafts too) never reads it.
      const warm = !this._admin && window.bgbCache && window.bgbCache.get(CACHE_NS, CACHE_KEY);
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
        this._notices = this._admin
          ? await window.ReleaseNotices.adminList(this._status)
          : await window.ReleaseNotices.archive();
        this._loaded = true;
        if (this._admin) {
          // Any admin write can change what readers see, so the warmed archive
          // is dropped rather than refreshed from a list that holds drafts.
          if (window.bgbCache) window.bgbCache.delete(CACHE_NS, CACHE_KEY);
        } else if (window.bgbCache) {
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
        ${this._editing
          ? `<section class="admin-spoke__body">${window.ReleaseNoticeEditor.render(this._editing)}</section>`
          : `<section class="admin-spoke__body">
               ${this._admin ? window.ReleaseNoticeAdmin.renderBar(this) : ""}
               <div class="whats-new">${this._renderBody()}</div>
             </section>`}
      `;
      this.refreshIcons();
      if (this._editing) window.ReleaseNoticeEditor.bind(this);
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
      if (!this._notices.length && this._admin) {
        return `<div class="whats-new__empty">
          <p>${window.ReleaseNoticeAdmin.emptyText(this._status)}</p>
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
      const admin = this._admin;
      // A draft has no published_at, so an admin's row dates it by creation.
      const date = n.published_at || (admin ? n.created_at : null);
      return `
        <li class="whats-new__row ${open ? "is-open" : ""}">
          <button class="whats-new__summary" type="button" aria-expanded="${open}"
                  onclick="window.whatsNewView._toggle('${escapeAttr(n.id)}')">
            <span class="whats-new__meta">
              <span class="whats-new__date">
                ${admin ? window.ReleaseNoticeAdmin.renderPill(n) : ""}
                ${escapeHtml(formatDate(date))}
              </span>
              <span class="whats-new__title">${escapeHtml(n.title)}</span>
            </span>
            <i data-icon="${open ? "chevron-up" : "chevron-down"}" class="w-4 h-4"></i>
          </button>
          ${open
            ? `<div class="whats-new__body" data-notice="${escapeAttr(n.id)}">
                 ${window.ReleaseNoticeBody.render(n)}
               </div>`
            : ""}
          ${admin ? window.ReleaseNoticeAdmin.renderActions(n) : ""}
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

    // ── Admin ────────────────────────────────────────────────────────────────
    // The editor's and the admin rows' inline handlers land here; the work is
    // in widgets/release-notice-admin.js.

    async _setStatus(s) {
      if (this._status === s) return;
      this._status = s;
      this._open = null;
      this._notices = [];
      this._loaded = false;
      await this._load();
    }

    _new() {
      this._editing = {};
      this.render();
    }

    _edit(id) {
      this._editing = this._notices.find((n) => n.id === id) || null;
      this.render();
    }

    _cancelEdit() {
      this._editing = null;
      this.render();
    }

    _pickRoute() {
      window.ReleaseNoticeEditor.pickRoute(this);
    }

    _saveEdit() {
      return window.ReleaseNoticeAdmin.save(this);
    }

    _togglePublished(id) {
      return window.ReleaseNoticeAdmin.togglePublished(this, id);
    }

    _delete(id) {
      return window.ReleaseNoticeAdmin.remove(this, id);
    }

    /** The CTA inside an expanded notice. */
    _go(route) {
      if (route && window.router) window.router.go(route);
    }
  }

  window.WhatsNewView = WhatsNewView;
})();
