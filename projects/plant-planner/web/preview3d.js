// preview3d.js — 45°-elevation isometric SVG preview for the wizard step-1
// planter shape. Replaces render2d's flat top-down view in the mini preview
// only; the builder placement view still uses render2d.js (top-down is the
// right interaction model for plant drag-and-drop).
//
// Rendered shapes by garden_type:
//   indoor_pot / outdoor_pot           — cylinder (radius, height)
//   indoor_planter_box / outdoor_*_box — rectangular box (w, l, h)
//   raised_bed                          — rectangular box (w, l, h)
//   greenhouse                          — rectangular box with peaked roof
//   garden_bed                          — flat rectangle (w, l)
//
// All shapes are projected via a simple cabinet projection:
//   screen_x = world_x + world_y * cos(α)
//   screen_y = world_y * sin(α) - world_z
// where α = 30° gives a comfortable 45°-ish elevation feel without literal
// half-scaling (which compresses depth too aggressively for short planters).

var _PREVIEW3D_NS = 'http://www.w3.org/2000/svg';

// Style palette — soil + planter "wood" / "ceramic" / "glass".
var _PR3D_SOIL_TOP   = '#caa66c';
var _PR3D_SOIL_DARK  = '#8d6d3d';
var _PR3D_WALL_LIGHT = '#d3a878';
var _PR3D_WALL_MID   = '#a37b4f';
var _PR3D_WALL_DARK  = '#7a5635';
var _PR3D_BED_LIGHT  = '#9bbf8a';
var _PR3D_BED_DARK   = '#6f8e63';
var _PR3D_GLASS_FILL = 'rgba(190, 220, 235, 0.55)';
var _PR3D_GLASS_LINE = '#8aa8b8';
var _PR3D_FRAME      = '#5d6d76';

function _pr3dEl(tag, attrs) {
  var el = document.createElementNS(_PREVIEW3D_NS, tag);
  if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]);
  return el;
}

// Project a (world_x, world_y, world_z) point onto 2D screen coords. world_y
// is depth into the screen, world_z is up. α controls the sense of elevation.
function _project(wx, wy, wz, scale, originX, originY) {
  var ALPHA = Math.PI / 6; // 30°; gives a clear 3D-from-45° feel.
  var depthX = wy * Math.cos(ALPHA);
  var depthY = wy * Math.sin(ALPHA);
  return {
    x: originX + (wx + depthX) * scale,
    y: originY - (wz - depthY) * scale
  };
}

function _polygon(points, fill, stroke) {
  var d = points.map(function(p) { return p.x.toFixed(2) + ',' + p.y.toFixed(2); }).join(' ');
  return _pr3dEl('polygon', {
    points: d, fill: fill, stroke: stroke || 'rgba(0,0,0,0.18)', 'stroke-linejoin': 'round', 'stroke-width': 1
  });
}


// ── Public API ──────────────────────────────────────────────────────────────

function disposePreview3D(handle) {
  if (handle && handle.container) handle.container.innerHTML = '';
}

function initPreview3D(containerId, garden) {
  var container = document.getElementById(containerId);
  if (!container) return null;
  container.innerHTML = '';
  container.classList.add('preview3d-container');

  var rect = container.getBoundingClientRect();
  var W = Math.max(1, rect.width  || 320);
  var H = Math.max(1, rect.height || 220);

  // World units: feet for outdoor types, inches for pot/box. Both render at
  // the same "size on screen" scale — the preview is illustrative, not to
  // scale across types.
  var w = Math.max(0.1, garden.grid_width  || 1);
  var l = Math.max(0.1, garden.grid_height || 1);
  var dh = (garden.dim_height != null) ? garden.dim_height : null;

  // Compute a scale that fits the projected bounding box in the container.
  var alpha = Math.PI / 6;
  // Approximate footprint screen extent: (w + l*cos), height extent up to
  // (dh + l*sin) for box-shape + (h_pot for pots).
  var maxH = 0;
  var t = garden.garden_type;
  if (t === 'indoor_pot' || t === 'outdoor_pot') {
    // Pot: world width = 2r (diameter), depth = 2r, height = grid_height.
    var diameter = 2 * w;
    maxH = (garden.grid_height || diameter);
    var screenW = diameter + diameter * Math.cos(alpha);
    var screenH = maxH + diameter * Math.sin(alpha);
    var sc = _previewFitScale(screenW, screenH, W, H);
    var origin = _previewOrigin(screenW, screenH, sc, W, H);
    _drawPot(container, w, garden.grid_height || diameter, sc, origin.x, origin.y);
  } else if (_gardenTypeHasHeightField && _gardenTypeHasHeightField(t)) {
    var h = (dh != null) ? dh : Math.min(w, l) / 4;
    var screenW2 = w + l * Math.cos(alpha);
    var screenH2 = h + l * Math.sin(alpha);
    var sc2 = _previewFitScale(screenW2, screenH2, W, H);
    var origin2 = _previewOrigin(screenW2, screenH2, sc2, W, H);
    if (t === 'greenhouse') {
      _drawGreenhouse(container, w, l, h, sc2, origin2.x, origin2.y);
    } else if (t === 'raised_bed') {
      _drawRaisedBed(container, w, l, h, sc2, origin2.x, origin2.y);
    } else {
      _drawPlanterBox(container, w, l, h, sc2, origin2.x, origin2.y);
    }
  } else {
    // Garden bed (flat). No height. Show a thin rectangular plot.
    var hh = Math.min(w, l) * 0.06;
    var screenW3 = w + l * Math.cos(alpha);
    var screenH3 = hh + l * Math.sin(alpha);
    var sc3 = _previewFitScale(screenW3, screenH3, W, H);
    var origin3 = _previewOrigin(screenW3, screenH3, sc3, W, H);
    _drawGardenBed(container, w, l, hh, sc3, origin3.x, origin3.y);
  }

  return { container: container };
}

function _previewFitScale(extentW, extentH, screenW, screenH) {
  var pad = 24;
  var availW = Math.max(20, screenW - pad * 2);
  var availH = Math.max(20, screenH - pad * 2);
  return Math.min(availW / extentW, availH / extentH);
}

function _previewOrigin(extentW, extentH, scale, screenW, screenH) {
  var sw = extentW * scale;
  var sh = extentH * scale;
  var alpha = Math.PI / 6;
  // Origin at the front-left bottom corner of the projected bounding box.
  return {
    x: (screenW - sw) / 2,
    y: (screenH + sh) / 2
  };
}

function _newSvg(container, screenW, screenH) {
  var svg = _pr3dEl('svg', {
    width: screenW, height: screenH,
    viewBox: '0 0 ' + screenW + ' ' + screenH,
    style: 'width:100%;height:100%;display:block;'
  });
  container.appendChild(svg);
  return svg;
}


// ── Cylinder (pot) ──────────────────────────────────────────────────────────

function _drawPot(container, radius, height, scale, originX, originY) {
  var rect = container.getBoundingClientRect();
  var svg = _newSvg(container, rect.width, rect.height);

  var alpha = Math.PI / 6;
  var diameter = 2 * radius;
  // Shrink ellipse vertical based on the elevation angle.
  var rxPx = radius * scale;
  var ryPx = radius * scale * Math.sin(alpha);

  // World-bottom of pot is at (radius, radius, 0); world-top at (radius, radius, height).
  var pBot = _project(radius, radius, 0,      scale, originX, originY);
  var pTop = _project(radius, radius, height, scale, originX, originY);

  // Side wall — rendered as a rectangle behind the top ellipse, then we draw
  // the top ellipse over it. Use a rounded "barrel" effect via a path.
  var sidePath = ''
    + 'M ' + (pTop.x - rxPx) + ' ' + pTop.y
    + ' A ' + rxPx + ' ' + ryPx + ' 0 0 0 ' + (pTop.x + rxPx) + ' ' + pTop.y
    + ' L ' + (pBot.x + rxPx) + ' ' + pBot.y
    + ' A ' + rxPx + ' ' + ryPx + ' 0 0 1 ' + (pBot.x - rxPx) + ' ' + pBot.y
    + ' Z';
  var side = _pr3dEl('path', {
    d: sidePath,
    fill: _PR3D_WALL_MID,
    stroke: _PR3D_WALL_DARK,
    'stroke-width': 1.2,
    'stroke-linejoin': 'round'
  });
  svg.appendChild(side);

  // Visible bottom rim arc (for depth cue).
  var rimBot = _pr3dEl('path', {
    d: 'M ' + (pBot.x - rxPx) + ' ' + pBot.y
       + ' A ' + rxPx + ' ' + ryPx + ' 0 0 0 ' + (pBot.x + rxPx) + ' ' + pBot.y,
    fill: 'none', stroke: _PR3D_WALL_DARK, 'stroke-width': 1.2
  });
  svg.appendChild(rimBot);

  // Top ellipse — soil surface on top of the pot. Slightly inset from the
  // outer rim so the wall thickness reads.
  var rimRxPx = rxPx;
  var rimRyPx = ryPx;
  var rim = _pr3dEl('ellipse', {
    cx: pTop.x, cy: pTop.y,
    rx: rimRxPx, ry: rimRyPx,
    fill: _PR3D_WALL_LIGHT, stroke: _PR3D_WALL_DARK, 'stroke-width': 1.2
  });
  svg.appendChild(rim);
  var inset = 0.85;
  var soil = _pr3dEl('ellipse', {
    cx: pTop.x, cy: pTop.y,
    rx: rimRxPx * inset, ry: rimRyPx * inset,
    fill: _PR3D_SOIL_TOP, stroke: _PR3D_SOIL_DARK, 'stroke-width': 0.8
  });
  svg.appendChild(soil);
}


// ── Rectangular box helpers ────────────────────────────────────────────────

function _drawBox(svg, w, l, h, scale, originX, originY, opts) {
  // Eight corners. World axes: x = right, y = depth, z = up.
  var c = {
    flb: _project(0, 0, 0, scale, originX, originY),  // front-left-bottom
    frb: _project(w, 0, 0, scale, originX, originY),
    blb: _project(0, l, 0, scale, originX, originY),
    brb: _project(w, l, 0, scale, originX, originY),
    flt: _project(0, 0, h, scale, originX, originY),
    frt: _project(w, 0, h, scale, originX, originY),
    blt: _project(0, l, h, scale, originX, originY),
    brt: _project(w, l, h, scale, originX, originY)
  };

  // Right face (x = w plane)
  svg.appendChild(_polygon([c.frb, c.brb, c.brt, c.frt], opts.right));
  // Front face (y = 0 plane)
  svg.appendChild(_polygon([c.flb, c.frb, c.frt, c.flt], opts.front));
  // Top face (z = h plane)
  svg.appendChild(_polygon([c.flt, c.frt, c.brt, c.blt], opts.top));

  return c;
}

function _drawPlanterBox(container, w, l, h, scale, originX, originY) {
  var rect = container.getBoundingClientRect();
  var svg = _newSvg(container, rect.width, rect.height);
  var c = _drawBox(svg, w, l, h, scale, originX, originY, {
    front: _PR3D_WALL_MID,
    right: _PR3D_WALL_DARK,
    top:   _PR3D_WALL_LIGHT
  });
  // Soil surface inset a touch inside the rim.
  var inset = 0.92;
  var cx = (c.flt.x + c.frt.x + c.brt.x + c.blt.x) / 4;
  var cy = (c.flt.y + c.frt.y + c.brt.y + c.blt.y) / 4;
  var soilPts = [c.flt, c.frt, c.brt, c.blt].map(function(p) {
    return { x: cx + (p.x - cx) * inset, y: cy + (p.y - cy) * inset };
  });
  svg.appendChild(_polygon(soilPts, _PR3D_SOIL_TOP, _PR3D_SOIL_DARK));
}

function _drawRaisedBed(container, w, l, h, scale, originX, originY) {
  var rect = container.getBoundingClientRect();
  var svg = _newSvg(container, rect.width, rect.height);
  var c = _drawBox(svg, w, l, h, scale, originX, originY, {
    front: _PR3D_BED_LIGHT,
    right: _PR3D_BED_DARK,
    top:   _PR3D_SOIL_TOP
  });
  // Soil "fluff" specks for character.
  for (var i = 0; i < 6; i++) {
    var u = 0.15 + Math.random() * 0.7;
    var v = 0.15 + Math.random() * 0.7;
    var p = _project(u * w, v * l, h, scale, originX, originY);
    svg.appendChild(_pr3dEl('circle', {
      cx: p.x, cy: p.y, r: 1.6, fill: _PR3D_SOIL_DARK, opacity: 0.55
    }));
  }
}

function _drawGardenBed(container, w, l, h, scale, originX, originY) {
  var rect = container.getBoundingClientRect();
  var svg = _newSvg(container, rect.width, rect.height);
  // Ground plane shadow
  var ground = _project(w / 2, l / 2, 0, scale, originX, originY);
  svg.appendChild(_pr3dEl('ellipse', {
    cx: ground.x, cy: ground.y + 4, rx: w * scale * 0.55, ry: l * scale * 0.4 * Math.sin(Math.PI/6),
    fill: 'rgba(0,0,0,0.10)'
  }));
  _drawBox(svg, w, l, h, scale, originX, originY, {
    front: _PR3D_SOIL_DARK,
    right: _PR3D_SOIL_DARK,
    top:   _PR3D_SOIL_TOP
  });
}

function _drawGreenhouse(container, w, l, h, scale, originX, originY) {
  var rect = container.getBoundingClientRect();
  var svg = _newSvg(container, rect.width, rect.height);
  // Ground / floor box (very short — 0.05·h). Sits below the glass walls.
  var floorH = Math.max(0.05 * h, 0.1);
  _drawBox(svg, w, l, floorH, scale, originX, originY, {
    front: _PR3D_BED_LIGHT,
    right: _PR3D_BED_DARK,
    top:   _PR3D_SOIL_TOP
  });
  // Glass walls — translucent box from floorH to h.
  var c = {
    flt: _project(0, 0, floorH, scale, originX, originY),
    frt: _project(w, 0, floorH, scale, originX, originY),
    blt: _project(0, l, floorH, scale, originX, originY),
    brt: _project(w, l, floorH, scale, originX, originY),
    flH: _project(0, 0, h, scale, originX, originY),
    frH: _project(w, 0, h, scale, originX, originY),
    blH: _project(0, l, h, scale, originX, originY),
    brH: _project(w, l, h, scale, originX, originY)
  };
  // Right glass wall
  svg.appendChild(_polygon([c.frt, c.brt, c.brH, c.frH], _PR3D_GLASS_FILL, _PR3D_GLASS_LINE));
  // Front glass wall
  svg.appendChild(_polygon([c.flt, c.frt, c.frH, c.flH], _PR3D_GLASS_FILL, _PR3D_GLASS_LINE));
  // Roof — a simple flat top (peaked roof would be nicer; flat is enough for the preview).
  svg.appendChild(_polygon([c.flH, c.frH, c.brH, c.blH], _PR3D_GLASS_FILL, _PR3D_GLASS_LINE));
  // Frame edges (vertical posts).
  function drawLine(a, b) {
    svg.appendChild(_pr3dEl('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: _PR3D_FRAME, 'stroke-width': 1.5
    }));
  }
  drawLine(c.flt, c.flH);
  drawLine(c.frt, c.frH);
  drawLine(c.blt, c.blH);
  drawLine(c.brt, c.brH);
}
