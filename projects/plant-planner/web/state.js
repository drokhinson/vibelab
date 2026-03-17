// state.js — All global state variables

var currentView = "auth"; // auth | gardens | builder
var token = localStorage.getItem("pp_token") || null;
var currentUser = null;
var plants = [];         // plant catalog from API
var gardens = [];        // user's saved gardens
var currentGarden = null; // garden being edited {id, name, grid_width, grid_height, plants:[]}
var gridPlacements = {}; // "x,y" → plant object
var viewMode = "top";    // "top" | "side"
var draggedPlant = null; // plant being dragged from catalog
var catalogFilter = "all";         // sunlight filter: all | full_sun | partial | shade
var catalogFilterSeason = "all";   // bloom season: all | spring | summer | fall | winter
var catalogFilterCategory = "all"; // category: all | vegetable | herb | flower | fruit
var sideViewAngle = "south";       // compass angle: south | north | east | west
var currentTheme = localStorage.getItem("pp_theme") || "sunlit";
