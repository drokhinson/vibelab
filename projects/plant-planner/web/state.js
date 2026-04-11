// state.js — All global state variables

var currentView = "auth"; // auth | gardens | builder
var currentUser = null;
var plants = [];         // plant catalog from API
var gardens = [];        // user's saved gardens
var currentGarden = null; // garden being edited {id, name, grid_width, grid_height, plants:[]}
var gridPlacements = {}; // "x,y" → plant object
var scene3DHandle = null;  // active Three.js scene handle
var renderStyle = localStorage.getItem("pp_render_style") || "realistic"; // "realistic" | "natural"
var draggedPlant = null; // plant being dragged from catalog
var catalogFilter = "all";         // sunlight filter: all | full_sun | partial | shade
var catalogFilterSeason = "all";   // bloom season: all | spring | summer | fall | winter
var catalogFilterCategory = "all"; // category: all | vegetable | herb | flower | fruit
var currentTheme = localStorage.getItem("pp_theme") || "pastel";

// Supabase client (initialized in helpers.js)
var sb = null;
