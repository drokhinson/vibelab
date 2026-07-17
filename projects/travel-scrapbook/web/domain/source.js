// domain/source.js — source operations + the inbox badge count.
'use strict';

// The Wander List badge counts places imported since the user last opened the
// list. We stamp that visit time in localStorage (survives reloads) and pass it
// to the count endpoint as `since`.
const INBOX_VISIT_KEY = 'ts.inbox.lastVisit';

const SourceDomain = {
  // ISO time of the user's last Wander List visit (null before the first one →
  // the badge falls back to the full pending count).
  getInboxLastVisit() {
    try { return localStorage.getItem(INBOX_VISIT_KEY) || null; }
    catch { return null; }
  },

  // Stamp "seen now" (called when leaving the Wander List) and refresh the
  // badge — which then counts only places imported after this moment, i.e. 0.
  markInboxVisited() {
    try { localStorage.setItem(INBOX_VISIT_KEY, new Date().toISOString()); }
    catch { /* private mode / storage full — badge just stays on the total */ }
    this.refreshInboxCount();
  },

  // Fire-and-forget refresh of the header badge. Callers never await it.
  refreshInboxCount() {
    if (!window.store.get('user')) return;
    window.api.inboxCount({ since: this.getInboxLastVisit() })
      .then((res) => window.store.set('inboxCount', res.count))
      .catch(() => {});
  },

  // The inbox view owns its own (filtered, paginated) data — these mutations
  // hit the API, drop the stale cached pages, and refresh the badge; the
  // caller reloads its list.
  _invalidateLists() {
    window.tsCache?.invalidate('inbox');
    window.tsCache?.invalidate('visited');
  },

  async retry(sourceId) {
    await window.api.retrySource(sourceId);
    this._invalidateLists();
    this.refreshInboxCount();
  },

  async dismiss(sourceId) {
    await window.api.deleteSource(sourceId);
    this._invalidateLists();
    this.refreshInboxCount();
  },

  async assignScrap(scrapId, tripId) {
    await window.api.assignScrap(scrapId, tripId);
    this._invalidateLists();
    this.refreshInboxCount();
  },

  async removeScrap(scrapId) {
    await window.api.deleteScrap(scrapId);
    this._invalidateLists();
    this.refreshInboxCount();
  },
};
window.SourceDomain = SourceDomain;
