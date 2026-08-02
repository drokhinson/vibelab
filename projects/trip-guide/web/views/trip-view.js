// views/trip-view.js — a single trip: themed header + ordered stop cards.
// The trip's color scheme is applied as CSS vars on the view container, so the
// page and every stop card share the palette. Admin can add/edit/delete stops
// and drag to reorder (optimistic, with a sequence guard on the persist).
(function () {
  const PALETTE_KEYS = ["primary", "bg", "surface", "text", "accent", "muted"];

  class TripView extends window.View {
    constructor() {
      super("trip");
      this.trip = null;
      this.stops = [];
      this.error = null;
      this._seq = 0;
      this._dragId = null;
    }

    async onMount() {
      this.error = null;
      this.trip = null;
      const id = this.params.id;
      try {
        const [bundle, schemes] = await Promise.all([
          window.api.getTrip(id),
          window.__tgSchemes ? Promise.resolve(window.__tgSchemes) : window.api.listColorSchemes().catch(() => []),
        ]);
        this.trip = bundle;
        this.stops = bundle.stops || [];
        window.__tgSchemes = schemes || window.__tgSchemes || [];
        this._applyPalette(bundle.palette || {});
      } catch (err) {
        this.error = err.status === 404 ? "This trip could not be found." : (err.message || "Could not load this trip.");
      }
    }

    async onParamsChange() {
      // Re-entering /trip/:id with a different id — refetch.
      await this.onMount();
      this.render();
      this.refreshIcons();
    }

    onUnmount() {
      this._clearPalette();
    }

    _applyPalette(palette) {
      const el = this.container;
      PALETTE_KEYS.forEach((k) => { if (palette[k]) el.style.setProperty(`--tg-${k}`, palette[k]); });
      el.classList.add("tg-themed");
    }
    _clearPalette() {
      const el = this.container;
      PALETTE_KEYS.forEach((k) => el.style.removeProperty(`--tg-${k}`));
      el.classList.remove("tg-themed");
    }

    renderLoading() {
      this.container.innerHTML = `<div class="tg-loading"><span class="loading loading-spinner loading-lg"></span></div>`;
    }

    render() {
      const c = this.container;
      const isAdmin = window.Admin.isAdmin();

      if (this.error) {
        c.innerHTML = `
          <div class="tg-page">
            <button class="btn btn-sm btn-ghost tg-back" data-back><i data-lucide="arrow-left"></i>All trips</button>
            <div class="tg-error"><p>${window.escapeHtml(this.error)}</p></div>
          </div>`;
        c.querySelector("[data-back]").addEventListener("click", () => window.router.back());
        this.refreshIcons();
        return;
      }

      const t = this.trip;
      c.innerHTML = `
        <div class="tg-page tg-trip">
          <button class="btn btn-sm btn-ghost tg-back" data-back><i data-lucide="arrow-left"></i>All trips</button>
          <header class="tg-trip__hero">
            <div class="tg-trip__hero-main">
              <h1 class="tg-trip__title">${window.escapeHtml(t.name)}</h1>
              ${t.description ? `<p class="tg-trip__desc">${window.escapeHtml(t.description)}</p>` : ""}
            </div>
            ${isAdmin ? `<button class="btn btn-sm btn-ghost" data-edit-trip aria-label="Edit trip"><i data-lucide="settings"></i></button>` : ""}
          </header>
          ${isAdmin ? `<div class="tg-trip__adminbar"><button class="btn btn-primary btn-sm" data-add-stop><i data-lucide="plus"></i>Add stop</button><span class="tg-trip__hint">Drag stops to reorder</span></div>` : ""}
          <div id="stops-host"></div>
        </div>`;

      c.querySelector("[data-back]").addEventListener("click", () => window.router.back());
      const addBtn = c.querySelector("[data-add-stop]");
      if (addBtn) addBtn.addEventListener("click", () => this._openAddStop());
      const editBtn = c.querySelector("[data-edit-trip]");
      if (editBtn) editBtn.addEventListener("click", () => this._openEditTrip());

      this._renderStops();
      this.refreshIcons();
    }

    _renderStops() {
      const host = this.container.querySelector("#stops-host");
      if (!host) return;
      const isAdmin = window.Admin.isAdmin();

      if (!this.stops.length) {
        host.innerHTML = `
          <div class="tg-empty tg-empty--inline">
            <img src="assets/illustrations/trip-guide-empty.svg" alt="" class="tg-empty__art" />
            <p class="tg-empty__text">${isAdmin ? "No stops yet — add the first one." : "This trip has no stops yet."}</p>
          </div>`;
        this.refreshIcons(host);
        return;
      }

      host.innerHTML = `<div class="tg-stop-list">${
        this.stops.map((s, i) => `<div class="tg-fade" style="--i:${i}">${window.renderStopCard(s, { index: i, isAdmin })}</div>`).join("")
      }</div>`;

      this._bindStops(host);
      this.refreshIcons(host);
    }

    _bindStops(host) {
      const isAdmin = window.Admin.isAdmin();

      host.querySelectorAll("[data-edit-stop]").forEach((b) =>
        b.addEventListener("click", () => this._openEditStop(b.dataset.editStop)));
      host.querySelectorAll("[data-delete-stop]").forEach((b) =>
        b.addEventListener("click", () => this._deleteStop(b.dataset.deleteStop)));

      if (!isAdmin) return;

      host.querySelectorAll(".tg-stop-card").forEach((card) => {
        card.addEventListener("dragstart", (e) => {
          this._dragId = card.dataset.stopId;
          card.classList.add("tg-dragging");
          try { e.dataTransfer.effectAllowed = "move"; } catch (_) {}
        });
        card.addEventListener("dragend", () => {
          card.classList.remove("tg-dragging");
          this._commitReorder(host);
        });
      });

      const list = host.querySelector(".tg-stop-list");
      if (list) {
        list.addEventListener("dragover", (e) => {
          e.preventDefault();
          const dragging = list.querySelector(".tg-dragging");
          if (!dragging) return;
          const after = this._cardAfter(list, e.clientY);
          if (after == null) list.appendChild(dragging.parentElement);
          else list.insertBefore(dragging.parentElement, after);
        });
      }
    }

    // Returns the .tg-fade wrapper to insert before, based on cursor Y.
    _cardAfter(list, y) {
      const wrappers = [...list.querySelectorAll(".tg-fade")].filter(
        (w) => !w.querySelector(".tg-dragging"));
      let closest = { offset: -Infinity, element: null };
      for (const w of wrappers) {
        const box = w.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) closest = { offset, element: w };
      }
      return closest.element;
    }

    async _commitReorder(host) {
      const domIds = [...host.querySelectorAll(".tg-stop-card")].map((el) => el.dataset.stopId);
      const currentIds = this.stops.map((s) => s.id);
      if (domIds.join(",") === currentIds.join(",")) return; // no change

      // Optimistic: reorder local state + re-render (fixes numbering).
      const byId = Object.fromEntries(this.stops.map((s) => [s.id, s]));
      this.stops = domIds.map((id) => byId[id]).filter(Boolean);
      this._renderStops();

      const seq = ++this._seq;
      try {
        await window.api.reorderStops(this.trip.id, domIds);
        if (seq !== this._seq) return; // a newer reorder superseded this one
      } catch (err) {
        if (seq !== this._seq) return;
        window.toast(err.message || "Could not save order", "error");
        await this.onMount(); // rollback to server truth
        this._renderStops();
      }
    }

    _openAddStop() {
      window.Forms.openStopForm({
        tripId: this.trip.id,
        onSaved: (stop) => { this.stops.push(stop); this._renderStops(); },
      });
    }
    _openEditStop(stopId) {
      const stop = this.stops.find((s) => s.id === stopId);
      if (!stop) return;
      window.Forms.openStopForm({
        tripId: this.trip.id, stop,
        onSaved: (updated) => {
          const i = this.stops.findIndex((s) => s.id === stopId);
          if (i >= 0) this.stops[i] = updated;
          this._renderStops();
        },
      });
    }
    async _deleteStop(stopId) {
      const stop = this.stops.find((s) => s.id === stopId);
      const name = stop ? `"${stop.name}"` : "this stop";
      if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;
      try {
        await window.api.deleteStop(stopId);
        this.stops = this.stops.filter((s) => s.id !== stopId);
        this._renderStops();
        window.toast("Stop deleted", "success");
      } catch (err) {
        window.toast(err.message || "Could not delete stop", "error");
      }
    }

    _openEditTrip() {
      window.Forms.openTripForm({
        trip: this.trip,
        schemes: window.__tgSchemes || [],
        onSaved: async () => { await this.onMount(); this.render(); this.refreshIcons(); },
      });
    }
  }

  window.TripView = TripView;
})();
