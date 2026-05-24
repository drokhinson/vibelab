'use strict';
// @ts-check

// SauceBossPopup — the project's shared confirm / alert modal.
//
// Every destructive action and every error / info dialog flows through
// this widget so the chrome stays consistent. Mirrors boardgame-buddy's
// PolaroidPopup (`projects/boardgame-buddy/web/ui/polaroid-popup.js`) in
// shape; styling matches the sauceboss accent palette (orange brand,
// rust-red for destructive). Backdrop tap dismisses (resolves cancel).
//
// API:
//   SauceBossPopup.confirm({ title, body, confirmLabel, cancelLabel, destructive })
//     → Promise<boolean>  true on confirm, false on cancel / backdrop.
//   SauceBossPopup.alert({ title, body, label })
//     → Promise<void>  resolves on acknowledge / backdrop tap.
//   SauceBossPopup.dismiss()
//     → close any open popup.
//
// `destructive: true` swaps the confirm-button color to --danger so the
// affordance reads as dangerous at a glance (per .claude/rules/web-frontend.md).

(function () {
  const BACKDROP_ID = 'sauce-popup-backdrop';

  function dismiss() {
    const existing = document.getElementById(BACKDROP_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  /**
   * @param {{ title: string, body?: string, confirmLabel?: string,
   *           cancelLabel?: string, destructive?: boolean }} opts
   * @returns {Promise<boolean>}
   */
  function confirm({
    title,
    body,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
  }) {
    return new Promise((resolve) => {
      dismiss();
      const root = document.createElement('div');
      root.id = BACKDROP_ID;
      root.className = 'sauce-popup__backdrop';
      const confirmCls = destructive
        ? 'sauce-popup__btn sauce-popup__btn--danger'
        : 'sauce-popup__btn sauce-popup__btn--primary';
      root.innerHTML = `
        <div class="sauce-popup__card" role="alertdialog" aria-modal="true">
          <div class="sauce-popup__title">${escape(title)}</div>
          ${body ? `<p class="sauce-popup__body">${escape(body)}</p>` : ''}
          <div class="sauce-popup__actions">
            <button class="sauce-popup__btn sauce-popup__btn--ghost" data-action="cancel">${escape(cancelLabel)}</button>
            <button class="${confirmCls}" data-action="confirm">${escape(confirmLabel)}</button>
          </div>
        </div>
      `;
      root.addEventListener('click', (ev) => {
        if (ev.target === root) { dismiss(); resolve(false); }
      });
      const cancelBtn = root.querySelector('[data-action="cancel"]');
      const confirmBtn = root.querySelector('[data-action="confirm"]');
      if (cancelBtn) cancelBtn.addEventListener('click', () => { dismiss(); resolve(false); });
      if (confirmBtn) confirmBtn.addEventListener('click', () => { dismiss(); resolve(true); });
      document.body.appendChild(root);
      // Focus the cancel button by default so Enter doesn't accidentally
      // fire the destructive action (per web-frontend.md "Cancel is the
      // default focus / first read order").
      if (cancelBtn instanceof HTMLElement) cancelBtn.focus();
    });
  }

  /**
   * @param {{ title: string, body?: string, label?: string }} opts
   * @returns {Promise<void>}
   */
  function alert({ title, body, label = 'OK' }) {
    return new Promise((resolve) => {
      dismiss();
      const root = document.createElement('div');
      root.id = BACKDROP_ID;
      root.className = 'sauce-popup__backdrop';
      root.innerHTML = `
        <div class="sauce-popup__card" role="alertdialog" aria-modal="true">
          <div class="sauce-popup__title">${escape(title)}</div>
          ${body ? `<p class="sauce-popup__body">${escape(body)}</p>` : ''}
          <div class="sauce-popup__actions sauce-popup__actions--single">
            <button class="sauce-popup__btn sauce-popup__btn--primary" data-action="ok">${escape(label)}</button>
          </div>
        </div>
      `;
      root.addEventListener('click', (ev) => {
        if (ev.target === root) { dismiss(); resolve(); }
      });
      const okBtn = root.querySelector('[data-action="ok"]');
      if (okBtn) okBtn.addEventListener('click', () => { dismiss(); resolve(); });
      document.body.appendChild(root);
      if (okBtn instanceof HTMLElement) okBtn.focus();
    });
  }

  function escape(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  window.SauceBossPopup = { confirm, alert, dismiss };
})();
