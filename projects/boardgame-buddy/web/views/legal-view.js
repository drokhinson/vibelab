// views/legal-view.js — the shell the privacy policy and terms share.
//
// Two documents, one chrome: a titled prose page with a last-updated date and
// one way out. Extracted at instance #2 per .claude/rules/ui-object-design.md
// §4, split along lifecycle vs appearance — this file owns the frame, the exit
// and the scroll reset; each subclass supplies only `_title()`, `_updated()`
// and `_body()`. Nothing about what either document SAYS lives here.
//
// WHY THESE ARE VIEWS AND NOT STATIC .html FILES. index.html has <base href="/">
// and sw.js derives its precache list from the shell's src=/href= attributes, so
// a second HTML entry point would need its own copy of the theme boot, its own
// service-worker story, and would fall out of the bundle. A route costs two
// lines in the path table and inherits all of it.
//
// THEY MUST RESOLVE WHILE COMING_SOON IS ON. Google gates the OAuth brand
// review on the privacy and terms URLs actually loading, and the reviewer
// arrives before launch by definition. init.js's pre-launch gate therefore lets
// these two routes through to here instead of redirecting to the waitlist —
// see the `comingSoonActive()` branch in boot().

(function () {
  class LegalView extends window.View {
    /** @param {string} name Route name, which is also the data-view attribute. */
    constructor(name) {
      super(name);
    }

    // Subclass contract ──────────────────────────────────────────────────────
    /** @returns {string} The document's heading. */
    _title() { return ""; }
    /** @returns {string} ISO date the text last changed, for the dateline. */
    _updated() { return ""; }
    /** @returns {string} The document body as HTML. */
    _body() { return ""; }

    // Chrome ─────────────────────────────────────────────────────────────────
    // Reachable from the landing footer, from Settings, and from a cold deep
    // link a reviewer pasted — three entry points, so this is a close × with a
    // fallback rather than a back ← naming one parent (web-frontend.md, "Close
    // vs back"). The fallback depends on which app the visitor is in: before
    // launch there is nothing but the landing page to return to.
    _fallback() {
      const cfg = window.APP_CONFIG;
      const preLaunch = cfg && (cfg.comingSoon === true || cfg.comingSoon === "1" || cfg.comingSoon === "true");
      return preLaunch ? "landing" : "settings";
    }

    close() {
      window.router.back(this._fallback());
    }

    async onMount() {
      // A document opened from the foot of a long page would otherwise inherit
      // that page's scroll position and start halfway down clause 7.
      try { window.scrollTo(0, 0); } catch (_) {}
      this.render();
    }

    render() {
      const el = this.container;
      if (!el) return;
      const updated = this._updated();
      el.innerHTML = `
        <article class="max-w-[42rem] mx-auto py-6">
          <header class="flex items-start justify-between gap-4">
            <div>
              <h1 class="text-2xl font-bold">${this._title()}</h1>
              <p class="text-base-content/60 text-sm mt-1">
                Last updated <time datetime="${updated}">${updated}</time>
              </p>
            </div>
            <button type="button"
                    class="btn btn-ghost btn-sm btn-circle shrink-0"
                    aria-label="Close"
                    onclick="window.${this.name}View.close()">
              <i data-icon="x" class="w-5 h-5"></i>
            </button>
          </header>

          <div class="bgb-legal mt-6 text-base-content/85 leading-relaxed">
            ${this._body()}
          </div>

          <footer class="mt-10 pt-6 border-t border-base-300 text-sm text-base-content/60">
            <a class="link" href="/privacy" onclick="window.router.go('privacy'); return false;">Privacy</a>
            <span aria-hidden="true"> · </span>
            <a class="link" href="/terms" onclick="window.router.go('terms'); return false;">Terms</a>
          </footer>
        </article>`;
      this.refreshIcons();
    }
  }

  window.LegalView = LegalView;
})();
