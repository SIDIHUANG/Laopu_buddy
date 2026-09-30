"""普瑞塞斯桌宠 · 素材管线 v2

v1 的两个 bug（已修）：
  1. 只取 16 帧**连续窗口** = 0.67s，丢掉了 5.04s 视频里 87% 的内容。
  2. 「循环闭合」优化挑首尾最像的窗口 → 系统性选中**最不动的 0.67 秒**
     （sleep 段只保留 6% 的运动量，等于抽了张固定图）。

v2 的做法：
  - 按 span 均匀采样**整段**（或指定区间），不再挑窗口。
  - 每个状态独立配置 帧数 / 帧率 / 播放语义（loop | once）。
  - 输出**每状态一条 strip**，不再合成巨幅 atlas；渲染端按状态懒加载。

阶段：抽帧 → 去水印 → 抠白底 → 统一缩放定位 → 程序化动画 → 输出
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "avatar_baseline"

FFMPEG_CANDIDATES = [
    os.environ.get("PRESAGE_FFMPEG", ""),
    shutil.which("ffmpeg") or "",
    r"C:\Users\Asus\AppData\Local\JianyingPro\Apps\10.1.0.13849\ffmpeg.exe",
]

# name, kind, 源文件（可给多个候选名/通配，命中第一个存在的）, 播放语义, 帧数, 帧率, span, 语义说明
# mode: loop=正序循环 | pingpong=往复播放（往复运动天然无缝，见 endpoint_diff）| once=播完停住
#
# 「working」与「celebrate_happy」是**预留位**：素材还没生成，管线会自动跳过并在日志里说明。
# 把文件（名字里带 work/忙碌/键盘，或 happy/开心/笑）丢进 avatar_baseline/ 后重跑即可，
# 不需要改任何代码。
STATE_CONFIG = [
    ("idle",       "video", "main待机.mp4",         "pingpong", 32, 12, (0.0, 1.0),
     "待机：两个 Agent 都空闲（上下浮动）"),
    ("thinking",   "video", "curious转头.mp4",      "pingpong", 40, 12, (0.0, 1.0),
     "思考中：回合已开始、未出工具调用（左右摇头）"),
    # working：这段素材是**一个完整动作**——拿出电脑 → 摆好 → 开始打字。
    # 用户要求「每次切到 working 都要重播这个动作」，所以不能整段循环：
    #   span (0,0.36) 一次性播完（拿出电脑） → tail (0.40,0.86) 打字循环
    # 由 TAILS 声明尾段，模式自动变成 once_loop，manifest 里给出 loopFrom。
    ("working",    "video", ["工作中的视频_main", "work", "工作", "键盘"], "once_loop", 44, 12, (0.0, 0.36),
     "工作中：拿出电脑 → 开始打字（一次性动作 + 尾部循环）"),
    ("waiting",    "still", "waiting.png",          "loop", 20, 12, None,
     "等待输入或审批（最高优先级）"),
    ("error",      "still", "sad.png",              "loop", 20, 12, None,
     "出错 / 失败"),
    ("celebrate",  "proc",  "main.png",             "once", 16, 12, None,
     "完成庆祝：弹跳 + squash，播完停住"),
    ("celebrate_happy", "still", ["happy", "开心", "笑", "smile"], "once", 16, 12, None,
     "完成（笑脸版，预留位，等素材）"),
    ("doze",       "video", "sleep长时间待机.mp4",   "once", 60, 12, (0.0, 1.0),
     "进入休眠：站立 → 趴下 → 闭眼（一次性过渡）"),
    ("sleep",      "video", "sleep长时间待机.mp4",   "pingpong", 20, 10, (0.78, 1.0),
     "熟睡：躺着打呼，Zzz 飘动（循环）"),
    ("sleep_idle", "still", "sleep.png",            "loop", 16, 12, None,
     "静态睡姿（备选，若不需要熟睡循环可用它）"),
    # 探头：从底部边框后面探出来看一眼再缩回去（一次性）。
    # 源素材是 1280x720 宽画幅，角色只在中间，所以靠 CROPS 先裁、靠 ANCHOR_OVERRIDE 换归一化。
    ("peek",       "video", ["探头", "peek"],       "once", 60, 12, (0.0, 1.0),
     "探头：从底部边框后探出来看一眼再缩回去（特殊边框互动）"),
    ("peek_right", "video", "右侧边框附件探头",      "once", 60, 12, (0.0, 1.0),
     "右侧探头：从右侧边框滑入看一眼再滑出"),
    ("peek_left",  "video", "右侧边框附件探头",      "once", 60, 12, (0.0, 1.0),
     "左侧探头：右侧素材水平镜像，不额外占素材"),
]

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}

# 逐状态裁剪：源画幅里角色只占一小块时（例如 1280x720 的「探头」素材，
# 角色只在中间 40%、其余是横贯全宽的边框线），先裁到角色附近再走正常流程。
# 值是占源画幅的比例 (left, top, right, bottom)。
CROPS: dict[str, tuple[float, float, float, float]] = {
    "peek": (0.26, 0.0, 0.76, 1.0),          # 底部探头：角色在中间
    "peek_right": (0.16, 0.02, 0.58, 1.0),   # 右侧探头：角色+竖线在左半边
}

# 逐状态镜像：一份素材反过来就是另一侧，不用再生成一版。
# 注意必须在去水印之后做 —— 水印定位是按原图右下角算的。
FLIPS: dict[str, str] = {
    "peek_left": "h",
}

# 镜像状态继承被镜像状态的裁剪参数（否则会拿整张宽画幅去归一化，尺寸对不上）
MIRROR_OF: dict[str, str] = {
    "peek_left": "peek_right",
}

# 逐状态覆盖归一化方式：frame 适合「角色几乎占满画幅」的素材，
# 而裁剪过的素材用 stabilize（按内容包围盒）更合适。
ANCHOR_OVERRIDE: dict[str, str] = {
    "peek": "stabilize",
    "peek_right": "stabilize",
    "peek_left": "stabilize",
}

# 尾段循环声明：状态名 -> {span, frames}
# 用于「一次性动作 + 尾部循环」的素材（动作播完停在循环里，而不是整段重复）
TAILS: dict[str, dict] = {
    "working": {"span": (0.40, 0.86), "frames": 56},
}


def resolve_src(candidates: str | list[str], kind: str) -> Path | None:
    """把候选名解析成实际文件。字符串 = 精确文件名；列表 = 依次尝试
    ①精确文件名 ②文件名包含该关键词（自动发现用户后来补的素材）。"""
    exts = VIDEO_EXT if kind == "video" else IMAGE_EXT
    names = [candidates] if isinstance(candidates, str) else list(candidates)
    all_files = [p for p in sorted(SRC_DIR.iterdir()) if p.is_file() and p.suffix.lower() in exts]

    for n in names:
        exact = SRC_DIR / n
        if exact.exists():
            return exact
    for n in names:
        if (SRC_DIR / n).exists():
            continue
        low = n.lower()
        for p in all_files:
            if low in p.name.lower():
                return p
    return None


# 静止立绘的程序化微动参数：呼吸幅度 / 倾斜角度 / 横向摆动px
# 第一版幅度太小，预览里几乎看不出在动 —— 静态状态必须靠动作模式与 idle 区分开。
STILL_MOTION = {
    "waiting":        {"breathe": 0.030, "tilt": 2.0, "sway": 6.0},
    "error":          {"breathe": 0.020, "tilt": -1.5, "sway": 1.5},
    "sleep_idle":     {"breathe": 0.014, "tilt": 0.0, "sway": 0.0},
    "celebrate_happy": {"breathe": 0.028, "tilt": 0.0, "sway": 4.0},
}

# 逐状态的整体缩放微调（1.0 = 不改）。
#
# 为什么要手调：anchor=frame 已经把所有状态按**素材画幅**统一了缩放，
# 因此各状态的角色大小基本一致（实测约 220px）。但源素材里有少数几张
# 本身就是**放大过的构图**（典型是 sleep.png：躺姿被放大到铺满画幅），
# 这种情况下任何几何归一化都消不掉，只能给一个手调系数。
SCALE_TWEAK: dict[str, float] = {
    "sleep_idle": 0.82,
    "sleep": 0.90,
    # 探头素材裁过、角色占比更大，按占屏尺寸回压到跟站姿一致（约 212px）
    "peek": 0.91,
    "peek_right": 0.91,
    "peek_left": 0.91,
}

FONT_CANDIDATES = [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\consola.ttf"]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for c in FONT_CANDIDATES:
        if Path(c).exists():
            try:
                return ImageFont.truetype(c, size)
            except OSError:
                continue
    return ImageFont.load_default()


# --------------------------------------------------------------------------- #
# 抽帧
# --------------------------------------------------------------------------- #
def find_ffmpeg() -> str:
    for cand in FFMPEG_CANDIDATES:
        if cand and Path(cand).exists():
            return cand
    raise SystemExit("找不到 ffmpeg。设 PRESAGE_FFMPEG 或放进 PATH。")


def extract_frames(ffmpeg: str, video: Path, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    existing = sorted(out_dir.glob("*.png"))
    if existing:
        return existing
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
           "-vsync", "0", "-an", str(out_dir / "%04d.png")]
    subprocess.run(cmd, check=True)
    frames = sorted(out_dir.glob("*.png"))
    if not frames:
        raise SystemExit(f"抽帧失败：{video}")
    return frames


def sample_indices(total: int, count: int, span: tuple[float, float] | None) -> list[int]:
    """在 span 指定的区间内**均匀**取 count 帧。span=None 表示整段。"""
    lo, hi = span or (0.0, 1.0)
    a = int(round(lo * (total - 1)))
    b = int(round(hi * (total - 1)))
    if b <= a:
        b = min(total - 1, a + 1)
    return list(np.linspace(a, b, count).round().astype(int))


# --------------------------------------------------------------------------- #
# 去水印 / 抠白底
# --------------------------------------------------------------------------- #
def strip_watermark(im: Image.Image, x0f: float = 0.70, y0f: float = 0.86,
                    lum_min: int = 140, sat_max: int = 40) -> tuple[Image.Image, int]:
    arr = np.asarray(im.convert("RGB"), dtype=np.int16).copy()
    h, w = arr.shape[:2]
    y0, x0 = int(h * y0f), int(w * x0f)
    reg = arr[y0:, x0:]
    lum = reg.mean(axis=2)
    sat = reg.max(axis=2) - reg.min(axis=2)
    mask = (lum > lum_min) & (sat < sat_max)
    reg[mask] = 255
    arr[y0:, x0:] = reg
    return Image.fromarray(arr.astype(np.uint8)), int(mask.sum())


def key_white(im: Image.Image, thresh: int = 80) -> Image.Image:
    """从画布边界 flood fill 出连通背景，保留角色内部白色（领结/眼睛高光）。

    **边界不一定是背景色**：探头素材里有一条触边的黑线（角色从线后探出来）。
    如果从黑线上取种子，flood fill 会把"黑"当背景色，顺着黑线灌进角色身体，
    把整个人抠没（实测：三个探头素材全变成残影，只剩眼睛和领结）。
    所以先求边界的主色作为背景色，只从接近主色的点起灌。
    """
    rgb = im.convert("RGB")
    w, h = rgb.size
    work = rgb.copy()
    sentinel = (255, 0, 255)
    step = max(8, min(w, h) // 24)
    seeds: list[tuple[int, int]] = []
    for x in range(0, w, step):
        seeds += [(x, 0), (x, h - 1)]
    for y in range(0, h, step):
        seeds += [(0, y), (w - 1, y)]

    # 边界主色 = 背景色（取中位数，抗住黑线这种少数派）
    cols = np.array([work.getpixel(p) for p in seeds], dtype=np.int16)
    bg_col = np.median(cols, axis=0)
    skipped = 0
    for xy in seeds:
        if work.getpixel(xy) == sentinel:
            continue
        px = np.array(work.getpixel(xy), dtype=np.int16)
        if np.abs(px - bg_col).max() > 60:
            skipped += 1  # 不是背景（例如线上那一点），跳过
            continue
        ImageDraw.floodfill(work, xy, sentinel, thresh=thresh)

    arr = np.asarray(work).astype(np.int16)
    bg = np.abs(arr - np.array(sentinel, dtype=np.int16)).max(axis=-1) == 0
    lum = np.asarray(rgb.convert("L"), dtype=np.float32)
    alpha = np.where(bg, 0, 255).astype(np.uint8)

    bg_l = Image.fromarray((bg * 255).astype(np.uint8), "L")
    band = (np.asarray(bg_l.filter(ImageFilter.MaxFilter(3))) > 0) & (~bg)
    wfrac = np.clip((lum - 170.0) / 85.0, 0.0, 1.0)
    alpha[band] = (255 * (1.0 - wfrac[band])).astype(np.uint8)

    # ---- 关于"被角色围住的背景口袋"（手臂与身体之间的缝）----
    # 这类缝隙是白色背景，flood 从画布边界到不了，会留下浅灰块（实测可见，且逐帧闪烁）。
    # 我试过两种自动清理，**都不可靠**：
    #   1) 按连通块的中位亮度判 → 白嘴与缝隙连成一块时，嘴被一起抠掉；
    #   2) 按逐像素亮度判     → 领结/眼睛高光的抗锯齿边缘被咬出麻点。
    # 根因：视频压缩后背景浅灰(≈244)与白色特征(≈251)的像素分布重叠，颜色上分不干净。
    # 结论：**这是源素材格式的问题**，可靠解法是导出时用可抠的背景
    # （带 alpha 的 webm/png，或从不出现在画面里的纯色幕布），而不是继续在这里加启发式。
    # 目前选择保住嘴巴/领结/高光这些"要命的"特征，接受这几条缝。
    pocket_px = 0

    a = Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(0.6))
    out = rgb.convert("RGBA")
    out.putalpha(a)
    return out


# --------------------------------------------------------------------------- #
# 统一缩放定位
# --------------------------------------------------------------------------- #
def compute_ref(bboxes: list[tuple], cell: int, margin: float) -> dict:
    ws = np.array([b[2] - b[0] for b in bboxes], dtype=float)
    hs = np.array([b[3] - b[1] for b in bboxes], dtype=float)
    inner = cell * (1 - 2 * margin)
    return {
        "scale": min(inner / float(np.median(ws)), inner / float(np.median(hs))),
        "ref_w": float(np.median(ws)), "ref_h": float(np.median(hs)),
        "ref_cx": float(np.median([(b[0] + b[2]) / 2 for b in bboxes])),
        "ref_bottom": float(np.median([b[3] for b in bboxes])),
        "w_std_pct": round(float(ws.std() / ws.mean() * 100), 2),
        "h_std_pct": round(float(hs.std() / hs.mean() * 100), 2),
    }


def compute_ref_frame(frame_size: tuple[int, int], bboxes: list[tuple], cell: int,
                      margin: float, tweak: float = 1.0) -> dict:
    """按**素材画幅**而不是内容包围盒来统一缩放。

    为什么这样更一致：所有素材都是同一套取景生成的（角色居中、脚踩底边、
    约占画幅 90~95%）。于是「内容 ÷ 画幅」这个比例在各素材间基本恒定，
    按画幅缩放后角色在格子里的像素尺寸也基本恒定——实测立绘约 220px、
    视频约 221px，几乎一致。

    反过来，按内容包围盒缩放会让**每个姿势都填满格子**：驼背、躺姿这些
    包围盒更小的姿势会被放大，切换状态时大小就跳。这就是「比例不统一」的根因。
    """
    fw, fh = frame_size
    inner = cell * (1 - 2 * margin)
    ws = np.array([b[2] - b[0] for b in bboxes], dtype=float)
    hs = np.array([b[3] - b[1] for b in bboxes], dtype=float)
    return {
        "scale": inner / max(fw, fh) * tweak,
        "ref_w": float(fw), "ref_h": float(fh),
        "content_w": float(np.median(ws)), "content_h": float(np.median(hs)),
        "tweak": tweak,
        "ref_cx": float(np.median([(b[0] + b[2]) / 2 for b in bboxes])),
        "ref_bottom": float(np.median([b[3] for b in bboxes])),
        "w_std_pct": round(float(ws.std() / ws.mean() * 100), 2),
        "h_std_pct": round(float(hs.std() / hs.mean() * 100), 2),
    }


def place(keyed: Image.Image, bbox: tuple | None, cell: int, ref: dict,
          margin: float, anchor: str) -> Image.Image:
    canvas = Image.new("RGBA", (cell, cell), (0, 0, 0, 0))
    if bbox is None:
        return canvas
    if anchor == "free":
        inner = cell * (1 - 2 * margin)
        s = min(inner / (bbox[2] - bbox[0]), inner / (bbox[3] - bbox[1]))
    else:
        s = ref["scale"]
    # frame 模式：缩放来自画幅（整段共用），位置仍逐帧对齐以消掉 AI 视频的整体游移
    per_frame = anchor in ("stabilize", "free", "frame")
    cx = (bbox[0] + bbox[2]) / 2 if per_frame else ref["ref_cx"]
    bottom = bbox[3] if per_frame else ref["ref_bottom"]
    w, h = keyed.size
    scaled = keyed.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    canvas.paste(scaled, (round(cell / 2 - cx * s), round(cell * (1 - margin) - bottom * s)), scaled)
    return canvas


def apply_transform(base: Image.Image, sx: float, sy: float, dx: float, dy: float,
                    rot: float) -> Image.Image:
    cell = base.size[0]
    out = base
    if abs(rot) > 1e-3:
        out = out.rotate(rot, resample=Image.BICUBIC, center=(cell / 2, cell))
    if abs(sx - 1) > 1e-4 or abs(sy - 1) > 1e-4:
        nw, nh = max(1, round(cell * sx)), max(1, round(cell * sy))
        scaled = out.resize((nw, nh), Image.LANCZOS)
        tmp = Image.new("RGBA", (cell, cell), (0, 0, 0, 0))
        tmp.paste(scaled, (round((cell - nw) / 2), cell - nh), scaled)
        out = tmp
    if abs(dx) > 1e-6 or abs(dy) > 1e-6:
        tmp = Image.new("RGBA", (cell, cell), (0, 0, 0, 0))
        tmp.paste(out, (round(dx * cell), round(dy * cell)), out)
        out = tmp
    return out


def still_motion(state: str, t: float, cell: int):
    p = STILL_MOTION.get(state, {"breathe": 0.012, "tilt": 0.0, "sway": 0.0})
    s = math.sin(2 * math.pi * t)
    sy = 1.0 + p["breathe"] * s
    return 1.0 / sy, sy, (p["sway"] / cell) * s, -0.006 * s, p["tilt"] * s


def celebrate_motion(t: float):
    jump, sy = 0.0, 1.0
    if t < 0.14:
        sy = 1.0 - 0.13 * (t / 0.14)
    elif t < 0.55:
        u = (t - 0.14) / 0.41
        jump, sy = math.sin(math.pi * u), 1.0 + 0.12 * math.sin(math.pi * u)
    elif t < 0.72:
        sy = 1.0 - 0.16 * math.sin(math.pi * ((t - 0.55) / 0.17))
    else:
        sy = 1.0 + 0.03 * math.sin(math.pi * ((t - 0.72) / 0.28))
    return 1.0 / sy, sy, 0.0, -jump * 0.22, 0.0


# --------------------------------------------------------------------------- #
# 预览
# --------------------------------------------------------------------------- #
def save_gif(frames: list[Image.Image], path: Path, fps: int, cell: int) -> None:
    bg = Image.new("RGB", (cell, cell), (232, 232, 234))
    out = []
    for f in frames:
        flat = bg.copy()
        flat.paste(f, (0, 0), f)
        out.append(flat.convert("P", palette=Image.ADAPTIVE, colors=255))
    out[0].save(path, save_all=True, append_images=out[1:],
                duration=int(1000 / fps), loop=0, disposal=2)


def contact_sheet(images: list[Image.Image], cols: int, cell: int, path: Path,
                  labels: list[str] | None = None, font_size: int = 14) -> None:
    rows = math.ceil(len(images) / cols)
    pad, band = 5, 18
    W = cols * (cell + pad) + pad
    H = rows * (cell + pad + band) + pad
    sheet = Image.new("RGB", (W, H), (245, 245, 247))
    d = ImageDraw.Draw(sheet)
    f = load_font(font_size)
    for i, im in enumerate(images):
        r, c = divmod(i, cols)
        x = pad + c * (cell + pad)
        y = pad + r * (cell + pad + band)
        flat = Image.new("RGB", (cell, cell), (232, 232, 234))
        flat.paste(im, (0, 0), im)
        sheet.paste(flat, (x, y + band))
        if labels and i < len(labels):
            d.text((x + 2, y + 1), labels[i], font=f, fill=(20, 20, 30))
    sheet.save(path)


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cell", type=int, default=256)
    ap.add_argument("--margin", type=float, default=0.04)
    ap.add_argument("--anchor", choices=["frame", "stabilize", "fixed", "free"], default="frame")
    ap.add_argument("--only", default="", help="只处理指定状态（逗号分隔）")
    ap.add_argument("--out", default="assets")
    args = ap.parse_args()

    out_root = ROOT / args.out
    states_dir = out_root / "states"
    preview_dir = out_root / "preview"
    raw_root = out_root / "_raw"
    for d in (states_dir, preview_dir, raw_root):
        d.mkdir(parents=True, exist_ok=True)

    ffmpeg = find_ffmpeg()
    cell = args.cell
    only = {s.strip() for s in args.only.split(",") if s.strip()}

    print(f"ffmpeg : {ffmpeg}")
    print(f"参数   : cell={cell} margin={args.margin} anchor={args.anchor}\n")
    print(f"{'state':<11}{'kind':<7}{'mode':<6}{'帧':>4}{'fps':>5}{'时长':>7}"
          f"{'端点差':>8}{'窗口/全片运动':>15}  说明")
    print("-" * 108)

    manifest: dict = {"cell": cell, "margin": args.margin, "anchor_mode": args.anchor,
                      "anchor": "bottom-center", "states": {}}

    for name, kind, src_name, mode, n, fps, span, desc in STATE_CONFIG:
        if only and name not in only:
            continue
        src = resolve_src(src_name, kind)
        if src is None:
            print(f"[跳过] {name}: 还没找到素材（候选: {src_name}）")
            continue

        loop_from = None
        seam_diff = 0.0
        if kind == "video":
            raw = extract_frames(ffmpeg, src, raw_root / src.stem)
            idx = sample_indices(len(raw), n, span)
            frames_rgb = []
            for i in idx:
                with Image.open(raw[i]) as im:
                    frames_rgb.append(im.convert("RGB"))

            tail = TAILS.get(name)
            if tail:
                loop_from = len(frames_rgb)
                tail_idx = sample_indices(len(raw), tail["frames"], tail["span"])
                for i in tail_idx:
                    with Image.open(raw[i]) as im:
                        frames_rgb.append(im.convert("RGB"))

            # 诊断：窗口内运动 vs 全片运动（只报数，不参与选择）
            thumbs = np.stack([
                np.asarray(Image.open(p).convert("L").resize((48, 48), Image.BILINEAR),
                           dtype=np.float32) for p in raw[::max(1, len(raw) // 60)]
            ])
            full_motion = float(np.abs(np.diff(thumbs, axis=0)).mean())
            sub = np.stack([
                np.asarray(f.convert("L").resize((48, 48), Image.BILINEAR), dtype=np.float32)
                for f in frames_rgb
            ])
            win_motion = float(np.abs(np.diff(sub, axis=0)).mean())
            if loop_from is not None:
                # once_loop 的接缝在「尾段末帧 → 尾段首帧」，不是整条 strip 的首尾
                seam_diff = float(np.abs(sub[-1] - sub[loop_from]).mean())
                endpoint = seam_diff
            else:
                endpoint = float(np.abs(sub[0] - sub[-1]).mean())
            motion_txt = f"{win_motion:.3f}/{full_motion:.3f}"
        else:
            with Image.open(src) as im:
                frames_rgb = [im.convert("RGB")]
            endpoint, motion_txt = 0.0, "-"

        # 去水印（裁剪之前做：水印位置是按整张画幅定位的）
        cleaned, removed = [], 0
        for im in frames_rgb:
            c, r = strip_watermark(im)
            cleaned.append(c)
            removed += r

        # 逐状态裁剪：源画幅里角色只占一小块时先裁过来
        crop = CROPS.get(name) or CROPS.get(MIRROR_OF.get(name, ""))
        if crop:
            w0, h0 = cleaned[0].size
            box = (int(crop[0] * w0), int(crop[1] * h0),
                   int(crop[2] * w0), int(crop[3] * h0))
            cleaned = [im.crop(box) for im in cleaned]
            info_crop = list(box)
        else:
            info_crop = None

        # 逐状态镜像（在去水印与裁剪之后做，否则水印位置会跑）
        flip = FLIPS.get(name)
        if flip == "h":
            cleaned = [im.transpose(Image.FLIP_LEFT_RIGHT) for im in cleaned]
        elif flip == "v":
            cleaned = [im.transpose(Image.FLIP_TOP_BOTTOM) for im in cleaned]

        # 抠白底
        keyed = [key_white(im) for im in cleaned]
        bboxes = [k.split()[-1].getbbox() for k in keyed]
        valid = [b for b in bboxes if b]
        if not valid:
            print(f"[跳过] {name}: 抠像后无内容")
            continue
        # 整段共用一个缩放（防止逐帧缩放导致的膨胀）；frame 模式按画幅统一各状态比例
        tweak = SCALE_TWEAK.get(name, 1.0)
        state_anchor = ANCHOR_OVERRIDE.get(name, args.anchor)
        if state_anchor == "frame":
            ref = compute_ref_frame(cleaned[0].size, valid, cell, args.margin, tweak)
        else:
            ref = compute_ref(valid, cell, args.margin)
            ref["scale"] *= tweak
            ref["ref_cx"] = float(np.median([(b[0] + b[2]) / 2 for b in valid]))
            ref["ref_bottom"] = float(np.median([b[3] for b in valid]))
        info_scale = round(ref["scale"], 5)
        info_onscreen = (
            round(ref.get("content_w", ref["ref_w"]) * ref["scale"]),
            round(ref.get("content_h", ref["ref_h"]) * ref["scale"]),
        )
        normed = [place(k, b, cell, ref, args.margin, state_anchor)
                  for k, b in zip(keyed, bboxes)]

        # 程序化
        if kind == "video":
            final = normed
        elif kind == "proc":
            base = normed[0]
            final = [apply_transform(base, *celebrate_motion(i / n)) for i in range(n)]
        else:
            base = normed[0]
            final = [apply_transform(base, *still_motion(name, i / n, cell)) for i in range(n)]

        # 输出 strip
        strip = Image.new("RGBA", (cell * len(final), cell), (0, 0, 0, 0))
        for i, f in enumerate(final):
            strip.paste(f, (i * cell, 0), f)
        strip_path = states_dir / f"{name}.png"
        strip.save(strip_path)

        dur = len(final) / fps
        loop_txt = f"  loopFrom={loop_from}" if loop_from is not None else ""
        print(f"{name:<11}{kind:<7}{mode:<10}{len(final):>4}{fps:>5}{dur:>6.1f}s"
              f"{endpoint:>8.2f}{motion_txt:>15}{loop_txt}  {desc}")

        # 预览：once_loop 要把「动作 + 两轮循环」都展示出来，否则看不出接缝
        if loop_from is not None:
            preview_frames = final + final[loop_from:] + final[loop_from:]
        else:
            preview_frames = final
        save_gif(preview_frames, preview_dir / f"{name}.gif", fps, cell)
        contact_sheet(final, cols=min(12, len(final)), cell=cell,
                      path=preview_dir / f"sheet_{name}.png",
                      labels=[f"{name} #{i}" for i in range(len(final))])

        manifest["states"][name] = {
            "file": f"states/{name}.png",
            "kind": kind, "mode": mode, "source": src_name,
            "frames": len(final), "fps": fps, "duration_s": round(dur, 2),
            "span": span, "desc": desc,
            "loopFrom": loop_from,          # once_loop：0..loopFrom-1 播一次，之后从 loopFrom 循环
            "tail": TAILS.get(name),
            "strip_size": [strip.size[0], strip.size[1]],
            "src_frame_size": list(frames_rgb[0].size),
            "crop": info_crop,
            "anchor_mode": state_anchor,
            "scale": info_scale,
            "tweak": tweak,
            "on_screen_px": list(info_onscreen),
            "content_median": [
                round(ref.get("content_w", ref["ref_w"])),
                round(ref.get("content_h", ref["ref_h"])),
            ],
            "watermark_px_removed": removed,
            "bbox_std_pct": [ref["w_std_pct"], ref["h_std_pct"]],
            "endpoint_diff": round(endpoint, 3),
            "loop_seam_diff": round(seam_diff, 3),
        }

    manifest_path = out_root / "manifest.json"
    # --only 时要把结果并回已有 manifest，否则会把其他状态抹掉
    if only and manifest_path.exists():
        try:
            old = json.loads(manifest_path.read_text(encoding="utf-8"))
            merged = dict(old.get("states", {}))
            merged.update(manifest["states"])
            manifest["states"] = merged
        except (OSError, ValueError):
            pass
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    total = sum((states_dir / f"{s['file'].split('/')[-1]}").stat().st_size
                for s in manifest["states"].values())
    mem = sum(s["frames"] * cell * cell * 4 for s in manifest["states"].values())
    print(f"\n{len(manifest['states'])} 个状态，磁盘 {total/1024/1024:.2f} MB，"
          f"全部载入内存约 {mem/1024/1024:.1f} MB（建议渲染端按状态懒加载 + LRU）")
    print(f"manifest: {out_root / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
