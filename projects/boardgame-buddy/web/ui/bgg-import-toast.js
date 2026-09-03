// @ts-check
// ui/bgg-import-toast.js — "Ark Nova is in the library" — the notification a
// finished BoardGameGeek import pops, wherever the user happens to be.
//
// WHY NOT showToast(). The app's global toast (helpers.js) is a line of text
// inside #app at z-index 100, which is the same rung the sheet backdrop sits
// on — and the backdrop is appended to <body> afterwards, so it wins the tie
// and paints straight over it. It also has nowhere to put an action, and this
// notification's whole job is to carry one: importing is step one, shelving is
// step two (.claude/rules/ui-object-design.md — one affordance per
// destination), and when the import lands after the sheet has been closed this
// card is the only place step two is still offered.
//
// So: body-level, top-anchored, and one rung ABOVE the modal/sheet rung at
// 110. Top-anchored is what makes that safe — the sheet it may be covering is
// bottom-anchored, so the two never fight for the same pixels, and the panel's
// own list stays fully readable underneath.
//
// Cards stack newest-on-top and expire on a timer that the pointer and focus
// both pause: a card carrying a button must not vanish under a thumb that is
// on its way to press it.

(function () {
  const HOST_ID = "bgb-import-toasts";

  // Long for a toast, deliberately: this one is read AND acted on. Matches the
  // budget the install prompt gives its two buttons.
  const LIFE_MS = 9000;
  // Must match the .bgb-import-toast--out animation duration in styles.css.
  const OUT_MS = 220;
  // Beyond this the stack is noise rather than news — oldest cards go first.
  const MAX_CARDS = 3;

  const SHELF_LABEL = { owned: "collection", wishlist: "wishlist" };

  function host() {
    let el = document.getElementById(HOST_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = HOST_ID;
    el.className = "bgb-import-toasts";
    // Announced, not focus-stealing: the user is somewhere else by definition.
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
    return el;
  }

  /** @param {HTMLElement} card */
  function remove(card) {
    if (!card.isConnected || card.classList.contains("bgb-import-toast--out")) return;
    const timer = Number(card.dataset.timer || 0);
    if (timer) clearTimeout(timer);
    // Drop the id BEFORE the exit animation. A dying card is still in the DOM
    // for OUT_MS, and a retry pressed on it re-imports the same game — which
    // would otherwise find this node by id, revive it, and then have it swept
    // out from under itself by the teardown already scheduled below.
    card.removeAttribute("id");
    card.classList.add("bgb-import-toast--out");
    setTimeout(() => {
      if (card.parentNode) card.parentNode.removeChild(card);
      const h = document.getElementById(HOST_ID);
      if (h && !h.childElementCount && h.parentNode) h.parentNode.removeChild(h);
    }, OUT_MS);
  }

  /** @param {HTMLElement} card */
  function arm(card) {
    const prev = Number(card.dataset.timer || 0);
    if (prev) clearTimeout(prev);
    card.dataset.timer = String(setTimeout(() => remove(card), LIFE_MS));
  }

  /** @param {HTMLElement} card */
  function hold(card) {
    const prev = Number(card.dataset.timer || 0);
    if (prev) clearTimeout(prev);
    card.dataset.timer = "0";
  }

  /**
   * The body of a card, for a given job state. Re-rendered in place as the
   * user works the card, so the same markup covers the first paint and every
   * later one.
   * @param {any} job
   */
  function body(job) {
    const failed = job.state === "error";
    const shelf = job.shelfIntent === "wishlist" ? "wishlist" : "owned";
    const shelved = !!job.shelf;
    const icon = failed ? "alert-triangle" : shelved ? "check-circle" : "library-big";

    let line;
    if (failed) line = job.error || "Import failed.";
    else if (shelved) line = `Added to your ${SHELF_LABEL[job.shelf] || "collection"}.`;
    else line = "Imported into the library. It isn't on a shelf yet.";

    let action = "";
    if (failed) {
      action = `<button type="button" class="bgb-import-toast__action" data-toast-action="retry">
                  Try again
                </button>`;
    } else if (!shelved) {
      action = `<button type="button" class="bgb-import-toast__action" data-toast-action="shelf"
                        data-toast-shelf="${escapeAttr(shelf)}" ${job.shelving ? "disabled" : ""}>
                  ${job.shelving ? "Adding…" : `Add to ${escapeHtml(SHELF_LABEL[shelf])}`}
                </button>`;
    }

    return `
      <div class="bgb-import-toast__mark ${failed ? "bgb-import-toast__mark--bad" : ""}" aria-hidden="true">
        <i data-icon="${icon}" class="w-5 h-5"></i>
      </div>
      <div class="bgb-import-toast__body">
        <div class="bgb-import-toast__name">${escapeHtml(job.name || "This game")}</div>
        <div class="bgb-import-toast__line">${escapeHtml(line)}</div>
      </div>
      ${action}
      <button type="button" class="bgb-import-toast__close" data-toast-action="dismiss"
              aria-label="Dismiss">
        <i data-icon="x" class="w-4 h-4"></i>
      </button>
    `;
  }

  /** @param {HTMLElement} card @param {any} job */
  function paint(card, job) {
    card.dataset.state = job.state;
    card.innerHTML = body(job);
    window.BgbIcons.render(card);
  }

  /**
   * Pop (or refresh) the notification for one import job.
   * @param {any} job  An ImportJob from domain/bgg-import.js.
   */
  function show(job) {
    if (!job) return;
    const h = host();
    const id = `bgb-import-toast-${job.bggId}`;

    // A retry from inside the card reuses it rather than stacking a second
    // one for the same game.
    let card = /** @type {HTMLElement|null} */ (document.getElementById(id));
    if (!card) {
      card = document.createElement("div");
      card.id = id;
      card.className = "bgb-import-toast";
      h.prepend(card);
      card.addEventListener("click", (ev) => onClick(ev, job.bggId));
      // Pointer OR keyboard: a card the user has tabbed into is being read.
      card.addEventListener("pointerenter", () => hold(/** @type {HTMLElement} */ (card)));
      card.addEventListener("pointerleave", () => arm(/** @type {HTMLElement} */ (card)));
      card.addEventListener("focusin", () => hold(/** @type {HTMLElement} */ (card)));
      card.addEventListener("focusout", () => arm(/** @type {HTMLElement} */ (card)));
    } else {
      card.classList.remove("bgb-import-toast--out");
    }

    paint(card, job);
    arm(card);

    while (h.childElementCount > MAX_CARDS) {
      remove(/** @type {HTMLElement} */ (h.lastElementChild));
    }
  }

  /** @param {Event} ev @param {number} bggId */
  async function onClick(ev, bggId) {
    const btn = /** @type {HTMLElement|null} */ (
      /** @type {any} */ (ev.target).closest("[data-toast-action]")
    );
    if (!btn) return;
    ev.preventDefault();
    const card = /** @type {HTMLElement|null} */ (document.getElementById(`bgb-import-toast-${bggId}`));
    if (!card) return;
    const action = btn.getAttribute("data-toast-action");

    if (action === "dismiss") { remove(card); return; }

    if (action === "retry") {
      const job = window.BggImport.get(bggId);
      remove(card);
      // start() pops a fresh notification when it settles, so nothing here
      // has to wait on it.
      window.BggImport.start(
        { bgg_id: bggId, name: job ? job.name : "" },
        { shelf: job ? job.shelfIntent : "owned" },
      );
      return;
    }

    if (action === "shelf") {
      const shelf = /** @type {any} */ (btn.getAttribute("data-toast-shelf") || "owned");
      // Held, not armed: the write is the user's last act on this card, and a
      // card that expired mid-request would take its own outcome with it.
      hold(card);
      const ok = await window.BggImport.addToShelf(bggId, shelf);
      // Both states are already painted by the subscription below — this only
      // decides how long the result stays up. On success the card is a receipt
      // with nothing left to press; on failure it names the reason and keeps
      // its button, so it gets the full life again.
      if (ok) setTimeout(() => remove(card), 2200);
      else arm(card);
    }
  }

  // Live cards repaint from the queue, so a step-two add made in the SHEET is
  // reflected on a card that is still up (and vice versa) without either
  // surface knowing the other exists.
  window.store.subscribe("bggImport", () => {
    const h = document.getElementById(HOST_ID);
    if (!h) return;
    for (const card of Array.from(h.children)) {
      const el = /** @type {HTMLElement} */ (card);
      if (el.classList.contains("bgb-import-toast--out")) continue;
      const job = window.BggImport.get(Number(el.id.replace("bgb-import-toast-", "")));
      if (job) paint(el, job);
    }
  });

  /** Clear every card. Sign-out, and anything that resets the queue. */
  function clear() {
    const h = document.getElementById(HOST_ID);
    if (h && h.parentNode) h.parentNode.removeChild(h);
  }

  window.BggImportToast = { show, clear };
})();
