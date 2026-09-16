#!/usr/bin/env python3
"""Generate web/assets/brand/bgb-og-banner.svg + .png — the link-preview card.

WHY THIS IS A GENERATOR AND NOT A HAND-DRAWN FILE
-------------------------------------------------
The banner sets "Boardgame Buddy" in Fraunces, the app's display face, and an
SVG that merely *names* a font does not get it: an SVG loaded through <img>, or
fetched by a link-preview scraper, sees none of the page's @font-face rules and
falls back to a system serif. So the type is converted to outlines here, which
makes the SVG self-contained and pixel-identical everywhere — at the cost of
the text no longer being editable by hand. Changing the wording means editing
COPY below and re-running this.

    python3 tools/build-og-banner.py

Needs `pip install fonttools Pillow` and network access to fonts.gstatic.com for the
two faces, plus Chromium to rasterise. Both outputs are committed, so this is
only run when the design or the copy changes.

WHY A PNG AT ALL, GIVEN THE SVG
-------------------------------
og:image has to be raster. Facebook, Twitter/X, iMessage, Slack and Discord all
decline to render an SVG preview — several silently, showing no card rather than
an error. The SVG is the editable source; the PNG is what ships in the meta tag.

NOT THE OAUTH CONSENT SCREEN
----------------------------
Google's consent screen takes a SQUARE logo (120x120, shown in a small rounded
frame beside the app name) and has no banner slot at all. That stays
assets/brand/bgb-logo.svg. This file is for link previews, which is the only
place a 1.91:1 image is actually rendered.
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
import urllib.request

from fontTools.misc.transform import Transform
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "..", "web")
OUT_SVG = os.path.join(WEB, "assets", "brand", "bgb-og-banner.svg")
OUT_PNG = os.path.join(WEB, "assets", "brand", "bgb-og-banner.png")

W, H = 1200, 630

# The wording is the app's own, not new marketing copy: the tagline is the line
# the pre-launch landing view carried, and the app name is the app name.
COPY = {
    "name": "Boardgame Buddy",
    "tagline": "A log for the games you actually played.",
    "domain": "bgbuddy.app",
}

# Requesting the CSS with no User-Agent gets TTF rather than WOFF2, which skips
# a brotli dependency for no loss — these are static instances either way.
FONT_CSS = {
    "display": "https://fonts.googleapis.com/css2?family=Fraunces:wght@700",
    "ui": "https://fonts.googleapis.com/css2?family=Geist:wght@500",
}

# Brand colours, from assets/brand/bgb-logo.svg.
INK_DARK = "#1a0f0b"
INK_DARK_2 = "#2a1812"
AMBER = "#f59e0b"
ORANGE = "#f97316"
CREAM = "#fdf6ef"


def fetch_font(css_url):
    req = urllib.request.Request(css_url)
    css = urllib.request.urlopen(req, timeout=30).read().decode("utf-8")
    start = css.index("url(") + 4
    url = css[start:css.index(")", start)]
    if not url.endswith(".ttf"):
        raise SystemExit(f"expected a .ttf from Google Fonts, got {url}")
    path = os.path.join(tempfile.gettempdir(), os.path.basename(url))
    if not os.path.exists(path):
        urllib.request.urlretrieve(url, path)
    return path


def text_path(font_path, text, size, tracking=0.0):
    """Outlines for `text` at `size` px, plus its total advance width."""
    font = TTFont(font_path)
    upem = font["head"].unitsPerEm
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    scale = size / upem
    x = 0.0
    parts = []
    for ch in text:
        name = cmap.get(ord(ch))
        if name is None:
            raise SystemExit(f"no glyph for {ch!r} in {os.path.basename(font_path)}")
        pen = SVGPathPen(glyphs, ntos=lambda v: format(round(v, 2), "g"))
        # The y axis is flipped: font units go up from the baseline, SVG down.
        glyphs[name].draw(TransformPen(pen, Transform(scale, 0, 0, -scale, x, 0)))
        d = pen.getCommands()
        if d:
            parts.append(d)
        x += glyphs[name].width * scale + tracking
    return " ".join(parts), x


def build_svg():
    display = fetch_font(FONT_CSS["display"])
    ui = fetch_font(FONT_CSS["ui"])

    name_d, name_w = text_path(display, COPY["name"], 96, tracking=-0.5)
    tag_d, tag_w = text_path(ui, COPY["tagline"], 38)
    dom_d, dom_w = text_path(ui, COPY["domain"], 28, tracking=1.5)

    # Vertical rhythm. Everything sits inside a 60px band top and bottom,
    # because Twitter/X crops a summary_large_image to 2:1 — 1200x600 — and
    # anything closer to the edge than that is cropped off there while looking
    # fine everywhere else.
    mark = 128
    mark_y = 112
    name_base = 368
    tag_base = 438
    dom_base = 516

    def centered(d, width):
        return f'<g transform="translate({round((W - width) / 2, 1)}, 0)"><path d="{d}"/></g>'

    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <!-- GENERATED by tools/build-og-banner.py — do not hand-edit.
       The type is outlines, not <text>: a scraper or an <img> load sees no
       @font-face, so a named font would silently become a system serif.
       Change the copy in that script and re-run it. -->
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{INK_DARK}"/>
      <stop offset="100%" stop-color="{INK_DARK_2}"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{AMBER}"/>
      <stop offset="100%" stop-color="{ORANGE}"/>
    </linearGradient>
    <clipPath id="plate">
      <rect x="{(W - mark) / 2}" y="{mark_y}" width="{mark}" height="{mark}" rx="24"/>
    </clipPath>
  </defs>

  <rect width="{W}" height="{H}" fill="url(#ground)"/>

  <!-- The logo's board grid, scaled to the card. Same 0.08 opacity, so it
       reads as texture rather than as lines. -->
  <g opacity="0.08" stroke="{AMBER}" stroke-width="2">
    {"".join(f'<line x1="{x}" y1="0" x2="{x}" y2="{H}"/>' for x in range(100, W, 100))}
    {"".join(f'<line x1="0" y1="{y}" x2="{W}" y2="{y}"/>' for y in range(100, H, 100))}
  </g>

  <!-- The mark, on the plate it was drawn for (assets.md: a fixed lockup is
       never recoloured to suit the ground). -->
  <g clip-path="url(#plate)">
    <rect x="{(W - mark) / 2}" y="{mark_y}" width="{mark}" height="{mark}" fill="{INK_DARK}"/>
    <g transform="translate({(W - mark) / 2}, {mark_y}) scale({mark / 512})">
      <rect x="176" y="120" width="160" height="160" rx="32" fill="url(#accent)"/>
      <circle cx="220" cy="190" r="10" fill="{INK_DARK}"/>
      <circle cx="292" cy="190" r="10" fill="{INK_DARK}"/>
      <path d="M220 230 Q256 260 292 230" stroke="{INK_DARK}" stroke-width="6" fill="none" stroke-linecap="round"/>
      <g fill="url(#accent)">
        <circle cx="256" cy="310" r="26"/>
        <rect x="226" y="330" width="60" height="40" rx="16"/>
        <rect x="206" y="360" width="100" height="24" rx="12"/>
      </g>
      <g transform="translate(300, 260)">
        <rect x="0" y="0" width="80" height="80" rx="18" fill="#ffffff" opacity="0.95"/>
        <polygon points="16,80 36,80 22,100" fill="#ffffff" opacity="0.95"/>
        <g fill="{INK_DARK_2}">
          <circle cx="20" cy="20" r="5"/><circle cx="60" cy="20" r="5"/>
          <circle cx="40" cy="40" r="5"/>
          <circle cx="20" cy="60" r="5"/><circle cx="60" cy="60" r="5"/>
        </g>
      </g>
    </g>
  </g>
  <rect x="{(W - mark) / 2}" y="{mark_y}" width="{mark}" height="{mark}" rx="24"
        fill="none" stroke="{AMBER}" stroke-opacity="0.25" stroke-width="2"/>

  <g fill="{CREAM}" transform="translate(0, {name_base})">{centered(name_d, name_w)}</g>
  <g fill="{CREAM}" fill-opacity="0.68" transform="translate(0, {tag_base})">{centered(tag_d, tag_w)}</g>
  <g fill="{AMBER}" transform="translate(0, {dom_base})">{centered(dom_d, dom_w)}</g>
</svg>
"""


# Headless Chromium does not paint into the full height it is given: a
# --window-size of 1200x630 lays the page out in about 1200x543 and pads the
# screenshot to the requested size with its own white canvas. That is how the
# first version of this banner ended up with an 87px white band along the
# bottom, in a file whose dimensions were exactly right. So: render taller than
# needed, crop, and then CHECK the crop — if the overhead ever changes, this
# should fail rather than quietly ship a white stripe in every link preview.
RENDER_PAD = 200


def rasterise(svg_path, png_path):
    """Screenshot the SVG with Chromium, then crop to exactly W x H."""
    chrome = os.environ.get("CHROME_BIN", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
    if not os.path.exists(chrome):
        print(f"! {chrome} not found; SVG written, PNG unchanged.", file=sys.stderr)
        print("  Set CHROME_BIN, or rasterise the SVG by hand at 1200x630.", file=sys.stderr)
        return False
    try:
        from PIL import Image
    except ImportError:
        print("! Pillow not installed (pip install Pillow); PNG unchanged.", file=sys.stderr)
        return False

    # A wrapper page rather than the .svg directly: an SVG opened as a document
    # is laid out against the viewport, and the img gives it a box of exactly
    # the size we want regardless of what that viewport turns out to be.
    with open(svg_path, encoding="utf-8") as fh:
        data = base64.b64encode(fh.read().encode("utf-8")).decode("ascii")
    html = (
        f'<!DOCTYPE html><html><body style="margin:0">'
        f'<img style="display:block" src="data:image/svg+xml;base64,{data}"'
        f' width="{W}" height="{H}">'
        f"</body></html>"
    )
    wrapper = os.path.join(tempfile.gettempdir(), "bgb-og-wrapper.html")
    with open(wrapper, "w", encoding="utf-8") as fh:
        fh.write(html)

    shot = os.path.join(tempfile.gettempdir(), "bgb-og-raw.png")
    subprocess.run(
        [chrome, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
         f"--window-size={W},{H + RENDER_PAD}", f"--screenshot={shot}", f"file://{wrapper}"],
        check=True, capture_output=True,
    )

    img = Image.open(shot).convert("RGB").crop((0, 0, W, H))
    # The ground is a dark gradient, so any white along the bottom edge is
    # Chromium's canvas showing through rather than artwork.
    bottom = [img.getpixel((x, H - 1)) for x in range(0, W, 97)]
    if all(sum(px) > 720 for px in bottom):
        raise SystemExit(
            f"bottom row of the crop is blank — Chromium painted less than "
            f"{H}px of a {H + RENDER_PAD}px window. Raise RENDER_PAD."
        )
    img.save(png_path, optimize=True)
    return True


if __name__ == "__main__":
    svg = build_svg()
    with open(OUT_SVG, "w", encoding="utf-8") as fh:
        fh.write(svg)
    print(f"wrote {os.path.relpath(OUT_SVG)} ({len(svg) // 1024} KB)")
    if rasterise(OUT_SVG, OUT_PNG):
        print(f"wrote {os.path.relpath(OUT_PNG)} ({os.path.getsize(OUT_PNG) // 1024} KB)")
    print(json.dumps(COPY, indent=2))
