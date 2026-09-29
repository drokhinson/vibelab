// widgets/score-sum.js — Σ Sum mode on the score pad: one cell built from
// several numbers typed one after another (Isle of Cats lessons, a hand of
// scoring cards), stacked with + and −.
//
// The state is plain data so it can be checked without a document
// (tools/check-score-keypad.mjs). `terms` are the numbers already stacked,
// `entry` the one being typed at the end, and `edit` the index of a stacked
// number reopened by tapping its chip; while one is open, keys go to
// `editVal` / `editOp` and the typed-at-the-end entry waits.
//
// The spotlight dims the screen around the cell being summed, its column's
// header and its row's label: one even-odd SVG path, a full-screen rect with a
// rounded hole per element, so the holes can come from three different tables
// without lifting anything out of its stacking context. It never takes a tap;
// a tap on the dimmed page lands on the page, which blurs the cell and ends
// the sum like any other way out.

(function () {
  const MAX_DIGITS = 6;

  /** A key typed into a number's text: a digit appends, "back" deletes. */
  function typeKey(text, key) {
    const s = String(text == null ? "" : text);
    if (key === "back") return s.slice(0, -1);
    if (!/^[0-9]$/.test(key)) return s;
    if (s === "0") return key;
    if (s === "-0") return "-" + key;
    return s.replace(/^-/, "").length >= MAX_DIGITS ? s : s + key;
  }

  /** @param {number|null} seed the cell's score when Sum was pressed */
  function create(seed) {
    const s = { terms: [], entry: "", op: "+", edit: null, editVal: "", editOp: "+" };
    if (seed != null && seed !== 0) s.terms.push({ op: seed < 0 ? "-" : "+", v: String(Math.abs(seed)) });
    return s;
  }

  /** The stacked terms as they read right now, an open edit included. */
  function view(s) {
    return s.terms.map((t, i) => (i === s.edit ? { op: s.editOp, v: s.editVal } : t));
  }

  function signed(t) {
    if (t.v === "") return 0;
    return (t.op === "-" ? -1 : 1) * Number(t.v);
  }

  function total(s) {
    const all = view(s);
    if (s.entry !== "") all.push({ op: s.op, v: s.entry });
    return all.reduce((a, t) => a + signed(t), 0);
  }

  function isEmpty(s) {
    return s.entry === "" && view(s).every((t) => t.v === "");
  }

  /** What the cell shows while summing: the running total, or blank. */
  function cellText(s) {
    return isEmpty(s) ? "" : String(total(s));
  }

  // Put a reopened number back where it came from, or drop it if cleared.
  function closeEdit(s) {
    if (s.edit === null) return;
    if (s.editVal !== "") s.terms[s.edit] = { op: s.editOp, v: s.editVal };
    else s.terms.splice(s.edit, 1);
    s.edit = null;
  }

  function open(s, i) {
    const target = s.terms[i];
    closeEdit(s);
    const j = s.terms.indexOf(target);
    if (j < 0) return;
    s.edit = j;
    s.editVal = target.v;
    s.editOp = target.op;
  }

  function remove(s, i) {
    if (s.edit === i) s.edit = null;
    else if (s.edit !== null && s.edit > i) s.edit--;
    s.terms.splice(i, 1);
  }

  /** A tap on chip i: open it, or close it again if it is the open one. */
  function tap(s, i) {
    if (i === s.edit) closeEdit(s);
    else open(s, i);
  }

  /**
   * One pad key: a digit, "back", "+" or "−" ("-"). With a chip open, + / −
   * give it that sign and close it, and "back" on an emptied chip removes it.
   * At the end of the tape, + / − stack the entry and pick the next sign, and
   * "back" with nothing typed reopens the last stacked number.
   */
  function key(s, k) {
    const op = k === "+" || k === "-";
    if (s.edit !== null) {
      if (op) { s.editOp = k; closeEdit(s); }
      else if (k === "back" && s.editVal === "") remove(s, s.edit);
      else s.editVal = typeKey(s.editVal, k);
      return;
    }
    if (op) {
      if (s.entry !== "") {
        s.terms.push({ op: s.op, v: s.entry, fresh: true });
        s.entry = "";
      }
      s.op = k;
    } else if (k === "back" && s.entry === "" && s.terms.length) {
      open(s, s.terms.length - 1);
    } else {
      s.entry = typeKey(s.entry, k);
    }
  }

  // ── Spotlight ──────────────────────────────────────────────────────────
  const SVG = "http://www.w3.org/2000/svg";
  /** @type {SVGSVGElement|null} */
  let spot = null;
  /** @type {HTMLElement|null} */
  let lit = null;
  let frame = 0;

  // The cell, its column's header and its row's label. The header is in a
  // separate table (.rg__head) laid out on the same colgroup, so the header
  // cell sits at the same index as the cell's own <td>.
  function targets(cell) {
    const td = cell.closest("td");
    const tr = cell.closest("tr");
    const grid = cell.closest(".rg");
    const headRow = grid && grid.querySelector(".rg__head thead tr");
    const head = td && headRow ? headRow.cells[td.cellIndex] : null;
    return [cell, head, tr ? tr.cells[0] : null].filter(Boolean);
  }

  // A header scrolled half out of its strip shows only the half that is in it.
  function visibleRect(node) {
    const r = node.getBoundingClientRect();
    const clip = node.closest(".rg__head, .rg__body");
    if (!clip) return r;
    const c = clip.getBoundingClientRect();
    return { left: Math.max(r.left, c.left), right: Math.min(r.right, c.right), top: Math.max(r.top, c.top), bottom: Math.min(r.bottom, c.bottom) };
  }

  function draw() {
    frame = 0;
    if (!spot || !lit) return;
    const w = window.innerWidth, h = window.innerHeight;
    let d = `M0 0H${w}V${h}H0Z`;
    for (const node of targets(lit)) {
      const r = visibleRect(node);
      if (r.right <= r.left || r.bottom <= r.top) continue;
      const x = r.left - 3, y = r.top - 3, x2 = r.right + 3, y2 = r.bottom + 3;
      const k = Math.min(8, (x2 - x) / 2, (y2 - y) / 2);
      d += `M${x + k} ${y}H${x2 - k}Q${x2} ${y} ${x2} ${y + k}V${y2 - k}Q${x2} ${y2} ${x2 - k} ${y2}`
        + `H${x + k}Q${x} ${y2} ${x} ${y2 - k}V${y + k}Q${x} ${y} ${x + k} ${y}Z`;
    }
    /** @type {SVGPathElement} */ (spot.firstChild).setAttribute("d", d);
  }

  function schedule() {
    if (lit && !frame) frame = requestAnimationFrame(draw);
  }

  function spotlight(cell) {
    if (!spot) {
      spot = /** @type {SVGSVGElement} */ (document.createElementNS(SVG, "svg"));
      spot.setAttribute("class", "score-sum-spot");
      spot.setAttribute("aria-hidden", "true");
      spot.appendChild(document.createElementNS(SVG, "path"));
      document.body.appendChild(spot);
      // Capture, because the grid scrolls inside .rg__body, not the page.
      window.addEventListener("scroll", schedule, { capture: true, passive: true });
      window.addEventListener("resize", schedule);
    }
    lit = cell;
    spot.removeAttribute("hidden");
    draw();
  }

  function unspotlight() {
    lit = null;
    if (spot) spot.setAttribute("hidden", "");
  }

  window.ScoreSum = {
    typeKey, create, total, cellText, isEmpty, view, key, tap, remove,
    spotlight, unspotlight, redraw: schedule,
  };
})();
