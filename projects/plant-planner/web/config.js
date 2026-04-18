// config.js — API + Supabase configuration
// Vercel injects production values via window.__ENV__ (see public/_env.js or equivalent).
// Defaults below are for local development.
window.APP_CONFIG = {
  apiBase: (window.__ENV__ && window.__ENV__.API_BASE) || "https://vibelab-production-2119.up.railway.app",
  supabaseUrl: (window.__ENV__ && window.__ENV__.SUPABASE_URL) || "https://your-project.supabase.co",
  supabaseAnonKey: (window.__ENV__ && window.__ENV__.SUPABASE_ANON_KEY) || "your-anon-key",
  project: "plant-planner"
};
