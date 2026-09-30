"""从角色立绘生成 Tauri 应用图标（透明背景）。

tauri-build 在 Windows 上要求 icons/icon.ico 存在，否则构建失败。
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_sprites as bs  # noqa: E402

ROOT = bs.ROOT
OUT = ROOT / "app" / "src-tauri" / "icons"


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    with Image.open(bs.SRC_DIR / "main.png") as im:
        cleaned, _ = bs.strip_watermark(im.convert("RGB"))
    rgba = bs.key_white(cleaned)

    bbox = rgba.split()[-1].getbbox()
    if bbox is None:
        print("抠像后没有内容")
        return 1
    ref = bs.compute_ref([bbox], 512, 0.08)
    ref["ref_cx"] = (bbox[0] + bbox[2]) / 2
    ref["ref_bottom"] = bbox[3]
    icon = bs.place(rgba, bbox, 512, ref, 0.08, "fixed")

    icon.save(OUT / "icon.png")
    icon.resize((128, 128), Image.LANCZOS).save(OUT / "128x128.png")
    icon.resize((32, 32), Image.LANCZOS).save(OUT / "32x32.png")
    icon.save(OUT / "icon.ico",
              sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    for f in sorted(OUT.iterdir()):
        print(f"  {f.name}  {f.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
