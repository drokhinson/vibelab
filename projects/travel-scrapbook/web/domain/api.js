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
 * @property {(string|null)=} trip_id  current trip context (trip surfaces); null on the Wander List
 * @property {(string|null)=} scrap_trip_id  membership id (per-trip vibe/schedule key)
 * @property {string[]=} trip_ids  every trip this place is in (Wander List picker)
 * @property {string} place_id
 * @property {('staged'|'approved'|null)=} status  membership status on trip surfaces
 * @property {(string|null)=} place_name
 * @property {(string|null)=} place_city
 * @property {(string|null)=} place_region
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
 * @property {('booked'|'must_do'|'interested'|'could_skip'|null)=} rating  owner's own priority
 * @property {(string|null)=} visited_at  null = on the wishlist; set = visited
 * @property {(number|null)=} route_position
 * @property {(string|null)=} plan_date  YYYY-MM-DD timeline slot (trip scraps only)
 * @property {(string|null)=} plan_time  HH:MM:SS, optional time within the day
 * @property {(string|null)=} added_by_user_id     who saved it (shared trips)
 * @property {(string|null)=} added_by_display_name
 * @property {ScrapVibe[]=} vibes                  per-traveler takes (trip surfaces)
 * @property {(ScrapConsensus|null)=} consensus    group roll-up
 * @property {TripSuggestion[]=} suggestions  inbox responses only
 */

/**
 * @typedef {Object} ScrapVibe  One traveler's vibe on a place.
 * @property {string} user_id
 * @property {string} display_name
 * @property {'booked'|'must_do'|'interested'|'could_skip'} level
 */

/**
 * @typedef {Object} ScrapConsensus  Group roll-up of a scrap's vibes.
 * @property {Object<string, number>} counts  level → count
 * @property {number} total
 * @property {string} headline
 */

/**
 * @typedef {Object} TripMember
 * @property {string} user_id
 * @property {string} username
 * @property {string} display_name
 * @property {'owner'|'collaborator'|'viewer'} role
 * @property {'pending'|'accepted'|'declined'} status
 */

/**
 * @typedef {Object} Invitation
 * @property {string} trip_id
 * @property {string} trip_name
 * @property {string} cover_icon
 * @property {'collaborator'|'viewer'} role
 * @property {(string|null)=} owner_display_name
 * @property {(string|null)=} invited_by_display_name
 * @property {string} created_at
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

  // ?key=value string from the non-empty entries of a params object.
  function qs(params = {}) {
    const s = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== '')
    ).toString();
    return s ? `?${s}` : '';
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
    // A cold Railway backend with no cap here can hang a view's loading state
    // (or the boot splash's own /me call) indefinitely with no visible error.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(`${BASE}${PREFIX}${path}`, { ...opts, headers, body, signal: controller.signal });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('The server is taking too long to respond');
      throw err;
    } finally {
      clearTimeout(timer);
    }
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
    /** Never auto-launch the tour again (idempotent). */
    markTutorialSeen: () => call('/me/tutorial-seen', { method: 'POST' }),

    listTrips: () => call('/trips'),
    createTrip: (body) => call('/trips', { method: 'POST', body }),
    /** The whole trip screen in one round trip: trip + anchors + scraps +
     *  staged_scraps + `members` (TripMember[]) + `candidates` (Scrap[]). */
    getTrip: (tripId) => call(`/trips/${tripId}`),
    updateTrip: (tripId, body) => call(`/trips/${tripId}`, { method: 'PATCH', body }),
    deleteTrip: (tripId) => call(`/trips/${tripId}`, { method: 'DELETE' }),

    createAnchor: (tripId, body) => call(`/trips/${tripId}/anchors`, { method: 'POST', body }),
    updateAnchor: (anchorId, body) => call(`/anchors/${anchorId}`, { method: 'PATCH', body }),
    deleteAnchor: (anchorId) => call(`/anchors/${anchorId}`, { method: 'DELETE' }),

    /** Silent capture of a shared/pasted URL. @returns {Promise<Source>} */
    capture: (body) => call('/capture', { method: 'POST', body }),
    /** One filtered page + geo facets + the global badge count. @returns {Promise<{processing_sources: Source[], failed_sources: Source[], scraps: Scrap[], total: number, facets: object, inbox_count: number}>} */
    getInbox: (params = {}) => call(`/inbox${qs(params)}`),
    /** @returns {Promise<{count: number}>} */
    inboxCount: () => call('/inbox/count'),
    /** A capture's live status + the scraps it produced. @returns {Promise<{status: string, error_kind: (string|null), scraps: Scrap[]}>} */
    sourceScraps: (sourceId) => call(`/sources/${sourceId}/scraps`),
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
    /** Wishlist places matching a trip's scope. @returns {Promise<{scraps: Scrap[]}>} */
    tripCandidates: (tripId) => call(`/trips/${tripId}/candidates`),
    /** All wishlist places + a fits_scope flag, for the trip's add picker. @returns {Promise<{scraps: Array<Scrap & {fits_scope: boolean}>}>} */
    tripWishlist: (tripId) => call(`/trips/${tripId}/wishlist`),
    /** Bulk-add wishlist scraps to a trip. @returns {Promise<{scraps: Scrap[]}>} */
    assignScraps: (tripId, scrapIds) => call(`/trips/${tripId}/assign-scraps`, { method: 'POST', body: { scrap_ids: scrapIds } }),
    /** One filtered page of visited places + geo facets. @returns {Promise<{scraps: Scrap[], total: number, facets: object}>} */
    listVisited: (params = {}) => call(`/visited${qs(params)}`),
    updateScrap: (scrapId, body) => call(`/scraps/${scrapId}`, { method: 'PATCH', body }),
    deleteScrap: (scrapId) => call(`/scraps/${scrapId}`, { method: 'DELETE' }),
    /** Add a place to one trip (additive membership). @returns {Promise<Scrap>} */
    assignScrap: (scrapId, tripId) => call(`/scraps/${scrapId}/assign`, { method: 'POST', body: { trip_id: tripId } }),
    /** Set the exact set of trips a place is in (multi-select). @returns {Promise<Scrap>} */
    setScrapTrips: (scrapId, tripIds) => call(`/scraps/${scrapId}/trips`, { method: 'PUT', body: { trip_ids: tripIds } }),
    /** Approve a staged membership on a trip. @returns {Promise<Scrap>} */
    approveScrap: (scrapId, tripId) => call(`/scraps/${scrapId}/trips/${tripId}/approve`, { method: 'POST' }),
    /** Remove a place from one trip. @returns {Promise<{message: string}>} */
    unassignScrap: (scrapId, tripId) => call(`/scraps/${scrapId}/trips/${tripId}`, { method: 'DELETE' }),
    /** Set/clear a plan's timeline slot on one trip. @returns {Promise<Scrap>} */
    scheduleScrap: (scrapId, tripId, body) => call(`/scraps/${scrapId}/trips/${tripId}/schedule`, { method: 'PATCH', body }),
    /** @returns {Promise<{scraps: Scrap[]}>} */
    approveAllStaged: (tripId) => call(`/trips/${tripId}/approve-all`, { method: 'POST' }),

    /** Day-by-day timeline: days with markers + scheduled plans, and unscheduled plans with slot suggestions. */
    tripTimeline: (tripId) => call(`/trips/${tripId}/timeline`),

    optimizeRoute: (tripId, body) => call(`/trips/${tripId}/route/optimize`, { method: 'POST', body: body || {} }),
    exportMapsLinks: (tripId) => call(`/trips/${tripId}/export/maps-links`),
    /** @returns {Promise<Blob>} */
    exportCsv: (tripId) => call(`/trips/${tripId}/export/csv`),

    // ── Trip sharing ──────────────────────────────────────────────────────
    /** @returns {Promise<{members: TripMember[]}>} */
    listMembers: (tripId) => call(`/trips/${tripId}/members`),
    /** @returns {Promise<TripMember>} */
    inviteMember: (tripId, body) => call(`/trips/${tripId}/members`, { method: 'POST', body }),
    /** @returns {Promise<TripMember>} */
    updateMember: (tripId, userId, body) => call(`/trips/${tripId}/members/${userId}`, { method: 'PATCH', body }),
    removeMember: (tripId, userId) => call(`/trips/${tripId}/members/${userId}`, { method: 'DELETE' }),
    /** @returns {Promise<{invitations: Invitation[]}>} */
    listInvitations: () => call('/invitations'),
    respondInvitation: (tripId, action) => call(`/trips/${tripId}/invitation/respond`, { method: 'POST', body: { action } }),

    // ── Community pool ────────────────────────────────────────────────────
    /** One filtered page of aggregated places (facts only, no user data). @returns {Promise<{places: object[], total: number, facets: object}>} */
    communityPlaces: (params = {}) => call(`/community/places${qs(params)}`),
    /** Save a community place to a trip (or the Wander List). @returns {Promise<Scrap>} */
    saveCommunityPlace: (placeId, tripId) =>
      call(`/community/places/${placeId}/save`, { method: 'POST', body: { trip_id: tripId || null } }),

    // ── Rating (owner's own priority) ─────────────────────────────────────
    /** @returns {Promise<Scrap>} */
    setRating: (scrapId, level) => call(`/scraps/${scrapId}/rating`, { method: 'PUT', body: { level } }),
    /** @returns {Promise<Scrap>} */
    clearRating: (scrapId) => call(`/scraps/${scrapId}/rating`, { method: 'DELETE' }),

    // ── Vibes (per traveler, per trip) ────────────────────────────────────
    /** @returns {Promise<Scrap>} */
    setVibe: (scrapId, tripId, level) => call(`/scraps/${scrapId}/trips/${tripId}/vibe`, { method: 'PUT', body: { level } }),
    /** @returns {Promise<Scrap>} */
    clearVibe: (scrapId, tripId) => call(`/scraps/${scrapId}/trips/${tripId}/vibe`, { method: 'DELETE' }),

    trackEvent: (name) => {
      fetch(`${BASE}/api/v1/analytics/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: 'travel-scrapbook', event: name }),
      }).catch(() => {});
    },
  };
})();
