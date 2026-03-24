// plant-thumbnails.js — Offscreen Three.js renderer for 2D side-profile plant thumbnails

var plantThumbnailCache = {}; // keyed by plantId + "_" + style
var _thumbRenderer = null;
var _thumbScene = null;
var _thumbCamera = null;

var THUMB_SIZE = 128;
// Fixed camera frustum sized for tallest plant (84") so all thumbnails are proportional
var THUMB_FRUSTUM = 1.8;

function _ensureThumbRenderer() {
  if (_thumbRenderer) return;
  _thumbRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  _thumbRenderer.setSize(THUMB_SIZE, THUMB_SIZE);
  _thumbRenderer.setPixelRatio(2); // retina sharpness

  _thumbScene = new THREE.Scene();
  var ambient = new THREE.AmbientLight(0xffffff, 0.8);
  _thumbScene.add(ambient);
  var dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(3, 5, 4);
  _thumbScene.add(dir);
  var fill = new THREE.DirectionalLight(0xFFF5E1, 0.3);
  fill.position.set(-2, 3, -2);
  _thumbScene.add(fill);

  // Orthographic camera from the side (+X axis looking toward origin)
  var half = THUMB_FRUSTUM;
  _thumbCamera = new THREE.OrthographicCamera(-half, half, half * 1.2, -half * 0.2, 0.1, 50);
  _thumbCamera.position.set(5, 0.4, 0);
  _thumbCamera.lookAt(0, 0.4, 0);
}

function _disposeThumbRenderer() {
  if (_thumbRenderer) {
    _thumbRenderer.dispose();
    _thumbRenderer = null;
  }
  if (_thumbScene) {
    // Keep lights, they're lightweight
    _thumbScene = null;
  }
  _thumbCamera = null;
}

function _renderPlantThumbnail(plant, style) {
  _ensureThumbRenderer();

  // Clear previous plant meshes (keep lights)
  var toRemove = [];
  _thumbScene.children.forEach(function(c) {
    if (c.type !== "AmbientLight" && c.type !== "DirectionalLight") toRemove.push(c);
  });
  toRemove.forEach(function(c) {
    _thumbScene.remove(c);
    disposeObject(c);
  });

  var mesh = buildPlantMesh(plant, style);
  // Center the plant vertically based on its scaled height
  _thumbScene.add(mesh);

  _thumbRenderer.render(_thumbScene, _thumbCamera);
  return _thumbRenderer.domElement.toDataURL("image/png");
}

function _svgFallback(plant) {
  var desc = getPlantDescriptor(plant);
  var foliageColor = "#4CAF50";
  var stemColor = desc.stem && desc.stem.color ? desc.stem.color : "#4a7c3f";
  if (desc.foliage && desc.foliage.length > 0 && desc.foliage[0].color) {
    foliageColor = desc.foliage[0].color;
  }
  var accentColor = foliageColor;
  if (desc.accents && desc.accents.length > 0 && desc.accents[0].color) {
    accentColor = desc.accents[0].color;
  }
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">' +
    '<rect x="58" y="50" width="12" height="50" rx="3" fill="' + stemColor + '"/>' +
    '<ellipse cx="64" cy="45" rx="30" ry="25" fill="' + foliageColor + '" opacity="0.85"/>' +
    '<ellipse cx="72" cy="38" rx="12" ry="10" fill="' + accentColor + '" opacity="0.7"/>' +
    '</svg>';
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

function getPlantThumbnail(plant, style) {
  var key = plant.id + "_" + (style || renderStyle);
  if (plantThumbnailCache[key]) return plantThumbnailCache[key];
  try {
    var url = _renderPlantThumbnail(plant, style || renderStyle);
    plantThumbnailCache[key] = url;
    return url;
  } catch (e) {
    var fallback = _svgFallback(plant);
    plantThumbnailCache[key] = fallback;
    return fallback;
  }
}

function preloadThumbnails(plantList, style) {
  _ensureThumbRenderer();
  for (var i = 0; i < plantList.length; i++) {
    var key = plantList[i].id + "_" + style;
    if (!plantThumbnailCache[key]) {
      try {
        plantThumbnailCache[key] = _renderPlantThumbnail(plantList[i], style);
      } catch (_) {
        plantThumbnailCache[key] = _svgFallback(plantList[i]);
      }
    }
  }
  _disposeThumbRenderer();
}

function invalidateThumbnailCache() {
  plantThumbnailCache = {};
}
