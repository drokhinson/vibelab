// render3d.js — Three.js 3D planter scene with toon-shaded low-poly plants

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

function buildPlantMesh(renderParams, heightInches, style) {
  var group = new THREE.Group();
  if (!renderParams) {
    // Fallback: simple green sphere on a stick
    var fallbackStem = buildShapeMesh({
      shape: "cylinder", height: 0.3, radius: 0.03, color: "#4a9e3a", segments: 6
    }, style);
    var fallbackTop = buildShapeMesh({
      shape: "sphere", position: [0, 0.35, 0], scale: [0.15, 0.12, 0.15], color: "#5cb85c", segments: 6
    }, style);
    group.add(fallbackStem);
    group.add(fallbackTop);
  } else {
    // Stem
    if (renderParams.stem) {
      group.add(buildShapeMesh(renderParams.stem, style));
    }
    // Foliage
    if (renderParams.foliage) {
      for (var i = 0; i < renderParams.foliage.length; i++) {
        group.add(buildShapeMesh(renderParams.foliage[i], style));
      }
    }
    // Accents (flowers, fruit, etc)
    if (renderParams.accents) {
      for (var j = 0; j < renderParams.accents.length; j++) {
        group.add(buildShapeMesh(renderParams.accents[j], style));
      }
    }
  }
  // Scale group by height (normalize: 84" max = scale 1.0)
  var s = Math.max(0.2, (heightInches || 12) / 84);
  group.scale.set(s, s, s);
  return group;
}

function init3DView(containerId, garden, placements) {
  var container = document.getElementById(containerId);
  if (!container) return null;

  var w = container.clientWidth || 400;
  var h = container.clientHeight || 300;

  // Scene
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(renderStyle === "wireframe" ? "#1a1a2e" : "#e8f4e8");

  // Camera
  var camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
  var gw = garden.grid_width;
  var gh = garden.grid_height;
  var maxDim = Math.max(gw, gh);
  camera.position.set(maxDim * 0.8, maxDim * 0.7, maxDim * 0.8);
  camera.lookAt(0, 0, 0);

  // Renderer
  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  // Lights
  var ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);
  var dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 8, 5);
  scene.add(dirLight);

  // OrbitControls
  var controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.minDistance = 2;
  controls.maxDistance = maxDim * 3;
  controls.target.set(0, 0, 0);
  controls.update();

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

  return handle;
}

function buildPlanterBox(gw, gh, isPlanter) {
  var group = new THREE.Group();
  var wallH = isPlanter ? 0.4 : 0.2;
  var wallThick = 0.06;
  var woodColor = isPlanter ? "#8B6914" : "#6b4e2a";
  var soilColor = "#3d2b1a";
  var style = renderStyle || "toon";

  // Soil floor
  var soilGeom = new THREE.BoxGeometry(gw, 0.05, gh);
  var soilMat = makeMaterial(soilColor, style);
  var soil = new THREE.Mesh(soilGeom, soilMat);
  soil.position.y = -0.025;
  group.add(soil);

  // 4 walls
  var wallMat = makeMaterial(woodColor, style);

  // Front (z+)
  var frontGeom = new THREE.BoxGeometry(gw + wallThick * 2, wallH, wallThick);
  var front = new THREE.Mesh(frontGeom, wallMat);
  front.position.set(0, wallH / 2, gh / 2 + wallThick / 2);
  group.add(front);

  // Back (z-)
  var back = front.clone();
  back.position.z = -gh / 2 - wallThick / 2;
  group.add(back);

  // Left (x-)
  var sideGeom = new THREE.BoxGeometry(wallThick, wallH, gh);
  var left = new THREE.Mesh(sideGeom, wallMat);
  left.position.set(-gw / 2 - wallThick / 2, wallH / 2, 0);
  group.add(left);

  // Right (x+)
  var right = left.clone();
  right.position.x = gw / 2 + wallThick / 2;
  group.add(right);

  // Grid lines on soil
  var gridMat = new THREE.LineBasicMaterial({ color: 0x5a4a3a, transparent: true, opacity: 0.4 });
  var gridPoints = [];
  for (var x = -gw / 2; x <= gw / 2; x++) {
    gridPoints.push(new THREE.Vector3(x, 0.01, -gh / 2));
    gridPoints.push(new THREE.Vector3(x, 0.01, gh / 2));
  }
  for (var z = -gh / 2; z <= gh / 2; z++) {
    gridPoints.push(new THREE.Vector3(-gw / 2, 0.01, z));
    gridPoints.push(new THREE.Vector3(gw / 2, 0.01, z));
  }
  var gridGeom = new THREE.BufferGeometry().setFromPoints(gridPoints);
  var gridLines = new THREE.LineSegments(gridGeom, gridMat);
  group.add(gridLines);

  return group;
}

function syncSceneWithPlacements(handle, placements) {
  if (!handle) return;
  var pg = handle.plantsGroup;
  var garden = handle.garden;
  var gw = garden.grid_width;
  var gh = garden.grid_height;
  var style = renderStyle || "toon";

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

    var mesh = buildPlantMesh(plant.render_params, plant.height_inches, style);
    // Position: grid cell center, offset so grid is centered at origin
    mesh.position.x = gx - gw / 2 + 0.5;
    mesh.position.z = gy - gh / 2 + 0.5;
    mesh.position.y = 0;
    mesh.userData = { gridKey: key, plantId: plant.id };
    pg.add(mesh);
  }
}

function setRenderStyle(handle, newStyle) {
  if (!handle) return;
  renderStyle = newStyle;

  // Update scene background
  handle.scene.background = new THREE.Color(newStyle === "wireframe" ? "#1a1a2e" : "#e8f4e8");

  // Rebuild all plants with new material
  syncSceneWithPlacements(handle, gridPlacements);

  // Rebuild planter box
  var garden = handle.garden;
  // Remove old box (first child of scene that isn't lights or plantsGroup)
  var toRemove = [];
  handle.scene.children.forEach(function(child) {
    if (child !== handle.plantsGroup && child.type !== "AmbientLight" && child.type !== "DirectionalLight") {
      toRemove.push(child);
    }
  });
  toRemove.forEach(function(child) {
    handle.scene.remove(child);
    disposeObject(child);
  });
  var newBox = buildPlanterBox(garden.grid_width, garden.grid_height, garden.garden_type === "planter");
  handle.scene.add(newBox);
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
