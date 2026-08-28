// @ts-check
//
// ui/outbox-indicator.js — the global header's pending-upload control.
//
// The upload queue is account-level state, not Play-tab state, so it lives in
// the header next to the avatar rather than in the middle of one screen.
//
// Renders three states:
//   nothing queued  → greyed out, no badge (present but plainly inert)
//   n queued        → accent, count badge
//   flushing        → accent + a spinner ring
//
// The count is Outbox.pendingCount(), NOT count(): count() includes entries
// the server rejected outright, and calling a permanently-failed play
// "waiting to upload" is a lie the old Play-tab banner told.

(function () {
  const HOST_ID = "bgb-outbox-indicator";

  function render() {
    const el = document.getElementById(HOST_ID);
    if (!el || !window.Outbox) return;

    const n = window.Outbox.pendingCount();
    const failed = window.Outbox.count() - n;
    const flushing = window.Outbox.isFlushing();

    el.classList.toggle("is-zero", n === 0 && failed === 0);
    el.classList.toggle("is-busy", flushing);

    const label = n === 0 && failed === 0
      ? "Uploads — nothing waiting"
      : `Uploads — ${n} waiting${failed ? `, ${failed} failed` : ""}`;
    el.setAttribute("title", label);
    el.setAttribute("aria-label", label);

    const badge = el.querySelector(".bgb-outbox__badge");
    if (badge) {
      // A failed entry still needs attention even though it is not "pending",
      // so it keeps the badge lit rather than silently disappearing.
      const shown = n || failed;
      badge.textContent = shown ? String(shown) : "";
      /** @type {HTMLElement} */ (badge).hidden = !shown;
      badge.classList.toggle("bgb-outbox__badge--failed", n === 0 && failed > 0);
    }
  }

  function open() {
    if (window.OutboxModal) window.OutboxModal.open();
  }

  window.BgbOutboxIndicator = { render, open };
})();
