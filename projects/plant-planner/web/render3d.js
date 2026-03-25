// render3d.js — Three.js 3D planter scene (geometry helpers, scene, planter box, sync)

// Gradient texture for MeshToonMaterial (3-step cel shading)
var _toonGradient = null;
function getToonGradient() {
  if (_toonGradient) return _toonGradient;
  var canvas = document.createElement("canvas");
  canvas.width = 4; canvas.height = 1;
  var ctx = canvas.getContext("2d");
  // 3-step: dark | mid | light
  ctx.fillStyle = "#555"; ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = "#999"; ctx.fillRect(1, 0, 1, 1);
  ctx.fillStyle = "#ccc"; ctx.fillRect(2, 0, 1, 1);
  ctx.fillStyle = "#fff"; ctx.fillRect(3, 0, 1, 1);
  var tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  _toonGradient = tex;
  return tex;
}

function makeMaterial(color, style) {
  if (style === "wireframe") {
    return new THREE.MeshBasicMaterial({ color: color, wireframe: true });
  }
  if (style === "natural") {
    return new THREE.MeshStandardMaterial({ color: color, roughness: 0.7, metalness: 0.1 });
  }
  // default: toon
  return new THREE.MeshToonMaterial({ color: color, gradientMap: getToonGradient() });
}

function buildShapeMesh(desc, style) {
  var geom;
  var seg = desc.segments || 6;
  switch (desc.shape) {
    case "sphere":
      geom = new THREE.SphereGeometry(1, seg, seg);
      break;
    case "cone":
      geom = new THREE.ConeGeometry(1, 2, seg);
      break;
    case "box":
      geom = new THREE.BoxGeometry(1, 1, 1);
      break;
    case "cylinder":
    default:
      var rTop = desc.radiusTop != null ? desc.radiusTop : (desc.radius || 0.04);
      var rBot = desc.radiusBottom != null ? desc.radiusBottom : (desc.radius || 0.04);
      var h = desc.height || 0.5;
      geom = new THREE.CylinderGeometry(rTop, rBot, h, seg);
      var mat = makeMaterial(desc.color || "#4a7c3f", style);
      var mesh = new THREE.Mesh(geom, mat);
      if (desc.position) mesh.position.set(desc.position[0], desc.position[1], desc.position[2]);
      else mesh.position.y = h / 2;
      if (desc.rotation) mesh.rotation.set(desc.rotation[0], desc.rotation[1], desc.rotation[2]);
      if (desc.scale) mesh.scale.set(desc.scale[0], desc.scale[1], desc.scale[2]);
      return mesh;
  }
  var mat = makeMaterial(desc.color || "#888", style);
  var mesh = new THREE.Mesh(geom, mat);
  if (desc.position) mesh.position.set(desc.position[0], desc.position[1], desc.position[2]);
  if (desc.rotation) mesh.rotation.set(desc.rotation[0], desc.rotation[1], desc.rotation[2]);
  if (desc.scale) mesh.scale.set(desc.scale[0], desc.scale[1], desc.scale[2]);
  return mesh;
}

// buildPlantMesh is now in plant-models.js

function getSceneBgColor(style) {
  if (style === "wireframe") return "#1a1a2e";
  return "#E8EEF4"; // soft sky blue-grey
}

function init3DView(containerId, garden, placements) {
  var container = document.getElementById(containerId);
  if (!container) return null;

  // getBoundingClientRect() forces a synchronous reflow, returning accurate
  // dimensions even immediately after innerHTML insertion on mobile.
  var rect = container.getBoundingClientRect();
  var w = rect.width || 400;
  var h = rect.height || Math.round((rect.width || 400) * 3 / 4);

  // Scene
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(getSceneBgColor(renderStyle));

  // Camera — ensure minimum distance for small grids
  var camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
  var gw = garden.grid_width;
  var gh = garden.grid_height;
  var maxDim = Math.max(gw, gh);
  camera.position.set(
    Math.max(maxDim * 0.8, 4),
    Math.max(maxDim * 0.7, 3.5),
    Math.max(maxDim * 0.8, 4)
  );
  camera.lookAt(0, 0, 0);

  // Renderer
  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  // Lights — brighter ambient + main directional + warm fill
  var ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambientLight);
  var dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 8, 5);
  scene.add(dirLight);
  var fillLight = new THREE.DirectionalLight(0xFFF5E1, 0.3);
  fillLight.position.set(-3, 4, -3);
  scene.add(fillLight);

  // OrbitControls
  var controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.minDistance = 2;
  controls.maxDistance = maxDim * 3;
  controls.maxPolarAngle = Math.PI / 2;
  controls.target.set(0, 0, 0);
  controls.update();

  // Ground plane (warm sandy beige)
  var groundGeom = new THREE.PlaneGeometry(maxDim * 4, maxDim * 4);
  var groundMat = makeMaterial("#D4C9B8", renderStyle);
  var ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  ground.name = "ground";
  scene.add(ground);

  // Build planter box
  var boxGroup = buildPlanterBox(gw, gh, garden.garden_type === "planter");
  scene.add(boxGroup);

  // Plant meshes group
  var plantsGroup = new THREE.Group();
  plantsGroup.name = "plants";
  scene.add(plantsGroup);

  var handle = {
    scene: scene,
    camera: camera,
    renderer: renderer,
    controls: controls,
    container: container,
    plantsGroup: plantsGroup,
    garden: garden,
    animId: null
  };

  // Populate plants
  syncSceneWithPlacements(handle, placements);

  // Animation loop
  function animate() {
    handle.animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // Resize observer
  var ro = new ResizeObserver(function(entries) {
    var entry = entries[0];
    var cw = entry.contentRect.width;
    var ch = entry.contentRect.height;
    if (cw > 0 && ch > 0) {
      camera.aspect = cw / ch;
      camera.updateProjectionMatrix();
      renderer.setSize(cw, ch);
    }
  });
  ro.observe(container);
  handle._resizeObserver = ro;

  // Safety net: if the ResizeObserver's initial fire saw 0px (layout not yet
  // committed), re-apply the correct size after a short delay.
  setTimeout(function() {
    var cw = container.clientWidth;
    var ch = container.clientHeight;
    if (cw > 0 && ch > 0 && (Math.abs(cw - renderer.domElement.width) > 2 || Math.abs(ch - renderer.domElement.height) > 2)) {
      camera.aspect = cw / ch;
      camera.updateProjectionMatrix();
      renderer.setSize(cw, ch);
    }
  }, 150);

  return handle;
}

function buildPlanterBox(gw, gh, isPlanter) {
  var group = new THREE.Group();
  var style = renderStyle || "toon";

  if (isPlanter) {
    // === PLANTER: raised box with wood walls and corner posts ===
    var wallH = 0.4;
    var wallThick = 0.06;
    var woodColor = "#A0784C";
    var postColor = "#8B6914";
    var soilColor = "#5C3D1E";

    // Soil fill (sits inside the planter)
    var soilGeom = new THREE.BoxGeometry(gw, wallH - 0.04, gh);
    var soilMat = makeMaterial(soilColor, style);
    var soil = new THREE.Mesh(soilGeom, soilMat);
    soil.position.y = (wallH - 0.04) / 2 - 0.02;
    group.add(soil);

    // 4 walls
    var wallMat = makeMaterial(woodColor, style);

    var frontGeom = new THREE.BoxGeometry(gw + wallThick * 2, wallH, wallThick);
    var front = new THREE.Mesh(frontGeom, wallMat);
    front.position.set(0, wallH / 2, gh / 2 + wallThick / 2);
    group.add(front);

    var back = front.clone();
    back.position.z = -gh / 2 - wallThick / 2;
    group.add(back);

    var sideGeom = new THREE.BoxGeometry(wallThick, wallH, gh);
    var left = new THREE.Mesh(sideGeom, wallMat);
    left.position.set(-gw / 2 - wallThick / 2, wallH / 2, 0);
    group.add(left);

    var right = left.clone();
    right.position.x = gw / 2 + wallThick / 2;
    group.add(right);

    // Corner posts (taller than walls)
    var postH = wallH + 0.08;
    var postR = 0.04;
    var postGeom = new THREE.CylinderGeometry(postR, postR, postH, 6);
    var postMat = makeMaterial(postColor, style);
    var corners = [
      [-gw / 2 - wallThick / 2, postH / 2, -gh / 2 - wallThick / 2],
      [ gw / 2 + wallThick / 2, postH / 2, -gh / 2 - wallThick / 2],
      [-gw / 2 - wallThick / 2, postH / 2,  gh / 2 + wallThick / 2],
      [ gw / 2 + wallThick / 2, postH / 2,  gh / 2 + wallThick / 2]
    ];
    for (var c = 0; c < corners.length; c++) {
      var post = new THREE.Mesh(postGeom, postMat);
      post.position.set(corners[c][0], corners[c][1], corners[c][2]);
      group.add(post);
    }

    // Plank lines on front/back walls
    var plankMat = new THREE.LineBasicMaterial({ color: 0x6B4226, transparent: true, opacity: 0.5 });
    var plankY = [wallH * 0.33, wallH * 0.66];
    var plankPts = [];
    for (var pi = 0; pi < plankY.length; pi++) {
      var py = plankY[pi];
      // front
      plankPts.push(new THREE.Vector3(-gw / 2, py, gh / 2 + wallThick));
      plankPts.push(new THREE.Vector3(gw / 2, py, gh / 2 + wallThick));
      // back
      plankPts.push(new THREE.Vector3(-gw / 2, py, -gh / 2 - wallThick));
      plankPts.push(new THREE.Vector3(gw / 2, py, -gh / 2 - wallThick));
      // left
      plankPts.push(new THREE.Vector3(-gw / 2 - wallThick, py, -gh / 2));
      plankPts.push(new THREE.Vector3(-gw / 2 - wallThick, py, gh / 2));
      // right
      plankPts.push(new THREE.Vector3(gw / 2 + wallThick, py, -gh / 2));
      plankPts.push(new THREE.Vector3(gw / 2 + wallThick, py, gh / 2));
    }
    var plankGeom = new THREE.BufferGeometry().setFromPoints(plankPts);
    group.add(new THREE.LineSegments(plankGeom, plankMat));

    // Grid lines on soil surface
    var soilTop = wallH - 0.04;
    var gridMat = new THREE.LineBasicMaterial({ color: 0x7a6a5a, transparent: true, opacity: 0.3 });
    var gridPoints = [];
    for (var x = -gw / 2; x <= gw / 2; x++) {
      gridPoints.push(new THREE.Vector3(x, soilTop, -gh / 2));
      gridPoints.push(new THREE.Vector3(x, soilTop, gh / 2));
    }
    for (var z = -gh / 2; z <= gh / 2; z++) {
      gridPoints.push(new THREE.Vector3(-gw / 2, soilTop, z));
      gridPoints.push(new THREE.Vector3(gw / 2, soilTop, z));
    }
    var gridGeom = new THREE.BufferGeometry().setFromPoints(gridPoints);
    group.add(new THREE.LineSegments(gridGeom, gridMat));

  } else {
    // === GARDEN BED: low border with mounded soil ===
    var bedH = 0.12;
    var bedThick = 0.05;
    var borderColor = "#6D4C2A";
    var bedSoilColor = "#7B5033";

    // Mounded soil (thicker, slightly above border)
    var moundGeom = new THREE.BoxGeometry(gw, 0.1, gh);
    var moundMat = makeMaterial(bedSoilColor, style);
    var mound = new THREE.Mesh(moundGeom, moundMat);
    mound.position.y = 0.05;
    group.add(mound);

    // Thin dark top layer (loose soil texture)
    var topSoilGeom = new THREE.BoxGeometry(gw - 0.02, 0.02, gh - 0.02);
    var topSoilMat = makeMaterial("#8B6B4A", style);
    var topSoil = new THREE.Mesh(topSoilGeom, topSoilMat);
    topSoil.position.y = 0.11;
    group.add(topSoil);

    // 4 low border walls
    var borderMat = makeMaterial(borderColor, style);

    var frontGeom = new THREE.BoxGeometry(gw + bedThick * 2, bedH, bedThick);
    var front = new THREE.Mesh(frontGeom, borderMat);
    front.position.set(0, bedH / 2, gh / 2 + bedThick / 2);
    group.add(front);

    var back = front.clone();
    back.position.z = -gh / 2 - bedThick / 2;
    group.add(back);

    var sideGeom = new THREE.BoxGeometry(bedThick, bedH, gh);
    var left = new THREE.Mesh(sideGeom, borderMat);
    left.position.set(-gw / 2 - bedThick / 2, bedH / 2, 0);
    group.add(left);

    var right = left.clone();
    right.position.x = gw / 2 + bedThick / 2;
    group.add(right);

    // Grid lines on soil surface
    var gridMat = new THREE.LineBasicMaterial({ color: 0x6a5a4a, transparent: true, opacity: 0.25 });
    var gridPoints = [];
    for (var x = -gw / 2; x <= gw / 2; x++) {
      gridPoints.push(new THREE.Vector3(x, 0.12, -gh / 2));
      gridPoints.push(new THREE.Vector3(x, 0.12, gh / 2));
    }
    for (var z = -gh / 2; z <= gh / 2; z++) {
      gridPoints.push(new THREE.Vector3(-gw / 2, 0.12, z));
      gridPoints.push(new THREE.Vector3(gw / 2, 0.12, z));
    }
    var gridGeom = new THREE.BufferGeometry().setFromPoints(gridPoints);
    group.add(new THREE.LineSegments(gridGeom, gridMat));
  }

  return group;
}

function syncSceneWithPlacements(handle, placements) {
  if (!handle) return;
  var pg = handle.plantsGroup;
  var garden = handle.garden;
  var gw = garden.grid_width;
  var gh = garden.grid_height;
  var style = renderStyle || "toon";
  // Plants sit on top of the soil surface
  var soilTop = garden.garden_type === "planter" ? 0.36 : 0.12;

  // Clear existing plants
  while (pg.children.length > 0) {
    var child = pg.children[0];
    pg.remove(child);
    disposeObject(child);
  }

  // Add plants from placements
  for (var key in placements) {
    var parts = key.split(",");
    var gx = parseInt(parts[0]);
    var gy = parseInt(parts[1]);
    var plant = placements[key];

    var mesh = buildPlantMesh(plant, style);
    // Position: grid cell center, offset so grid is centered at origin
    mesh.position.x = gx - gw / 2 + 0.5;
    mesh.position.z = gy - gh / 2 + 0.5;
    mesh.position.y = soilTop;
    mesh.userData = { gridKey: key, plantId: plant.id };
    pg.add(mesh);
  }
}

function setRenderStyle(handle, newStyle) {
  if (!handle) return;
  renderStyle = newStyle;

  // Update scene background
  handle.scene.background = new THREE.Color(getSceneBgColor(newStyle));

  // Rebuild planter box and ground (keep plantsGroup, lights, and interaction helpers)
  var garden = handle.garden;
  var toRemove = [];
  handle.scene.children.forEach(function(child) {
    if (child !== handle.plantsGroup &&
        child.type !== "AmbientLight" &&
        child.type !== "DirectionalLight" &&
        child.name !== "hitPlane" &&
        child.name !== "cellHighlight") {
      toRemove.push(child);
    }
  });
  toRemove.forEach(function(child) {
    handle.scene.remove(child);
    disposeObject(child);
  });

  // Re-add ground
  var maxDim = Math.max(garden.grid_width, garden.grid_height);
  var groundGeom = new THREE.PlaneGeometry(maxDim * 4, maxDim * 4);
  var groundMat = makeMaterial("#D4C9B8", newStyle);
  var ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  ground.name = "ground";
  handle.scene.add(ground);

  var newBox = buildPlanterBox(garden.grid_width, garden.grid_height, garden.garden_type === "planter");
  handle.scene.add(newBox);

  // Rebuild all plants with new material (after box so plants are on top)
  syncSceneWithPlacements(handle, gridPlacements);
}

function dispose3DView(handle) {
  if (!handle) return;
  if (handle.animId) cancelAnimationFrame(handle.animId);
  if (handle._resizeObserver) handle._resizeObserver.disconnect();
  if (handle.controls) handle.controls.dispose();

  // Dispose all scene objects
  handle.scene.traverse(function(obj) {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach(function(m) { m.dispose(); });
      } else {
        obj.material.dispose();
      }
    }
  });

  if (handle.renderer) {
    handle.renderer.dispose();
    if (handle.container) handle.container.innerHTML = "";
  }
}

function disposeObject(obj) {
  obj.traverse(function(child) {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) {
        child.material.forEach(function(m) { m.dispose(); });
      } else {
        child.material.dispose();
      }
    }
  });
}

// ── 3D Drag-and-Drop Interaction ───────────────────────────────────────────

function getRaycastCell(handle, clientX, clientY) {
  if (!handle || !handle.hitPlane) return null;
  var canvas = handle.renderer.domElement;
  var rect = canvas.getBoundingClientRect();
  var mouse = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  var raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, handle.camera);
  var hits = raycaster.intersectObject(handle.hitPlane);
  if (hits.length === 0) return null;
  var pt = hits[0].point;
  var gw = handle.garden.grid_width;
  var gh = handle.garden.grid_height;
  var gx = Math.floor(pt.x + gw / 2);
  var gy = Math.floor(pt.z + gh / 2);
  if (gx < 0 || gx >= gw || gy < 0 || gy >= gh) return null;
  return { gx: gx, gy: gy };
}

function showCellHighlight(handle, gx, gy) {
  if (!handle || !handle.cellHighlight) return;
  var gw = handle.garden.grid_width;
  var gh = handle.garden.grid_height;
  handle.cellHighlight.position.x = gx - gw / 2 + 0.5;
  handle.cellHighlight.position.z = gy - gh / 2 + 0.5;
  handle.cellHighlight.visible = true;
}

function hideCellHighlight(handle) {
  if (!handle || !handle.cellHighlight) return;
  handle.cellHighlight.visible = false;
}

function lockBirdsEye(handle) {
  if (!handle || handle._birdsEyeLocked) return;
  handle._savedMinPolar = handle.controls.minPolarAngle;
  handle._savedMaxPolar = handle.controls.maxPolarAngle;
  handle.controls.minPolarAngle = 0;
  handle.controls.maxPolarAngle = 0.001;
  handle._birdsEyeLocked = true;
  handle.controls.update();
}

function unlockCamera(handle) {
  if (!handle || !handle._birdsEyeLocked) return;
  handle.controls.minPolarAngle = handle._savedMinPolar || 0;
  handle.controls.maxPolarAngle = handle._savedMaxPolar !== undefined ? handle._savedMaxPolar : Math.PI / 2;
  handle._birdsEyeLocked = false;
  handle.controls.update();
}

function setup3DDragDrop(handle, callbacks) {
  if (!handle) return;
  var garden = handle.garden;
  var gw = garden.grid_width;
  var gh = garden.grid_height;
  var soilTop = garden.garden_type === "planter" ? 0.36 : 0.12;

  // Invisible hit plane at soil level for raycasting
  var hitGeom = new THREE.PlaneGeometry(gw, gh);
  var hitMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
  var hitPlane = new THREE.Mesh(hitGeom, hitMat);
  hitPlane.rotation.x = -Math.PI / 2;
  hitPlane.position.y = soilTop;
  hitPlane.name = "hitPlane";
  handle.scene.add(hitPlane);
  handle.hitPlane = hitPlane;

  // Semi-transparent cell highlight at soil level
  var hlGeom = new THREE.PlaneGeometry(0.92, 0.92);
  var hlMat = new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthTest: false });
  var highlight = new THREE.Mesh(hlGeom, hlMat);
  highlight.rotation.x = -Math.PI / 2;
  highlight.position.y = soilTop + 0.01;
  highlight.name = "cellHighlight";
  highlight.visible = false;
  handle.scene.add(highlight);
  handle.cellHighlight = highlight;

  var canvas = handle.renderer.domElement;

  canvas.addEventListener("dragover", function(e) {
    if (!draggedPlant) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    lockBirdsEye(handle);
    var cell = getRaycastCell(handle, e.clientX, e.clientY);
    if (cell) showCellHighlight(handle, cell.gx, cell.gy);
    else hideCellHighlight(handle);
  });

  canvas.addEventListener("drop", function(e) {
    e.preventDefault();
    var cell = getRaycastCell(handle, e.clientX, e.clientY);
    hideCellHighlight(handle);
    unlockCamera(handle);
    if (cell) callbacks.onDrop(cell.gx, cell.gy);
    else callbacks.onLeave();
  });

  canvas.addEventListener("dragleave", function() {
    hideCellHighlight(handle);
    unlockCamera(handle);
    callbacks.onLeave();
  });
}
