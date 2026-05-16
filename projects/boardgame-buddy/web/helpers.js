// helpers.js — small utilities shared across the OOP frontend.
// The legacy apiFetch / showView / trackEvent / state-coupled helpers have
// moved to the domain layer (api.js, view.js) and to the individual views.

function bggImg(url) {
  if (!url) return null;
  if (url.startsWith("//")) return "https:" + url;
  return url;
}

function computeInitials(name) {
  const parts = (name || "").trim().split(/[\s.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] || "?").slice(0, 2).toUpperCase();
}

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

function formatDate(dateStr) {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function showToast(message, type = "info") {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.className = `toast toast-end toast-top`;
  toast.innerHTML = `<div class="alert alert-${type}"><span>${message}</span></div>`;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 3000);
}
