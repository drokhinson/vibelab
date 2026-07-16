// @ts-check
// domain/api.js — backend client (makeApi pattern from sauceboss/shared/api.js).
'use strict';

/**
 * @typedef {Object} SourceRef
 *   Compact chip: how the user stumbled on a place.
 * @property {string} id
 * @property {string} url
 * @property {(string|null)=} source_domain
 * @property {(string|null)=} og_title
 */

/**
 * @typedef {Object} Source
 *   One capture event (a shared/pasted URL) and its processing state.
 * @property {string} id
 * @property {string} url
 * @property {(string|null)=} source_domain
 * @property {'processing'|'ready'|'failed'} status
 * @property {(string|null)=} error_kind
 * @property {'paste'|'bookmarklet'|'share'|'shortcut'} captured_via
 * @property {(string|null)=} og_title
 * @property {(string|null)=} og_image_url
 * @property {(string|null)=} trip_hint_id
 * @property {string} created_at
 */

/**
 * @typedef {Object} Scrap
 *   A saved place — in a trip or the inbox. Place fields are flattened from
 *   the canonical place row; `sources` lists every URL that mentioned it.
 * @property {string} id
 * @property {(string|null)} trip_id  null = inbox
 * @property {string} place_id
 * @property {'inbox'|'staged'|'approved'} status
 * @property {(string|null)=} place_name
 * @property {(string|null)=} place_city
 * @property {(string|null)=} place_country
 * @property {string} category
 * @property {(number|null)=} lat
 * @property {(number|null)=} lng
 * @property {'high'|'medium'|'low'|'none'} geocode_confidence
 * @property {(string|null)=} geocode_display_name
 * @property {(string|null)=} maps_url
 * @property {(string|null)=} og_image_url
 * @property {SourceRef[]} sources
 * @property {(string|null)=} notes
 * @property {boolean} is_favorite
 * @property {(number|null)=} route_position
 * @property {TripSuggestion[]=} suggestions  inbox responses only
 */

/**
 * @typedef {Object} TripSuggestion
 * @property {string} trip_id
 * @property {string} name
 * @property {string} cover_icon
 * @property {number} distance_km
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

    /** Silent capture of a shared/pasted URL. @returns {Promise<Source>} */
    capture: (body) => call('/capture', { method: 'POST', body }),
    /** @returns {Promise<{processing_sources: Source[], failed_sources: Source[], scraps: Scrap[]}>} */
    getInbox: () => call('/inbox'),
    /** @returns {Promise<{count: number}>} */
    inboxCount: () => call('/inbox/count'),
    /** @returns {Promise<Source>} */
    retrySource: (sourceId) => call(`/sources/${sourceId}/retry`, { method: 'POST' }),
    deleteSource: (sourceId) => call(`/sources/${sourceId}`, { method: 'DELETE' }),

    /** @returns {Promise<{token: string, created_at: string}>} */
    createCaptureToken: () => call('/capture-token', { method: 'POST' }),
    /** @returns {Promise<{active: boolean, created_at?: string, last_used_at?: string}>} */
    getCaptureToken: () => call('/capture-token'),
    revokeCaptureToken: () => call('/capture-token', { method: 'DELETE' }),

    /** @returns {Promise<Scrap>} */
    getScrap: (scrapId) => call(`/scraps/${scrapId}`),
    /** @returns {Promise<{scraps: Scrap[]}>} */
    listScraps: (tripId) => call(`/trips/${tripId}/scraps`),
    updateScrap: (scrapId, body) => call(`/scraps/${scrapId}`, { method: 'PATCH', body }),
    deleteScrap: (scrapId) => call(`/scraps/${scrapId}`, { method: 'DELETE' }),
    /** @returns {Promise<Scrap>} */
    assignScrap: (scrapId, tripId) => call(`/scraps/${scrapId}/assign`, { method: 'POST', body: { trip_id: tripId } }),
    /** @returns {Promise<Scrap>} */
    approveScrap: (scrapId) => call(`/scraps/${scrapId}/approve`, { method: 'POST' }),
    /** @returns {Promise<Scrap>} */
    unassignScrap: (scrapId) => call(`/scraps/${scrapId}/unassign`, { method: 'POST' }),
    /** @returns {Promise<{scraps: Scrap[]}>} */
    approveAllStaged: (tripId) => call(`/trips/${tripId}/approve-all`, { method: 'POST' }),

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
