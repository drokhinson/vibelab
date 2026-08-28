// @ts-check
//
// widgets/outbox-modal.js — the one surface for the offline upload queue.
//
// Reuses the polaroid-popup backdrop + card chrome for visual consistency (per
// .claude/rules/ui-object-design.md §3c) but owns its own .outbox-modal* body
// classes, because PolaroidPopup.show() is a fixed-shape wrap-up card with no
// children slot or scroller and extending it would bloat it.
//
// Opened from two places — the global header indicator and Settings — which is
// the point: before this, the Play tab and Settings each had their own
// rendering of the same queue.

(function () {
  const BACKDROP_ID = "bgb-outbox-modal";

  let _previousFocus = null;
  let _escHandler = null;
  let _busy = false;
  let _unsub = null;

  function dismiss() {
    const el = document.getElementById(BACKDROP_ID);
    if (el) el.remove();
    if (_escHandler) {
      document.removeEventListener("keydown", _escHandler);
      _escHandler = null;
    }
    if (_unsub) {
      _unsub();
      _unsub = null;
    }
    if (_previousFocus && _previousFocus.focus) {
      try { _previousFocus.focus(); } catch (_) {}
    }
    _previousFocus = null;
  }

  function fmtWhen(entry) {
    const raw = (entry.payload && entry.payload.played_at) || "";
    if (!raw) return "";
    // played_at is a YYYY-MM-DD string, not a timestamp — formatDate handles it.
    return window.formatDate ? window.formatDate(raw) : raw;
  }

  function fmtPlayers(entry) {
    const players = (entry.payload && entry.payload.players) || [];
    const names = players.map((p) => p && p.name).filter(Boolean);
    if (!names.length) return "";
    return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
  }

  /**
   * @param {any} entry
   * @param {boolean} isActive true for the entry the serial flush is on now
   */
  function renderRow(entry, isActive) {
    const snap = entry.gameSnapshot || {};
    // An offline-queued play never carries a photo (play-session.js never
    // persists the blob), so the game thumbnail is the only art available.
    const art = snap.thumbnail_url || "";
    const name = snap.name || "Unknown game";
    const failed = entry.state === "failed";
    const meta = [fmtPlayers(entry), fmtWhen(entry)].filter(Boolean).join(" · ");

    let status;
    if (failed) {
      status = `
        <span class="outbox-modal__chip outbox-modal__chip--failed">Failed</span>
        <button class="outbox-modal__act"
                onclick="window.OutboxModal._retry('${escapeAttr(entry.clientKey)}')">Retry</button>
        <button class="outbox-modal__act outbox-modal__act--quiet"
                aria-label="Remove ${escapeAttr(name)} from the queue"
                onclick="window.OutboxModal._remove('${escapeAttr(entry.clientKey)}')">Remove</button>`;
    } else if (isActive) {
      status = `<span class="outbox-modal__chip outbox-modal__chip--up">Uploading</span>`;
    } else {
      status = `<span class="outbox-modal__chip outbox-modal__chip--queued">Queued</span>`;
    }

    return `
      <div class="outbox-modal__row">
        ${art
          ? `<img class="outbox-modal__art" src="${escapeAttr(art)}" alt="" loading="lazy" />`
          : `<span class="outbox-modal__art outbox-modal__art--empty"></span>`}
        <span class="outbox-modal__body">
          <span class="outbox-modal__name">${escapeHtml(name)}</span>
          <span class="outbox-modal__meta">${escapeHtml(meta)}${
            failed && entry.lastError ? ` · ${escapeHtml(entry.lastError)}` : ""}</span>
        </span>
        ${status}
      </div>
    `;
  }

  function renderBody() {
    const entries = window.Outbox ? window.Outbox.list() : [];
    if (!entries.length) {
      return `<p class="outbox-modal__empty">Nothing waiting. Every play you've logged is on the server.</p>`;
    }
    const flushing = window.Outbox.isFlushing();
    // The flush is strictly serial and takes the oldest non-failed entry, so
    // that entry is the one in flight while a flush is running.
    const activeKey = flushing
      ? (entries.find((e) => e.state !== "failed") || {}).clientKey
      : null;
    return entries.map((e) => renderRow(e, e.clientKey === activeKey)).join("");
  }

  function repaint() {
    const root = document.getElementById(BACKDROP_ID);
    if (!root) return;
    const body = root.querySelector(".outbox-modal__list");
    if (body) body.innerHTML = renderBody();
    const foot = root.querySelector(".outbox-modal__actions");
    if (foot) foot.innerHTML = renderActions();
    if (window.lucide) window.lucide.createIcons({ root });
  }

  function renderActions() {
    const offline = !!(window.BgbNet && window.BgbNet.isOffline());
    const pending = window.Outbox ? window.Outbox.pendingCount() : 0;
    const upload = (offline || !pending)
      ? ""
      : `<button class="btn btn-primary btn-sm" ${_busy ? "disabled" : ""}
                 onclick="window.OutboxModal._upload()">${_busy ? "Uploading…" : "Upload now"}</button>`;
    return `
      <button class="btn btn-ghost btn-sm" onclick="window.OutboxModal.dismiss()">Close</button>
      ${upload}
    `;
  }

  function open() {
    dismiss(); // singleton — never stack two
    _previousFocus = document.activeElement;
    const offline = !!(window.BgbNet && window.BgbNet.isOffline());

    const root = document.createElement("div");
    root.id = BACKDROP_ID;
    root.className = "polaroid-popup__backdrop";
    root.innerHTML = `
      <div class="polaroid-popup__card polaroid-popup__card--confirm outbox-modal"
           role="dialog" aria-modal="true" aria-label="Waiting to upload">
        <button class="polaroid-popup__close" aria-label="Close">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
        <div class="polaroid-popup__title">Waiting to upload</div>
        <p class="outbox-modal__hint">${offline
          ? "Saved on this device. They'll go up as soon as you're back online."
          : "Saved on this device until the server confirms them."}</p>
        <div class="outbox-modal__list">${renderBody()}</div>
        <div class="outbox-modal__actions">${renderActions()}</div>
      </div>
    `;
    root.addEventListener("click", (ev) => {
      if (ev.target === root) dismiss();
    });
    document.body.appendChild(root);
    if (window.lucide) window.lucide.createIcons({ root });

    const closeBtn = root.querySelector(".polaroid-popup__close");
    if (closeBtn) closeBtn.addEventListener("click", () => dismiss());

    _escHandler = (ev) => { if (ev.key === "Escape") dismiss(); };
    document.addEventListener("keydown", _escHandler);

    // outboxCount only fires on a net change, and a queued→failed flip leaves
    // the total identical — so repaint off the store AND after every action.
    if (window.store) {
      const a = window.store.subscribe("outboxCount", repaint);
      const b = window.store.subscribe("offline", repaint);
      _unsub = () => { a && a(); b && b(); };
    }
  }

  async function _upload() {
    if (_busy) return;
    _busy = true;
    repaint();
    try {
      const res = await window.Outbox.flush();
      if (res.sent > 0 && window.showToast) {
        window.showToast(`Uploaded ${res.sent} ${res.sent === 1 ? "play" : "plays"}.`, "success");
      } else if (res.remaining > 0 && window.showToast) {
        window.showToast("Still can't reach the server — they're safe on this device.", "error");
      }
    } finally {
      _busy = false;
      repaint();
    }
  }

  /**
   * A "failed" entry is one the server rejected outright, so the flush skips
   * it rather than wedging the queue. Clearing the flag puts it back in line.
   */
  async function _retry(clientKey) {
    if (!window.Outbox || !window.Outbox.requeue) return;
    window.Outbox.requeue(clientKey);
    repaint();
    await _upload();
  }

  async function _remove(clientKey) {
    const entry = (window.Outbox.list() || []).find((e) => e.clientKey === clientKey);
    const name = (entry && entry.gameSnapshot && entry.gameSnapshot.name) || "this play";
    const ok = await window.PolaroidPopup.confirm({
      title: "Remove this play?",
      body: `${name} has never reached the server. Removing it here deletes it for good — there is no copy anywhere else.`,
      confirmLabel: "Remove",
      cancelLabel: "Keep it",
    });
    if (!ok) return;
    window.Outbox.remove(clientKey);
    repaint();
  }

  window.OutboxModal = { open, dismiss, _upload, _retry, _remove };
})();
