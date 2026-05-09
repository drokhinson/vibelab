// render2d.js — top-down 2D planter renderer (SVG-based).
//
// Replaces render3d.js for the Phase-1 plant-first refactor: the builder no
// longer shows a Three.js view; instead the planter is rendered as a flat,
// scaled-to-fit SVG with one disk per placement.
//
// The returned scene handle is shape-compatible with the old 3D handle so
// companions.js, shading.js, and plant-drag.js keep working: they only need
// `garden`, `placements`, and a `projectPlacement(placement) → {x,y}`
// function. The handle carries `isTwoD: true` so callers can branch when
// 3D-specific paths are needed.

var SVG_NS = 'http://www.w3.org/2000/svg';

// Visual style — soil color, grid lines.
var SOIL_FILL = '#f4ecd8';
var SOIL_STROKE = '#cdb78c';
var GRID_STROKE = 'rgba(120, 90, 50, 0.18)';

function _categoryColor(plant) {
  switch ((plant && plant.category) || 'other') {
    case 'vegetable': return '#7fa650';
    case 'herb':      return '#7c9e6d';
    case 'flower':    return '#d77ac1';
    case 'fruit':     return '#e08866';
    default:          return '#9aa66b';
  }
}

function _plantImageUrl(plant) {
  if (!plant) return null;
  // Cache plants carry storage paths (mirrored) and original URLs (fallback).
  return plant.image_thumbnail_path || plant.image_thumbnail_url
      || plant.image_medium_path   || plant.image_medium_url
      || plant.image_regular_path  || plant.image_regular_url
      || null;
}

function _newSvgEl(tag, attrs) {
  var el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (var k in attrs) {
      if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]);
    }
  }
  return el;
}

function init2DView(containerId, garden, initialPlacements) {
  var container = document.getElementById(containerId);
  if (!container) return null;
  container.innerHTML = '';
  container.classList.add('render2d-container');

  var rect = container.getBoundingClientRect();
  var W = Math.max(1, rect.width);
  var H = Math.max(1, rect.height);
  // Leave a small margin around the soil so disks at the edge don't clip.
  var margin = 16;
  var availW = Math.max(50, W - margin * 2);
  var availH = Math.max(50, H - margin * 2);
  var pixelsPerFoot = Math.min(availW / garden.grid_width, availH / garden.grid_height);
  var soilW = pixelsPerFoot * garden.grid_width;
  var soilH = pixelsPerFoot * garden.grid_height;
  var soilX = (W - soilW) / 2;
  var soilY = (H - soilH) / 2;

  var svg = _newSvgEl('svg', {
    width: W, height: H, viewBox: '0 0 ' + W + ' ' + H,
    class: 'render2d-svg',
    style: 'width:100%;height:100%;display:block;'
  });

  // Soil background.
  var soil = _newSvgEl('rect', {
    x: soilX, y: soilY, width: soilW, height: soilH,
    rx: 6, ry: 6, fill: SOIL_FILL, stroke: SOIL_STROKE, 'stroke-width': 2
  });
  svg.appendChild(soil);

  // Grid lines (one per foot).
  var gridGroup = _newSvgEl('g', { class: 'render2d-grid' });
  for (var gx = 1; gx < garden.grid_width; gx++) {
    gridGroup.appendChild(_newSvgEl('line', {
      x1: soilX + gx * pixelsPerFoot, y1: soilY,
      x2: soilX + gx * pixelsPerFoot, y2: soilY + soilH,
      stroke: GRID_STROKE, 'stroke-width': 1
    }));
  }
  for (var gy = 1; gy < garden.grid_height; gy++) {
    gridGroup.appendChild(_newSvgEl('line', {
      x1: soilX,          y1: soilY + gy * pixelsPerFoot,
      x2: soilX + soilW,  y2: soilY + gy * pixelsPerFoot,
      stroke: GRID_STROKE, 'stroke-width': 1
    }));
  }
  svg.appendChild(gridGroup);

  // Compass — +y = north.
  var compass = _newSvgEl('text', {
    x: soilX + soilW - 6, y: soilY + soilH + 14,
    'text-anchor': 'end', 'font-size': 11, fill: 'rgba(0,0,0,0.45)'
  });
  compass.textContent = '↑ N';
  svg.appendChild(compass);

  // Plants group (sorted on render).
  var plantsGroup = _newSvgEl('g', { class: 'render2d-plants' });
  svg.appendChild(plantsGroup);

  // Preview disk (single, hidden by default).
  var previewDisk = _newSvgEl('circle', {
    cx: 0, cy: 0, r: 0, fill: 'rgba(34, 197, 94, 0.35)',
    stroke: 'rgba(34, 197, 94, 0.85)', 'stroke-width': 2,
    style: 'pointer-events:none;display:none;'
  });
  svg.appendChild(previewDisk);

  container.appendChild(svg);

  var handle = {
    isTwoD: true,
    garden: garden,
    container: container,
    svg: svg,
    plantsGroup: plantsGroup,
    previewDisk: previewDisk,
    pixelsPerFoot: pixelsPerFoot,
    soilX: soilX,
    soilY: soilY,
    soilW: soilW,
    soilH: soilH,
    canvasW: W,
    canvasH: H,
    // Mimic 3D handle for code that reads renderer.domElement.
    renderer: { domElement: svg },
    camera: null,
    placements: initialPlacements || [],
  };

  handle.projectPlacement = function(placement) {
    if (!placement) return null;
    return {
      x: handle.soilX + placement.pos_x * handle.pixelsPerFoot,
      y: handle.soilY + (handle.garden.grid_height - placement.pos_y) * handle.pixelsPerFoot
    };
  };

  handle.canvasToGarden = function(clientX, clientY) {
    var r = svg.getBoundingClientRect();
    var localX = clientX - r.left;
    var localY = clientY - r.top;
    var pos_x = (localX - handle.soilX) / handle.pixelsPerFoot;
    var pos_y = handle.garden.grid_height - (localY - handle.soilY) / handle.pixelsPerFoot;
    return { pos_x: pos_x, pos_y: pos_y };
  };

  syncSceneWithPlacements(handle, initialPlacements || []);
  return handle;
}

function dispose2DView(handle) {
  if (!handle || !handle.container) return;
  handle.container.innerHTML = '';
}

function syncSceneWithPlacements(handle, placements) {
  if (!handle || !handle.plantsGroup) return;
  handle.placements = placements;
  // Redraw all disks. Far simpler than diffing for the small N we have.
  while (handle.plantsGroup.firstChild) {
    handle.plantsGroup.removeChild(handle.plantsGroup.firstChild);
  }
  // Sort by y descending so northern (visually-upper) plants render first
  // and southern ones overlap on top — matches typical top-down convention.
  var sorted = placements.slice().sort(function(a, b) { return b.pos_y - a.pos_y; });
  for (var i = 0; i < sorted.length; i++) {
    var p = sorted[i];
    var center = handle.projectPlacement(p);
    if (!center) continue;
    var radiusPx = Math.max(6, p.radius_feet * handle.pixelsPerFoot);
    var color = _categoryColor(p.plant);

    var group = _newSvgEl('g', { class: 'render2d-plant', 'data-placement-id': p.id });

    // Spread disk (translucent).
    var disk = _newSvgEl('circle', {
      cx: center.x, cy: center.y, r: radiusPx,
      fill: color + '33', stroke: color, 'stroke-width': 1.5,
      style: 'cursor:pointer;'
    });
    group.appendChild(disk);

    // Photo or category dot at center.
    var imgUrl = _plantImageUrl(p.plant);
    var thumbR = Math.min(radiusPx, 22);
    if (imgUrl) {
      var clipId = 'render2d-clip-' + (p.id || i);
      var defs = _newSvgEl('defs', {});
      var clip = _newSvgEl('clipPath', { id: clipId });
      clip.appendChild(_newSvgEl('circle', { cx: center.x, cy: center.y, r: thumbR }));
      defs.appendChild(clip);
      group.appendChild(defs);
      var img = _newSvgEl('image', {
        x: center.x - thumbR, y: center.y - thumbR,
        width: thumbR * 2, height: thumbR * 2,
        'clip-path': 'url(#' + clipId + ')',
        preserveAspectRatio: 'xMidYMid slice',
        style: 'pointer-events:none;'
      });
      img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', imgUrl);
      img.setAttribute('href', imgUrl);
      group.appendChild(img);
      // Ring around the photo for legibility on light soil.
      group.appendChild(_newSvgEl('circle', {
        cx: center.x, cy: center.y, r: thumbR,
        fill: 'none', stroke: color, 'stroke-width': 2,
        style: 'pointer-events:none;'
      }));
    } else {
      group.appendChild(_newSvgEl('circle', {
        cx: center.x, cy: center.y, r: 8,
        fill: color, stroke: 'white', 'stroke-width': 1.5,
        style: 'pointer-events:none;'
      }));
    }

    handle.plantsGroup.appendChild(group);
  }
}

function showPreviewDisk(handle, pos_x, pos_y, radiusFeet, status) {
  if (!handle || !handle.previewDisk) return;
  var center = handle.projectPlacement({ pos_x: pos_x, pos_y: pos_y });
  if (!center) return;
  var radiusPx = Math.max(6, radiusFeet * handle.pixelsPerFoot);
  var fill, stroke;
  if (status === 'ok') {
    fill = 'rgba(34,197,94,0.30)'; stroke = 'rgba(34,197,94,0.95)';
  } else if (status === 'overlap') {
    fill = 'rgba(245,158,11,0.30)'; stroke = 'rgba(245,158,11,0.95)';
  } else {
    fill = 'rgba(239,68,68,0.30)'; stroke = 'rgba(239,68,68,0.95)';
  }
  handle.previewDisk.setAttribute('cx', center.x);
  handle.previewDisk.setAttribute('cy', center.y);
  handle.previewDisk.setAttribute('r', radiusPx);
  handle.previewDisk.setAttribute('fill', fill);
  handle.previewDisk.setAttribute('stroke', stroke);
  handle.previewDisk.style.display = 'block';
}

function hidePreviewDisk(handle) {
  if (!handle || !handle.previewDisk) return;
  handle.previewDisk.style.display = 'none';
}

function setup2DDragDrop(handle, callbacks) {
  if (!handle || !handle.svg) return;
  var svg = handle.svg;
  callbacks = callbacks || {};

  function onDragOver(e) {
    e.preventDefault();
    if (!window.draggedPlant) return;
    var pos = handle.canvasToGarden(e.clientX, e.clientY);
    var r = (window.draggedPlant.spread_inches || window.draggedPlant.spread_cm
              ? (window.draggedPlant.spread_inches || (window.draggedPlant.spread_cm / 2.54))
              : 12) / 24;
    var valid = (typeof validatePlacement === 'function')
      ? validatePlacement(pos.pos_x, pos.pos_y, r, handle.garden.grid_width, handle.garden.grid_height, handle.placements)
      : 'ok';
    showPreviewDisk(handle, pos.pos_x, pos.pos_y, r, valid);
  }

  function onDrop(e) {
    e.preventDefault();
    var pos = handle.canvasToGarden(e.clientX, e.clientY);
    if (callbacks.onDrop) callbacks.onDrop(pos.pos_x, pos.pos_y);
    hidePreviewDisk(handle);
  }

  function onDragLeave(e) {
    if (!svg.contains(e.relatedTarget)) {
      hidePreviewDisk(handle);
      if (callbacks.onLeave) callbacks.onLeave();
    }
  }

  svg.addEventListener('dragover', onDragOver);
  svg.addEventListener('drop', onDrop);
  svg.addEventListener('dragleave', onDragLeave);
}

function bind2DClick(handle, onPlacementClick) {
  if (!handle || !handle.svg) return;
  handle.svg.addEventListener('click', function(e) {
    var target = e.target;
    while (target && target !== handle.svg) {
      var pid = target.getAttribute && target.getAttribute('data-placement-id');
      if (pid) {
        if (onPlacementClick) onPlacementClick(pid);
        return;
      }
      target = target.parentNode;
    }
  });
}

// Helpers used by companions.js / shading.js — same name as the 3D version so
// callers don't need to branch.
function scenePlacementWorldPosition(handle, placement) {
  if (!handle || !placement) return null;
  return handle.projectPlacement(placement);
}
