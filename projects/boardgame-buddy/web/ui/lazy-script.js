// @ts-check
// ui/lazy-script.js — load a vendored script the first time something needs it.
//
// index.html loads ~120 scripts as plain parser-blocking <script src> tags, and
// every one of them is on the critical path of every boot. Two of them —
// ui/qr-decode.js (258 KB, 57 KB gzipped, ~9% of the whole JS budget) and
// ui/qr-encode.js — exist for the buddy-QR flow, which most sessions never
// open. This is how they stop being boot cost.
//
// WHY THE TAGS ARE STILL IN index.html, AS rel=prefetch
// -----------------------------------------------------
// sw.js derives its precache list by scanning index.html for src= and href=
// (see its PRECACHE LIST header — a hand-kept list would drift the first time
// somebody added a module). Deleting the two <script> tags would therefore have
// dropped the codecs from the precache, and offline QR is precisely what the
// same-origin vendoring in qr-decode.js's header exists to protect.
// <link rel="prefetch" as="script"> keeps them in the SW's sweep while taking
// them off the parser's critical path: Chrome fetches at Lowest priority, and
// Safari ignores the hint entirely, so neither can compete with /bootstrap.
//
// Requests are memoised per src, so N concurrent callers share one <script>.

(function () {
  /** @type {Map<string, Promise<void>>} */
  const inflight = new Map();

  const BgbLazyScript = {
    /**
     * Ensure `src` has been loaded and executed. Resolves once; rejects if the
     * script could not be fetched.
     *
     * A rejected load is NOT memoised: the usual cause is a dead connection,
     * and the user retrying the thing that needed it should get a real second
     * attempt rather than the first failure replayed forever.
     *
     * @param {string} src Same-origin, relative — resolved against <base href="/">.
     * @returns {Promise<void>}
     */
    load(src) {
      const pending = inflight.get(src);
      if (pending) return pending;

      const p = new Promise((resolve, reject) => {
        // A previous call may have inserted the tag and then been dropped from
        // the map by a rejection; reuse the element rather than stacking a
        // second copy of a 258 KB file into the document.
        const existing = /** @type {HTMLScriptElement|null} */ (
          document.querySelector('script[data-lazy-src="' + src + '"]')
        );
        const el = existing || document.createElement("script");
        if (!existing) {
          el.src = src;
          el.async = true;
          el.dataset.lazySrc = src;
        }
        el.addEventListener("load", () => resolve(), { once: true });
        el.addEventListener("error", () => reject(new Error("lazy-script: " + src)), { once: true });
        if (!existing) document.head.appendChild(el);
      }).catch((err) => {
        inflight.delete(src);
        throw err;
      });

      inflight.set(src, p);
      return p;
    },
  };

  window.BgbLazyScript = BgbLazyScript;
})();
