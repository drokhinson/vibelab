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

  async loadInbox() {
    const inbox = await window.api.getInbox();
    window.store.set('inbox', inbox);
    window.store.set(
      'inboxCount',
      (inbox.scraps || []).length +
        (inbox.processing_sources || []).length +
        (inbox.failed_sources || []).length
    );
    return inbox;
  },

  async retry(sourceId) {
    await window.api.retrySource(sourceId);
    return this.loadInbox();
  },

  async dismiss(sourceId) {
    await window.api.deleteSource(sourceId);
    return this.loadInbox();
  },

  async assignScrap(scrapId, tripId) {
    await window.api.assignScrap(scrapId, tripId);
    return this.loadInbox();
  },

  async removeScrap(scrapId) {
    await window.api.deleteScrap(scrapId);
    return this.loadInbox();
  },
};
window.SourceDomain = SourceDomain;
