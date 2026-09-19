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
//
// AND THE PREFETCH LINK IS WHERE THE URL COMES FROM, not just where the hint
// lives. sw.js serves same-origin subresources cacheFirst with revalidation
// off, so a file at a STABLE url is frozen for as long as the active worker
// lives — and an iOS standalone PWA can hold an old worker indefinitely. The
// deploy therefore stamps ?v=<sha> onto these links, and load() resolves a
// bare path through them so the stamp reaches the <script> with no call site
// knowing it exists. In local dev there is no stamp and the bare path is
// what comes back.

(function () {
  /** @type {Map<string, Promise<void>>} */
  const inflight = new Map();

  /**
   * The url the shell actually names for `src` — its prefetch link's href,
   * which carries the deploy's cache-busting stamp when there is one.
   *
   * Matched exactly, or as the same path followed by a query, rather than by
   * prefix: `startsWith(src)` alone would let one module's path match
   * another's longer one.
   *
   * @param {string} src
   * @returns {string}
   */
  function resolveSrc(src) {
    try {
      const links = document.querySelectorAll('link[rel="prefetch"]');
      for (let i = 0; i < links.length; i++) {
        const href = links[i].getAttribute("href") || "";
        if (href === src || href.indexOf(src + "?") === 0) return href;
      }
    } catch (_) {}
    return src;
  }

  const BgbLazyScript = {
    /**
     * Ensure `src` has been loaded and executed. Resolves once; rejects if the
     * script could not be fetched.
     *
     * A rejected load is NOT memoised: the usual cause is a dead connection,
     * and the user retrying the thing that needed it should get a real second
     * attempt rather than the first failure replayed forever.
     *
     * @param {string} rawSrc Same-origin, relative — resolved against
     *   <base href="/">, and against the shell's prefetch links for the
     *   deploy's version stamp.
     * @returns {Promise<void>}
     */
    load(rawSrc) {
      // Memoised on the RESOLVED url, so the key is stable whether the caller
      // passed the bare path or the stamped one.
      const src = resolveSrc(rawSrc);
      const pending = inflight.get(src);
      if (pending) return pending;

      const p = new Promise((resolve, reject) => {
        // A tag can outlive its map entry (the promise settled, the tag stays);
        // reuse it rather than stack a second copy of a 258 KB file.
        const existing = /** @type {HTMLScriptElement|null} */ (
          document.querySelector('script[data-lazy-src="' + src + '"]')
        );
        const el = existing || document.createElement("script");
        if (!existing) {
          el.src = src;
          el.async = true;
          el.dataset.lazySrc = src;
        }
        // A SCRIPT THAT HAS ALREADY RUN NEVER FIRES `load` AGAIN, so attaching
        // a listener to a finished tag waits forever. The error path below
        // already says this about itself; the success path did not, and a
        // reused tag whose memo had been dropped hung every caller with no
        // error anywhere. Answer from the tag's own state instead.
        if (existing && existing.dataset.lazyDone === "1") { resolve(); return; }
        el.addEventListener("load", () => {
          el.dataset.lazyDone = "1";
          resolve();
        }, { once: true });
        el.addEventListener("error", () => {
          // A finished tag never fires again; drop it so a retry gets a fresh one.
          el.remove();
          reject(new Error("lazy-script: " + src));
        }, { once: true });
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
