// config.js — API base for the landing site (person page travel section).
//
// Unlike per-project web apps (whose config.js is gitignored and env-injected),
// the landing site deploys standalone, so this file is committed. It resolves
// the API base from the hostname: localhost during dev, the shared Railway
// backend in production — so the same committed file works in both places.
(function () {
  var host = window.location.hostname;
  var isLocal = host === "localhost" || host === "127.0.0.1" || host === "";
  window.APP_CONFIG = {
    apiBase: isLocal
      ? "http://localhost:8000"
      : "https://vibelab-production-2119.up.railway.app",
    project: "person",
  };
})();
