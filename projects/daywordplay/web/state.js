'use strict';

// ── API Base ──────────────────────────────────────────────────────────────────
const API = window.APP_CONFIG?.apiBase ?? 'http://localhost:8000';
const BASE = '/api/v1/daywordplay';

// ── Auth state ────────────────────────────────────────────────────────────────
let currentUser = null;

// ── Group state ───────────────────────────────────────────────────────────────
let myGroups = [];
let activeGroupId = null;

// ── Word/sentence state ───────────────────────────────────────────────────────
let todayData = null;      // { word, submitted, my_sentence, submission_count, member_count, bookmarked }
let yesterdayData = null;  // { word, sentences, has_voted }
let bookmarks = [];

// ── UI state ──────────────────────────────────────────────────────────────────
let currentView = 'home';     // home | vote | dictionary | profile | leaderboard

// ── Analytics ping ────────────────────────────────────────────────────────────
fetch(`${API}/api/v1/analytics/track`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app: 'daywordplay', event: 'app_open' }),
}).catch(() => {});
