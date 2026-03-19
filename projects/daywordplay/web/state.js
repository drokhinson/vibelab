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
let todayData = null;          // { word, submitted, my_sentence, submission_count, member_count, bookmarked }
let cachedDailyWord = null;    // persists across group switches (same word for all groups)
let yesterdayData = null;      // { word, sentences, has_voted }
let wordHistory = [];          // all past words from user's groups with winning sentences
let allWords = [];             // all words in the word bank (for dictionary view)
let reusableSentences = [];    // sentences user submitted in other groups for today's word

// ── UI state ──────────────────────────────────────────────────────────────────
let currentView = 'home';      // home | dictionary | profile | leaderboard | admin
let activeWordTab = 'today';   // 'today' | 'vote'
let dictFilter = 'played';      // 'all' | 'played'

// ── Analytics ping ────────────────────────────────────────────────────────────
fetch(`${API}/api/v1/analytics/track`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app: 'daywordplay', event: 'app_open' }),
}).catch(() => {});
