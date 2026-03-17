// gardens.js — My Gardens list view (save/load/create/delete)

async function renderGardens() {
  app.innerHTML = '<div class="loading">Loading gardens…</div>';
  try {
    gardens = await apiFetch("/gardens");
  } catch (err) {
    app.innerHTML = '<div class="error-banner">' + err.message + '</div>';
    return;
  }

  var html = '<h3>My Gardens</h3>';
  html += '<button id="new-garden-btn" class="outline">+ New Garden</button>';

  if (gardens.length === 0) {
    html += '<div class="empty-state"><p>No gardens yet. Create your first garden!</p></div>';
  } else {
    html += '<div class="card-grid">';
    for (var i = 0; i < gardens.length; i++) {
      var g = gardens[i];
      html += '\
        <article class="garden-card" data-id="' + g.id + '">\
          <header>\
            <strong>' + escapeHtml(g.name) + '</strong>\
            <span class="muted"> — ' + g.grid_width + '×' + g.grid_height + ' ft</span>\
          </header>\
          <footer>\
            <button class="open-garden-btn outline" data-id="' + g.id + '">Open</button>\
            <button class="delete-garden-btn secondary outline" data-id="' + g.id + '">Delete</button>\
          </footer>\
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
        <input type="text" name="name" placeholder="Garden name" value="My Garden" required />\
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
        <button type="submit">Create</button>\
        <button type="button" class="secondary" id="cancel-new-garden">Cancel</button>\
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
        body: { name: fd.get("name"), grid_width: w, grid_height: h }
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
