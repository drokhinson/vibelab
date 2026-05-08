// state.js — All global state variables

var currentView = "auth"; // auth | gardens | builder

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
var catalogChips = {};       // active filter chip ids → true; e.g. { native: true, sun: true }
var detailPanelPlantId = null; // id of plant currently shown in the detail panel, or null
var currentTheme = localStorage.getItem("pp_theme") || "pastel";

var companions = [];
var companionsByPlantId = {};
var dismissedCompanionWarnings = new Set();
var companionPopoverCellKey = null;

var previewYear = parseInt(localStorage.getItem('pp_preview_year') || '3', 10);
if (![1, 2, 3].includes(previewYear)) previewYear = 3;
