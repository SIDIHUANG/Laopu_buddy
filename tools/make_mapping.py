"""从 v2 的 strip 产出决策材料。

  assets/preview/all_states_motion.png  8 状态各取 12 帧，一图看完真实动作
  assets/preview/ab_thinking.gif        thinking 用「往返」vs「正序循环」的接缝对照
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
PREVIEW = ASSETS / "preview"
FONTS = [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\consola.ttf"]


def font(size: int) -> ImageFont.FreeTypeFont:
    for p in FONTS:
        if Path(p).exists():
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                pass
    return ImageFont.load_default()


def load_strip(name: str, cell: int) -> list[Image.Image]:
    path = ASSETS / "states" / f"{name}.png"
    if not path.exists():
        return []
    im = Image.open(path).convert("RGBA")
    count = im.size[0] // cell
    return [im.crop((i * cell, 0, (i + 1) * cell, cell)) for i in range(count)]


def flat(im: Image.Image, size: int) -> Image.Image:
    bg = Image.new("RGB", (size, size), (232, 232, 234))
    bg.paste(im.resize((size, size), Image.LANCZOS) if im.size[0] != size else im, (0, 0))
    return bg


def main() -> int:
    meta = json.loads((ASSETS / "manifest.json").read_text(encoding="utf-8"))
    cell = meta["cell"]
    states: dict[str, dict] = meta["states"]

    # ---- 总览：每状态 12 帧 ----
    cols, thumb, pad, band = 12, 150, 5, 30
    order = list(states.keys())
    W = cols * (thumb + pad) + pad
    H = pad + len(order) * (thumb + pad + band)
    sheet = Image.new("RGB", (W, H), (250, 250, 252))
    d = ImageDraw.Draw(sheet)
    f = font(15)

    for r, name in enumerate(order):
        st = states[name]
        frames = load_strip(name, cell)
        if not frames:
            continue
        picks = [round(i * (len(frames) - 1) / (cols - 1)) for i in range(cols)]
        y = pad + r * (thumb + pad + band)
        d.text((pad, y + 5),
               f"{name}  [{st['kind']}/{st['mode']}]  {st['frames']}f @{st['fps']}fps "
               f"= {st['duration_s']}s  端点差={st['endpoint_diff']}  {st['desc']}",
               font=f, fill=(20, 20, 30))
        for c, pi in enumerate(picks):
            sheet.paste(flat(frames[pi], thumb), (pad + c * (thumb + pad), y + band))
    sheet.save(PREVIEW / "all_states_motion.png")
    print(f"all_states_motion.png {sheet.size[0]}x{sheet.size[1]}")

    # ---- thinking 接缝对照：pingpong vs loop ----
    name = "thinking"
    if name in states:
        frames = load_strip(name, cell)
        n = len(frames)
        head = 42
        f_tag = font(19)
        out = []
        # 上排 pingpong（正+反），下排 loop（正序，展示接缝跳变）
        seq_pp = list(range(n)) + list(range(n - 2, 0, -1))
        seq_lp = list(range(n)) + list(range(n))
        for k in range(n):
            canvas = Image.new("RGB", (cell * 2 + 16, head + cell), (250, 250, 252))
            dd = ImageDraw.Draw(canvas)
            dd.rectangle([0, 0, cell, head], fill=(30, 110, 60))
            dd.rectangle([cell + 16, 0, cell * 2 + 16, head], fill=(190, 90, 30))
            dd.text((10, 10), "A  pingpong 往复（无缝）", font=f_tag, fill=(255, 255, 255))
            dd.text((cell + 26, 10), "B  loop 正序（接缝跳变）", font=f_tag, fill=(255, 255, 255))
            a = flat(frames[k], cell)
            b = flat(frames[k], cell)
            canvas.paste(a, (0, head))
            canvas.paste(b, (cell + 16, head))
            dd.text((10, head + cell - 20), f"frame {k:02d}/{n}", font=font(14), fill=(90, 90, 100))
            out.append(canvas.convert("P", palette=Image.ADAPTIVE, colors=255))
        # 实际用 pingpong 序列做成动画，loop 序列在 seam 处会看到跳
        out_pp = []
        for idx in seq_pp[: 2 * n]:
            canvas = Image.new("RGB", (cell, cell), (232, 232, 234))
            canvas.paste(flat(frames[idx % n], cell), (0, 0))
            out_pp.append(canvas.convert("P", palette=Image.ADAPTIVE, colors=255))
        out_pp[0].save(PREVIEW / "thinking_pingpong.gif", save_all=True,
                       append_images=out_pp[1:], duration=83, loop=0, disposal=2)
        print(f"thinking_pingpong.gif  {len(out_pp)} frames（含回程）")

    return 0


if __name__ == "__main__":
    sys.exit(main())
