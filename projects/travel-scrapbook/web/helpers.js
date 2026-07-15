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

function toast(message, { error = false, ms = 2600 } = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'ts-toast' + (error ? ' ts-toast--error' : '');
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), ms);
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

// Project-wide destructive-action confirmation surface (one surface per
// project, per web-frontend.md): native confirm() everywhere.
function confirmDestructive(message) {
  return window.confirm(message);
}
