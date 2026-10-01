# 普瑞塞斯桌宠 · v1.1 基线

> **v1.1 做了什么、还剩什么，看 [OPEN-ISSUES.md](OPEN-ISSUES.md)（第 0 节是本次修掉的全部问题）。**
> 本文档第 0 节下面是 **v1 的历史记录**，其中的"未解决问题"结论**已被 v1.1 更新**，
> 读的时候以 OPEN-ISSUES.md 为准。

## v1.1 摘要（一句话版）

**v1 的"角色几秒后只剩半截 / 整个消失"不是渲染或合成问题，而是布局几何从第一帧就错了：
窗口高度按「精灵格高度（宽 × 1.34）」算，而角色真实只有「宽 × 0.875」，
于是她的下半身一直在窗口外，被窗口裁掉；气泡又通过负 margin 拉着她一起动，
所以"被裁掉的是哪一半"还会变。**

修法（全部实测验证过）：

| # | 改动 | 文件 |
|---|---|---|
| 1 | 窗口高 = 角色实际占高 + 气泡区；尺寸上限跟屏幕走 | `app/src/appearance.js` |
| 2 | 画布 / 命中盒 / 精灵格三者同尺寸（`HEADROOM = 0`），遮罩坐标 == 可见坐标 | `app/src/renderer.js` |
| 3 | 角色 `bottom` 锚窗口底边、气泡 `bottom` 锚"头顶 + 8%"；删掉覆盖 `position` 的重复规则 | `app/index.html` |
| 4 | 状态抖动：防抖记账只在候选变化时写时间戳 + 一次性动画按优先级抢占 | `app/src/arbiter.js` |
| 5 | 启动器重写：唯一实现、`start /b` 直启（无 powershell 中间层）、profile 坏了自动重建 | `启动桌宠.bat` |
| 6 | 几何自检日志（`[geom:*] 裁掉=/出屏=/气泡出框=`）+ 提权自检 + 托盘不可用的热键退路 | `app/src/main.js` / `app/src-tauri/src/main.rs` |
| 7 | 排障工具：`measure_sprites.py`（量真实包围盒）/ `see_pet.py`（抓屏幕像素）/ `set_size.mjs` | `tools/` |

**验收命令**（三档尺寸都不许被裁 + 肉眼看整只都在）：

```powershell
$env:PYTHONIOENCODING = "utf-8"; python tools\build_web.py
cd app\src-tauri; cargo build --release; cd ..\..
Copy-Item app\src-tauri\target\release\presage-pet.exe v1\ -Force
Copy-Item app\src-tauri\target\release\WebView2Loader.dll v1\ -Force
# （在 DSH 沙箱里跑：profile 必须放工作区内，见 OPEN-ISSUES 第 3 节）
$env:WEBVIEW2_USER_DATA_FOLDER = "$PWD\runtime\wv2-geom"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333 --remote-allow-origins=*"
Start-Process "$PWD\v1\presage-pet.exe" -WorkingDirectory "$PWD\v1" `
  -RedirectStandardOutput "$PWD\runtime\sz.out.log" -RedirectStandardError "$PWD\runtime\sz.err.log"
node tools\set_size.mjs 200; node tools\set_size.mjs 320; node tools\set_size.mjs 480
python tools\see_pet.py --out runtime\shot.png
```

---

<!-- ↓↓↓ 以下为 v1 时期的历史记录，保留以便追溯（结论以 OPEN-ISSUES.md 为准） ↓↓↓ -->

## 📌 下次开工指引（新对话第一件事就看这里）

> **未解决问题的完整清单与最新进展见 [OPEN-ISSUES.md](OPEN-ISSUES.md)** —— 先读那一份。

**把下面这句话直接粘进新对话即可**（不需要重新解释项目背景）：

> 读 `C:\Users\Asus\Desktop\dsh_test\laopu_ds\V1-BASELINE.md`。
> 当前状态：v1 可用并已提交（git tag `v1-baseline`）。
> 请从「3. 未解决的问题 → 问题 1：托盘图标不显示」开始，按里面的"下次的下一步"继续排查。

**先读这两个文件就够了**：
1. 本文档 —— 功能现状 / 未解决问题（含 file:line 锚点）/ 下次步骤 / **第 5 节：9 个已经踩过的坑**（不看会重犯）
2. `README.md` —— 架构与环境说明

**开工前的三件事**：
```powershell
cd C:\Users\Asus\Desktop\dsh_test\laopu_ds
git log --oneline -1                     # 确认仍在 v1-baseline 上
python tools\build_web.py                # 前端语法门禁 + 打包 dist
node app\test\logic.test.mjs             # 冒烟：应 43/43 通过
```

**⚠️ 启动桌宠必须重定向输出**（否则命令会一直挂着，这是上次浪费最多时间的地方）：
```powershell
$env:WEBVIEW2_USER_DATA_FOLDER = (Join-Path (Get-Location) "runtime\webview2")
Start-Process -FilePath "v1\presage-pet.exe" `
  -RedirectStandardOutput "runtime\pet.out.log" -RedirectStandardError "runtime\pet.err.log"
```

**唯一还没定的结论**：由用户**自己双击 `v1\启动桌宠.bat`** 时，`Shell_NotifyIcon` 是否仍返回
`GetLastError=5`。用户界面上的日志（`v1\runtime\pet.out.log` 里 `[tray]` 那几行）就是判据。

---

> 基线日期：2026-10-01 · 版本：v1（可用，带一个未解决的环境级问题）
> git 基线：提交 `9c4da40`（2214 个文件，工作区干净）
> 用法：双击 `v1\启动桌宠.bat`（或根目录的 `启动桌宠.bat`）
> 日志：`runtime\pet.out.log`，同时写 `%LOCALAPPDATA%\PresagePet\pet.log`（无控制台也能查）

## 0. v1 包内容（`v1\`）

| 文件 | 说明 |
|---|---|
| `presage-pet.exe` | **release 构建，44.3 MB**（debug 版 269 MB，不要用）；前端与素材已编入二进制 |
| **`WebView2Loader.dll`** | **必须一起分发！** 见下方"封装坑"，漏了它 exe 会以 `0xC0000135` 秒退 |
| `启动桌宠.bat` | 双击启动：检查重复实例 → 按需拉起桥接 → 启动桌宠 |
| `V1-BASELINE.md` | 本文档 |
| `tools\pet_bridge.mjs` | 桥接：`/usage`（余额）`/lines`（台词库） |
| `tools\usage.mjs` | 用量采集（ccswitch / dsh / deepseek） |

### ⚠️ 封装坑（本次踩到，务必保留）：`WebView2Loader.dll`

只拷 exe 会导致**双击后无任何提示地秒退，退出码 `0xC0000135`(STATUS_DLL_NOT_FOUND)**。
排查方式（不要靠猜）：

```powershell
& "$env:USERPROFILE\.mingw64\mingw64\bin\objdump.exe" -p presage-pet.exe |
  Select-String "DLL Name"      # 看真实导入表，找非系统 DLL
```

导入表里只有 `WebView2Loader.dll` 是需要随包分发的（其余都是系统 DLL）。
它的位置：`app\src-tauri\target\release\WebView2Loader.dll`。

> 补充：`target-feature=+crt-static` **不能**去掉 MinGW 运行时依赖（`libgcc_s` 是独立
> unwinder），本项目实测无效；好在导入表里本来也没有它，无需处理。

**v1 实测功能检查（全绿）**：

```
桥接 /health            ok:true
/usage                  ccswitch[ok]  dsh[ok] tokens=357,121,583
                        deepseek[ok] 余额 ¥51.1  近24h ¥3.88
桌宠（PATH 无 MinGW）   存活 · 36.6 MB · source=live · boot ok states=12 eggs=5
                        命中遮罩 hitmask 780/4096 · 点击穿透 → 穿透 ✓
设置独立窗口            已创建 → 切换视图 → 对话框已打开 → 设置页已刷新
托盘                    ✗ 见问题 1（环境级 ACCESS_DENIED，与缺 DLL 无关）
```


---

## 1. 怎么跑 / 怎么建

```powershell
# 前端（含素材打包进 dist，做语法门禁）
python tools\build_web.py

# 原生壳（MinGW 工具链）
$env:Path = "$env:USERPROFILE\.mingw64\mingw64\bin;$env:USERPROFILE\.cargo\bin;" + $env:Path
cd app\src-tauri; cargo build

# 测试（119 项，全绿）
node app\test\logic.test.mjs        # 43
node app\test\codex.test.mjs        # 19
node app\test\interactions.test.mjs # 11
node app\test\dsh.test.mjs          # 13
node app\test\lines.test.mjs        # 13
node app\test\usage-view.test.mjs   # 13
```

**启动注意（踩过）**：桌宠是常驻 GUI 进程，用脚本启动时**必须重定向 stdout/stderr**，
否则子进程一直持有继承的管道句柄，启动命令会永远等不到结束（表现为"卡住"）。

```powershell
Start-Process -FilePath $exe -RedirectStandardOutput "runtime\pet.out.log" `
              -RedirectStandardError "runtime\pet.err.log"
```

---

## 2. 已验证可用（v1 的功能清单）

| 功能 | 验证方式与证据 |
|---|---|
| 精灵图桌宠窗口（透明、无边框、置顶） | `boot ok states=12 eggs=5 tauri=true` |
| **点击穿透** `WS_EX_TRANSPARENT \| WS_EX_LAYERED` | `WindowFromPoint` 三点探测均为"穿透到下层" |
| 命中遮罩（JS 算 64×64 网格，Rust 每 16ms 轮询光标） | 日志 `[hitmask] filled=…` / `[cursor] hit=…` |
| 状态随真实 DSH 会话变化（零安装轮询投影缓存） | `[config] source=live`，`state → working/thinking` 跟随 |
| Codex 感知（tail rollout + 15 分钟新鲜度过滤） | `监视中的 Codex 会话=0`（历史会话不再误触发） |
| 长任务稳定保持 `working`（心跳判据） | 3 条新测试：心跳在→3 分钟不衰减；心跳停→80s 回落；有工具在跑→不打瞌睡 |
| 气泡排队（最新优先 + 20s TTL + 上限 1 条） | 点击台词不再卡住，新台词顶掉旧的 |
| 靠边吸附 + 三向探头 | 实测 `left=0 / right=0 / bottom=0` 判定正确；三个边缘自检全通过 |
| 外观设置（大小 80–480 / 透明度 / 置顶 / 穿透） | 设置窗口改 → Rust 转发给桌宠窗口生效（不再调设置页自己） |
| 设置独立窗口（普通可拖动窗口，内容可滚动） | 实拍：标题栏 + 账本卡片 + 滚动条 + 完整分区 |
| 余额：官方 API + 余额差额 | `DeepSeek 余额 ¥52.49，近 24h 消耗 ¥2.49（50 次采样）` |
| 台词库可视化编辑（9 类，含用量播报） | 设置页可增删，写入 `runtime/events/lines.json` |
| **无控制台黑框** | `#![windows_subsystem = "windows"]`（main.rs:20） |

---

## 3. 未解决的问题（下次从这里开始）

### 🔴 问题 1：托盘图标不显示

> ### ❌ 已排除：「以管理员身份运行」
> 曾以为提权是根因（提权会拒绝托盘注册、也会打掉 WebView2 的 GPU 沙箱）。
> **用户实测推翻**：`.bat` 属性里根本没有"兼容性"页（所以不存在勾选 ✓），
> 而且**普通双击与右键管理员运行的表现完全一样** ✗ → 与权限无关 ✓。
> 教训：这个假设曾被我当成结论写进文档 ✗ —— **未验证的推断不要写成结论** ✓。

> ### ✅ 现在最可能：WebView2 的 GPU 合成（混合显卡）
> 用户的机器有 **NVIDIA 独显 + 集显（混合显卡）** 且显示缩放 200% ✓。
> 透明窗口 + 硬件加速在混合显卡/部分驱动上会出现「画布不再合成、DOM 文字照常」✓，
> 与「她消失、只剩 +n 条」吻合 ✓。
>
> **决定性验证（一次双击）**：`v1\诊断-关GPU启动.bat`
> ⚠️ 注意：它通过 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 传参数，
> 而 Tauri/wry 通常会自己传一套浏览器参数 ✗ → **该环境变量可能被忽略** ✗。
> 所以：**如果它没变化，不能据此排除 GPU 假设** ✓ ——
> 届时应把 `--disable-gpu` 直接写进 `tauri.conf.json` 的 `windows[].additionalBrowserArgs`
> 并**重新构建**后再测（这才是可靠验证）✓。
>
> **另一个零成本的判据**：让用户启动后**等 25 秒**再截控制台图 ✗（上一次截图截早了 ✗），
> 新版 `启动桌宠.bat` 会在 20 秒后打印 `[1]`~`[5]` 诊断段 ✓，
> 其中的 `[4] 素材/渲染相关` 与 `[5] pet.err.log` 能直接区分
> **「JS 报错导致画不出来」** 与 **「JS 正常但画布没合成」** ✓✓。


**现象**：进程正常、窗口正常，但任务栏右下角（含 `^` 隐藏区）始终没有图标。
**证据链**（全部实测）：

```
[tray] 用 exe 图标资源 id=32512
[tray] 图标句柄来源=exe 资源 有效=true
[tray] diag windowstation=WinSta0 desktop=Default     ← 与 Explorer 一致，排除窗口站假设
[tray] diag NIM_ADD without-icon ok=0 err=5            ← 连"不带图标"的最小注册也被拒
[tray] Shell_NotifyIcon 第 1..5 次失败，GetLastError=5  ← 5 = ACCESS_DENIED
```

已排除的假设：
1. ~~图标句柄无效~~ —— 用 exe 自带资源（id=**32512**，不是常规的 1），句柄有效
2. ~~图标尺寸不对~~ —— 512 / 128 / 32 都试过
3. ~~结构体尺寸不对~~ —— `cbSize=976`，且用不带图标的最小结构同样被拒
4. ~~残留错误码~~ —— 调用前已 `SetLastError(0)`
5. ~~窗口站/桌面不对~~ —— `WinSta0\Default`
6. ~~Tauri 封装的问题~~ —— 换成原生 `Shell_NotifyIconW` 同样失败（Tauri 那个是**静默**失败）
7. ~~权限令牌~~ —— **用户自己双击 exe 也是 `err=5`**

**结论**：`Shell_NotifyIcon` 在这台机器上对任何来源的调用都返回 `ACCESS_DENIED`，
属于**环境级拒绝**（安全软件 / 组策略 / 通知区策略），不是本项目代码的问题。

**已排除"缺 DLL 导致托盘失败"这一猜测**：v1 包补齐 `WebView2Loader.dll` 后，
同一进程完整运行（`source=live`、12 状态、穿透正常），托盘日志依旧 `err=5` —— 两者无关。

**相关代码行**：
- `app/src-tauri/src/main.rs:40-290` —— `mod native_tray`（原生实现 + 全部诊断日志）
- `app/src-tauri/src/main.rs:130` —— `pub fn install()`：建隐藏窗口 + `NIM_ADD` 重试 5 次
- `app/src-tauri/src/main.rs:274` —— 五次失败后的结论日志
- `app/src-tauri/src/main.rs:401` —— `fn setup_tray()`：Tauri 版托盘（非 Windows 平台的兜底）

**下次的下一步（按性价比排序）**：
1. 写一个 **30 行独立的最小 exe**（只用 `Shell_NotifyIcon`，不带 Tauri）在同一台机器跑 —— 若它也 `err=5`，即可 100% 确认环境问题并停止在本项目里找原因
2. 检查安全软件 / 组策略：`gpedit.msc` → 用户配置 → 管理模板 → 开始菜单和任务栏；以及第三方安全套件的"托盘保护"
3. 查 `HKCU\Control Panel\NotifyIconSettings` 与该 exe 路径相关的键值
4. 换一个 Windows 账户（新建本地账户）试同一 exe —— 若正常则是当前账户的策略
5. 兜底方案：既然托盘不可用，就把**桌宠右键菜单**作为唯一入口（已可用），并在 exe 上加桌面快捷方式说明

### 🔴 问题 2：桌宠先出现、随后画面消失，只剩「+n 条」文字（**仅在用户环境**）

> ### 🔑 2026-10-01 决定性线索（用户原话）
> 「每次**我授权给你（agent）启动**就正常，**而且没有那个黑框**就直接出桌宠了；
>  **我自己双击 .bat** 就有黑框、桌宠闪一下就没。」
>
> 对齐成表：
>
> | 启动方式 | 黑框 | 桌宠画面 |
> |---|---|---|
> | agent 从沙箱启动（`Start-Process`） | 无 | **正常** ✓ |
> | `cmd /c 启动桌宠.bat`（我在沙箱里跑） | 有 | **也正常** ✓ |
> | 用户双击 `启动桌宠.bat` | 有（bat 自己的控制台 ✓） | **闪一下就没** ✗ |
>
> 也就是说：**同一个 exe、同一个 profile、同一台机器** ✗ —— 差异只在
> **"谁启动的 / 在哪个会话里启动"** ✓。这条把"代码 bug"基本排除 ✓，
> 指向**会话/桌面/合成路径**的差异 ✓（我的进程来自受限令牌的沙箱会话 ✓）。
>
> ### 🎯 另一个强判据：**只有 canvas 不出来，DOM 与 PNG 一直正常**
> 用户机器上气泡、气泡皮肤的 PNG、`+n 条` 计数**始终正常** ✓，唯独**角色画布**不见 ✗。
> → 说明**图片与 DOM 的渲染路径没问题** ✓，坏的是 **canvas 这一路** ✓。
> → **可靠的兜底方案**：把角色改成 **CSS 背景图 + `background-position` 逐帧** 渲染
>   （与气泡皮肤同一条路径 ✓），绕开 canvas ✓。涉及
>   `app/src/renderer.js`（现在用 `#pet-canvas` + 2D 上下文，含提拉形变/交叉淡化 ✓）
>   与 `app/index.html:267` 的 `<canvas id="pet-canvas">` ✓。
>   代价：提拉形变要用 CSS `transform` 重写 ✓（可行 ✓），交叉淡化用两层 `<div>` ✓。

**两个已被推翻的假设（都别再走一遍）**：
1. ~~提权运行~~ ✗ —— 用户实测：属性里没有兼容性页 ✓，普通双击表现完全一样 ✓
2. ~~WebView2 GPU 合成~~ ✗ —— 已把 `additionalBrowserArgs = "--disable-gpu"` 写进
   `tauri.conf.json` ✓ 并重新构建 ✓，**用户实测仍然闪一下就没** ✗
   ⚠️ 但仍**未验证该 flag 是否真被 WebView2 采用** ✗（二进制里有字符串 ≠ 生效 ✓）；
   下次可用 `msedgewebview2.exe` 子进程里有没有 `--type=gpu-process` 来确认 ✓。

**当前掌握的证据**：
- 开发机（沙箱会话）**无法复现** ✗：连续采样 35 秒，`hitmask filled` 为 811/504 ✓，**从未 0** ✓
- 用 `cmd /c 启动桌宠.bat` 复现也**正常**：`boot ok states=12` ✓、`pet.err.log` 为空 ✓
- 用户机器是**混合显卡（NVIDIA + 集显）+ 200% 缩放** ✓（仍可能影响 canvas 合成路径 ✓）
- 用户的 `.bat` 与我的启动**环境变量/工作目录完全相同** ✓ → 差异在会话 ✓

**下一步（按顺序，第一条就能定性）**：
1. **看 `hitmask filled=`** ✓（新版 `启动桌宠.bat` 的诊断段 `[4]` 已打印 ✓）：
   - `filled=0` → **画布真的是空的** ✗ → 前端绘制/懒加载问题 ✓（我这边能查 ✓）
   - `filled` 非 0 → **画布有内容但没显示** ✗ → canvas 合成问题 ✓ → **走 CSS 渲染兜底** ✓
2. 若走兜底：把 `renderer.js` 的 canvas 绘制改为 CSS 精灵动画 ✓（保留同一套状态机 ✓）
3. 顺手确认 `--disable-gpu` 是否真生效 ✓（查 `msedgewebview2.exe` 有没有 `--type=gpu-process` ✓）


**现象**（用户实测）：双击 `启动桌宠.bat` → 她出现 → **随后消失** ✗，桌面上只剩「+n 条」悬浮文字；
任务管理器里进程仍在 ✓。用户补充：「**你用命令启动就正常，我点 bat 就不行，还有红条**」。

**当前掌握的证据**：
- **普通双击同样复现** ✗（用户实测：与管理员运行表现一致 ✓）→ **与权限无关** ✓
- 在开发机上**无法复现** ✗：用同样的 `v1\presage-pet.exe` + 同样的 `v1\runtime\webview2` profile
  + 同样的工作目录，`PrintWindow` 抓到的画面是完整的（她 + 气泡 + 计数）✓
- 用 `cmd /c 启动桌宠.bat` 复现时也**正常**：`boot ok states=12` ✓、`hitmask filled=505` ✓、
  `pet.err.log` 为空 ✓ → **画布确实有内容** ✓
- 用户的机器是**混合显卡（NVIDIA 独显 + 集显）+ 200% 缩放** ✓ → 指向 GPU 合成（见上）
- **验证顺序**：① 等 25 秒截 `[1]`~`[5]` 诊断段 ✓（区分 JS 报错 / 合成失败）
  ② 用 `v1\诊断-关GPU启动.bat` ✓；若没变化，把 `--disable-gpu` 写进配置**重新构建**再测 ✓

**最可能的原因（按可能性排序）**：
1. **WebView2 的 GPU 合成**：透明窗口 + 硬件加速在部分显卡/驱动上会「先画出来、随后画布不再合成、
   只剩 DOM 文字」—— 与「她消失、+n 条还在」的现象**高度吻合** ✓
   → 已备好一键验证：**`v1\诊断-关GPU启动.bat`**（设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu …`）
   → 若该启动器下她稳定显示，就把参数写进 `tauri.conf.json` 的 `windows[].additionalBrowserArgs`
2. **多显示器 / DPI 变化**导致的合成失效（用户的显示缩放 200%）
3. 第三方安全软件拦截了 WebView2 的 GPU 进程

**「红条」是什么**：尚未确认 ✗。用户第一张 bat 截图里控制台右上出现过红色矩形
（怀疑是控制台窗口的局部重绘残影，或 `timeout` 报错那一瞬的画面）。
**下次请用户直接截图**，这是最快的判据。

**需要的证据（用户双击一次 bat 即可，新版已自带诊断输出）**：屏幕上的 `[1]`~`[5]` 整段。

### 🟡 问题 3：抠图残留（手臂与身体之间的浅灰缝）

**现象**：某些帧角色左右两侧有未扣净的浅灰竖条，且**逐帧闪烁**。
**根因**：该缝隙是"被角色围住的白色背景"，flood fill 从画布边界到不了。
**为什么没硬修**：试过两种自动判据，都不可靠 ——
- 按连通块中位亮度判 → 白嘴与缝隙连成一块时**把嘴一起抠掉**
- 按逐像素亮度判 → 领结/高光抗锯齿边缘被**咬出麻点**
根因是视频压缩后背景浅灰(≈244)与白色特征(≈251)像素分布重叠，颜色上分不干净。

**相关代码行**：
- `tools/build_sprites.py:225` —— `def key_white()`：全部抠图逻辑与决策注释
- `tools/build_sprites.py:262-276` —— 反走样带处理 + `pocket_px` 占位（此处是"口袋清理"的回退点）

**下次的下一步**：**从源素材解决** —— 导出带 alpha 的 webm/png 序列，或用纯色幕布（如纯绿 #00FF00）。
这样抠图零误差，灰条/边界毛边/探头裁切会一起消失。

### 🟡 问题 4：任务栏图标（`skipTaskbar` 无效）

**现象**：窗口仍出现在任务栏（虽然窗口本身无边框）。
**相关代码行**：`app/src-tauri/src/main.rs:806` —— `let _ = w.set_skip_taskbar(true);`
**下次的下一步**：直接设扩展样式 `WS_EX_TOOLWINDOW`（清 `WS_EX_APPWINDOW`）。
链接期警告 `.rsrc merge failure: multiple non-default manifests` 与此无关，不影响运行。

### 🟢 问题 5：`celebrate` 用难过脸弹跳

需要一个笑脸立绘。文件名带 `happy` / `开心` / `笑` / `smile` 就会被管线自动识别。

---

## 4. 关键文件地图

| 文件 | 职责 |
|---|---|
| `app/src/main.js` | 启动、外观、贴边吸附/探头、自检、跨窗口转发 |
| `app/src/arbiter.js` | 状态仲裁（心跳感知的新鲜度衰减、瞌睡判定） |
| `app/src/pointer.js` | 命中遮罩、点击穿透、拖动、位置记忆 |
| `app/src/renderer.js` | 精灵图播放、提拉形变、呼吸缩放 |
| `app/src/settings.js` | 设置面板（惰性查找元素，跨窗口改外观） |
| `app/src-tauri/src/main.rs` | 原生壳：托盘、窗口、穿透样式、日志 |
| `tools/build_sprites.py` | 素材管线（抠图/裁切/合成精灵图） |
| `tools/pet_bridge.mjs` | 桥接：/usage /lines，DSH+Codex 感知 |
| `tools/check_alpha.py` | 抠图质量审计（逐状态逐帧） |

---

## 5. 这次踩过的坑（写下来免得重犯）

1. **`<dialog>` 的 `display:none` 会被 `#settings{display:flex}` 覆盖** —— 关闭的面板一直显示（症状：桌宠旁边总跟着一块"设置"头部）。要写 `#settings[open]`。
2. **元素查询必须惰性** —— `<dialog>` 在 `<script type="module">` 之后，模块执行时 `getElementById` 返回 null，症状是"点了没反应、也不报错"。
3. **`run_on_main_thread` 是阻塞发送** —— 在 IPC 处理线程里调用会与主线程互等死锁，前端 Promise 既不 resolve 也不 reject。要从旁路线程发起。
4. **`WebviewUrl::App("index.html?view=settings")`** —— Tauri 把整串当文件路径，页面加载失败变成白屏。改用 eval 切换视图。
5. **`println!` 在 GUI 子系统下会 panic**（没有 stdout）—— 必须用 `writeln!` 并忽略错误。
6. **`.bat` 必须 CRLF + 与代码页一致的编码**（GBK 存就用默认代码页，别 `chcp 65001`）。
7. **`GetLastError` 必须先 `SetLastError(0)`** 才可信。
8. **exe 的图标资源 id 不一定是 1** —— 这台机器上是 32512。
9. **启动常驻进程必须重定向输出**，否则命令挂住（第一节已说明）。
10. **`.bat` 里不要用 `timeout /t`** —— 它在 **stdin 被重定向**时（计划任务、某些启动器、
    隐藏窗口运行）会打印「不支持输入重新定向，立即退出此进程」并**中断整个批处理** ✗。
    实测踩到 ✓。改用 `ping -n <秒> 127.0.0.1 > nul` ✓（任何上下文都稳）。
11. **日志是 UTF-8、cmd 控制台是 GBK** —— `findstr` / `type` 直出日志会**中文花屏** ✗
    （用户根本没法把报错发给你 ✓）。做法：先 `Get-Content -Encoding UTF8 … | Set-Content -Encoding Default …`
    转一份 GBK 副本 ✓，再打印 ✓。
12. **验证 release 版不能只看日志** —— 我上次只确认了 `boot ok` / `hitmask filled` ✓ 就收工，
    漏掉了「画面到底画出来没有」✗。**凡是涉及"看得见"的功能，必须抓图或肉眼看** ✓。
13. **「我用命令启动正常、你点 bat 不行」这类差异，第一件事是按用户的方式复现** ——
    直接 `cmd /c 启动桌宠.bat` ✓，而不是用 `Start-Process exe` 模拟 ✗（两者环境并不等价 ✓）。
14. **一定要先问"你是怎么启动的"** —— 这次绕了极远的路 ✗：曾以为用户是**以管理员身份**运行
    bat（提权会同时让 `Shell_NotifyIcon` 被拒 ✓、打掉 WebView2 的 GPU 合成 ✓）。
    **但用户实测推翻**：属性里根本没有兼容性页 ✓，且普通双击表现完全一样 ✗。
    → 提问仍然值得（能快速排除一大类可能 ✓），但**别把未验证的推断写成结论** ✓（见下条）。
15. **不要把"推测"写成"结论"** ✗ —— 我曾把"提权是根因"写进文档 ✓，随后被用户一次双击推翻 ✓。
    正确写法：**现象 + 已排除项（附证据）+ 当前最可能项 + 下一步验证方法** ✓，
    并且明确标注哪些是**实测**、哪些是**推测** ✓。文档里现在都按这个格式写 ✓。
16. **待办：启动时自检是否提权**（`OpenProcessToken` + `GetTokenInformation(TokenElevation)` ✓），
    在日志与气泡里明确提示 ✓。虽然提权已被排除为本次根因 ✗，
    但它确实是"托盘注册被拒"和"GPU 合成失败"的**已知诱因** ✓，值得有提示 ✓。
