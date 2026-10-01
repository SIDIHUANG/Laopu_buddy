"""把前端与精灵图装配到 app/dist/（Tauri 的 frontendDist）。

刻意不做打包：源码就是浏览器能直接跑的 ES 模块，
dist 只是「原样拷贝 + 把 assets 放进来」。
这样既能在浏览器里 debug，也能被 Tauri 直接当静态资源用。
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
DIST = APP / "dist"
ASSETS = ROOT / "assets"


def syntax_check(src_dir: Path) -> int:
    """用 node --check 逐个校验前端模块。

    为什么要这一步：ES 模块的语法错误**在浏览器里才知道**，而 Tauri 是把 dist
    在编译期嵌进 exe 的 —— 一个多余变量名就会让角色整块不渲染，却一路构建成功。
    实测踩过一次（新增的 step 与帧间隔的 step 重名），所以这里拦一道。
    """
    node = shutil.which("node")
    if not node:
        bundled = Path.home() / ".dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
        node = str(bundled) if bundled.exists() else None
    if not node:
        print("  [跳过] 找不到 node，无法做语法校验")
        return 0
    bad = []
    for f in sorted(src_dir.rglob("*.js")):
        r = subprocess.run([node, "--check", str(f)], capture_output=True, text=True)
        if r.returncode != 0:
            bad.append((f, (r.stderr or "").strip().splitlines()[:4]))
    for f, err in bad:
        print(f"  ✗ 语法错误 {f.name}")
        for line in err:
            print(f"      {line}")
    if bad:
        return len(bad)
    print(f"  ✓ 语法校验通过（{len(list(src_dir.rglob('*.js')))} 个模块）")
    return 0


def check_imports(src_dir: Path, html: Path) -> int:
    """校验 index.html 里 import 的模块都真的存在。

    这类错误（改名/漏拷）在浏览器里是"整块不渲染"，在 native 日志里也看不到
    —— 因为模块图加载失败时页面自己的错误处理器都还没注册。所以在装配阶段静态查一遍。
    """
    text = html.read_text(encoding="utf-8")
    # 两个来源的相对基准不同：index.html 里的相对 app/，main.js 里的相对 src/
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
    """检查「前端是否已经被编进 exe」——看 tauri 生成的资产是不是比 dist 新。

    为什么需要这一步：**前端是编译期嵌进 exe 的**，改了 dist 不重新 cargo build，
    exe 里跑的还是旧前端。v1.1 排查时在这上面绕过一圈：拿字符串在 exe 里搜
    新代码，搜不到就以为"没嵌进去" —— 其实 tauri 会把资产 **Brotli 压缩**，
    明文搜索永远搜不到（实测资产文件头是 `1B 66 06 00`，是 brotli 流）。

    所以判据只能是**时间戳**：tauri 会在 target/release/build/*/out/
    tauri-codegen-assets/ 下生成每个资产的压缩副本；只要它比 dist 里最新的
    文件还新，就说明嵌入过。这里只提示、不失败（dist 刚改还没 build 是正常的），
    但把"该重新 build 了"说得很清楚。
    """
    build_root = APP / "src-tauri" / "target" / "release" / "build"
    if not build_root.exists():
        return 0
    newest_dist = max(
        (p.stat().st_mtime for p in DIST.rglob("*") if p.is_file()),
        default=0,
    )
    newest_asset = 0.0
    # 直接递归找 `tauri-codegen-assets` 目录：cargo 的 build 输出目录名带指纹，
    # 按名字猜（presage-pet-*）不可靠 —— 实测还有别的指纹目录同时存在。
    for assets in build_root.rglob("tauri-codegen-assets"):
        if not assets.is_dir():
            continue
        for p in assets.glob("*"):
            newest_asset = max(newest_asset, p.stat().st_mtime)
    if newest_asset == 0:
        print("  ⚠ 没找到 tauri 的资产副本：还没 build 过原生壳（cargo build --release）")
        return 0
    if newest_asset + 1 < newest_dist:
        print("  ⚠ 前端比 exe 新 —— exe 里跑的还是旧前端，请重新:")
        print("      cd app/src-tauri; cargo build --release")
        print(f"      （dist 最新 {newest_dist:.0f} > 资产 {newest_asset:.0f}）")
    else:
        print("  ✓ 前端已被编进 exe（资产副本不比 dist 旧）")
    # 提醒：字符串搜 exe 是无效判据
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

    # 精灵图：manifest + states/（preview 和 _raw 不进 dist）
    (DIST / "assets").mkdir()
    shutil.copy2(ASSETS / "manifest.json", DIST / "assets" / "manifest.json")
    shutil.copytree(ASSETS / "states", DIST / "assets" / "states")

    # UI 素材（气泡皮肤等）
    if (ASSETS / "ui").exists():
        shutil.copytree(ASSETS / "ui", DIST / "assets" / "ui")

    total = 0
    for f in DIST.rglob("*"):
        if f.is_file():
            total += f.stat().st_size
    n = len(list((DIST / "assets" / "states").glob("*.png")))
    print(f"dist 就绪: {DIST}")
    print(f"  index.html + src/ + assets/manifest.json + {n} 个状态 strip")
    print(f"  合计 {total / 1024 / 1024:.2f} MB")
    check_embed_freshness()
    print("\n浏览器预览：  python -m http.server 8791 --directory app/dist")
    print("然后打开     http://127.0.0.1:8791/?debug=1")
    return 0


if __name__ == "__main__":
    sys.exit(main())
