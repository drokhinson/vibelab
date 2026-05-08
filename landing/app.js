// landing/app.js — vibelab central landing page
// Reads registry.json, renders a featured tier of branded hero cards
// (live flagship apps with project-specific colors + logos) and a
// secondary grid of WIP prototypes. The admin tool is hoisted out of
// the project list and rendered as a button in the header.

const grid = document.getElementById("projects-grid");
const featuredEl = document.getElementById("featured");
const adminSlot = document.getElementById("admin-slot");
const filterBtns = document.querySelectorAll(".filter-btn");
const filtersSection = document.getElementById("filters");

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

// ── Brand glyphs (inline SVG) ─────────────────────────────────────────────────
// Each featured card uses its project's signature illustration so the
// hero tier reads as a real lineup, not a row of emoji.

// Featured-card hero illustrations live as standalone SVGs under
// landing/assets/illustrations/. Each file is a synced copy of the
// source-of-truth at projects/<name>/web/assets/illustrations/<prefix>-hero.svg.
// When a project's hero changes, copy the updated file into landing/ as well.
function heroImg(file, variant) {
  return `<img class="hero-art hero-art--${variant}" src="assets/illustrations/${file}" alt="" aria-hidden="true">`;
}

function sauceBossPotSVG()  { return heroImg("sb-hero.svg",  "pot"); }
function buddySVG()         { return heroImg("bgb-hero.svg", "buddy"); }
function plantPlannerSVG()  { return heroImg("pp-hero.svg",  "sprout"); }
function dwpBookSVG()       { return heroImg("dwp-hero.svg", "book"); }

const FEATURED_THEMES = {
  "sauceboss":       { brandClass: "brand-sauceboss", art: sauceBossPotSVG },
  "boardgame-buddy": { brandClass: "brand-bgb",       art: buddySVG },
  "daywordplay":     { brandClass: "brand-dwp",       art: dwpBookSVG },
  "plant-planner":   { brandClass: "brand-pp",        art: plantPlannerSVG },
};

// Status sort order — live first, then in-progress, then deferred. Within
// each bucket we preserve the registry's declared order so editors stay in
// control of the lineup.
const STATUS_RANK = { live: 0, wip: 1, prototype: 1, deferred: 2, archived: 3 };
function statusRank(p) { return STATUS_RANK[p.status] ?? 9; }

// ── Render helpers ────────────────────────────────────────────────────────────
function statusLabel(status) {
  const map = {
    live: "Live",
    wip: "In Progress",
    prototype: "Prototype",
    deferred: "Deferred",
    archived: "Archived",
  };
  return map[status] ?? status;
}

function nativeBadge(p) {
  if (!p.hasNativeApp) return "";
  if (p.nativeBeta) {
    return `<span class="native-badge native-badge--beta" title="Native app available in beta">📱 Native · Beta</span>`;
  }
  return `<span class="native-badge">📱 Native</span>`;
}

function openLink(url, klass = "card-link") {
  return url
    ? `<a class="${klass}" href="${url}" target="_blank" rel="noopener">Open ↗</a>`
    : `<span class="${klass}" style="opacity:0.3">Not deployed</span>`;
}

// ── Featured hero card ────────────────────────────────────────────────────────
function featuredCard(p) {
  const theme = FEATURED_THEMES[p.id];
  const art = theme && theme.art ? theme.art() : `<div class="hero-art hero-art--emoji">${p.icon ?? "✨"}</div>`;
  const brandClass = theme ? theme.brandClass : "";
  return `
    <a class="featured-card ${brandClass}" data-status="${p.status}"
       href="${p.webUrl}" target="_blank" rel="noopener">
      <div class="featured-art">${art}</div>
      <div class="featured-body">
        <div class="featured-headline">
          <span class="featured-name">${p.name}</span>
          <span class="status-badge status-${p.status}">${statusLabel(p.status)}</span>
        </div>
        <p class="featured-desc">${p.description}</p>
        <div class="featured-meta">
          <div class="featured-actions">
            ${nativeBadge(p)}
            <span class="featured-cta">Open ↗</span>
          </div>
        </div>
      </div>
    </a>
  `;
}

// ── Compact card (WIP / non-featured projects) ────────────────────────────────
function projectCard(p) {
  return `
    <div class="project-card" data-status="${p.status}">
      <div class="card-icon">${p.icon ?? "🔧"}</div>
      <p class="card-name">${p.name}</p>
      <p class="card-desc">${p.description}</p>
      <div class="card-footer">
        <span class="status-badge status-${p.status}">${statusLabel(p.status)}</span>
        ${nativeBadge(p)}
        ${openLink(p.webUrl)}
      </div>
    </div>
  `;
}

// ── Header admin button ───────────────────────────────────────────────────────
function renderAdminSlot(admin) {
  if (!admin || !admin.webUrl) {
    adminSlot.innerHTML = "";
    return;
  }
  adminSlot.innerHTML = `
    <a class="admin-btn" href="${admin.webUrl}" target="_blank" rel="noopener" title="${admin.description}">
      <span class="admin-btn-icon">${admin.icon ?? "🛠️"}</span>
      <span class="admin-btn-label">Admin</span>
    </a>
  `;
}

// ── Main render ───────────────────────────────────────────────────────────────
function render() {
  // Pull the admin tool out — it lives in the header, not the grid.
  const admin = allProjects.find(p => p.isAdminTool);
  const projects = allProjects.filter(p => !p.isAdminTool);
  renderAdminSlot(admin);

  // Stable status-rank sort: live → wip → deferred → archived. Featured
  // entries jump to the top within their status bucket so the lineup reads
  // sauceboss → bgb → dwp (all live, all featured) → plant-planner (wip,
  // featured) → spotme/wealthmate (deferred, compact).
  const sorted = [...projects].sort((a, b) => {
    const r = statusRank(a) - statusRank(b);
    if (r !== 0) return r;
    if (!!a.featured !== !!b.featured) return a.featured ? -1 : 1;
    return 0;
  });

  const featured = sorted.filter(p => p.featured);
  const others   = sorted.filter(p => !p.featured);

  // Filter applies to BOTH tiers consistently — clicking "In Progress"
  // shows only WIP entries (in either tier), etc.
  const matches = (p) => activeFilter === "all" || p.status === activeFilter;
  const featuredVisible = featured.filter(matches);
  const othersVisible   = others.filter(matches);

  featuredEl.innerHTML = featuredVisible.map(featuredCard).join("");
  featuredEl.style.display = featuredVisible.length ? "" : "none";

  // Hide the "In progress" heading + filter pills if there's nothing below
  // the featured tier to filter (e.g. when "Live" is selected).
  const showLowerSection = othersVisible.length > 0 || activeFilter === "wip" || activeFilter === "all";
  filtersSection.style.display = showLowerSection ? "" : "none";

  if (othersVisible.length === 0 && featuredVisible.length === 0) {
    grid.innerHTML = `<div class="empty">No projects found.</div>`;
    return;
  }
  if (othersVisible.length === 0) {
    grid.innerHTML = "";
    return;
  }
  grid.innerHTML = othersVisible.map(projectCard).join("");
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadRegistry();
