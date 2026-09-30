"""Measure the real on-screen geometry of every sprite strip.

Why this exists: the pet window's size and the character's anchor were both
derived from the *cell* box (256 px), not from the pixels the character
actually occupies. That mismatch is what pushed the character below the
window's bottom edge on some machines. This script prints the numbers the
layout must be based on:

  content_bbox   : bounding box of non-transparent pixels, in cell units
  visible_ratio  : content height / cell   (how much of the cell is character)
  bottom_gap     : empty rows below the character inside the cell

Run:  python tools/measure_sprites.py
"""
import io
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "app", "dist", "assets", "manifest.json")
STATES_DIR = os.path.join(ROOT, "app", "dist", "assets", "states")


def alpha_bbox(path, cell):
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    frames = max(1, round(w / cell))
    boxes = []
    for i in range(frames):
        f = img.crop((i * cell, 0, (i + 1) * cell, min(h, cell)))
        bb = f.split()[3].getbbox()
        boxes.append(bb)
    return frames, boxes


def main():
    with io.open(MANIFEST, encoding="utf-8") as fh:
        manifest = json.load(fh)
    cell = manifest["cell"]
    print(f"cell = {cell}")
    print(f"{'state':<12} {'frames':>6} {'bbox(x0,y0,x1,y1)':<28} {'h/cell':>7} {'w/cell':>7} "
          f"{'bottom_gap':>10} {'head_gap':>9}")
    rows = []
    for name, info in manifest["states"].items():
        path = os.path.join(STATES_DIR, info["file"])
        if not os.path.exists(path):
            print(f"{name:<12} MISSING {info['file']}")
            continue
        frames, boxes = alpha_bbox(path, cell)
        boxes = [b for b in boxes if b]
        if not boxes:
            print(f"{name:<12} fully transparent!")
            continue
        x0 = min(b[0] for b in boxes)
        y0 = min(b[1] for b in boxes)
        x1 = max(b[2] for b in boxes)
        y1 = max(b[3] for b in boxes)
        h_ratio = (y1 - y0) / cell
        w_ratio = (x1 - x0) / cell
        bottom_gap = (cell - y1) / cell
        head_gap = y0 / cell
        rows.append(dict(state=name, frames=frames, bbox=[x0, y0, x1, y1],
                         h_ratio=round(h_ratio, 4), w_ratio=round(w_ratio, 4),
                         bottom_gap=round(bottom_gap, 4), head_gap=round(head_gap, 4),
                         on_screen_px=info.get("on_screen_px")))
        print(f"{name:<12} {frames:>6} {str([x0, y0, x1, y1]):<28} {h_ratio:>7.3f} "
              f"{w_ratio:>7.3f} {bottom_gap:>10.3f} {head_gap:>9.3f}")

    if rows:
        mx = max(rows, key=lambda r: r["h_ratio"])
        mn = min(rows, key=lambda r: r["bottom_gap"])
        print()
        print(f"max content height ratio = {mx['h_ratio']:.3f}  ({mx['state']})")
        print(f"min bottom gap ratio     = {mn['bottom_gap']:.3f}  ({mn['state']})")
        print()
        print("=> a layer of size S shows the character as S * h_ratio tall,")
        print("   sitting S * bottom_gap above the layer's bottom edge.")

    out = os.path.join(ROOT, "runtime", "sprite-metrics.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with io.open(out, "w", encoding="utf-8") as fh:
        json.dump(dict(cell=cell, states=rows), fh, ensure_ascii=False, indent=2)
    print(f"\nwrote {out}")


if __name__ == "__main__":
    sys.exit(main())
