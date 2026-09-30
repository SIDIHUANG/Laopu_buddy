# 未解决问题汇总（交接给下一个对话）

> 生成时间：2026-10-01 深夜 · 对应提交 `f08c898`（以及本文档的后续提交）
> 项目：`C:\Users\Asus\Desktop\dsh_test\laopu_ds`
> **新对话第一句建议直接粘**：
> 「读 `OPEN-ISSUES.md` 和 `V1-BASELINE.md`。目标：解决 OPEN-ISSUES 里的问题 1（角色几秒后消失+红色故障条）。」

---

## 🔴 问题 1（阻塞级）：角色启动几秒后消失，伴随「红色故障条」

### 用户实测的完整时间线（这是最可靠的资料）

| 时间 | 现象 |
|---|---|
| 0~10 秒 | **一切正常** ✓：角色显示正确、**可以正常拖动** ✓、气泡正常带动画 ✓ |
| ~10 秒后 | 上方出现**红色故障条** ✗（用户原话），角色**只剩半截**（上半或下半） ✗ |
| 再之后 | 角色**完全消失** ✗，只剩气泡文字与 `+n 条` 计数 ✓ |

**关键推论**：这是**延迟发生**的 ✗（前 10 秒完全正常 ✓）→ 不是"画不出来"✗，
而是**几秒后合成/绘制路径坏掉** ✓。

### 已排除的假设（都做过实验，别再走一遍）

| 假设 | 实验 | 结果 |
|---|---|---|
| 提权运行 | 用户去掉管理员，普通双击 | 现象**完全相同** → 排除 ✗ |
| canvas 图层不被合成 | 把可见角色改成 **DOM/CSS 背景图**（与气泡同路径） | **仍然几秒后消失** → 排除 ✗ |
| `--disable-gpu` | 写进 `tauri.conf.json` 的 `additionalBrowserArgs` 并重新构建 | **仍然复现** → 无效 ✗（且未验证该 flag 是否真被 WebView2 采用 ✗） |
| 启动方式差异（bat vs agent） | bat 已改成与 agent **完全相同的 `Start-Process` 命令** | 仍在验证中（用新版 bat 测一次即可确认） |

### 🎯 现在的首要怀疑：**交叉淡化（两层 opacity 混合）**

理由：**canvas 版与 DOM 版都复现** ✗，而两者唯一的共同点是
**状态切换时会做 180ms 的交叉淡化**（把一个旧图层以 opacity 淡出、新图层淡入）✓
—— 而且**前 10 秒正常**，正好对应"第一次状态切换发生之前" ✓。

**最便宜的验证（强烈建议先做这个）**：
**把交叉淡化整个去掉** ✓（状态切换直接硬切 ✓），重建后看故障是否消失 ✓。

相关代码（都在 `app/src/renderer.js`）：
- `FADE_MS = 180` 与 `this.fade` 的推进
- `snapshotPrevious()` / `snapshotPreviousDom()`（旧画面快照）
- canvas 版的 `if (this.fade < 1) { ctx.globalAlpha = 1 - fade; ctx.drawImage(this.prev, ...) }`
- DOM 版的 `cur.style.opacity = fade * op` / `prev.style.opacity = (1 - fade) * op`

### 其他次要但合理的怀疑

1. **WebView2 的 GPU 进程在几秒后崩溃** ✗ →
   查 `msedgewebview2.exe` 里是否还活着 `--type=gpu-process` ✓；
   真正关掉硬件加速（不是靠 env var ✗）✓；再不行关掉 Windows 的
   「硬件加速 GPU 计划」（设置 → 系统 → 屏幕 → 显示卡 → 默认图形设置）✓；
   更新显卡驱动 ✓。用户机器是**混合显卡（NVIDIA + 集显）+ 200% 缩放** ✓。
2. **红色故障条**：只在角色故障时出现 ✓，怀疑是 **DWM/合成器**重绘失败的残留 ✓
   （它是**系统级**现象 ✓，不是我们窗口的画错 ✓）。

### 排查纪律（这轮踩过的坑）

- **不要再基于推测写"结论"** ✓ —— 本轮有两次（提权 ✗、GPU flag ✗）都是被用户实测推翻的 ✓。
- **验证必须看得见** ✓：日志说 `boot ok` / `hitmask filled` 非 0 都**不能**证明"画面正常" ✗。
- 用户机器上的画面问题，**只能靠用户肉眼或截图确认** ✓。

---

## 🔴 问题 2：托盘图标不出现（`Shell_NotifyIcon` 返回 ACCESS_DENIED）

```
[tray] 用 exe 图标资源 id=32512 ✓ 句柄有效 ✓
[tray] diag windowstation=WinSta0 desktop=Default ✓（与 Explorer 一致）
[tray] diag NIM_ADD without-icon ok=0 err=5      ← 连不带图标的最小注册也被拒
[tray] Shell_NotifyIcon 五次都失败，GetLastError=5
```

已排除：图标句柄无效 ✗、图标尺寸（512/128/32 都试过）✗、结构体尺寸 `cbSize=976` ✗、
残留错误码（已 `SetLastError(0)`）✗、窗口站/桌面 ✗、Tauri 封装 ✗（换原生实现同样失败）、
提权 ✗（普通双击同样 err=5）。

**下一步**：
1. 写一个 **30 行独立最小 exe**（只调 `Shell_NotifyIcon`）在同一台机器跑 ✓ ——
   若它也 err=5 ✓，即可确认是**环境级**问题并停止在本项目里找原因 ✓
2. 查安全软件 / 组策略（用户配置 → 管理模板 → 开始菜单和任务栏）✓
3. 换一个 Windows 本地账户试同一 exe ✓
4. 兜底：托盘不可用时，**桌宠右键菜单**是唯一入口（已可用 ✓），
   可考虑做桌面快捷方式并在文档里说明 ✓

---

## 🟡 问题 3：抠图残留（手臂与身体之间的浅灰缝）

**现象**：某些帧角色两侧有未扣净的浅灰竖条，**逐帧闪烁** ✗。
**根因**：那是"被角色围住的白色背景"，flood fill 从画布边界到不了 ✓。
**为什么没硬修**：试过两种自动判据都不可靠 ✗（按连通块中位亮度 → 白嘴与缝连成一块时把嘴一起抠掉 ✗；
按逐像素亮度 → 领结/高光抗锯齿边缘被咬出麻点 ✗）。根因是视频压缩后
背景浅灰(≈244)与白色特征(≈251)像素分布**重叠** ✓。

**代码位置**：`tools/build_sprites.py:225` `key_white()`（含完整决策注释与回退点 `:262-276`）
**正解**：**从源素材解决** ✓ —— 导出带 alpha 的 webm/png 序列，或用纯色幕布（如纯绿 #00FF00）。
这样抠图零误差，灰条/边界毛边/探头裁切会一起消失 ✓。

---

## 🟡 问题 4：任务栏图标（`skipTaskbar` 无效）

窗口仍出现在任务栏。代码：`app/src-tauri/src/main.rs:806` `let _ = w.set_skip_taskbar(true);`
**下一步**：直接设扩展样式 `WS_EX_TOOLWINDOW`（清 `WS_EX_APPWINDOW`）。
链接期警告 `.rsrc merge failure: multiple non-default manifests` 与此无关，不影响运行 ✓。

---

## 🟢 问题 5：`celebrate` 用难过脸弹跳

需要一张笑脸立绘。文件名带 `happy` / `开心` / `笑` / `smile` 就会被管线自动识别 ✓。

---

## 当前代码状态（本轮改动全在此）

| 提交 | 内容 | 影响 |
|---|---|---|
| `f08c898` | canvas 彻底移出 DOM（只供遮罩像素）；`#pet-hit` 占位盒负责坐标与拖拽；透明度作用到 DOM 层；**bat 改抄 agent 的可 work 命令** | 命中遮罩与点击恢复正常 ✓ |
| `b1d59be` | 可见角色改由 **DOM/CSS 背景图**渲染（`#pet-cur`/`#pet-prev` 两层 `.pet-layer`） | 绕开 canvas 显示路径 ✓ |
| `1805ee4` | `tauri.conf.json` 加 `additionalBrowserArgs: "--disable-gpu"` | 未解决问题 1 ✗ |
| 其余 | bat 两个真 bug（`timeout` 在 stdin 重定向下中断 ✗ / UTF-8 日志在 GBK 控制台花屏 ✗）+ 文档 + 基线 | 启动器可用 ✓ |

**⚠️ 本轮引入过并已修的回归**：DOM 层排在 `#bubble-list` 之后且没写 `z-index` ✗ →
**气泡被压到角色后面** ✗（用户实测）。已修：`.pet-layer { z-index: 0 }` + `#bubble-list { z-index: 1 }` ✓。
**改动渲染层级时务必确认"气泡尾巴搭在她头顶"仍然成立** ✓。

**关键文件**：
- `app/index.html` —— 舞台结构（`#bubble-list` / `#pet-hit` / `.pet-layer` ×2）+ 全部 CSS
- `app/src/renderer.js` —— 绘制（canvas 画像素供遮罩 ✓ + DOM 画可见角色 ✓）、交叉淡化、提拉形变
- `app/src/pointer.js` —— 命中遮罩（像素来自游离 canvas ✓、坐标与拖拽来自 `#pet-hit` ✓）
- `app/src/main.js` —— 接线（`canvas` 由 JS 创建不进 DOM ✓、`hit` 传给渲染器与指针桥 ✓）
- `app/src-tauri/src/main.rs` —— 原生壳（托盘、窗口、穿透样式、`logln` 双写日志 ✓）

## 环境与验证方式（重要）

```powershell
# 构建
python tools\build_web.py                     # 需 $env:PYTHONIOENCODING="utf-8"，否则 GBK 报错 ✗
cd app\src-tauri; cargo build              # debug 20s；cargo build --release 约 1 分钟

# 启动（必须重定向输出，否则命令挂住 ✗）
$env:WEBVIEW2_USER_DATA_FOLDER = "$pwd\v1\runtime\webview2"
Start-Process -FilePath "v1\presage-pet.exe" -WorkingDirectory "$pwd\v1" `
  -RedirectStandardOutput "v1\runtime\pet.out.log" -RedirectStandardError "v1\runtime\pet.err.log"

# 日志（程序自己写，没有控制台也能查 ✓）
%LOCALAPPDATA%\PresagePet\pet.log             # ← agent 可直接读，不必让用户截图 ✓
v1\runtime\pet.out.log                         # 另写一份到 cwd

# 抓窗口截图验证"看得见"的东西（PrintWindow）
```

**发布包**：`v1\`（`presage-pet.exe` + `WebView2Loader.dll` + `启动桌宠.bat` + `诊断-关GPU启动.bat`）
—— **`v1\` 不进 git** ✓（44 MB 的 exe 不该进版本库 ✓）。

**用户环境要点**：Windows · 显示缩放 **200%** · **混合显卡（NVIDIA 独显 + 集显）** ·
非管理员 · 没有 PowerShell 7（只有 5.1）· MinGW-w64 在 `~/.mingw64/mingw64/bin`。
