"""Look at what is really on screen where the pet window is.

PrintWindow is not trustworthy for a layered (transparent) window: it can
return an empty or clamped image. This grabs the DWM-composited screen
rectangle instead, which is exactly what the user's eyes see, and then
reports a vertical profile of "character" pixels.

Usage:
    python tools/see_pet.py [--wait 10] [--out runtime/see.png] [--kill]
"""
import argparse
import ctypes
import ctypes.wintypes as wt
import os
import sys
import time

import numpy as np
from PIL import Image

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wt.DWORD), ("biWidth", ctypes.c_long),
                ("biHeight", ctypes.c_long), ("biPlanes", wt.WORD),
                ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
                ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wt.DWORD),
                ("biClrImportant", wt.DWORD)]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wt.DWORD * 3)]


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def find_pet_window():
    """Return (hwnd, rect) of the Tauri pet window, or (None, None)."""
    found = []

    def _cb(hwnd, lparam):
        buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, buf, 256)
        if buf.value == "Tauri Window":
            r = RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            found.append((hwnd, r))
        return True

    # keep a reference to the callback for the whole call: a temporary
    # WINFUNCTYPE object can be collected mid-enumeration and hang the call.
    cb = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)(_cb)
    user32.EnumWindows(cb, 0)
    if not found:
        return None, None
    return found[0]


def grab(x, y, w, h):
    hdc_src = user32.GetDC(0)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_src)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_src, w, h)
    old = gdi32.SelectObject(hdc_mem, hbmp)
    gdi32.BitBlt(hdc_mem, 0, 0, w, h, hdc_src, x, y, SRCCOPY)
    gdi32.SelectObject(hdc_mem, old)

    bi = BITMAPINFO()
    bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.bmiHeader.biWidth = w
    bi.bmiHeader.biHeight = -h  # top-down
    bi.bmiHeader.biPlanes = 1
    bi.bmiHeader.biBitCount = 32
    bi.bmiHeader.biCompression = 0
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(hdc_mem, hbmp, 0, h, buf, ctypes.byref(bi), DIB_RGB_COLORS)
    gdi32.DeleteObject(hbmp)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(0, hdc_src)

    arr = np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 4)[:, :, :3][:, :, ::-1]
    return arr


def profile(arr, label):
    h, w, _ = arr.shape
    rgb = arr.astype(np.int16)
    # character = clearly darker than the desktop in all channels
    dark = (rgb[:, :, 0] < 120) & (rgb[:, :, 1] < 120) & (rgb[:, :, 2] < 140)
    rows = dark.sum(axis=1)
    print(f"--- {label}: window {w}x{h}, dark pixels total={int(rows.sum())} ---")
    bands = 20
    for i in range(bands):
        y0 = int(i * h / bands)
        y1 = int((i + 1) * h / bands)
        seg = dark[y0:y1]
        pct = 100.0 * seg.sum() / max(1, seg.size)
        bar = "#" * int(pct / 2)
        print(f"  y {y0:>4}-{y1:>4} ({100*i//bands:>3}%)  {pct:5.1f}%  {bar}")
    # vertical extent of the character
    nz = np.nonzero(rows > 3)[0]
    if len(nz):
        print(f"  character rows: top={nz[0]} bottom={nz[-1]} "
              f"(window height {h}, empty below character = {h - 1 - nz[-1]}px)")
    else:
        print("  NO character pixels found in the whole window")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wait", type=float, default=0)
    ap.add_argument("--out", default="")
    ap.add_argument("--kill", action="store_true")
    ap.add_argument("--samples", type=int, default=1)
    ap.add_argument("--every", type=float, default=5.0)
    args = ap.parse_args()

    user32.SetProcessDPIAware()
    if args.wait:
        time.sleep(args.wait)

    for i in range(args.samples):
        hwnd, r = find_pet_window()
        if not hwnd:
            print("pet window not found")
            return 1
        w, h = r.right - r.left, r.bottom - r.top
        arr = grab(r.left, r.top, w, h)
        profile(arr, f"sample {i} rect=({r.left},{r.top})")
        if args.out:
            out = args.out if args.samples == 1 else args.out.replace(".png", f"-{i}.png")
            Image.fromarray(arr).save(out)
            print(f"  saved {out}")
        if i < args.samples - 1:
            time.sleep(args.every)

    if args.kill:
        os.system("taskkill /IM presage-pet.exe /F >nul 2>&1")
    return 0


if __name__ == "__main__":
    sys.exit(main())
