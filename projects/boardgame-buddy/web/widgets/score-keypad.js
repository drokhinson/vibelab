// widgets/score-keypad.js — the score pad: the app's own number keys for a
// scoring-grid cell on a touch screen, in place of the phone's keyboard.
//
//   1  2  3  ⌫          Sum mode:   1  2  3  ⌫
//   4  5  6  (−)                    4  5  6  −
//   7  8  9                         7  8  9  +
//   Prev  0  Next  .                Prev  0  Next  .
//   Σ Sum  |  + Round               Σ Sum  |  =
//
// On a coarse pointer the cells render with inputmode="none"
// (round-score-grid.js asks ScoreKeypad.custom), so focusing one raises no
// system keyboard and this pad slides up instead. A score field outside a grid
// (the play-detail card's whole-play scores) opts in with `data-score-pad`,
// and Prev / Next walk the nearest [data-score-pad-group] around it. A mouse-and-keyboard screen
// keeps plain typing, with Enter / Shift+Enter moving between cells.
//
// The pad is one element on <body>, created on first use, so it is never inside
// a transformed sheet where `position: fixed` would stop meaning the screen. It
// reports its size to ui/viewport-lock.js (BgbViewport.setPad), which folds it
// into --bgb-vv-h / --bgb-kb-inset and :root.bgb-kb-open exactly as a system
// keyboard would, so every surface that already makes room for a keyboard makes
// room for the pad. On the `land` tier (a phone on its side) the pad docks on
// the right edge instead and reports a width.
//
// The keys must not take focus from the cell, or the cell would blur and the
// pad close on every tap. pointerdown is cancelled for mouse and pen; iOS
// decides focus in the tap itself, so a touch acts on touchend and cancels
// that, which also swallows the click it would have become.
//
// Scores take up to two decimal places, so "." is a key of its own.
//
// + Round shows only for a cell inside a [data-kp-round] element. It
// dispatches `scorekeypad:round` (bubbling) from the cell; the host adds the
// row and focuses its first cell in the same tap.
//
// The device back gesture puts the pad away, the way it would a system
// keyboard: the pad arms a back guard (ui/back-guard.js) while it is up, and
// the press that pops it blurs the cell. Android's own back-with-keyboard never
// reaches the page, but with the system keyboard kept down the press does, and
// unguarded it would walk the screen behind the pad instead. Inside an overlay
// the pad's guard sits above the overlay's, so the first press closes the pad
// and the second the overlay.
//
// Σ Sum (widgets/score-sum.js) writes the running total into the cell on every
// key, the same way typing does, so the host's totals follow along. Leaving the
// cell keeps that total; Cancel puts back what the cell held before.

(function () {
  // A scoring-grid cell, or any other score field that opts in.
  const CELL = "input.scoring-cell, input[data-score-pad]";
  const Sum = window.ScoreSum;
  const custom = !!(typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches);

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

  // A number still being typed is finished on the way out: a lone "-" or "."
  // is cleared and a trailing "." dropped, so a cell never sits there showing
  // a sign or a point its column is not totalling.
  function settle(el) {
    const v = el.value.replace(/\.$/, "");
    const done = v === "-" ? "" : v;
    if (done !== el.value) write(el, done);
  }

  // The cells of the grid this one belongs to, in reading order — across a
  // round, then down to the next one — which is document order, because each
  // round is one <tr>.
  function cellsOf(el) {
    const grid = el.closest(".rg, [data-score-pad-group]") || document;
    return Array.from(grid.querySelectorAll(CELL));
  }

  // Next past the last cell closes the pad; Prev before the first one does
  // nothing (its key is disabled there).
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

  // ── The pad ──────────────────────────────────────────────────────────
  const BACK_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z"/><path d="m12 9 6 6M18 9l-6 6"/></svg>`;

  /** @type {HTMLElement|null} */
  let pad = null;
  /** @type {HTMLInputElement|null} */
  let active = null;
  /** Σ Sum state, and what the cell held when it began. */
  let sum = null;
  let before = "";
  let touched = false;
  /** The back guard's token while the pad is up, else 0. */
  let guard = 0;

  function key(k, label, cls, aria) {
    return `<button type="button" tabindex="-1" class="score-pad__key${cls ? " " + cls : ""}" data-key="${k}"${aria ? ` aria-label="${aria}"` : ""}>${label}</button>`;
  }

  function buildPad() {
    const el = document.createElement("div");
    el.className = "score-pad";
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", "Score keys");
    el.hidden = true;
    const blank = `<span class="score-pad__key score-pad__key--blank score-pad__plain" aria-hidden="true"></span>`;
    el.innerHTML = `
      <div class="score-pad__tape">
        <div class="score-pad__terms"></div>
        <button type="button" tabindex="-1" class="score-pad__cancel" data-key="cancel">Cancel</button>
      </div>
      <div class="score-pad__keys">
        ${key("1", "1")}${key("2", "2")}${key("3", "3")}
        ${key("back", BACK_ICON, "score-pad__key--fn", "Delete")}
        ${key("4", "4")}${key("5", "5")}${key("6", "6")}
        ${key("sign", "(&minus;)", "score-pad__key--fn score-pad__key--sign score-pad__plain", "Make negative or positive")}
        ${key("-", "&minus;", "score-pad__key--op score-pad__sum", "Subtract")}
        ${key("7", "7")}${key("8", "8")}${key("9", "9")}
        ${blank}${key("+", "+", "score-pad__key--op score-pad__sum", "Add")}
        ${key("prev", "Prev", "score-pad__key--nav")}
        ${key("0", "0")}
        ${key("next", "Next", "score-pad__key--next")}
        ${key(".", ".", "score-pad__key--fn score-pad__key--dot", "Decimal point")}
        ${key("sum", "&Sigma; Sum", "score-pad__key--tool score-pad__key--sumkey")}
        ${key("round", "+ Round", "score-pad__key--tool score-pad__key--round score-pad__plain")}
        ${key("=", "=", "score-pad__key--tool score-pad__key--eq score-pad__sum", "Finish the sum")}
      </div>`;
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" && e.target instanceof Element && e.target.closest("button")) e.preventDefault();
    });
    el.addEventListener("touchend", (e) => {
      if (!(e.target instanceof Element) || !e.target.closest("button")) return;
      e.preventDefault();
      // The cancelled touch never becomes a click; the flag only guards
      // browsers that send one anyway.
      touched = true;
      setTimeout(() => { touched = false; }, 400);
      press(e.target);
    });
    el.addEventListener("click", (e) => {
      if (!touched && e.target instanceof Element) press(e.target);
    });
    document.body.appendChild(el);
    if (typeof ResizeObserver === "function") new ResizeObserver(report).observe(el);
    window.addEventListener("resize", () => { if (active) { place(); report(); } });
    return el;
  }

  /** @param {Element} target */
  function press(target) {
    const el = active;
    if (!el || !el.isConnected) return;
    const del = target.closest("[data-del]");
    const chip = target.closest("[data-chip]");
    if (sum && (del || chip)) {
      if (del) Sum.remove(sum, Number(del.getAttribute("data-del")));
      else Sum.tap(sum, Number(chip.getAttribute("data-chip")));
      return sumChanged();
    }
    const b = target.closest("button");
    if (!b || /** @type {HTMLButtonElement} */ (b).disabled) return;
    const k = b.getAttribute("data-key");
    if (k === "next") move(el, 1);
    else if (k === "prev") move(el, -1);
    else if (k === "round") {
      endSum();
      settle(el);
      el.dispatchEvent(new CustomEvent("scorekeypad:round", { bubbles: true }));
    } else if (k === "sum") {
      if (sum) endSum(); else startSum();
    } else if (sum) {
      if (k === "=") endSum();
      else if (k === "cancel") { endSum(); write(el, before); }
      else { Sum.key(sum, k); sumChanged(); }
    } else if (k === "sign") toggleSign(el);
    else if (k === "back" || k === "." || /^[0-9]$/.test(k || "")) write(el, Sum.typeKey(el.value, k));
  }

  // ── Σ Sum ──
  function startSum() {
    const el = active;
    if (!el || !pad) return;
    const n = Number(el.value);
    before = el.value;
    sum = Sum.create(el.value === "" || el.value === "-" || !Number.isFinite(n) ? null : n);
    pad.classList.add("is-summing");
    const wrap = el.closest(".scoring-cell-wrap, .score-pad-field");
    if (wrap) wrap.classList.add("is-summing");
    Sum.spotlight(el);
    sumChanged();
  }

  function endSum() {
    if (!sum) return;
    sum = null;
    if (pad) pad.classList.remove("is-summing");
    document.querySelectorAll(".is-summing:is(.scoring-cell-wrap, .score-pad-field)").forEach((w) => w.classList.remove("is-summing"));
    Sum.unspotlight();
  }

  function sumChanged() {
    if (!sum || !pad || !active) return;
    const box = /** @type {HTMLElement} */ (pad.querySelector(".score-pad__terms"));
    const terms = Sum.view(sum);
    const sign = (op) => (op === "-" ? "&minus;" : "+");
    const ph = `<span class="score-pad__ph">…</span>`;
    box.innerHTML = terms.map((t, i) => {
      const open = i === sum.edit;
      const lead = i === 0 && t.op === "+" ? "" : sign(t.op);
      return `<button type="button" tabindex="-1" data-chip="${i}"
        class="score-pad__chip${t.op === "-" ? " is-minus" : ""}${open ? " is-open" : ""}${sum.terms[i].fresh ? " is-fresh" : ""}"
        aria-label="${open ? "Editing" : "Change"} ${t.op === "-" ? "minus " : ""}${t.v}">${lead}${t.v || ph}${open
          ? `<span class="score-pad__chip-del" data-del="${i}" aria-label="Remove">&times;</span>` : ""}</button>`;
    }).join("") + `<span class="score-pad__chip score-pad__chip--entry${sum.edit === null ? " is-live" : ""}">${
      terms.length || sum.op === "-" ? sign(sum.op) : ""}${sum.entry || ph}</span>`;
    sum.terms.forEach((t) => { delete t.fresh; });
    const openChip = /** @type {HTMLElement|null} */ (box.querySelector(".is-open"));
    if (!openChip) box.scrollLeft = box.scrollWidth;
    else if (openChip.offsetLeft < box.scrollLeft || openChip.offsetLeft + openChip.offsetWidth > box.scrollLeft + box.clientWidth) {
      box.scrollLeft = openChip.offsetLeft - 8;
    }
    pad.querySelectorAll(".score-pad__key--op").forEach((b) => b.classList.toggle("is-armed",
      sum.edit === null && b.getAttribute("data-key") === sum.op && sum.entry === "" && sum.terms.length > 0));
    write(active, Sum.cellText(sum));
    Sum.redraw();
  }

  // ── Showing and placing ──
  function side() {
    return document.documentElement.getAttribute("data-bgb-layout") === "land";
  }

  function place() {
    if (pad) pad.classList.toggle("score-pad--side", side());
  }

  // Tell viewport-lock how much of the screen the pad covers.
  function report() {
    if (!window.BgbViewport || !window.BgbViewport.setPad) return;
    if (!pad || pad.hidden || !active) return window.BgbViewport.setPad(0, 0);
    if (side()) window.BgbViewport.setPad(0, pad.offsetWidth);
    else window.BgbViewport.setPad(pad.offsetHeight, 0);
  }

  function show(el) {
    if (!pad) pad = buildPad();
    if (active !== el) endSum();
    active = el;
    const cells = cellsOf(el);
    const nextBtn = pad.querySelector('[data-key="next"]');
    const prevBtn = /** @type {HTMLButtonElement|null} */ (pad.querySelector('[data-key="prev"]'));
    if (nextBtn) nextBtn.textContent = cells[cells.length - 1] === el ? "Done" : "Next";
    if (prevBtn) prevBtn.disabled = cells[0] === el;
    pad.classList.toggle("has-round", !!el.closest("[data-kp-round]"));
    place();
    const opening = pad.hidden;
    pad.hidden = false;
    report();
    if (opening && !guard && window.BgbBackGuard) {
      guard = window.BgbBackGuard.arm({
        root: pad,
        close: () => {
          guard = 0;
          if (active) active.blur();
        },
      });
    }
    if (opening) requestAnimationFrame(() => { if (pad && active) pad.classList.add("is-open"); });
    // The browser scrolls a focused field into view without knowing about the
    // pad. Once the pad has settled, bring the cell out from under it too.
    setTimeout(() => {
      if (active !== el || !pad || pad.hidden) return;
      const p = pad.getBoundingClientRect();
      const covered = () => {
        const r = el.getBoundingClientRect();
        return side() ? r.right > p.left : r.bottom > p.top - 8;
      };
      if (!covered()) return;
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (covered() && !side()) window.scrollBy(0, el.getBoundingClientRect().bottom - p.top + 16);
    }, 280);
  }

  function hide() {
    endSum();
    active = null;
    if (guard && window.BgbBackGuard) window.BgbBackGuard.release(guard);
    guard = 0;
    if (!pad) return;
    pad.classList.remove("is-open");
    pad.hidden = true;
    report();
  }

  function start() {
    document.addEventListener("focusin", (e) => {
      const t = e.target;
      if (custom && t instanceof HTMLInputElement && t.matches(CELL)) show(t);
    });
    document.addEventListener("focusout", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || !t.matches(CELL)) return;
      if (t === active) endSum();
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

  window.ScoreKeypad = { custom, flipSign, toggleSign, move };
  if (typeof document !== "undefined" && document.addEventListener) start();
})();
