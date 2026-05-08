// state.js — All global state variables

var currentView = "auth"; // auth | gardens | wizard | builder

// ── Supabase Auth state ──────────────────────────────────────────────────────
var supabaseClient = null;
var session = null;          // populated by supabaseClient.auth.onAuthStateChange
var authConfigError = null;  // surfaced in the auth screen if Supabase config is missing
var authMode = "login";      // "login" | "signup"
var authBusy = false;

var currentUser = null;
var plants = [];         // plant catalog from API
var gardens = [];        // user's saved gardens
var currentGarden = null; // garden being edited {id, name, grid_width, grid_height, plants:[]}
var placements = [];   // Array<{id, plantId, plant, pos_x, pos_y, radius_feet}>
var draggingPreview = null;  // {plant, pos_x, pos_y, radius_feet, valid: 'ok'|'overlap'|'oob'} or null
var scene3DHandle = null;  // active Three.js scene handle
var renderStyle = localStorage.getItem("pp_render_style") || "realistic"; // "realistic" | "natural"
var draggedPlant = null; // plant being dragged from catalog
var catalogDropHandled = false; // set true when a catalog drag has either been placed in the grid or already tossed; tile ondragend checks this to avoid double-handling
var catalogSearch = '';      // free-text search query (debounced)

// Plant-catalog filter state (replaces the old flat catalogChips map).
// Primary control is matchGarden — when true, the catalog auto-filters using
// currentGarden's lighting, water_plan, hardiness zone, and planter type.
var catalogFilters = {
  matchGarden: true,
  seasons: {},          // { spring:true, summer:true, ... }
  types: {},            // { flower:true, herb:true, vegetable:true, fruit:true }
  native: false,
  pollinators: false
};

// Garden-creation wizard draft (only populated while currentView === "wizard").
// Shape mirrors CreateGardenBody on the backend; null on every other view.
var wizardDraft = null;
var wizardStep = 1;        // 1..6
var wizardEditReturnTo = null;  // null | step number; when set, "Next" jumps back to review

var detailPanelPlantId = null; // id of plant currently shown in the detail panel, or null
var currentTheme = localStorage.getItem("pp_theme") || "pastel";

var companions = [];
var companionsByPlantId = {};
var dismissedCompanionWarnings = new Set();
var companionPopoverCellKey = null;

var previewYear = parseInt(localStorage.getItem('pp_preview_year') || '3', 10);
if (![1, 2, 3].includes(previewYear)) previewYear = 3;
