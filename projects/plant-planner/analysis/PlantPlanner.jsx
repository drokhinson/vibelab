import { useState, useCallback } from "react";

// ═══════════════════════════════════════════════════════
// COMPANION PLANTING DATABASE  (bundled static — no API)
// ═══════════════════════════════════════════════════════
const COMPANION_DB = {
  tomato:      { good: ["basil","carrot","marigold","parsley","garlic","borage","celery","asparagus","chives"], bad: ["fennel","cabbage","broccoli","kale","corn","potato","kohlrabi"], tip: "Basil repels aphids & spider mites and improves fruit flavor. Marigolds deter nematodes." },
  basil:       { good: ["tomato","pepper","oregano","chamomile","marigold","asparagus"], bad: ["sage","rue","thyme"], tip: "Improves growth and flavor of nearby vegetables. Keep away from sage and thyme." },
  carrot:      { good: ["tomato","lettuce","onion","leek","rosemary","sage","peas","chives"], bad: ["dill","parsnip","fennel","celery"], tip: "Tomatoes repel carrot fly. Chives improve carrot flavor and deter aphids." },
  lettuce:     { good: ["carrot","radish","strawberry","cucumber","onion","garlic","marigold","chives"], bad: ["parsley","celery"], tip: "Thrives in the partial shade of taller plants like tomatoes or corn." },
  pepper:      { good: ["basil","carrot","onion","tomato","spinach","marjoram"], bad: ["fennel","kohlrabi"], tip: "Basil repels aphids and spider mites. Good heat-sharing companion with tomato." },
  cucumber:    { good: ["beans","peas","radish","sunflower","lettuce","marigold","dill","nasturtium"], bad: ["potato","sage","fennel"], tip: "Sunflowers provide living trellis support. Radishes deter cucumber beetles." },
  beans:       { good: ["carrot","cucumber","squash","corn","strawberry","marigold","celery","peas"], bad: ["onion","garlic","chives","fennel","kohlrabi","sunflower"], tip: "Fix nitrogen in soil. Avoid all alliums — they inhibit bean growth." },
  corn:        { good: ["beans","squash","cucumber","peas","melon"], bad: ["tomato","fennel","celery"], tip: "Three Sisters trio: corn provides structure, beans fix nitrogen, squash suppresses weeds." },
  squash:      { good: ["corn","beans","nasturtium","radish","borage","marigold"], bad: ["potato","fennel"], tip: "Three Sisters: squash leaves shade the ground, suppressing weeds and retaining moisture." },
  onion:       { good: ["carrot","lettuce","tomato","strawberry","chamomile","beet"], bad: ["peas","beans","asparagus","sage"], tip: "Repels carrot fly and aphids. Avoid planting near legumes." },
  garlic:      { good: ["tomato","rose","carrot","cucumber","lettuce","beet"], bad: ["peas","beans","sage","parsley"], tip: "Natural fungicide and insect repellent. Keep away from all legumes." },
  radish:      { good: ["cucumber","squash","melon","peas","lettuce","nasturtium"], bad: ["hyssop"], tip: "Excellent trap crop for flea beetles. Plant as a sacrificial crop around cucumbers." },
  marigold:    { good: ["tomato","pepper","cucumber","squash","beans","asparagus","potato"], bad: ["cabbage","fennel"], tip: "Repels nematodes, whiteflies, and aphids. The universal companion plant." },
  peas:        { good: ["carrot","radish","turnip","cucumber","corn","beans","mint","spinach"], bad: ["onion","garlic","chives","leek","fennel","gladiolus"], tip: "Fix nitrogen; plant near heavy feeders. Avoid entire allium family." },
  spinach:     { good: ["strawberry","peas","beans","celery","onion","garlic"], bad: ["fennel"], tip: "Thrives under taller plants. Great spring and fall companion." },
  strawberry:  { good: ["spinach","lettuce","onion","garlic","borage","thyme"], bad: ["fennel","cabbage","broccoli","cauliflower"], tip: "Borage deters worms and attracts pollinators. Thyme improves flavor." },
  broccoli:    { good: ["dill","chamomile","sage","rosemary","onion","beet","celery","potato"], bad: ["tomato","pepper","strawberry","beans","fennel"], tip: "Dill attracts parasitic wasps that control cabbage worms." },
  cabbage:     { good: ["dill","chamomile","sage","rosemary","mint","onion","beet"], bad: ["tomato","pepper","strawberry","beans","fennel","rue"], tip: "Aromatic herbs confuse cabbage moths. Never plant near tomatoes." },
  rosemary:    { good: ["beans","cabbage","carrot","sage","thyme"], bad: ["cucumber","pumpkin"], tip: "Repels bean beetles, cabbage moths, and carrot fly." },
  mint:        { good: ["cabbage","tomato","peas","carrot"], bad: ["chamomile"], tip: "Plant in containers — spreads aggressively. Repels aphids, ants, and flea beetles." },
  dill:        { good: ["cabbage","broccoli","corn","cucumber","lettuce","onion"], bad: ["carrot","tomato","fennel","pepper"], tip: "Attracts beneficial insects. Keep away from mature tomatoes and carrots." },
  fennel:      { good: ["fennel"], bad: ["most vegetables","tomato","pepper","beans","peas"], tip: "Highly allelopathic — inhibits most plants. Best isolated or grown alone." },
  beet:        { good: ["onion","lettuce","cabbage","broccoli","garlic","kohlrabi"], bad: ["beans","pole beans","mustard","fennel"], tip: "Good nitrogen accumulator. Beet leaves add minerals to compost." },
  potato:      { good: ["beans","cabbage","corn","peas","marigold","horseradish"], bad: ["tomato","cucumber","pumpkin","sunflower","fennel"], tip: "Avoid tomatoes — share blight. Horseradish repels Colorado potato beetles." },
  sunflower:   { good: ["cucumber","squash","corn","melon"], bad: ["potato","beans"], tip: "Attracts pollinators. Provides shade and natural trellising for climbers." },
  chives:      { good: ["carrot","apple","rose","parsley","tomato","cucumber"], bad: ["beans","peas"], tip: "Repels aphids and Japanese beetles. Excellent near carrots." },
  borage:      { good: ["tomato","strawberry","squash","cucumber"], bad: [], tip: "Deters tomato hornworms and cabbage worms. Attracts pollinators prolifically." },
  nasturtium:  { good: ["cucumber","squash","radish","tomato","beans"], bad: [], tip: "Trap crop for aphids. Repels squash bugs and whiteflies." },
  chamomile:   { good: ["cabbage","onion","cucumber","basil","wheat"], bad: [], tip: "Calcium accumulator. Improves growth and flavor of many nearby plants." },
  lavender:    { good: ["rose","thyme","oregano","brassica","echinacea"], bad: ["fennel"], tip: "Repels fleas, moths, and many insects. Strong pollinator attractor." },
  zucchini:    { good: ["corn","beans","nasturtium","radish","borage","marigold"], bad: ["potato","fennel"], tip: "Part of the Three Sisters trio. Nasturtiums repel squash bugs." },
  kale:        { good: ["beet","celery","cucumber","dill","onion","potato"], bad: ["tomato","strawberry","beans","fennel"], tip: "Dill and celery improve flavor. Keep away from other nightshades." },
};

// ═══════════════════════════════════════════════════════
// DEMO PLANTS  (so the tool works with zero API keys)
// ═══════════════════════════════════════════════════════
const DEMO_PLANTS = [
  { id:"d-tomato",    source:"demo", name:"Cherry Tomato",    scientific:"Solanum lycopersicum var. cerasiforme", family:"Nightshade", image:null, emoji:"🍅", hardiness:{min:3,max:11}, sunlight:"full_sun",   watering:"average",  cycle:"annual",    height:{min:90,max:150}, daysToHarvest:65, edible:true, vegetable:true, toxicity:"none", growthRate:"rapid",   ph:{min:6.0,max:6.8}, sowing:"Start indoors 6–8 weeks before last frost. Transplant when nights stay above 50°F (10°C).", tags:["edible","vegetable"] },
  { id:"d-basil",     source:"demo", name:"Sweet Basil",      scientific:"Ocimum basilicum",                      family:"Mint",       image:null, emoji:"🌿", hardiness:{min:9,max:11}, sunlight:"full_sun",   watering:"average",  cycle:"annual",    height:{min:30,max:60},  daysToHarvest:28, edible:true, vegetable:false,toxicity:"none", growthRate:"rapid",   ph:{min:6.0,max:7.5}, sowing:"Direct sow after last frost or start indoors 4 weeks early. Needs warm soil (>60°F).", tags:["edible","herb"] },
  { id:"d-carrot",    source:"demo", name:"Nantes Carrot",    scientific:"Daucus carota subsp. sativus",          family:"Carrot",     image:null, emoji:"🥕", hardiness:{min:3,max:10}, sunlight:"full_sun",   watering:"average",  cycle:"annual",    height:{min:20,max:40},  daysToHarvest:75, edible:true, vegetable:true, toxicity:"none", growthRate:"moderate",ph:{min:6.0,max:6.8}, sowing:"Direct sow 3–5 weeks before last frost. Thin to 2–3 inches apart. Avoid transplanting.", tags:["edible","vegetable"] },
  { id:"d-lettuce",   source:"demo", name:"Butterhead Lettuce",scientific:"Lactuca sativa var. capitata",         family:"Daisy",      image:null, emoji:"🥬", hardiness:{min:3,max:11}, sunlight:"part_shade", watering:"average",  cycle:"annual",    height:{min:20,max:35},  daysToHarvest:50, edible:true, vegetable:true, toxicity:"none", growthRate:"rapid",   ph:{min:6.0,max:7.0}, sowing:"Sow outdoors 4–6 weeks before last frost. Bolt-prone in heat — use shade cloth in summer.", tags:["edible","vegetable"] },
  { id:"d-cucumber",  source:"demo", name:"Garden Cucumber",  scientific:"Cucumis sativus",                       family:"Gourd",      image:null, emoji:"🥒", hardiness:{min:4,max:12}, sunlight:"full_sun",   watering:"frequent", cycle:"annual",    height:{min:150,max:250},daysToHarvest:60, edible:true, vegetable:true, toxicity:"none", growthRate:"rapid",   ph:{min:6.0,max:7.0}, sowing:"Direct sow after last frost, once soil reaches 60°F. Needs trellis or ample ground space.", tags:["edible","vegetable"] },
  { id:"d-marigold",  source:"demo", name:"French Marigold",  scientific:"Tagetes patula",                        family:"Daisy",      image:null, emoji:"🌼", hardiness:{min:2,max:11}, sunlight:"full_sun",   watering:"minimum",  cycle:"annual",    height:{min:20,max:40},  daysToHarvest:null,edible:false,vegetable:false,toxicity:"low",  growthRate:"rapid",   ph:{min:5.8,max:7.0}, sowing:"Start indoors 6–8 weeks before last frost, or direct sow after. Very easy to grow.", tags:["pest-deterrent"] },
  { id:"d-garlic",    source:"demo", name:"Hardneck Garlic",  scientific:"Allium sativum var. ophioscorodon",     family:"Amaryllis",  image:null, emoji:"🧄", hardiness:{min:3,max:9},  sunlight:"full_sun",   watering:"minimum",  cycle:"perennial", height:{min:45,max:70},  daysToHarvest:240,edible:true, vegetable:false,toxicity:"none", growthRate:"slow",    ph:{min:6.0,max:7.0}, sowing:"Plant cloves in fall (Oct–Nov). Mulch heavily over winter. Harvest next summer when leaves brown.", tags:["edible","herb","pest-deterrent"] },
  { id:"d-zucchini",  source:"demo", name:"Zucchini Squash",  scientific:"Cucurbita pepo var. cylindrica",        family:"Gourd",      image:null, emoji:"🥦", hardiness:{min:3,max:11}, sunlight:"full_sun",   watering:"frequent", cycle:"annual",    height:{min:60,max:100}, daysToHarvest:55, edible:true, vegetable:true, toxicity:"none", growthRate:"rapid",   ph:{min:6.0,max:7.5}, sowing:"Direct sow 2 weeks after last frost. Needs space — plant 3 feet apart. Harvest young.", tags:["edible","vegetable"] },
  { id:"d-rosemary",  source:"demo", name:"Rosemary",         scientific:"Salvia rosmarinus",                     family:"Mint",       image:null, emoji:"🌱", hardiness:{min:6,max:10}, sunlight:"full_sun",   watering:"minimum",  cycle:"perennial", height:{min:60,max:150}, daysToHarvest:null,edible:true, vegetable:false,toxicity:"none", growthRate:"slow",    ph:{min:6.0,max:8.0}, sowing:"Propagate from cuttings or buy transplants. Extremely drought-tolerant once established.", tags:["edible","herb","pest-deterrent"] },
  { id:"d-beans",     source:"demo", name:"Bush Beans",       scientific:"Phaseolus vulgaris",                    family:"Legume",     image:null, emoji:"🫘", hardiness:{min:3,max:10}, sunlight:"full_sun",   watering:"average",  cycle:"annual",    height:{min:40,max:65},  daysToHarvest:55, edible:true, vegetable:true, toxicity:"none", growthRate:"rapid",   ph:{min:6.0,max:7.5}, sowing:"Direct sow after last frost. Avoid transplanting. Inoculate seeds with rhizobium for nitrogen fixation.", tags:["edible","vegetable","nitrogen-fixer"] },
  { id:"d-mint",      source:"demo", name:"Spearmint",        scientific:"Mentha spicata",                        family:"Mint",       image:null, emoji:"🌿", hardiness:{min:3,max:11}, sunlight:"part_shade", watering:"average",  cycle:"perennial", height:{min:30,max:90},  daysToHarvest:30, edible:true, vegetable:false,toxicity:"none", growthRate:"rapid",   ph:{min:6.0,max:7.0}, sowing:"Grow in containers to prevent aggressive spreading. Divide clumps in spring.", tags:["edible","herb","pest-deterrent"] },
  { id:"d-kale",      source:"demo", name:"Curly Kale",       scientific:"Brassica oleracea var. sabellica",      family:"Mustard",    image:null, emoji:"🥬", hardiness:{min:3,max:9},  sunlight:"full_sun",   watering:"average",  cycle:"annual",    height:{min:45,max:90},  daysToHarvest:60, edible:true, vegetable:true, toxicity:"none", growthRate:"moderate",ph:{min:6.0,max:7.5}, sowing:"Start indoors 6 weeks early or direct sow in late summer for fall harvest. Cold-hardy.", tags:["edible","vegetable"] },
];

// ═══════════════════════════════════════════════════════
// NORMALIZE FUNCTIONS  (common plant shape from each API)
// ═══════════════════════════════════════════════════════
function normalizeTrefle(p) {
  const lightVal = p.growth?.light;
  const sun = lightVal >= 7 ? "full_sun" : lightVal >= 4 ? "part_shade" : lightVal != null ? "full_shade" : null;
  return {
    id: `trefle-${p.id}`, source: "trefle",
    name: p.common_name || p.scientific_name,
    scientific: p.scientific_name, family: p.family_common_name || p.family,
    image: p.image_url, emoji: "🌿",
    hardiness: null,
    sunlight: sun, watering: null, cycle: Array.isArray(p.duration) ? p.duration[0] : p.duration,
    height: p.specifications?.average_height?.cm ? { min: Math.round(p.specifications.average_height.cm * 0.6), max: p.specifications.average_height.cm } : null,
    daysToHarvest: p.growth?.days_to_harvest,
    edible: p.edible, vegetable: p.vegetable,
    toxicity: p.specifications?.toxicity, growthRate: p.specifications?.growth_rate,
    ph: p.growth?.ph_minimum != null ? { min: p.growth.ph_minimum, max: p.growth.ph_maximum } : null,
    sowing: p.growth?.sowing, nitrogen: p.specifications?.nitrogen_fixation, tags: [],
  };
}

function normalizePerenual(p) {
  const sl = Array.isArray(p.sunlight) ? p.sunlight[0] : p.sunlight;
  const sunMap = { full_sun:"full_sun", part_shade:"part_shade", full_shade:"full_shade", "sun-part_shade":"part_shade" };
  return {
    id: `perenual-${p.id}`, source: "perenual",
    name: p.common_name, scientific: Array.isArray(p.scientific_name) ? p.scientific_name[0] : p.scientific_name,
    family: null, image: p.default_image?.regular_url || p.default_image?.original_url, emoji: "🌿",
    hardiness: p.hardiness ? { min: Number(p.hardiness.min), max: Number(p.hardiness.max) } : null,
    sunlight: sunMap[sl] || sl, watering: p.watering, cycle: p.cycle,
    height: null, daysToHarvest: null, edible: null, vegetable: null,
    toxicity: null, growthRate: null, ph: null, sowing: null, tags: [],
  };
}

function normalizeFlora(p) {
  return {
    id: `flora-${p.id || p.slug}`, source: "flora",
    name: p.common_name || p.name, scientific: p.scientific_name, family: p.family,
    image: p.image_url || p.image, emoji: "🌿",
    hardiness: p.hardiness_zone ? { min: parseInt(p.hardiness_zone), max: parseInt(p.hardiness_zone) + 2 } : null,
    sunlight: p.sun_exposure || p.sunlight, watering: p.water_needs || p.watering, cycle: p.duration || p.lifecycle,
    height: p.height_max ? { min: 0, max: parseFloat(p.height_max) } : null,
    daysToHarvest: null, edible: p.edible, vegetable: null, toxicity: p.toxicity, growthRate: null, ph: null, sowing: null, tags: [],
  };
}

// ═══════════════════════════════════════════════════════
// API CALLS
// ═══════════════════════════════════════════════════════
async function doTrefle(q, token) {
  const r = await fetch(`https://trefle.io/api/v1/plants/search?q=${encodeURIComponent(q)}&token=${token}`);
  if (!r.ok) throw new Error(`Trefle ${r.status}`);
  const j = await r.json();
  return (j.data || []).map(normalizeTrefle);
}

async function doFlora(q, key) {
  const r = await fetch(`https://floraapi.com/api/plants?search=${encodeURIComponent(q)}&api_key=${key}&limit=20`);
  if (!r.ok) throw new Error(`Flora ${r.status}`);
  const j = await r.json();
  return (j.data || j.plants || j.results || []).map(normalizeFlora);
}

async function doPerenual(q, key) {
  const r = await fetch(`https://perenual.com/api/v2/species-list?key=${key}&q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`Perenual ${r.status}`);
  const j = await r.json();
  return (j.data || []).map(normalizePerenual);
}

// ═══════════════════════════════════════════════════════
// COMPANION HELPERS
// ═══════════════════════════════════════════════════════
function getStaticCompanions(name) {
  if (!name) return null;
  const key = name.toLowerCase();
  if (COMPANION_DB[key]) return COMPANION_DB[key];
  for (const [k, v] of Object.entries(COMPANION_DB)) {
    if (key.includes(k) || k.includes(key.split(" ")[0])) return v;
  }
  return null;
}

// ═══════════════════════════════════════════════════════
// SOURCE META
// ═══════════════════════════════════════════════════════
const SRC = {
  demo:    { bg:"#f3e8ff", fg:"#6b21a8", label:"Demo Data" },
  trefle:  { bg:"#dcfce7", fg:"#15803d", label:"Trefle OSS" },
  flora:   { bg:"#dbeafe", fg:"#1d4ed8", label:"Flora API" },
  perenual:{ bg:"#fce7f3", fg:"#9d174d", label:"Perenual" },
};

const SUN_LABEL  = { full_sun:"Full Sun", part_shade:"Part Shade", full_shade:"Full Shade" };
const SUN_EMOJI  = { full_sun:"☀️", part_shade:"⛅", full_shade:"🌥️" };
const WATER_EMOJI= { frequent:"💧💧💧", average:"💧💧", minimum:"💧", none:"🏜️" };

// ═══════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════
export default function PlantPlanner() {
  const [tab,    setTab]    = useState("explore");
  const [keys,   setKeys]   = useState({ trefle:"", flora:"", perenual:"" });
  const [query,  setQuery]  = useState("");
  const [results,setResults]= useState([]);
  const [loading,setLoading]= useState(false);
  const [error,  setError]  = useState(null);
  const [srcUsed,setSrcUsed]= useState(null);   // which API responded
  const [selected,setSelected]= useState(null);
  const [palette,setPalette]= useState([]);      // plants added to garden
  const [grid,   setGrid]   = useState(Array(48).fill(null));  // 8×6
  const [cursor, setCursor] = useState(null);    // active palette plant to place
  const [aiData, setAiData] = useState({});      // Claude-generated companion data
  const [aiLoading,setAiLoading]= useState(false);

  // ── SEARCH ──────────────────────────────────────────
  const search = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true); setError(null); setResults([]); setSrcUsed(null);

    // Filter to only configured keys (Trefle → Flora → Perenual)
    const chain = [
      keys.trefle  && { fn:()=>doTrefle(query,keys.trefle),   src:"trefle"   },
      keys.flora   && { fn:()=>doFlora(query,keys.flora),     src:"flora"    },
      keys.perenual&& { fn:()=>doPerenual(query,keys.perenual),src:"perenual" },
    ].filter(Boolean);

    // Local demo filter always available
    const demoMatches = DEMO_PLANTS.filter(p =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      p.scientific.toLowerCase().includes(query.toLowerCase())
    );

    if (chain.length === 0) {
      setResults(demoMatches.length ? demoMatches : []);
      setSrcUsed("demo");
      if (!demoMatches.length) setError("No demo plants matched. Add an API key in Sources for full search.");
      setLoading(false); return;
    }

    let success = false;
    for (const { fn, src } of chain) {
      try {
        const data = await fn();
        setResults(data); setSrcUsed(src); success = true; break;
      } catch (e) {
        console.warn(`${src} failed:`, e.message);
      }
    }
    if (!success) {
      // All APIs failed — fall back to demo
      setResults(demoMatches);
      setSrcUsed("demo");
      setError("Live APIs unavailable — showing local demo matches.");
    }
    setLoading(false);
  }, [query, keys]);

  // ── AI COMPANION LOOKUP ─────────────────────────────
  const fetchAI = useCallback(async (plantName) => {
    if (aiData[plantName]) return;
    setAiLoading(true);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514", max_tokens:800,
          system:"You are a gardening expert. Respond ONLY with valid JSON — no markdown, no preamble. Schema: {\"good\":[string],\"bad\":[string],\"tip\":string}. good/bad = lowercase common plant names.",
          messages:[{ role:"user", content:`Companion planting for: ${plantName}` }]
        })
      });
      const j = await r.json();
      const txt = j.content?.[0]?.text || "{}";
      const parsed = JSON.parse(txt.replace(/```json|```/g,"").trim());
      setAiData(prev => ({ ...prev, [plantName]: parsed }));
    } catch(e) { console.warn("AI companion error:", e); }
    setAiLoading(false);
  }, [aiData]);

  // ── GARDEN BED LOGIC ────────────────────────────────
  const placeInCell = (idx) => {
    if (!cursor) return;
    setGrid(prev => { const n=[...prev]; n[idx]=cursor; return n; });
  };
  const clearCell = (idx) => setGrid(prev => { const n=[...prev]; n[idx]=null; return n; });

  const adjCells = (idx) => {
    const cols=8, r=Math.floor(idx/cols), c=idx%cols, out=[];
    if (r>0) out.push(idx-cols); if (r<5) out.push(idx+cols);
    if (c>0) out.push(idx-1);   if (c<7) out.push(idx+1);
    return out;
  };

  const cellCompat = (idx) => {
    const p = grid[idx]; if (!p) return null;
    const neighbors = adjCells(idx).map(i=>grid[i]).filter(Boolean);
    if (!neighbors.length) return null;
    const comp = getStaticCompanions(p.name) || aiData[p.name];
    if (!comp) return "neutral";
    let good=0, bad=0;
    for (const nb of neighbors) {
      const n=nb.name.toLowerCase().split(" ")[0];
      if ((comp.good||[]).some(g=>g.includes(n)||n.includes(g))) good++;
      if ((comp.bad||[]).some(b=>b.includes(n)||n.includes(b))) bad++;
    }
    return bad>0?"bad": good>0?"good":"neutral";
  };

  // ── COMPANION DATA for selected plant ───────────────
  const staticComp = selected ? getStaticCompanions(selected.name) : null;
  const aiComp     = selected ? aiData[selected.name] : null;
  const companions  = staticComp || aiComp;

  // ── RENDER ──────────────────────────────────────────
  return (
    <div style={{ fontFamily:"'DM Sans',sans-serif", background:"#F4EFE6", minHeight:"100vh", color:"#1A1A1A" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&display=swap');
        *{box-sizing:border-box;}
        .pcard{cursor:pointer;transition:all .18s ease;}
        .pcard:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(28,58,43,.14)!important;}
        .gcell{transition:all .15s;cursor:pointer;border:1px solid #C8B99A;border-radius:5px;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;}
        .gcell:hover{background:rgba(28,58,43,.1)!important;}
        .gcell.good{border-color:#2e7d32;box-shadow:0 0 0 2px rgba(46,125,50,.35);}
        .gcell.bad {border-color:#c62828;box-shadow:0 0 0 2px rgba(198,40,40,.35);}
        .tag{display:inline-flex;align-items:center;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:500;}
        .inp{width:100%;padding:8px 12px;border:1.5px solid #DDD;border-radius:7px;font-family:'DM Sans';font-size:13px;outline:none;background:white;}
        .inp:focus{border-color:#1C3A2B;box-shadow:0 0 0 3px rgba(28,58,43,.1);}
        .scr::-webkit-scrollbar{width:3px;} .scr::-webkit-scrollbar-thumb{background:#C8B99A;border-radius:2px;}
        .btn{background:#1C3A2B;color:white;border:none;cursor:pointer;padding:9px 20px;border-radius:7px;font-family:'DM Sans';font-size:13px;font-weight:500;transition:background .15s;}
        .btn:hover{background:#2d5c42;} .btn:disabled{opacity:.5;cursor:not-allowed;}
        .tbtn{padding:9px 18px;border:none;background:transparent;cursor:pointer;font-family:'DM Sans';font-size:13px;font-weight:500;color:rgba(255,255,255,.55);border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap;}
        .tbtn.on{color:#a5d6a7;border-bottom-color:#a5d6a7;}
        .tbtn:hover{color:rgba(255,255,255,.85);}
      `}</style>

      {/* ── HEADER ───────────────────────────────────── */}
      <div style={{ background:"#1C3A2B" }}>
        <div style={{ maxWidth:1200, margin:"0 auto", padding:"0 24px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ display:"flex", alignItems:"center", gap:12, padding:"14px 0 0" }}>
            <span style={{ fontSize:26 }}>🌱</span>
            <div>
              <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:22, fontWeight:600, color:"white", letterSpacing:.3, lineHeight:1 }}>PlantPlanner</div>
              <div style={{ fontSize:10, color:"rgba(255,255,255,.45)", letterSpacing:1.5, textTransform:"uppercase" }}>Garden Design Tool</div>
            </div>
          </div>
          <div style={{ display:"flex", gap:0 }}>
            {[["explore","🔍 Explore"],["planner","🌿 Garden"],["sources","⚙️ Sources"]].map(([t,label])=>(
              <button key={t} className={`tbtn ${tab===t?"on":""}`} onClick={()=>setTab(t)}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth:1200, margin:"0 auto", padding:"20px 24px" }}>

        {/* ══════════════ SOURCES TAB ══════════════ */}
        {tab==="sources" && (
          <div style={{ maxWidth:620 }}>
            <h2 style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:30, fontWeight:600, color:"#1C3A2B", margin:"0 0 6px" }}>API Sources</h2>
            <p style={{ color:"#666", fontSize:13, lineHeight:1.7, margin:"0 0 24px" }}>
              Configure your API keys. PlantPlanner cascades — <strong>Trefle → Flora → Perenual</strong> — and uses the first successful response. Demo plants are always available with zero keys.
            </p>

            {[
              { id:"trefle",  label:"Trefle",   badge:"Open Source · Free",    desc:"Botanical REST API with 400k+ plant species. Register free at trefle.io.",           url:"https://trefle.io/profile",              color:"#15803d" },
              { id:"flora",   label:"Flora API", badge:"US Native · Paid",      desc:"29,000+ US species, county-level distribution, native/invasive flags. floraapi.com.", url:"https://floraapi.com",                   color:"#1d4ed8" },
              { id:"perenual",label:"Perenual",  badge:"Garden-Focused · Freemium",desc:"10,000+ species with care guides, hardiness zones, and images. perenual.com.",    url:"https://perenual.com/user/developer",    color:"#9d174d" },
            ].map(({ id, label, badge, desc, url, color }) => (
              <div key={id} style={{ background:"white", borderRadius:12, padding:20, marginBottom:14, boxShadow:"0 1px 6px rgba(0,0,0,.06)" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
                  <div>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <span style={{ fontWeight:600, fontSize:15 }}>{label}</span>
                      <span style={{ fontSize:10, background: id==="trefle"?"#dcfce7":id==="flora"?"#dbeafe":"#fce7f3", color, padding:"2px 8px", borderRadius:20, fontWeight:600 }}>{badge}</span>
                      {keys[id] && <span style={{ fontSize:11, color:"#2e7d32", fontWeight:600 }}>✓ Set</span>}
                    </div>
                    <div style={{ fontSize:12, color:"#888", marginTop:3 }}>{desc}</div>
                  </div>
                  <a href={url} target="_blank" rel="noreferrer" style={{ fontSize:11, color, textDecoration:"none", whiteSpace:"nowrap", marginLeft:16 }}>Get Key →</a>
                </div>
                <input className="inp" type="password" placeholder={`Paste ${label} API key…`}
                  value={keys[id]} onChange={e=>setKeys(p=>({...p,[id]:e.target.value}))} />
              </div>
            ))}

            <div style={{ background:"#f0f7f4", border:"1px solid #bbddc8", borderRadius:10, padding:14, fontSize:13, color:"#2e7d32", lineHeight:1.6 }}>
              <strong>💡 Companion planting</strong> is always available — it's bundled locally with Claude AI as a fallback for any plant not in the database.
            </div>
          </div>
        )}

        {/* ══════════════ EXPLORE TAB ══════════════ */}
        {tab==="explore" && (
          <div style={{ display:"flex", gap:20, alignItems:"flex-start" }}>

            {/* LEFT: search + results */}
            <div style={{ flex:"0 0 340px" }}>
              {/* Search */}
              <div style={{ display:"flex", gap:8, marginBottom:14 }}>
                <input
                  style={{ flex:1, padding:"10px 14px", border:"2px solid #DDD6C8", background:"white", borderRadius:9, fontFamily:"'DM Sans'", fontSize:14, outline:"none" }}
                  value={query} onChange={e=>setQuery(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&search()}
                  onFocus={e=>e.target.style.borderColor="#1C3A2B"}
                  onBlur={e=>e.target.style.borderColor="#DDD6C8"}
                  placeholder="tomato, basil, carrot…" />
                <button className="btn" onClick={search} disabled={loading}>
                  {loading ? "…" : "Search"}
                </button>
              </div>

              {/* Source badge */}
              {srcUsed && (
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                  <span style={{ fontSize:11, color:"#999" }}>Showing:</span>
                  <span style={{ ...SRC[srcUsed], background:SRC[srcUsed]?.bg, color:SRC[srcUsed]?.fg, fontSize:10, fontWeight:700, padding:"2px 10px", borderRadius:20, letterSpacing:.5 }}>{SRC[srcUsed]?.label}</span>
                </div>
              )}

              {/* No keys prompt */}
              {!keys.trefle && !keys.flora && !keys.perenual && !srcUsed && (
                <div style={{ background:"white", border:"2px dashed #C8B99A", borderRadius:12, padding:20, textAlign:"center", marginBottom:14 }}>
                  <div style={{ fontSize:36, marginBottom:8 }}>🔑</div>
                  <div style={{ fontWeight:500, fontSize:14, color:"#1C3A2B", marginBottom:4 }}>No API keys configured</div>
                  <div style={{ fontSize:12, color:"#888", marginBottom:14 }}>Search will use demo plants. Add keys in Sources for full access.</div>
                  <div style={{ display:"flex", gap:8, justifyContent:"center" }}>
                    <button className="btn" onClick={()=>setTab("sources")} style={{ fontSize:12, padding:"6px 14px" }}>Configure Sources</button>
                    <button onClick={search} style={{ border:"1.5px solid #1C3A2B", background:"none", borderRadius:7, padding:"6px 14px", fontSize:12, cursor:"pointer", color:"#1C3A2B", fontWeight:500 }}>Try Demo Search</button>
                  </div>
                </div>
              )}

              {/* Error */}
              {error && (
                <div style={{ background:"#fff8e1", border:"1px solid #ffe082", borderRadius:8, padding:10, marginBottom:10, fontSize:12, color:"#5d4037" }}>⚠️ {error}</div>
              )}

              {/* Results */}
              <div className="scr" style={{ maxHeight:"calc(100vh - 260px)", overflowY:"auto", paddingRight:2 }}>
                {results.map(plant => {
                  const isSel = selected?.id === plant.id;
                  return (
                    <div key={plant.id} className="pcard"
                      onClick={() => { setSelected(plant); if (!getStaticCompanions(plant.name)) fetchAI(plant.name); }}
                      style={{ background:"white", borderRadius:10, overflow:"hidden", marginBottom:8,
                        boxShadow: isSel ? "0 0 0 2px #1C3A2B, 0 4px 16px rgba(28,58,43,.12)" : "0 1px 6px rgba(0,0,0,.06)" }}>
                      <div style={{ display:"flex" }}>
                        {/* thumbnail */}
                        <div style={{ width:76, height:76, flexShrink:0, background:"linear-gradient(135deg,#e8f5e9,#c8e6c9)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:32 }}>
                          {plant.image ? <img src={plant.image} alt={plant.name} style={{ width:"100%", height:"100%", objectFit:"cover" }} /> : plant.emoji}
                        </div>
                        {/* text */}
                        <div style={{ flex:1, padding:"9px 11px", minWidth:0 }}>
                          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontWeight:600, fontSize:16, color:"#1C3A2B", lineHeight:1.2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{plant.name}</div>
                          <div style={{ fontSize:11, color:"#999", fontStyle:"italic", marginBottom:5, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{plant.scientific}</div>
                          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                            {plant.sunlight  && <span style={{ fontSize:11, color:"#555" }}>{SUN_EMOJI[plant.sunlight]} {SUN_LABEL[plant.sunlight]}</span>}
                            {plant.watering  && <span style={{ fontSize:11, color:"#555" }}>{WATER_EMOJI[plant.watering] || "💧"} {plant.watering}</span>}
                            {plant.daysToHarvest && <span style={{ fontSize:11, color:"#555" }}>🗓 {plant.daysToHarvest}d</span>}
                          </div>
                        </div>
                        {/* actions */}
                        <div style={{ display:"flex", flexDirection:"column", justifyContent:"center", padding:"0 8px 0 0", gap:6 }}>
                          <button onClick={e=>{ e.stopPropagation(); if(!palette.find(p=>p.id===plant.id)) setPalette(p=>[...p,plant]); }}
                            title="Add to garden palette"
                            style={{ background:"none", border:"1.5px solid #1C3A2B", borderRadius:5, cursor:"pointer", padding:"3px 8px", fontSize:11, color:"#1C3A2B", fontWeight:500, whiteSpace:"nowrap" }}>
                            + Plot
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {results.length === 0 && !loading && srcUsed && (
                  <div style={{ textAlign:"center", padding:"40px 0", color:"#999" }}>
                    <div style={{ fontSize:40, marginBottom:8 }}>🔍</div>
                    <div style={{ fontSize:13 }}>No results found</div>
                  </div>
                )}
              </div>
            </div>

            {/* RIGHT: detail panel */}
            <div style={{ flex:1 }}>
              {selected ? (
                <div style={{ background:"white", borderRadius:16, overflow:"hidden", boxShadow:"0 4px 24px rgba(0,0,0,.08)" }}>
                  {/* Hero image */}
                  <div style={{ position:"relative", height:210, overflow:"hidden", background:"linear-gradient(135deg,#1C3A2B,#2d5c42)", display:"flex", alignItems:"center", justifyContent:"center" }}>
                    {selected.image
                      ? <img src={selected.image} alt={selected.name} style={{ width:"100%", height:"100%", objectFit:"cover" }} />
                      : <span style={{ fontSize:90, opacity:.7 }}>{selected.emoji}</span>}
                    <div style={{ position:"absolute", inset:0, background:"linear-gradient(to top,rgba(0,0,0,.65) 0%,transparent 55%)" }} />
                    {/* Source badge */}
                    <div style={{ position:"absolute", top:12, right:12, background:SRC[selected.source]?.bg, color:SRC[selected.source]?.fg, fontSize:10, fontWeight:700, padding:"3px 10px", borderRadius:20, letterSpacing:.5 }}>{SRC[selected.source]?.label}</div>
                    {/* Close */}
                    <button onClick={()=>setSelected(null)} style={{ position:"absolute", top:12, left:12, background:"rgba(0,0,0,.3)", border:"none", borderRadius:"50%", width:28, height:28, cursor:"pointer", color:"white", fontSize:14, display:"flex", alignItems:"center", justifyContent:"center" }}>✕</button>
                    {/* Name */}
                    <div style={{ position:"absolute", bottom:14, left:18, right:60 }}>
                      <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:28, fontWeight:600, color:"white", lineHeight:1.1 }}>{selected.name}</div>
                      <div style={{ fontSize:12, color:"rgba(255,255,255,.7)", fontStyle:"italic" }}>{selected.scientific}</div>
                    </div>
                  </div>

                  {/* Data */}
                  <div className="scr" style={{ overflowY:"auto", maxHeight:"calc(100vh - 360px)", padding:20 }}>
                    {/* Stat grid */}
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:18 }}>
                      {[
                        { icon:"☀️", label:"Sunlight",   val: SUN_LABEL[selected.sunlight] || selected.sunlight || "—" },
                        { icon:"💧", label:"Watering",   val: selected.watering || "—" },
                        { icon:"🌡️", label:"USDA Zones", val: selected.hardiness ? `${selected.hardiness.min} – ${selected.hardiness.max}` : "—" },
                        { icon:"📏", label:"Height",     val: selected.height ? `${selected.height.max} cm` : "—" },
                        { icon:"⏱",  label:"Harvest",    val: selected.daysToHarvest ? `${selected.daysToHarvest} days` : "—" },
                        { icon:"🔄", label:"Cycle",      val: selected.cycle || "—" },
                        { icon:"⚗️", label:"Soil pH",    val: selected.ph ? `${selected.ph.min} – ${selected.ph.max}` : "—" },
                        { icon:"⚡", label:"Growth Rate", val: selected.growthRate || "—" },
                        { icon:"☠️", label:"Toxicity",   val: selected.toxicity || "—" },
                      ].map(({ icon, label, val }) => (
                        <div key={label} style={{ background:"#F4EFE6", borderRadius:8, padding:"10px 12px" }}>
                          <div style={{ fontSize:10, color:"#999", textTransform:"uppercase", letterSpacing:.7, marginBottom:2 }}>{icon} {label}</div>
                          <div style={{ fontWeight:500, fontSize:13, textTransform:"capitalize" }}>{val}</div>
                        </div>
                      ))}
                    </div>

                    {/* Tags */}
                    {selected.tags?.length > 0 && (
                      <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:16 }}>
                        {selected.tags.map(t=>(
                          <span key={t} className="tag" style={{ background:"#e8f5e9", color:"#2e7d32" }}>{t}</span>
                        ))}
                      </div>
                    )}

                    {/* Sowing */}
                    {selected.sowing && (
                      <div style={{ background:"#f0f7f4", border:"1px solid #bbddc8", borderRadius:8, padding:14, marginBottom:16, fontSize:13, color:"#1A1A1A", lineHeight:1.65 }}>
                        <strong>🌱 Sowing guide:</strong> {selected.sowing}
                      </div>
                    )}

                    {/* ── Companion Planting ── */}
                    <div style={{ borderTop:"1px solid #eee", paddingTop:16 }}>
                      <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:22, fontWeight:600, color:"#1C3A2B", marginBottom:12 }}>Companion Planting</div>

                      {companions ? (
                        <>
                          {companions.tip && (
                            <div style={{ background:"#fffde7", border:"1px solid #fff176", borderRadius:8, padding:12, marginBottom:14, fontSize:13, color:"#4e342e", lineHeight:1.6 }}>
                              💡 {companions.tip}
                            </div>
                          )}
                          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
                            <div>
                              <div style={{ fontSize:11, fontWeight:600, color:"#2e7d32", textTransform:"uppercase", letterSpacing:.7, marginBottom:8 }}>✅ Plant Together</div>
                              <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                                {(companions.good||[]).map(n=><span key={n} className="tag" style={{ background:"#e8f5e9", color:"#2e7d32" }}>{n}</span>)}
                                {(companions.good||[]).length===0 && <span style={{ fontSize:12, color:"#aaa" }}>None listed</span>}
                              </div>
                            </div>
                            <div>
                              <div style={{ fontSize:11, fontWeight:600, color:"#c62828", textTransform:"uppercase", letterSpacing:.7, marginBottom:8 }}>❌ Keep Apart</div>
                              <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                                {(companions.bad||[]).map(n=><span key={n} className="tag" style={{ background:"#ffebee", color:"#c62828" }}>{n}</span>)}
                                {(companions.bad||[]).length===0 && <span style={{ fontSize:12, color:"#aaa" }}>None listed</span>}
                              </div>
                            </div>
                          </div>
                          {!staticComp && aiComp && (
                            <div style={{ fontSize:11, color:"#aaa", marginTop:10 }}>✨ Companion data generated by Claude AI</div>
                          )}
                        </>
                      ) : aiLoading ? (
                        <div style={{ textAlign:"center", padding:24, color:"#888", fontSize:13 }}>🌿 Asking Claude for companion data…</div>
                      ) : (
                        <div style={{ textAlign:"center", padding:16 }}>
                          <div style={{ fontSize:13, color:"#888", marginBottom:12 }}>Not in local database — ask Claude to generate companion data</div>
                          <button className="btn" onClick={()=>fetchAI(selected.name)}>✨ Ask Claude</button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ height:460, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", color:"#aaa", gap:10 }}>
                  <div style={{ fontSize:72 }}>🌸</div>
                  <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:24, color:"#1C3A2B" }}>Select a plant to see details</div>
                  <div style={{ fontSize:13 }}>Search above, then click any card</div>
                  <div style={{ marginTop:16, fontSize:12, color:"#bbb" }}>
                    {DEMO_PLANTS.length} demo plants available · Try "tomato", "basil", or "carrot"
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══════════════ PLANNER TAB ══════════════ */}
        {tab==="planner" && (
          <div style={{ display:"flex", gap:20, alignItems:"flex-start" }}>

            {/* Plant palette */}
            <div style={{ flex:"0 0 190px" }}>
              <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:22, fontWeight:600, color:"#1C3A2B", marginBottom:4 }}>Plant Palette</div>
              <div style={{ fontSize:12, color:"#888", marginBottom:12, lineHeight:1.5 }}>
                Add plants from Explore. Select one here, then click a cell to place it.
              </div>

              {palette.length === 0 ? (
                <div style={{ border:"2px dashed #C8B99A", borderRadius:10, padding:20, textAlign:"center" }}>
                  <div style={{ fontSize:28, marginBottom:6 }}>🪴</div>
                  <div style={{ fontSize:12, color:"#888" }}>Search plants in Explore and click "＋ Plot" to add them here.</div>
                </div>
              ) : (
                palette.map(plant => {
                  const isCursor = cursor?.id === plant.id;
                  return (
                    <div key={plant.id}
                      onClick={() => setCursor(isCursor ? null : plant)}
                      style={{ background: isCursor?"#1C3A2B":"white", color: isCursor?"white":"#1A1A1A",
                        borderRadius:8, padding:"8px 10px", marginBottom:7, cursor:"pointer",
                        display:"flex", alignItems:"center", gap:8,
                        boxShadow: isCursor?"0 4px 12px rgba(28,58,43,.3)":"0 1px 4px rgba(0,0,0,.06)",
                        transition:"all .15s" }}>
                      <span style={{ fontSize:22 }}>{plant.emoji}</span>
                      <span style={{ fontSize:13, fontWeight:500, flex:1, lineHeight:1.2 }}>{plant.name}</span>
                      <button onClick={e=>{ e.stopPropagation(); setPalette(p=>p.filter(x=>x.id!==plant.id)); if(cursor?.id===plant.id) setCursor(null); }}
                        style={{ background:"none", border:"none", cursor:"pointer", color:"inherit", opacity:.5, fontSize:13, padding:0 }}>✕</button>
                    </div>
                  );
                })
              )}

              {/* Legend */}
              <div style={{ marginTop:22, padding:"14px 0", borderTop:"1px solid #E0D8CC" }}>
                <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:.7, marginBottom:8 }}>Compatibility</div>
                {[["🟢","Good neighbors"],["🔴","Antagonists nearby"],["⬜","Neutral / unknown"]].map(([icon,label])=>(
                  <div key={label} style={{ fontSize:12, color:"#666", marginBottom:4, display:"flex", gap:6, alignItems:"center" }}><span>{icon}</span>{label}</div>
                ))}
              </div>

              {cursor && (
                <div style={{ background:"#e8f5e9", border:"1px solid #a5d6a7", borderRadius:8, padding:10, fontSize:12, color:"#2e7d32", fontWeight:500 }}>
                  Placing: <strong>{cursor.name}</strong><br/>
                  <span style={{ fontWeight:400, color:"#666" }}>Click any empty cell in the grid</span>
                </div>
              )}
            </div>

            {/* Garden bed */}
            <div style={{ flex:1 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                <div>
                  <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:22, fontWeight:600, color:"#1C3A2B" }}>Garden Bed  <span style={{ fontSize:14, fontWeight:400, color:"#999" }}>8 × 6 plots</span></div>
                  <div style={{ fontSize:12, color:"#888", marginTop:1 }}>{grid.filter(Boolean).length} plants placed · Click occupied cell to remove</div>
                </div>
                <button onClick={()=>setGrid(Array(48).fill(null))}
                  style={{ background:"none", border:"1.5px solid #ccc", borderRadius:7, padding:"5px 14px", fontSize:12, cursor:"pointer", color:"#666" }}>Clear All</button>
              </div>

              {/* Grid */}
              <div style={{ background:"#DDD1B8", borderRadius:16, padding:16, boxShadow:"inset 0 2px 8px rgba(0,0,0,.12)" }}>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(8,1fr)", gap:5 }}>
                  {grid.map((plant, i) => {
                    const compat = cellCompat(i);
                    const bg = compat==="good"?"#e8f5e9": compat==="bad"?"#ffebee":"rgba(255,255,255,.4)";
                    return (
                      <div key={i} className={`gcell ${compat||""}`}
                        style={{ height:72, background:bg }}
                        onClick={() => plant ? clearCell(i) : placeInCell(i)}
                        title={plant ? `${plant.name} — click to remove` : cursor ? `Place ${cursor.name}` : "Select a plant from palette"}>
                        {plant ? (
                          <div style={{ textAlign:"center", padding:3, width:"100%" }}>
                            <div style={{ fontSize:22, lineHeight:1 }}>{plant.emoji}</div>
                            <div style={{ fontSize:8, color:"#444", lineHeight:1.1, marginTop:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", padding:"0 2px" }}>{plant.name}</div>
                            {compat==="good" && <div style={{ position:"absolute", top:2, right:2, fontSize:7 }}>✅</div>}
                            {compat==="bad"  && <div style={{ position:"absolute", top:2, right:2, fontSize:7 }}>⚠️</div>}
                          </div>
                        ) : (
                          <span style={{ fontSize:20, opacity:.2, userSelect:"none" }}>+</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Compatibility summary */}
              {grid.filter(Boolean).length > 1 && (
                <div style={{ marginTop:14, background:"white", borderRadius:10, padding:14, boxShadow:"0 1px 6px rgba(0,0,0,.06)" }}>
                  <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:18, fontWeight:600, color:"#1C3A2B", marginBottom:8 }}>Bed Analysis</div>
                  <div style={{ display:"flex", gap:16, flexWrap:"wrap" }}>
                    {grid.filter(Boolean).map((plant,i)=>{
                      const idx = grid.indexOf(plant);
                      const c = cellCompat(idx);
                      if (c==="neutral" || !c) return null;
                      const adjNames = adjCells(idx).map(j=>grid[j]?.name).filter(Boolean);
                      return (
                        <div key={`${plant.id}-${i}`} style={{ fontSize:12, color: c==="good"?"#2e7d32":"#c62828" }}>
                          {c==="good"?"✅":"⚠️"} <strong>{plant.name}</strong> near {adjNames.join(", ")}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
