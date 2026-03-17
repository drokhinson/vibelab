// theme.js — Color theme definitions and apply logic

var THEMES = {
  sunlit: { label: "🌻 Sunlit Garden", picoTheme: "light" },
  golden: { label: "🌅 Golden Hour",   picoTheme: "dark"  }
};

function applyTheme(name) {
  if (!THEMES[name]) name = "golden";
  currentTheme = name;
  localStorage.setItem("pp_theme", name);
  document.documentElement.setAttribute("data-theme", THEMES[name].picoTheme);
  document.documentElement.setAttribute("data-color-scheme", name);
}
