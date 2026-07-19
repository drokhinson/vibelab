// helpers.js — analytics ping, toast, escaping, formatting.
'use strict';

// Fire-and-forget analytics ping (required for every vibelab app).
(function () {
  const API = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || 'http://localhost:8000';
  fetch(`${API}/api/v1/analytics/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: window.APP_CONFIG?.project || 'travel-scrapbook', event: 'app_open' }),
  }).catch(() => {});
})();

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeAttr(str) { return escapeHtml(str); }

// `key` dedupes: a repeat toast with the same key updates the existing bubble's
// text and resets its timer instead of stacking a new one — so rapid-fire
// mutations (e.g. cycling a timeline checkbox) show one bubble, not a burst.
function toast(message, { error = false, ms = 2600, key = null } = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  let el = key ? root.querySelector(`.ts-toast[data-toast-key="${key}"]`) : null;
  if (!el) {
    el = document.createElement('div');
    if (key) el.dataset.toastKey = key;
    root.appendChild(el);
  } else if (el._toastTimer) {
    clearTimeout(el._toastTimer);
  }
  el.className = 'ts-toast' + (error ? ' ts-toast--error' : '');
  el.textContent = message;
  el._toastTimer = setTimeout(() => el.remove(), ms);
}

function formatDateRange(startDate, endDate) {
  if (!startDate && !endDate) return '';
  const fmt = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (startDate && endDate) return `${fmt(startDate)} – ${fmt(endDate)}`;
  return fmt(startDate || endDate);
}

function formatKm(km) {
  if (km == null) return '';
  return km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

// Static-map thumbnail for a geocoded place that has no source photo. Keyless
// (OSM-based), so it fits this app's no-Google-key design. Centralized here so
// the provider swaps in ONE place; if a styled pin / guaranteed uptime is ever
// needed, point this at a referrer-restricted free-tier provider (Geoapify /
// LocationIQ) — the key is safe client-side. Callers always pair it with an
// onerror → sprite fallback, so a provider hiccup degrades gracefully.
function staticMapUrl(lat, lng, { w = 400, h = 220, zoom = 15 } = {}) {
  if (lat == null || lng == null) return null;
  return `https://staticmap.openstreetmap.de/staticmap.php` +
    `?center=${lat},${lng}&zoom=${zoom}&size=${w}x${h}&markers=${lat},${lng},lightblue1`;
}

// Project-wide destructive-action confirmation surface (one surface per
// project, per web-frontend.md): native confirm() everywhere.
function confirmDestructive(message) {
  return window.confirm(message);
}

// iPhone / iPad detection, for the platform-specific share-shortcut onboarding
// nudge. iPadOS 13+ masquerades as a Mac, so also treat a touch-capable
// "Macintosh" as iOS. UA sniffing is intentionally best-effort here — the
// tutorial card it gates is optional and purely informational.
function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}
window.isIOS = isIOS;
