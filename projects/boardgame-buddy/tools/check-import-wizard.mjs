#!/usr/bin/env node
// check-import-wizard.mjs — assert the two import drafts answer one interface.
//
//     node projects/boardgame-buddy/tools/check-import-wizard.mjs
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads the real domain modules
// into a VM context and checks the things the unified importer rests on and
// that are invisible when they break.
//
// The note importer and the photo importer stayed two models on purpose: one
// is a parse → global name-map → run-collapse machine and the other is an
// EXIF → per-file upload machine, and merging them would be a thousand lines
// of `if (source === …)`. What makes one review screen render both is that
// they answer the SAME interface. Assertion 1 is the whole justification for
// that choice, and it is one loop.
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
  };
  const sandbox = {
    window: win, console, Date, Number, Math, Map, Set, Promise, JSON, String,
    Array, Object, Boolean, URL,
  };
  sandbox.localStorage = win.localStorage;
  vm.createContext(sandbox);
  for (const f of ["domain/play-import.js", "domain/photo-import.js"]) {
    vm.runInContext(fs.readFileSync(`${W}${f}`, "utf8"), sandbox, { filename: f });
  }
  return win;
}

const win = load();
const { PlayImport, PhotoImport } = win;

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

// ── 1. Interface conformance ─────────────────────────────────────────────────
// The entire argument for keeping two models behind an adapter rather than
// merging them. If this fails, the shared review step cannot be shared.

console.log("\n1. Both drafts answer the ImportSource interface");
{
  const METHODS = [
    "importable", "seatless", "seats", "toPayload", "run",
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
  for (const [label, draft] of [["notes", noteDraft()], ["photos", photoDraft()]]) {
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
}

console.log(fails ? `\n${fails} FAILED\n` : "\nAll checks passed\n");
process.exit(fails ? 1 : 0);
