"""打印各状态的实际占屏尺寸，用于核对「比例是否统一」。

用法：python tools/report_scales.py
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    meta = json.loads((ROOT / "assets" / "manifest.json").read_text(encoding="utf-8"))
    cell = meta["cell"]
    print(f"格子 {cell}px   anchor={meta.get('anchor_mode')}\n")
    print(f"{'状态':<14}{'源画幅':>13}{'内容包围盒':>14}{'占屏px':>13}{'tweak':>7}  mode")
    print("-" * 78)
    sizes = []
    for name, st in meta["states"].items():
        w, h = st.get("on_screen_px") or (0, 0)
        sizes.append((name, w, h))
        print(
            f"{name:<14}{str(st.get('src_frame_size')):>13}"
            f"{str(st.get('src_content_median')):>14}{str((w, h)):>13}"
            f"{st.get('tweak', 1.0):>7}  {st.get('mode')}"
        )
    print("\n只比较「站姿类」状态的高度（躺姿/驼背本来就更矮）：")
    upright = [h for n, w, h in sizes if n not in ("sleep", "sleep_idle", "doze")]
    if upright:
        print(f"  高度范围 {min(upright)} ~ {max(upright)} px  "
              f"（极差 {max(upright) - min(upright)} px，越小越统一）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
