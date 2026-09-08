// @ts-check
// domain/geo-grid.js — which country a coordinate is in.
//
// domain/geo.js answers "where is this device", coarsely, from the timezone,
// and deliberately never asks for a coordinate. This file is the other
// question: a photo's EXIF already carries the exact place it was taken, and
// the photo importer (views/photo-import-view.js) needs to turn that into the
// one country-shaped value a play row can hold.
//
// NOTHING LEAVES THE DEVICE. The whole point of resolving this here rather
// than on the server is that the coordinate never travels: a photo's GPS tag
// says where somebody's house is, and the field it is being turned into is
// deliberately coarse enough that it can't. The lookup is an array index into
// a raster of the world's borders (domain/geo-grid-data.js) — no network, no
// permission prompt, no third party, and the same answer offline.
//
// THE DATA IS LAZY. The raster is 162 KB of text, and it is needed by exactly
// one screen. It rides as <link rel=prefetch> in index.html (so sw.js still
// precaches it — see ui/lazy-script.js for why that matters) and loads on the
// first lookup, which is the moment the user picks their first photo.
//
// THE FORMAT. A 0.1° grid, row-major from (90°N, 180°W), run-length encoded
// as `<run length in base36><ISO 3166-1 alpha-2>` with `..` for "no country".
// It needs no separators and no companion code table because lengths are
// lower case and ISO codes are upper case: a run ends at the first capital.
// Built by tools/build-geo-grid.py, which documents the choices behind it.
//
// PRECISION. 0.1° is about 11 km at the equator and 7 km across at 50°N, so a
// play logged within a few kilometres of a border can land on the wrong side
// of it. That is why the importer always SHOWS the country it resolved and
// puts the picker one tap away, and why a miss is a wrong guess the user can
// see rather than a wrong value they can't.

(function () {
  const DATA_SRC = "domain/geo-grid-data.js";
  // How far to look for land when the cell itself is water. A photo taken on
  // a ferry, a pier or a beach lands in a cell whose centre is sea; three
  // cells is ~20-30 km, which reaches shore from anywhere someone is
  // plausibly playing a board game. Past that "we don't know" is the honest
  // answer — see geo.js on why guessing poisons the column.
  const SEARCH_RADIUS = 3;

  /** @type {Uint8Array|null} cell → 1-based index into `codes`; 0 is water. */
  let cells = null;
  /** @type {string[]} */
  let codes = [];
  let cols = 0;
  let rows = 0;
  let step = 0;
  /** @type {Promise<boolean>|null} */
  let loading = null;

  /**
   * Expand the run-length string into the flat grid, once.
   * @returns {boolean} false when the data file is absent or malformed.
   */
  function _build() {
    if (cells) return true;
    const data = window.BGB_GEO_GRID_DATA;
    if (!data || !data.runs) return false;
    cols = data.cols;
    rows = data.rows;
    step = data.step;

    const grid = new Uint8Array(cols * rows);
    /** @type {Record<string, number>} */
    const seen = {};
    const runs = String(data.runs);
    let at = 0;
    let i = 0;
    while (i < runs.length) {
      // Lower-case base36 digits, then exactly two upper-case letters (or
      // "..", which is water and gets no index).
      let n = 0;
      while (i < runs.length && runs.charCodeAt(i) >= 48 /* 0 */ && runs.charCodeAt(i) <= 122 /* z */
             && runs[i] !== "." && runs[i] === runs[i].toLowerCase()) {
        n = n * 36 + parseInt(runs[i], 36);
        i++;
      }
      const code = runs.slice(i, i + 2);
      i += 2;
      if (code !== "..") {
        let ix = seen[code];
        if (!ix) {
          codes.push(code);
          ix = seen[code] = codes.length;
        }
        grid.fill(ix, at, at + n);
      }
      at += n;
    }
    if (at !== cols * rows) {
      // A truncated or corrupted file. Better to answer "unknown" for every
      // photo than to answer confidently off a half-built map.
      cells = null;
      codes = [];
      return false;
    }
    cells = grid;
    return true;
  }

  /**
   * Fetch and expand the raster. Safe to call repeatedly — the underlying
   * script load is memoised by ui/lazy-script.js, and the expansion is
   * idempotent.
   * @returns {Promise<boolean>} whether lookups can now answer.
   */
  function load() {
    if (cells) return Promise.resolve(true);
    if (loading) return loading;
    loading = window.BgbLazyScript.load(DATA_SRC)
      .then(() => _build())
      .catch(() => false)
      .then((ok) => {
        // A failed load is not memoised: the usual cause is a dead connection,
        // and the next photo the user picks deserves a real second attempt.
        if (!ok) loading = null;
        return ok;
      });
    return loading;
  }

  /** @returns {boolean} whether the raster is in memory already. */
  function isReady() { return !!cells; }

  function _cellAt(row, col) {
    if (row < 0 || row >= rows) return 0;
    // Longitude wraps; latitude does not.
    const c = ((col % cols) + cols) % cols;
    return /** @type {Uint8Array} */ (cells)[row * cols + c];
  }

  /**
   * The country a coordinate is in, or null.
   *
   * Synchronous by design — the importer resolves a whole batch of photos in
   * one pass after `load()` — and answers null rather than throwing when the
   * raster isn't loaded, because "we don't know yet" and "we don't know" are
   * the same thing to every caller.
   *
   * @param {number} lat
   * @param {number} lon
   * @returns {string|null} ISO 3166-1 alpha-2, upper case.
   */
  function countryAt(lat, lon) {
    if (!cells) return null;
    if (!isFinite(lat) || !isFinite(lon)) return null;
    if (lat > 90 || lat < -90 || lon > 180 || lon < -180) return null;
    const row = Math.min(rows - 1, Math.max(0, Math.floor((90 - lat) / step)));
    const col = Math.floor((lon + 180) / step);

    const hit = _cellAt(row, col);
    if (hit) return codes[hit - 1];

    // Water. Walk outwards a ring at a time and take the nearest land, so a
    // photo from a harbour, a pier or a lake shore still resolves.
    for (let radius = 1; radius <= SEARCH_RADIUS; radius++) {
      let best = 0;
      let bestDist = Infinity;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          // The ring, not the filled square — the inside was covered by the
          // smaller radii, and re-reading it would make this O(r⁴).
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
          const v = _cellAt(row + dr, col + dc);
          if (!v) continue;
          const d = dr * dr + dc * dc;
          if (d < bestDist) { bestDist = d; best = v; }
        }
      }
      if (best) return codes[best - 1];
    }
    return null;
  }

  window.BgbGeoGrid = { countryAt, isReady, load };
})();
