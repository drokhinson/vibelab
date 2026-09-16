// domain/import-draft.js — which source an import is coming from.
//
// The wizard holds one draft at a time and each source keeps its own model
// (domain/play-import.js, domain/photo-import.js) with its own localStorage key
// at its own version. This is the small envelope over the top: it records which
// of them is live, so a refresh mid-wizard resumes on the right branch instead
// of at the source picker.
//
// Three keys rather than one blob, deliberately. Both models' save()/restore()
// pairs are already correct about the things that are easy to get wrong — the
// note's photos are never saved, the camera roll's Files are never saved,
// `progress` is never restored, a full quota costs the resume and not the
// import — and folding them into one envelope would mean rewriting both.
//
// The cost is that clearDraft() has to sweep all three. It does; a finished
// import that left one key behind would be resurrectable from it on the next
// open.
//
/**
 * @typedef {Object} ImportSource
 *   The interface both draft models answer, which is what lets
 *   widgets/import-review-step.js render either without knowing which it has.
 *   tools/check-import-wizard.mjs asserts every name below exists on both.
 *
 * @property {"notes"|"photos"} sourceKey
 * @property {boolean} supportsBulkDate
 * @property {number} step
 * @property {string} stepName
 * @property {boolean} isDirty
 * @property {any} progress
 *
 * @property {() => Array<{key: string, name: string, game: any, rows: any[]}>} reviewGroups
 * @property {() => string[]} reviewWarnings
 * @property {() => Array<{count: number, text: string}>} reviewNotices
 * @property {() => {label: string, value: any, note: string|null}} summaryTile
 * @property {() => string|null} ctaNote
 * @property {(p: any, busy: boolean) => string} progressHeading
 * @property {(p: any) => string|null} progressNote
 *
 * @property {(id: string, game: any) => boolean} setRowGame
 * @property {(id: string, iso: string) => boolean} setRowDate
 * @property {(id: string, n: number) => any} setRowCount
 * @property {(id: string) => boolean} dropRow
 * @property {(id: string, picks: any[]) => boolean} addSeats
 * @property {(id: string, who: string) => any} removeSeat
 * @property {(id: string, who: string) => any} toggleWinner
 * @property {(id: string, who: string, value: any) => boolean} setScore
 *
 * @property {() => any[]} importable
 * @property {() => any[]} seatless
 * @property {(item: any) => any[]} seats
 * @property {(onProgress?: Function) => Promise<void>} run
 * @property {() => void} save
 * @property {() => boolean} restore
 * @property {() => void} clearDraft
 */

(function () {
  const KEY = "bgb.import.draft";
  const VERSION = 1;

  // Probed in this order when the envelope is absent — a user who was mid-
  // wizard when this shipped. Photos first: that draft costs more to rebuild,
  // because its files are gone and its assignments are not.
  const LEGACY = [
    ["photos", "bgb.photoImport.draft"],
    ["notes", "bgb.playImport.draft"],
  ];

  const MODELS = {
    notes: () => new window.PlayImport(),
    photos: () => new window.PhotoImport(),
  };

  function read(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  const ImportDraft = {
    SOURCES: ["notes", "photos"],

    /** @param {"notes"|"photos"} source */
    create(source) {
      const make = MODELS[source];
      return make ? make() : null;
    },

    /** Remember which source is live, so a refresh resumes on its branch. */
    remember(source) {
      try {
        localStorage.setItem(KEY, JSON.stringify({ v: VERSION, source }));
      } catch (_) {
        // A blocked quota costs the resume, not the import — the same trade
        // both models make.
      }
    },

    /**
     * The draft a refresh should resume, or null.
     *
     * Returns a model that has already restored itself, so the caller can
     * paint the step it was left on.
     * @returns {{source: string, model: any}|null}
     */
    restore() {
      let saved = null;
      try { saved = JSON.parse(read(KEY) || "null"); } catch (_) { saved = null; }
      if (saved && saved.v === VERSION && MODELS[saved.source]) {
        const model = this.create(saved.source);
        if (model && model.restore()) return { source: saved.source, model };
      }
      // No envelope: either nothing to resume, or a draft written before the
      // wizard existed. Adopt the latter once and write the envelope, so the
      // probe is a one-time cost rather than something every open pays.
      for (const [source, key] of LEGACY) {
        if (!read(key)) continue;
        const model = this.create(source);
        if (model && model.restore()) {
          this.remember(source);
          return { source, model };
        }
      }
      return null;
    },

    /** Drop the envelope AND both models' keys. */
    clear() {
      try { localStorage.removeItem(KEY); } catch (_) {}
      for (const [, key] of LEGACY) {
        try { localStorage.removeItem(key); } catch (_) {}
      }
    },
  };

  window.ImportDraft = ImportDraft;
})();
