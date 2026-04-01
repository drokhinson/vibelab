// config.js — local dev defaults
// In production this file is overwritten by build.sh using Vercel env vars.
// Set SUPABASE_URL and SUPABASE_ANON_KEY in the Vercel project dashboard.
window.APP_CONFIG = {
  apiBase: "http://localhost:8000",
  project: "boardgame-buddy",
  supabaseUrl: "",
  supabaseAnonKey: ""
};
