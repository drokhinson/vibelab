// render3d.js — Three.js 3D planter scene (geometry helpers, scene, planter box, sync)

function makeMaterial(color) {
  return new THREE.MeshStandardMaterial({ color: color, roughness: 0.7, metalness: 0.1 });
}

function buildShapeMesh(desc) {
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
      var mat = makeMaterial(desc.color || "#4a7c3f");
      var mesh = new THREE.Mesh(geom, mat);
      if (desc.position) mesh.position.set(desc.position[0], desc.position[1], desc.position[2]);
      else mesh.position.y = h / 2;
      if (desc.rotation) mesh.rotation.set(desc.rotation[0], desc.rotation[1], desc.rotation[2]);
      if (desc.scale) mesh.scale.set(desc.scale[0], desc.scale[1], desc.scale[2]);
      return mesh;
  }
  var mat = makeMaterial(desc.color || "#888");
  var mesh = new THREE.Mesh(geom, mat);
  if (desc.position) mesh.position.set(desc.position[0], desc.position[1], desc.position[2]);
  if (desc.rotation) mesh.rotation.set(desc.rotation[0], desc.rotation[1], desc.rotation[2]);
  if (desc.scale) mesh.scale.set(desc.scale[0], desc.scale[1], desc.scale[2]);
  return mesh;
}

// buildPlantMesh is now in plant-models.js

function getSceneBgColor() {
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
  scene.background = new THREE.Color(getSceneBgColor());

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
  var groundMat = makeMaterial("#D4C9B8");
  var ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  ground.name = "ground";
  scene.add(ground);

  // Build planter box. Five-way dispatch on garden_type — indoor pot vs
  // outdoor planter vs flat garden bed vs raised bed vs greenhouse.
  var boxGroup = buildPlanterBox(gw, gh, garden.garden_type || 'garden_bed');
  scene.add(boxGroup);

  // Plant meshes group
  var plantsGroup = new THREE.Group();
  plantsGroup.name = "plants";
  scene.add(plantsGroup);

  // Shadow disks group (iter 6: shading warnings — translucent ground shadows)
  var shadowsGroup = new THREE.Group();
  shadowsGroup.name = "shadows";
  scene.add(shadowsGroup);

  var soilTop = _soilTopFor(garden.garden_type);
  var handle = {
    scene: scene,
    camera: camera,
    renderer: renderer,
    controls: controls,
    container: container,
    plantsGroup: plantsGroup,
    shadowsGroup: shadowsGroup,
    garden: garden,
    animId: null,
    cellSize: 1,
    gridOriginX: -gw / 2 + 0.5,
    gridOriginZ: -gh / 2 + 0.5,
    gridWidth: gw,
    gridHeight: gh,
    soilTop: soilTop
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

// Soil-surface Y for each garden type — used by plant placement, drag preview,
// click hit-testing, etc. Centralised here so all five mesh styles agree.
function _soilTopFor(gardenType) {
  switch (gardenType) {
    case 'indoor':     return 0.30;   // top of the pot soil
    case 'outdoor':    return 0.30;   // small terracotta planter
    case 'raised_bed': return 0.36;   // legacy raised wood box
    case 'greenhouse': return 0.12;   // garden bed inside a glass shell
    case 'garden_bed':
    default:           return 0.12;   // low-border earth bed
  }
}

function buildPlanterBox(gw, gh, gardenType) {
  switch (gardenType) {
    case 'indoor':     return _buildIndoorPot(gw, gh);
    case 'outdoor':    return _buildOutdoorPlanter(gw, gh);
    case 'raised_bed': return _buildRaisedBed(gw, gh);
    case 'greenhouse': return _buildGreenhouse(gw, gh);
    case 'garden_bed':
    default:           return _buildGardenBed(gw, gh);
  }
}

// Helper: 4-corner border walls + grid lines on top. Used by several types.
function _addBorderAndGrid(group, gw, gh, opts) {
  var wallH      = opts.wallH;
  var wallThick  = opts.wallThick;
  var wallMat    = opts.wallMat;
  var soilTop    = opts.soilTop;
  var gridColor  = opts.gridColor || 0x6a5a4a;
  var gridOpacity = opts.gridOpacity || 0.25;

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

  var gridMat = new THREE.LineBasicMaterial({ color: gridColor, transparent: true, opacity: gridOpacity });
  var gridPoints = [];
  for (var x = -gw / 2; x <= gw / 2; x++) {
    gridPoints.push(new THREE.Vector3(x, soilTop, -gh / 2));
    gridPoints.push(new THREE.Vector3(x, soilTop,  gh / 2));
  }
  for (var z = -gh / 2; z <= gh / 2; z++) {
    gridPoints.push(new THREE.Vector3(-gw / 2, soilTop, z));
    gridPoints.push(new THREE.Vector3( gw / 2, soilTop, z));
  }
  var gridGeom = new THREE.BufferGeometry().setFromPoints(gridPoints);
  group.add(new THREE.LineSegments(gridGeom, gridMat));
}

// Indoor pot — round terracotta cylinder with a saucer underneath.
// gw/gh come from the wizard in inches; we treat the pot as a single round
// cell roughly max(gw, gh) in diameter, scaled into world units.
function _buildIndoorPot(gw, gh) {
  var group = new THREE.Group();
  // World scale: 1 ft = 1 unit in our scene; pot is sized in inches → /12.
  var diam = Math.max(0.6, Math.max(gw, gh) / 12);
  var topR = diam / 2;
  var botR = topR * 0.78;            // slight taper, classic pot silhouette
  var potH = 0.30;
  var rimH = 0.04;

  // Saucer (thin wider disk under the pot)
  var saucerGeom = new THREE.CylinderGeometry(topR + 0.06, topR + 0.06, 0.025, 24);
  var saucerMat  = makeMaterial("#A04E2F");
  var saucer     = new THREE.Mesh(saucerGeom, saucerMat);
  saucer.position.y = 0.012;
  group.add(saucer);

  // Pot body (slightly tapered cylinder)
  var bodyGeom = new THREE.CylinderGeometry(topR, botR, potH, 28, 1, true);
  var bodyMat  = makeMaterial("#B85A3A");
  var body     = new THREE.Mesh(bodyGeom, bodyMat);
  body.position.y = 0.025 + potH / 2;
  group.add(body);

  // Rim (slightly wider, darker)
  var rimGeom = new THREE.CylinderGeometry(topR + 0.025, topR + 0.025, rimH, 28, 1, true);
  var rimMat  = makeMaterial("#984A2D");
  var rim     = new THREE.Mesh(rimGeom, rimMat);
  rim.position.y = 0.025 + potH - rimH / 2;
  group.add(rim);

  // Soil disk on top
  var soilGeom = new THREE.CylinderGeometry(topR - 0.02, topR - 0.02, 0.04, 24);
  var soilMat  = makeMaterial("#5C3D1E");
  var soil     = new THREE.Mesh(soilGeom, soilMat);
  soil.position.y = _soilTopFor('indoor') - 0.02;
  group.add(soil);

  return group;
}

// Outdoor planter — small terracotta box with grid + low walls (deck/balcony).
function _buildOutdoorPlanter(gw, gh) {
  var group = new THREE.Group();
  var wallH = 0.30;
  var wallThick = 0.05;
  var soilColor  = "#5A3A20";
  var clayColor  = "#B0654A";
  var rimColor   = "#8E4F38";

  // Soil fill
  var soilGeom = new THREE.BoxGeometry(gw, wallH - 0.04, gh);
  var soil = new THREE.Mesh(soilGeom, makeMaterial(soilColor));
  soil.position.y = (wallH - 0.04) / 2 - 0.02;
  group.add(soil);

  _addBorderAndGrid(group, gw, gh, {
    wallH: wallH,
    wallThick: wallThick,
    wallMat: makeMaterial(clayColor),
    soilTop: _soilTopFor('outdoor'),
    gridColor: 0x5a4a3a,
    gridOpacity: 0.25
  });

  // A darker clay rim along the top of each wall.
  var rimMat = makeMaterial(rimColor);
  var rimT = 0.025;
  var rimFrontGeom = new THREE.BoxGeometry(gw + wallThick * 2 + 0.02, rimT, wallThick + 0.02);
  var rimFront = new THREE.Mesh(rimFrontGeom, rimMat);
  rimFront.position.set(0, wallH + rimT / 2 - 0.005, gh / 2 + wallThick / 2);
  group.add(rimFront);
  var rimBack = rimFront.clone();
  rimBack.position.z = -gh / 2 - wallThick / 2;
  group.add(rimBack);
  var rimSideGeom = new THREE.BoxGeometry(wallThick + 0.02, rimT, gh);
  var rimLeft = new THREE.Mesh(rimSideGeom, rimMat);
  rimLeft.position.set(-gw / 2 - wallThick / 2, wallH + rimT / 2 - 0.005, 0);
  group.add(rimLeft);
  var rimRight = rimLeft.clone();
  rimRight.position.x = gw / 2 + wallThick / 2;
  group.add(rimRight);

  return group;
}

// Garden bed — current low-border style (unchanged from before).
function _buildGardenBed(gw, gh) {
  var group = new THREE.Group();
  var bedH = 0.12;
  var bedThick = 0.05;
  var borderColor = "#6D4C2A";
  var bedSoilColor = "#7B5033";

  var moundGeom = new THREE.BoxGeometry(gw, 0.1, gh);
  var mound = new THREE.Mesh(moundGeom, makeMaterial(bedSoilColor));
  mound.position.y = 0.05;
  group.add(mound);

  var topSoilGeom = new THREE.BoxGeometry(gw - 0.02, 0.02, gh - 0.02);
  var topSoil = new THREE.Mesh(topSoilGeom, makeMaterial("#8B6B4A"));
  topSoil.position.y = 0.11;
  group.add(topSoil);

  _addBorderAndGrid(group, gw, gh, {
    wallH: bedH,
    wallThick: bedThick,
    wallMat: makeMaterial(borderColor),
    soilTop: _soilTopFor('garden_bed'),
    gridColor: 0x6a5a4a,
    gridOpacity: 0.25
  });

  return group;
}

// Raised bed — taller wood box with corner posts and plank lines (was "planter").
function _buildRaisedBed(gw, gh) {
  var group = new THREE.Group();
  var wallH = 0.40;
  var wallThick = 0.06;
  var woodColor = "#A0784C";
  var postColor = "#8B6914";
  var soilColor = "#5C3D1E";

  // Soil fill
  var soilGeom = new THREE.BoxGeometry(gw, wallH - 0.04, gh);
  var soil = new THREE.Mesh(soilGeom, makeMaterial(soilColor));
  soil.position.y = (wallH - 0.04) / 2 - 0.02;
  group.add(soil);

  _addBorderAndGrid(group, gw, gh, {
    wallH: wallH,
    wallThick: wallThick,
    wallMat: makeMaterial(woodColor),
    soilTop: _soilTopFor('raised_bed'),
    gridColor: 0x7a6a5a,
    gridOpacity: 0.30
  });

  // Corner posts (taller than walls)
  var postH = wallH + 0.08;
  var postR = 0.04;
  var postGeom = new THREE.CylinderGeometry(postR, postR, postH, 6);
  var postMat = makeMaterial(postColor);
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

  // Plank lines on the four walls
  var plankMat = new THREE.LineBasicMaterial({ color: 0x6B4226, transparent: true, opacity: 0.5 });
  var plankY = [wallH * 0.33, wallH * 0.66];
  var plankPts = [];
  for (var pi = 0; pi < plankY.length; pi++) {
    var py = plankY[pi];
    plankPts.push(new THREE.Vector3(-gw / 2, py,  gh / 2 + wallThick));
    plankPts.push(new THREE.Vector3( gw / 2, py,  gh / 2 + wallThick));
    plankPts.push(new THREE.Vector3(-gw / 2, py, -gh / 2 - wallThick));
    plankPts.push(new THREE.Vector3( gw / 2, py, -gh / 2 - wallThick));
    plankPts.push(new THREE.Vector3(-gw / 2 - wallThick, py, -gh / 2));
    plankPts.push(new THREE.Vector3(-gw / 2 - wallThick, py,  gh / 2));
    plankPts.push(new THREE.Vector3( gw / 2 + wallThick, py, -gh / 2));
    plankPts.push(new THREE.Vector3( gw / 2 + wallThick, py,  gh / 2));
  }
  var plankGeom = new THREE.BufferGeometry().setFromPoints(plankPts);
  group.add(new THREE.LineSegments(plankGeom, plankMat));

  return group;
}

// Greenhouse — garden bed inside a translucent glass shell with peaked roof.
function _buildGreenhouse(gw, gh) {
  var group = _buildGardenBed(gw, gh);

  var glassColor = 0xCCEEFF;
  var frameColor = 0xBFC6CD;
  var glassMat = new THREE.MeshStandardMaterial({
    color: glassColor,
    transparent: true,
    opacity: 0.18,
    metalness: 0.0,
    roughness: 0.05,
    side: THREE.DoubleSide
  });
  var frameMat = new THREE.LineBasicMaterial({ color: frameColor, transparent: true, opacity: 0.85 });

  // Footprint slightly bigger than the bed so the glass sits on the lawn.
  var ow = gw + 0.4;
  var oh = gh + 0.4;
  var wallH = 0.85;
  var roofH = 0.45;

  // 4 vertical glass panes
  var paneFrontBackGeom = new THREE.PlaneGeometry(ow, wallH);
  var paneSideGeom      = new THREE.PlaneGeometry(oh, wallH);

  var paneFront = new THREE.Mesh(paneFrontBackGeom, glassMat);
  paneFront.position.set(0, wallH / 2, oh / 2);
  group.add(paneFront);
  var paneBack = paneFront.clone();
  paneBack.position.z = -oh / 2;
  paneBack.rotation.y = Math.PI;
  group.add(paneBack);

  var paneLeft = new THREE.Mesh(paneSideGeom, glassMat);
  paneLeft.position.set(-ow / 2, wallH / 2, 0);
  paneLeft.rotation.y = Math.PI / 2;
  group.add(paneLeft);
  var paneRight = paneLeft.clone();
  paneRight.position.x = ow / 2;
  paneRight.rotation.y = -Math.PI / 2;
  group.add(paneRight);

  // Peaked roof — two slanted planes meeting at the ridge.
  var ridgeY = wallH + roofH;
  var slope = Math.atan2(roofH, ow / 2);
  var slantLen = Math.sqrt((ow / 2) * (ow / 2) + roofH * roofH);
  var roofGeom = new THREE.PlaneGeometry(slantLen, oh);
  var roofA = new THREE.Mesh(roofGeom, glassMat);
  roofA.position.set(-ow / 4, (wallH + ridgeY) / 2, 0);
  roofA.rotation.z = slope;
  roofA.rotation.y = Math.PI / 2;
  group.add(roofA);
  var roofB = new THREE.Mesh(roofGeom, glassMat);
  roofB.position.set(ow / 4, (wallH + ridgeY) / 2, 0);
  roofB.rotation.z = -slope;
  roofB.rotation.y = Math.PI / 2;
  group.add(roofB);

  // Frame edges — 4 vertical posts + top + ridge + 4 sloped roof beams.
  var fp = [];
  // 4 corner posts
  fp.push(new THREE.Vector3(-ow / 2, 0,       -oh / 2)); fp.push(new THREE.Vector3(-ow / 2, wallH, -oh / 2));
  fp.push(new THREE.Vector3( ow / 2, 0,       -oh / 2)); fp.push(new THREE.Vector3( ow / 2, wallH, -oh / 2));
  fp.push(new THREE.Vector3(-ow / 2, 0,        oh / 2)); fp.push(new THREE.Vector3(-ow / 2, wallH,  oh / 2));
  fp.push(new THREE.Vector3( ow / 2, 0,        oh / 2)); fp.push(new THREE.Vector3( ow / 2, wallH,  oh / 2));
  // Top rectangle
  fp.push(new THREE.Vector3(-ow / 2, wallH, -oh / 2)); fp.push(new THREE.Vector3( ow / 2, wallH, -oh / 2));
  fp.push(new THREE.Vector3(-ow / 2, wallH,  oh / 2)); fp.push(new THREE.Vector3( ow / 2, wallH,  oh / 2));
  fp.push(new THREE.Vector3(-ow / 2, wallH, -oh / 2)); fp.push(new THREE.Vector3(-ow / 2, wallH,  oh / 2));
  fp.push(new THREE.Vector3( ow / 2, wallH, -oh / 2)); fp.push(new THREE.Vector3( ow / 2, wallH,  oh / 2));
  // Ridge
  fp.push(new THREE.Vector3(0, ridgeY, -oh / 2)); fp.push(new THREE.Vector3(0, ridgeY,  oh / 2));
  // Sloped roof beams (4 corners → ridge)
  fp.push(new THREE.Vector3(-ow / 2, wallH, -oh / 2)); fp.push(new THREE.Vector3(0, ridgeY, -oh / 2));
  fp.push(new THREE.Vector3( ow / 2, wallH, -oh / 2)); fp.push(new THREE.Vector3(0, ridgeY, -oh / 2));
  fp.push(new THREE.Vector3(-ow / 2, wallH,  oh / 2)); fp.push(new THREE.Vector3(0, ridgeY,  oh / 2));
  fp.push(new THREE.Vector3( ow / 2, wallH,  oh / 2)); fp.push(new THREE.Vector3(0, ridgeY,  oh / 2));
  var frameGeom = new THREE.BufferGeometry().setFromPoints(fp);
  group.add(new THREE.LineSegments(frameGeom, frameMat));

  return group;
}

function syncSceneWithPlacements(handle, placementsArr) {
  if (!handle) return;
  var pg = handle.plantsGroup;
  var garden = handle.garden;
  var gw = garden.grid_width;
  var gh = garden.grid_height;
  var style = renderStyle || "realistic";
  // Plants sit on top of the soil surface
  var soilTop = _soilTopFor(garden.garden_type);

  // Clear existing plants
  while (pg.children.length > 0) {
    var child = pg.children[0];
    pg.remove(child);
    disposeObject(child);
  }

  if (!placementsArr || placementsArr.length === 0) return;

  // Add plants from placements array
  for (var i = 0; i < placementsArr.length; i++) {
    var placement = placementsArr[i];
    var plant = placement.plant;
    if (!plant) continue;

    // Year-preview scale: ramps perennials/biennials at earlier years; annuals stay 1.0.
    var s = (typeof yearScale === 'function') ? yearScale(plant, previewYear) : 1.0;

    var group = new THREE.Group();
    group.position.set(placement.pos_x - gw / 2, soilTop, placement.pos_y - gh / 2);
    group.userData = { placementId: placement.id, plantId: placement.plantId };

    var mesh = buildPlantMesh(plant, style);
    mesh.position.set(0, 0, 0);
    // Apply year-preview scale to the entire plant mesh (handles spread + height in one knob).
    mesh.scale.set(s, s, s);
    if (mesh.userData) mesh.userData.placementId = placement.id;
    else mesh.userData = { placementId: placement.id };
    group.add(mesh);

    // Translucent soil disk for the plant's spread (scaled to year-preview radius).
    var diskColor = (plant.render_colors && plant.render_colors.foliage && plant.render_colors.foliage[0]) || '#7BAE7F';
    var diskRadius = Math.max(0.001, placement.radius_feet * s);
    var diskGeom = new THREE.CircleGeometry(diskRadius, 32);
    var diskMat = new THREE.MeshBasicMaterial({
      color: diskColor,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    var disk = new THREE.Mesh(diskGeom, diskMat);
    disk.rotation.x = -Math.PI / 2;
    disk.position.y = 0.005;
    disk.userData = { placementId: placement.id };
    group.add(disk);

    pg.add(group);
  }

  // iter 6: refresh ground-shadow disks for shading warnings
  updateShadowMeshes(handle, placementsArr, previewYear);
}

function updateShadowMeshes(handle, placementsArr, year) {
  if (!handle) return;
  // Lazy-create the shadows group (e.g. after a setRenderStyle that wiped it)
  if (!handle.shadowsGroup || !handle.shadowsGroup.parent) {
    var sg = new THREE.Group();
    sg.name = "shadows";
    handle.scene.add(sg);
    handle.shadowsGroup = sg;
  }
  var shg = handle.shadowsGroup;
  // Clear existing shadow meshes
  while (shg.children.length > 0) {
    var sChild = shg.children[0];
    shg.remove(sChild);
    disposeObject(sChild);
  }
  if (!placementsArr || placementsArr.length === 0) return;
  if (typeof shadowZoneFor !== 'function') return;
  var garden = handle.garden;
  var gw = garden.grid_width;
  var gh = garden.grid_height;
  var soilTop = (handle.soilTop != null) ? handle.soilTop : (_soilTopFor(garden.garden_type));

  for (var i = 0; i < placementsArr.length; i++) {
    var placement = placementsArr[i];
    var zone = shadowZoneFor(placement, year);
    if (!zone) continue;
    if (zone.heightFt < 0.5) continue; // skip noise from very short plants
    var planeGeom = new THREE.PlaneGeometry(1, 1);
    var planeMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    var plane = new THREE.Mesh(planeGeom, planeMat);
    plane.rotation.x = -Math.PI / 2;
    var scaleX = Math.max(0.001, zone.halfWidth * 2);
    var scaleZ = Math.max(0.001, zone.heightFt * 0.7);
    plane.scale.set(scaleX, scaleZ, 1);
    plane.position.set(
      zone.cx - gw / 2,
      soilTop + 0.008,
      zone.yNorth - gh / 2 - zone.heightFt * 0.35
    );
    shg.add(plane);
  }
}

function setRenderStyle(handle, newStyle) {
  if (!handle) return;
  renderStyle = newStyle;

  // Update scene background
  handle.scene.background = new THREE.Color(getSceneBgColor());

  // Rebuild planter box and ground (keep plantsGroup, lights, and interaction helpers)
  var garden = handle.garden;
  var toRemove = [];
  handle.scene.children.forEach(function(child) {
    if (child !== handle.plantsGroup &&
        child !== handle.shadowsGroup &&
        child.type !== "AmbientLight" &&
        child.type !== "DirectionalLight" &&
        child.name !== "hitPlane" &&
        child.name !== "_previewDisk" &&
        child.name !== "_carryPlane" &&
        child.name !== "groundPlants" &&
        child.name !== "shadows") {
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
  var groundMat = makeMaterial("#D4C9B8");
  var ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  ground.name = "ground";
  handle.scene.add(ground);

  var newBox = buildPlanterBox(garden.grid_width, garden.grid_height, garden.garden_type || 'garden_bed');
  handle.scene.add(newBox);

  // Rebuild all plants with new material (after box so plants are on top)
  syncSceneWithPlacements(handle, placements);
}

function dispose3DView(handle) {
  if (!handle) return;
  if (handle.animId) cancelAnimationFrame(handle.animId);
  if (handle._resizeObserver) handle._resizeObserver.disconnect();
  if (handle.controls) handle.controls.dispose();
  if (handle.groundPlantsGroup) {
    handle.groundPlantsGroup.children.slice().forEach(function(c) { disposeObject(c); });
  }
  if (handle.shadowsGroup) {
    handle.shadowsGroup.children.slice().forEach(function(c) { disposeObject(c); });
  }

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
        child.material.forEach(function(m) {
          if (m.map) m.map.dispose();
          m.dispose();
        });
      } else {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    }
  });
}

// ── 3D Drag-and-Drop Interaction ───────────────────────────────────────────

// Returns a THREE.Vector3 at soil level for a placement's continuous (pos_x, pos_y) feet.
// Used by overlays (e.g. companion warning chips) to project placements to screen.
function scenePlacementWorldPosition(handle, placement) {
  if (!handle || !placement) return null;
  var gw = handle.gridWidth != null ? handle.gridWidth : handle.garden.grid_width;
  var gh = handle.gridHeight != null ? handle.gridHeight : handle.garden.grid_height;
  var top = (handle.soilTop != null)
    ? handle.soilTop
    : _soilTopFor(handle.garden && handle.garden.garden_type);
  return new THREE.Vector3(placement.pos_x - gw / 2, top, placement.pos_y - gh / 2);
}

// Raycast against the soil hit-plane and return the intersection in feet
// (pos_x, pos_y) coordinates without clamping. Returns null if ray misses.
function getRaycastPoint(handle, clientX, clientY) {
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
  var gw = handle.gridWidth != null ? handle.gridWidth : handle.garden.grid_width;
  var gh = handle.gridHeight != null ? handle.gridHeight : handle.garden.grid_height;
  return { x: pt.x + gw / 2, y: pt.z + gh / 2 };
}

function ensurePreviewDisk(handle) {
  if (handle._previewDisk) return handle._previewDisk;
  var geom = new THREE.CircleGeometry(1, 32);
  var mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });
  var mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.visible = false;
  mesh.name = "_previewDisk";
  handle.scene.add(mesh);
  handle._previewDisk = mesh;
  return mesh;
}

function showPreviewDisk(handle, pos_x, pos_y, radius_feet, valid) {
  if (!handle) return;
  var d = ensurePreviewDisk(handle);
  var gw = handle.gridWidth != null ? handle.gridWidth : handle.garden.grid_width;
  var gh = handle.gridHeight != null ? handle.gridHeight : handle.garden.grid_height;
  var top = (handle.soilTop != null) ? handle.soilTop : _soilTopFor(handle.garden && handle.garden.garden_type);
  d.position.set(pos_x - gw / 2, top + 0.012, pos_y - gh / 2);
  d.scale.setScalar(radius_feet > 0 ? radius_feet : 0.01);
  d.material.color.set(valid === 'ok' ? '#4ade80' : valid === 'overlap' ? '#fbbf24' : '#ef4444');
  d.visible = true;
}

function hidePreviewDisk(handle) {
  if (handle && handle._previewDisk) handle._previewDisk.visible = false;
}

function lockBirdsEye(handle) {
  if (!handle || handle._dragLocked) return;
  handle.controls.enableRotate = false;
  handle._dragLocked = true;
}

function unlockCamera(handle) {
  if (!handle || !handle._dragLocked) return;
  handle.controls.enableRotate = true;
  handle._dragLocked = false;
}

function setup3DDragDrop(handle, callbacks) {
  if (!handle) return;
  var garden = handle.garden;
  var gw = garden.grid_width;
  var gh = garden.grid_height;
  var soilTop = _soilTopFor(garden.garden_type);

  // Invisible hit plane at soil level for raycasting
  var hitGeom = new THREE.PlaneGeometry(gw, gh);
  var hitMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
  var hitPlane = new THREE.Mesh(hitGeom, hitMat);
  hitPlane.rotation.x = -Math.PI / 2;
  hitPlane.position.y = soilTop;
  hitPlane.name = "hitPlane";
  handle.scene.add(hitPlane);
  handle.hitPlane = hitPlane;

  ensurePreviewDisk(handle);

  var canvas = handle.renderer.domElement;

  canvas.addEventListener("dragover", function(e) {
    if (!draggedPlant) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    lockBirdsEye(handle);
    var pt = getRaycastPoint(handle, e.clientX, e.clientY);
    if (!pt) { hidePreviewDisk(handle); return; }
    var r = (draggedPlant.spread_inches || 12) / 24;
    var valid = validatePlacement(pt.x, pt.y, r, gw, gh, placements);
    showPreviewDisk(handle, pt.x, pt.y, r, valid);
  });

  canvas.addEventListener("drop", function(e) {
    e.preventDefault();
    unlockCamera(handle);
    var pt = getRaycastPoint(handle, e.clientX, e.clientY);
    // In-grid drops go through onDrop which re-validates with the radius-aware
    // helper. Drops on the canvas but outside the grid stay as toss-to-ground
    // (existing affordance for discarding a plant onto the soil/lawn area).
    var inGrid = pt && pt.x >= 0 && pt.x <= gw && pt.y >= 0 && pt.y <= gh;
    if (inGrid) {
      callbacks.onDrop(pt.x, pt.y);
    } else {
      hidePreviewDisk(handle);
      if (callbacks.onMiss) callbacks.onMiss(e.clientX, e.clientY);
      else callbacks.onLeave();
    }
  });

  canvas.addEventListener("dragleave", function() {
    hidePreviewDisk(handle);
    unlockCamera(handle);
    callbacks.onLeave();
  });
}
