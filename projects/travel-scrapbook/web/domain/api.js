// @ts-check
// domain/api.js — backend client (makeApi pattern from sauceboss/shared/api.js).
'use strict';

/**
 * @typedef {Object} Scrap
 * @property {string} id
 * @property {string} trip_id
 * @property {string} source_url
 * @property {(string|null)=} source_domain
 * @property {'pending'|'ready'|'failed'} status
 * @property {(string|null)=} error_kind
 * @property {(string|null)=} og_title
 * @property {(string|null)=} og_image_url
 * @property {(string|null)=} place_name
 * @property {(string|null)=} place_city
 * @property {(string|null)=} place_country
 * @property {string} category
 * @property {(number|null)=} lat
 * @property {(number|null)=} lng
 * @property {'high'|'medium'|'low'|'none'} geocode_confidence
 * @property {(string|null)=} geocode_display_name
 * @property {(string|null)=} maps_url
 * @property {(string|null)=} notes
 * @property {boolean} is_favorite
 * @property {(number|null)=} route_position
 */

(function () {
  const PREFIX = '/api/v1/travel_scrapbook';
  const BASE = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || 'http://localhost:8000';

  // Coerce FastAPI's `detail` (string | object | validation list) into one line.
  function formatErrorDetail(detail) {
    if (!detail) return '';
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      return detail.map((d) => d?.msg || JSON.stringify(d)).join('; ');
    }
    if (typeof detail === 'object' && detail.message) return detail.message;
    return JSON.stringify(detail);
  }

  async function call(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const token = getAuthToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let body = opts.body;
    if (body && typeof body === 'object') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const res = await fetch(`${BASE}${PREFIX}${path}`, { ...opts, headers, body });
    if (!res.ok) {
      let detail = '';
      try { detail = formatErrorDetail((await res.json()).detail); } catch (_) {}
      const err = new Error(detail || `Request failed (${res.status})`);
      // @ts-ignore — status carried for callers that branch on it
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    const contentType = res.headers.get('content-type') || '';
    return contentType.includes('text/csv') ? res.blob() : res.json();
  }

  window.api = {
    health: () => call('/health'),
    me: () => call('/me'),
    updateMe: (body) => call('/me', { method: 'PATCH', body }),

    listTrips: () => call('/trips'),
    createTrip: (body) => call('/trips', { method: 'POST', body }),
    getTrip: (tripId) => call(`/trips/${tripId}`),
    updateTrip: (tripId, body) => call(`/trips/${tripId}`, { method: 'PATCH', body }),
    deleteTrip: (tripId) => call(`/trips/${tripId}`, { method: 'DELETE' }),

    createAnchor: (tripId, body) => call(`/trips/${tripId}/anchors`, { method: 'POST', body }),
    updateAnchor: (anchorId, body) => call(`/anchors/${anchorId}`, { method: 'PATCH', body }),
    deleteAnchor: (anchorId) => call(`/anchors/${anchorId}`, { method: 'DELETE' }),

    /** @returns {Promise<Scrap>} */
    createScrap: (body) => call('/scraps', { method: 'POST', body }),
    /** @returns {Promise<Scrap>} */
    getScrap: (scrapId) => call(`/scraps/${scrapId}`),
    /** @returns {Promise<{scraps: Scrap[]}>} */
    listScraps: (tripId) => call(`/trips/${tripId}/scraps`),
    updateScrap: (scrapId, body) => call(`/scraps/${scrapId}`, { method: 'PATCH', body }),
    retryScrap: (scrapId) => call(`/scraps/${scrapId}/retry`, { method: 'POST' }),
    deleteScrap: (scrapId) => call(`/scraps/${scrapId}`, { method: 'DELETE' }),

    optimizeRoute: (tripId, body) => call(`/trips/${tripId}/route/optimize`, { method: 'POST', body: body || {} }),
    exportMapsLinks: (tripId) => call(`/trips/${tripId}/export/maps-links`),
    /** @returns {Promise<Blob>} */
    exportCsv: (tripId) => call(`/trips/${tripId}/export/csv`),

    trackEvent: (name) => {
      fetch(`${BASE}/api/v1/analytics/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: 'travel-scrapbook', event: name }),
      }).catch(() => {});
    },
  };
})();
