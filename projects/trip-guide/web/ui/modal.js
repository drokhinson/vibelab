// ui/modal.js — one modal surface + one toast surface for the whole app.
// Modal.open() returns { root, close }; callers wire their own form events.
(function () {
  let _closeFn = null;

  function open({ title, bodyHTML, footerHTML = "", wide = false }) {
    close();
    const host = document.getElementById("modal-host");
    host.innerHTML = `
      <div class="tg-modal-backdrop" data-modal-backdrop>
        <div class="tg-modal ${wide ? "tg-modal--wide" : ""}" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
          <div class="tg-modal__head">
            <h2 class="tg-modal__title">${escapeHtml(title)}</h2>
            <button class="btn btn-sm btn-ghost btn-circle" data-modal-x aria-label="Close">
              <i data-lucide="x"></i>
            </button>
          </div>
          <div class="tg-modal__body">${bodyHTML}</div>
          ${footerHTML ? `<div class="tg-modal__foot">${footerHTML}</div>` : ""}
        </div>
      </div>`;
    const root = host.firstElementChild;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    root.querySelector("[data-modal-x]").addEventListener("click", close);
    // `root` IS the backdrop element — close when the click lands on it (outside the panel).
    root.addEventListener("mousedown", (e) => { if (e.target === root) close(); });
    _closeFn = () => {
      document.removeEventListener("keydown", onKey);
      host.innerHTML = "";
      _closeFn = null;
    };
    if (window.lucide) window.lucide.createIcons({ root });
    return { root, close };
  }

  function close() { if (_closeFn) _closeFn(); }

  function toast(message, type = "info") {
    const host = document.getElementById("toast-host");
    const el = document.createElement("div");
    el.className = `tg-toast tg-toast--${type}`;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => { el.classList.add("tg-toast--out"); }, 2600);
    setTimeout(() => { el.remove(); }, 3000);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function escapeAttr(s) { return escapeHtml(s); }

  window.Modal = { open, close };
  window.toast = toast;
  window.escapeHtml = escapeHtml;
})();
