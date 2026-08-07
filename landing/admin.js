// admin.js — shared API client + admin-key handling for the person travel
// section. Loaded on both about.html and trip.html, before the page module.
//
// Admin access uses the shared ADMIN_API_KEY (backend auth.py require_admin).
// The key is held in localStorage (persists across browser sessions) and sent
// as a Bearer header on write requests. Enter admin mode by visiting the page
// with ?admin in the query string — that prompts for the key and validates it.
(function () {
  "use strict";

  var API = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || "http://localhost:8000";
  var BASE = "/api/v1/person";
  var STORAGE_KEY = "person_admin_key";
  var EDIT_KEY = "person_edit_mode";
  var changeListeners = [];

  // Admin login persists across browser sessions: the key + edit-mode flag live
  // in localStorage (not sessionStorage), so closing the tab or browser no
  // longer logs you out. The backend key never expires, so a stored key keeps
  // working until Sign out or a rejected key (401/403). Migrate any key left in
  // sessionStorage by an older build so existing logins carry over seamlessly.
  var store = window.localStorage;
  try {
    var legacy = window.sessionStorage.getItem(STORAGE_KEY);
    if (legacy && !store.getItem(STORAGE_KEY)) {
      store.setItem(STORAGE_KEY, legacy);
      if (window.sessionStorage.getItem(EDIT_KEY) === "1") store.setItem(EDIT_KEY, "1");
    }
    window.sessionStorage.removeItem(STORAGE_KEY);
    window.sessionStorage.removeItem(EDIT_KEY);
  } catch (_) {}

  // ── Key storage ─────────────────────────────────────────────────────────
  function getKey() { return store.getItem(STORAGE_KEY); }
  function setKey(k) { store.setItem(STORAGE_KEY, k); }
  function clearKey() { store.removeItem(STORAGE_KEY); }
  function hasKey() { return !!getKey(); }

  // ── Edit mode ─────────────────────────────────────────────────────────────
  // "Logged in" (a valid key is held) is separate from "edit mode" (admin
  // controls are visible). Once logged in, the pencil flips edit mode on/off
  // without a re-prompt; only Sign out (or closing the tab) drops the key.
  function editMode() { return hasKey() && store.getItem(EDIT_KEY) === "1"; }
  function setEditMode(on) {
    if (on) store.setItem(EDIT_KEY, "1");
    else store.removeItem(EDIT_KEY);
    notifyChange();
  }
  // Admin controls show only when logged in AND edit mode is on.
  function isAdmin() { return hasKey() && editMode(); }

  // Pencil handler: prompt for the key the first time, then toggle edit mode.
  async function toggleEdit() {
    if (hasKey()) { setEditMode(!editMode()); return; }
    var ok = await promptForKey();
    if (ok) setEditMode(true);
  }

  function notifyChange() {
    changeListeners.forEach(function (cb) {
      try { cb(hasKey()); } catch (_) {}
    });
  }

  // ── Escaping (text + attribute contexts) ─────────────────────────────────
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function escAttr(s) { return esc(s); }

  // ── Fetch helpers ─────────────────────────────────────────────────────────
  async function publicFetch(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    var res = await fetch(API + BASE + path, Object.assign({}, opts, { headers: headers }));
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.detail || ("HTTP " + res.status));
    return data;
  }

  async function adminFetch(path, opts) {
    opts = opts || {};
    var key = getKey();
    var headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (key) headers["Authorization"] = "Bearer " + key;
    var res = await fetch(API + BASE + path, Object.assign({}, opts, { headers: headers }));
    if (res.status === 401 || res.status === 403) {
      clearKey();
      notifyChange();
      throw new Error("Admin key rejected — please sign in again.");
    }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.detail || ("HTTP " + res.status));
    return data;
  }

  // ── Admin session ─────────────────────────────────────────────────────────
  // Prompt for the key, validate it against /admin/verify, store on success.
  async function promptForKey() {
    var key = window.prompt("Enter admin key:");
    if (!key) return false;
    setKey(key.trim());
    try {
      await adminFetch("/admin/verify");
      notifyChange();
      return true;
    } catch (err) {
      // Clear the key so a wrong key OR an unreachable backend doesn't leave a
      // stale login state (adminFetch already clears on 401/403; this also
      // covers network/CORS failures).
      clearKey();
      notifyChange();
      window.alert("Couldn't verify admin key — wrong key or the backend isn't reachable.");
      return false;
    }
  }

  function signOut() {
    clearKey();
    store.removeItem(EDIT_KEY);
    notifyChange();
  }

  function onChange(cb) { if (typeof cb === "function") changeListeners.push(cb); }

  // ── Header pencil button ───────────────────────────────────────────────────
  // Wires the pencil to toggleEdit. The pencil is the whole affordance: it
  // prompts for the key when there isn't one, and goes gold while editing —
  // no standing "Logged in" chip, the button's own state says it.
  function wireLoginButton(btn) {
    if (!btn) return;

    function render() {
      var editing = isAdmin();
      var label = !hasKey()
        ? "Edit — admin login"
        : editing
          ? "Editing — click to stop editing"
          : "Logged in — click to edit";
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.classList.toggle("pa-admin-login--active", editing);
    }

    btn.addEventListener("click", function () { toggleEdit(); });
    onChange(render);
    render();
  }

  // ── Generic admin form modal ──────────────────────────────────────────────
  // opts: { title, submitLabel, savingLabel, onSubmit, fields: [{name,label,type,required,rows,placeholder}], values }
  // type ∈ text | url | number | textarea | checkbox. Resolves collected values
  // (numbers/checkboxes coerced) on submit, or null on cancel/backdrop/Escape.
  //
  // onSubmit(values) → Promise: opt-in "save before you close" mode. The modal
  // stays mounted while the promise is pending, shows a spinner on the submit
  // button, and freezes every dismissal path — so the caller can finish its
  // request (and update its own state) before the user is handed back to the
  // page. A rejection keeps the modal open with the input intact and the reason
  // in the error strip, so a failed save is retryable instead of retyped.
  // Without onSubmit the modal closes the instant it validates, as it always has.
  function formModal(opts) {
    opts = opts || {};
    var fields = opts.fields || [];
    var values = opts.values || {};
    return new Promise(function (resolve) {
      var root = document.createElement("div");
      root.className = "pa-modal__backdrop";

      var fieldsHtml = fields.map(function (f) {
        var v = values[f.name];
        var id = "pa-f-" + f.name;
        var labelHtml = '<label class="pa-field__label" for="' + id + '">' +
          esc(f.label) + (f.required ? ' <span class="pa-req">*</span>' : "") + "</label>";
        if (f.type === "checkbox") {
          return '<div class="pa-field pa-field--check">' +
            '<label class="pa-field__label" for="' + id + '">' +
            '<input id="' + id + '" data-name="' + escAttr(f.name) + '" type="checkbox" ' +
            (v ? "checked" : "") + " /> " + esc(f.label) + "</label></div>";
        }
        if (f.type === "htmleditor") {
          return '<div class="pa-field">' + labelHtml +
            '<div class="hse-mount" data-name="' + escAttr(f.name) + '"></div></div>';
        }
        // A fixed option set: f.options is [{ value, label }]. A select always
        // has a value, so it never takes the "blank input → null" path in the
        // submit collector below.
        if (f.type === "select") {
          var opts = (f.options || []).map(function (o) {
            return '<option value="' + escAttr(o.value) + '"' +
              (String(v) === String(o.value) ? " selected" : "") + ">" +
              esc(o.label) + "</option>";
          }).join("");
          return '<div class="pa-field">' + labelHtml +
            '<select id="' + id + '" data-name="' + escAttr(f.name) + '">' +
            opts + "</select></div>";
        }
        if (f.type === "textarea") {
          var importHtml = f.importFile
            ? '<div class="pa-import">' +
                '<label class="pa-btn pa-btn--ghost pa-btn--sm pa-import__btn">Load file' +
                  '<input type="file" accept="' + escAttr(f.importAccept || ".html,text/html,.htm") +
                  '" data-import-for="' + escAttr(f.name) + '" hidden /></label>' +
                '<span class="pa-import__name"></span>' +
              "</div>"
            : "";
          return '<div class="pa-field">' + labelHtml + importHtml +
            '<textarea id="' + id + '" data-name="' + escAttr(f.name) + '" rows="' +
            (f.rows || 4) + '" placeholder="' + escAttr(f.placeholder || "") + '">' +
            esc(v == null ? "" : v) + "</textarea></div>";
        }
        var inputType = f.type === "number" ? "number" : (f.type === "url" ? "url" : "text");
        return '<div class="pa-field">' + labelHtml +
          '<input id="' + id + '" data-name="' + escAttr(f.name) + '" type="' + inputType +
          '" placeholder="' + escAttr(f.placeholder || "") + '" value="' +
          escAttr(v == null ? "" : v) + '" /></div>';
      }).join("");

      root.innerHTML =
        '<div class="pa-modal" role="dialog" aria-modal="true">' +
        '<div class="pa-modal__head"><span class="pa-modal__title">' + esc(opts.title || "Edit") +
        '</span><button class="pa-modal__x" aria-label="Close">&times;</button></div>' +
        '<form class="pa-modal__form">' +
        '<div class="pa-modal__body">' + fieldsHtml + "</div>" +
        '<div class="pa-modal__err" hidden></div>' +
        '<div class="pa-modal__actions">' +
        '<button type="button" class="pa-btn pa-btn--ghost pa-cancel">Cancel</button>' +
        '<button type="submit" class="pa-btn pa-btn--primary pa-submit">' +
        esc(opts.submitLabel || "Save") + "</button></div></form></div>";

      // Keep the backdrop matched to the viewport actually on screen. iOS Safari
      // overlays the software keyboard without shrinking the layout viewport, so
      // even a 100dvh fixed backdrop extends behind it and takes the pinned
      // actions row with it. visualViewport is the only thing that reports the
      // visible box; offsetTop covers the page being scrolled within it.
      var vv = window.visualViewport;
      function syncViewport() {
        root.style.setProperty("--pa-vv-h", vv.height + "px");
        root.style.transform = "translateY(" + (vv.offsetTop || 0) + "px)";
      }

      // True while an onSubmit promise is in flight. Every dismissal path checks
      // it: walking away mid-save would leave the request racing a page the user
      // has already moved on from.
      var saving = false;

      function close(result) {
        if (saving) return;
        document.removeEventListener("keydown", onKey);
        if (vv) {
          vv.removeEventListener("resize", syncViewport);
          vv.removeEventListener("scroll", syncViewport);
        }
        if (root.parentNode) root.parentNode.removeChild(root);
        resolve(result);
      }
      function onKey(ev) { if (ev.key === "Escape") close(null); }

      root.addEventListener("click", function (ev) { if (ev.target === root) close(null); });
      document.addEventListener("keydown", onKey);
      document.body.appendChild(root);
      if (vv) {
        vv.addEventListener("resize", syncViewport);
        vv.addEventListener("scroll", syncViewport);
        syncViewport();
      }
      var dialog = root.querySelector(".pa-modal");
      var closeBtn = root.querySelector(".pa-modal__x");
      var cancelBtn = root.querySelector(".pa-cancel");
      var submitBtn = root.querySelector(".pa-submit");
      var submitHtml = submitBtn.innerHTML;
      closeBtn.addEventListener("click", function () { close(null); });
      cancelBtn.addEventListener("click", function () { close(null); });

      var form = root.querySelector("form");
      var errEl = root.querySelector(".pa-modal__err");

      function setBusy(on) {
        saving = on;
        // Drops the software keyboard on mobile, so the saving state is what's
        // on screen rather than a keyboard over a frozen form.
        if (on && document.activeElement && document.activeElement.blur) document.activeElement.blur();
        root.classList.toggle("pa-modal--busy", on);
        dialog.setAttribute("aria-busy", on ? "true" : "false");
        submitBtn.disabled = on;
        cancelBtn.disabled = on;
        closeBtn.disabled = on;
        submitBtn.innerHTML = on
          ? '<span class="pa-spin" aria-hidden="true"></span>' + esc(opts.savingLabel || "Saving…")
          : submitHtml;
      }

      // The shell shrinks when the keyboard opens; pull whatever just took focus
      // back into the scroller. Covers the contenteditable block fields too.
      form.addEventListener("focusin", function (ev) {
        if (ev.target && ev.target.scrollIntoView) {
          ev.target.scrollIntoView({ block: "nearest" });
        }
      });

      // Wire "Load file" inputs: read the picked file's text into its textarea.
      form.querySelectorAll("input[type=file][data-import-for]").forEach(function (inp) {
        inp.addEventListener("change", function () {
          var file = inp.files && inp.files[0];
          if (!file) return;
          var reader = new FileReader();
          reader.onload = function () {
            var ta = form.querySelector('[data-name="' + inp.getAttribute("data-import-for") + '"]');
            if (ta) ta.value = String(reader.result || "");
            var wrap = inp.closest(".pa-import");
            var nameEl = wrap && wrap.querySelector(".pa-import__name");
            if (nameEl) nameEl.textContent = file.name;
          };
          reader.onerror = function () { window.alert("Could not read that file."); };
          reader.readAsText(file);
        });
      });

      // Instantiate rich HTML editors for any htmleditor fields.
      var editors = {};
      fields.forEach(function (f) {
        if (f.type === "htmleditor" && window.HtmlSpanEditor) {
          var mountEl = form.querySelector('.hse-mount[data-name="' + f.name + '"]');
          if (mountEl) editors[f.name] = window.HtmlSpanEditor.create(mountEl, values[f.name] || "");
        }
      });

      form.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        if (saving) return;
        var out = {};
        for (var i = 0; i < fields.length; i++) {
          var f = fields[i];
          if (f.type === "htmleditor") {
            var ed = editors[f.name];
            if (f.required && ed && !ed.hasContent()) {
              errEl.textContent = f.label + " is required.";
              errEl.hidden = false;
              return;
            }
            out[f.name] = ed ? ed.getHTML() : "";
            continue;
          }
          var el = form.querySelector('[data-name="' + f.name + '"]');
          if (!el) continue;
          if (f.type === "checkbox") { out[f.name] = el.checked; continue; }
          var val = el.value.trim();
          if (f.required && !val) {
            errEl.textContent = f.label + " is required.";
            errEl.hidden = false;
            el.focus();
            return;
          }
          if (f.type === "number") { out[f.name] = val === "" ? null : Number(val); }
          else { out[f.name] = val === "" ? null : val; }
        }
        if (!opts.onSubmit) { close(out); return; }
        errEl.hidden = true;
        setBusy(true);
        try {
          await opts.onSubmit(out);
        } catch (err) {
          // Stay open with everything the user typed still in the fields.
          setBusy(false);
          errEl.textContent = (err && err.message) || "Something went wrong. Try again.";
          errEl.hidden = false;
          return;
        }
        setBusy(false);
        close(out);
      });
      // Deliberately no autofocus: focusing the first field opens the software
      // keyboard the instant the modal appears, which covers most of the form
      // before you've even seen it. Tap the field you actually want.
    });
  }

  // On load: if the URL asks for admin and we don't yet have a key, prompt.
  async function init() {
    var params = new URLSearchParams(window.location.search);
    if (params.has("admin") && !hasKey()) {
      if (await promptForKey()) setEditMode(true);
    } else if (hasKey()) {
      // Re-validate a carried-over key silently; drop it if stale.
      try { await adminFetch("/admin/verify"); } catch (_) {}
      notifyChange();
    }
  }

  window.PersonAdmin = {
    apiBase: API,
    hasKey: hasKey,
    editMode: editMode,
    isAdmin: isAdmin,
    toggleEdit: toggleEdit,
    wireLoginButton: wireLoginButton,
    publicFetch: publicFetch,
    adminFetch: adminFetch,
    promptForKey: promptForKey,
    signOut: signOut,
    onChange: onChange,
    init: init,
    esc: esc,
    escAttr: escAttr,
    formModal: formModal,
  };

  document.addEventListener("DOMContentLoaded", init);
})();
