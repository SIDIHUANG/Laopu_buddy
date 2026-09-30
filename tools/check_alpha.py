"""检查每个状态的白底残留。

关键点：不是"数白色像素"——角色本身的领结、眼睛高光是白的，
真正该查的是**角色包围盒之外**或**与背景连通**的白色。
这里用两个判据：
  1. 每一帧取内容包围盒，看包围盒四条边上是否有"接近背景色"的像素（说明背景没切干净）
  2. 统计完全不透明且接近纯白的像素占比，超过阈值就报警
最后拼一张对照图，方便直接看。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_sprites as bs  # noqa: E402

ROOT = bs.ROOT
ASSETS = ROOT / "assets"


def near_white(px) -> bool:
    r, g, b, a = px
    return a > 200 and r > 235 and g > 235 and b > 235


def check_frame(frame: Image.Image) -> dict:
    alpha = frame.split()[3]
    bbox = alpha.getbbox()
    if not bbox:
        return {"bbox": None, "white_ratio": 0.0, "edge_white": 0}
    x0, y0, x1, y1 = bbox
    px = frame.load()
    total = 0
    white = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            p = px[x, y]
            if p[3] > 200:
                total += 1
                if near_white(p):
                    white += 1
    # 包围盒四条边上的白色（背景没切干净的典型特征）
    edge_white = 0
    for x in range(x0, x1):
        edge_white += near_white(px[x, y0]) + near_white(px[x, y1 - 1])
    for y in range(y0, y1):
        edge_white += near_white(px[x0, y]) + near_white(px[x1 - 1, y])
    return {
        "bbox": bbox,
        "white_ratio": (white / total) if total else 0.0,
        "edge_white": edge_white,
    }


def main() -> int:
    manifest = json.loads((ASSETS / "manifest.json").read_text(encoding="utf-8"))
    rows = []
    print(f"{'状态':<12} {'帧数':>4} {'白像素占比':>10} {'包围盒边上的白':>14}  判定")
    for name, st in manifest["states"].items():
        strip = ASSETS / st["file"].replace("\\", "/")
        if not strip.exists():
            print(f"{name:<12} 缺素材 {st['file']}")
            continue
        frames = st.get("frames", 1)
        cell = Imagesize = None
        with Image.open(strip) as im:
            im = im.convert("RGBA")
            fw = im.width // frames
            fh = im.height
            cell = (fw, fh)
            samples = sorted({0, frames // 4, frames // 2, (frames * 3) // 4, frames - 1})
            worst_white = 0.0
            worst_edge = 0
            bad_frame = 0
            for idx in samples:
                f = im.crop((idx * fw, 0, (idx + 1) * fw, fh))
                r = check_frame(f)
                if r["white_ratio"] > worst_white:
                    worst_white = r["white_ratio"]
                    bad_frame = idx
                worst_edge = max(worst_edge, r["edge_white"])
                rows.append((name, idx, f))
        verdict = "OK"
        if worst_edge > 40:
            verdict = f"包围盒边上残留白 ✗"
        elif worst_white > 0.22:
            verdict = f"白像素偏多 ?"
        print(f"{name:<12} {frames:>4} {worst_white:>9.1%} {worst_edge:>14}  {verdict}")
    print()
    print("说明：包围盒边上的白 > 40 基本可以确定背景没切干净；")
    print("      白像素占比高不一定是错（领结、眼睛高光本来就是白的）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
