// domain/bgg.js — BoardGameGeek account linking + sync.

(function () {
  // Linking or unlinking flips the Geek Certified badge, so both drop the
  // cached achievements payload. Chained on the promise rather than fired
  // beside the call: a failed link must not invalidate anything.
  function _dropAchievements(result) {
    if (window.Achievements && window.Achievements.invalidate) window.Achievements.invalidate();
    return result;
  }

  class Bgg {
    static status()           { return window.api.get("/bgg/sync/status"); }
    static link(username, password) {
      return window.api.post("/bgg/link", { username, password }).then(_dropAchievements);
    }
    static unlink()           { return window.api.del("/bgg/link").then(_dropAchievements); }
    // A sync writes plays, which moves half the catalog.
    static sync()             { return window.api.post("/bgg/sync", {}).then(_dropAchievements); }
  }

  window.Bgg = Bgg;
})();
