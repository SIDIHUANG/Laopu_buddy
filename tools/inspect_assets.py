"""量一下 avatar_baseline 里现有素材的真实规格。

图片用 Pillow 读真实格式/尺寸/alpha/内容包围盒；
mp4 直接解析 MP4 box 结构（不依赖 ffmpeg），拿到时长、分辨率、帧数、帧率、编码。
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / "avatar_baseline"

CONTAINER_BOXES = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"udta", b"dinf"}


def iter_boxes(data: bytes, start: int = 0, end: int | None = None):
    """按顺序产出 (type, payload_start, payload_end)。"""
    end = len(data) if end is None else end
    pos = start
    while pos + 8 <= end:
        size = struct.unpack(">I", data[pos : pos + 4])[0]
        btype = data[pos + 4 : pos + 8]
        header = 8
        if size == 1:
            if pos + 16 > end:
                return
            size = struct.unpack(">Q", data[pos + 8 : pos + 16])[0]
            header = 16
        elif size == 0:
            size = end - pos
        if size < header or pos + size > end:
            return
        yield btype, pos + header, pos + size
        pos += size


def find_box(data: bytes, path: list[bytes], start: int = 0, end: int | None = None):
    """按路径找第一个匹配的 box，返回 (payload_start, payload_end)。"""
    end = len(data) if end is None else end
    for btype, ps, pe in iter_boxes(data, start, end):
        if btype == path[0]:
            if len(path) == 1:
                return ps, pe
            if btype in CONTAINER_BOXES:
                found = find_box(data, path[1:], ps, pe)
                if found:
                    return found
    return None


def probe_mp4(path: Path) -> dict:
    data = path.read_bytes()
    info: dict = {"file": path.name, "bytes": len(data)}

    ftyp = find_box(data, [b"ftyp"])
    if ftyp:
        ps, pe = ftyp
        info["brand"] = data[ps : ps + 4].decode("ascii", "replace")
        info["compatible"] = [
            data[i : i + 4].decode("ascii", "replace")
            for i in range(ps + 8, pe - 3, 4)
        ]

    mvhd = find_box(data, [b"moov", b"mvhd"])
    if mvhd:
        ps, _ = mvhd
        version = data[ps]
        if version == 0:
            timescale, duration = struct.unpack(">II", data[ps + 12 : ps + 20])
        else:
            timescale, duration = struct.unpack(">IQ", data[ps + 20 : ps + 32])
        info["movie_timescale"] = timescale
        info["movie_duration_s"] = round(duration / timescale, 3) if timescale else None

    # 逐个 trak 判断是视频还是音频
    moov = find_box(data, [b"moov"])
    tracks = []
    if moov:
        for btype, ps, pe in iter_boxes(data, moov[0], moov[1]):
            if btype != b"trak":
                continue
            track: dict = {}
            hdlr = find_box(data, [b"mdia", b"hdlr"], ps, pe)
            if hdlr:
                track["handler"] = data[hdlr[0] + 8 : hdlr[0] + 12].decode("ascii", "replace")
            mdhd = find_box(data, [b"mdia", b"mdhd"], ps, pe)
            ts = dur = None
            if mdhd:
                p = mdhd[0]
                if data[p] == 0:
                    ts, dur = struct.unpack(">II", data[p + 12 : p + 20])
                else:
                    ts, dur = struct.unpack(">IQ", data[p + 20 : p + 32])
                track["mdhd_timescale"] = ts
                track["mdhd_duration_s"] = round(dur / ts, 3) if ts else None
            tkhd = find_box(data, [b"tkhd"], ps, pe)
            if tkhd:
                p, q = tkhd
                w, h = struct.unpack(">II", data[q - 8 : q])
                track["width"] = w >> 16
                track["height"] = h >> 16
            stsd = find_box(data, [b"mdia", b"minf", b"stbl", b"stsd"], ps, pe)
            if stsd:
                p = stsd[0]
                track["codec"] = data[p + 12 : p + 16].decode("ascii", "replace")
            stts = find_box(data, [b"mdia", b"minf", b"stbl", b"stts"], ps, pe)
            if stts:
                p = stts[0]
                entry_count = struct.unpack(">I", data[p + 4 : p + 8])[0]
                samples = 0
                total_delta = 0
                for i in range(entry_count):
                    off = p + 8 + i * 8
                    sc, sd = struct.unpack(">II", data[off : off + 8])
                    samples += sc
                    total_delta += sc * sd
                track["sample_count"] = samples
                track["total_delta"] = total_delta
                if ts and total_delta:
                    track["fps_avg"] = round(samples / (total_delta / ts), 3)
            tracks.append(track)
    info["tracks"] = tracks
    return info


def probe_image(path: Path) -> dict:
    with Image.open(path) as im:
        info = {
            "file": path.name,
            "bytes": path.stat().st_size,
            "real_format": im.format,
            "declared_by_ext": path.suffix.lower().lstrip("."),
            "size": im.size,
            "mode": im.mode,
        }
        info["has_alpha"] = "A" in im.getbands()
        rgb = im.convert("RGB")
        w, h = rgb.size
        # 与白底的差异 -> 内容包围盒
        gray = rgb.convert("L")
        mask = gray.point(lambda v: 255 if v < 245 else 0)
        bbox = mask.getbbox()
        info["content_bbox"] = bbox
        if bbox:
            info["content_size"] = (bbox[2] - bbox[0], bbox[3] - bbox[1])
            info["content_pct"] = (
                round((bbox[2] - bbox[0]) / w * 100, 1),
                round((bbox[3] - bbox[1]) / h * 100, 1),
            )
            info["margins_ltrb"] = (bbox[0], bbox[1], w - bbox[2], h - bbox[3])
        info["unique_colors"] = len(rgb.getcolors(maxcolors=1_000_000) or [])
        # 右下角水印区非白像素密度
        cw, ch = int(w * 0.3), int(h * 0.12)
        corner = gray.crop((w - cw, h - ch, w, h))
        dark = sum(1 for v in corner.getdata() if v < 235)
        info["corner_dark_px"] = dark
        info["corner_density_pct"] = round(dark / (cw * ch) * 100, 2)
        return info


def main() -> int:
    files = sorted(p for p in ROOT.iterdir() if p.is_file())
    if not files:
        print(f"no files in {ROOT}")
        return 1
    print(f"# directory: {ROOT}\n")
    for path in files:
        ext = path.suffix.lower()
        if ext in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}:
            info = probe_image(path)
        elif ext in {".mp4", ".mov", ".m4v", ".webm"}:
            info = probe_mp4(path)
        else:
            info = {"file": path.name, "bytes": path.stat().st_size, "note": "skipped"}
        print(f"## {info.pop('file')}")
        for k, v in info.items():
            print(f"   {k}: {v}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
