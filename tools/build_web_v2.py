"""把 v2 的前端与精灵图装配到 v2/app/dist/（Tauri 的 frontendDist）。

与 v1 的 tools/build_web.py 是**同一套逻辑**，只改基准目录：
    v1 版：ROOT = 工程根，APP = <根>/app，DIST = <根>/app/dist
    v2 版：ROOT = 工程根，APP = <根>/v2/app，DIST = <根>/v2/app/dist

为什么不直接复用 v1 那份：v1 的 dist 是 v1 exe 的输入，v2 若写到同一个
dist 目录，就会把 v1 的构建输入改掉 —— 而"v1 基线保持可用、可重建"是这次
改动的硬要求（用户明确说了不要覆盖既有基线）。两份脚本都比"一份脚本带
一堆 if"更容易读，代价只是这个文件。

用法：
    $env:PYTHONIOENCODING = "utf-8"; python tools\\build_web_v2.py
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "v2" / "app"
DIST = APP / "dist"
ASSETS = ROOT / "assets"


def syntax_check(src_dir: Path) -> int:
    """用 node --check 逐个校验前端模块（与 v1 完全一致的意图）。

    ES 模块的语法错误**在浏览器里才知道**，而 Tauri 是把 dist 在编译期嵌进
    exe 的 —— 一个多余变量名就会让角色整块不渲染，却一路构建成功。这里拦一道。
    """
    node = shutil.which("node")
    if not node:
        bundled = Path.home() / ".dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
        node = str(bundled) if bundled.exists() else None
    if not node:
        print("  [跳过] 找不到 node，无法做语法校验")
        return 0
    bad = []
    files = sorted(src_dir.rglob("*.js"))
    for f in files:
        r = subprocess.run([node, "--check", str(f)], capture_output=True, text=True)
        if r.returncode != 0:
            bad.append((f, (r.stderr or "").strip().splitlines()[:4]))
    for f, err in bad:
        print(f"  ✗ 语法错误 {f.name}")
        for line in err:
            print(f"      {line}")
    if bad:
        return len(bad)
    print(f"  ✓ 语法校验通过（{len(files)} 个模块）")
    return 0


def check_imports(src_dir: Path, html: Path) -> int:
    """校验 index.html / main.js 里 import 的模块都真的存在。"""
    text = html.read_text(encoding="utf-8")
    refs = {(r, html.parent)
            for r in re.findall(r'''(?:from|src)\s*=?\s*["']([^"']+\.js)["']''', text)}
    main = src_dir / "main.js"
    if main.exists():
        refs |= {(r, src_dir)
                 for r in re.findall(r'''from\s+["']([^"']+\.js)["']''',
                                     main.read_text(encoding="utf-8"))}
    missing = []
    for r, base in refs:
        if r.startswith(("http://", "https://")):
            continue
        if not (base / r).resolve().exists():
            missing.append(r)
    for m in missing:
        print(f"  ✗ 找不到模块 {m}")
    if missing:
        return len(missing)
    print(f"  ✓ 模块引用完整（{len(refs)} 个引用）")
    return 0


def check_embed_freshness() -> int:
    """检查「v2 前端是否已经被编进 v2 exe」—— 看 tauri 生成的资产是否比 dist 新。

    注意基准必须指向 **v2/app/src-tauri/target**：v1 与 v2 各有一个 target，
    看错了目录就会得出相反的结论（v1.1 在这类"看错文件"上踩过好几次）。
    """
    build_root = APP / "src-tauri" / "target" / "release" / "build"
    if not build_root.exists():
        return 0
    newest_dist = max(
        (p.stat().st_mtime for p in DIST.rglob("*") if p.is_file()),
        default=0,
    )
    newest_asset = 0.0
    for assets in build_root.rglob("tauri-codegen-assets"):
        if not assets.is_dir():
            continue
        for p in assets.glob("*"):
            newest_asset = max(newest_asset, p.stat().st_mtime)
    if newest_asset == 0:
        print("  ⚠ 没找到 v2 的资产副本：还没 build 过原生壳（cargo build --release）")
        return 0
    if newest_asset + 1 < newest_dist:
        print("  ⚠ 前端比 exe 新 —— exe 里跑的还是旧前端，请重新:")
        print("      cd v2/app/src-tauri; cargo build --release")
        print(f"      （dist 最新 {newest_dist:.0f} > 资产 {newest_asset:.0f}）")
    else:
        print("  ✓ v2 前端已被编进 v2 exe（资产副本不比 dist 旧）")
    print("    备注：不要用「在 exe 里搜前端字符串」判断是否嵌入 —— 资产是 Brotli 压缩的")
    return 0


def main() -> int:
    if not (ASSETS / "manifest.json").exists():
        print("缺少 assets/manifest.json，先跑 tools/build_sprites.py")
        return 1

    if syntax_check(APP / "src") > 0:
        print("前端有语法错误，已中止装配（不会产出坏 dist）")
        return 1
    if check_imports(APP / "src", APP / "index.html") > 0:
        print("有模块引用不到，已中止装配")
        return 1

    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    shutil.copy2(APP / "index.html", DIST / "index.html")
    shutil.copytree(APP / "src", DIST / "src")

    (DIST / "assets").mkdir()
    shutil.copy2(ASSETS / "manifest.json", DIST / "assets" / "manifest.json")
    shutil.copytree(ASSETS / "states", DIST / "assets" / "states")
    if (ASSETS / "ui").exists():
        shutil.copytree(ASSETS / "ui", DIST / "assets" / "ui")

    total = 0
    for f in DIST.rglob("*"):
        if f.is_file():
            total += f.stat().st_size
    n = len(list((DIST / "assets" / "states").glob("*.png")))
    print(f"v2 dist 就绪: {DIST}")
    print(f"  index.html + src/ + assets/manifest.json + {n} 个状态 strip")
    print(f"  合计 {total / 1024 / 1024:.2f} MB")
    check_embed_freshness()
    print("\n浏览器预览：  python -m http.server 8791 --directory v2/app/dist")
    print("然后打开     http://127.0.0.1:8791/?debug=1")
    return 0


if __name__ == "__main__":
    sys.exit(main())
