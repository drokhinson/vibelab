// helpers.js — API fetch, navigation, formatting utilities

const API = window.APP_CONFIG?.apiBase || "http://localhost:8000";
const PREFIX = "/api/v1/boardgame_buddy";

function bggImg(url) {
  if (!url) return null;
  if (url.startsWith("//")) return "https:" + url;
  return url;
}

// ── API ──────────────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const headers = opts.headers || {};
  if (session?.access_token) {
    headers["Authorization"] = "Bearer " + session.access_token;
  }
  if (opts.body && typeof opts.body === "object") {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(API + PREFIX + path, { ...opts, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json();
}

// ── Navigation ───────────────────────────────────────────────────────────────

function showView(view) {
  currentView = view;
  document.querySelectorAll("[data-view]").forEach(el => {
    el.classList.toggle("hidden", el.dataset.view !== view);
  });
  // Update bottom nav active state
  document.querySelectorAll(".btm-nav button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.nav === view);
  });
  // Update auth-dependent visibility
  const isAuthed = !!session;
  document.querySelectorAll("[data-auth-only]").forEach(el => {
    el.classList.toggle("hidden", !isAuthed);
  });
}

// ── Formatting ───────────────────────────────────────────────────────────────

function playerRange(min, max) {
  if (!min && !max) return "";
  if (min === max) return `${min}P`;
  return `${min || "?"}–${max || "?"}P`;
}

function formatTime(minutes) {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h${m}m` : `${h}h`;
}

function formatRating(rating) {
  if (!rating) return "N/A";
  return Number(rating).toFixed(1);
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

// ── Toast ────────────────────────────────────────────────────────────────────

function showToast(message, type = "info") {
  const toast = document.getElementById("toast");
  toast.className = `toast toast-end toast-top`;
  toast.innerHTML = `<div class="alert alert-${type}"><span>${message}</span></div>`;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 3000);
}

// ── Analytics ────────────────────────────────────────────────────────────────

function trackEvent(event) {
  fetch(API + "/api/v1/analytics/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app: "boardgame-buddy", event }),
  }).catch(() => {});
}
