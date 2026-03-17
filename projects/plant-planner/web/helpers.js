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
  if (token && currentUser) {
    navRight.innerHTML =
      '<li><a href="#" id="nav-gardens">My Gardens</a></li>' +
      '<li><a href="#" id="nav-logout">Logout</a></li>';
    document.getElementById("nav-gardens").onclick = function(e) {
      e.preventDefault();
      showView("gardens");
    };
    document.getElementById("nav-logout").onclick = function(e) {
      e.preventDefault();
      logout();
    };
  } else {
    navRight.innerHTML = "";
  }
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

function render() {
  updateNav();
  if (currentView === "auth") renderAuth();
  else if (currentView === "gardens") renderGardens();
  else if (currentView === "builder") renderBuilder();
}
