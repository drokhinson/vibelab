// views/trips-view.js — home screen: the list of trips.
(function () {
  class TripsView extends window.View {
    constructor() {
      super("home");
      this.trips = null;
      this.schemes = [];
      this.error = null;
      this._bound = false;
    }

    async onMount() {
      this.error = null;
      try {
        const [trips, schemes] = await Promise.all([
          window.api.listTrips(),
          window.api.listColorSchemes(),
        ]);
        this.trips = trips;
        this.schemes = schemes || [];
        window.__tgSchemes = this.schemes; // shared with forms
      } catch (err) {
        this.error = err.message || "Could not load trips.";
      }
    }

    _schemeMap() {
      const m = {};
      for (const s of this.schemes) m[s.slug] = s.palette || {};
      return m;
    }

    renderLoading() {
      this.container.innerHTML = `<div class="tg-loading"><span class="loading loading-spinner loading-lg"></span></div>`;
    }

    render() {
      const isAdmin = window.Admin.isAdmin();
      const c = this.container;

      if (this.error) {
        c.innerHTML = `
          <div class="tg-page">
            <div class="tg-error">
              <p>${window.escapeHtml(this.error)}</p>
              <button class="btn btn-sm btn-primary" data-retry>Try again</button>
            </div>
          </div>`;
        c.querySelector("[data-retry]").addEventListener("click", () => this._reload());
        this.refreshIcons();
        return;
      }

      const trips = this.trips || [];
      const map = this._schemeMap();

      const toolbar = `
        <div class="tg-page__head">
          <div>
            <h1 class="tg-page__title">Trips</h1>
            <p class="tg-page__subtitle">Guided routes, one stop at a time.</p>
          </div>
          ${isAdmin ? `<button class="btn btn-primary btn-sm" data-new-trip><i data-lucide="plus"></i>New trip</button>` : ""}
        </div>`;

      let listHTML;
      if (!trips.length) {
        listHTML = `
          <div class="tg-empty">
            <img src="assets/illustrations/trip-guide-empty.svg" alt="" class="tg-empty__art" />
            <h2 class="tg-empty__title">No trips yet</h2>
            <p class="tg-empty__text">${isAdmin ? "Create your first trip to get started." : "Check back soon — trips are on the way."}</p>
            ${isAdmin ? `<button class="btn btn-primary btn-sm" data-new-trip><i data-lucide="plus"></i>Create a trip</button>` : ""}
          </div>`;
      } else {
        listHTML = `<div class="tg-trip-grid">${
          trips.map((t, i) => `<div class="tg-fade" style="--i:${i}">${window.renderTripCard(t, { palette: map[t.color_scheme], isAdmin })}</div>`).join("")
        }</div>`;
      }

      c.innerHTML = `<div class="tg-page">${toolbar}${listHTML}</div>`;
      this._bind();
      this.refreshIcons();
    }

    _bind() {
      const c = this.container;
      c.querySelectorAll("[data-new-trip]").forEach((b) =>
        b.addEventListener("click", () => this._openNew()));

      c.addEventListener("click", (e) => {
        const editBtn = e.target.closest("[data-edit-trip]");
        if (editBtn) { e.stopPropagation(); this._openEdit(editBtn.dataset.editTrip); return; }
        const delBtn = e.target.closest("[data-delete-trip]");
        if (delBtn) { e.stopPropagation(); this._delete(delBtn.dataset.deleteTrip); return; }
        const card = e.target.closest(".tg-trip-card");
        if (card && card.dataset.tripId) window.router.go("trip", { id: card.dataset.tripId });
      });
    }

    _openNew() {
      window.Forms.openTripForm({ schemes: this.schemes, onSaved: () => this._reload() });
    }

    _openEdit(tripId) {
      const trip = (this.trips || []).find((t) => t.id === tripId);
      if (!trip) return;
      window.Forms.openTripForm({ trip, schemes: this.schemes, onSaved: () => this._reload() });
    }

    async _delete(tripId) {
      const trip = (this.trips || []).find((t) => t.id === tripId);
      const name = trip ? `"${trip.name}"` : "this trip";
      if (!window.confirm(`Delete ${name} and all its stops? This cannot be undone.`)) return;
      try {
        await window.api.deleteTrip(tripId);
        window.toast("Trip deleted", "success");
        this._reload();
      } catch (err) {
        window.toast(err.message || "Could not delete trip", "error");
      }
    }

    async _reload() {
      await this.onMount();
      this.render();
    }
  }

  window.TripsView = TripsView;
})();
