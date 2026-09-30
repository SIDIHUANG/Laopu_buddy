"""诊断：我的抽帧到底取到了视频的哪一段？

怀疑点：build_sprites 的 pick_loop_window 会挑「首尾最像」的窗口来闭合循环，
如果原视频本身是「站立 → 睡着」这种单向变化，最小化端点差就会挑到**几乎不动的那一段**，
于是抽出来的 16 帧看起来像张固定图。

本脚本：
  1. 打印每段视频被选中的窗口位置与覆盖率
  2. 打印逐帧运动量曲线，客观显示「动作发生在视频的哪一段」
  3. 输出整段视频的 24 帧总览图，用眼睛验证
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_sprites as bs  # noqa: E402

ROOT = bs.ROOT
PREVIEW = ROOT / "assets" / "preview"
RAW = ROOT / "assets" / "_raw"

VIDEOS = [
    ("main待机.mp4", "main idle"),
    ("curious转头.mp4", "curious head-turn"),
    ("sleep长时间待机.mp4", "sleep stand->sleep"),
]

FONT_PATHS = [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\consola.ttf"]


def font(size: int) -> ImageFont.FreeTypeFont:
    for p in FONT_PATHS:
        if Path(p).exists():
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                pass
    return ImageFont.load_default()


def main() -> int:
    ffmpeg = bs.find_ffmpeg()
    PREVIEW.mkdir(parents=True, exist_ok=True)
    n = 16
    cols, thumb, pad, head = 24, 132, 4, 26

    print(f"{'video':<26} {'总帧':>5} {'选中窗口':>12} {'覆盖时长':>9} {'窗口内运动':>10} {'全片运动':>9}")
    print("-" * 82)

    rows: list[tuple[str, list[Image.Image]]] = []
    for fname, label in VIDEOS:
        src = bs.SRC_DIR / fname
        if not src.exists():
            print(f"{fname}: 缺失")
            continue
        raw = bs.extract_frames(ffmpeg, src, RAW / f"diag_{label.split()[0]}")
        m = len(raw)

        thumbs = []
        for f in raw:
            with Image.open(f) as im:
                thumbs.append(
                    np.asarray(im.convert("L").resize((64, 64), Image.BILINEAR), dtype=np.float32)
                )
        arr = np.stack(thumbs)

        # 逐帧运动量
        diff = np.abs(np.diff(arr, axis=0)).mean(axis=(1, 2))
        idx, endpoint = bs.pick_loop_window(raw, n, 256)
        start, end = idx[0], idx[-1]

        fps = 24.0
        print(
            f"{fname:<26} {m:>5} {f'{start:>3}-{end:<3}':>12} "
            f"{(end - start + 1) / fps:>8.2f}s "
            f"{diff[start:end].mean():>10.3f} {diff.mean():>9.3f}"
        )
        rows.append(
            (
                f"{fname}  选中窗口={start}-{end} / 共 {m} 帧  "
                f"(窗口内运动={diff[start:end].mean():.3f} vs 全片均值={diff.mean():.3f})",
                [
                    Image.open(raw[pi]).convert("RGB")
                    for pi in [round(i * (m - 1) / (cols - 1)) for i in range(cols)]
                ],
            )
        )

    # 整段总览：每段视频均匀取 24 帧
    W = cols * (thumb + pad) + pad
    H = head + len(rows) * (thumb + head + pad) + pad
    sheet = Image.new("RGB", (W, H), (250, 250, 252))
    d = ImageDraw.Draw(sheet)
    f = font(15)

    for r, (label, frames) in enumerate(rows):
        y0 = head + r * (thumb + head + pad)
        d.text((pad, y0 + 4), label, font=f, fill=(20, 20, 30))
        for c, im in enumerate(frames):
            sheet.paste(im.resize((thumb, thumb), Image.LANCZOS),
                        (pad + c * (thumb + pad), y0 + head))

    sheet.save(PREVIEW / "fullclip_motion.png")
    print(f"\n整段总览: {PREVIEW / 'fullclip_motion.png'}  {sheet.size[0]}x{sheet.size[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
