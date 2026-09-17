#!/usr/bin/env node
// check-import-wizard.mjs — assert every import draft answers one interface.
//
//     node projects/boardgame-buddy/tools/check-import-wizard.mjs
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads the real domain modules
// into a VM context and checks the things the unified importer rests on and
// that are invisible when they break.
//
// The three importers stayed three models on purpose: a parse → global
// name-map → run-collapse machine, an EXIF → per-file upload machine, and a
// sign-in → sweep → handle-map machine. Merging them would be a thousand lines
// of `if (source === …)`. What makes one review screen render all of them is
// that they answer the SAME interface. Assertion 1 is the whole justification
// for that choice, and it is one loop.
//
// The rest guard the per-play seat override, which is the genuinely new and
// genuinely dangerous piece: seats in the note importer are DERIVED through a
// global name mapping, so editing one play's table must not edit every play
// that name appears in — and must not change what a play already sends.
import fs from "node:fs";
import vm from "node:vm";

const W = new URL("../web/", import.meta.url).pathname;

let fails = 0;
const ok = (name, cond) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}`); }
};

// ── The sandbox ──────────────────────────────────────────────────────────────
// Only what the two models actually touch. `api` is never called here: nothing
// below runs an import, deliberately — run() owns the idempotency keys and the
// chunking, and this file is about the review layer above it.
function load() {
  const store = new Map();
  const win = {
    crypto: { randomUUID: () => `uuid-${store.size}-${Math.random().toString(16).slice(2)}` },
    store: { get: () => null, set: () => {} },
    localStorage: {
      _v: new Map(),
      getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
      setItem(k, v) { this._v.set(k, String(v)); },
      removeItem(k) { this._v.delete(k); },
    },
    ImportPeople: { viewerRow: () => null, candidates: () => [] },
    BgbNameMatch: { best: () => null },
  };
  // Same globals as loadUi()'s sandbox, deliberately: the two used to differ,
  // and a model touching RegExp at module scope would then throw in one and
  // not the other — a gate that disagrees with itself about what "loads" means.
  const sandbox = {
    window: win, console, Date, Number, Math, Map, Set, Promise, JSON, String,
    Array, Object, Boolean, URL, RegExp, Error, Intl, parseInt, parseFloat, isNaN,
  };
  sandbox.localStorage = win.localStorage;
  vm.createContext(sandbox);
  for (const f of [
    "domain/import-seats.js", "domain/play-import.js", "domain/photo-import.js",
    "domain/bga-import.js", "domain/bgg-play-import.js",
  ]) {
    vm.runInContext(fs.readFileSync(`${W}${f}`, "utf8"), sandbox, { filename: f });
  }
  return win;
}

/**
 * The same, plus the UI layer: the step modules, the shared review, the source
 * picker and both branches. Enough fake DOM for a render pass to build strings
 * — nothing here mounts anything.
 */
function loadUi() {
  const win = {
    store: { get: () => ({ id: "u-me", display_name: "Me" }), set() {} },
    crypto: { randomUUID: () => `id-${Math.random().toString(16).slice(2)}` },
    localStorage: {
      _v: new Map(),
      getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
      setItem(k, v) { this._v.set(k, String(v)); },
      removeItem(k) { this._v.delete(k); },
    },
    Geo: { countryName: (c) => c },
    BgbBadge: { render: (o) => `<b>${o.displayName}</b>` },
    Buddy: { toPlayerCandidates: () => [] },
    ImportPeople: {
      SUGGEST_MAX: 5,
      viewerRow: () => ({ user_id: "u-me", name: "Me", username: "me" }),
      candidates: () => [],
      async loadPartners() { return { accounts: [], ghosts: [], recent: [] }; },
    },
    BgbNameMatch: { best: () => null },
    Bgg: { status: async () => ({ auth_state: "linked" }) },
    BggImport: { start: async () => null, catalogChanged() {} },
  };
  win.window = win;
  const sandbox = {
    window: win, console, Date, Number, Math, Map, Set, Promise, JSON, String,
    Array, Object, Boolean, RegExp, Error, Intl, parseInt, parseFloat, isNaN,
    localStorage: win.localStorage,
    document: { activeElement: null },
    showToast() {},
  };
  vm.createContext(sandbox);
  const run = (f) => vm.runInContext(
    fs.readFileSync(`${W}${f}`, "utf8"), sandbox, { filename: f });
  // helpers.js first: escapeHtml/escapeAttr/jsStr/formatDate are globals the
  // step bodies build every string with.
  run("helpers.js");
  for (const f of [
    "domain/import-people.js", "domain/import-seats.js",
    "domain/play-import.js", "domain/photo-import.js",
    "domain/bga.js", "domain/bga-import.js",
    "domain/bgg-play-import.js",
    "domain/import-draft.js", "widgets/import-review-step.js",
    "widgets/import-source-step.js", "widgets/import-notes-steps.js",
    "widgets/import-photos-steps.js", "widgets/import-bga-steps.js",
    "widgets/import-bgg-steps.js",
    "widgets/import-notes-branch.js", "widgets/import-photos-branch.js",
    "widgets/import-bga-branch.js", "widgets/import-bgg-branch.js",
  ]) run(f);
  return win;
}

const win = load();
const { PlayImport, PhotoImport, BgaImport, BggPlayImport } = win;

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A note draft: two games, one of them a run of three identical plays. */
function noteDraft() {
  const d = new PlayImport();
  d.plays = [
    // A run of three, all the same.
    ...[0, 1, 2].map((i) => ({
      id: `p-run-${i}`, gameName: "Catan", gameId: null, playedAt: "2026-01-04",
      notes: null, runId: "run-1", dropped: false, seatsOverride: null,
      players: [
        { name: "Jas", isWinner: true, score: 10 },
        { name: "Sean", isWinner: false, score: 8 },
      ],
    })),
    // A one-off of another game.
    {
      id: "p-solo", gameName: "Wingspan", gameId: null, playedAt: "2026-01-05",
      notes: null, runId: null, dropped: false, seatsOverride: null,
      players: [
        { name: "Jasmine", isWinner: false, score: 71 },
        { name: "Sean", isWinner: true, score: 80 },
      ],
    },
  ];
  d.playerNames = ["Jas", "Sean", "Jasmine"];
  // "Jas" and "Jasmine" are ONE account — the thing the Players step exists to
  // say, and the thing the review row has to honour.
  d.playerMap = {
    jas: { kind: "buddy", userId: "u-jas", label: "Jasmine" },
    jasmine: { kind: "buddy", userId: "u-jas", label: "Jasmine" },
    sean: { kind: "ghost", userId: null, label: "Sean" },
  };
  d.gameMap = {
    catan: { id: "g-catan", name: "Catan", thumbnail_url: null },
    wingspan: { id: "g-wing", name: "Wingspan", thumbnail_url: null },
  };
  return d;
}

/** A photo draft: two shots of one game, one of another. */
function photoDraft() {
  const d = new PhotoImport();
  d.shots = [
    {
      id: "s-1", label: "a.jpg", file: null, url: "blob:a", playedAt: "2026-02-01",
      dateSource: "exif", countryCode: "PT", countrySource: "photo",
      game: { id: "g-catan", name: "Catan" }, notes: null, photoUrl: null,
      players: [
        { name: "Me", userId: "u-me", isWinner: true, score: null },
        { name: "Sean", userId: null, isWinner: false, score: null },
      ],
    },
    {
      id: "s-2", label: "b.jpg", file: null, url: "blob:b", playedAt: "2026-02-01",
      dateSource: "exif", countryCode: "PT", countrySource: "photo",
      game: { id: "g-catan", name: "Catan" }, notes: null, photoUrl: null,
      players: [{ name: "Me", userId: "u-me", isWinner: true, score: null }],
    },
    {
      id: "s-3", label: "c.jpg", file: null, url: null, playedAt: "2026-02-02",
      dateSource: "file", countryCode: null, countrySource: null,
      game: null, notes: null, photoUrl: null,
      players: [{ name: "Me", userId: "u-me", isWinner: false, score: null }],
    },
  ];
  return d;
}

/**
 * A Board Game Arena draft: two tables of one game with the same two people,
 * one of another game. The repeated pair is what run-collapse and feed
 * grouping bite on; the two handles are one person, which is what the seat
 * collapse has to honour or migration 023's unique index refuses the play.
 *
 * `Ctor` so a caller with its own VM context can build one there — §8 saves
 * and restores through a fresh sandbox's localStorage, and a draft built from
 * the module-level class would write into the wrong one and silently restore
 * nothing.
 */
function bgaDraft(Ctor = BgaImport) {
  const d = new Ctor();
  d.link = { username: "me_bga", playerId: "77", authState: "linked", lastImportAt: null };
  d.tables = [
    ...[0, 1].map((i) => ({
      id: `t-${i}`, bgaTableId: 5550 + i, gameName: "Azul", gameId: null,
      playedAt: "2026-03-01", seatsOverride: null, dropped: false,
      seats: [
        { handle: "Tiggy_42", isWinner: true, score: 88, rank: 1 },
        { handle: "tiggy", isWinner: false, score: 71, rank: 2 },
      ],
    })),
    {
      id: "t-solo", bgaTableId: 5599, gameName: "Hanabi", gameId: null,
      playedAt: "2026-03-02", seatsOverride: null, dropped: false,
      seats: [{ handle: "Tiggy_42", isWinner: true, score: 25, rank: 1 }],
    },
  ];
  d.handles = ["Tiggy_42", "tiggy"];
  // Two BGA accounts, one person — the BGA analogue of "Jas" and "Jasmine".
  d.handleMap = {
    tiggy_42: { kind: "buddy", userId: "u-tig", label: "Tiggy" },
    tiggy: { kind: "buddy", userId: "u-tig", label: "Tiggy" },
  };
  d.matchReasons = { tiggy_42: "remembered", tiggy: "fuzzy" };
  d.gameMap = {
    azul: { id: "g-azul", name: "Azul", thumbnail_url: null },
    hanabi: { id: "g-hana", name: "Hanabi", thumbnail_url: null },
  };
  d.gameRefs = [
    { name: "Azul", candidates: [], confident: true },
    { name: "Hanabi", candidates: [], confident: true },
  ];
  d.skipped = 12;
  return d;
}

/**
 * A BoardGameGeek draft: two games, one of them a pair of identical plays, and
 * one game the catalog has never seen.
 *
 * Built through adopt() rather than by hand, so the fixture exercises the one
 * translation step this source has — and so a change to the response shape
 * shows up here rather than in production.
 */
function bggDraft() {
  const d = new BggPlayImport();
  d.adopt({
    bgg_username: "me",
    total_new: 4,
    truncated: false,
    fetched_at: "2026-09-17T10:00:00Z",
    players: ["Jas", "Sean", "Jasmine"],
    plays: [
      // Two identical plays of one game — the pair the review collapses.
      ...[101, 102].map((id) => ({
        bgg_play_id: id, bgg_id: 13, bgg_game_name: "Catan",
        played_at: "2026-01-04", notes: null, quantity: 1,
        game: { id: "g-catan", name: "Catan", thumbnail_url: null },
        players: [
          { name: "Jas", username: null, is_winner: true },
          { name: "Sean", username: null, is_winner: false },
        ],
      })),
      // A one-off of another game, with a quantity BGG stands several plays on.
      {
        bgg_play_id: 103, bgg_id: 266192, bgg_game_name: "Wingspan",
        played_at: "2026-01-05", notes: "close one", quantity: 3,
        game: { id: "g-wing", name: "Wingspan", thumbnail_url: null },
        players: [
          { name: "Jasmine", username: null, is_winner: false },
          { name: "Sean", username: null, is_winner: true },
        ],
      },
      // A game BgB has never heard of — the Games step's row.
      {
        bgg_play_id: 104, bgg_id: 999999, bgg_game_name: "Obscure Thing",
        played_at: "2026-01-06", notes: null, quantity: 1,
        game: null,
        players: [{ name: "Sean", username: null, is_winner: true }],
      },
    ],
  });
  // "Jas" and "Jasmine" are ONE account — the thing the Players step exists to
  // say, and the thing the review row has to honour.
  d.playerMap = {
    jas: { kind: "buddy", userId: "u-jas", label: "Jasmine" },
    jasmine: { kind: "buddy", userId: "u-jas", label: "Jasmine" },
    sean: { kind: "ghost", userId: null, label: "Sean" },
  };
  return d;
}

// ── 1. Interface conformance ─────────────────────────────────────────────────
// The entire argument for keeping two models behind an adapter rather than
// merging them. If this fails, the shared review step cannot be shared.

console.log("\n1. Every draft answers the ImportSource interface");
{
  const METHODS = [
    "importable", "seatless", "seats", "gameOf", "toPayload", "run",
    "save", "restore", "clearDraft",
    "reviewGroups", "reviewWarnings", "reviewNotices",
    "summaryTile", "ctaNote", "progressHeading", "progressNote",
    "setRowGame", "setRowDate", "setRowCount", "dropRow",
    "addSeats", "removeSeat", "toggleWinner", "setScore",
  ];
  const GETTERS = ["sourceKey", "supportsBulkDate", "isDirty", "stepName"];
  const STATICS = ["steps", "today"];

  for (const [label, Ctor, draft] of [
    ["PlayImport", PlayImport, noteDraft()],
    ["PhotoImport", PhotoImport, photoDraft()],
    ["BgaImport", BgaImport, bgaDraft()],
    ["BggPlayImport", BggPlayImport, bggDraft()],
  ]) {
    const missing = METHODS.filter((m) => typeof draft[m] !== "function");
    ok(`${label} implements every method`, missing.length === 0);
    if (missing.length) console.log(`       missing: ${missing.join(", ")}`);

    const badGetters = GETTERS.filter((g) => draft[g] === undefined);
    ok(`${label} exposes every getter`, badGetters.length === 0);
    if (badGetters.length) console.log(`       missing: ${badGetters.join(", ")}`);

    const badStatics = STATICS.filter((g) => Ctor[g] === undefined);
    ok(`${label} exposes every static`, badStatics.length === 0);
    ok(`${label}.whoOf is a function`, typeof Ctor.whoOf === "function");
  }

  // The review row shape is the contract the shared step renders. Both must
  // produce every key, or the step reads undefined on one source only.
  const ROW_KEYS = ["id", "count", "countEditable", "game", "playedAt", "notes",
    "thumbUrl", "countryCode", "seats", "edited", "runNote"];
  for (const [label, draft] of [
    ["notes", noteDraft()], ["photos", photoDraft()], ["bga", bgaDraft()],
    ["bgg", bggDraft()],
  ]) {
    const groups = draft.reviewGroups();
    const row = groups[0] && groups[0].rows[0];
    ok(`${label} reviewGroups() yields rows`, !!row);
    const missing = row ? ROW_KEYS.filter((k) => !(k in row)) : ROW_KEYS;
    ok(`${label} review rows carry every key`, missing.length === 0);
    if (missing.length) console.log(`       missing: ${missing.join(", ")}`);
    const tile = draft.summaryTile();
    ok(`${label} summaryTile has label+value`,
      !!tile && typeof tile.label === "string" && tile.value !== undefined);
  }
}

// ── 2. Materialising an override is a no-op ──────────────────────────────────
// The override seeds itself from what the mapping already says, so the first
// edit must not itself change the play. If this drifts, merely OPENING a row
// and touching one control rewrites the other seats.

console.log("\n2. Materialising a seat override changes nothing");
{
  const before = noteDraft();
  const after = noteDraft();
  const play = after.plays[0];

  const payloadBefore = JSON.stringify(before.toPayload(before.plays[0], new Map(), "b"));
  after._materialise(play);
  const payloadAfter = JSON.stringify(after.toPayload(play, new Map(), "b"));

  ok("payload is byte-identical after materialising", payloadBefore === payloadAfter);
  ok("the override was actually set", Array.isArray(play.seatsOverride));
  ok("row key is unchanged",
    before.rowKeyFor(before.plays[0]) === after.rowKeyFor(play));
}

// ── 3. A per-play edit is local ──────────────────────────────────────────────
// The bug this guards: seats are derived through ONE global mapping, so the
// obvious implementation — edit the map — takes Sean off every play in the
// note rather than off the one the user was looking at.

console.log("\n3. Editing one row's seats leaves every other row alone");
{
  const d = noteDraft();
  const seanOnSolo = d.seats(d.plays[3]).map((s) => s.name).sort();
  d.removeSeat("p-run-0", "g:sean");

  ok("the edited row lost Sean",
    d.seats(d.plays[0]).every((s) => s.name !== "Sean"));
  ok("the untouched row still seats Sean",
    JSON.stringify(d.seats(d.plays[3]).map((s) => s.name).sort()) === JSON.stringify(seanOnSolo));
  ok("the global mapping is untouched", d.playerMapping("Sean").label === "Sean");
  ok("play.players is untouched (it is the note as parsed)",
    d.plays[0].players.some((p) => p.name === "Sean"));
}

// ── 4. Run collapsing survives an edit ───────────────────────────────────────

console.log("\n4. A row of N edits as a row of N, and equal rows merge");
{
  const d = noteDraft();
  const rowsBefore = d.rows(d.groups()[0].plays);
  ok("the run starts as one row of 3",
    rowsBefore.length === 1 && rowsBefore[0].plays.length === 3);

  const keyBefore = rowsBefore[0].key;
  d.toggleWinner("p-run-0", "g:sean");
  const rowsAfter = d.rows(d.groups()[0].plays);
  ok("still one row of 3 after the edit",
    rowsAfter.length === 1 && rowsAfter[0].plays.length === 3);
  ok("the row key moved", rowsAfter[0].key !== keyBefore);

  // Two rows edited into agreement become one row of N+M. Correct — they are
  // now indistinguishable — and the caller has to re-resolve its open anchor.
  const m = noteDraft();
  m.plays[3].gameName = "Catan";
  m.plays[3].gameId = "g-catan";
  m.plays[3].playedAt = "2026-01-04";
  const split = m.rows(m.groups()[0].plays);
  ok("they start as two rows", split.length === 2);
  // Give the solo play the run's exact table.
  m._materialise(m.plays[3]);
  m.plays[3].seatsOverride = m.seats(m.plays[0]).map((s) => ({ ...s }));
  const merged = m.rows(m.groups()[0].plays);
  ok("identical tables merge into one row of 4",
    merged.length === 1 && merged[0].plays.length === 4);
}

// ── 5. Payload asymmetries survive ───────────────────────────────────────────
// The two sources deliberately write different columns. An edit must not blur
// that: a note still groups runs for the feed and sends no photo or country;
// a photo still sends both and is never one of the indistinguishable repeats
// import_group_id exists to collapse.

console.log("\n5. Each source still writes its own columns after an edit");
{
  const d = noteDraft();
  d.setScore("p-solo", "u:u-jas", "99");
  const groups = d.assignGroups(d.importable());
  const runPayload = d.toPayload(d.plays[0], groups, "batch-1");
  const soloPayload = d.toPayload(d.plays[3], groups, "batch-1");

  ok("a run still gets an import_group_id", !!runPayload.import_group_id);
  ok("a one-off still gets none", soloPayload.import_group_id === null);
  ok("both carry the batch id",
    runPayload.import_batch_id === "batch-1" && soloPayload.import_batch_id === "batch-1");
  ok("a note sends no photo_url", !("photo_url" in runPayload));
  ok("a note sends no country_code", !("country_code" in runPayload));
  ok("the edited score reached the payload",
    soloPayload.players.some((p) => p.score === 99));

  const ph = photoDraft();
  ph.setScore("s-1", "u:u-me", "42");
  const shotPayload = ph.toPayload(ph.shots[0], "batch-2");
  ok("a photo sends country_code", shotPayload.country_code === "PT");
  ok("a photo sends photo_url", "photo_url" in shotPayload);
  ok("a photo never groups", !("import_group_id" in shotPayload));
  ok("the edited score reached the payload",
    shotPayload.players.some((p) => p.score === 42));

  // BGA's own column, and the two it must NOT invent. bga_table_id is the key
  // the server dedupes a re-import on, so a payload that drops it turns every
  // second import into a pile of duplicate plays.
  const b = bgaDraft();
  b.setScore("t-solo", "u:u-tig", "31");
  const bGroups = b.assignGroups(b.importable());
  const pairPayload = b.toPayload(b.tables[0], bGroups, "batch-3");
  const bSoloPayload = b.toPayload(b.tables[2], bGroups, "batch-3");

  ok("a BGA play carries its table id", pairPayload.bga_table_id === 5550);
  ok("each table carries its OWN id", bSoloPayload.bga_table_id === 5599);
  ok("a BGA play still carries a client_key", !!pairPayload.client_key);
  ok("two identical BGA tables group together", !!pairPayload.import_group_id);
  ok("a lone BGA table gets no group", bSoloPayload.import_group_id === null);
  ok("BGA carries the batch id", pairPayload.import_batch_id === "batch-3");
  ok("BGA sends no photo_url", !("photo_url" in pairPayload));
  ok("BGA sends no country_code", !("country_code" in pairPayload));
  ok("the edited score reached the BGA payload",
    bSoloPayload.players.some((p) => p.score === 31));

  // The seat collapse, which is what stops two handles for one person becoming
  // two seats for one account — a play migration 023 refuses outright.
  ok("two handles for one person collapse to one seat",
    pairPayload.players.length === 1 && pairPayload.players[0].user_id === "u-tig");
  ok("the collapse keeps the win", pairPayload.players[0].is_winner === true);

  // The BoardGameGeek source's own asymmetry, and the one that matters most:
  // its second idempotency key. Without bgg_play_id on the payload, migration
  // 044's pre-check cannot see the plays the retired sync wrote and the
  // wizard re-imports every one of them.
  const g = bggDraft();
  const gGroups = g.assignGroups(g.importable());
  const bggPair = g.toPayload(g.plays[0], gGroups, "batch-3");
  const bggSolo = g.toPayload(g.plays[2], gGroups, "batch-3");

  ok("a BGG play carries its bgg_play_id", bggPair.bgg_play_id === 101);
  ok("a BGG play still carries a client_key too",
    typeof bggPair.client_key === "string" && bggPair.client_key.length > 0);
  ok("two BGG plays carry DIFFERENT bgg_play_ids even in one row",
    g.toPayload(g.plays[1], gGroups, "batch-3").bgg_play_id === 102);
  ok("indistinguishable BGG plays still share a group id",
    !!bggPair.import_group_id
      && bggPair.import_group_id === g.toPayload(g.plays[1], gGroups, "b").import_group_id);
  ok("a lone BGG play gets no group id", bggSolo.import_group_id === null);
  ok("a BGG play carries the batch id", bggPair.import_batch_id === "batch-3");
  ok("a BGG play sends no photo_url", !("photo_url" in bggPair));
  ok("a BGG play sends no country_code", !("country_code" in bggPair));

  // And the new column must not leak into the two sources that have no
  // BoardGameGeek identity to send.
  ok("a note sends no bgg_play_id", !("bgg_play_id" in runPayload));
  ok("a photo sends no bgg_play_id", !("bgg_play_id" in shotPayload));
}

// ── 5b. Quantity is echoed, never expanded ───────────────────────────────────
// BGG lets one <play> stand for N sittings. Expanding it would mint N rows
// sharing one bgg_play_id, and the partial UNIQUE would reject all but the
// first — so the import would land one play and report N.

console.log("\n5b. A BGG quantity never becomes more than one play");
{
  const b = bggDraft();
  const three = b.plays.find((p) => p.quantity === 3);
  ok("the fixture holds a quantity of 3", !!three);
  ok("it is still one draft play",
    b.plays.filter((p) => p.bggPlayId === three.bggPlayId).length === 1);
  ok("every bgg_play_id is unique across the draft",
    new Set(b.plays.map((p) => p.bggPlayId)).size === b.plays.length);
  ok("the review says so rather than hiding it",
    b.reviewWarnings().some((w) => /several sittings/.test(w)));
  ok("resizing a BGG row is refused", b.setRowCount(b.plays[0].id, 5) === false);
}

// ── 6. Scores ────────────────────────────────────────────────────────────────

console.log("\n6. Scores are carried, cleared, and part of row identity");
{
  const ph = photoDraft();
  ok("an untouched photo seat scores null", ph.seats(ph.shots[0])[0].score === null);
  ph.setScore("s-1", "u:u-me", "12");
  ok("a set score is carried", ph.seats(ph.shots[0])[0].score === 12);
  ph.setScore("s-1", "u:u-me", "");
  ok("a blank clears back to null (not 0)", ph.seats(ph.shots[0])[0].score === null);
  ph.setScore("s-1", "u:u-me", "0");
  ok("an explicit zero is kept", ph.seats(ph.shots[0])[0].score === 0);

  // Unequal scores split a collapsed row; equal ones keep it whole. Correct,
  // and surprising enough that the review row says so.
  const d = noteDraft();
  ok("the run is one row", d.rows(d.groups()[0].plays).length === 1);
  d._materialise(d.plays[0]);
  d.plays[0].seatsOverride = d.plays[0].seatsOverride.map(
    (s) => (s.user_id === "u-jas" ? { ...s, score: 999 } : s));
  ok("one play scoring differently splits the row",
    d.rows(d.groups()[0].plays).length === 2);
}

// ── 7. Seat keys address a seat, not a spelling ──────────────────────────────
// An account and a ghost can legitimately carry one display name — which is
// exactly what the seats() collapse exists to keep apart — so a name-keyed
// handler hits both.

console.log("\n7. Seats are addressed by identity, not by display name");
{
  ok("PlayImport.whoOf separates an account from a same-named ghost",
    PlayImport.whoOf({ name: "Sean", user_id: "u-1" })
      !== PlayImport.whoOf({ name: "Sean", user_id: null }));
  ok("PhotoImport.whoOf agrees on the key shape",
    PhotoImport.whoOf({ name: "Sean", userId: "u-1" })
      === PlayImport.whoOf({ name: "Sean", user_id: "u-1" }));
  ok("PhotoImport.whoOf is case-insensitive on a ghost",
    PhotoImport.whoOf({ name: "SEAN", userId: null })
      === PhotoImport.whoOf({ name: "sean", userId: null }));
  // THREE models now, and this is what makes pointing the other two at
  // domain/import-seats.js a safe change later: a handler in the shared review
  // passes a key minted by one model to a method on another's draft, so two
  // key shapes would silently address nobody.
  ok("BggPlayImport.whoOf agrees with PlayImport's",
    BggPlayImport.whoOf({ name: "Sean", user_id: "u-1" })
      === PlayImport.whoOf({ name: "Sean", user_id: "u-1" })
    && BggPlayImport.whoOf({ name: "Sean", user_id: null })
      === PlayImport.whoOf({ name: "Sean", user_id: null }));
  ok("BgaImport.whoOf agrees on the key shape",
    BgaImport.whoOf({ name: "Sean", user_id: "u-1" })
      === PlayImport.whoOf({ name: "Sean", user_id: "u-1" }));
  ok("BgaImport.whoOf agrees on a ghost key",
    BgaImport.whoOf({ name: "SEAN", user_id: null })
      === PlayImport.whoOf({ name: "sean", user_id: null }));

  const ph = photoDraft();
  ph.shots[0].players.push({ name: "Sean", userId: "u-other", isWinner: false, score: null });
  ph.removeSeat("s-1", "g:sean");
  const left = ph.shots[0].players.filter((p) => p.name === "Sean");
  ok("removing the ghost leaves the same-named account seated",
    left.length === 1 && left[0].userId === "u-other");
}

// ── 8. Draft restore normalises the additive fields ──────────────────────────
// Both changes are additive optional fields with null defaults, which is what
// lets DRAFT_VERSION stay where it is. A bump would throw away every
// in-flight import on deploy day for no benefit — but only if restore()
// actually fills the field in.

console.log("\n8. A pre-edit draft restores with the new fields defaulted");
{
  const w = load();
  w.localStorage.setItem("bgb.playImport.draft", JSON.stringify({
    v: 1, step: 4, text: "x", hint: "",
    // Exactly the shape saved before seat editing existed: no seatsOverride.
    plays: [{
      id: "p1", gameName: "Catan", gameId: null, playedAt: null, notes: null,
      runId: null, dropped: false,
      players: [{ name: "Sean", isWinner: true, score: null }],
    }],
    playerNames: ["Sean"], playerMap: {}, gameRefs: [], gameMap: {},
    warnings: [], bulkDate: null,
  }));
  const d = new w.PlayImport();
  ok("a v1 note draft still restores", d.restore() === true);
  ok("seatsOverride is normalised to null", d.plays[0].seatsOverride === null);

  w.localStorage.setItem("bgb.photoImport.draft", JSON.stringify({
    v: 1, step: 1, cursor: 0,
    shots: [{
      id: "s1", label: "a.jpg", playedAt: "2026-02-01", dateSource: "exif",
      countryCode: null, countrySource: null, game: null, notes: null, photoUrl: null,
      // Saved before scores existed.
      players: [{ name: "Me", userId: "u-me", isWinner: false }],
    }],
  }));
  const ph = new w.PhotoImport();
  ok("a v1 photo draft still restores", ph.restore() === true);
  ok("score is normalised to null", ph.shots[0].players[0].score === null);

  // The BGA draft round-trips, AND — the assertion that earns this section's
  // place — carries no password. There is no `password` field on the model to
  // begin with and save() writes an explicit field list, but "we accidentally
  // persisted the credential" is exactly the class of mistake that reads fine
  // in review, so it gets a gate rather than a comment.
  const b = bgaDraft(w.BgaImport);
  b.save();
  const saved = w.localStorage.getItem("bgb.bgaImport.draft");
  ok("a BGA draft saves", typeof saved === "string" && saved.length > 10);
  ok("a saved BGA draft holds no password", !/password|passwd|secret/i.test(saved || ""));

  const b2 = new w.BgaImport();
  ok("a BGA draft restores", b2.restore() === true);
  ok("the table id survives the round trip", b2.tables[0].bgaTableId === 5550);
  ok("seatsOverride is normalised to null", b2.tables[0].seatsOverride === null);
  ok("rank survives the round trip", b2.tables[0].seats[0].rank === 1);
  ok("the skipped count survives", b2.skipped === 12);
  ok("the linked handle survives", b2.link.username === "me_bga");

  // A table already imported is the server's answer, not the client's, but a
  // table the user dropped must never reach the payload.
  b2.dropRow("t-solo");
  ok("a dropped table leaves importable()",
    !b2.importable().some((t) => t.id === "t-solo"));
}

// ── 9. Every inline handler resolves ────────────────────────────────────────
// The one gate that catches the whole class of failure this refactor risks.
// Handlers are `onclick="window.thing._method(...)"` strings, resolved by name
// at CLICK time — so a renamed method is a silently dead button with no
// build-time error anywhere. Every name a step file writes has to exist on the
// object it names.

console.log("\n9. Every inline handler names a method that exists");
{
  const read = (f) => fs.readFileSync(`${W}${f}`, "utf8");

  // global name -> the file that defines its class
  const OWNERS = {
    "window.importNotesBranch": "widgets/import-notes-branch.js",
    "window.importPhotosBranch": "widgets/import-photos-branch.js",
    "window.importBgaBranch": "widgets/import-bga-branch.js",
    "window.importBggBranch": "widgets/import-bgg-branch.js",
    "window.importWizardView": "views/import-wizard-view.js",
    "window.importWizardView.review": "widgets/import-review-host.js",
  };
  const defined = {};
  for (const [global, file] of Object.entries(OWNERS)) {
    const src = read(file);
    const names = new Set();
    for (const m of src.matchAll(/^\s{4}(?:async |get |static )?([A-Za-z_][\w]*)\s*\(/gm)) {
      names.add(m[1]);
    }
    defined[global] = names;
  }

  // Comments are stripped first: several of these files document the handler
  // convention with an illustrative `window.importNotesBranch._foo()`, and a
  // gate that cannot tell prose from a call site is a gate nobody keeps green.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  const CALLERS = [
    "widgets/import-notes-steps.js",
    "widgets/import-photos-steps.js",
    "widgets/import-bga-steps.js",
    "widgets/import-bgg-steps.js",
    "widgets/import-source-step.js",
    "widgets/import-review-step.js",
  ];
  // The step files build handlers from a module-local `const V = "..."`, so
  // resolve that indirection before matching.
  const bad = [];
  for (const file of CALLERS) {
    const src = stripComments(read(file));
    const vMatch = src.match(/const V = "([^"]+)"/);
    const V = vMatch ? vMatch[1] : null;
    const text = V ? src.split("${V}").join(V) : src;
    for (const m of text.matchAll(/(window\.importWizardView\.review|window\.importWizardView|window\.importNotesBranch|window\.importPhotosBranch|window\.importBgaBranch|window\.importBggBranch)\.(_?[A-Za-z]\w*)\(/g)) {
      const [, global, method] = m;
      if (!defined[global] || !defined[global].has(method)) {
        bad.push(`${file}: ${global}.${method}()`);
      }
    }
    // A template that still names `V` without a definition would silently
    // build "undefined._foo()".
    if (/\$\{V\}/.test(src) && !V) bad.push(`${file}: uses \${V} with no const V`);
  }
  ok("no inline handler names a missing method", bad.length === 0);
  for (const b of bad) console.log(`       ${b}`);

  // And the shared review's host must implement everything the step calls.
  const HOST = ["_toggleRow", "_dropRow", "_onBulkDate", "_onRowDate", "_onRowCount",
    "_openRowGameSheet", "_openRowPlayerSheet", "_toggleRowWinner",
    "_removeRowSeat", "_onSeatScore"];
  const missingHost = HOST.filter((m) => !defined["window.importWizardView.review"].has(m));
  ok("the review host implements every review handler", missingHost.length === 0);
  if (missingHost.length) console.log(`       missing: ${missingHost.join(", ")}`);

  // The two retired globals must be gone everywhere.
  const stale = [];
  for (const f of [...CALLERS, ...Object.values(OWNERS), "init.js", "views/settings-view.js"]) {
    if (/window\.(importPlaysView|photoImportView)\b/.test(stripComments(read(f)))) stale.push(f);
  }
  ok("no file still names the retired view globals", stale.length === 0);
  for (const f of stale) console.log(`       ${f}`);
}

// ── 10. The step arithmetic ─────────────────────────────────────────────────

console.log("\n10. Each branch's step list is walkable end to end");
{
  for (const [label, Ctor, branchSteps] of [
    ["notes", PlayImport, ["source", "details", "players", "games"]],
    ["photos", PhotoImport, ["photos", "assign"]],
    ["bga", BgaImport, ["account", "fetch", "players", "games"]],
    ["bgg", BggPlayImport, ["plays", "players", "games"]],
  ]) {
    const steps = Ctor.steps;
    ok(`${label} steps are unique`, new Set(steps).size === steps.length);
    ok(`${label} ends review -> import`,
      steps[steps.length - 2] === "review" && steps[steps.length - 1] === "import");
    ok(`${label} branch steps lead the list`,
      JSON.stringify(steps.slice(0, branchSteps.length)) === JSON.stringify(branchSteps));
    // The progress bar is rendered with total = steps.length, so no reachable
    // index may need clamping.
    ok(`${label} every index is inside the bar`,
      steps.every((_, i) => i >= 0 && i < steps.length));
  }
}

// ── 11. Every step body renders ─────────────────────────────────────────────
// The gate that catches a helper deleted along with the function above it.
// Splitting the two step modules cut `thumb()` and `emptyStep()` out of the
// photo one — they sat below the renderers that moved — and nothing said so:
// both files parsed, both exported, and the pager threw
// "thumb is not defined" only when somebody opened it.

console.log("\n11. Every step body renders without throwing");
{
  const w = loadUi();
  const notes = new w.ImportNotesBranch();
  const photos = new w.ImportPhotosBranch();
  const bga = new w.ImportBgaBranch();
  // Enough draft to make every BGA step body have something to draw.
  const bgaSeed = bgaDraft();
  bga.draft.link = bgaSeed.link;
  bga.draft.tables = bgaSeed.tables;
  bga.draft.handles = bgaSeed.handles;
  bga.draft.handleMap = bgaSeed.handleMap;
  bga.draft.matchReasons = bgaSeed.matchReasons;
  bga.draft.gameMap = bgaSeed.gameMap;
  bga.draft.gameRefs = bgaSeed.gameRefs;
  bga.draft.skipped = bgaSeed.skipped;
  photos.draft.shots = [{
    id: "s1", label: "a.jpg", file: null, url: "blob:a", playedAt: "2026-02-01",
    dateSource: "exif", countryCode: "PT", countrySource: "photo",
    game: { id: "g1", name: "Catan" }, notes: null, photoUrl: null,
    players: [{ name: "Me", userId: "u-me", isWinner: true, score: null }],
  }];
  const bgg = new w.ImportBggBranch();
  // Built through adopt(), the same as the domain fixture above — the steps
  // read fields that translation sets (bggGameName, quantity, bggUsername).
  bgg.draft.adopt({
    bgg_username: "me",
    total_new: 2, truncated: false, fetched_at: "2026-09-17T10:00:00Z",
    players: ["Sean"],
    plays: [
      {
        bgg_play_id: 1, bgg_id: 13, bgg_game_name: "Catan",
        played_at: "2026-01-04", notes: null, quantity: 1,
        game: { id: "g1", name: "Catan", thumbnail_url: null },
        players: [{ name: "Sean", username: null, is_winner: true }],
      },
      // One unresolved game, so the Games step renders its real row rather
      // than the all-matched shape.
      {
        bgg_play_id: 2, bgg_id: 999999, bgg_game_name: "Obscure Thing",
        played_at: "2026-01-05", notes: null, quantity: 1, game: null,
        players: [{ name: "Sean", username: null, is_winner: false }],
      },
    ],
  });
  bgg.draft.playerMap = { sean: { kind: "ghost", userId: null, label: "Sean" } };
  const opts = { host: "window.importWizardView.review", expanded: {}, shownGroups: 99 };

  for (const [label, branch] of [["notes", notes], ["photos", photos], ["bga", bga], ["bgg", bgg]]) {
    for (const step of branch.steps) {
      let html = null, err = null;
      try { html = branch.renderStep(step, opts); } catch (e) { err = e.message; }
      ok(`${label}/${step} renders`, typeof html === "string" && html.length > 40);
      if (err) console.log(`       ${err}`);
    }
  }

  // The account step has TWO states and they are different screens: the
  // unlinked one carries the consent copy and the fields that gate Continue,
  // and rendering only the linked one would never exercise it.
  {
    const unlinked = new w.ImportBgaBranch();
    let html = null, err = null;
    try { html = unlinked.renderStep("account", opts); } catch (e) { err = e.message; }
    ok("bga/account renders unlinked", typeof html === "string" && html.length > 40);
    ok("the unlinked account step says the terms don't allow this",
      !!html && html.includes("terms don"));
    ok("the unlinked account step asks for a password",
      !!html && html.includes('type="password"'));
    if (err) console.log(`       ${err}`);

    // The sweep's ledger, which only paints while a fetch is in flight. Set on
    // the BRANCH rather than passed in opts: renderStep overlays its own
    // transient state over whatever it is handed, because the branch is the
    // source of truth about whether a fetch is running.
    let ledger = null;
    bga._fetching = true;
    bga._fetchProgress = { state: "running", steps: [
      { key: "history", state: "active", done: 3, total: null, detail: "3 new so far" },
    ] };
    try { ledger = bga.renderStep("fetch", opts); } catch (e) { err = e.message; }
    bga._fetching = false;
    bga._fetchProgress = null;
    ok("bga/fetch renders its ledger",
      typeof ledger === "string" && ledger.includes("imp-ledger"));
    if (err) console.log(`       ${err}`);
  }

  // The BGG plays step has four faces and only one of them is the happy path.
  // Each is a different screen rather than a flag over one, so each renders.
  for (const [name, extra] of [
    ["loading", { loading: true }],
    ["link error", { linkError: "Link your BoardGameGeek account first." }],
    ["read error", { error: "Couldn't read your plays." }],
  ]) {
    let html = null, err = null;
    try { html = bgg.renderStep("plays", Object.assign({}, opts, extra)); }
    catch (e) { err = e.message; }
    ok(`bgg/plays (${name}) renders`, typeof html === "string" && html.length > 40);
    if (err) console.log(`       ${err}`);
  }
  {
    const empty = new w.ImportBggBranch();
    let html = null, err = null;
    try { html = empty.renderStep("plays", opts); } catch (e) { err = e.message; }
    ok("bgg/plays (nothing new) renders",
      typeof html === "string" && /Nothing new/.test(html));
    if (err) console.log(`       ${err}`);
  }

  // And the three shared screens, for every source.
  for (const [label, draft] of [
    ["notes", notes.draft], ["photos", photos.draft], ["bga", bga.draft],
    ["bgg", bgg.draft],
  ]) {
    if (label === "notes") {
      draft.plays = [{
        id: "p1", gameName: "Catan", gameId: null, playedAt: "2026-01-04",
        notes: null, runId: null, dropped: false, seatsOverride: null,
        players: [{ name: "Sean", isWinner: true, score: 9 }],
      }];
      draft.gameMap = { catan: { id: "g1", name: "Catan", thumbnail_url: null } };
      draft.playerNames = ["Sean"];
      draft.playerMap = { sean: { kind: "ghost", userId: null, label: "Sean" } };
    }
    const rowId = draft.reviewGroups()[0].rows[0].id;
    for (const [name, fn] of [
      ["review", () => w.ImportReviewStep.review(draft, opts)],
      ["review (open)", () => w.ImportReviewStep.review(
        draft, { ...opts, expanded: { [rowId]: true } })],
      ["summary", () => w.ImportReviewStep.summary(draft, opts)],
    ]) {
      let html = null, err = null;
      try { html = fn(); } catch (e) { err = e.message; }
      ok(`${label} ${name} renders`, typeof html === "string" && html.length > 40);
      if (err) console.log(`       ${err}`);
    }
    draft.progress = { done: 1, total: 2, imported: 1, duplicate: 0, failed: 0,
      photosFailed: 0, errors: [] };
    let html = null, err = null;
    try { html = w.ImportReviewStep.progress(draft, true, opts); } catch (e) { err = e.message; }
    ok(`${label} progress renders`, typeof html === "string" && html.includes("progressbar"));
    if (err) console.log(`       ${err}`);
    draft.progress = null;
  }

  // \u2500\u2500 The picker's four rows, and the BGG row's four states \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  //
  // The row must never be live before the link state is known: the picker
  // paints synchronously and the answer arrives a moment later, so starting
  // enabled and disabling on arrival would take a control away from under a
  // thumb already on its way down.
  const pickerFor = (bggAuth) => w.ImportSourceStep.render({ resume: null, bggAuth });
  const rows = (html) => (html.match(/class="imp-row[ "]/g) || []).length;
  const disabled = (html) => (html.match(/disabled aria-disabled/g) || []).length;

  for (const state of [null, "linked", "unlinked", "relink_required"]) {
    ok(`the picker offers four sources (${state || "unknown"})`,
      rows(pickerFor(state)) === 4);
  }
  // This count is the only thing between enabling a source and shipping a
  // dead button, and it has to come down by one every time a source lands.
  // Board Game Arena landed, so a linked BGG account leaves nothing behind.
  ok("a linked account leaves nothing disabled",
    disabled(pickerFor("linked")) === 0);
  ok("the BGA row is live and warns before the door",
    pickerFor("linked").includes("_pickSource(&#39;bga&#39;)"));
  // The handler is escapeAttr'd, so the quotes around the source arrive as
  // entities. Matched on the escaped form rather than unescaping, so the
  // assertion fails if that escaping is ever dropped.
  const picksBgg = (html) => html.includes("_pickSource(&#39;bgg&#39;)");
  ok("a linked account makes the BGG row selectable", picksBgg(pickerFor("linked")));
  ok("an unlinked account disables the BGG row",
    disabled(pickerFor("unlinked")) === 1);
  ok("and points it at Connections",
    pickerFor("unlinked").includes("Settings \u2192 Connections"));
  ok("an expired session says reconnect",
    pickerFor("relink_required").includes("Reconnect")
      && disabled(pickerFor("relink_required")) === 1);
  ok("an unknown link state never offers the row",
    disabled(pickerFor(null)) === 1 && !picksBgg(pickerFor(null)));
  ok("nor does an unlinked or expired one",
    !picksBgg(pickerFor("unlinked")) && !picksBgg(pickerFor("relink_required")));

  // Every branch must expose _partners: ImportReviewHost._openRowPlayerSheet
  // reads this._branch._partners directly, so a branch without it fails only
  // when somebody opens a review row — the one place nothing else would catch.
  for (const [label, branch] of [["notes", notes], ["photos", photos], ["bga", bga], ["bgg", bgg]]) {
    ok(`${label} branch exposes _partners`, "_partners" in branch);
  }
}

// \u2500\u2500 12. The draft envelope knows every source \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// clear() used to sweep the LEGACY probe list, which is the two pre-wizard
// keys. A third model's key left behind by a finished import is resurrectable
// on the next open \u2014 the exact failure domain/import-draft.js's header is
// about \u2014 so the sweep list and the probe list are now separate.

console.log("\n12. The draft envelope knows every source");
{
  const w = loadUi();
  const D = w.ImportDraft;
  ok("SOURCES names all three",
    JSON.stringify(D.SOURCES) === JSON.stringify(["notes", "photos", "bga", "bgg"]));
  const noModel = D.SOURCES.filter((s) => !D.create(s));
  ok("every source builds a model", noModel.length === 0);
  if (noModel.length) console.log(`       no model: ${noModel.join(", ")}`);

  const KEYS = ["bgb.import.draft", "bgb.playImport.draft",
    "bgb.photoImport.draft", "bgb.bgaImport.draft",
    "bgb.bggPlayImport.draft"];
  for (const k of KEYS) w.localStorage.setItem(k, "{}");
  D.clear();
  const left = KEYS.filter((k) => w.localStorage.getItem(k) !== null);
  ok("clear() sweeps every model's key and the envelope", left.length === 0);
  if (left.length) console.log(`       left behind: ${left.join(", ")}`);
}

console.log(fails ? `\n${fails} FAILED\n` : "\nAll checks passed\n");
process.exit(fails ? 1 : 0);
