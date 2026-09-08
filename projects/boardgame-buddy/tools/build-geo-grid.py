#!/usr/bin/env python3
"""Regenerate web/domain/geo-grid-data.js — the lat/lon → country raster.

    python3 projects/boardgame-buddy/tools/build-geo-grid.py

Downloads the Natural Earth admin-0 boundaries (via the `datasets/geo-countries`
mirror), rasterises them onto a 0.1° grid and writes the run-length string that
domain/geo-grid.js reads. Nothing here runs at request time or at deploy time:
this is a one-off, checked in like domain/geo-data.js is, and rerun only when
the boundary data changes.

WHY A RASTER AND NOT THE POLYGONS. The polygons are 15 MB. The question being
asked of them is "which country is this photo from", at country granularity,
for a field the user can correct in one tap — so a 0.1° grid (about 11 km at
the equator) is all the precision the answer can carry. It costs 162 KB of
text, 71 KB over the wire, and answers in an array lookup with no allocation.

WHY 0.1° AND NOT COARSER. 0.25° is a third of the bytes and gets Basel,
Geneva and Maastricht wrong — three cities whose whole metropolitan area is
inside one cell of a neighbouring country. Border towns are exactly where a
guessed country is most likely to be wrong and least likely to be noticed.

WHY FIRST-WRITER-WINS, SMALLEST COUNTRY FIRST. Where two polygons claim one
cell — a border, a disputed area, an enclave — the smaller country keeps it.
Monaco is smaller than one cell of this grid; giving the cell to France would
mean Monaco could never be detected at all, while France loses one cell of
coastline it has 60,000 others of.
"""

import json
import math
import os
import sys
import urllib.request
from collections import defaultdict

STEP = 0.1
SOURCE_URL = (
    "https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson"
)

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "..", "web")
OUT = os.path.normpath(os.path.join(WEB, "domain", "geo-grid-data.js"))
GEO_DATA = os.path.normpath(os.path.join(WEB, "domain", "geo-data.js"))

COLS = int(round(360 / STEP))
ROWS = int(round(180 / STEP))

# Natural Earth writes "-99" where it has no ISO code to give. Three of those
# are ordinary countries with ordinary codes; two more are territories with no
# code of their own, which take the code of the country ISO files them under.
# The rest of the "-99" rows are military bases, glaciers and uninhabited rocks
# that a "where did you play this game" field has nothing to say about.
# Named explicitly so an upstream fix is a no-op rather than a double entry.
OVERRIDES = {
    "France": "FR",
    "Norway": "NO",
    "Taiwan": "TW",
    "Somaliland": "SO",
    "Northern Cyprus": "CY",
}

BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def known_countries() -> set:
    """Every country domain/geo-data.js knows.

    The grid must not be able to produce a code Geo.isKnown() rejects or the
    picker can't display — one source for the country SET, two ways of looking
    a country up in it.
    """
    codes = set()
    with open(GEO_DATA, encoding="utf-8") as fh:
        for line in fh:
            parts = line.strip().split()
            if len(parts) >= 2 and len(parts[0]) == 2 and parts[0].isalpha() and parts[0].isupper():
                codes.add(parts[0])
    return codes


def load_features(known: set) -> list:
    """(bbox area, ISO code, polygons) per country, smallest first."""
    print(f"fetching {SOURCE_URL}", file=sys.stderr)
    with urllib.request.urlopen(SOURCE_URL) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    out = []
    for feature in data["features"]:
        props = feature.get("properties") or {}
        code = (props.get("ISO3166-1-Alpha-2") or "").upper()
        if len(code) != 2 or not code.isalpha():
            code = OVERRIDES.get(props.get("name") or "", "")
        if code not in known:
            continue
        geom = feature.get("geometry") or {}
        if geom.get("type") == "Polygon":
            polys = [geom["coordinates"]]
        elif geom.get("type") == "MultiPolygon":
            polys = geom["coordinates"]
        else:
            continue
        xs = [p[0] for poly in polys for ring in poly for p in ring]
        ys = [p[1] for poly in polys for ring in poly for p in ring]
        if not xs:
            continue
        area = (max(xs) - min(xs)) * (max(ys) - min(ys))
        out.append((area, code, polys))
    out.sort(key=lambda row: row[0])
    return out


def rasterise(feats: list) -> tuple:
    """The grid, as a bytearray of 1-based indices into the code list."""
    grid = bytearray(COLS * ROWS)
    codes = []
    index = {}

    def code_index(code: str) -> int:
        if code not in index:
            codes.append(code)
            index[code] = len(codes)
        return index[code]

    # Pass 1 — interiors. Even-odd scanline fill, per polygon (so a polygon's
    # holes, which are just more rings, subtract themselves).
    for _, code, polys in feats:
        ci = code_index(code)
        for poly in polys:
            crossings = defaultdict(list)
            for ring in poly:
                n = len(ring)
                for i in range(n):
                    x1, y1 = ring[i][0], ring[i][1]
                    x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
                    if y1 == y2:
                        continue
                    lo, hi = (y1, y2) if y1 < y2 else (y2, y1)
                    r_lo = max(0, int(math.floor((90.0 - hi) / STEP)))
                    r_hi = min(ROWS - 1, int(math.ceil((90.0 - lo) / STEP)))
                    for r in range(r_lo, r_hi + 1):
                        yc = 90.0 - (r + 0.5) * STEP
                        if yc <= lo or yc > hi:
                            continue
                        crossings[r].append(x1 + (yc - y1) * (x2 - x1) / (y2 - y1))
            for r, xs in crossings.items():
                xs.sort()
                base = r * COLS
                for i in range(0, len(xs) - 1, 2):
                    ca = int(math.ceil((xs[i] + 180.0) / STEP - 0.5))
                    cb = int(math.floor((xs[i + 1] + 180.0) / STEP - 0.5))
                    if cb < ca:
                        # A span narrower than one cell still covers a cell.
                        ca = cb = int((xs[i] + xs[i + 1]) / 2.0 / STEP + 180.0 / STEP)
                    for c in range(max(0, ca), min(COLS - 1, cb) + 1):
                        if grid[base + c] == 0:
                            grid[base + c] = ci

    # Pass 2 — coastlines. A scanline fill only claims cells whose CENTRE is
    # inside the polygon, so a harbour city in a cell that is mostly water
    # resolves to nothing at all. Walking every edge and claiming the cells it
    # crosses puts the coast on the map. Interiors are already written, so this
    # only ever fills blanks.
    for _, code, polys in feats:
        ci = code_index(code)
        for poly in polys:
            for ring in poly:
                n = len(ring)
                for i in range(n):
                    x1, y1 = ring[i][0], ring[i][1]
                    x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
                    steps = int(max(abs(x2 - x1), abs(y2 - y1)) / STEP) + 1
                    for s in range(steps + 1):
                        t = s / steps
                        r = int((90.0 - (y1 + (y2 - y1) * t)) / STEP)
                        c = int((x1 + (x2 - x1) * t + 180.0) / STEP)
                        if 0 <= r < ROWS and 0 <= c < COLS and grid[r * COLS + c] == 0:
                            grid[r * COLS + c] = ci
    return grid, codes


def encode(grid: bytearray, codes: list) -> str:
    """Row-major run-length, as `<count base36><ISO code>` with `..` for water.

    Self-delimiting with no separators and no companion lookup table, because
    base36 run lengths are lower case and ISO codes are upper case: the decoder
    knows a run has ended the moment it reads a capital.
    """
    def b36(n: int) -> str:
        s = ""
        while True:
            s = BASE36[n % 36] + s
            n //= 36
            if not n:
                return s

    out = []
    prev = grid[0]
    run = 1
    for value in memoryview(grid)[1:]:
        if value == prev:
            run += 1
            continue
        out.append(b36(run) + (codes[prev - 1] if prev else ".."))
        prev = value
        run = 1
    out.append(b36(run) + (codes[prev - 1] if prev else ".."))
    return "".join(out)


HEADER = '''// domain/geo-grid-data.js — GENERATED. Do not edit by hand.
//
// Rebuild with:  python3 projects/boardgame-buddy/tools/build-geo-grid.py
//
// A %(step)s° raster of the world's country boundaries, run-length encoded.
// Read by domain/geo-grid.js, which is the only file that should ever touch it
// and which documents the format. Loaded lazily (ui/lazy-script.js) — nothing
// but the photo importer needs a map of the world.
//
// Source: Natural Earth admin-0 boundaries, via the datasets/geo-countries
// mirror. %(cols)d × %(rows)d cells, %(runs)d runs.
(function () {
  window.BGB_GEO_GRID_DATA = {
    step: %(step)s,
    cols: %(cols)d,
    rows: %(rows)d,
    // "<run length, base36><ISO 3166-1 alpha-2>", or ".." for no country.
    runs: "%(runs_str)s",
  };
})();
'''


def main() -> None:
    known = known_countries()
    feats = load_features(known)
    print(f"{len(feats)} countries of {len(known)} known", file=sys.stderr)
    grid, codes = rasterise(feats)
    land = sum(1 for v in grid if v)
    print(f"{land} land cells of {COLS * ROWS} ({100 * land / (COLS * ROWS):.1f}%)", file=sys.stderr)
    runs = encode(grid, codes)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(HEADER % {
            "step": STEP,
            "cols": COLS,
            "rows": ROWS,
            "runs": sum(1 for ch in runs if ch.isupper() or ch == ".") // 2,
            "runs_str": runs,
        })
    print(f"wrote {OUT} ({len(runs)} chars)", file=sys.stderr)


if __name__ == "__main__":
    main()
