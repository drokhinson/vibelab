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
// THEY MUST RESOLVE FOR A SIGNED-OUT STRANGER. Google's OAuth consent screen
// links to both permanently, and its brand review loads them directly, so a
// visitor with no account and no session has to be able to read them. That is
// why they are routes above the auth gate rather than pages inside Settings.
//
// A pre-launch COMING_SOON gate used to carve out an exception for exactly
// these two; the gate is gone, but the requirement it was serving is not.

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
    // vs back").
    //
    // router.back() only reaches the fallback when there is no history to go
    // back to, which is the cold-deep-link case: someone who opened /privacy
    // directly, signed in or not. Settings is where the links live, so it is
    // the honest parent; an unauthenticated visitor lands on the auth screen
    // from there, same as any other route.
    close() {
      window.router.back("settings");
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
