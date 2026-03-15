// state.js — WealthMate shared state
// All data comes from the shared backend API via fetch().
// API base URL is set in config.js as window.APP_CONFIG.apiBase

const API = window.APP_CONFIG?.apiBase ?? "http://localhost:8000";
const BASE = "/api/v1/wealthmate";

// Analytics — fire-and-forget app open tracking
fetch(`${API}/api/v1/analytics/track`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app: window.APP_CONFIG?.project || 'wealthmate', event: 'app_open' })
}).catch(() => {});

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser = null;   // { id, username, display_name }
let coupleInfo = null;    // { couple, members } or null
let activeCheckin = null;  // in-progress checkin or null
let previousValues = {};   // account_id -> { current_value, balance_owed }
let accounts = [];
let checkins = [];
let wealthHistory = [];
let nwChart = null;
let acctChart = null;
let acctHistoryData = null;  // { dates, accounts }
let selectedAcctIds = new Set();
let currentView = "dashboard";
let checkinStep = 1;
let addAccountFromCheckin = false;
let checkinNewAccounts = {};  // account_id -> { current_value, balance_owed }
let editingAccountId = null;
let historyTab = "overview";
let currentCostTool = "big-purchases";
let expenseGroups = [];
let currentExpenseGroup = null;
let recurringExpenses = [];
let editingBillId = null;
