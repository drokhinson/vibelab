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
  // just hit the API and refresh the badge; the caller reloads its list.
  async retry(sourceId) {
    await window.api.retrySource(sourceId);
    this.refreshInboxCount();
  },

  async dismiss(sourceId) {
    await window.api.deleteSource(sourceId);
    this.refreshInboxCount();
  },

  async assignScrap(scrapId, tripId) {
    await window.api.assignScrap(scrapId, tripId);
    this.refreshInboxCount();
  },

  async removeScrap(scrapId) {
    await window.api.deleteScrap(scrapId);
    this.refreshInboxCount();
  },
};
window.SourceDomain = SourceDomain;
