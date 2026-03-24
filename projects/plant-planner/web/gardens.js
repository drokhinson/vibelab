// gardens.js — My Gardens list view (save/load/create/delete)

async function renderGardens() {
  app.innerHTML = '<div class="flex flex-col items-center justify-center py-12 text-base-content/50 gap-3"><span class="loading loading-spinner loading-md text-primary"></span>Loading gardens...</div>';
  try {
    gardens = await apiFetch("/gardens");
  } catch (err) {
    app.innerHTML = '<div class="error-banner">' + err.message + '</div>';
    return;
  }

  var html = '<div class="flex justify-between items-center mb-5">';
  html += '<h3 class="text-xl font-display font-semibold">My Gardens</h3>';
  html += '<button id="new-garden-btn" class="btn btn-primary btn-sm gap-1"><i data-lucide="plus-circle" style="width:1em;height:1em"></i> New Garden</button>';
  html += '</div>';

  if (gardens.length === 0) {
    html += '<div class="empty-state-illustration">' +
      '<svg width="200" height="160" viewBox="0 0 200 160" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<ellipse cx="100" cy="148" rx="70" ry="8" fill="currentColor" opacity="0.06"/>' +
        '<rect x="40" y="100" width="120" height="40" rx="6" fill="#7BAE7F" opacity="0.15"/>' +
        '<rect x="45" y="95" width="110" height="10" rx="3" fill="#7BAE7F" opacity="0.25"/>' +
        '<path d="M70 95 Q70 70 60 55 Q68 60 70 50 Q72 60 80 55 Q70 70 70 95Z" fill="#7BAE7F" opacity="0.5"/>' +
        '<path d="M100 95 Q98 60 88 40 Q98 50 100 35 Q102 50 112 40 Q102 60 100 95Z" fill="#7BAE7F" opacity="0.65"/>' +
        '<path d="M130 95 Q130 72 122 60 Q128 64 130 55 Q132 64 138 60 Q130 72 130 95Z" fill="#7BAE7F" opacity="0.45"/>' +
        '<circle cx="88" cy="42" r="5" fill="#E8856C" opacity="0.8"/>' +
        '<circle cx="112" cy="38" r="4" fill="#E8856C" opacity="0.7"/>' +
        '<circle cx="60" cy="56" r="3.5" fill="#B8A9D4" opacity="0.6"/>' +
      '</svg>' +
      '<p class="text-base-content/50">No gardens yet. Create your first garden!</p>' +
    '</div>';
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
        <div class="garden-card" data-id="' + g.id + '" style="--i:' + i + '">\
          <div>\
            <div class="garden-card-title">' + escapeHtml(g.name) + '</div>\
            <div class="garden-card-meta">\
              <span class="garden-chip">' + typeIcon + ' ' + typeLabel + '</span>\
              <span class="garden-chip">' + g.grid_width + '×' + g.grid_height + ' ft</span>\
            </div>\
            <div class="garden-card-meta mt-1">\
              <span class="garden-chip">' + shadeIcon + ' ' + shadeLabel + '</span>\
              <span class="garden-chip">' + season + '</span>\
            </div>\
          </div>\
          <div class="garden-card-actions">\
            <button class="btn btn-sm btn-primary gap-1 open-garden-btn" data-id="' + g.id + '"><i data-lucide="layout-grid" style="width:0.85em;height:0.85em"></i> Open</button>\
            <button class="btn btn-sm btn-ghost text-error gap-1 delete-garden-btn" data-id="' + g.id + '"><i data-lucide="trash-2" style="width:0.85em;height:0.85em"></i> Delete</button>\
          </div>\
        </div>';
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
  _initIcons();
}

function showNewGardenDialog() {
  var dialog = document.createElement("dialog");
  dialog.id = "new-garden-dialog";
  dialog.innerHTML = '\
    <div class="dialog-body">\
      <div class="dialog-header"><i data-lucide="plus-circle"></i> New Garden</div>\
      <form id="new-garden-form" class="space-y-3">\
        <div>\
          <label class="label"><span class="label-text text-sm">Name</span></label>\
          <input type="text" name="name" placeholder="Garden name" value="My Garden" required class="input input-bordered w-full input-sm" />\
        </div>\
        <div>\
          <label class="label"><span class="label-text text-sm">Type</span></label>\
          <select name="garden_type" class="select select-bordered w-full select-sm">\
            <option value="garden_bed">Garden Bed</option>\
            <option value="planter">Planter</option>\
          </select>\
        </div>\
        <div>\
          <label class="label"><span class="label-text text-sm">Shade</span></label>\
          <select name="shade_level" class="select select-bordered w-full select-sm">\
            <option value="full_sun">Full Sun</option>\
            <option value="partial">Partial Shade</option>\
            <option value="shade">Full Shade</option>\
          </select>\
        </div>\
        <div>\
          <label class="label"><span class="label-text text-sm">Planting Season</span></label>\
          <select name="planting_season" class="select select-bordered w-full select-sm">\
            <option value="spring">Spring</option>\
            <option value="summer">Summer</option>\
            <option value="fall">Fall</option>\
            <option value="winter">Winter</option>\
          </select>\
        </div>\
        <div>\
          <label class="label"><span class="label-text text-sm">Size</span></label>\
          <select name="preset" id="size-preset" class="select select-bordered w-full select-sm">\
            <option value="4x4">4x4 ft (Small Planter)</option>\
            <option value="4x8">4x8 ft (Raised Bed)</option>\
            <option value="8x8">8x8 ft (Large Garden)</option>\
            <option value="custom">Custom</option>\
          </select>\
        </div>\
        <div id="custom-size" style="display:none">\
          <div class="flex gap-2">\
            <input type="number" name="width" placeholder="Width (ft)" min="1" max="20" value="4" class="input input-bordered input-sm flex-1" />\
            <input type="number" name="height" placeholder="Height (ft)" min="1" max="20" value="4" class="input input-bordered input-sm flex-1" />\
          </div>\
        </div>\
        <div class="flex gap-2 pt-2">\
          <button type="submit" class="btn btn-primary btn-sm flex-1">Create</button>\
          <button type="button" class="btn btn-ghost btn-sm flex-1" id="cancel-new-garden">Cancel</button>\
        </div>\
      </form>\
    </div>';
  document.body.appendChild(dialog);
  dialog.showModal();
  _initIcons();

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
  app.innerHTML = '<div class="flex flex-col items-center justify-center py-12 text-base-content/50 gap-3"><span class="loading loading-spinner loading-md text-primary"></span>Loading garden...</div>';
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
