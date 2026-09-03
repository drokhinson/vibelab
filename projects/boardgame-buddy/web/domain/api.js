// domain/api.js — Singleton API client. Wraps fetch, attaches Supabase JWT,
// surfaces the FastAPI error envelope as `Error("detail or statusText")`.

(function () {
  const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || "http://localhost:8000";
  const PREFIX = "/api/v1/boardgame_buddy";

  // Every request carries a deadline.
  //
  // A network error rejects fetch() promptly and the app recovers; a STALLED
  // request never settles at all, and no browser imposes a timeout worth
  // waiting for. That is not theoretical here: reported from the field, an
  // iPhone's first launch of the freshly-installed PWA "sat on a loading
  // screen forever, until I clicked one of the menu buttons below". Every
  // first-paint call is awaited — the boot's /bootstrap, the feed's first
  // page — so one stalled request is the whole app, with no error, no retry
  // and (on the splash) not even a nav bar to escape with. The tap that
  // "fixed" it just started a different request on a different connection.
  //
  // 15s is well past a healthy p99 (including a cold Railway dyno) and well
  // short of "forever". Uploads get their own budget — a play photo over
  // cellular legitimately takes longer than any JSON call ever should, and so
  // does the odd endpoint that does third-party work inside the handler
  // (POST /bgg/sync walks a whole BoardGameGeek collection before it answers).
  // Those pass an explicit `timeoutMs`; they still get a deadline, just one
  // sized to the work rather than to a JSON round trip.
  const REQUEST_TIMEOUT_MS = 15000;
  const UPLOAD_TIMEOUT_MS = 60000;

  class Api {
    constructor() {
      this.base = API_BASE;
      this.prefix = PREFIX;
    }

    // Override only when the auth layer wants to test a token that isn't yet
    // on `window.session`. Normal callers leave this alone.
    _authHeader() {
      const tok = window.session && window.session.access_token;
      return tok ? { Authorization: "Bearer " + tok } : {};
    }

    // Refresh the Supabase access token and re-publish it on window.session.
    // Returns true when a usable session is in hand afterwards. Used to recover
    // transparently from a 401 (e.g. a token that expired while the phone was
    // asleep) so a stale token never cascades into a forced sign-out.
    async _refreshSession() {
      const client = window.supabaseClient;
      if (!client) return false;
      try {
        // getSession() auto-refreshes an expired token from the refresh token.
        let { data } = await client.auth.getSession();
        let sess = data && data.session;
        if (!sess) {
          const r = await client.auth.refreshSession();
          if (r.error) return false;
          sess = r.data && r.data.session;
        }
        if (sess) {
          window.session = sess;
          if (window.store) window.store.set("session", sess);
          return true;
        }
      } catch (_) {}
      return false;
    }

    /**
     * fetch() + connectivity bookkeeping.
     *
     * A dead network makes fetch REJECT with a bare `TypeError: Failed to
     * fetch` — it never reaches the `!res.ok` branch below, so it used to
     * arrive at callers with no `.status` and no way to tell it apart from
     * anything else that threw. Offline mode needs that distinction on every
     * call site, so it's normalized here: `err.offline = true`, `err.status = 0`.
     *
     * Caveat: "Failed to fetch" is overloaded in this codebase. An unhandled
     * Supabase APIError used to produce a 500 that bypassed CORSMiddleware,
     * which the browser also reports this way — see the long comment on
     * @app.exception_handler(APIError) in shared-backend/main.py. That handler
     * now returns a CORS-bearing 500, so the overlap is rare, but `err.offline`
     * is a heuristic and BgbNet treats it as one (two strikes, not one).
     *
     * A deadline abort (see _send) lands in the same branch and is normalized
     * the same way, plus `err.timeout = true`. A link on which requests never
     * complete IS offline as far as this app is concerned — the outbox keys
     * every play on a client_key, so re-queueing a write that may have landed
     * is de-duplicated server-side rather than double-written.
     *
     * A caller-supplied `signal` (the game picker aborts a search the moment
     * the next keystroke supersedes it) is the one abort that means nothing
     * about the link: it never calls noteFailure() and never sets `offline`,
     * or typing would walk the app into offline mode one keystroke at a time.
     * It rejects with `err.aborted = true`, which callers ignore.
     *
     * @param {string} url
     * @param {RequestInit} init
     * @param {AbortSignal} [callerSignal]
     * @returns {Promise<Response>}
     */
    async _fetch(url, init, callerSignal) {
      let res;
      try {
        res = await fetch(url, init);
      } catch (e) {
        if (callerSignal && callerSignal.aborted) {
          const err = new Error("Request superseded.");
          err.aborted = true;
          err.status = 0;
          err.cause = e;
          throw err;
        }
        if (window.BgbNet) window.BgbNet.noteFailure();
        const timedOut = !!e && (e.name === "AbortError" || e.name === "TimeoutError");
        const err = new Error(timedOut
          ? "The server took too long to respond."
          : "You appear to be offline.");
        err.offline = true;
        err.timeout = timedOut;
        err.status = 0;
        err.cause = e;
        throw err;
      }
      // The link demonstrably works — a 4xx/5xx still proves reachability.
      if (window.BgbNet) window.BgbNet.noteSuccess();
      return res;
    }

    /**
     * _fetch() under a deadline that stays armed until the caller releases it.
     *
     * Headers arriving is not the same as the request being done: the body
     * read is a second chance to stall, so the abort timer covers both and the
     * caller clears it once it has finished with the response.
     *
     * @param {string} url
     * @param {RequestInit} init
     * @param {number} timeoutMs
     * @param {AbortSignal} [callerSignal] aborts the request early
     * @returns {Promise<[Response, () => void]>} the response and its release fn
     */
    _send(url, init, timeoutMs, callerSignal) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let onCallerAbort = null;
      if (callerSignal) {
        if (callerSignal.aborted) ctl.abort();
        else {
          onCallerAbort = () => ctl.abort();
          callerSignal.addEventListener("abort", onCallerAbort);
        }
      }
      const release = () => {
        clearTimeout(timer);
        if (onCallerAbort) callerSignal.removeEventListener("abort", onCallerAbort);
      };
      return this._fetch(url, { ...init, signal: ctl.signal }, callerSignal).then(
        (res) => [res, release],
        (e) => { release(); throw e; },
      );
    }

    async _request(method, path, opts = {}) {
      const { body, query, headers, raw, signal, timeoutMs, _retried, _stalled } = opts;
      const url = new URL(this.base + this.prefix + path);
      if (query) {
        for (const [k, v] of Object.entries(query)) {
          if (v === undefined || v === null || v === "") continue;
          url.searchParams.set(k, v);
        }
      }
      const init = {
        method,
        headers: { ...this._authHeader(), ...(headers || {}) },
      };
      if (body !== undefined && !raw) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      } else if (raw) {
        init.body = body;
      }

      let res, release;
      try {
        [res, release] = await this._send(
          url.toString(), init, timeoutMs || REQUEST_TIMEOUT_MS, signal,
        );
      } catch (e) {
        // A stalled socket does not heal itself — the same request on a new
        // connection is what recovers, which is exactly what the user was
        // doing by hand when they tapped another tab. Reads are safe to repeat,
        // so retry a GET once before surfacing anything; writes are the
        // outbox's problem, not this layer's.
        if (e && e.timeout && method === "GET" && !_stalled) {
          return this._request(method, path, { ...opts, _stalled: true });
        }
        throw e;
      }

      try {
        if (!res.ok) {
          // A 401 usually means the access token expired (commonly after the
          // device slept). Refresh once and retry before surfacing the error so
          // the caller — and the user — never sees the blip.
          if (res.status === 401 && !_retried && await this._refreshSession()) {
            return this._request(method, path, { ...opts, _retried: true });
          }
          let detail = res.statusText;
          try {
            const j = await res.json();
            detail = j.detail || j.message || detail;
          } catch (_) {}
          const err = new Error(detail);
          err.status = res.status;
          throw err;
        }
        if (res.status === 204) return null;
        const ct = res.headers.get("content-type") || "";
        // Awaited inside the try so the body read is still covered by the
        // deadline — release() below must not fire until the bytes are in.
        return ct.includes("application/json") ? await res.json() : await res.text();
      } catch (e) {
        // Headers arriving is not the request being done, so a caller abort
        // can land during the body read — after _fetch has already returned,
        // and as a raw AbortError. Tag it here too so `err.aborted` is the one
        // thing a caller has to check, whenever the abort happened to fire.
        if (signal && signal.aborted && !(e && e.aborted)) {
          const err = new Error("Request superseded.");
          err.aborted = true;
          err.status = 0;
          err.cause = e;
          throw err;
        }
        throw e;
      } finally {
        release();
      }
    }

    // `opts` carries per-call extras: `{ signal }`, used by the game picker to
    // drop a search the next keystroke has superseded, and `{ timeoutMs }` for
    // the handful of endpoints whose honest budget is not a JSON round trip.
    get(path, query, opts)   { return this._request("GET",    path, { ...(opts || {}), query }); }
    post(path, body, opts)   { return this._request("POST",   path, { ...(opts || {}), body }); }
    put(path, body)          { return this._request("PUT",    path, { body }); }
    patch(path, body)        { return this._request("PATCH",  path, { body }); }
    del(path)                { return this._request("DELETE", path); }

    // For multipart bodies (play photo upload). Caller passes a FormData.
    async upload(path, formData, _retried) {
      const url = this.base + this.prefix + path;
      const [res, release] = await this._send(url, {
        method: "POST",
        headers: this._authHeader(),
        body: formData,
      }, UPLOAD_TIMEOUT_MS);
      try {
        if (!res.ok) {
          if (res.status === 401 && !_retried && await this._refreshSession()) {
            return this.upload(path, formData, true);
          }
          let detail = res.statusText;
          try { detail = (await res.json()).detail || detail; } catch (_) {}
          const err = new Error(detail);
          err.status = res.status;
          throw err;
        }
        return await res.json();
      } finally {
        release();
      }
    }

    // Fire-and-forget analytics ping — never blocks the UI. Deliberately not
    // routed through _fetch: a stalled analytics ping must not count toward
    // offline detection, but it still gets a deadline so it can't sit on a
    // connection the app needs for real work.
    /**
     * @param {string} event
     * @param {Object} [metadata] Arbitrary JSON, stored on the row. The
     *   backend's TrackBody has always accepted this; nothing sent it, so
     *   every event was reduced to its name. init.js#reportBootTiming is the
     *   first caller — it is how a "the app took a minute to open" report
     *   becomes a number somebody can read off the admin dashboard.
     */
    trackEvent(event, metadata) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
      const body = { app: "boardgame-buddy", event };
      if (metadata) body.metadata = metadata;
      fetch(this.base + "/api/v1/analytics/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      }).catch(() => {}).finally(() => clearTimeout(timer));
    }
  }

  window.Api = Api;
  window.api = new Api();
})();
