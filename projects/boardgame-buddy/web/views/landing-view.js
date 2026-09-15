// views/landing-view.js — the signed-out root while COMING_SOON is on.
//
// splash-view.js is the boot loader and auth-view.js is a bare login form;
// neither is a surface you can point a domain at. This is that surface: what
// bgbuddy.app serves before the app goes live, and where the app-store badges
// go when the native apps ship.
//
// It captures an email and creates NO account, which is a correctness
// requirement rather than a soft launch: Firebase's importUsers does not dedupe
// on email, so any real signup taken before the Supabase users are imported
// becomes a duplicate identity to reconcile by hand. See Docs/MIGRATION_PLAN.md
// "Waitlist only before launch".
//
// The gate lives in init.js and reads window.APP_CONFIG.comingSoon, which
// build.sh writes from the BGB_COMING_SOON repo variable. Going live is
// therefore flipping a variable and redeploying — not a code change, and not a
// domain move. ?preview=1 bypasses it so the real app can be smoke-tested on
// the live domain before DNS is cut over; see init.js.

(function () {
  class LandingView extends window.View {
    constructor() {
      super("landing");
      this._state = "idle"; // idle | sending | done | invalid | failed
    }

    async submit(event) {
      if (event) event.preventDefault();
      const input = document.getElementById("landing-email");
      const email = (input && input.value || "").trim();
      if (!email) return;

      this._state = "sending";
      this.render();

      try {
        const res = await window.api.post("/waitlist", { email, source: "landing" });
        // The endpoint answers ok:false only for an address it could not have
        // written — a duplicate and a real save both come back ok:true on
        // purpose, so the page cannot be used to probe who signed up.
        this._state = res && res.ok === false ? "invalid" : "done";
      } catch (e) {
        this._state = "failed";
      }
      this.render();
    }

    _note() {
      switch (this._state) {
        case "done":
          return `<p class="text-success text-sm mt-3" role="status">
                    You're on the list. We'll email you when it opens.
                  </p>`;
        case "invalid":
          return `<p class="text-error text-sm mt-3" role="alert">
                    That address doesn't look right — check it and try again.
                  </p>`;
        case "failed":
          return `<p class="text-error text-sm mt-3" role="alert">
                    Couldn't reach the server. Try again in a moment.
                  </p>`;
        default:
          return "";
      }
    }

    _form() {
      if (this._state === "done") return "";
      const busy = this._state === "sending";
      return `
        <form class="w-full mt-6" onsubmit="window.landingView.submit(event)">
          <label for="landing-email" class="sr-only">Email address</label>
          <div class="flex flex-col sm:flex-row gap-2">
            <input
              id="landing-email"
              name="email"
              type="email"
              inputmode="email"
              autocomplete="email"
              required
              placeholder="you@example.com"
              class="input input-bordered flex-1 min-w-0"
              ${busy ? "disabled" : ""}
            />
            <button type="submit" class="btn btn-primary ${busy ? "loading" : ""}" ${busy ? "disabled" : ""}>
              ${busy ? "Adding…" : "Keep me posted"}
            </button>
          </div>
        </form>`;
    }

    render() {
      const el = this.container;
      if (!el) return;
      el.innerHTML = `
        <div class="flex flex-col items-center text-center max-w-[32rem] mx-auto py-8">
          <img src="assets/brand/bgb-logo.svg" alt=""
               width="72" height="72" class="rounded-2xl" />
          <h1 class="text-3xl font-bold mt-5">Boardgame Buddy</h1>
          <p class="text-base-content/70 mt-2 text-lg">
            A log for the games you actually played.
          </p>

          <img src="assets/illustrations/bgb-hero.svg" alt=""
               class="w-full max-w-[22rem] mt-7" />

          <p class="text-base-content/80 mt-7 leading-relaxed">
            Log a play in three screens, keep a per-game reference guide your
            table can read mid-game, and see what your buddies have been
            playing. Opening soon.
          </p>

          ${this._form()}
          ${this._note()}

          <p class="text-base-content/50 text-xs mt-8">
            One email when it opens. Nothing else, ever.
          </p>
        </div>`;
    }
  }

  window.LandingView = LandingView;
})();
