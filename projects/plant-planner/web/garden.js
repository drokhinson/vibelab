// garden.js — 3D grid builder with direct drag-and-drop onto the Three.js scene

function renderBuilder() {
  if (!currentGarden) { showView("gardens"); return; }
  var g = currentGarden;

  var html = '<div class="builder-header">';
  html += '<div class="builder-title">';
  html += '<h4>' + escapeHtml(g.name) + '</h4>';
  html += '<span class="text-sm opacity-50">' + g.grid_width + '×' + g.grid_height + ' ft</span>';
  html += '</div>';
  html += '<div class="builder-actions">';
  html += '<button id="save-garden" class="btn btn-sm btn-primary gap-1"><i data-lucide="save"></i> Save</button>';
  html += '<button id="reseed-garden" class="btn btn-sm btn-outline gap-1"><i data-lucide="refresh-cw"></i> Reseed</button>';
  html += '</div></div>';

  html += '<div class="builder-layout">';

  // Catalog sidebar
  html += '<div id="catalog-sidebar" class="catalog-sidebar">';
  html += '<div class="catalog-filters">' + renderCatalogFilters() + '</div>';
  html += '<div class="catalog-list-wrapper" id="catalog-list-wrapper">' + renderCatalogList() + '</div>';
  html += '</div>';

  // 3D view (full width — drag catalog plants directly onto scene)
  html += '<div class="builder-main">';
  html += '<div class="render3d-pane">';
  html += '<div class="render3d-header">';
  html += '<span class="render3d-label"><i data-lucide="box"></i> Drag from catalog to place &nbsp;·&nbsp; hold to move &nbsp;·&nbsp; tap to remove</span>';
  html += '</div>';
  html += '<div id="render3d-container"></div>';
  html += '</div>';
  html += '</div>'; // .builder-main
  html += '</div>'; // .builder-layout

  // Plant info tooltip
  html += '<div id="plant-tooltip" class="plant-tooltip" style="display:none"></div>';

  app.innerHTML = html;

  bindCatalogEvents();
  bindBuilderButtons();
  _initIcons();

  // Initialize 3D scene, then wire up drag-drop and click handlers
  init3DScene(g);
}

function init3DScene(g) {
  if (scene3DHandle) {
    dispose3DView(scene3DHandle);
    scene3DHandle = null;
  }
  // Double RAF ensures CSS layout is fully committed before reading container dimensions
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      scene3DHandle = init3DView("render3d-container", g, gridPlacements);
      if (scene3DHandle) {
        bind3DDragDrop();
        bind3DClick();
        bindPlantDrag(scene3DHandle);
      }
    });
  });
}

function sync3DView() {
  if (scene3DHandle) {
    syncSceneWithPlacements(scene3DHandle, gridPlacements);
  }
}

function bind3DDragDrop() {
  setup3DDragDrop(scene3DHandle, {
    onDrop: function(gx, gy) {
      if (draggedPlant) {
        gridPlacements[gx + "," + gy] = draggedPlant;
        draggedPlant = null;
        sync3DView();
      }
    },
    onLeave: function() {
      draggedPlant = null;
    }
  });
}

function bind3DClick() {
  var canvas = scene3DHandle.renderer.domElement;
  canvas.addEventListener("click", function(e) {
    if (Date.now() - _lastPickupEndTime < 300) return;
    var rect = canvas.getBoundingClientRect();
    var mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    var raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, scene3DHandle.camera);
    var hits = raycaster.intersectObjects(scene3DHandle.plantsGroup.children, true);
    if (hits.length > 0) {
      var obj = hits[0].object;
      while (obj && !obj.userData.gridKey) obj = obj.parent;
      if (obj && obj.userData.gridKey) {
        delete gridPlacements[obj.userData.gridKey];
        sync3DView();
      }
    }
  });
}

function showTooltip(el, plant) {
  var tip = document.getElementById("plant-tooltip");
  if (!tip) return;
  tip.innerHTML =
    '<strong>' + escapeHtml(plant.name) + '</strong><br>' +
    sunlightIcon(plant.sunlight) + ' ' + sunlightLabel(plant.sunlight) +
    ' | ' + plant.height_inches + '" tall' +
    (plant.description ? '<br><span class="opacity-50 text-sm">' + escapeHtml(plant.description) + '</span>' : '');
  tip.style.display = "block";
  var rect = el.getBoundingClientRect();
  tip.style.left = rect.left + "px";
  tip.style.top = (rect.bottom + 4) + "px";
}

function hideTooltip() {
  var tip = document.getElementById("plant-tooltip");
  if (tip) tip.style.display = "none";
}

function bindBuilderButtons() {
  document.getElementById("save-garden").onclick = saveGarden;
  document.getElementById("reseed-garden").onclick = reseedGarden;
}

async function saveGarden() {
  var btn = document.getElementById("save-garden");
  btn.classList.add("loading");
  btn.disabled = true;
  var placements = [];
  for (var key in gridPlacements) {
    var parts = key.split(",");
    placements.push({
      plant_id: gridPlacements[key].id,
      grid_x: parseInt(parts[0]),
      grid_y: parseInt(parts[1])
    });
  }
  try {
    await apiFetch("/gardens/" + currentGarden.id + "/plants", {
      method: "PUT",
      body: { plants: placements }
    });
    btn.textContent = "Saved!";
    setTimeout(function() { btn.innerHTML = '<i data-lucide="save"></i> Save'; _initIcons(); }, 1500);
  } catch (err) {
    alert("Save failed: " + err.message);
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}

async function reseedGarden() {
  if (!confirm("Reseed for next season? This will clear all current plants and save an empty garden.")) return;
  var btn = document.getElementById("reseed-garden");
  btn.classList.add("loading");
  btn.disabled = true;
  try {
    await apiFetch("/gardens/" + currentGarden.id + "/plants", {
      method: "PUT",
      body: { plants: [] }
    });
    gridPlacements = {};
    btn.textContent = "Reseeded!";
    setTimeout(function() {
      btn.innerHTML = '<i data-lucide="refresh-cw"></i> Reseed';
      _initIcons();
      renderBuilder();
    }, 1200);
  } catch (err) {
    alert("Reseed failed: " + err.message);
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}
