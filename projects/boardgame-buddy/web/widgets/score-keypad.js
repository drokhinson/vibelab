// widgets/score-keypad.js — the bar that rides on top of the number pad while
// a scoring-grid cell has focus: (−) to flip the cell's sign, Prev / Next to
// move between cells, the cell being typed into, and — on the Play step — the
// docked bar's "Next round" as + Round.
//
// The cell asks for `inputmode="numeric"`, the iOS 10-key pad — big keys,
// digits only, no sign and no return key. The two keys that pad is missing
// live here instead.
//
// The bar is one element on <body>, created on first use, so it is never
// inside a transformed sheet where `position: fixed` would stop meaning the
// screen. It shows only while :root.bgb-kb-open (ui/viewport-lock.js) says a
// software keyboard is up — a laptop has its own minus key, and Enter and
// Shift+Enter move the same way — and sits on it through --bgb-kb-inset.
//
// iOS 26 changed what "on the keyboard" means. Its form-assistant bar
// (⌃ ⌄ ✓) became a floating glass pill that is NOT part of the keyboard: the
// visual viewport ends at the keyboard's top edge and the pill floats over the
// bottom of it — exactly where this bar docks, so the pill covered it. Earlier
// iOS attached that bar to the keyboard, outside the viewport, so docking at
// --bgb-kb-inset was right there and still is. The bar lifts on iOS 26+ only;
// see liftsOverAssistant() for how that is told apart.
//
// The buttons must not take focus from the cell, or the keyboard drops and
// comes back on every tap. pointerdown is cancelled for mouse and Android;
// iOS decides focus in the tap itself, so a touch acts on touchend and cancels
// that, which also swallows the click it would have become.
//
// + Round shows only for a cell inside a [data-kp-round] element. It
// dispatches `scorekeypad:round` (bubbling) from the cell; the host adds the
// row and focuses its first cell in the same tap, so the keyboard stays up.
// With a keyboard up the Play step hides its docked bar (styles.css), because
// this bar sits exactly where that one would.

(function () {
  const CELL = "input.scoring-cell";

  /**
   * The cell's text with its sign flipped: "" → "-" (a sign waiting for
   * digits, the half-typed state sanitizeRoundScore keeps), "-" → "", and
   * "12" ↔ "-12".
   * @param {string} text
   * @returns {string}
   */
  function flipSign(text) {
    const v = String(text == null ? "" : text);
    return v.charAt(0) === "-" ? v.slice(1) : "-" + v;
  }

  /** Write text into a cell the way typing would, so the host hears it. */
  function write(el, text) {
    el.value = text;
    try { el.setSelectionRange(text.length, text.length); } catch (_) {}
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function toggleSign(el) {
    write(el, flipSign(el.value));
  }

  // A lone "-" left behind is cleared on the way out, so a cell never sits
  // there showing a sign its column is totalling as nothing.
  function settle(el) {
    if (el.value === "-") write(el, "");
  }

  // The cells of the grid this one belongs to, in reading order — across a
  // round, then down to the next one — which is document order, because each
  // round is one <tr>.
  function cellsOf(el) {
    const grid = el.closest(".rg") || document;
    return Array.from(grid.querySelectorAll(CELL));
  }

  // Next past the last cell closes the keyboard; Prev before the first one
  // does nothing (its button is disabled there).
  function move(el, step) {
    const cells = cellsOf(el);
    const to = cells[cells.indexOf(el) + step];
    if (!to && step < 0) return;
    settle(el);
    if (!to) { el.blur(); return; }
    to.focus();
    const n = to.value.length;
    try { to.setSelectionRange(n, n); } catch (_) {}
  }

  // ── The bar ──────────────────────────────────────────────────────────
  // iPhone on iOS 26 or later. The user agent can't say: Safari 26 freezes the
  // OS version in it at 18_x, and a home-screen app carries no Safari version
  // at all. CSS anchor positioning shipped in the same WebKit (Safari 26), and
  // every iOS browser is that WebKit, so it marks the version on any of them.
  // iPad is left out: its keyboard keeps the shortcuts bar inside itself.
  function liftsOverAssistant() {
    const ua = navigator.userAgent || "";
    if (!/iPhone|iPod/.test(ua)) return false;
    return !!(window.CSS && CSS.supports && CSS.supports("anchor-name: --a"));
  }

  /** @type {HTMLElement|null} */
  let bar = null;
  /** @type {HTMLInputElement|null} */
  let active = null;
  let touched = false;

  function buildBar() {
    const el = document.createElement("div");
    el.className = liftsOverAssistant() ? "score-keypad score-keypad--lifted" : "score-keypad";
    el.setAttribute("role", "toolbar");
    el.setAttribute("aria-label", "Score keys");
    el.hidden = true;
    el.innerHTML = `
      <button type="button" tabindex="-1" class="score-keypad__key" data-key="sign" aria-label="Make negative or positive">(&minus;)</button>
      <span class="score-keypad__where" aria-hidden="true"></span>
      <button type="button" tabindex="-1" class="score-keypad__nav score-keypad__prev" data-key="prev">Prev</button>
      <button type="button" tabindex="-1" class="score-keypad__nav score-keypad__next" data-key="next">Next</button>
      <button type="button" tabindex="-1" class="score-keypad__nav score-keypad__round" data-key="round">+ Round</button>`;
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
    if (key === "next") move(el, 1);
    else if (key === "prev") move(el, -1);
    else if (key === "sign") toggleSign(el);
    else if (key === "round") {
      settle(el);
      el.dispatchEvent(new CustomEvent("scorekeypad:round", { bubbles: true }));
    }
  }

  function show(el) {
    if (!bar) bar = buildBar();
    active = el;
    const cells = cellsOf(el);
    const nextBtn = bar.querySelector(".score-keypad__next");
    const prevBtn = /** @type {HTMLButtonElement|null} */ (bar.querySelector(".score-keypad__prev"));
    if (nextBtn) nextBtn.textContent = cells[cells.length - 1] === el ? "Done" : "Next";
    if (prevBtn) prevBtn.disabled = cells[0] === el;
    const where = bar.querySelector(".score-keypad__where");
    if (where) where.textContent = el.getAttribute("aria-label") || "";
    const roundBtn = /** @type {HTMLElement|null} */ (bar.querySelector(".score-keypad__round"));
    if (roundBtn) roundBtn.hidden = !el.closest("[data-kp-round]");
    bar.hidden = false;
    // iOS scrolls a focused field clear of the keyboard, but it does not know
    // about this bar — once the keyboard has settled, bring the cell out from
    // under it too.
    setTimeout(() => {
      if (active !== el || !bar || bar.hidden) return;
      const barTop = bar.getBoundingClientRect().top;
      if (el.getBoundingClientRect().bottom > barTop) el.scrollIntoView({ block: "nearest", inline: "nearest" });
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
      move(t, e.shiftKey ? -1 : 1);
    });
  }

  window.ScoreKeypad = { flipSign, toggleSign, move };
  if (typeof document !== "undefined" && document.addEventListener) start();
})();
