"""预览九宫格气泡在真实尺寸下的样子。

前端用的是 CSS border-image，这里用同一套切边与厚度在 Python 里重算一遍，
好让「改切边前先看一眼」这件事不依赖浏览器。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_sprites as bs  # noqa: E402

ROOT = bs.ROOT
UI = ROOT / "assets" / "ui"


def nine_slice(src: Image.Image, slice_px: dict, border: dict, w: int, h: int) -> Image.Image:
    """按 CSS border-image 的规则重绘：四角固定（缩放到 border 尺寸）、四边单向拉伸、中心填充。"""
    s = src
    L, R, T, B = slice_px["left"], slice_px["right"], slice_px["top"], slice_px["bottom"]
    bl, br, bt, bb = border["left"], border["right"], border["top"], border["bottom"]
    sw, sh = s.size
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    mid_w = max(1, w - bl - br)
    mid_h = max(1, h - bt - bb)
    src_mid_w = max(1, sw - L - R)
    src_mid_h = max(1, sh - T - B)

    def piece(box, size):
        return s.crop(box).resize(size, Image.LANCZOS)

    # 四角
    out.paste(piece((0, 0, L, T), (bl, bt)), (0, 0))
    out.paste(piece((sw - R, 0, sw, T), (br, bt)), (w - br, 0))
    out.paste(piece((0, sh - B, L, sh), (bl, bb)), (0, h - bb))
    out.paste(piece((sw - R, sh - B, sw, sh), (br, bb)), (w - br, h - bb))
    # 四边
    out.paste(piece((L, 0, sw - R, T), (mid_w, bt)), (bl, 0))
    out.paste(piece((L, sh - B, sw - R, sh), (mid_w, bb)), (bl, h - bb))
    out.paste(piece((0, T, L, sh - B), (bl, mid_h)), (0, bt))
    out.paste(piece((sw - R, T, sw, sh - B), (br, mid_h)), (w - br, bt))
    # 中心
    out.paste(piece((L, T, sw - R, sh - B), (mid_w, mid_h)), (bl, bt))
    return out


def main() -> int:
    meta = json.loads((UI / "bubble.json").read_text(encoding="utf-8"))
    with Image.open(UI / "bubble.png") as im:
        src = im.convert("RGBA")
    print(f"气泡素材 {src.size[0]}x{src.size[1]}  切边={meta['slice']}  渲染厚度={meta['border']}")

    samples = [
        ("完成 / 这一轮改完了", "#1b1d22"),
        ("需要你批准：要执行 git push", "#14663a"),
        ("出错了：命令返回非零退出码", "#8c2a20"),
        ("DSH 和 Codex 都在等你", "#1b1d22"),
    ]
    W = 210
    rows = []
    font_title = bs.load_font(13)
    font_text = bs.load_font(12)
    for text, color in samples:
        # 高度按文字行数估：这里就单行 + 标题，共 34px 内容
        content_h = 34
        h = meta["border"]["top"] + content_h + meta["border"]["bottom"]
        canvas = Image.new("RGBA", (W, h), (0, 0, 0, 0))
        frame = nine_slice(src, meta["slice"], meta["border"], W, h)
        canvas.alpha_composite(frame)
        d = ImageDraw.Draw(canvas)
        d.text((meta["border"]["left"] + 2, meta["border"]["top"] - 2), text,
               font=font_text, fill=color)
        rows.append(canvas)

    pad = 8
    sheet = Image.new("RGB", (W + pad * 2, sum(r.height + pad for r in rows) + pad), (232, 232, 234))
    y = pad
    for r in rows:
        sheet.paste(r, (pad, y), r)
        y += r.height + pad
    out = ROOT / "assets" / "preview" / "bubble_preview.png"
    sheet.save(out)
    print(f"预览（模拟前端九宫格渲染）: {out}  {sheet.size[0]}x{sheet.size[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
