#!/usr/bin/env python3
"""
Generate the menu-bar tray icons for IronClaw.

Two families of PNGs are emitted:

  1. Status-only variants — three colored claw glyphs (cyan / gold /
     dim-grey), one per connection state, no badge overlay. Names:
     `tray-{status}.png` (matches the original v1 file shape so any
     existing reference stays valid).

  2. Status × count composites — the same claw glyph with a small red
     pill rendered in the top-right corner containing the count. We
     emit one PNG per (status, count) pair for count ∈ {1..9, 9plus},
     so the Rust side can swap a single image instead of compositing
     at runtime. Names: `tray-{status}-{count}.png` (count ∈ "1".."9",
     "9plus").

Total icons: 3 + 3×10 = 33.

We deliberately do NOT use a single macOS Template image + tint-overlay:
- macOS templates collapse to white-on-black in light/dark menu bars,
  which loses the colour signal entirely. We want three distinct hues
  that "leak through" the tint so the user reads state at a glance.
- The bitmap is rendered at 64x64 (32pt @2x), the size macOS expects in
  the menu bar. Tauri's tray-icon crate clamps the image down for us if
  the OS picks a smaller slot.

The badge overlay is a red filled circle in the top-right quadrant with
the count rendered in white Helvetica bold. The badge sits over the
talon and pulls the user's eye without obscuring the claw silhouette.
"9+" replaces any count ≥ 10 so the pill never grows wider than two
glyphs at the menu-bar resolution.

Rendering uses Pillow only — no cairosvg dependency — so this works in
the system Python without a venv.

Run from inside src-tauri/icons/tray/ (the script anchors paths off
__file__ so any cwd works).
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont  # type: ignore
except ImportError:
    sys.exit("Pillow not available; install with `pip3 install --user Pillow`")

HERE = Path(__file__).resolve().parent

# 32x32 @2x = 64x64 effective. macOS will downscale if a smaller slot
# is needed; we never go below this to keep the menu-bar rendering sharp.
SIZE = 64

# (name suffix, fill RGB) — alpha comes from the draw mask. The suffix
# matches the JS `IconStatus` discriminator + the Rust enum below.
STATUSES: list[tuple[str, tuple[int, int, int]]] = [
    ("connected", (0, 212, 255)),    # accent-cyan
    ("connecting", (251, 191, 36)),  # accent-gold
    ("disconnected", (160, 160, 168)),  # dim grey (neutral, not alarming)
]

# Count labels we render. The tuple is (filename token, glyph). Filename
# tokens cannot include "+" (some shells/tools choke on them inside
# include_bytes! paths), so we use the spelled-out form "9plus".
COUNT_VARIANTS: list[tuple[str, str]] = [
    ("1", "1"),
    ("2", "2"),
    ("3", "3"),
    ("4", "4"),
    ("5", "5"),
    ("6", "6"),
    ("7", "7"),
    ("8", "8"),
    ("9", "9"),
    ("9plus", "9+"),
]

# Badge styling. Sized relative to SIZE so the geometry survives scale
# changes without re-tuning. Filled red circle with a white digit; the
# circle is anchored in the top-right corner with a small inset so it
# doesn't visually overflow the icon's tight bounding box.
BADGE_RADIUS = SIZE * 0.22
BADGE_INSET = SIZE * 0.04
BADGE_FILL = (235, 64, 52, 255)        # macOS-ish red, opaque
BADGE_RING = (255, 255, 255, 235)      # thin white outline so the badge
                                       # reads on light AND dark menu bars
BADGE_RING_WIDTH = max(1, int(SIZE * 0.025))
BADGE_TEXT_COLOR = (255, 255, 255, 255)

# Font for the digit overlay. We try Helvetica first (ships on every
# macOS install) and fall back to PIL's default bitmap font so a missing
# system font never breaks the build — the fallback just looks chunky.
FONT_PATH_CANDIDATES = [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/Avenir.ttc",
    "/Library/Fonts/Arial.ttf",
]


def load_badge_font(target_size: int) -> ImageFont.ImageFont:
    """Load a bold/medium sans font sized for the badge pill.

    `target_size` is the desired pt-size; we render at 2x so the glyph
    is crisp at the 64x64 bitmap scale.
    """
    for path in FONT_PATH_CANDIDATES:
        try:
            # Helvetica.ttc has multiple faces; index 1 is "Bold" on
            # macOS Sequoia, which is what we want for a small overlay
            # digit. PIL silently falls back to face 0 if the requested
            # index doesn't exist.
            return ImageFont.truetype(path, size=target_size, index=1)
        except (OSError, IOError):
            continue
        except TypeError:
            # Older PIL signatures don't accept `index=`. Try without.
            try:
                return ImageFont.truetype(path, size=target_size)
            except (OSError, IOError):
                continue
    return ImageFont.load_default()


def draw_claw(size: int, color: tuple[int, int, int]) -> Image.Image:
    """Render one claw glyph in `color` at `size`x`size` RGBA.

    Geometry: three short arc-segments evenly spaced 120 degrees apart,
    pointing outward from a small dotted centre. The stroke width is
    proportional to size so the glyph keeps its weight at every scale.
    """
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    cx = cy = size / 2
    # Outer radius for the talons; the arc traces an annulus from r_inner
    # to r_outer so the marks read as claws, not lines.
    r_outer = size * 0.42
    r_inner = size * 0.20  # noqa: F841 - kept for future variants
    stroke = max(2, int(size * 0.11))

    # Three talons, starting at top (-90 deg) and rotating clockwise.
    # Each talon is a short arc drawn between two `pieslice` outlines
    # then masked to a tick-mark width by re-drawing in transparent.
    # For simplicity we draw an arc segment via PIL's `arc` primitive.
    bbox = (cx - r_outer, cy - r_outer, cx + r_outer, cy + r_outer)
    # Each talon occupies a 60-degree arc centred on its base angle.
    for base_deg in (-90.0, 30.0, 150.0):
        start = base_deg - 28.0
        end = base_deg + 28.0
        draw.arc(bbox, start=start, end=end, fill=color + (255,), width=stroke)

    # Small inner dot tying the three talons together — same accent
    # colour, slightly translucent, sized relative to the glyph.
    dot_r = size * 0.07
    draw.ellipse(
        (cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r),
        fill=color + (220,),
    )

    # Single tiny "tip" glint on the top talon to echo the main app icon's
    # gold accent. Always white-ish so it reads at small sizes; the color
    # is the claw's own colour at full alpha so it stays harmonious.
    tip_r = max(1, int(size * 0.045))
    tip_y = cy - r_outer
    draw.ellipse(
        (cx - tip_r, tip_y - tip_r, cx + tip_r, tip_y + tip_r),
        fill=(255, 255, 255, 240),
    )

    return img


def overlay_badge(base: Image.Image, glyph: str) -> Image.Image:
    """Composite a small red count badge onto a copy of `base`.

    `glyph` is the rendered text — "1".."9" or "9+". The badge sits in
    the top-right corner with a thin white ring so it stays readable on
    both light and dark menu bars. We compose on a fresh RGBA so the
    caller can still re-use the original status-only image.
    """
    out = base.copy()
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    size = base.size[0]
    cx = size - BADGE_INSET - BADGE_RADIUS
    cy = BADGE_INSET + BADGE_RADIUS
    bbox = (
        cx - BADGE_RADIUS,
        cy - BADGE_RADIUS,
        cx + BADGE_RADIUS,
        cy + BADGE_RADIUS,
    )

    # Outer ring first so the fill paints inside it cleanly; PIL's
    # ellipse with `outline` + `width` draws strokes centred on the
    # path, which can soft-blend at the edge. Drawing fill then ring
    # gives a crisper edge.
    draw.ellipse(bbox, fill=BADGE_FILL)
    draw.ellipse(bbox, outline=BADGE_RING, width=BADGE_RING_WIDTH)

    # Render the glyph centred on the badge. Font is sized to ~70% of
    # badge diameter for single digits, scaled down a touch for "9+"
    # so the wider glyph fits cleanly.
    target_font_px = int(BADGE_RADIUS * 1.45) if len(glyph) == 1 else int(BADGE_RADIUS * 1.15)
    font = load_badge_font(target_font_px)
    tbox = draw.textbbox((0, 0), glyph, font=font)
    tw = tbox[2] - tbox[0]
    th = tbox[3] - tbox[1]
    # Compensate for the textbbox top-left offset (PIL leaves leading
    # whitespace in the bbox); subtract tbox[0,1] so the glyph centres
    # on the true ink box.
    tx = cx - tw / 2 - tbox[0]
    ty = cy - th / 2 - tbox[1]
    draw.text((tx, ty), glyph, fill=BADGE_TEXT_COLOR, font=font)

    out.alpha_composite(overlay)
    return out


def main() -> None:
    print(
        f"rendering 3 status icons + 30 (status,count) composites "
        f"at {SIZE}x{SIZE} into {HERE}"
    )

    # First the status-only variants — same artwork as v1, same names.
    bases: dict[str, Image.Image] = {}
    for status_name, color in STATUSES:
        img = draw_claw(SIZE, color)
        bases[status_name] = img
        out = HERE / f"tray-{status_name}.png"
        img.save(out, format="PNG")
        print(
            f"  wrote {out.name} "
            f"({color[0]:02x}{color[1]:02x}{color[2]:02x}, "
            f"{out.stat().st_size} bytes)"
        )

    # Then the count overlays — one per (status, count) tuple.
    total_overlay_bytes = 0
    for status_name, _color in STATUSES:
        base = bases[status_name]
        for token, glyph in COUNT_VARIANTS:
            img = overlay_badge(base, glyph)
            out = HERE / f"tray-{status_name}-{token}.png"
            img.save(out, format="PNG")
            size = out.stat().st_size
            total_overlay_bytes += size
            print(f"  wrote {out.name} ({size} bytes)")

    print(
        f"done. 33 icons total; "
        f"{total_overlay_bytes} bytes across the 30 composites."
    )


if __name__ == "__main__":
    main()
