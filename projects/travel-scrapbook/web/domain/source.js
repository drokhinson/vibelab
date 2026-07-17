// domain/source.js — source operations + the inbox badge count.
'use strict';

const SourceDomain = {
  // Fire-and-forget refresh of the header badge. Callers never await it.
  refreshInboxCount() {
    if (!window.store.get('user')) return;
    window.api.inboxCount()
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
