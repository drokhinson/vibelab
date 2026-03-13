// landing/app.js — vibelab central landing page
// Reads registry.json and renders project cards with filter controls.

const grid = document.getElementById("projects-grid");
const filterBtns = document.querySelectorAll(".filter-btn");

let allProjects = [];
let activeFilter = "all";

// ── Load registry ─────────────────────────────────────────────────────────────
async function loadRegistry() {
  try {
    const res = await fetch("./registry.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allProjects = data.projects ?? [];
    render();
  } catch (err) {
    grid.innerHTML = `<div class="empty">⚠ Failed to load projects: ${err.message}</div>`;
  }
}

// ── Filter ────────────────────────────────────────────────────────────────────
filterBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    filterBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeFilter = btn.dataset.filter;
    render();
  });
});

// ── Render ────────────────────────────────────────────────────────────────────
function statusLabel(status) {
  const map = { live: "Live", wip: "In Progress", prototype: "Prototype", archived: "Archived" };
  return map[status] ?? status;
}

function projectCard(p) {
  const webLink = p.webUrl
    ? `<a class="card-link" href="${p.webUrl}" target="_blank" rel="noopener">Open ↗</a>`
    : `<span class="card-link" style="opacity:0.3">Not deployed</span>`;

  const nativeBadge = p.hasNativeApp
    ? `<span class="native-badge">📱 Native</span>`
    : "";

  const tags = (p.tags ?? [])
    .map(t => `<span class="tag">${t}</span>`)
    .join("");

  return `
    <div class="project-card" data-status="${p.status}">
      <div class="card-icon">${p.icon ?? "🔧"}</div>
      <p class="card-name">${p.name}</p>
      <p class="card-desc">${p.description}</p>
      ${tags ? `<div class="card-tags">${tags}</div>` : ""}
      <div class="card-footer">
        <span class="status-badge status-${p.status}">${statusLabel(p.status)}</span>
        ${nativeBadge}
        ${webLink}
      </div>
    </div>
  `;
}

function render() {
  const filtered = activeFilter === "all"
    ? allProjects
    : allProjects.filter(p => p.status === activeFilter);

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty">No projects found.</div>`;
    return;
  }

  grid.innerHTML = filtered.map(projectCard).join("");
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadRegistry();
