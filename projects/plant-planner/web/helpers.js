// helpers.js — apiFetch, auth token, navigation, formatting

var API = window.APP_CONFIG?.apiBase ?? "http://localhost:8000";
var PREFIX = "/api/v1/plant_planner";
var app = document.getElementById("app");

async function apiFetch(path, opts = {}) {
  var headers = opts.headers || {};
  var accessToken = session && session.access_token;
  if (accessToken) headers["Authorization"] = "Bearer " + accessToken;
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

async function logout() {
  if (supabaseClient) {
    try { await supabaseClient.auth.signOut(); } catch (e) {
      console.error("[plant-planner] signOut error:", e);
    }
    // onAuthStateChange (SIGNED_OUT) handles state reset + view switch.
    return;
  }
  // No Supabase configured — local cleanup fallback.
  session = null;
  currentUser = null;
  currentGarden = null;
  placements = [];
  showView("auth");
}

function updateNav() {
  var navRight = document.getElementById("nav-right");
  if (!navRight) return;
  if (session && currentUser) {
    navRight.innerHTML =
      '<button class="btn btn-ghost btn-sm gap-1" id="nav-gardens"><i data-lucide="layout-grid" style="width:1em;height:1em"></i> My Gardens</button>' +
      '<button class="btn btn-ghost btn-sm btn-circle" id="nav-settings" title="Settings"><i data-lucide="settings" style="width:1.1em;height:1.1em"></i></button>';
    document.getElementById("nav-gardens").onclick = function(e) {
      e.preventDefault();
      showView("gardens");
    };
  } else {
    navRight.innerHTML =
      '<button class="btn btn-ghost btn-sm btn-circle" id="nav-settings" title="Settings"><i data-lucide="settings" style="width:1.1em;height:1.1em"></i></button>';
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
      '<input type="radio" name="pp-theme" value="' + key + '"' + (currentTheme === key ? " checked" : "") + ' class="radio radio-sm radio-primary">' +
      '<span class="theme-swatch ' + (t.swatch || "swatch-" + key) + '"></span>' +
      '<span class="text-sm">' + t.label + '</span>' +
      '</label>';
  }).join("");

  // Draw style options
  var styleOptions = [
    { id: "realistic", label: "Realistic" },
    { id: "natural", label: "Cublants" }
  ];
  var styleHtml = styleOptions.map(function(s) {
    return '<label class="theme-option">' +
      '<input type="radio" name="pp-style" value="' + s.id + '"' + (renderStyle === s.id ? ' checked' : '') + ' class="radio radio-sm radio-primary">' +
      '<span class="text-sm">' + s.label + '</span>' +
      '</label>';
  }).join("");

  var showAccount = !!(session && currentUser);
  var accountHtml = showAccount
    ? '<fieldset class="space-y-2 mt-3 settings-account">' +
        '<legend class="text-sm font-medium mb-2">Account</legend>' +
        '<button type="button" id="settings-logout" class="btn btn-sm btn-outline btn-error w-full gap-1">' +
          '<i data-lucide="log-out" style="width:1em;height:1em"></i> Log out' +
        '</button>' +
      '</fieldset>'
    : '';

  dialog.innerHTML =
    '<div class="dialog-body">' +
      '<div class="dialog-header"><i data-lucide="settings"></i> Settings</div>' +
      '<fieldset class="space-y-2">' +
        '<legend class="text-sm font-medium mb-2">Color Theme</legend>' +
        optionsHtml +
      '</fieldset>' +
      '<fieldset class="space-y-2 mt-3">' +
        '<legend class="text-sm font-medium mb-2">Draw Style</legend>' +
        styleHtml +
      '</fieldset>' +
      accountHtml +
      '<div class="mt-4"><button id="settings-close" class="btn btn-sm btn-primary w-full">Close</button></div>' +
    '</div>';

  document.body.appendChild(dialog);
  dialog.showModal();
  _initIcons();

  dialog.querySelectorAll('input[name="pp-theme"]').forEach(function(radio) {
    radio.onchange = function() { applyTheme(this.value); };
  });
  dialog.querySelectorAll('input[name="pp-style"]').forEach(function(radio) {
    radio.onchange = function() {
      renderStyle = this.value;
      localStorage.setItem("pp_render_style", renderStyle);
      // Update 3D view if active
      if (scene3DHandle) setRenderStyle(scene3DHandle, renderStyle);
      // Regenerate 2D thumbnails
      invalidateThumbnailCache();
      preloadThumbnails(plants, renderStyle);
      // Re-render grid/catalog to update thumbnails
      if (currentView === "builder") {
        var gridArea = document.querySelector(".grid-area");
        if (gridArea) {
          gridArea.innerHTML = viewMode === "top" ? renderTopGrid(currentGarden) : renderSideView(currentGarden);
          bindGridEvents(currentGarden);
          if (viewMode === "side") bindCompassButtons();
        }
        refreshCatalogList();
      }
    };
  });
  var logoutBtn = document.getElementById("settings-logout");
  if (logoutBtn) logoutBtn.onclick = function() {
    dialog.close();
    dialog.remove();
    logout();
  };
  document.getElementById("settings-close").onclick = function() {
    dialog.close();
    dialog.remove();
  };
}

function yearScale(plant, year) {
  if (!plant) return 1.0;
  if (plant.lifecycle === 'annual') return 1.0;
  if (plant.lifecycle === 'biennial') return year >= 2 ? 1.0 : 0.5;
  // perennial: ramp to 1.0 at years_to_maturity; floor 0.4 at year 1
  var ytm = plant.years_to_maturity || 3;
  if (year >= ytm) return 1.0;
  return Math.max(0.4, year / ytm);
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
  else if (currentView === "wizard") renderGardenWizard();
  else if (currentView === "builder") renderBuilder();
  _initIcons();
}
