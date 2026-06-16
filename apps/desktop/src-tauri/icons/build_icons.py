#!/usr/bin/env python3
"""
Rasterize iconsrc.svg into the PNG sizes Tauri + macOS need, then assemble
the macOS .icns via the system `iconutil`.

Run from inside a venv that has cairosvg installed (see top of file in repo).
This script is idempotent — re-run any time iconsrc.svg changes.
"""

from __future__ import annotations

import io
import shutil
import subprocess
import sys
from pathlib import Path

try:
    import cairosvg  # type: ignore
except ImportError:
    sys.exit("cairosvg not available; run inside a venv with `pip install cairosvg`")

try:
    from PIL import Image  # type: ignore
except ImportError:
    sys.exit("Pillow not available; run inside a venv with `pip install Pillow`")

HERE = Path(__file__).resolve().parent
SRC = HERE / "iconsrc.svg"

# Sizes Tauri config references directly
TAURI_SIZES = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 1024,
}

# All sizes iconutil expects inside an .iconset (Apple HIG)
ICONSET_SIZES = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
}


def render(size: int) -> bytes:
    """Render iconsrc.svg to a PNG byte-string in RGBA mode.

    cairosvg writes RGB-only PNGs by default; Tauri's bundler rejects
    those, so we round-trip through Pillow to force an explicit RGBA
    save (alpha channel present even though the SVG fills edge-to-edge).
    """
    raw = cairosvg.svg2png(
        url=str(SRC),
        output_width=size,
        output_height=size,
    )
    with Image.open(io.BytesIO(raw)) as img:
        rgba = img.convert("RGBA")
        buf = io.BytesIO()
        rgba.save(buf, format="PNG")
        return buf.getvalue()


def main() -> None:
    if not SRC.exists():
        sys.exit(f"missing source SVG: {SRC}")

    # Render each unique pixel size once, cache the bytes.
    needed = set(TAURI_SIZES.values()) | set(ICONSET_SIZES.values())
    print(f"rendering {len(needed)} unique sizes: {sorted(needed)}")
    cache: dict[int, bytes] = {s: render(s) for s in needed}

    # Write Tauri-referenced PNGs at the icons/ root.
    for name, size in TAURI_SIZES.items():
        path = HERE / name
        path.write_bytes(cache[size])
        print(f"  wrote {path.name} ({size}x{size}, {len(cache[size])} bytes)")

    # Build the .iconset directory.
    iconset_dir = HERE / "IronClaw.iconset"
    if iconset_dir.exists():
        shutil.rmtree(iconset_dir)
    iconset_dir.mkdir()
    for name, size in ICONSET_SIZES.items():
        (iconset_dir / name).write_bytes(cache[size])

    # Compile .icns via Apple's iconutil.
    icns_out = HERE / "icon.icns"
    if icns_out.exists():
        icns_out.unlink()
    subprocess.run(
        ["iconutil", "-c", "icns", "-o", str(icns_out), str(iconset_dir)],
        check=True,
    )
    print(f"  wrote {icns_out.name} ({icns_out.stat().st_size} bytes)")

    # Sanity: .icns must start with magic 'icns'
    with icns_out.open("rb") as fh:
        magic = fh.read(4)
    if magic != b"icns":
        sys.exit(f"icns magic bytes wrong: {magic!r}")
    print(f"  icns magic OK: {magic!r}")

    # Clean intermediate iconset (keep only sources + outputs)
    shutil.rmtree(iconset_dir)
    print(f"  cleaned {iconset_dir.name}/")


if __name__ == "__main__":
    main()
