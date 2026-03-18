// helpers.js — apiFetch, auth token, navigation, formatting

var API = window.APP_CONFIG?.apiBase ?? "http://localhost:8000";
var PREFIX = "/api/v1/plant_planner";
var app = document.getElementById("app");

async function apiFetch(path, opts = {}) {
  var headers = opts.headers || {};
  if (token) headers["Authorization"] = "Bearer " + token;
  if (opts.body && typeof opts.body === "object") {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  var res = await fetch(API + PREFIX + path, { ...opts, headers });
  if (!res.ok) {
    var err;
    try { err = (await res.json()).detail; } catch (_) { err = res.statusText; }
    throw new Error(err || "Request failed");
  }
  return res.json();
}

function showView(view) {
  // Dispose 3D scene when leaving builder
  if (currentView === "builder" && view !== "builder" && scene3DHandle) {
    dispose3DView(scene3DHandle);
    scene3DHandle = null;
  }
  currentView = view;
  render();
}

function setToken(t) {
  token = t;
  if (t) localStorage.setItem("pp_token", t);
  else localStorage.removeItem("pp_token");
}

function logout() {
  setToken(null);
  currentUser = null;
  currentGarden = null;
  gridPlacements = {};
  showView("auth");
}

function updateNav() {
  var navRight = document.getElementById("nav-right");
  if (!navRight) return;
  var settingsItem = '<li><button class="outline small-btn" id="nav-settings" title="Settings"><i data-lucide="settings"></i></button></li>';
  if (token && currentUser) {
    navRight.innerHTML =
      '<li><a href="#" id="nav-gardens">My Gardens</a></li>' +
      '<li><a href="#" id="nav-logout">Logout</a></li>' +
      settingsItem;
    document.getElementById("nav-gardens").onclick = function(e) {
      e.preventDefault();
      showView("gardens");
    };
    document.getElementById("nav-logout").onclick = function(e) {
      e.preventDefault();
      logout();
    };
  } else {
    navRight.innerHTML = settingsItem;
  }
  document.getElementById("nav-settings").onclick = showThemeSettings;
}

function showThemeSettings() {
  var existing = document.getElementById("settings-dialog");
  if (existing) { existing.showModal(); return; }

  var dialog = document.createElement("dialog");
  dialog.id = "settings-dialog";

  var optionsHtml = Object.keys(THEMES).map(function(key) {
    var t = THEMES[key];
    return '<label class="theme-option">' +
      '<input type="radio" name="pp-theme" value="' + key + '"' + (currentTheme === key ? " checked" : "") + '>' +
      '<span class="theme-swatch swatch-' + key + '"></span>' +
      '<span>' + t.label + '</span>' +
      '</label>';
  }).join("");

  dialog.innerHTML =
    '<article>' +
      '<header><strong><i data-lucide="settings"></i> Settings</strong></header>' +
      '<fieldset>' +
        '<legend>Color Theme</legend>' +
        optionsHtml +
      '</fieldset>' +
      '<footer><button id="settings-close">Close</button></footer>' +
    '</article>';

  document.body.appendChild(dialog);
  dialog.showModal();
  _initIcons();

  dialog.querySelectorAll('input[name="pp-theme"]').forEach(function(radio) {
    radio.onchange = function() { applyTheme(this.value); };
  });
  document.getElementById("settings-close").onclick = function() {
    dialog.close();
    dialog.remove();
  };
}

function sunlightLabel(s) {
  if (s === "full_sun") return "Full Sun";
  if (s === "partial") return "Partial";
  if (s === "shade") return "Shade";
  return s;
}

function sunlightIcon(s) {
  if (s === "full_sun") return "☀️";
  if (s === "partial") return "⛅";
  if (s === "shade") return "🌙";
  return "";
}

function _initIcons() {
  if (window.lucide) requestAnimationFrame(function() { lucide.createIcons(); });
}

function render() {
  updateNav();
  if (currentView === "auth") renderAuth();
  else if (currentView === "gardens") renderGardens();
  else if (currentView === "builder") renderBuilder();
  _initIcons();
}
