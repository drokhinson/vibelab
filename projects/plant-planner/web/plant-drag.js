// plant-drag.js — Long-hold drag and toss mechanics for placed plants in the 3D scene

var _pickedPlant = null;      // { mesh, gridKey, plant }
var _holdTimer = null;
var _holdStartX = 0;
var _holdStartY = 0;
var _pointerHistory = [];     // [{x, z, t}] world-space, for velocity calculation
var _lastPickupEndTime = 0;   // suppresses spurious click-to-remove after a drag ends
var _dragHandle = null;       // reference to the active scene handle during drag

var HOLD_MS = 450;
var HOLD_MOVE_THRESH = 10;    // px — cancel hold if pointer moves more than this
var TOSS_THRESHOLD = 1.2;     // world units/sec — above this = toss arc
var CARRY_LIFT = 0.8;         // units above soil top while carrying

function bindPlantDrag(handle) {
  if (!handle) return;
  var garden = handle.garden;
  var soilTop = garden.garden_type === "planter" ? 0.36 : 0.12;
  var carryY = soilTop + CARRY_LIFT;

  // Invisible plane at carry height — raycasting target while dragging
  var carryGeom = new THREE.PlaneGeometry(100, 100);
  var carryMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
  var carryPlane = new THREE.Mesh(carryGeom, carryMat);
  carryPlane.rotation.x = -Math.PI / 2;
  carryPlane.position.y = carryY;
  carryPlane.name = "_carryPlane";
  handle.scene.add(carryPlane);
  handle._carryPlane = carryPlane;
  handle._carryY = carryY;

  // Group for session-only ground plants (not in gridPlacements → gone on reload)
  var gpg = new THREE.Group();
  gpg.name = "groundPlants";
  handle.scene.add(gpg);
  handle.groundPlantsGroup = gpg;

  var canvas = handle.renderer.domElement;

  // ── Mouse ──────────────────────────────────────────────────────────────────
  canvas.addEventListener("mousedown", function(e) {
    if (e.button !== 0) return;
    _startHold(e.clientX, e.clientY, handle);
  });

  canvas.addEventListener("mousemove", function(e) {
    if (_pickedPlant) {
      _onMove(e.clientX, e.clientY, handle);
    } else if (_holdTimer) {
      _checkCancel(e.clientX, e.clientY);
    }
  });

  canvas.addEventListener("mouseup", function(e) {
    if (e.button !== 0) return;
    _clearHoldTimer();
    if (_pickedPlant) _onRelease(e.clientX, e.clientY, handle);
  });

  // ── Touch ──────────────────────────────────────────────────────────────────
  canvas.addEventListener("touchstart", function(e) {
    if (_touchDragState) return; // catalog drag in progress
    var t = e.touches[0];
    _startHold(t.clientX, t.clientY, handle);
  }, { passive: false });

  canvas.addEventListener("touchmove", function(e) {
    if (_touchDragState) return;
    var t = e.touches[0];
    if (_pickedPlant) {
      e.preventDefault();
      _onMove(t.clientX, t.clientY, handle);
    } else if (_holdTimer) {
      _checkCancel(t.clientX, t.clientY);
    }
  }, { passive: false });

  canvas.addEventListener("touchend", function(e) {
    if (_touchDragState) return;
    _clearHoldTimer();
    if (_pickedPlant) {
      var t = e.changedTouches[0];
      _onRelease(t.clientX, t.clientY, handle);
    }
  });

  canvas.addEventListener("touchcancel", function() {
    _clearHoldTimer();
    if (_pickedPlant) _cancelDrag(handle);
  });
}

// ── Hold detection ────────────────────────────────────────────────────────────

function _startHold(clientX, clientY, handle) {
  _holdStartX = clientX;
  _holdStartY = clientY;
  _holdTimer = setTimeout(function() {
    _holdTimer = null;
    _tryPickup(clientX, clientY, handle);
  }, HOLD_MS);
}

function _clearHoldTimer() {
  if (_holdTimer) {
    clearTimeout(_holdTimer);
    _holdTimer = null;
  }
}

function _checkCancel(clientX, clientY) {
  var dx = clientX - _holdStartX;
  var dy = clientY - _holdStartY;
  if (dx * dx + dy * dy > HOLD_MOVE_THRESH * HOLD_MOVE_THRESH) {
    _clearHoldTimer();
  }
}

// ── Pick up ───────────────────────────────────────────────────────────────────

function _tryPickup(clientX, clientY, handle) {
  var canvas = handle.renderer.domElement;
  var rect = canvas.getBoundingClientRect();
  var mouse = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  var raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, handle.camera);
  var hits = raycaster.intersectObjects(handle.plantsGroup.children, true);
  if (hits.length === 0) return;

  var obj = hits[0].object;
  while (obj && !obj.userData.gridKey) obj = obj.parent;
  if (!obj || !obj.userData.gridKey) return;

  var gridKey = obj.userData.gridKey;
  var plant = gridPlacements[gridKey];
  if (!plant) return;

  // Detach from grid
  delete gridPlacements[gridKey];
  handle.plantsGroup.remove(obj);
  handle.scene.add(obj);

  // Lift visually
  obj.position.y = handle._carryY;
  obj.rotation.x = -0.15;
  obj.scale.multiplyScalar(1.1);

  _pickedPlant = { mesh: obj, gridKey: gridKey, plant: plant };
  _pointerHistory = [];
  _dragHandle = handle;

  handle.controls.enabled = false;

  if (navigator.vibrate) navigator.vibrate(30);
}

// ── Drag move ─────────────────────────────────────────────────────────────────

function _onMove(clientX, clientY, handle) {
  if (!_pickedPlant) return;
  var pt = _raycastCarryPlane(clientX, clientY, handle);
  if (!pt) return;

  _pickedPlant.mesh.position.set(pt.x, handle._carryY, pt.z);

  _pointerHistory.push({ x: pt.x, z: pt.z, t: Date.now() });
  if (_pointerHistory.length > 8) _pointerHistory.shift();

  var gw = handle.garden.grid_width;
  var gh = handle.garden.grid_height;
  var gx = Math.floor(pt.x + gw / 2);
  var gy = Math.floor(pt.z + gh / 2);
  if (gx >= 0 && gx < gw && gy >= 0 && gy < gh) {
    showCellHighlight(handle, gx, gy);
  } else {
    hideCellHighlight(handle);
  }
}

// ── Release / drop / toss ─────────────────────────────────────────────────────

function _onRelease(clientX, clientY, handle) {
  if (!_pickedPlant) return;

  var mesh = _pickedPlant.mesh;
  var plant = _pickedPlant.plant;

  _lastPickupEndTime = Date.now();
  _pickedPlant = null;
  _dragHandle = null;

  // Restore visual transforms
  mesh.rotation.x = 0;
  mesh.scale.divideScalar(1.1);

  handle.controls.enabled = true;
  hideCellHighlight(handle);

  var pt = _raycastCarryPlane(clientX, clientY, handle);
  var gw = handle.garden.grid_width;
  var gh = handle.garden.grid_height;

  var gx = -1, gy = -1;
  var isInside = false;
  if (pt) {
    gx = Math.floor(pt.x + gw / 2);
    gy = Math.floor(pt.z + gh / 2);
    isInside = gx >= 0 && gx < gw && gy >= 0 && gy < gh;
  }

  var vel = _calcVelocity();
  var speed = Math.sqrt(vel.vx * vel.vx + vel.vz * vel.vz);
  var isToss = speed > TOSS_THRESHOLD;

  _pointerHistory = [];

  if (isInside && !isToss) {
    _dropIntoGrid(mesh, plant, gx, gy, handle);
  } else {
    var startPos = mesh.position.clone();
    var landX, landZ;
    if (isToss) {
      landX = startPos.x + vel.vx * 1.5;
      landZ = startPos.z + vel.vz * 1.5;
    } else {
      landX = pt ? pt.x : startPos.x;
      landZ = pt ? pt.z : startPos.z;
    }
    _animateArc(mesh, startPos, landX, landZ, isToss, handle);
  }
}

function _cancelDrag(handle) {
  if (!_pickedPlant) return;
  var mesh = _pickedPlant.mesh;
  var plant = _pickedPlant.plant;
  var gridKey = _pickedPlant.gridKey;

  mesh.rotation.x = 0;
  mesh.scale.divideScalar(1.1);

  // Return to original grid cell
  handle.scene.remove(mesh);
  disposeObject(mesh);
  gridPlacements[gridKey] = plant;
  sync3DView();

  _pickedPlant = null;
  _dragHandle = null;
  _pointerHistory = [];
  handle.controls.enabled = true;
  hideCellHighlight(handle);
}

// ── Grid drop ─────────────────────────────────────────────────────────────────

function _dropIntoGrid(mesh, plant, gx, gy, handle) {
  gridPlacements[gx + "," + gy] = plant;
  handle.scene.remove(mesh);
  disposeObject(mesh);
  sync3DView();
}

// ── Arc animation ─────────────────────────────────────────────────────────────

function _animateArc(mesh, startPos, landX, landZ, isToss, handle) {
  var groundY = -0.06;
  var duration = isToss ? 0.65 : 0.45;
  var peakLift = isToss ? 1.0 : 0.4;
  var startTime = null;

  function frame(ts) {
    if (!startTime) startTime = ts;
    var t = Math.min((ts - startTime) / (duration * 1000), 1);

    var px = startPos.x + (landX - startPos.x) * t;
    var pz = startPos.z + (landZ - startPos.z) * t;
    var py = (1 - t) * startPos.y + t * groundY + Math.sin(t * Math.PI) * peakLift;
    mesh.position.set(px, py, pz);

    // Tip the plant over as it falls
    mesh.rotation.x = t * (Math.PI / 2);

    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      mesh.position.y = groundY;
      mesh.rotation.x = Math.PI / 2;
      handle.scene.remove(mesh);
      if (handle.groundPlantsGroup) {
        handle.groundPlantsGroup.add(mesh);
        mesh.userData.isGroundPlant = true;
      }
    }
  }

  requestAnimationFrame(frame);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _raycastCarryPlane(clientX, clientY, handle) {
  if (!handle._carryPlane) return null;
  var canvas = handle.renderer.domElement;
  var rect = canvas.getBoundingClientRect();
  var mouse = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  var raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, handle.camera);
  var hits = raycaster.intersectObject(handle._carryPlane);
  return hits.length > 0 ? hits[0].point : null;
}

function _calcVelocity() {
  if (_pointerHistory.length < 2) return { vx: 0, vz: 0 };
  var now = Date.now();
  var recent = _pointerHistory.filter(function(p) { return now - p.t < 120; });
  if (recent.length < 2) recent = _pointerHistory.slice(-2);
  var first = recent[0];
  var last = recent[recent.length - 1];
  var dt = (last.t - first.t) / 1000;
  if (dt < 0.001) return { vx: 0, vz: 0 };
  return {
    vx: (last.x - first.x) / dt,
    vz: (last.z - first.z) / dt
  };
}
