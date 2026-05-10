// state.js — All global state variables.
//
// Garden_type values (mirrored in shared-backend/routes/plant_planner/garden_units.py):
//   indoor_pot, indoor_planter_box, greenhouse,
//   outdoor_pot, outdoor_planter_box, garden_bed, raised_bed.
// grid_width / grid_height are inches for indoor_pot / indoor_planter_box /
// outdoor_pot / outdoor_planter_box and feet for the rest.

var currentView = "auth"; // auth | gardens | wizard | shopping | builder | library | browser | import

// ── Supabase Auth state ──────────────────────────────────────────────────────
var supabaseClient = null;
var session = null;          // populated by supabaseClient.auth.onAuthStateChange
var authConfigError = null;  // surfaced in the auth screen if Supabase config is missing
var authMode = "login";      // "login" | "signup"
var authBusy = false;

var currentUser = null;
var gardens = [];        // user's saved gardens
var currentGarden = null;
var placements = [];     // Array<{id, plantCacheId, plant, pos_x, pos_y, radius_feet}>
var draggedPlant = null; // plant being dragged from sidebar shortlist
var scene3DHandle = null;  // active 2D scene handle (kept this name for backward compat)
var catalogDropHandled = false;

// Garden-creation wizard draft (only populated while currentView === "wizard").
// Shape mirrors CreateGardenBody on the backend; null on every other view.
var wizardDraft = null;
var wizardStep = 1;        // 1..7
var wizardEditReturnTo = null;  // null | step number; when set, "Next" jumps back to review

var currentTheme = localStorage.getItem("pp_theme") || "pastel";
