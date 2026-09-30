"""UI 素材预处理：把「通知对话气泡」做成前端可用的九宫格气泡框。

为什么用九宫格：气泡框必须能随文字长短自由伸缩，但描边和尾巴不能跟着拉伸变形。
九宫格把图切成 3x3，四角固定、四边单向拉伸、中心填充 —— 正好满足。

切边（insets）不靠手填：沿中轴扫描，从画布边缘向内找到「不再是深色描边」的位置，
就是内边界。底部扫描会先撞到尾巴，于是下切边自然会大一些 —— 这正是我们要的，
尾巴才会留在下方切片里、不被横向拉伸。

产出：assets/ui/bubble.png（已去水印、去白底）+ assets/ui/bubble.json（切边元数据）
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_sprites as bs  # noqa: E402

ROOT = bs.ROOT
OUT_DIR = ROOT / "assets" / "ui"

# 候选素材名（自动发现，用户改文件名也能认出来）
CANDIDATES = ["通知对话气泡", "气泡", "bubble", "对话框"]

# 描边判定：低于这个亮度算「深色描边」
STROKE_LUM = 96
# 九宫格切边的最小占比：必须覆盖圆角，否则四角会被拉伸变形。
# 这条兜底很关键——单条扫描线很容易在描边的高光/纹理处提前停下（实测左右只量到 13px）。
#
# 两个方向用不同占比，原因见下：素材是一个近似圆形的气泡，尾巴在偏左位置。
# 如果左右切边取到 30%+，尾巴会横跨「左下角切片」和「中段拉伸区」，
# 结果两端都会长出一个尖角。把左右收窄到 20%，尾巴就整体落在中段里、
# 随宽度一起拉伸（宽尾巴是常见画法），四角也不会被拉歪。
MIN_INSET_FRAC_V = 0.34
MIN_INSET_FRAC_H = 0.20
MAX_INSET_FRAC_H = 0.22


def scan_insets(alpha: np.ndarray, rgb: np.ndarray, bbox: tuple) -> dict:
    """量四边描边厚度（源图像素）。

    用多条扫描线取中位数，而不是只看中轴一条：手绘描边有高光和纹理，
    单条线很容易在亮处提前停下，量出来的切边会小得离谱、四角就被拉伸了。
    """
    x0, y0, x1, y1 = bbox
    lum = rgb.mean(axis=2)
    solid = alpha > 128
    w, h = x1 - x0, y1 - y0

    def thickness(axis: str, reverse: bool) -> int:
        found = []
        for t in np.linspace(0.15, 0.85, 25):
            if axis == "y":
                x = int(x0 + t * (w - 1))
                rng = range(h)
            else:
                y = int(y0 + t * (h - 1))
                rng = range(w)
            limit = h if axis == "y" else w
            for i in rng:
                idx = (limit - 1 - i) if reverse else i
                px = x if axis == "y" else (x0 + idx)
                py = (y0 + idx) if axis == "y" else y
                if solid[py, px] and lum[py, px] > STROKE_LUM:
                    found.append(i)
                    break
        return int(np.median(found)) if found else 0

    measured = {
        "top": thickness("y", False),
        "bottom": thickness("y", True),
        "left": thickness("x", False),
        "right": thickness("x", True),
    }
    # 兜底：至少要覆盖圆角；左右还要设上限，避免把尾巴切进角里
    floor_v = round(h * MIN_INSET_FRAC_V)
    floor_h = round(w * MIN_INSET_FRAC_H)
    ceil_h = round(w * MAX_INSET_FRAC_H)
    return {
        "top": max(measured["top"], floor_v),
        "bottom": max(measured["bottom"], floor_v),
        "left": min(max(measured["left"], floor_h), ceil_h),
        "right": min(max(measured["right"], floor_h), ceil_h),
        "measured": measured,
    }


def resolve_bubble() -> Path | None:
    for name in CANDIDATES:
        exact = bs.SRC_DIR / f"{name}.png"
        if exact.exists():
            return exact
    for p in sorted(bs.SRC_DIR.iterdir()):
        if p.suffix.lower() in bs.IMAGE_EXT and any(
                c.lower() in p.name.lower() for c in CANDIDATES):
            return p
    return None


def main() -> int:
    src = resolve_bubble()
    if src is None:
        print("没找到气泡素材。把图片放进 avatar_baseline/，文件名里带「气泡」或 bubble 即可。")
        return 1

    with Image.open(src) as im:
        print(f"素材: {src.name}  声明={src.suffix}  实际格式={im.format}  {im.size[0]}x{im.size[1]}")
        rgb = im.convert("RGB")

    cleaned, removed = bs.strip_watermark(rgb)
    print(f"  去水印像素: {removed}")

    rgba = bs.key_white(cleaned)
    alpha = np.asarray(rgba.split()[-1])
    bbox = rgba.split()[-1].getbbox()
    if bbox is None:
        print("抠像后没有内容")
        return 1
    print(f"  内容包围盒: {bbox}  →  {bbox[2]-bbox[0]}x{bbox[3]-bbox[1]}")

    arr = np.asarray(rgba)
    measured = scan_insets(alpha, arr[..., :3].astype(np.float32), bbox)
    raw_measured = measured.pop("measured")

    # 尾巴的水平中心（占图像宽度比例）——前端要靠它把尾巴对准角色头顶
    solid = alpha > 128
    x0, y0, x1, y1 = bbox
    bottoms = []
    for x in range(x0, x1):
        col = np.nonzero(solid[:, x])[0]
        bottoms.append(col[-1] if col.size else y0)
    bottoms = np.array(bottoms, dtype=float)
    body_bottom = float(np.median(bottoms))
    tail_cols = np.nonzero(bottoms > body_bottom + max(6, (y1 - y0) * 0.02))[0]
    if tail_cols.size:
        tail_center = float(tail_cols.mean()) + x0
        tail_ratio = round((tail_center - bbox[0]) / (bbox[2] - bbox[0]), 4)
    else:
        tail_ratio = 0.5  # 没测出尾巴就当作居中

    # 裁到内容并留 1px 透明边（border-image 对贴边切片更稳）
    pad = 2
    crop = rgba.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                      min(rgba.width, bbox[2] + pad), min(rgba.height, bbox[3] + pad)))
    insets = {k: v + pad for k, v in measured.items()}

    # 给文字再留一点内边距，避免字压到描边上
    for k in ("left", "right"):
        insets[k] += 6

    # 兜底：四边切片之和不能吃掉整张图
    insets = {
        "top": min(insets["top"], round(crop.height * 0.42)),
        "bottom": min(insets["bottom"], round(crop.height * 0.42)),
        "left": min(insets["left"], round(crop.width * 0.42)),
        "right": min(insets["right"], round(crop.width * 0.42)),
    }

    # 前端渲染时四角该画多厚：源切边是按「整张图」量的（三十多个百分点），
    # 直接等比缩到 200px 宽会把文字区挤没，所以渲染厚度单独给一组推荐值。
    suggested = {"top": 11, "right": 16, "bottom": 21, "left": 16}

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_png = OUT_DIR / "bubble.png"
    crop.save(out_png)

    meta = {
        "file": "ui/bubble.png",
        "source": src.name,
        "size": [crop.size[0], crop.size[1]],
        "slice": insets,          # border-image-slice 用的源图切边（像素）
        "border": suggested,      # border-image-width 用的渲染厚度（CSS px）
        "tailRatio": tail_ratio,  # 尾巴水平中心占宽度的比例（前端据此对准角色头顶）
        "measuredStroke": raw_measured,
        "note": "slice 按源图像素给 border-image-slice；border 是按宠物默认尺寸给的渲染厚度",
    }
    (OUT_DIR / "bubble.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"  实测描边(源图px): 上{raw_measured['top']} 右{raw_measured['right']} "
          f"下{raw_measured['bottom']} 左{raw_measured['left']}")
    print(f"  最终切边(源图px): 上{insets['top']} 右{insets['right']} "
          f"下{insets['bottom']} 左{insets['left']}")
    print(f"  中部拉伸区: {crop.width - insets['left'] - insets['right']}"
          f"x{crop.height - insets['top'] - insets['bottom']} (源图px)")
    print(f"  推荐渲染厚度: {suggested}")
    print(f"  尾巴水平中心: {tail_ratio:.3f}（占宽度比例，前端据此把尾巴对准角色头顶）")
    print(f"产出: {out_png}  {out_png.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
