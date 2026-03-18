// theme.js — Color theme definitions and apply logic

var THEMES = {
  pastel: { label: "Sunlit Garden", swatch: "swatch-pastel" },
  night:  { label: "Evening Garden", swatch: "swatch-night" }
};

function applyTheme(name) {
  if (!THEMES[name]) name = "pastel";
  currentTheme = name;
  localStorage.setItem("pp_theme", name);
  document.documentElement.setAttribute("data-theme", name);
}
