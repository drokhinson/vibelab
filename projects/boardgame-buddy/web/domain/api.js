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
      const res = await fetch(url.toString(), init);
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
      const res = await fetch(url, {
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
