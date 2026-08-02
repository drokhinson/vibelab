// admin.js — shared API client + admin-key handling for the person travel
// section. Loaded on both about.html and trip.html, before the page module.
//
// Admin access uses the shared ADMIN_API_KEY (backend auth.py require_admin).
// The key is held in sessionStorage (clears on tab close) and sent as a Bearer
// header on write requests. Enter admin mode by visiting the page with ?admin
// in the query string — that prompts for the key and validates it.
(function () {
  "use strict";

  var API = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || "http://localhost:8000";
  var BASE = "/api/v1/person";
  var STORAGE_KEY = "person_admin_key";
  var EDIT_KEY = "person_edit_mode";
  var changeListeners = [];

  // ── Key storage ─────────────────────────────────────────────────────────
  function getKey() { return sessionStorage.getItem(STORAGE_KEY); }
  function setKey(k) { sessionStorage.setItem(STORAGE_KEY, k); }
  function clearKey() { sessionStorage.removeItem(STORAGE_KEY); }
  function hasKey() { return !!getKey(); }

  // ── Edit mode ─────────────────────────────────────────────────────────────
  // "Logged in" (a valid key is held) is separate from "edit mode" (admin
  // controls are visible). Once logged in, the pencil flips edit mode on/off
  // without a re-prompt; only Sign out (or closing the tab) drops the key.
  function editMode() { return hasKey() && sessionStorage.getItem(EDIT_KEY) === "1"; }
  function setEditMode(on) {
    if (on) sessionStorage.setItem(EDIT_KEY, "1");
    else sessionStorage.removeItem(EDIT_KEY);
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
    sessionStorage.removeItem(EDIT_KEY);
    notifyChange();
  }

  function onChange(cb) { if (typeof cb === "function") changeListeners.push(cb); }

  // ── Header pencil button + "Logged in / Editing" status chip ───────────────
  // Shared across about.html and trip.html. Wires the pencil to toggleEdit and
  // keeps a small status chip (inserted before the button) in sync with state.
  function wireLoginButton(btn) {
    if (!btn) return;
    var status = document.createElement("span");
    status.className = "pa-admin-status";
    status.hidden = true;
    btn.parentNode.insertBefore(status, btn);

    function render() {
      var editing = isAdmin();
      var loggedIn = hasKey();
      var label = !loggedIn
        ? "Edit — admin login"
        : editing
          ? "Editing — click to stop editing"
          : "Logged in — click to edit";
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.classList.toggle("pa-admin-login--active", editing);
      status.hidden = !loggedIn;
      status.textContent = editing ? "Editing" : "Logged in";
      status.classList.toggle("pa-admin-status--editing", editing);
    }

    btn.addEventListener("click", function () { toggleEdit(); });
    onChange(render);
    render();
  }

  // ── Generic admin form modal ──────────────────────────────────────────────
  // opts: { title, submitLabel, fields: [{name,label,type,required,rows,placeholder}], values }
  // type ∈ text | url | number | textarea | checkbox. Resolves collected values
  // (numbers/checkboxes coerced) on submit, or null on cancel/backdrop/Escape.
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
        '<form class="pa-modal__body">' + fieldsHtml +
        '<div class="pa-modal__err" hidden></div>' +
        '<div class="pa-modal__actions">' +
        '<button type="button" class="pa-btn pa-btn--ghost pa-cancel">Cancel</button>' +
        '<button type="submit" class="pa-btn pa-btn--primary pa-submit">' +
        esc(opts.submitLabel || "Save") + "</button></div></form></div>";

      function close(result) {
        document.removeEventListener("keydown", onKey);
        if (root.parentNode) root.parentNode.removeChild(root);
        resolve(result);
      }
      function onKey(ev) { if (ev.key === "Escape") close(null); }

      root.addEventListener("click", function (ev) { if (ev.target === root) close(null); });
      document.addEventListener("keydown", onKey);
      document.body.appendChild(root);
      root.querySelector(".pa-modal__x").addEventListener("click", function () { close(null); });
      root.querySelector(".pa-cancel").addEventListener("click", function () { close(null); });

      var form = root.querySelector("form");
      var errEl = root.querySelector(".pa-modal__err");

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

      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
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
        close(out);
      });
      var first = root.querySelector("input, textarea");
      if (first) first.focus();
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
