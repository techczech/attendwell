"""Builds the App Store icon: AppIcon-1024.png with no alpha channel.

The desktop icon is a rounded tile on a transparent margin. iOS masks the icon
itself, so the tile is cropped to its bounds, scaled to fill the square, and the
rounded corners are filled with the tile's own background gradient (diagonal,
sampled from the tile) before the alpha channel is dropped.
Usage: python3 -I make-appstore-icon.py <desktop 1024x1024.png> <output.png>
"""
import sys
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGBA")
box = im.getchannel("A").getbbox()
tile = im.crop(box).resize((1024, 1024), Image.LANCZOS)
x0, y0, x1, _ = box
scale = (x1 - x0) / 1024
# Gradient depends on x + y; sample it inside the tile, away from the glyph.
a, b = (300, 200), (870, 870)
ca, cb = im.getpixel(a)[:3], im.getpixel(b)[:3]
sa, sb = sum(a), sum(b)
bg = Image.new("RGB", (1024, 1024))
px = bg.load()
for v in range(1024):
    for u in range(1024):
        s = (x0 + u * scale) + (y0 + v * scale)
        t = (s - sa) / (sb - sa)
        px[u, v] = tuple(max(0, min(255, round(ca[i] + (cb[i] - ca[i]) * t))) for i in range(3))
bg.paste(tile, (0, 0), tile)
bg.save(out, "PNG")
