// ui/forms.js — shared create/edit modals for Trip and Stop.
// Kept here so both the trips list and the trip page open identical forms.
(function () {
  const esc = () => window.escapeHtml;

  // ── Trip form (create + edit) ───────────────────────────────────────────────
  function openTripForm({ trip, schemes, onSaved }) {
    const E = esc();
    const isEdit = !!trip;
    const list = schemes && schemes.length ? schemes : [{ slug: "alpine", name: "Alpine", palette: {} }];
    const current = (trip && trip.color_scheme) || list[0].slug;

    const options = list.map((s) =>
      `<option value="${E(s.slug)}" ${s.slug === current ? "selected" : ""}>${E(s.name)}</option>`).join("");

    const { root, close } = window.Modal.open({
      title: isEdit ? "Edit trip" : "New trip",
      bodyHTML: `
        <form id="trip-form" class="tg-form">
          <label class="tg-field">
            <span class="tg-field__label">Trip name</span>
            <input id="trip-name" class="input input-bordered w-full" value="${E(trip ? trip.name : "")}" placeholder="e.g. Slovenian Arrow" />
          </label>
          <label class="tg-field">
            <span class="tg-field__label">Short description</span>
            <textarea id="trip-desc" class="textarea textarea-bordered w-full" rows="2" placeholder="One or two lines about this trip">${E(trip ? (trip.description || "") : "")}</textarea>
          </label>
          <label class="tg-field">
            <span class="tg-field__label">Color scheme</span>
            <select id="trip-scheme" class="select select-bordered w-full">${options}</select>
            <div id="scheme-swatch" class="tg-swatch-row" aria-hidden="true"></div>
          </label>
          <p id="trip-err" class="tg-form-err hidden"></p>
        </form>`,
      footerHTML: `
        <button class="btn btn-ghost" data-cancel>Cancel</button>
        <button class="btn btn-primary" data-submit>${isEdit ? "Save" : "Create trip"}</button>`,
    });

    const nameEl = root.querySelector("#trip-name");
    const descEl = root.querySelector("#trip-desc");
    const schemeEl = root.querySelector("#trip-scheme");
    const swatchEl = root.querySelector("#scheme-swatch");
    const errEl = root.querySelector("#trip-err");
    nameEl.focus();

    function paintSwatch() {
      const s = list.find((x) => x.slug === schemeEl.value);
      const p = (s && s.palette) || {};
      const keys = ["primary", "accent", "surface", "bg", "muted"];
      swatchEl.innerHTML = keys
        .filter((k) => p[k])
        .map((k) => `<span class="tg-swatch" style="background:${E()(p[k])}" title="${k}"></span>`)
        .join("");
    }
    schemeEl.addEventListener("change", paintSwatch);
    paintSwatch();

    async function submit() {
      const name = nameEl.value.trim();
      if (!name) { errEl.textContent = "Please enter a trip name."; errEl.classList.remove("hidden"); nameEl.focus(); return; }
      const body = { name, description: descEl.value.trim() || null, color_scheme: schemeEl.value };
      const btn = root.querySelector("[data-submit]");
      btn.disabled = true; btn.classList.add("loading");
      try {
        const result = isEdit ? await window.api.updateTrip(trip.id, body) : await window.api.createTrip(body);
        close();
        window.toast(isEdit ? "Trip updated" : "Trip created", "success");
        onSaved && onSaved(result);
      } catch (err) {
        errEl.textContent = err.message || "Could not save trip.";
        errEl.classList.remove("hidden");
        btn.disabled = false; btn.classList.remove("loading");
      }
    }
    root.querySelector("[data-submit]").addEventListener("click", submit);
    root.querySelector("[data-cancel]").addEventListener("click", close);
    root.querySelector("#trip-form").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  }

  // ── Stop form (create + edit) with live HTML preview ────────────────────────
  function openStopForm({ tripId, stop, onSaved }) {
    const E = esc();
    const isEdit = !!stop;

    const { root, close } = window.Modal.open({
      wide: true,
      title: isEdit ? "Edit stop" : "Add stop",
      bodyHTML: `
        <form id="stop-form" class="tg-form">
          <div class="tg-form__row">
            <label class="tg-field tg-field--grow">
              <span class="tg-field__label">Stop name</span>
              <input id="stop-name" class="input input-bordered w-full" value="${E(stop ? stop.name : "")}" placeholder="e.g. Lake Bled" />
            </label>
          </div>
          <label class="tg-field">
            <span class="tg-field__label">Quick description</span>
            <input id="stop-desc" class="input input-bordered w-full" value="${E(stop ? (stop.description || "") : "")}" placeholder="One line shown under the name" />
          </label>
          <div class="tg-editor">
            <label class="tg-field tg-editor__pane">
              <span class="tg-field__label">HTML content</span>
              <textarea id="stop-html" class="textarea textarea-bordered tg-editor__code" rows="12" placeholder="&lt;p&gt;Write the stop's content as HTML…&lt;/p&gt;">${E(stop ? (stop.content_html || "") : "")}</textarea>
            </label>
            <div class="tg-editor__pane">
              <span class="tg-field__label">Live preview</span>
              <div id="stop-preview" class="tg-editor__preview tg-html"></div>
            </div>
          </div>
          <p id="stop-err" class="tg-form-err hidden"></p>
        </form>`,
      footerHTML: `
        <button class="btn btn-ghost" data-cancel>Cancel</button>
        <button class="btn btn-primary" data-submit>${isEdit ? "Save" : "Add stop"}</button>`,
    });

    const nameEl = root.querySelector("#stop-name");
    const descEl = root.querySelector("#stop-desc");
    const htmlEl = root.querySelector("#stop-html");
    const previewEl = root.querySelector("#stop-preview");
    const errEl = root.querySelector("#stop-err");
    nameEl.focus();

    function paintPreview() {
      previewEl.innerHTML = htmlEl.value || `<p class="tg-editor__empty">Preview appears here as you type.</p>`;
    }
    htmlEl.addEventListener("input", paintPreview);
    paintPreview();

    async function submit() {
      const name = nameEl.value.trim();
      if (!name) { errEl.textContent = "Please enter a stop name."; errEl.classList.remove("hidden"); nameEl.focus(); return; }
      const body = { name, description: descEl.value.trim() || null, content_html: htmlEl.value };
      const btn = root.querySelector("[data-submit]");
      btn.disabled = true; btn.classList.add("loading");
      try {
        const result = isEdit ? await window.api.updateStop(stop.id, body) : await window.api.createStop(tripId, body);
        close();
        window.toast(isEdit ? "Stop updated" : "Stop added", "success");
        onSaved && onSaved(result);
      } catch (err) {
        errEl.textContent = err.message || "Could not save stop.";
        errEl.classList.remove("hidden");
        btn.disabled = false; btn.classList.remove("loading");
      }
    }
    root.querySelector("[data-submit]").addEventListener("click", submit);
    root.querySelector("[data-cancel]").addEventListener("click", close);
    root.querySelector("#stop-form").addEventListener("submit", (e) => {
      // Enter inside the textarea should insert a newline, not submit.
      if (e.target && e.target.id === "stop-html") return;
      e.preventDefault(); submit();
    });
  }

  window.Forms = { openTripForm, openStopForm };
})();
