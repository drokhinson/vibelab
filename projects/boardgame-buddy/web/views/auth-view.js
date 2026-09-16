// views/auth-view.js — the sign-in screen. Canonical OAuth pattern
// (auth-ui.md). Provider-agnostic: every call goes through domain/auth.js,
// which decides between GCP Identity Platform and Supabase Auth at boot.

(function () {
  class AuthView extends window.View {
    constructor() {
      super("auth");
      this._resetFormState();
    }

    /**
     * Single source of truth for this screen's transient state, per
     * .claude/rules/web-frontend.md § Async state — called from the
     * constructor, the top of onMount, and onUnmount.
     *
     * Nothing here may outlive the visit, and each field has its own reason:
     *
     *   • `_oauthBusy` disables the provider buttons, and the app comes BACK
     *     to this screen on paths that are nothing to do with the tap that set
     *     it (the boot watchdog, a rejected token, a later sign-out). Left
     *     set, it is two permanently dead buttons and no way in but a reload.
     *   • `_email` is the address the LAST person typed. This screen is where
     *     a shared tab changes hands, so it does not carry over.
     *   • `_error` and `_mode` are one attempt's; a stale "check your email"
     *     has no business greeting the next arrival.
     */
    _resetFormState() {
      this._mode = "login";
      this._error = null;
      this._email = "";
      // True from the tap that opens the Google popup until we know what came
      // of it. The provider buttons are the only thing it disables, and that
      // is the point: a second tap while the first popup is open is what
      // Firebase reports as auth/cancelled-popup-request, which kills the
      // sign-in already in progress.
      this._oauthBusy = false;
    }

    onMount() {
      this._resetFormState();
      // Deliberately not awaited: mount must not wait on the auth SDK, and
      // this screen is fully usable without an answer. _surfaceRedirectFailure
      // paints when and if there is something to say.
      this._surfaceRedirectFailure();
    }

    onUnmount() {
      this._resetFormState();
    }

    /**
     * Say why the redirect fallback came back empty-handed.
     *
     * The popup is the preferred flow (domain/auth.js#signInWithGoogle) but a
     * popup blocker or an embedded webview leaves redirect as the only route,
     * and a redirect that FAILS is silent by construction: the document was
     * replaced, so the rejection has no caller left to report to. The user
     * went to Google, came back, and landed on the login screen with no error
     * and no idea whether to try again. BgbAuth.consumeRedirectResult existed
     * for exactly this and had no callers.
     *
     * Asked from here rather than the boot path because this is the screen
     * that cares and the screen that can show an answer — no cross-module
     * handoff, and no race against the mount that would have wiped the
     * message (_resetFormState runs at the top of every mount).
     *
     * It no-ops unless this tab actually started a redirect, so the ordinary
     * popup sign-in and every later visit to this screen cost nothing.
     */
    async _surfaceRedirectFailure() {
      if (!window.BgbAuth || !window.BgbAuth.consumeRedirectResult) return;
      const err = await window.BgbAuth.consumeRedirectResult();
      // Nothing to say, or the user has already moved on — a late error must
      // not repaint a screen they have left.
      if (!err || !this._mounted) return;
      this.setError(this._authErrorMessage(err, "Google sign-in failed"));
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
        disabled: configMissing || this._oauthBusy,
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
            <p class="text-base-content/60 mt-2">Games Played, Nights Remembered.</p>
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

    /**
     * THE POPUP CLOSING IS NOT THE SIGN-IN FINISHING, and this method's whole
     * job is to stop the screen from saying otherwise.
     *
     * signInWithPopup resolves the moment the credential comes back over
     * postMessage. What happens after that is init.js's auth state listener:
     * bind the cache, and — for an account this device has never seen, which
     * is every new signup — wait on /bootstrap before it routes anywhere. This
     * method used to resolve into that gap and do nothing, so the popup
     * vanished and the login form was simply still there, complete with a live
     * "Continue with Google" button. It reads as a failure, and the obvious
     * response to it (press the button again) is the one thing that actually
     * can break the sign-in: the second popup cancels the first.
     *
     * So the form hands over to the boot loader the instant a credential
     * exists, as the email LOGIN path already did (its signup twin had the
     * same gap and is fixed below). Nothing here waits for the profile — the
     * splash is the screen that covers that leg, and every
     * way out of it is already handled (routeAfterBoot on success, /auth on a
     * genuinely bad token, the boot watchdog if the whole thing stalls).
     */
    async oauth(provider) {
      if (this._oauthBusy) return;
      this._error = null;
      if (!window.BgbAuth || !window.BgbAuth.backend) {
        this.setError("Auth is not configured.");
        return;
      }
      this._oauthBusy = true;
      // Disabling the buttons costs a full re-render, which rebuilds the email
      // field — so carry what is in it across, the way submit() does. Somebody
      // who typed an address and then chose Google should not come back from a
      // cancelled popup to an empty form.
      const typed = document.getElementById("auth-email");
      if (typed) this._email = typed.value;
      this.render();
      let outcome;
      try {
        // Google is the only provider the auth screen offers, and the Firebase
        // path is Google-specific (GoogleAuthProvider), so anything else would
        // silently sign the user in with the wrong one rather than failing.
        if (provider !== "google") throw new Error(`Unsupported provider: ${provider}`);
        outcome = await window.BgbAuth.signInWithGoogle();
      } catch (e) {
        this._oauthBusy = false;
        this.setError(this._authErrorMessage(e, `${provider} sign-in failed`));
        return;
      }
      // A shut popup is not an error and not a sign-in. Give the buttons back
      // and say nothing: the user closed a window they opened.
      if (outcome === "cancelled") {
        this._oauthBusy = false;
        this.render();
        return;
      }
      // "signed-in", or "redirecting" and this document is on its way out.
      // Either way the form has nothing left to offer. onUnmount clears the
      // latch as the router swaps the screens.
      window.router.go("splash");
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
            // Signed in immediately — no email confirmation configured.
            //
            // Hand over to the loader rather than waiting for the auth state
            // listener to land the user on the feed, for the same reason the
            // Google path does (see oauth): the listener's first move for an
            // account this device has never seen is to wait on /bootstrap,
            // and a brand-new signup is never a device that has seen it. This
            // branch used to fall through to the `finally` below, which put
            // the Sign Up button back exactly as it was — on the longest wait
            // in the app, in front of the person least able to tell that it
            // had worked.
            this._error = null;
            window.router.go("splash");
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
