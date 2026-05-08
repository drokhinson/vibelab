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

function sauceBossPotSVG() {
  // Lifted from projects/sauceboss/web/meal.js → potSVG(). Fills tuned for
  // the orange hero card so the pot reads on a colored background.
  return `
    <svg class="hero-art hero-art--pot" viewBox="0 0 180 140" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <ellipse cx="90" cy="130" rx="62" ry="8" fill="#1A1A2E" opacity="0.12"/>
      <path d="M28 68 Q28 112 90 112 Q152 112 152 68 Z" fill="#FFF3E6"/>
      <path d="M28 68 Q28 112 90 112 Q152 112 152 68" stroke="#3D1100" stroke-width="2" fill="none"/>
      <ellipse cx="90" cy="96" rx="40" ry="10" fill="#E85D04" opacity="0.18"/>
      <circle cx="70"  cy="91"  r="9" fill="#FAA307" opacity="0.95"/>
      <circle cx="93"  cy="84"  r="7" fill="#F48C06" opacity="0.95"/>
      <circle cx="114" cy="93"  r="8" fill="#C94E02" opacity="0.95"/>
      <path d="M58 76 Q72 62 88 76 Q104 90 118 74" stroke="#C94E02" stroke-width="2.5" stroke-linecap="round" fill="none" opacity="0.6"/>
      <rect x="20" y="60" width="140" height="14" rx="7" fill="#3D1100"/>
      <path d="M62 56 Q66 44 62 34 Q58 24 62 14"     stroke="#FFE7CC" stroke-width="2.5" stroke-linecap="round" fill="none" opacity="0.85"/>
      <path d="M90 53 Q94 41 90 31 Q86 21 90 11"     stroke="#FFE7CC" stroke-width="2.5" stroke-linecap="round" fill="none" opacity="0.85"/>
      <path d="M118 56 Q122 44 118 34 Q114 24 118 14" stroke="#FFE7CC" stroke-width="2.5" stroke-linecap="round" fill="none" opacity="0.85"/>
    </svg>`;
}

function buddySVG() {
  // Distilled from projects/boardgame-buddy/web/assets/brand/bgb-logo.svg —
  // just the buddy face + speech bubble (no dark plate; the card itself is
  // the dark warm-brown background).
  return `
    <svg class="hero-art hero-art--buddy" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="bgb-accent" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#f59e0b"/>
          <stop offset="100%" stop-color="#f97316"/>
        </linearGradient>
      </defs>
      <g opacity="0.18" stroke="#f59e0b" stroke-width="1.5" fill="none">
        <line x1="50" y1="20" x2="50" y2="180"/>
        <line x1="100" y1="20" x2="100" y2="180"/>
        <line x1="150" y1="20" x2="150" y2="180"/>
        <line x1="20" y1="50" x2="180" y2="50"/>
        <line x1="20" y1="100" x2="180" y2="100"/>
        <line x1="20" y1="150" x2="180" y2="150"/>
      </g>
      <rect x="55" y="40" width="90" height="90" rx="20" fill="url(#bgb-accent)"/>
      <circle cx="80" cy="80" r="6" fill="#1a0f0b"/>
      <circle cx="120" cy="80" r="6" fill="#1a0f0b"/>
      <path d="M80 102 Q100 118 120 102" stroke="#1a0f0b" stroke-width="4" fill="none" stroke-linecap="round"/>
      <g fill="url(#bgb-accent)">
        <circle cx="100" cy="148" r="14"/>
        <rect x="84" y="158" width="32" height="22" rx="9"/>
      </g>
      <g transform="translate(135, 110)">
        <rect x="0" y="0" width="48" height="48" rx="10" fill="#fff" opacity="0.95"/>
        <polygon points="10,48 22,48 14,60" fill="#fff" opacity="0.95"/>
        <g fill="#2a1812">
          <circle cx="12" cy="12" r="3.2"/>
          <circle cx="36" cy="12" r="3.2"/>
          <circle cx="24" cy="24" r="3.2"/>
          <circle cx="12" cy="36" r="3.2"/>
          <circle cx="36" cy="36" r="3.2"/>
        </g>
      </g>
    </svg>`;
}

function plantPlannerSVG() {
  // PlantPlanner has no logo asset — its app header just uses Lucide
  // "sprout" with the Quicksand wordmark. We render a potted-sprout
  // illustration in the project's coral / sage / lavender palette.
  return `
    <svg class="hero-art hero-art--sprout" viewBox="0 0 200 180" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <ellipse cx="100" cy="170" rx="62" ry="6" fill="#1A1A2E" opacity="0.08"/>
      <!-- Leaves -->
      <g>
        <path d="M100 90 Q70 64 56 84 Q66 102 100 96 Z" fill="#7BAE7F"/>
        <path d="M100 90 Q66 78 56 84 Q72 92 100 96 Z" fill="#6A9D6E" opacity="0.6"/>
        <path d="M100 90 Q130 60 146 80 Q134 100 100 96 Z" fill="#7BAE7F"/>
        <path d="M100 90 Q132 76 146 80 Q128 92 100 96 Z" fill="#6A9D6E" opacity="0.6"/>
        <path d="M100 88 Q92 56 100 36 Q108 56 100 88 Z" fill="#7BAE7F"/>
        <line x1="100" y1="40" x2="100" y2="118" stroke="#5E8C62" stroke-width="3" stroke-linecap="round"/>
      </g>
      <!-- Lavender flower bud -->
      <circle cx="100" cy="34" r="7" fill="#B8A9D4"/>
      <circle cx="100" cy="30" r="4" fill="#CDC0E0"/>
      <!-- Pot -->
      <path d="M58 116 L142 116 L132 162 Q132 168 124 168 L76 168 Q68 168 68 162 Z"
            fill="#E8856C" stroke="#C76854" stroke-width="2"/>
      <rect x="56" y="112" width="88" height="10" rx="3" fill="#D26F58"/>
      <!-- Pot highlight -->
      <path d="M76 124 L80 158" stroke="#FBF8F3" stroke-width="3" stroke-linecap="round" opacity="0.45"/>
      <!-- Soil -->
      <ellipse cx="100" cy="118" rx="40" ry="3" fill="#5E3A2A" opacity="0.6"/>
    </svg>`;
}

function dwpBookSVG() {
  // Day Word Play has no logo character — render an open-book SVG using
  // the project's teal accent on cream paper.
  return `
    <svg class="hero-art hero-art--book" viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <ellipse cx="100" cy="148" rx="76" ry="6" fill="#1C1C1E" opacity="0.08"/>
      <path d="M16 44 Q60 28 100 44 Q140 28 184 44 L184 134 Q140 120 100 134 Q60 120 16 134 Z"
            fill="#F0EDE8" stroke="#4A7C7C" stroke-width="2.5" stroke-linejoin="round"/>
      <line x1="100" y1="44" x2="100" y2="134" stroke="#4A7C7C" stroke-width="2.5" stroke-linecap="round"/>
      <g stroke="#4A7C7C" stroke-width="2" stroke-linecap="round" opacity="0.7">
        <line x1="32" y1="60" x2="84" y2="56"/>
        <line x1="32" y1="74" x2="84" y2="70"/>
        <line x1="32" y1="88" x2="76" y2="84"/>
        <line x1="116" y1="56" x2="168" y2="60"/>
        <line x1="116" y1="70" x2="168" y2="74"/>
        <line x1="116" y1="84" x2="160" y2="88"/>
      </g>
      <g transform="translate(54 102)">
        <circle r="14" fill="#4A7C7C"/>
        <text y="5" text-anchor="middle" font-family="Inter, sans-serif" font-size="14" font-weight="700" fill="#F0EDE8">A</text>
      </g>
      <g transform="translate(146 102)">
        <circle r="14" fill="#3A6A6A"/>
        <text y="5" text-anchor="middle" font-family="Inter, sans-serif" font-size="14" font-weight="700" fill="#F0EDE8">Z</text>
      </g>
    </svg>`;
}

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
