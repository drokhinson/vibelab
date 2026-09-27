// widgets/score-keypad.js — the bar that rides on top of the number pad while
// a scoring-grid cell has focus: + and − to add up a cell, (−) to flip its
// sign, and Next to move on.
//
// The cell asks for `inputmode="numeric"`, the iOS 10-key pad — big keys,
// digits only, no sign and no return key. Everything that pad is missing lives
// here instead. A cell can therefore hold a sum while it is being typed
// ("12+7-3"), and the host only ever sees the result: the grid's oninput
// passes ScoreKeypad.value(this) rather than the raw text, and leaving the
// cell (Next, a tap elsewhere) replaces the sum with that same result.
//
// The bar is one element on <body>, created on first use, so it is never
// inside a transformed sheet where `position: fixed` would stop meaning the
// screen. It shows only while :root.bgb-kb-open (ui/viewport-lock.js) says a
// software keyboard is up — a laptop has its own + and − keys and Enter moves
// on just the same — and sits on it through --bgb-kb-inset.
//
// The buttons must not take focus from the cell, or the keyboard drops and
// comes back on every tap. pointerdown is cancelled for mouse and Android;
// iOS decides focus in the tap itself, so a touch acts on touchend and cancels
// that, which also swallows the click it would have become.

(function () {
  const CELL = "input.scoring-cell";

  /**
   * The score a cell's text stands for: "" (empty), "-" (a sign waiting for
   * digits, the same half-typed state sanitizeRoundScore keeps), or an integer
   * string. A trailing operator is ignored, so "12+" is 12 while it is typed.
   * @param {string} text
   * @returns {string}
   */
  function evaluate(text) {
    const s = clean(text);
    const terms = s.match(/[+-]?\d+/g);
    if (!terms) return s.charAt(0) === "-" ? "-" : "";
    return String(terms.reduce((sum, t) => sum + parseInt(t, 10), 0));
  }

  /** Digits and the two operators, no operator stacked on another, no leading "+". */
  function clean(text) {
    return String(text == null ? "" : text)
      .replace(/[^0-9+-]/g, "")
      .replace(/[+-]+(?=[+-])/g, "")
      .replace(/^\+/, "");
  }

  /**
   * For the cell's oninput: tidy the text in place (a pasted letter, a doubled
   * operator) and return the score it stands for.
   * @param {HTMLInputElement} el
   */
  function value(el) {
    const tidy = clean(el.value);
    if (tidy !== el.value) {
      const pos = Math.max(0, (el.selectionStart || 0) - (el.value.length - tidy.length));
      el.value = tidy;
      try { el.setSelectionRange(pos, pos); } catch (_) {}
    }
    return evaluate(tidy);
  }

  /** Write text into a cell the way typing would, so the host hears it. */
  function write(el, text, caret) {
    el.value = text;
    try { el.setSelectionRange(caret, caret); } catch (_) {}
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function insertOp(el, op) {
    const v = el.value;
    let start = el.selectionStart == null ? v.length : el.selectionStart;
    const end = el.selectionEnd == null ? v.length : el.selectionEnd;
    // Swap an operator right behind the caret rather than stacking a second.
    if (start === end && /[+-]/.test(v.charAt(start - 1))) start -= 1;
    if (start === 0 && op === "+") return;
    write(el, v.slice(0, start) + op + v.slice(end), start + 1);
  }

  // (−) is about the whole cell, not the term under the caret: a sum in
  // progress is settled first, so "12+7" becomes "-19".
  function toggleSign(el) {
    const v = evaluate(el.value);
    const next = v === "" ? "-" : v === "-" ? "" : v.charAt(0) === "-" ? v.slice(1) : "-" + v;
    write(el, next, next.length);
  }

  // Settle a cell on the way out: the sum becomes its result and a lone "-"
  // becomes empty, so a cell never sits there showing text its column is not
  // totalling.
  function settle(el) {
    const v = evaluate(el.value);
    const final = v === "-" ? "" : v;
    if (el.value !== final) write(el, final, final.length);
  }

  // The cells of the grid this one belongs to, in reading order — across a
  // round, then down to the next one — which is document order, because each
  // round is one <tr>.
  function cellsOf(el) {
    const grid = el.closest(".rg") || document;
    return Array.from(grid.querySelectorAll(CELL));
  }

  function isLast(el) {
    const cells = cellsOf(el);
    return cells[cells.length - 1] === el;
  }

  function next(el) {
    const cells = cellsOf(el);
    const to = cells[cells.indexOf(el) + 1];
    settle(el);
    if (!to) { el.blur(); return; }
    to.focus();
    const n = to.value.length;
    try { to.setSelectionRange(n, n); } catch (_) {}
  }

  // ── The bar ──────────────────────────────────────────────────────────
  /** @type {HTMLElement|null} */
  let bar = null;
  /** @type {HTMLInputElement|null} */
  let active = null;
  let touched = false;

  function buildBar() {
    const el = document.createElement("div");
    el.className = "score-keypad";
    el.setAttribute("role", "toolbar");
    el.setAttribute("aria-label", "Score keys");
    el.hidden = true;
    el.innerHTML = `
      <button type="button" tabindex="-1" class="score-keypad__key" data-key="+" aria-label="Plus">+</button>
      <button type="button" tabindex="-1" class="score-keypad__key" data-key="-" aria-label="Minus">&minus;</button>
      <button type="button" tabindex="-1" class="score-keypad__key score-keypad__key--sign" data-key="sign" aria-label="Make negative or positive">(&minus;)</button>
      <button type="button" tabindex="-1" class="score-keypad__next" data-key="next">Next</button>`;
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" && e.target instanceof Element && e.target.closest("button")) e.preventDefault();
    });
    el.addEventListener("touchend", (e) => {
      const b = e.target instanceof Element ? e.target.closest("button") : null;
      if (!b) return;
      e.preventDefault();
      // The cancelled touch never becomes a click; the flag only guards
      // browsers that send one anyway.
      touched = true;
      setTimeout(() => { touched = false; }, 400);
      press(b);
    });
    el.addEventListener("click", (e) => {
      if (touched) return;
      const b = e.target instanceof Element ? e.target.closest("button") : null;
      if (b) press(b);
    });
    document.body.appendChild(el);
    return el;
  }

  /** @param {Element} b */
  function press(b) {
    const el = active;
    if (!el || !el.isConnected) return;
    const key = b.getAttribute("data-key");
    if (key === "next") next(el);
    else if (key === "sign") toggleSign(el);
    else if (key) insertOp(el, key);
  }

  function show(el) {
    if (!bar) bar = buildBar();
    active = el;
    const nextBtn = bar.querySelector(".score-keypad__next");
    if (nextBtn) nextBtn.textContent = isLast(el) ? "Done" : "Next";
    bar.hidden = false;
    // iOS scrolls a focused field clear of the keyboard, but it does not know
    // about this bar — once the keyboard has settled, bring the cell out from
    // under it too.
    setTimeout(() => {
      if (active !== el || !bar || bar.hidden) return;
      const barTop = bar.getBoundingClientRect().top;
      if (el.getBoundingClientRect().bottom > barTop) el.scrollIntoView({ block: "center", inline: "nearest" });
    }, 350);
  }

  function hide() {
    active = null;
    if (bar) bar.hidden = true;
  }

  function start() {
    document.addEventListener("focusin", (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.matches(CELL)) show(t);
    });
    document.addEventListener("focusout", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || !t.matches(CELL)) return;
      settle(t);
      // Focus lands on the next cell after this event; only hide if it didn't.
      setTimeout(() => {
        const now = document.activeElement;
        if (!(now instanceof HTMLInputElement && now.matches(CELL))) hide();
      }, 0);
    });
    document.addEventListener("keydown", (e) => {
      const t = e.target;
      if (e.key !== "Enter" || !(t instanceof HTMLInputElement) || !t.matches(CELL)) return;
      e.preventDefault();
      next(t);
    });
  }

  window.ScoreKeypad = { evaluate, value, toggleSign, insertOp, next };
  if (typeof document !== "undefined" && document.addEventListener) start();
})();
