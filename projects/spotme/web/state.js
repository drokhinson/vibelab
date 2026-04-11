// state.js — SpotMe shared state
// All data comes from the shared backend API via fetch().

const API = window.APP_CONFIG?.apiBase ?? "http://localhost:8000";
const BASE = "/api/v1/spotme";

// Analytics — fire-and-forget app open tracking
fetch(`${API}/api/v1/analytics/track`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app: window.APP_CONFIG?.project || 'spotme', event: 'app_open' })
}).catch(() => {});

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser = null;       // { id, username, display_name, bio, home_label, ... }
let currentView = "profile";
let hobbyCategories = [];     // [{ id, slug, name, icon, sort_order }]
let allHobbies = [];          // [{ id, name, slug, category_id, spotme_hobby_categories: {...} }]
let myHobbies = [];           // [{ id, hobby_id, proficiency, notes, spotme_hobbies: {...} }]
let selectedCategoryFilter = null;  // category_id or null for "all"

// Supabase client (initialized in helpers.js)
let sb = null;
