"""通用视频预览：把任意视频均匀抽帧拼成一张总览图。

用法：python tools/preview_video.py "avatar_baseline/xxx.mp4" [帧数] [每格像素]
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_sprites as bs  # noqa: E402

from PIL import Image, ImageDraw  # noqa: E402


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    raw_path = Path(sys.argv[1])
    src = raw_path if raw_path.is_absolute() else bs.ROOT / raw_path
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 24
    thumb = int(sys.argv[3]) if len(sys.argv) > 3 else 150
    if not src.exists():
        print(f"找不到 {src}")
        return 1

    ffmpeg = bs.find_ffmpeg()
    frames = bs.extract_frames(ffmpeg, src, bs.ROOT / "assets" / "_raw" / f"preview_{src.stem}")
    total = len(frames)
    picks = [round(i * (total - 1) / (count - 1)) for i in range(count)]

    cols = min(8, count)
    rows = (count + cols - 1) // cols
    pad, band = 4, 18
    sheet = Image.new("RGB", (cols * (thumb + pad) + pad, rows * (thumb + pad + band) + pad),
                      (245, 245, 247))
    d = ImageDraw.Draw(sheet)
    font = bs.load_font(13)
    for i, pi in enumerate(picks):
        r, c = divmod(i, cols)
        x = pad + c * (thumb + pad)
        y = pad + r * (thumb + pad + band)
        with Image.open(frames[pi]) as im:
            tile = im.convert("RGB").resize((thumb, thumb), Image.LANCZOS)
        sheet.paste(tile, (x, y + band))
        d.text((x + 2, y + 1), f"#{pi} ({pi / max(1, total - 1) * 100:.0f}%)", font=font,
               fill=(20, 20, 30))
    out = bs.ROOT / "assets" / "preview" / f"video_{src.stem[:24]}.png"
    sheet.save(out)
    print(f"{src.name}: 共 {total} 帧 → {out}")
    print(f"  {sheet.size[0]}x{sheet.size[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
