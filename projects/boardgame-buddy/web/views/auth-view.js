// views/auth-view.js — Supabase Auth. Canonical OAuth pattern (auth-ui.md).

(function () {
  class AuthView extends window.View {
    constructor() {
      super("auth");
      this._mode = "login";
      this._error = null;
      this._email = "";
    }

    onMount() {
      // Bound once. The form is re-rendered on tab switches but mount is single-shot.
    }

    setError(msg) {
      this._error = msg || null;
      this.render();
    }

    render() {
      const cfg = window.APP_CONFIG;
      const configMissing = !cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey;
      const configBanner = configMissing
        ? `<div class="alert alert-warning mb-4 text-sm">
             <i data-lucide="alert-triangle" class="w-4 h-4"></i>
             <span>Supabase auth is not configured. Check supabaseUrl / supabaseAnonKey in config.js.</span>
           </div>`
        : "";
      const oauth = window.oauthButtons({
        disabled: configMissing,
        onGoogle: "window.authView.oauth('google')",
        onApple: "window.authView.oauth('apple')",
      });
      const errLine = this._error
        ? `<div class="text-error text-sm mb-3">${this._error}</div>` : "";

      this.container.innerHTML = `
        <div class="flex flex-col items-center justify-center min-h-[60vh] px-4">
          <div class="mb-8 text-center">
            <img src="assets/brand/bgb-logo.svg" alt="" class="w-16 h-16 mx-auto rounded-2xl mb-3" />
            <h1 class="text-3xl font-bold font-display text-base-content">BoardgameBuddy</h1>
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
                  <input type="email" id="auth-email" placeholder="Email" class="input input-bordered w-full" value="${this._email || ""}" required />
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
      if (window.lucide) window.lucide.createIcons();
    }

    switchMode(mode) {
      this._mode = mode;
      this._error = null;
      this.render();
    }

    async oauth(provider) {
      this._error = null;
      if (!window.supabaseClient) {
        this.setError("Auth is not configured.");
        return;
      }
      try {
        const { error } = await window.supabaseClient.auth.signInWithOAuth({
          provider,
          options: { redirectTo: window.location.origin },
        });
        if (error) throw error;
      } catch (e) {
        this.setError(e.message || `${provider} sign-in failed`);
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
        if (!window.supabaseClient) throw new Error("Auth is not configured");
        if (this._mode === "signup") {
          const { data, error } = await window.supabaseClient.auth.signUp({ email, password });
          if (error) throw error;
          // Supabase returns a synthetic user with empty `identities` (and
          // sends no email) when the address is already registered — the
          // anti-enumeration path. Across vibelab apps the same auth.users
          // row backs every app, so this case is common: a Sauceboss user
          // signs up for BGB and would otherwise be told to "check email"
          // for a mail that will never arrive. Flip to sign-in instead so
          // they can link with their existing password.
          if (data?.user && (data.user.identities?.length ?? 0) === 0) {
            this._mode = "login";
            this.setError("An account with this email already exists in another vibelab app. Sign in with your existing password to link BoardgameBuddy.");
          } else if (data?.session) {
            // Project is configured without email confirmation; the auth
            // state listener will land the user on the feed.
            this.setError(null);
          } else {
            // Truly new email + email confirmation is enabled.
            this._mode = "login";
            this.setError("Account created. Check your email to confirm, then sign in.");
          }
        } else {
          const { error } = await window.supabaseClient.auth.signInWithPassword({ email, password });
          if (error) throw error;
          window.router.go("splash");
        }
      } catch (e) {
        this.setError(e.message || "Authentication failed");
      } finally {
        btn.classList.remove("loading");
        btn.disabled = false;
      }
    }
  }

  window.AuthView = AuthView;
})();
