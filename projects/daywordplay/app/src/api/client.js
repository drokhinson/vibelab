// API client — Day Word Play
// All fetch calls go through this file. Never call fetch() directly in screens.

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8000";
const PROJECT = "daywordplay";

async function apiFetch(path, options = {}) {
  const url = `${BASE_URL}/api/v1/${PROJECT}${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Health check ──────────────────────────────────────────────────────────────
export async function fetchHealth() {
  return apiFetch("/health");
}

// TODO: add project-specific fetch functions below
// export async function fetchItems() { return apiFetch("/items"); }
