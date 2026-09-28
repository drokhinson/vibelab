// ui/stylesheet-heal.js — recover from a stylesheet that never applied.
//
// The deploy renames styles.css to a content-hashed /bgb-<sha>.css and stamps
// assets/bgb-tw.css?v=<sha>, and the _redirects catch-all answers a path Pages
// doesn't have with index.html and a 200. A device that asks for a new sheet
// in the seconds before its edge has it gets the HTML page instead: `nosniff`
// makes the browser refuse it, _headers has already told the HTTP cache to
// keep that answer for a year, and the app boots working but unstyled. sw.js
// never caches such an answer, but the browser's own HTTP cache may.
//
// So once the page has loaded, check that both sheets applied — styles.css by
// its --bgb-sheet token, the precompiled Tailwind sheet (deployed builds only)
// by a variable its preflight sets on every element. If either is missing,
// drop every cached copy of the same-origin sheets and re-fetch them past the
// HTTP cache until each comes back as real CSS, backing off while the edge
// catches up; then reload, which reads the fresh copies. The attempt budget
// lives in sessionStorage and refills after a quiet spell, so a sheet that is
// genuinely missing cannot loop the page, and a long-lived standalone session
// is not stuck unstyled after one early miss.

(function () {
  const KEY = "bgb-sheet-heal";
  // Reloads allowed per window before standing down.
  const MAX_RELOADS = 3;
  const WINDOW_MS = 10 * 60 * 1000;
  // Re-fetch spacing while the sheets still come back as HTML.
  const BACKOFF_MS = [0, 2000, 4000, 8000, 15000, 30000];

  function store(fn) { try { return fn(window.sessionStorage); } catch (_) { return null; } }

  function readState() {
    const raw = store((s) => s.getItem(KEY));
    try {
      const st = raw ? JSON.parse(raw) : null;
      if (st && Date.now() - st.t < WINDOW_MS) return st;
    } catch (_) {}
    return { n: 0, t: Date.now() };
  }

  function rootVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function sameOriginSheets() {
    return Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .map((l) => /** @type {HTMLLinkElement} */ (l).href)
      .filter((h) => { try { return new URL(h).origin === location.origin; } catch (_) { return false; } });
  }

  function applied(hrefs) {
    if (!rootVar("--bgb-sheet")) return false;
    // Tailwind's preflight declares its --tw-* variables on every element. Only
    // a deployed build links the precompiled sheet; local dev runs the CDN JIT.
    const tw = hrefs.some((h) => /\/assets\/bgb-tw\.css/.test(h));
    return !tw || !!rootVar("--tw-ring-offset-width");
  }

  function isCss(res) {
    return !!res && res.ok && (res.headers.get("content-type") || "").includes("text/css");
  }

  // Worker caches first: the re-fetch goes through sw.js, which would
  // otherwise answer it from a bad copy.
  function purge(hrefs) {
    if (!window.caches) return Promise.resolve();
    return caches.keys().then((keys) => Promise.all(keys.map((k) =>
      caches.open(k).then((c) => Promise.all(hrefs.map((h) => c.delete(h)))))));
  }

  function refetch(hrefs) {
    return Promise.all(hrefs.map((h) =>
      fetch(h, { cache: "reload" }).then(isCss).catch(() => false)))
      .then((oks) => oks.every(Boolean));
  }

  function heal(hrefs, attempt) {
    return purge(hrefs).catch(() => {})
      .then(() => refetch(hrefs))
      .then((ok) => {
        if (ok || attempt + 1 >= BACKOFF_MS.length) return;
        return new Promise((r) => setTimeout(r, BACKOFF_MS[attempt + 1]))
          .then(() => heal(hrefs, attempt + 1));
      });
  }

  function check() {
    const hrefs = sameOriginSheets();
    if (applied(hrefs)) { store((s) => s.removeItem(KEY)); return; }
    const st = readState();
    if (st.n >= MAX_RELOADS) return;
    store((s) => s.setItem(KEY, JSON.stringify({ n: st.n + 1, t: st.n ? st.t : Date.now() })));
    heal(hrefs, 0).then(() => location.reload());
  }

  if (document.readyState === "complete") check();
  else window.addEventListener("load", check);
})();
