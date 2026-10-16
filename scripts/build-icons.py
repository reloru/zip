"""Draws every app icon from the art below and inlines the touch icon into index.html.

Regenerate, never hand-edit the PNGs:  python3 scripts/build-icons.py   (needs Pillow)
Every output is an opaque RGB PNG; no icon is an SVG.
"""
import base64
import io
import pathlib
import re

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
HTML = ROOT / "index.html"

BLUE = (0x2F, 0x6F, 0xDF)
DARK_BLUE = (0x1D, 0x4F, 0xAE)
WHITE = (0xFF, 0xFF, 0xFF)
SUPERSAMPLE = 8

# Art on a 512 x 512 canvas: (x, y, width, height, corner radius, colour), drawn in order.
ART = [(236, 80, 40, 230, 8, DARK_BLUE)]
ART += [(212 if i % 2 == 0 else 256, 88 + i * 24, 44, 16, 5, WHITE) for i in range(9)]
ART += [(206, 300, 100, 132, 26, WHITE), (236, 340, 40, 56, 14, BLUE)]

# name: (pixel size, art scale around the centre). 0.8 keeps the art inside the maskable safe zone;
# 1.25 makes the art legible at tab-icon sizes.
OUTPUTS = {
    "favicon-16.png": (16, 1.25),
    "favicon-32.png": (32, 1.25),
    "icon-192.png": (192, 1.0),
    "icon-512.png": (512, 1.0),
    "icon-maskable-512.png": (512, 0.8),
    "apple-touch-icon.png": (180, 0.8),
    "og-image.png": (512, 0.8),
}


def render(size, scale):
    big = size * SUPERSAMPLE
    image = Image.new("RGB", (big, big), BLUE)
    draw = ImageDraw.Draw(image)
    unit = big / 512
    offset = 256 * (1 - scale)
    for x, y, w, h, r, colour in ART:
        x0 = (offset + x * scale) * unit
        y0 = (offset + y * scale) * unit
        draw.rounded_rectangle(
            (x0, y0, x0 + w * scale * unit, y0 + h * scale * unit),
            radius=r * scale * unit,
            fill=colour,
        )
    return image.resize((size, size), Image.LANCZOS)


def png_bytes(image):
    buf = io.BytesIO()
    image.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def main():
    ICONS.mkdir(exist_ok=True)
    data = {}
    for name, (size, scale) in OUTPUTS.items():
        data[name] = png_bytes(render(size, scale))
        if name != "apple-touch-icon.png":
            (ICONS / name).write_bytes(data[name])
        print(f"{name}: {size}x{size}, {len(data[name])} bytes")

    uri = "data:image/png;base64," + base64.b64encode(data["apple-touch-icon.png"]).decode()
    html = HTML.read_text(encoding="utf-8")
    pattern = r'(<link rel="apple-touch-icon" sizes="180x180" href=")[^"]*(")'
    updated, count = re.subn(pattern, lambda m: m.group(1) + uri + m.group(2), html)
    if count != 1:
        raise SystemExit("index.html must contain exactly one apple-touch-icon link with sizes=\"180x180\"")
    HTML.write_text(updated, encoding="utf-8")
    print(f"index.html: inlined apple-touch-icon ({len(uri)} characters)")


if __name__ == "__main__":
    main()
