// domain/browse.js — shared page loaders for the browse screens (Wander
// List / Visited / Community). Each fetches one filtered page, normalizes it
// to the exact state shape its view paints, and write-through-caches page 0
// under the view's geo key — so the views and the boot-time preloader
// (init.js) produce identical cache entries.
'use strict';

(function () {
  const DEFAULT_GEO = { region: null, country: null, city: null };
  const key = (geo) => JSON.stringify(geo);

  const BrowsePages = {
    DEFAULT_GEO,

    /** One Wander List page. The nav badge counts only places imported since
     *  the last visit (not the bundle's raw total), so refresh it via the
     *  since-aware count endpoint rather than piggybacking res.inbox_count.
     *  Checkpoint-category places (hotels/transport) arrive as their own
     *  `checkpoints` section, split server-side. */
    async loadInbox({ geo = DEFAULT_GEO, limit = 24, offset = 0 } = {}) {
      const res = await window.api.getInbox({ ...geo, limit, offset });
      const page = {
        processing: res.processing_sources || [],
        failed: res.failed_sources || [],
        items: res.scraps || [],
        checkpoints: res.checkpoint_scraps || [],
        total: res.total || 0,
        checkpointTotal: res.checkpoint_total || 0,
        facets: res.facets || {},
      };
      if (offset === 0) window.tsCache?.set('inbox', key(geo), page);
      window.SourceDomain?.refreshInboxCount();
      return page;
    },

    async loadVisited({ geo = DEFAULT_GEO, limit = 24, offset = 0 } = {}) {
      const res = await window.api.listVisited({ ...geo, limit, offset });
      const page = {
        items: res.scraps || [],
        checkpoints: res.visited_checkpoints || [],
        total: res.total || 0,
        checkpointTotal: res.checkpoint_total || 0,
        facets: res.facets || {},
      };
      if (offset === 0) window.tsCache?.set('visited', key(geo), page);
      return page;
    },

    /** `checkpoints` flips to the community Stays & transport tab; the cache
     *  key carries it so the two tabs don't overwrite each other. */
    async loadCommunity({ geo = DEFAULT_GEO, limit = 24, offset = 0, checkpoints = false } = {}) {
      const res = await window.api.communityPlaces({ ...geo, limit, offset, checkpoints });
      const page = { items: res.places || [], total: res.total || 0, facets: res.facets || {} };
      if (offset === 0) {
        window.tsCache?.set('community', key({ ...geo, checkpoints }), page);
      }
      return page;
    },
  };
  window.BrowsePages = BrowsePages;
})();
