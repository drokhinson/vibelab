// domain/auth.js — the one place that knows which identity provider is live.
//
// Two backends, chosen at boot from window.APP_CONFIG:
//
//   * `firebase`  when config.js carries a complete firebase block
//   * `supabase`  otherwise
//
// Runtime selection rather than a code swap, for three reasons that all cost
// real time when they go wrong:
//
//   1. Rollback is flipping the BGB_FIREBASE_* repo variables off and
//      re-running the deploy workflow, not reverting a commit and waiting.
//   2. Local dev has no Firebase config (build.sh reads env vars that only
//      CI sets), so `python -m http.server` keeps working against Supabase.
//   3. The old Vercel deployment is still live until the cutover, and it is
//      built from the same tree.
//
// The backend that is NOT selected is never initialised, so there is exactly
// one source of truth for `window.session` at any moment.
//
// -----------------------------------------------------------------------------
// The session shape is a contract, not an implementation detail.
//
// Callers across the app read exactly two things off `window.session`:
// `access_token` (domain/api.js#_authHeader, domain/outbox.js:233) and
// `user.id` (domain/outbox.js#_currentUid). Supabase's own session object
// happens to have both; the Firebase path therefore SYNTHESISES the same
// shape rather than publishing a Firebase user and making ~14 call sites
// learn a second one:
//
//     { access_token: "<jwt>", user: { id, email } }
//
// `user.id` is the Firebase uid, which for every imported account IS the
// original Supabase UUID (see tools/import-users-to-firebase.mjs). That is
// what lets boardgamebuddy_profiles.id keep matching after the swap.
// -----------------------------------------------------------------------------

(function () {
  const FB_SDK_VERSION = "10.14.1";

  let _backend = null;
  let _fbAuth = null;

  function _cfg() {
    return window.APP_CONFIG || {};
  }

  function _firebaseConfigured() {
    const f = _cfg().firebase;
    return !!(f && f.apiKey && f.authDomain && f.projectId && f.appId);
  }

  /** Session in the shape the rest of the app already reads. */
  function _session(token, user) {
    return {
      access_token: token,
      user: { id: user.uid, email: user.email || "" },
    };
  }

  // ── Firebase ───────────────────────────────────────────────────────────────

  function _initFirebase() {
    if (!window.firebase || !window.firebase.initializeApp) {
      console.error(
        "Firebase SDK did not load. NOT falling back to Supabase Auth — see " +
          "the note in init()."
      );
      return false;
    }
    const f = _cfg().firebase;
    try {
      // Guard against a double init in a hot-reloaded tab; the compat SDK
      // throws rather than no-ops on a second call with the same name.
      if (!window.firebase.apps || !window.firebase.apps.length) {
        window.firebase.initializeApp({
          apiKey: f.apiKey,
          authDomain: f.authDomain,
          projectId: f.projectId,
          appId: f.appId,
        });
      }
      _fbAuth = window.firebase.auth();
      return true;
    } catch (e) {
      console.error("Firebase init failed", e);
      return false;
    }
  }

  // ── public surface ─────────────────────────────────────────────────────────

  const BgbAuth = {
    /** "firebase" | "supabase" | null before init(). */
    get backend() {
      return _backend;
    },

    /**
     * Stand up whichever backend is configured.
     *
     * `window.supabaseClient` is created on BOTH paths, and that is not
     * leftovers. Identity Platform replaces Supabase *Auth*; it does not
     * replace Supabase. domain/live-scores.js and domain/session-phase.js
     * subscribe to realtime channels and read and write the live-session
     * tables through that client directly, and each of them is written as
     * `if (!window.supabaseClient) return;` — so a Firebase path that skipped
     * creating it would not error, it would silently no-op. Live scores stop
     * updating and the spectator grid goes blank, with nothing in the console.
     *
     * On the Firebase path the client is given an `accessToken` callback
     * instead of a session of its own. That is what Supabase's third-party
     * auth integration reads, so PostgREST and realtime both receive the
     * Identity Platform JWT and the `auth.uid()` predicates on the live
     * session tables keep resolving to the same UUID they always did. Without
     * it the client would fall back to the anon key and every one of those
     * policies would fail closed — the failure MIGRATION_PLAN.md 3-ALT.2 warns
     * about, arrived at from the other direction.
     *
     * @returns {boolean} false when nothing could be initialised — the caller
     *   routes to /auth and shows "Auth is not configured", same as before.
     */
    init() {
      const cfg = _cfg();
      // The DB client is required either way, so its absence is fatal on both
      // paths rather than a reason to fall back to Supabase Auth.
      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return false;
      if (!window.supabase || !window.supabase.createClient) return false;

      // Configured-but-unavailable does NOT fall through to Supabase Auth.
      // The realistic cause is the gstatic script failing on a cold offline
      // start, and quietly switching providers there would subscribe to a
      // Supabase session that the cutover retired — so the app would decide
      // the user is signed out and route to /auth, which is precisely the
      // bounce init.js's offline guard exists to prevent, arrived at through a
      // different door. Reporting the failure keeps the cause visible instead.
      // sw.js caches the SDK from www.gstatic.com on the first online load so
      // this stays rare rather than routine.
      if (_firebaseConfigured()) {
        if (!_initFirebase()) return false;
        window.supabaseClient = window.supabase.createClient(
          cfg.supabaseUrl,
          cfg.supabaseAnonKey,
          {
            // Unforced: Firebase serves the cached token and refreshes it on
            // its own within five minutes of expiry, so this stays cheap on
            // every call while never handing out a dead one. Returning null
            // rather than throwing when signed out lets anonymous reads fall
            // back to the anon key, which is what a spectator opening a public
            // session link needs.
            accessToken: async () => {
              const user = _fbAuth.currentUser;
              if (!user) return null;
              try {
                return await user.getIdToken();
              } catch (_) {
                return null;
              }
            },
          }
        );
        _backend = "firebase";
        return true;
      }

      window.supabaseClient = window.supabase.createClient(
        cfg.supabaseUrl,
        cfg.supabaseAnonKey
      );
      _backend = "supabase";
      return true;
    },

    /**
     * Subscribe to session changes.
     *
     * The callback signature mirrors Supabase's — `(event, session)` with
     * event === "SIGNED_OUT" on a real sign-out — because init.js's handler
     * distinguishes a genuine sign-out from a transient null, and that logic
     * is worth keeping verbatim rather than re-deriving per backend.
     *
     * Firebase uses onIdTokenChanged, not onAuthStateChange: it fires on
     * sign-in, on sign-out AND on every silent token refresh. The refresh case
     * is the one that matters — without it `window.session.access_token` would
     * go stale an hour into a session and every request would 401 until
     * something forced a refresh.
     */
    onChange(cb) {
      if (_backend === "firebase") {
        _fbAuth.onIdTokenChanged(async (user) => {
          if (!user) {
            cb("SIGNED_OUT", null);
            return;
          }
          try {
            cb("SIGNED_IN", _session(await user.getIdToken(), user));
          } catch (e) {
            // A token fetch that fails offline is a blip, not a sign-out.
            // Reporting null here would bounce a mid-game host to /auth, which
            // is the exact failure init.js's offline guard exists to prevent —
            // so say nothing and let the next refresh settle it.
            console.warn("getIdToken failed; holding the last session", e);
          }
        });
        return;
      }
      window.supabaseClient.auth.onAuthStateChange((event, sess) => cb(event, sess));
    },

    async signInWithPassword(email, password) {
      if (_backend === "firebase") {
        await _fbAuth.signInWithEmailAndPassword(email, password);
        return;
      }
      const { error } = await window.supabaseClient.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
    },

    /**
     * Create an account.
     *
     * @returns {{existing: boolean, session: boolean}}
     *   `existing` true means the address is already registered and the caller
     *   should flip to sign-in. The two backends signal that completely
     *   differently: Firebase throws `auth/email-already-in-use`, while
     *   Supabase RESOLVES with a synthetic user carrying an empty `identities`
     *   array (its anti-enumeration behaviour). Normalising here is the whole
     *   point — auth-view.js should not carry both shapes.
     */
    async signUp(email, password) {
      if (_backend === "firebase") {
        try {
          await _fbAuth.createUserWithEmailAndPassword(email, password);
          return { existing: false, session: true };
        } catch (e) {
          if (e && e.code === "auth/email-already-in-use") {
            return { existing: true, session: false };
          }
          throw e;
        }
      }
      const { data, error } = await window.supabaseClient.auth.signUp({
        email,
        password,
      });
      if (error) throw error;
      const existing = !!(data && data.user && (data.user.identities?.length ?? 0) === 0);
      return { existing, session: !!(data && data.session) };
    },

    /**
     * Google sign-in.
     *
     * Popup first, redirect only as a fallback, and that order is deliberate.
     * With a custom `authDomain` the auth handler lives on a different origin
     * (auth.bgbuddy.app) from the app (bgbuddy.app). The redirect flow needs
     * to read state back from that origin's storage, which Safari's ITP and
     * Firefox's total cookie protection treat as third-party and block — so
     * redirect silently returns the user to a signed-out app. A popup runs
     * auth.bgbuddy.app as a first-party context and hands the credential back
     * over postMessage, which those protections do not touch.
     *
     * Redirect stays as the fallback because a popup blocker, or an embedded
     * webview with no window.open, leaves no other route.
     *
     * WHAT IT RETURNS, AND WHY IT HAS TO RETURN ANYTHING. This used to resolve
     * with nothing on all three of its outcomes, which made a credential in
     * hand indistinguishable from a popup the user shut. The caller could
     * therefore do nothing but re-render the form it was already showing — so
     * the popup closed, the sign-in screen came back, and the person who had
     * just signed in successfully was looking at the login button again while
     * /bootstrap ran. Several of them pressed it.
     *
     *   "signed-in"    the credential is in hand. The auth state listener in
     *                  init.js is already running; the caller's job is to get
     *                  off the form and let the loader cover the rest.
     *   "cancelled"    the user shut the popup, or a second click superseded
     *                  the first. Nothing is coming. Stay where you are.
     *   "redirecting"  this document is navigating away. Whatever the caller
     *                  does next is moot, and it must not be "show an error".
     *
     * @returns {Promise<"signed-in"|"cancelled"|"redirecting">}
     */
    async signInWithGoogle() {
      if (_backend === "firebase") {
        const provider = new window.firebase.auth.GoogleAuthProvider();
        try {
          await _fbAuth.signInWithPopup(provider);
        } catch (e) {
          const code = (e && e.code) || "";
          if (
            code === "auth/popup-blocked" ||
            code === "auth/operation-not-supported-in-this-environment"
          ) {
            await _fbAuth.signInWithRedirect(provider);
            return "redirecting";
          }
          // A user who closes the popup has not failed at anything; swallow it
          // rather than painting an error under the button they just dismissed.
          if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
            return "cancelled";
          }
          throw e;
        }
        return "signed-in";
      }
      const { error } = await window.supabaseClient.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (error) throw error;
      return "redirecting";
    },

    /**
     * Surface an error left behind by the redirect fallback.
     *
     * A successful redirect sign-in already arrives through onChange, so this
     * is only about not swallowing the failure case. Safe to call always.
     */
    async consumeRedirectResult() {
      if (_backend !== "firebase") return null;
      try {
        await _fbAuth.getRedirectResult();
        return null;
      } catch (e) {
        return e;
      }
    },

    async signOut() {
      if (_backend === "firebase") {
        await _fbAuth.signOut();
        return;
      }
      await window.supabaseClient.auth.signOut();
    },

    /**
     * Return a usable session, refreshing the token if it is at or near expiry.
     *
     * Called from the 401 self-heal in domain/api.js and from the wake-up path
     * in init.js. `force` is for the 401 case: the token we just sent was
     * rejected, so the cached one is not worth re-sending.
     *
     * @returns {Promise<object|null>}
     */
    async refresh(force) {
      if (_backend === "firebase") {
        const user = _fbAuth.currentUser;
        if (!user) return null;
        try {
          return _session(await user.getIdToken(!!force), user);
        } catch (_) {
          return null;
        }
      }
      const client = window.supabaseClient;
      if (!client) return null;
      try {
        // getSession() auto-refreshes an expired token from the refresh token.
        const { data } = await client.auth.getSession();
        let sess = data && data.session;
        if (!sess) {
          const r = await client.auth.refreshSession();
          if (r.error) return null;
          sess = r.data && r.data.session;
        }
        return sess || null;
      } catch (_) {
        return null;
      }
    },

    /** The CDN URLs index.html loads, exported so a check can assert the pin. */
    sdkVersion: FB_SDK_VERSION,
  };

  window.BgbAuth = BgbAuth;
})();
