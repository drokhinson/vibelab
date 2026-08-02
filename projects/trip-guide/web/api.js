// api.js — TripGuide backend client. Exposes window.api.
// Modeled on projects/travel-scrapbook/web/domain/api.js: one private call()
// wrapper that injects the admin Bearer token when present, coerces FastAPI
// `detail` errors to one line, times out cold requests, and surfaces err.status.
// @ts-check
(function () {
  const PREFIX = "/api/v1/trip_guide";
  const BASE = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || "http://localhost:8000";

  function formatErrorDetail(detail) {
    if (!detail) return "";
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) return detail.map((d) => (d && d.msg) || JSON.stringify(d)).join("; ");
    if (typeof detail === "object" && detail.message) return detail.message;
    return JSON.stringify(detail);
  }

  async function call(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const key = window.Admin && window.Admin.getKey();
    if (key) headers["Authorization"] = `Bearer ${key}`;
    let body = opts.body;
    if (body && typeof body === "object") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(`${BASE}${PREFIX}${path}`, { ...opts, headers, body, signal: controller.signal });
    } catch (err) {
      if (err.name === "AbortError") throw new Error("The server is taking too long to respond");
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let detail = "";
      try { detail = formatErrorDetail((await res.json()).detail); } catch (_) {}
      const err = new Error(detail || `Request failed (${res.status})`);
      // @ts-ignore — status carried for callers that branch on it
      err.status = res.status;
      // A rejected admin key anywhere should drop the session.
      if ((res.status === 401 || res.status === 403) && window.Admin) window.Admin.onUnauthorized();
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  window.api = {
    health: () => call("/health"),
    adminHealth: () => call("/admin/health"),

    listColorSchemes: () => call("/color-schemes"),

    listTrips: () => call("/trips"),
    getTrip: (tripId) => call(`/trips/${tripId}`),
    createTrip: (body) => call("/trips", { method: "POST", body }),
    updateTrip: (tripId, body) => call(`/trips/${tripId}`, { method: "PUT", body }),
    deleteTrip: (tripId) => call(`/trips/${tripId}`, { method: "DELETE" }),

    createStop: (tripId, body) => call(`/trips/${tripId}/stops`, { method: "POST", body }),
    updateStop: (stopId, body) => call(`/stops/${stopId}`, { method: "PUT", body }),
    deleteStop: (stopId) => call(`/stops/${stopId}`, { method: "DELETE" }),
    reorderStops: (tripId, orderedIds) =>
      call(`/trips/${tripId}/stops/reorder`, { method: "POST", body: { ordered_ids: orderedIds } }),
  };
})();
