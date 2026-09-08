// @ts-check
// domain/exif.js — when and where a photo was taken, read out of the file.
//
// One caller: the photo importer (views/photo-import-view.js), which turns a
// camera roll into plays. The two fields it wants are the two a phone writes
// without being asked — the capture timestamp and, when location services were
// on for the camera, the coordinate. Everything else in an EXIF block is
// somebody else's problem.
//
// READ THE ORIGINAL FILE, NOT THE PREPARED ONE. helpers.js's
// preparePhotoForUpload() decodes to a canvas and re-encodes, which drops every
// EXIF tag on the floor. That is the right behaviour for an upload — a play
// photo shared with buddies should not carry the coordinates of somebody's
// living room — but it means this has to run against the File the user picked,
// before any of that happens.
//
// NO LIBRARY. exif-js and friends are 30-80 KB to parse a format whose whole
// relevant surface is two IFDs and six tags. This is ~150 lines, ships in the
// bundle, and cannot break on a CDN outage.
//
// WHAT IT UNDERSTANDS. Baseline JPEG with an APP1/Exif segment, which is what
// every phone camera and every iOS "convert on share" path produces. A PNG,
// a screenshot, a WhatsApp re-encode or a HEIC that the browser handed over
// untouched all read as "nothing found" — which is a normal answer here, not
// an error: the importer falls back to the file's own modified time and to no
// country at all, and both are correctable on screen.

(function () {
  // EXIF lives in the first APP segment of a JPEG, ahead of the image data.
  // A quarter of a megabyte covers the block plus the embedded thumbnail that
  // usually follows it, without pulling a 12 MP photo into memory to read
  // twelve bytes of it.
  const HEAD_BYTES = 256 * 1024;

  const TAG_DATETIME = 0x0132;          // IFD0, "YYYY:MM:DD HH:MM:SS"
  const TAG_EXIF_IFD = 0x8769;          // IFD0 → pointer to the Exif sub-IFD
  const TAG_GPS_IFD = 0x8825;           // IFD0 → pointer to the GPS sub-IFD
  const TAG_DATETIME_ORIGINAL = 0x9003; // Exif IFD, when the shutter fired
  const TAG_DATETIME_DIGITIZED = 0x9004;
  const GPS_LAT_REF = 0x0001;
  const GPS_LAT = 0x0002;
  const GPS_LON_REF = 0x0003;
  const GPS_LON = 0x0004;

  // Bytes per component, indexed by the TIFF type code. 0 marks a type this
  // reader has no use for (undefined, slong, srational, float, double).
  const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 0, 0, 0, 0, 8];

  /**
   * @typedef {Object} PhotoExif
   * @property {string|null} takenAt  Local date at the place of capture, "YYYY-MM-DD".
   * @property {number|null} lat
   * @property {number|null} lon
   */

  /** @param {File|Blob} file */
  function _head(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new DataView(/** @type {ArrayBuffer} */ (reader.result)));
      reader.onerror = () => reject(new Error("Couldn't read that photo."));
      reader.readAsArrayBuffer(file.slice(0, HEAD_BYTES));
    });
  }

  /**
   * Byte offset of the TIFF header inside the file, or -1.
   *
   * Walks the JPEG segment chain rather than searching for the "Exif" string:
   * those four bytes can occur inside compressed image data, and a false hit
   * would be parsed as a TIFF header pointing anywhere.
   * @param {DataView} view
   */
  function _findTiff(view) {
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return -1; // not a JPEG
    let at = 2;
    while (at + 4 <= view.byteLength) {
      if (view.getUint8(at) !== 0xff) return -1; // out of step with the chain
      const marker = view.getUint8(at + 1);
      // Standalone markers (no length word): padding, RSTn, SOI/EOI.
      if (marker === 0xff) { at++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      if (marker === 0xda || marker === 0xd9) return -1; // image data starts; no EXIF
      const length = view.getUint16(at + 2);
      if (length < 2) return -1;
      if (marker === 0xe1 && at + 10 <= view.byteLength) {
        // APP1. "Exif\0\0" then the TIFF header.
        if (view.getUint32(at + 4) === 0x45786966 && view.getUint16(at + 8) === 0x0000) {
          return at + 10;
        }
      }
      at += 2 + length;
    }
    return -1;
  }

  /**
   * Read one IFD, calling `onTag` with every entry's value.
   * @param {DataView} view
   * @param {number} tiff  Offset of the TIFF header — every pointer is relative to it.
   * @param {number} ifd   Offset of the IFD itself, relative to `tiff`.
   * @param {boolean} le   Little-endian.
   * @param {(tag: number, value: string|number[]) => void} onTag
   */
  function _readIfd(view, tiff, ifd, le, onTag) {
    const base = tiff + ifd;
    if (base + 2 > view.byteLength) return;
    const count = view.getUint16(base, le);
    for (let i = 0; i < count; i++) {
      const entry = base + 2 + i * 12;
      if (entry + 12 > view.byteLength) return;
      const tag = view.getUint16(entry, le);
      const type = view.getUint16(entry + 2, le);
      const n = view.getUint32(entry + 4, le);
      const size = TYPE_SIZE[type] || 0;
      if (!size || n > 0xffff) continue;
      const bytes = size * n;
      // Values of four bytes or fewer are stored in the entry itself; anything
      // longer is a pointer, again relative to the TIFF header.
      const at = bytes <= 4 ? entry + 8 : tiff + view.getUint32(entry + 8, le);
      if (at < 0 || at + bytes > view.byteLength) continue;

      if (type === 2) {
        let s = "";
        for (let k = 0; k < n; k++) {
          const c = view.getUint8(at + k);
          if (!c) break; // NUL-terminated
          s += String.fromCharCode(c);
        }
        onTag(tag, s);
      } else if (type === 5) {
        /** @type {number[]} */
        const out = [];
        for (let k = 0; k < n; k++) {
          const num = view.getUint32(at + k * 8, le);
          const den = view.getUint32(at + k * 8 + 4, le);
          out.push(den ? num / den : 0);
        }
        onTag(tag, out);
      } else if (type === 3 || type === 4) {
        const v = type === 3 ? view.getUint16(at, le) : view.getUint32(at, le);
        onTag(tag, [v]);
      }
    }
  }

  /**
   * "YYYY:MM:DD HH:MM:SS" → "YYYY-MM-DD".
   *
   * The date part is taken verbatim and NOT put through a Date: an EXIF
   * timestamp is already local wall-clock time where the shutter fired, which
   * is exactly what a play's `played_at` means. Parsing it into a Date would
   * reinterpret it in the phone's current timezone and move a late-evening
   * holiday play to the following day.
   * @param {string} raw
   */
  function _dateFrom(raw) {
    const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(String(raw || "").trim());
    if (!m) return null;
    const [, y, mo, d] = m;
    if (y === "0000" || mo === "00" || d === "00") return null;
    return `${y}-${mo}-${d}`;
  }

  /**
   * GPS coordinates are three rationals — degrees, minutes, seconds — plus a
   * hemisphere letter in a separate tag.
   * @param {number[]} dms
   * @param {string} ref
   */
  function _degrees(dms, ref) {
    if (!Array.isArray(dms) || !dms.length) return null;
    const deg = (dms[0] || 0) + (dms[1] || 0) / 60 + (dms[2] || 0) / 3600;
    if (!isFinite(deg)) return null;
    const negative = /^[SW]/i.test(String(ref || ""));
    return negative ? -deg : deg;
  }

  /**
   * What a photo says about itself. Never rejects for a photo it can't read —
   * every field is independently optional, and the importer's whole design is
   * that the user sees and can correct whatever came back.
   * @param {File} file
   * @returns {Promise<PhotoExif>}
   */
  async function read(file) {
    /** @type {PhotoExif} */
    const out = { takenAt: null, lat: null, lon: null };
    let view;
    try {
      view = await _head(file);
    } catch (_) {
      return out;
    }
    const tiff = _findTiff(view);
    if (tiff < 0 || tiff + 8 > view.byteLength) return out;

    const order = view.getUint16(tiff);
    if (order !== 0x4949 && order !== 0x4d4d) return out;
    const le = order === 0x4949;
    if (view.getUint16(tiff + 2, le) !== 0x002a) return out;

    let exifIfd = 0;
    let gpsIfd = 0;
    let fallbackDate = null;
    _readIfd(view, tiff, view.getUint32(tiff + 4, le), le, (tag, value) => {
      if (tag === TAG_EXIF_IFD && Array.isArray(value)) exifIfd = value[0];
      else if (tag === TAG_GPS_IFD && Array.isArray(value)) gpsIfd = value[0];
      else if (tag === TAG_DATETIME && typeof value === "string") fallbackDate = _dateFrom(value);
    });

    if (exifIfd) {
      let digitized = null;
      _readIfd(view, tiff, exifIfd, le, (tag, value) => {
        if (typeof value !== "string") return;
        if (tag === TAG_DATETIME_ORIGINAL) out.takenAt = _dateFrom(value);
        else if (tag === TAG_DATETIME_DIGITIZED) digitized = _dateFrom(value);
      });
      // DateTimeOriginal is when the shutter fired; the other two are when the
      // file was written and when it was last edited. Preferred in that order.
      if (!out.takenAt) out.takenAt = digitized;
    }
    if (!out.takenAt) out.takenAt = fallbackDate;

    if (gpsIfd) {
      /** @type {number[]|null} */ let lat = null;
      /** @type {number[]|null} */ let lon = null;
      let latRef = "";
      let lonRef = "";
      _readIfd(view, tiff, gpsIfd, le, (tag, value) => {
        if (tag === GPS_LAT && Array.isArray(value)) lat = value;
        else if (tag === GPS_LON && Array.isArray(value)) lon = value;
        else if (tag === GPS_LAT_REF && typeof value === "string") latRef = value;
        else if (tag === GPS_LON_REF && typeof value === "string") lonRef = value;
      });
      if (lat && lon) {
        const la = _degrees(lat, latRef);
        const lo = _degrees(lon, lonRef);
        // (0, 0) is in the Gulf of Guinea, and it is overwhelmingly more likely
        // to be a camera that wrote an empty GPS block than a photo taken
        // there — a null null island beats a play logged in the sea.
        if (la != null && lo != null && (la || lo)) { out.lat = la; out.lon = lo; }
      }
    }
    return out;
  }

  /**
   * The photo's own date when it has one, else the file's modified time.
   *
   * A file date is weaker — a copy, a download or an AirDrop can rewrite it —
   * but for a camera roll it is usually still the day of the play, and it is
   * strictly better than making the user type every date by hand.
   * @param {PhotoExif} exif
   * @param {File} file
   * @returns {{date: string, source: "exif"|"file"}}
   */
  function dateFor(exif, file) {
    if (exif && exif.takenAt) return { date: exif.takenAt, source: "exif" };
    const d = new Date((file && file.lastModified) || Date.now());
    const pad = (n) => String(n).padStart(2, "0");
    return {
      // Local parts, not toISOString(): that is UTC, so an evening play west
      // of Greenwich would come out as the next day.
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      source: "file",
    };
  }

  window.BgbExif = { read, dateFor };
})();
