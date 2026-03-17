// gardens.js — My Gardens list view (save/load/create/delete)

async function renderGardens() {
  app.innerHTML = '<div class="loading">Loading gardens…</div>';
  try {
    gardens = await apiFetch("/gardens");
  } catch (err) {
    app.innerHTML = '<div class="error-banner">' + err.message + '</div>';
    return;
  }

  var html = '<div class="gardens-view-header">';
  html += '<h3>My Gardens</h3>';
  html += '<button id="new-garden-btn" class="outline">+ New Garden</button>';
  html += '</div>';

  if (gardens.length === 0) {
    html += '<div class="empty-state"><p>No gardens yet. Create your first garden!</p></div>';
  } else {
    html += '<div class="gardens-grid">';
    for (var i = 0; i < gardens.length; i++) {
      var g = gardens[i];
      var typeLabel = g.garden_type === "planter" ? "Planter" : "Garden Bed";
      var typeIcon = g.garden_type === "planter" ? "🪴" : "🌱";
      var shadeIcon = sunlightIcon(g.shade_level || "full_sun");
      var shadeLabel = sunlightLabel(g.shade_level || "full_sun");
      var season = g.planting_season ? (g.planting_season.charAt(0).toUpperCase() + g.planting_season.slice(1)) : "Spring";

      html += '\
        <article class="garden-card" data-id="' + g.id + '">\
          <div class="garden-card-body">\
            <div class="garden-card-title">' + escapeHtml(g.name) + '</div>\
            <div class="garden-card-meta">\
              <span class="garden-chip">' + typeIcon + ' ' + typeLabel + '</span>\
              <span class="garden-chip">' + g.grid_width + '×' + g.grid_height + ' ft</span>\
            </div>\
            <div class="garden-card-meta">\
              <span class="garden-chip">' + shadeIcon + ' ' + shadeLabel + '</span>\
              <span class="garden-chip">🗓 ' + season + '</span>\
            </div>\
          </div>\
          <div class="garden-card-actions">\
            <button class="open-garden-btn" data-id="' + g.id + '">Open</button>\
            <button class="delete-garden-btn secondary outline" data-id="' + g.id + '">Delete</button>\
          </div>\
        </article>';
    }
    html += '</div>';
  }
  app.innerHTML = html;

  document.getElementById("new-garden-btn").onclick = showNewGardenDialog;
  document.querySelectorAll(".open-garden-btn").forEach(function(btn) {
    btn.onclick = function() { openGarden(btn.dataset.id); };
  });
  document.querySelectorAll(".delete-garden-btn").forEach(function(btn) {
    btn.onclick = function() { deleteGarden(btn.dataset.id); };
  });
}

function showNewGardenDialog() {
  var dialog = document.createElement("dialog");
  dialog.id = "new-garden-dialog";
  dialog.innerHTML = '\
    <article>\
      <header><h4>New Garden</h4></header>\
      <form id="new-garden-form">\
        <label>Name</label>\
        <input type="text" name="name" placeholder="Garden name" value="My Garden" required />\
        <label>Type</label>\
        <select name="garden_type">\
          <option value="garden_bed">🌱 Garden Bed</option>\
          <option value="planter">🪴 Planter</option>\
        </select>\
        <label>Shade</label>\
        <select name="shade_level">\
          <option value="full_sun">☀ Full Sun</option>\
          <option value="partial">⛅ Partial Shade</option>\
          <option value="shade">🌙 Full Shade</option>\
        </select>\
        <label>Planting Season</label>\
        <select name="planting_season">\
          <option value="spring">Spring</option>\
          <option value="summer">Summer</option>\
          <option value="fall">Fall</option>\
          <option value="winter">Winter</option>\
        </select>\
        <label>Size preset</label>\
        <select name="preset" id="size-preset">\
          <option value="4x4">4×4 ft (Small Planter)</option>\
          <option value="4x8">4×8 ft (Raised Bed)</option>\
          <option value="8x8">8×8 ft (Large Garden)</option>\
          <option value="custom">Custom</option>\
        </select>\
        <div id="custom-size" style="display:none">\
          <div style="display:flex;gap:0.5rem">\
            <input type="number" name="width" placeholder="Width (ft)" min="1" max="20" value="4" />\
            <input type="number" name="height" placeholder="Height (ft)" min="1" max="20" value="4" />\
          </div>\
        </div>\
        <div style="display:flex;gap:0.5rem;margin-top:1rem">\
          <button type="submit">Create</button>\
          <button type="button" class="secondary outline" id="cancel-new-garden">Cancel</button>\
        </div>\
      </form>\
    </article>';
  document.body.appendChild(dialog);
  dialog.showModal();

  document.getElementById("size-preset").onchange = function(e) {
    document.getElementById("custom-size").style.display = e.target.value === "custom" ? "block" : "none";
  };
  document.getElementById("cancel-new-garden").onclick = function() {
    dialog.close();
    dialog.remove();
  };
  document.getElementById("new-garden-form").onsubmit = async function(e) {
    e.preventDefault();
    var fd = new FormData(e.target);
    var preset = fd.get("preset");
    var w, h;
    if (preset === "custom") {
      w = parseInt(fd.get("width")) || 4;
      h = parseInt(fd.get("height")) || 4;
    } else {
      var parts = preset.split("x");
      w = parseInt(parts[0]);
      h = parseInt(parts[1]);
    }
    try {
      await apiFetch("/gardens", {
        method: "POST",
        body: {
          name: fd.get("name"),
          grid_width: w,
          grid_height: h,
          garden_type: fd.get("garden_type"),
          shade_level: fd.get("shade_level"),
          planting_season: fd.get("planting_season")
        }
      });
      dialog.close();
      dialog.remove();
      renderGardens();
    } catch (err) {
      alert("Error: " + err.message);
    }
  };
}

async function openGarden(id) {
  app.innerHTML = '<div class="loading">Loading garden…</div>';
  try {
    var data = await apiFetch("/gardens/" + id);
    currentGarden = data;
    gridPlacements = {};
    if (data.plants) {
      for (var i = 0; i < data.plants.length; i++) {
        var p = data.plants[i];
        var key = p.grid_x + "," + p.grid_y;
        gridPlacements[key] = p.plantplanner_plants || p;
      }
    }
    viewMode = "top";
    showView("builder");
  } catch (err) {
    app.innerHTML = '<div class="error-banner">' + err.message + '</div>';
  }
}

async function deleteGarden(id) {
  if (!confirm("Delete this garden?")) return;
  try {
    await apiFetch("/gardens/" + id, { method: "DELETE" });
    renderGardens();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

function escapeHtml(s) {
  var div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
