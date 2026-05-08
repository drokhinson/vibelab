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

// Per-platform native badges. Each project that intends to ship a mobile app
// (hasNativeApp: true) renders an Android pill and an iOS pill side-by-side.
// Status values: "live" | "beta" | "wip" | "not-started". Renders as a <span>
// for now; once `androidUrl` / `iosUrl` are populated the markup becomes a real
// link to the Play / App Store (requires the featured-card outer <a> to move
// to a button-style wrapper to avoid nested anchors).
const PLATFORM_LOGOS = {
  android: `<svg class="platform-badge__icon" viewBox="0 0 24 24" aria-hidden="true" fill="#3DDC84"><path d="M17.523 15.341a.998.998 0 110-1.997.998.998 0 010 1.997m-11.046 0a.998.998 0 110-1.997.998.998 0 010 1.997m11.405-6.02l1.997-3.46a.416.416 0 10-.72-.415l-2.022 3.503A12.4 12.4 0 0012 7.85a12.4 12.4 0 00-5.137 1.099L4.841 5.446a.416.416 0 10-.72.415l1.997 3.46A11.5 11.5 0 000 18.76h24a11.5 11.5 0 00-6.118-9.439"/></svg>`,
  ios: `<svg class="platform-badge__icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.351 2.18-.117.073-2.617 1.51-2.617 4.5 0 3.43 3.083 4.65 3.213 4.69z"/></svg>`,
};
const PLATFORM_NAMES = { android: "Android", ios: "iOS" };
const PLATFORM_STATUS_LABEL = {
  live: "Live",
  beta: "Beta",
  wip: "WIP",
  "not-started": "Not started",
};

function platformBadge(platform, status) {
  if (!status) return "";
  const name = PLATFORM_NAMES[platform];
  const stateLabel = PLATFORM_STATUS_LABEL[status] ?? status;
  return `<span class="platform-badge platform-badge--${platform} platform-badge--${status}" title="${name} — ${stateLabel}">${PLATFORM_LOGOS[platform]}<span class="platform-badge__label">${name} · ${stateLabel}</span></span>`;
}

function nativeBadges(p) {
  if (!p.hasNativeApp) return "";
  return platformBadge("android", p.androidStatus) + platformBadge("ios", p.iosStatus);
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
            ${nativeBadges(p)}
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
        ${nativeBadges(p)}
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
