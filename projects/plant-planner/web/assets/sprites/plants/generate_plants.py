#!/usr/bin/env python3
"""Generate realistic-looking transparent PNG plant illustrations for the garden planner.

Each plant is 256x512px with transparent background, front-facing botanical style.
Uses layered shapes with subtle color variation for a natural look.
"""

import math
import random
import os
from PIL import Image, ImageDraw, ImageFilter

OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))
W, H = 256, 512

# ── Color helpers ──────────────────────────────────────────────────────────

def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def vary_color(rgb, amount=20):
    return tuple(max(0, min(255, c + random.randint(-amount, amount))) for c in rgb)

def darker(rgb, f=0.7):
    return tuple(int(c * f) for c in rgb)

def lighter(rgb, f=1.3):
    return tuple(min(255, int(c * f)) for c in rgb)

# ── Drawing primitives ────────────────────────────────────────────────────

def draw_ellipse(draw, cx, cy, rx, ry, color, alpha=255):
    for i in range(3):
        c = vary_color(color, 8)
        offset = random.randint(-2, 2)
        draw.ellipse(
            [cx - rx + offset, cy - ry + offset, cx + rx + offset, cy + ry + offset],
            fill=(*c, alpha)
        )

def draw_leaf(draw, cx, cy, w, h, color, angle=0):
    """Draw a leaf shape as a rotated ellipse with a midrib."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([cx - w, cy - h, cx + w, cy + h], fill=(*color, 220))
    # Midrib line
    mid_color = darker(color, 0.6)
    d.line([cx, cy - h + 2, cx, cy + h - 2], fill=(*mid_color, 160), width=1)
    if angle != 0:
        img = img.rotate(angle, center=(cx, cy), resample=Image.BICUBIC)
    return img

def draw_stem(draw, x, y1, y2, width, color):
    """Draw a tapered stem."""
    for i in range(max(1, width)):
        offset = i - width // 2
        c = vary_color(color, 10)
        draw.line([x + offset, y1, x + offset, y2], fill=(*c, 240), width=1)

def draw_flower_head(draw, cx, cy, radius, petal_color, center_color, petals=8):
    """Draw a simple flower with petals arranged in a circle."""
    petal_r = radius * 0.5
    for i in range(petals):
        angle = (2 * math.pi * i) / petals
        px = cx + math.cos(angle) * radius * 0.5
        py = cy + math.sin(angle) * radius * 0.5
        c = vary_color(petal_color, 15)
        draw.ellipse([px - petal_r, py - petal_r, px + petal_r, py + petal_r],
                     fill=(*c, 210))
    # Center
    cr = radius * 0.3
    draw.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=(*center_color, 240))

def draw_fruit(draw, cx, cy, rx, ry, color):
    """Draw a fruit/berry shape."""
    draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(*color, 230))
    # Highlight
    hx, hy = cx - rx * 0.3, cy - ry * 0.3
    hr = min(rx, ry) * 0.25
    draw.ellipse([hx - hr, hy - hr, hx + hr, hy + hr],
                 fill=(*lighter(color, 1.4), 100))

# ── Plant generators ──────────────────────────────────────────────────────

def gen_leafy_plant(name, leaf_color, stem_color, height_frac=0.6, spread=0.6, leaf_count=8):
    """Generic leafy plant (lettuce, spinach, kale, basil, etc.)."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    base_y = int(H * 0.92)
    top_y = int(H * (1 - height_frac) * 0.9)
    mid_x = W // 2

    # Stem
    draw_stem(draw, mid_x, base_y, top_y + 40, 4, stem_color)

    # Leaves in a rosette pattern
    for i in range(leaf_count):
        frac = i / max(1, leaf_count - 1)
        ly = base_y - int((base_y - top_y) * (0.3 + frac * 0.6))
        lx = mid_x + int(math.sin(i * 1.8) * W * spread * 0.3)
        lw = int(20 + random.randint(5, 20))
        lh = int(28 + random.randint(5, 15))
        angle = int(math.sin(i * 1.5) * 30)
        leaf_img = draw_leaf(draw, lx, ly, lw, lh, vary_color(leaf_color, 15), angle)
        img = Image.alpha_composite(img, leaf_img)
        draw = ImageDraw.Draw(img)

    return img

def gen_tall_stem_plant(name, leaf_color, stem_color, fruit_color=None,
                        height_frac=0.75, has_fruit=False, fruit_size=12):
    """Tall plant with central stem and side leaves (tomato, pepper, eggplant)."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    base_y = int(H * 0.92)
    top_y = int(H * (1 - height_frac) * 0.85)
    mid_x = W // 2

    # Main stem
    draw_stem(draw, mid_x, base_y, top_y, 5, stem_color)

    # Side branches with leaves
    branch_count = random.randint(5, 8)
    for i in range(branch_count):
        frac = (i + 1) / (branch_count + 1)
        by = base_y - int((base_y - top_y) * frac)
        side = 1 if i % 2 == 0 else -1
        bx_end = mid_x + side * random.randint(30, 60)

        # Branch line
        draw.line([mid_x, by, bx_end, by - 10], fill=(*stem_color, 200), width=2)

        # Leaf at end
        lw = random.randint(15, 25)
        lh = random.randint(20, 30)
        leaf_img = draw_leaf(draw, bx_end, by - 10, lw, lh,
                           vary_color(leaf_color, 12), side * random.randint(10, 25))
        img = Image.alpha_composite(img, leaf_img)
        draw = ImageDraw.Draw(img)

        # Fruits on some branches
        if has_fruit and fruit_color and random.random() > 0.4:
            fx = bx_end + side * 5
            fy = by + random.randint(0, 15)
            draw_fruit(draw, fx, fy, fruit_size, int(fruit_size * 1.1),
                      vary_color(fruit_color, 15))

    # Top leaves
    for i in range(3):
        lx = mid_x + random.randint(-15, 15)
        ly = top_y + random.randint(0, 20)
        leaf_img = draw_leaf(draw, lx, ly, 18, 25, vary_color(leaf_color, 10),
                           random.randint(-20, 20))
        img = Image.alpha_composite(img, leaf_img)
        draw = ImageDraw.Draw(img)

    return img

def gen_flower_plant(name, petal_color, center_color, stem_color, leaf_color,
                     height_frac=0.65, flower_count=3, flower_size=25):
    """Flowering plant with blooms on stems."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    base_y = int(H * 0.92)
    top_y = int(H * (1 - height_frac) * 0.85)
    mid_x = W // 2

    # Main stem
    draw_stem(draw, mid_x, base_y, top_y + 20, 4, stem_color)

    # Lower leaves
    for i in range(4):
        frac = (i + 1) / 6
        ly = base_y - int((base_y - top_y) * frac)
        side = 1 if i % 2 == 0 else -1
        lx = mid_x + side * random.randint(20, 40)
        draw.line([mid_x, ly, lx, ly - 5], fill=(*stem_color, 180), width=2)
        leaf_img = draw_leaf(draw, lx, ly - 5, 16, 22, vary_color(leaf_color, 10),
                           side * 20)
        img = Image.alpha_composite(img, leaf_img)
        draw = ImageDraw.Draw(img)

    # Flowers
    for i in range(flower_count):
        if flower_count == 1:
            fx, fy = mid_x, top_y + 10
        else:
            fx = mid_x + random.randint(-30, 30)
            fy = top_y + random.randint(0, 40)
            # Sub-stem to flower
            draw.line([mid_x, fy + 20, fx, fy], fill=(*stem_color, 180), width=2)

        draw_flower_head(draw, fx, fy, flower_size, vary_color(petal_color, 15),
                        center_color, petals=random.randint(6, 10))

    return img

def gen_herb_bush(name, leaf_color, stem_color, height_frac=0.45, dense=True):
    """Dense bushy herb (basil, oregano, thyme)."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    base_y = int(H * 0.92)
    top_y = int(H * (1 - height_frac) * 0.9)
    mid_x = W // 2

    # Multiple stems
    stem_count = 3 if dense else 1
    for s in range(stem_count):
        sx = mid_x + (s - 1) * 15
        draw_stem(draw, sx, base_y, top_y + 20, 3, stem_color)

    # Dense leaf cluster
    leaf_count = 15 if dense else 8
    for i in range(leaf_count):
        frac = random.random()
        lx = mid_x + random.randint(-45, 45)
        ly = base_y - int((base_y - top_y) * (0.2 + frac * 0.8))
        lw = random.randint(8, 16)
        lh = random.randint(12, 20)
        leaf_img = draw_leaf(draw, lx, ly, lw, lh, vary_color(leaf_color, 18),
                           random.randint(-40, 40))
        img = Image.alpha_composite(img, leaf_img)
        draw = ImageDraw.Draw(img)

    return img

def gen_root_veggie(name, leaf_color, stem_color, root_color, height_frac=0.35):
    """Root vegetable with visible top and hint of root (carrot, radish, onion)."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    base_y = int(H * 0.92)
    soil_y = int(H * 0.78)
    top_y = int(H * (1 - height_frac) * 0.9)
    mid_x = W // 2

    # Root peeking above soil
    draw.ellipse([mid_x - 18, soil_y - 10, mid_x + 18, soil_y + 25],
                 fill=(*root_color, 220))
    # Highlight on root
    draw.ellipse([mid_x - 8, soil_y - 5, mid_x + 5, soil_y + 10],
                 fill=(*lighter(root_color, 1.3), 80))

    # Stems/leaves growing up
    for i in range(4):
        sx = mid_x + random.randint(-8, 8)
        draw_stem(draw, sx, soil_y - 5, top_y + random.randint(0, 30), 2, stem_color)
        # Leaf at top
        leaf_img = draw_leaf(draw, sx, top_y + random.randint(10, 30),
                           random.randint(10, 18), random.randint(18, 28),
                           vary_color(leaf_color, 12), random.randint(-30, 30))
        img = Image.alpha_composite(img, leaf_img)
        draw = ImageDraw.Draw(img)

    return img

def gen_vine_crop(name, leaf_color, stem_color, fruit_color, fruit_rx=30, fruit_ry=25,
                  height_frac=0.4):
    """Ground-level vine crop with large fruit (watermelon, pumpkin, zucchini)."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    base_y = int(H * 0.92)
    mid_x = W // 2

    # Vine along ground
    vine_y = base_y - 30
    draw.line([mid_x - 60, vine_y, mid_x + 60, vine_y],
             fill=(*stem_color, 200), width=3)

    # Large leaves
    for i in range(5):
        lx = mid_x + random.randint(-55, 55)
        ly = vine_y - random.randint(10, 50)
        draw.line([lx, vine_y, lx, ly], fill=(*stem_color, 180), width=2)
        leaf_img = draw_leaf(draw, lx, ly, random.randint(18, 28), random.randint(20, 30),
                           vary_color(leaf_color, 15), random.randint(-25, 25))
        img = Image.alpha_composite(img, leaf_img)
        draw = ImageDraw.Draw(img)

    # Fruit sitting on ground
    fruit_y = base_y - fruit_ry - 5
    draw_fruit(draw, mid_x, fruit_y, fruit_rx, fruit_ry, fruit_color)

    # Stripe pattern for some fruits
    if fruit_rx > 25:
        for s in range(-2, 3):
            sx = mid_x + s * int(fruit_rx * 0.35)
            draw.line([sx, fruit_y - fruit_ry + 5, sx, fruit_y + fruit_ry - 5],
                     fill=(*darker(fruit_color, 0.8), 80), width=2)

    return img

def gen_tall_grass(name, color, height_frac=0.7):
    """Tall grass-like plant (corn, chives, garlic)."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    base_y = int(H * 0.92)
    top_y = int(H * (1 - height_frac) * 0.85)
    mid_x = W // 2

    blade_count = random.randint(5, 9)
    for i in range(blade_count):
        bx = mid_x + random.randint(-20, 20)
        tip_x = bx + random.randint(-25, 25)
        tip_y = top_y + random.randint(0, 50)
        c = vary_color(color, 15)

        # Draw blade as tapered polygon
        half_w = random.randint(4, 8)
        draw.polygon([
            (bx - half_w, base_y),
            (bx + half_w, base_y),
            (tip_x + 1, tip_y),
            (tip_x - 1, tip_y)
        ], fill=(*c, 220))
        # Center line
        draw.line([bx, base_y, tip_x, tip_y], fill=(*darker(c, 0.7), 100), width=1)

    return img

def gen_sunflower(name):
    """Special case: tall sunflower."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    base_y = int(H * 0.92)
    top_y = int(H * 0.1)
    mid_x = W // 2

    # Thick stem
    draw_stem(draw, mid_x, base_y, top_y + 50, 7, hex_to_rgb("#4a7c3f"))

    # Large leaves along stem
    for i in range(4):
        ly = base_y - int(i * (base_y - top_y) / 5) - 40
        side = 1 if i % 2 == 0 else -1
        lx = mid_x + side * 40
        draw.line([mid_x, ly, lx, ly - 10], fill=(*hex_to_rgb("#4a7c3f"), 200), width=3)
        leaf_img = draw_leaf(draw, lx, ly - 10, 25, 35, hex_to_rgb("#2E7D32"),
                           side * 25)
        img = Image.alpha_composite(img, leaf_img)
        draw = ImageDraw.Draw(img)

    # Large flower head
    draw_flower_head(draw, mid_x, top_y + 35, 45,
                    hex_to_rgb("#FFD600"), hex_to_rgb("#5D4037"), petals=14)

    return img

def gen_berry_bush(name, leaf_color, stem_color, berry_color, height_frac=0.6):
    """Berry bush (blueberry, raspberry, strawberry)."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    base_y = int(H * 0.92)
    top_y = int(H * (1 - height_frac) * 0.85)
    mid_x = W // 2

    # Multiple woody stems
    for s in range(-1, 2):
        sx = mid_x + s * 18
        draw_stem(draw, sx, base_y, top_y + random.randint(10, 40), 4, stem_color)

    # Leaves
    for i in range(10):
        lx = mid_x + random.randint(-50, 50)
        ly = base_y - int(random.random() * (base_y - top_y) * 0.8) - 20
        leaf_img = draw_leaf(draw, lx, ly, random.randint(12, 20), random.randint(16, 24),
                           vary_color(leaf_color, 12), random.randint(-30, 30))
        img = Image.alpha_composite(img, leaf_img)
        draw = ImageDraw.Draw(img)

    # Berries scattered
    for i in range(8):
        bx = mid_x + random.randint(-40, 40)
        by = base_y - int(random.random() * (base_y - top_y) * 0.6) - 30
        draw_fruit(draw, bx, by, 6, 7, vary_color(berry_color, 20))

    return img

def gen_climbing_plant(name, leaf_color, stem_color, height_frac=0.8):
    """Climbing/vining plant with tendrils (pole bean, pea)."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    base_y = int(H * 0.92)
    top_y = int(H * (1 - height_frac) * 0.85)
    mid_x = W // 2

    # Support pole hint
    draw.line([mid_x, base_y, mid_x, top_y - 10], fill=(160, 140, 120, 100), width=3)

    # Winding vine
    for y in range(base_y, top_y, -8):
        frac = (base_y - y) / (base_y - top_y)
        vx = mid_x + int(math.sin(frac * 8) * 15)
        draw.rectangle([vx - 2, y - 4, vx + 2, y], fill=(*stem_color, 200))

    # Leaves along vine
    for i in range(8):
        frac = (i + 1) / 9
        vy = base_y - int((base_y - top_y) * frac)
        side = 1 if i % 2 == 0 else -1
        vx = mid_x + int(math.sin(frac * 8) * 15)
        lx = vx + side * random.randint(20, 35)
        draw.line([vx, vy, lx, vy - 5], fill=(*stem_color, 160), width=1)
        leaf_img = draw_leaf(draw, lx, vy - 5, 14, 18, vary_color(leaf_color, 12),
                           side * 20)
        img = Image.alpha_composite(img, leaf_img)
        draw = ImageDraw.Draw(img)

    return img

# ── Plant definitions ─────────────────────────────────────────────────────

PLANTS = {
    # Vegetables
    "tomato": lambda: gen_tall_stem_plant("tomato", hex_to_rgb("#2E7D32"), hex_to_rgb("#4a7c3f"),
                                          hex_to_rgb("#E53935"), height_frac=0.65, has_fruit=True, fruit_size=14),
    "pepper": lambda: gen_tall_stem_plant("pepper", hex_to_rgb("#388E3C"), hex_to_rgb("#4a7c3f"),
                                          hex_to_rgb("#F44336"), height_frac=0.5, has_fruit=True, fruit_size=10),
    "lettuce": lambda: gen_leafy_plant("lettuce", hex_to_rgb("#7CB342"), hex_to_rgb("#558B2F"),
                                       height_frac=0.3, leaf_count=10),
    "carrot": lambda: gen_root_veggie("carrot", hex_to_rgb("#66BB6A"), hex_to_rgb("#4a7c3f"),
                                      hex_to_rgb("#FF8F00")),
    "zucchini": lambda: gen_vine_crop("zucchini", hex_to_rgb("#2E7D32"), hex_to_rgb("#33691E"),
                                      hex_to_rgb("#558B2F"), fruit_rx=28, fruit_ry=14),
    "cucumber": lambda: gen_vine_crop("cucumber", hex_to_rgb("#43A047"), hex_to_rgb("#33691E"),
                                      hex_to_rgb("#558B2F"), fruit_rx=25, fruit_ry=12),
    "broccoli": lambda: gen_leafy_plant("broccoli", hex_to_rgb("#2E7D32"), hex_to_rgb("#33691E"),
                                         height_frac=0.45, leaf_count=6),
    "spinach": lambda: gen_leafy_plant("spinach", hex_to_rgb("#388E3C"), hex_to_rgb("#2E7D32"),
                                        height_frac=0.25, leaf_count=8),
    "kale": lambda: gen_leafy_plant("kale", hex_to_rgb("#1B5E20"), hex_to_rgb("#33691E"),
                                     height_frac=0.45, leaf_count=10),
    "radish": lambda: gen_root_veggie("radish", hex_to_rgb("#66BB6A"), hex_to_rgb("#4a7c3f"),
                                       hex_to_rgb("#E53935"), height_frac=0.2),
    "bean-bush": lambda: gen_herb_bush("bean-bush", hex_to_rgb("#43A047"), hex_to_rgb("#33691E"),
                                        height_frac=0.4),
    "bean-pole": lambda: gen_climbing_plant("bean-pole", hex_to_rgb("#43A047"), hex_to_rgb("#33691E"),
                                             height_frac=0.8),
    "pea": lambda: gen_climbing_plant("pea", hex_to_rgb("#66BB6A"), hex_to_rgb("#4a7c3f"),
                                       height_frac=0.65),
    "onion": lambda: gen_root_veggie("onion", hex_to_rgb("#66BB6A"), hex_to_rgb("#4a7c3f"),
                                      hex_to_rgb("#F9A825")),
    "garlic": lambda: gen_tall_grass("garlic", hex_to_rgb("#7CB342"), height_frac=0.35),
    "potato": lambda: gen_leafy_plant("potato", hex_to_rgb("#43A047"), hex_to_rgb("#33691E"),
                                       height_frac=0.45, leaf_count=7),
    "sweet-potato": lambda: gen_vine_crop("sweet-potato", hex_to_rgb("#388E3C"), hex_to_rgb("#33691E"),
                                           hex_to_rgb("#E65100"), fruit_rx=22, fruit_ry=14),
    "corn": lambda: gen_tall_grass("corn", hex_to_rgb("#558B2F"), height_frac=0.85),
    "eggplant": lambda: gen_tall_stem_plant("eggplant", hex_to_rgb("#388E3C"), hex_to_rgb("#4a7c3f"),
                                             hex_to_rgb("#6A1B9A"), height_frac=0.55, has_fruit=True, fruit_size=16),

    # Herbs
    "basil": lambda: gen_herb_bush("basil", hex_to_rgb("#43A047"), hex_to_rgb("#2E7D32"),
                                    height_frac=0.35, dense=True),
    "cilantro": lambda: gen_herb_bush("cilantro", hex_to_rgb("#66BB6A"), hex_to_rgb("#4a7c3f"),
                                       height_frac=0.28, dense=False),
    "parsley": lambda: gen_herb_bush("parsley", hex_to_rgb("#388E3C"), hex_to_rgb("#2E7D32"),
                                      height_frac=0.28, dense=True),
    "rosemary": lambda: gen_herb_bush("rosemary", hex_to_rgb("#5D8A5E"), hex_to_rgb("#6D4C41"),
                                       height_frac=0.5, dense=True),
    "thyme": lambda: gen_herb_bush("thyme", hex_to_rgb("#7CB342"), hex_to_rgb("#6D4C41"),
                                    height_frac=0.22, dense=True),
    "mint": lambda: gen_herb_bush("mint", hex_to_rgb("#4CAF50"), hex_to_rgb("#388E3C"),
                                   height_frac=0.35, dense=True),
    "dill": lambda: gen_tall_stem_plant("dill", hex_to_rgb("#8BC34A"), hex_to_rgb("#558B2F"),
                                         height_frac=0.55),
    "chives": lambda: gen_tall_grass("chives", hex_to_rgb("#66BB6A"), height_frac=0.28),
    "oregano": lambda: gen_herb_bush("oregano", hex_to_rgb("#43A047"), hex_to_rgb("#6D4C41"),
                                      height_frac=0.28, dense=True),
    "sage": lambda: gen_herb_bush("sage", hex_to_rgb("#90A4AE"), hex_to_rgb("#6D4C41"),
                                   height_frac=0.45, dense=True),
    "lavender": lambda: gen_flower_plant("lavender", hex_to_rgb("#9C27B0"), hex_to_rgb("#7B1FA2"),
                                          hex_to_rgb("#6D4C41"), hex_to_rgb("#78909C"),
                                          height_frac=0.45, flower_count=5, flower_size=12),

    # Flowers
    "sunflower": lambda: gen_sunflower("sunflower"),
    "marigold": lambda: gen_flower_plant("marigold", hex_to_rgb("#FF8F00"), hex_to_rgb("#E65100"),
                                          hex_to_rgb("#4a7c3f"), hex_to_rgb("#43A047"),
                                          height_frac=0.3, flower_count=3, flower_size=18),
    "zinnia": lambda: gen_flower_plant("zinnia", hex_to_rgb("#E91E63"), hex_to_rgb("#FFD600"),
                                        hex_to_rgb("#4a7c3f"), hex_to_rgb("#388E3C"),
                                        height_frac=0.5, flower_count=3, flower_size=20),
    "petunia": lambda: gen_flower_plant("petunia", hex_to_rgb("#AB47BC"), hex_to_rgb("#F3E5F5"),
                                         hex_to_rgb("#4a7c3f"), hex_to_rgb("#43A047"),
                                         height_frac=0.25, flower_count=4, flower_size=16),
    "cosmos": lambda: gen_flower_plant("cosmos", hex_to_rgb("#F48FB1"), hex_to_rgb("#FFD600"),
                                        hex_to_rgb("#4a7c3f"), hex_to_rgb("#66BB6A"),
                                        height_frac=0.65, flower_count=4, flower_size=18),
    "nasturtium": lambda: gen_flower_plant("nasturtium", hex_to_rgb("#FF6D00"), hex_to_rgb("#FFD600"),
                                            hex_to_rgb("#4a7c3f"), hex_to_rgb("#43A047"),
                                            height_frac=0.3, flower_count=4, flower_size=16),
    "dahlia": lambda: gen_flower_plant("dahlia", hex_to_rgb("#AD1457"), hex_to_rgb("#F8BBD0"),
                                        hex_to_rgb("#4a7c3f"), hex_to_rgb("#388E3C"),
                                        height_frac=0.65, flower_count=3, flower_size=28),
    "pansy": lambda: gen_flower_plant("pansy", hex_to_rgb("#7B1FA2"), hex_to_rgb("#FFD600"),
                                       hex_to_rgb("#4a7c3f"), hex_to_rgb("#66BB6A"),
                                       height_frac=0.22, flower_count=3, flower_size=16),
    "impatiens": lambda: gen_flower_plant("impatiens", hex_to_rgb("#F44336"), hex_to_rgb("#FFEB3B"),
                                           hex_to_rgb("#4a7c3f"), hex_to_rgb("#43A047"),
                                           height_frac=0.3, flower_count=5, flower_size=14),
    "hosta": lambda: gen_leafy_plant("hosta", hex_to_rgb("#558B2F"), hex_to_rgb("#33691E"),
                                      height_frac=0.45, spread=0.8, leaf_count=8),
    "snapdragon": lambda: gen_flower_plant("snapdragon", hex_to_rgb("#E91E63"), hex_to_rgb("#F8BBD0"),
                                            hex_to_rgb("#4a7c3f"), hex_to_rgb("#388E3C"),
                                            height_frac=0.5, flower_count=6, flower_size=10),
    "black-eyed-susan": lambda: gen_flower_plant("black-eyed-susan", hex_to_rgb("#FFC107"),
                                                   hex_to_rgb("#5D4037"),
                                                   hex_to_rgb("#4a7c3f"), hex_to_rgb("#43A047"),
                                                   height_frac=0.5, flower_count=4, flower_size=18),
    "coneflower": lambda: gen_flower_plant("coneflower", hex_to_rgb("#CE93D8"), hex_to_rgb("#5D4037"),
                                            hex_to_rgb("#4a7c3f"), hex_to_rgb("#388E3C"),
                                            height_frac=0.55, flower_count=3, flower_size=22),
    "geranium": lambda: gen_flower_plant("geranium", hex_to_rgb("#E53935"), hex_to_rgb("#C62828"),
                                          hex_to_rgb("#4a7c3f"), hex_to_rgb("#43A047"),
                                          height_frac=0.35, flower_count=4, flower_size=18),

    # Fruits
    "strawberry": lambda: gen_berry_bush("strawberry", hex_to_rgb("#43A047"), hex_to_rgb("#33691E"),
                                          hex_to_rgb("#E53935"), height_frac=0.22),
    "blueberry": lambda: gen_berry_bush("blueberry", hex_to_rgb("#388E3C"), hex_to_rgb("#5D4037"),
                                         hex_to_rgb("#1565C0"), height_frac=0.6),
    "raspberry": lambda: gen_berry_bush("raspberry", hex_to_rgb("#43A047"), hex_to_rgb("#5D4037"),
                                         hex_to_rgb("#C62828"), height_frac=0.7),
    "watermelon": lambda: gen_vine_crop("watermelon", hex_to_rgb("#43A047"), hex_to_rgb("#33691E"),
                                         hex_to_rgb("#2E7D32"), fruit_rx=40, fruit_ry=30),
    "pumpkin": lambda: gen_vine_crop("pumpkin", hex_to_rgb("#43A047"), hex_to_rgb("#33691E"),
                                      hex_to_rgb("#E65100"), fruit_rx=38, fruit_ry=32),
    "cantaloupe": lambda: gen_vine_crop("cantaloupe", hex_to_rgb("#43A047"), hex_to_rgb("#33691E"),
                                         hex_to_rgb("#C8B560"), fruit_rx=30, fruit_ry=26),
}

# Category fallback generators
CATEGORY_FALLBACKS = {
    "_vegetable": lambda: gen_leafy_plant("veggie", hex_to_rgb("#43A047"), hex_to_rgb("#33691E"),
                                           height_frac=0.45, leaf_count=7),
    "_herb": lambda: gen_herb_bush("herb", hex_to_rgb("#66BB6A"), hex_to_rgb("#4a7c3f"),
                                    height_frac=0.35),
    "_flower": lambda: gen_flower_plant("flower", hex_to_rgb("#E91E63"), hex_to_rgb("#FFD600"),
                                         hex_to_rgb("#4a7c3f"), hex_to_rgb("#43A047"),
                                         height_frac=0.45, flower_count=3, flower_size=20),
    "_fruit": lambda: gen_berry_bush("fruit", hex_to_rgb("#43A047"), hex_to_rgb("#5D4037"),
                                      hex_to_rgb("#E53935"), height_frac=0.5),
}

def apply_soft_edges(img):
    """Apply slight blur to edges for a softer, more natural look."""
    # Create alpha mask, blur it slightly, apply back
    alpha = img.split()[3]
    # Very slight edge softening
    alpha = alpha.filter(ImageFilter.SMOOTH)
    img.putalpha(alpha)
    return img

def main():
    random.seed(42)  # Reproducible output

    all_plants = {**PLANTS, **CATEGORY_FALLBACKS}
    total = len(all_plants)

    for i, (slug, gen_func) in enumerate(all_plants.items()):
        filename = slug + ".png"
        filepath = os.path.join(OUTPUT_DIR, filename)
        print(f"[{i+1}/{total}] Generating {filename}...")

        img = gen_func()
        img = apply_soft_edges(img)
        img.save(filepath, "PNG", optimize=True)

    print(f"\nDone! Generated {total} plant images in {OUTPUT_DIR}")

if __name__ == "__main__":
    main()
