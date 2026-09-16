// views/auth-view.js — the sign-in screen. Canonical OAuth pattern
// (auth-ui.md). Provider-agnostic: every call goes through domain/auth.js,
// which decides between GCP Identity Platform and Supabase Auth at boot.

(function () {
  class AuthView extends window.View {
    constructor() {
      super("auth");
      this._mode = "login";
      this._error = null;
      this._email = "";
    }

    setError(msg) {
      this._error = msg || null;
      this.render();
    }

    /**
     * An auth SDK does its own fetching, so its rejections carry none of
     * domain/api.js's normalisation — no `offline`, no `status`, just a bare
     * "Failed to fetch" (or, from Firebase, an `auth/…` code) that is true and
     * tells the user nothing. This asks the connectivity signals directly.
     *
     * It replaces a banner this screen used to paint the moment BgbNet
     * latched, before the user had typed anything. That was offline as a mode:
     * it answered a question nobody had asked, and it was wrong every time the
     * latch was stale. Signing in does need a connection — it is a network
     * call by definition — and this is where that gets said.
     *
     * @param {any} e
     * @param {string} fallback
     */
    // Firebase error codes -> what a person should read.
    //
    // Without this the sign-in screen shows Firebase's own strings, which look
    // like `Firebase: Error (auth/invalid-credential).` — vendor noise wrapped
    // around a slug, on the one screen where a confusing message makes someone
    // give up rather than retry.
    //
    // Wrong password and unknown account map to the SAME sentence on purpose.
    // Modern Firebase already collapses both into auth/invalid-credential for
    // exactly that reason, and telling a stranger which of the two it was
    // turns this form into a way to test whether an address has an account.
    static get FIREBASE_MESSAGES() {
      return {
        "auth/invalid-credential": "That email and password don't match an account.",
        "auth/wrong-password": "That email and password don't match an account.",
        "auth/user-not-found": "That email and password don't match an account.",
        "auth/invalid-email": "That doesn't look like an email address.",
        "auth/weak-password": "Pick a password with at least 6 characters.",
        "auth/too-many-requests": "Too many attempts. Wait a minute, then try again.",
        "auth/user-disabled": "That account has been disabled.",
        // Operator errors. Worded so a user is not left thinking they did
        // something wrong, and so the cause is obvious in a bug report.
        "auth/unauthorized-domain": "Sign-in is not enabled for this address yet.",
        "auth/operation-not-allowed": "That sign-in method is not enabled.",
      };
    }

    _authErrorMessage(e, fallback) {
      const code = (e && e.code) || "";
      const message = (e && e.message) || "";
      const looksOffline = navigator.onLine === false
        || !!(window.BgbNet && window.BgbNet.isOffline())
        // Firebase wraps a dead network in its own code rather than letting
        // the fetch rejection through, so the string test below never sees it.
        || code === "auth/network-request-failed"
        // Last resort, for a link that died too recently for either signal
        // above to know: this is the shape fetch() rejects with in Chromium,
        // WebKit and Gecko respectively.
        || /failed to fetch|load failed|networkerror/i.test(message);
      if (!looksOffline) {
        return AuthView.FIREBASE_MESSAGES[code] || message || fallback;
      }
      const queued = window.Outbox ? window.Outbox.count() : 0;
      // Only said when it is both true and reassuring. On a signed-out phone
      // with an empty queue it is noise on a login screen.
      return queued > 0
        ? "You're offline — signing in needs a connection. Plays you already recorded are safe on this device."
        : "You're offline — signing in needs a connection.";
    }

    render() {
      // Ask the auth layer, not config.js: supabaseUrl stays populated after
      // the swap because the DB and realtime still use it, so a check on those
      // two fields would report "configured" on a page that cannot sign anyone
      // in. BgbAuth.backend is null until one provider actually stood up.
      const configMissing = !window.BgbAuth || !window.BgbAuth.backend;
      const configBanner = configMissing
        ? `<div class="alert alert-warning mb-4 text-sm">
             <i data-icon="alert-triangle" class="w-4 h-4"></i>
             <span>Auth is not configured. Check the firebase block, or supabaseUrl / supabaseAnonKey, in config.js.</span>
           </div>`
        : "";
      const oauth = window.oauthButtons({
        disabled: configMissing,
        onGoogle: "window.authView.oauth('google')",
        onApple: "window.authView.oauth('apple')",
      });
      const errLine = this._error
        ? `<div class="text-error text-sm mb-3">${escapeHtml(this._error)}</div>` : "";
      this.container.innerHTML = `
        <div class="flex flex-col items-center justify-center min-h-[60vh] px-4">
          <div class="mb-8 text-center">
            <img src="assets/brand/bgb-logo.svg" alt="" class="w-16 h-16 mx-auto rounded-2xl mb-3" />
            <h1 class="text-3xl font-bold font-display text-base-content">Boardgame Buddy</h1>
            <p class="text-base-content/60 mt-2">Plays, buddies, and the games you reach for.</p>
          </div>
          <div class="card bg-base-200 w-full max-w-sm">
            <div class="card-body">
              ${configBanner}
              ${oauth}
              <div class="tabs tabs-boxed mb-4">
                <button class="tab ${this._mode === "login" ? "tab-active" : ""}" onclick="window.authView.switchMode('login')">Log In</button>
                <button class="tab ${this._mode === "signup" ? "tab-active" : ""}" onclick="window.authView.switchMode('signup')">Sign Up</button>
              </div>
              <form onsubmit="window.authView.submit(event)">
                <div class="form-control mb-3">
                  <input type="email" id="auth-email" placeholder="Email" class="input input-bordered w-full" value="${escapeAttr(this._email || "")}" required />
                </div>
                <div class="form-control mb-4">
                  <input type="password" id="auth-password" placeholder="Password" class="input input-bordered w-full" required minlength="6" />
                </div>
                ${errLine}
                <button type="submit" id="auth-submit" class="btn btn-primary w-full" ${configMissing ? "disabled" : ""}>
                  ${this._mode === "login" ? "Log In" : "Sign Up"}
                </button>
              </form>
            </div>
          </div>
        </div>
      `;
      this.refreshIcons();
    }

    switchMode(mode) {
      this._mode = mode;
      this._error = null;
      this.render();
    }

    async oauth(provider) {
      this._error = null;
      if (!window.BgbAuth || !window.BgbAuth.backend) {
        this.setError("Auth is not configured.");
        return;
      }
      try {
        // Google is the only provider the auth screen offers, and the Firebase
        // path is Google-specific (GoogleAuthProvider), so anything else would
        // silently sign the user in with the wrong one rather than failing.
        if (provider !== "google") throw new Error(`Unsupported provider: ${provider}`);
        await window.BgbAuth.signInWithGoogle();
      } catch (e) {
        this.setError(this._authErrorMessage(e, `${provider} sign-in failed`));
      }
    }

    async submit(event) {
      event.preventDefault();
      this._error = null;
      const btn = document.getElementById("auth-submit");
      btn.classList.add("loading");
      btn.disabled = true;
      const email = document.getElementById("auth-email").value;
      const password = document.getElementById("auth-password").value;
      this._email = email;
      try {
        if (!window.BgbAuth || !window.BgbAuth.backend) throw new Error("Auth is not configured");
        if (this._mode === "signup") {
          // BgbAuth.signUp normalises the two providers' wildly different
          // "already registered" signals into one flag — Firebase throws
          // auth/email-already-in-use, Supabase resolves with a synthetic
          // user carrying no identities. See domain/auth.js#signUp.
          const { existing, session } = await window.BgbAuth.signUp(email, password);
          if (existing) {
            // On Supabase this is common rather than exceptional: one
            // auth.users row backs every vibelab app, so a Sauceboss user
            // signing up for BGB lands here and would otherwise be told to
            // "check email" for a mail that will never arrive. Flip to
            // sign-in so they can link with the password they already have.
            this._mode = "login";
            this.setError("An account with this email already exists. Sign in with your existing password to link Boardgame Buddy.");
          } else if (session) {
            // Signed in immediately — no email confirmation configured. The
            // auth state listener lands the user on the feed.
            this.setError(null);
          } else {
            // Truly new email + email confirmation is enabled.
            this._mode = "login";
            this.setError("Account created. Check your email to confirm, then sign in.");
          }
        } else {
          await window.BgbAuth.signInWithPassword(email, password);
          window.router.go("splash");
        }
      } catch (e) {
        this.setError(this._authErrorMessage(e, "Authentication failed"));
      } finally {
        btn.classList.remove("loading");
        btn.disabled = false;
      }
    }
  }

  window.AuthView = AuthView;
})();
