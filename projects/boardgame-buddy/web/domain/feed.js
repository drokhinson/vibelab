// domain/feed.js — Feed page assembler. Thin wrapper over /feed cursor pagination.

(function () {
  class Feed {
    static async fetchPage({ cursor } = {}) {
      return window.api.get("/feed", {
        cursor: cursor || undefined,
        limit: 20,
      });
    }
  }

  window.Feed = Feed;
})();
