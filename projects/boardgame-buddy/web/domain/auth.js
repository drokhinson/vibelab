// domain/auth.js — the one place that talks to the identity provider.
//
// GCP Identity Platform (Firebase Auth), and only that. `init()` stands it up
// from the firebase block in window.APP_CONFIG and reports false if it cannot,
// which the app renders as "Auth is not configured".
//
// THE SUPABASE AUTH BRANCH IS GONE. It existed so the frontend and backend
// swaps did not have to be simultaneous and so rollback was flipping four repo
// variables rather than reverting a commit. That stopped being a rollback once
// accounts existed only in Identity Platform — going back would orphan them —
// and `api/jwt_auth.py` dropped the matching verifier in the same commit.
//
// ONE CONSEQUENCE WORTH KNOWING: local dev can no longer sign in without the
// four BGB_FIREBASE_* values in its config.js. They are repo *variables*, not
// secrets — the API key identifies the project and authorizes nothing, since
// access is decided by Authorized Domains — so copying them into a local
// config is fine. Without them the app still boots, still serves a spectator
// on a public session link through the anon key, and shows the auth screen's
// "not configured" banner instead of a sign-in form.
//
// -----------------------------------------------------------------------------
// The session shape is a contract, not an implementation detail.
//
// Callers across the app read exactly two things off `window.session`:
// `access_token` (domain/api.js#_authHeader, domain/outbox.js:233) and
// `user.id` (domain/outbox.js#_currentUid). The shape is Supabase's, because
// ~14 call sites were written against it and a Firebase user object would have
// made every one of them learn a second one. So it is SYNTHESISED:
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

  /**
   * One-shot marker that THIS TAB handed a sign-in to the redirect fallback.
   *
   * It exists because the redirect leaves the document: the fact that we
   * started one cannot be held in memory across it, and consumeRedirectResult
   * below must not ask the SDK about a redirect that never happened. Asking
   * anyway would be a real regression — getRedirectResult() touches the auth
   * domain's storage, which is exactly what Safari's ITP and Firefox's total
   * cookie protection block on a cross-origin authDomain (the reason the popup
   * is preferred at all, see signInWithGoogle). A storage rejection surfaced
   * as an error on the sign-in screen would greet every Safari user who had
   * just signed in successfully by popup.
   *
   * sessionStorage, not localStorage: a redirect is one tab's business and it
   * is finished by the time the tab closes.
   */
  const REDIRECT_PENDING_KEY = "bgb.auth.redirectPending";

  // Storage throws outright in Safari private mode, and nothing here is worth
  // taking sign-in down for. A tab that cannot mark a redirect simply never
  // consumes its result, which is the behaviour before any of this existed.
  function _safeStorage(fn, fallback) {
    try { return fn(); } catch (_) { return fallback; }
  }

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
    /** "firebase", or null when nothing could be initialised. */
    get backend() {
      return _backend;
    },

    /**
     * Stand up whichever backend is configured.
     *
     * `window.supabaseClient` is still created here, and that is not
     * leftovers. Identity Platform replaced Supabase *Auth*; it did not
     * replace Supabase. domain/live-scores.js and domain/session-phase.js
     * subscribe to realtime channels and read and write the live-session
     * tables through that client directly, and each of them is written as
     * `if (!window.supabaseClient) return;` — so dropping it would not error,
     * it would silently no-op. Live scores stop updating and the spectator
     * grid goes blank, with nothing in the console.
     *
     * The client is given an `accessToken` callback instead of a session of
     * its own. That is what Supabase's third-party
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
      // The DB client is required whether or not auth stands up: it is what
      // serves a spectator opening a public session link.
      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return false;
      if (!window.supabase || !window.supabase.createClient) return false;
      // No Firebase config, or a gstatic script that did not load, is now
      // simply "auth is not configured" — there is nothing to fall back to.
      // The realistic cause of the second is a cold offline start; sw.js
      // caches the SDK on the first online load, so it stays rare.
      if (!_firebaseConfigured()) return false;
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
    },

    async signInWithPassword(email, password) {
      await _fbAuth.signInWithEmailAndPassword(email, password);
    },

    /**
     * Create an account.
     *
     * @returns {{existing: boolean, session: boolean}}
     *   `existing` true means the address is already registered and the caller
     *   should flip to sign-in. Identity Platform signals it by throwing
     *   `auth/email-already-in-use`; the shape is normalised here so
     *   auth-view.js reads one answer rather than a provider's error code.
     *
     *   `session: false` is unreachable on this provider and kept in the shape
     *   because auth-view.js branches on it: Supabase could create an account
     *   pending email confirmation, and that branch is the difference between
     *   "check your email" and landing the user on the feed. It is cheap
     *   insurance against email verification being turned on later.
     */
    async signUp(email, password) {
      try {
        await _fbAuth.createUserWithEmailAndPassword(email, password);
        return { existing: false, session: true };
      } catch (e) {
        if (e && e.code === "auth/email-already-in-use") {
          return { existing: true, session: false };
        }
        throw e;
      }
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
      const provider = new window.firebase.auth.GoogleAuthProvider();
      try {
        await _fbAuth.signInWithPopup(provider);
      } catch (e) {
        const code = (e && e.code) || "";
        if (
          code === "auth/popup-blocked" ||
          code === "auth/operation-not-supported-in-this-environment"
        ) {
          _safeStorage(() => sessionStorage.setItem(REDIRECT_PENDING_KEY, "1"));
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
    },

    /**
     * Surface an error left behind by the redirect fallback.
     *
     * A successful redirect sign-in already arrives through onChange, so this
     * is only about not swallowing the failure case — which, before this was
     * wired up, meant a popup-blocked browser sent the user to Google and
     * brought them back to a login screen that said nothing at all.
     *
     * Safe to call always, and cheap: with no redirect marked (see
     * REDIRECT_PENDING_KEY) it answers without touching the SDK. Returns the
     * error for the caller to word, or null — it never throws, because the one
     * screen that calls it is the screen someone is trying to sign in on.
     *
     * One-shot in both directions: the marker is cleared here whatever the
     * outcome, and the SDK hands over a pending result only once.
     *
     * @returns {Promise<any|null>}
     */
    async consumeRedirectResult() {
      if (_backend !== "firebase") return null;   // init() never stood up
      if (!_safeStorage(() => sessionStorage.getItem(REDIRECT_PENDING_KEY))) return null;
      _safeStorage(() => sessionStorage.removeItem(REDIRECT_PENDING_KEY));
      try {
        await _fbAuth.getRedirectResult();
        return null;
      } catch (e) {
        return e;
      }
    },

    async signOut() {
      await _fbAuth.signOut();
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
      const user = _fbAuth.currentUser;
      if (!user) return null;
      try {
        return _session(await user.getIdToken(!!force), user);
      } catch (_) {
        return null;
      }
    },

    /** The CDN URLs index.html loads, exported so a check can assert the pin. */
    sdkVersion: FB_SDK_VERSION,
  };

  window.BgbAuth = BgbAuth;
})();
