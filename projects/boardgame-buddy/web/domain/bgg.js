// domain/bgg.js — BoardGameGeek account linking + sync.

(function () {
  class Bgg {
    static status()           { return window.api.get("/bgg/sync/status"); }
    static link(username, password) {
      return window.api.post("/bgg/link", { username, password });
    }
    static unlink()           { return window.api.del("/bgg/link"); }
    static sync()             { return window.api.post("/bgg/sync", {}); }
    static processPending()   { return window.api.post("/bgg/sync/process-pending", {}); }
  }

  window.Bgg = Bgg;
})();
