// domain/search.js — wrapper around /search (UnifiedSearchResponse).
// Returns { results, bgg_results, bgg_searched } where results is the
// collection-first → DB ranked list and bgg_results is only populated when
// include_bgg=true.

(function () {
  class Search {
    static run(q, { includeBgg = false, limit = 20 } = {}) {
      return window.api.get("/search", {
        q,
        limit,
        include_bgg: includeBgg ? "true" : "false",
      });
    }
  }

  window.Search = Search;
})();
