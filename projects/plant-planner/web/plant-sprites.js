// plant-sprites.js — Realistic billboard sprite rendering for plants
// Uses transparent PNG images on crossed planes in Three.js

var _spriteTextureCache = {}; // keyed by plant name
var _spriteTextureLoader = new THREE.TextureLoader();

// Category fallback image filenames
var CATEGORY_FALLBACK_IMAGES = {
  vegetable: "_vegetable.png",
  herb: "_herb.png",
  flower: "_flower.png",
  fruit: "_fruit.png",
  other: "_vegetable.png"
};

function plantNameToSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
}

function _getPlantImageUrl(plant) {
  var slug = plantNameToSlug(plant.name);
  return "assets/plants/" + slug + ".png";
}

function _getCategoryFallbackUrl(plant) {
  var cat = plant.category || "other";
  var file = CATEGORY_FALLBACK_IMAGES[cat] || CATEGORY_FALLBACK_IMAGES.other;
  return "assets/plants/" + file;
}

function loadPlantTexture(plant) {
  var key = plant.name;
  if (_spriteTextureCache[key]) return _spriteTextureCache[key];

  var url = _getPlantImageUrl(plant);
  var tex = _spriteTextureLoader.load(
    url,
    function(loadedTex) {
      // Success — texture is ready
      loadedTex.colorSpace = THREE.SRGBColorSpace;
    },
    undefined,
    function() {
      // Error — try category fallback
      var fallbackUrl = _getCategoryFallbackUrl(plant);
      var fallbackTex = _spriteTextureLoader.load(fallbackUrl);
      fallbackTex.colorSpace = THREE.SRGBColorSpace;
      _spriteTextureCache[key] = fallbackTex;
    }
  );
  tex.colorSpace = THREE.SRGBColorSpace;
  _spriteTextureCache[key] = tex;
  return tex;
}

function buildBillboardMesh(plant) {
  var texture = loadPlantTexture(plant);
  var mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    depthWrite: true
  });

  // Two perpendicular planes forming an X — looks good from any angle
  var planeGeom = new THREE.PlaneGeometry(1, 1.5);

  var plane1 = new THREE.Mesh(planeGeom, mat);
  plane1.position.y = 0.75; // lift so base sits at y=0

  var plane2 = new THREE.Mesh(planeGeom, mat.clone());
  plane2.rotation.y = Math.PI / 2; // perpendicular
  plane2.position.y = 0.75;

  var group = new THREE.Group();
  group.add(plane1);
  group.add(plane2);
  return group;
}

function disposeSpriteTextureCache() {
  for (var key in _spriteTextureCache) {
    if (_spriteTextureCache[key] && _spriteTextureCache[key].dispose) {
      _spriteTextureCache[key].dispose();
    }
  }
  _spriteTextureCache = {};
}
