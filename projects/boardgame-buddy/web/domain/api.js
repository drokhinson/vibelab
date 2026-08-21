// domain/api.js — Singleton API client. Wraps fetch, attaches Supabase JWT,
// surfaces the FastAPI error envelope as `Error("detail or statusText")`.

(function () {
  const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || "http://localhost:8000";
  const PREFIX = "/api/v1/boardgame_buddy";

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
     * @param {string} url
     * @param {RequestInit} init
     * @returns {Promise<Response>}
     */
    async _fetch(url, init) {
      let res;
      try {
        res = await fetch(url, init);
      } catch (e) {
        if (window.BgbNet) window.BgbNet.noteFailure();
        const err = new Error("You appear to be offline.");
        err.offline = true;
        err.status = 0;
        err.cause = e;
        throw err;
      }
      // The link demonstrably works — a 4xx/5xx still proves reachability.
      if (window.BgbNet) window.BgbNet.noteSuccess();
      return res;
    }

    async _request(method, path, { body, query, headers, raw, _retried } = {}) {
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
      const res = await this._fetch(url.toString(), init);
      if (!res.ok) {
        // A 401 usually means the access token expired (commonly after the
        // device slept). Refresh once and retry before surfacing the error so
        // the caller — and the user — never sees the blip.
        if (res.status === 401 && !_retried && await this._refreshSession()) {
          return this._request(method, path, { body, query, headers, raw, _retried: true });
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
      return ct.includes("application/json") ? res.json() : res.text();
    }

    get(path, query)         { return this._request("GET",    path, { query }); }
    post(path, body)         { return this._request("POST",   path, { body }); }
    put(path, body)          { return this._request("PUT",    path, { body }); }
    patch(path, body)        { return this._request("PATCH",  path, { body }); }
    del(path)                { return this._request("DELETE", path); }

    // For multipart bodies (play photo upload). Caller passes a FormData.
    async upload(path, formData, _retried) {
      const url = this.base + this.prefix + path;
      const res = await this._fetch(url, {
        method: "POST",
        headers: this._authHeader(),
        body: formData,
      });
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
      return res.json();
    }

    // Fire-and-forget analytics ping — never blocks the UI.
    trackEvent(event) {
      fetch(this.base + "/api/v1/analytics/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app: "boardgame-buddy", event }),
      }).catch(() => {});
    }
  }

  window.Api = Api;
  window.api = new Api();
})();
