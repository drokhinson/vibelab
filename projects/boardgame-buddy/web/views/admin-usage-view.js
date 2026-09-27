// views/admin-usage-view.js — the Usage spoke: how the app is being used.
//
// The fifth screen behind Settings → Admin tools, and the only one that
// moderates nothing. The other four work a queue somebody else filled; this
// one answers "how many people are here, what do they do, and what is it
// costing" — which had no answer anywhere before it, so both "the app takes a
// minute to open" and "is storage about to be a bill" were reports rather than
// numbers.
//
// This file is the LIFECYCLE — the two requests, their caches, the window
// state and the hosts it repaints. Every panel's markup is
// widgets/usage-panels.js.
//
// TWO REQUESTS, NOT ONE, and the split is why the screen feels quick:
// everything except the bucket sizes is one SQL round trip, while the R2 walk
// is dozens of HTTP requests. The buckets block has its own host and its own
// loader and is fetched AFTER first paint, so the numbers that were ready
// immediately are not held behind the slow one.
//
// THE WINDOW CONTROL DOES NOT REFETCH. The payload carries all four windows
// (24h / 7d / 30d / all) for every ranked block, so a switch is a repaint of
// the Features card from memory, in the same frame as the tap
// (`.claude/rules/web-frontend.md`). It sits inside that card because that
// card is all it changes.
//
// THE AUDIENCE CONTROL DOES. "Without admins" is a different payload (the RPC
// filters server-side), cached under its own key on both sides, so after the
// first switch each way it paints from cache too. Defaults to without admins:
// admins are the accounts doing development work.

(function () {
  // Stable hosts, so a window switch and the buckets landing each repaint one
  // region rather than the screen.
  const BODY_ID = "usage-body";
  const BUCKETS_ID = "usage-buckets";
  const FEATURES_ID = "usage-features";

  const SELF = "window.adminUsageView";

  class AdminUsageView extends window.View {
    constructor() {
      super("admin-usage");
      this._reset();
    }

    // Centralised so the constructor and onMount share one definition. This
    // view is a singleton and survives logout→login and back-stack pops, so a
    // previous session's payload would otherwise paint under the next one
    // (`.claude/rules/web-frontend.md`, "Reset transient state on every mount").
    _reset() {
      this._data = null;
      this._buckets = null;
      this._window = "last_7d";
      this._excludeAdmins = true;
      this._loading = false;
      this._error = null;
      this._bucketsLoading = false;
      this._bucketsError = null;
      this._refreshing = false;
    }

    renderLoading() {
      if (window.AdminGate.block(this)) return;
      this.container.innerHTML = `
        ${window.AdminGate.head("Usage")}
        <section class="admin-spoke__body">${window.buddyLoader({ size: 80 })}</section>
      `;
      this.refreshIcons();
    }

    async onMount() {
      if (!window.AdminGate.allowed()) return;
      this._reset();
      // Paint whatever the cache still holds before the network answers. These
      // figures move by the minute at most, so a second-stale number is a
      // better first frame than a spinner.
      this._data = window.AdminUsage.cached(this._excludeAdmins) || null;
      this._buckets = window.AdminUsage.cachedBuckets() || null;
      await this._load();
      // Only now: the bucket walk must not delay anything above it.
      this._loadBuckets();
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    async _load(opts) {
      const refresh = !!(opts && opts.refresh);
      // Marked in flight BEFORE the first paint, so no branch can fall through
      // to an empty state while the request is still out.
      this._loading = true;
      this._error = null;
      if (refresh) this._refreshing = true;
      this.render();
      const excludeAdmins = this._excludeAdmins;
      // True once the audience was switched while this was in flight: the
      // newer request owns the screen, and this answer is for the other view.
      const superseded = () => excludeAdmins !== this._excludeAdmins;
      try {
        const data = await window.AdminUsage.load({ refresh, excludeAdmins });
        if (!superseded()) this._data = data;
      } catch (e) {
        // A failed first load is NOT an empty state: it gets its own branch
        // with a retry rather than rendering "nothing here yet" over an error.
        if (!superseded()) {
          this._error = e.message || "Couldn't load usage stats";
          if (refresh) showToast(this._error, "error");
        }
      } finally {
        if (!superseded()) {
          this._loading = false;
          this._refreshing = false;
          this.render();
        }
      }
    }

    async _loadBuckets(opts) {
      const refresh = !!(opts && opts.refresh);
      this._bucketsLoading = true;
      this._bucketsError = null;
      this._patchBuckets();
      try {
        this._buckets = await window.AdminUsage.buckets({ refresh });
      } catch (e) {
        this._bucketsError = e.message || "Couldn't read the buckets";
      } finally {
        this._bucketsLoading = false;
        this._patchBuckets();
      }
    }

    // ── Paint ────────────────────────────────────────────────────────────────

    render() {
      // Re-checked on every paint, not once in onMount: View#mount() renders
      // again after onMount resolves, which would overwrite a one-shot refusal.
      if (window.AdminGate.block(this)) return;
      this.container.innerHTML = `
        ${window.AdminGate.head("Usage")}
        <section class="admin-spoke__body">
          <div id="${BODY_ID}">${this._renderBody()}</div>
        </section>
      `;
      this.refreshIcons();
    }

    /** Repaint one host, or the whole screen when that host isn't up yet. */
    _patch(id, html) {
      const host = this.container && this.container.querySelector("#" + id);
      if (!host) { this.render(); return; }
      host.innerHTML = html;
      this.refreshIcons(host);
    }

    _patchBuckets() {
      // Nothing to patch into until the body has painted; render() covers it.
      if (!this._data) return;
      this._patch(BUCKETS_ID, this._bucketRows());
    }

    _renderBody() {
      // Three branches, never conflated: an error that left us with nothing is
      // not an empty state, and an empty state is never shown while a request
      // for it is in flight.
      if (this._error && !this._data) return this._renderLoadError();
      if (!this._data) return window.buddyLoader({ size: 80 });
      const P = window.UsagePanels;
      return `
        ${P.audienceSeg(this._excludeAdmins, SELF + "._setAudience")}
        ${P.people(this._data)}
        <div id="${FEATURES_ID}">${this._renderFeatures()}</div>
        ${P.storage(this._data, BUCKETS_ID, this._bucketRows())}
        ${P.footer(this._data, {
          refreshing: this._refreshing,
          refreshHandler: SELF + "._load({ refresh: true })",
        })}
      `;
    }

    _renderFeatures() {
      return window.UsagePanels.features(this._data, this._window, SELF + "._setWindow");
    }

    _bucketRows() {
      return window.UsagePanels.bucketRows({
        buckets: (this._buckets && this._buckets.buckets) || null,
        loading: this._bucketsLoading,
        error: this._bucketsError,
        refreshHandler: SELF + "._loadBuckets({ refresh: true })",
      });
    }

    _renderLoadError() {
      return `
        <div class="usage-error">
          <h3 class="font-semibold">Couldn't load usage stats</h3>
          <p class="text-sm opacity-70 mt-1">${escapeHtml(this._error || "")}</p>
          <button class="btn btn-primary btn-sm mt-3" onclick="${SELF}._load()">Try again</button>
        </div>
      `;
    }

    // ── Interaction ──────────────────────────────────────────────────────────

    _setWindow(key) {
      if (this._window === key) return;
      this._window = key;
      // The payload already holds every window, so this is a repaint of one
      // host — no request, same frame as the tap.
      this._patch(FEATURES_ID, this._renderFeatures());
    }

    _setAudience(excludeAdmins) {
      if (this._excludeAdmins === excludeAdmins) return;
      this._excludeAdmins = excludeAdmins;
      // Paint the cached copy of the other view if there is one; otherwise the
      // loader, never the previous audience's numbers under the new label.
      this._data = window.AdminUsage.cached(excludeAdmins) || null;
      this._error = null;
      this._load();
    }
  }

  window.AdminUsageView = AdminUsageView;
})();
