// plant-drag.js — Long-hold drag and toss mechanics for placed plants in the 3D scene

var _pickedPlant = null;      // { mesh, placement, plant }
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
  var soilTop = (typeof _soilTopFor === 'function') ? _soilTopFor(garden.garden_type) : 0.12;
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

  // Group for session-only ground plants (not in placements → gone on reload)
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
  while (obj && !obj.userData.placementId) obj = obj.parent;
  if (!obj || !obj.userData.placementId) return;

  var placementId = obj.userData.placementId;
  var idx = placements.findIndex(function(p) { return p.id === placementId; });
  if (idx < 0) return;
  var placement = placements[idx];
  var plant = placement.plant;

  // Detach from placements array (will be re-added on drop or cancel)
  placements.splice(idx, 1);
  handle.plantsGroup.remove(obj);
  handle.scene.add(obj);

  // Lift visually
  obj.position.y = handle._carryY;
  obj.rotation.x = -0.15;
  obj.scale.multiplyScalar(1.1);

  _pickedPlant = { mesh: obj, placement: placement, plant: plant };
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
  var posX = pt.x + gw / 2;
  var posY = pt.z + gh / 2;
  var r = _pickedPlant.placement.radius_feet;
  // Skip self in overlap check — the placement was spliced out at pickup so
  // it isn't in `placements` here, but pass id anyway in case that changes.
  var valid = validatePlacement(posX, posY, r, gw, gh, placements, _pickedPlant.placement.id);
  showPreviewDisk(handle, posX, posY, r, valid);
}

// ── Release / drop / toss ─────────────────────────────────────────────────────

function _onRelease(clientX, clientY, handle) {
  if (!_pickedPlant) return;

  var mesh = _pickedPlant.mesh;
  var placement = _pickedPlant.placement;

  _lastPickupEndTime = Date.now();
  var picked = _pickedPlant;
  _pickedPlant = null;
  _dragHandle = null;

  // Restore visual transforms
  mesh.rotation.x = 0;
  mesh.scale.divideScalar(1.1);

  handle.controls.enabled = true;
  hidePreviewDisk(handle);

  var pt = _raycastCarryPlane(clientX, clientY, handle);
  var gw = handle.garden.grid_width;
  var gh = handle.garden.grid_height;

  var posX = -1, posY = -1;
  var centerInside = false;
  var dropValid = 'oob';
  var r = placement.radius_feet;
  if (pt) {
    posX = pt.x + gw / 2;
    posY = pt.z + gh / 2;
    centerInside = posX >= 0 && posX <= gw && posY >= 0 && posY <= gh;
    if (centerInside) {
      dropValid = validatePlacement(posX, posY, r, gw, gh, placements, placement.id);
    }
  }

  var vel = _calcVelocity();
  var speed = Math.sqrt(vel.vx * vel.vx + vel.vz * vel.vz);
  var isToss = speed > TOSS_THRESHOLD;

  _pointerHistory = [];

  if (centerInside && dropValid === 'ok' && !isToss) {
    _dropIntoGrid(mesh, placement, posX, posY, handle);
  } else if (centerInside && !isToss) {
    // Drop landed inside the bed but at an invalid spot (radius out of
    // bounds or overlapping another plant). Flash red, then return the
    // plant to its original placement so the user doesn't lose it.
    _flashRejection(handle, posX, posY, r, dropValid);
    handle.scene.remove(mesh);
    disposeObject(mesh);
    placements.push(placement);
    sync3DView();
    if (typeof renderCompanionChips === 'function') renderCompanionChips();
    if (typeof refreshCatalogList === 'function') refreshCatalogList();
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
    // Placement has already been spliced out at pickup; refresh
    // companion chips + catalog badges to reflect the now-gone neighbor.
    if (typeof renderCompanionChips === 'function') renderCompanionChips();
    if (typeof refreshCatalogList === 'function') refreshCatalogList();
  }
}

function _cancelDrag(handle) {
  if (!_pickedPlant) return;
  var mesh = _pickedPlant.mesh;
  var placement = _pickedPlant.placement;

  mesh.rotation.x = 0;
  mesh.scale.divideScalar(1.1);

  // Return to original position
  handle.scene.remove(mesh);
  disposeObject(mesh);
  placements.push(placement);
  sync3DView();

  _pickedPlant = null;
  _dragHandle = null;
  _pointerHistory = [];
  handle.controls.enabled = true;
  hidePreviewDisk(handle);
}

// ── Grid drop ─────────────────────────────────────────────────────────────────

function _dropIntoGrid(mesh, placement, pos_x, pos_y, handle) {
  placement.pos_x = pos_x;
  placement.pos_y = pos_y;
  placements.push(placement);
  if (mesh && mesh.parent) mesh.parent.remove(mesh);
  disposeObject(mesh);
  sync3DView();
  if (typeof renderCompanionChips === 'function') renderCompanionChips();
  if (typeof refreshCatalogList === 'function') refreshCatalogList();
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

// ── New-plant toss (catalog drag dropped outside the grid) ───────────────────
// Mirrors the toss arc applied to picked-up plants: builds a fresh mesh from
// the catalog plant data, drops it from carry height onto the ground at the
// drop coordinates, and parks it in groundPlantsGroup so it is visible until
// the next view re-init (session-only, like other ground plants).
function tossNewPlantToGround(plant, clientX, clientY, handle) {
  if (!handle || !plant) return;
  var mesh = buildPlantMesh(plant, renderStyle);

  var pt = _raycastCarryPlane(clientX, clientY, handle);
  var landX, landZ;
  if (pt) {
    landX = pt.x;
    landZ = pt.z;
  } else {
    // Off-canvas drop — drop just past the front edge of the garden bed.
    var gh = handle.garden.grid_height;
    landX = 0;
    landZ = gh / 2 + 1.2;
  }

  var carryY = (handle._carryY != null) ? handle._carryY : 1.0;
  var startPos = new THREE.Vector3(landX, carryY, landZ);
  mesh.position.copy(startPos);
  handle.scene.add(mesh);

  _animateArc(mesh, startPos, landX, landZ, false, handle);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Flashes the preview disk red briefly so the user can see why a drop was
// rejected (overlap with another plant, or radius extends out of bounds).
function _flashRejection(handle, posX, posY, r, valid) {
  if (!handle) return;
  showPreviewDisk(handle, posX, posY, r, valid);
  setTimeout(function() { hidePreviewDisk(handle); }, 350);
  if (navigator.vibrate) navigator.vibrate(20);
}

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
