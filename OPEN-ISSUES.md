# 未解决问题汇总 · v1.1

> 更新于 v1.1（`V1-BASELINE.md` 同版本）· 项目：`C:\Users\Asus\Desktop\dsh_test\laopu_ds`
> **新对话第一句建议直接粘**：
> 「读 `V1-BASELINE.md` 和 `OPEN-ISSUES.md`。先看 v1.1 修了什么（第 0 节），
> 再看还剩下什么（第 1 节起）。」

---

## 0. ✅ v1.1 修掉的问题（v1 记录的问题 1/2 已定性并解决）

### 0.1 根因：**角色被窗口硬裁掉**（v1 记录里那个"几秒后只剩半截/整个消失"）

**现象（v1）**：前 10 秒正常、能拖能点，随后"红色故障条 + 只剩半截"，再之后"完全消失，
只剩气泡文字与 `+n 条`"。

**v1.1 的实测结论**：这不是"延迟发生的合成失败"，而是**布局几何从第一帧就错了**，
只是错的位置随时间变化（气泡出现/消失、状态切换都会改变她相对窗口的位置）：

```
旧公式（appearance.js）：画布高 = 宽度 × 1.34 = 268px，窗口高 = 画布高 + 202 = 470px
真实素材（tools/measure_sprites.py 量 12 条精灵图）：
    非透明像素高度 ÷ 格子 = 0.875（working/thinking/error/peek_*）
                            0.969（celebrate 弹跳那一帧）
    → 200 宽的角色实际只有 ~175px 高，而代码按 268px 给它留位置
```

于是 `#pet-hit` / `.pet-layer` 的底边被算到窗口底边**以下**，角色下半身直接落在窗口外，
被窗口（不是合成器！）裁掉。窗口尺寸、气泡位置、命中遮罩三者又互相耦合，
所以"哪一半被裁掉"会随气泡与状态变化 —— 用户看到的就是"半截 → 消失"。

**v1.1 的解法**（结构性，不靠调参）：

| 改动 | 文件 | 为什么 |
|---|---|---|
| 窗口高 = 角色实际占高（`size × 0.98`）+ 气泡区（116） | `app/src/appearance.js` | 不再用精灵格高度，窗口刚好装得下她 + 气泡 |
| 画布 / 命中盒 / 精灵格 **三者同尺寸**（`size × size`） | `app/src/renderer.js`（`HEADROOM = 0`） | "遮罩坐标 == 眼睛看到的坐标"结构性成立 |
| 角色用 `bottom` 锚在窗口底边，气泡用 `bottom` 锚在"头顶 + 8% 重叠" | `app/index.html` | 气泡不再通过负 margin 拉动角色（v1 的 `margin-bottom: -Npx` 会把她拉出窗口） |
| 删掉 `#bubble-list { position: relative }` 这条重复规则 | `app/index.html` | 它把上面的 `position: absolute` 覆盖掉了，`bottom` 直接失效 —— 气泡被放到窗口**上方**（实测 `bubble.y = -226`） |
| 尺寸上限跟屏幕走（`maxSizeForScreen()`），设置页滑块同步 | `app/src/appearance.js` / `settings.js` | v1 允许调到 480，窗口高 845px > 可用高度，脚永远在屏幕外 |

**验证方式（可复现）**：
```powershell
# 三档尺寸都不许被裁：clipped 必须为 0
$env:WEBVIEW2_USER_DATA_FOLDER = "$PWD\runtime\wv2-geom"   # 必须在工作区内，见第 3 节
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333 --remote-allow-origins=* --disable-gpu"
Start-Process -FilePath "$PWD\v1\presage-pet.exe" -WorkingDirectory "$PWD\v1" `
  -RedirectStandardOutput "$PWD\runtime\sz.out.log" -RedirectStandardError "$PWD\runtime\sz.err.log"
node tools\set_size.mjs 200   # {"clipped":0,"bubbleTop":32}
node tools\set_size.mjs 320   # {"clipped":0,"bubbleTop":38}
node tools\set_size.mjs 480   # {"clipped":0,"bubbleTop":42}
python tools\see_pet.py --out runtime\shot.png   # 肉眼看整只都在
```

### 0.2 新增：**几何自检日志**（这类问题不再需要截图猜）

`app/src/main.js` 的 `logGeometry()` 每次启动 / 改尺寸 / 气泡变化都会打一行：

```
[front] [geom:boot] OK win=380x351 dpr=2 screen=1280x752 pos=(125,51) size=240
        pet=(70,104,240,240) petBottom=9.59px 裁掉=0px 出屏=0px
        bubble=(左115 上61 186x64) 尾巴压住头顶=106px 气泡出框=0px
```

`裁掉=0` / `出屏=0` / `气泡出框=0` 三个数任何非 0，就是确定性的几何故障，
并且这一行会直接指出是"角色被窗口裁"还是"气泡跑到窗口外"。

### 0.3 状态抖动（同一秒内 `idle→thinking→celebrate→idle`）

**v1 症状**：日志里满屏 `state → working（上一状态 thinking 持续 0.0s）`，
画面上她不停抽搐；`working` 是 `once_loop`（先"拿出电脑"再打字），
每次重进都从头播 → 用户**永远看不到打字那一段**。

**两个真 bug**（都在 `app/src/arbiter.js`）：

1. **防抖记账每次都被刷新**：`resolve()` 每 200ms 被调一次（tick + 每次事件），
   原实现在里面写 `_pendingSince = now`，于是 `now - _pendingSince` 永远是 0，
   2.2s 的窗口**永远满足不了**，状态反而每次都被放行。
2. **一次性动画可以随意被抢**：`celebrate`（1.4s 素材动画）会被下一轮的
   `idle` 立刻打断 —— `TURN_END` 与下一个 `TURN_START` 常常只差几十毫秒。

**解法**：
* 记账只在"候选动画变化"时写时间戳；
* 新增 `ANIM_PRIORITY`：`celebrate(30)` 挡得住 `idle(5)`，挡不住
  `thinking(55)/working(65)`（所以"新工作开始时该演什么"这条老规则仍然成立）；
* `CELEBRATE_MS` 由 3000 改成 **1400**，与素材 16 帧 @12fps = 1.33s 对齐
  （以前跳完了还要愣在那里 1.7 秒）；
* 日志里那个恒为 `0.0s` 的"上一状态持续"改成仲裁器给的 `heldMs`
  （日志现在是 `持续 0.8s/0.8s`）。

**测试**：`app/test/logic.test.mjs` 新增 3 条（47 项全绿），其中
「事件把状态反复打断时，动画必须稳定在一个值上」就是照着用户日志复现的。

### 0.4 启动器重写（"测试里能启动、双击 bat 就失败"）

v1 的启动器有两个结构性毛病：

| 问题 | v1 现象 | v1.1 做法 |
|---|---|---|
| 用 `powershell -Command Start-Process ... -RedirectStandardOutput` 启动 | 进程树多一层 `powershell.exe`；双击时控制台一闪、桌宠跟着抖动 | 直接 `start "" /b /d "..." exe`：进程树里只有桌宠，和手动双击 exe 完全一致 |
| 两份启动逻辑（根目录 / `v1\`）各自修 | "v1\ 里修好了、根目录那份还是旧的"，两个入口现象不同 | **只有一份实现**（根目录 `启动桌宠.bat`），`v1\启动桌宠.bat` 只做转发 |
| WebView2 profile 被反复强杀写坏 | profile 一坏，之后每次启动都是 `0x8000FFFF 灾难性故障`，日志空白 | profile 固定为 `runtime\webview2`；看到 `.boot-failed` 标记或"12 秒后进程不在"就**自动删掉重建并重试一次** |
| 环境依赖 | 只认 DSH 自带的 node、依赖工作目录 | node 回落到 PATH；`start /d` 显式给工作目录；缺 `WebView2Loader.dll` 直接提示（否则双击 exe 静默秒退 `0xC0000135`） |

另外补了两条兜底（`app/src-tauri/src/main.rs`）：
* **提权自检**：日志里 `[env] 提权=否`（`OpenProcessToken` + `GetTokenInformation`，
  不再靠"是不是右键管理员运行"猜）；
* **托盘不可用时的退路**：日志 `[hotkey] Ctrl+Alt+Q 退出=ok Ctrl+Alt+S 设置=ok`，
  并让前端弹一条常驻提示气泡（"右键我 → 设置/退出；或按 Ctrl+Alt+S / Ctrl+Alt+Q"）。

### 0.5 用户实测反馈后补修的三处（v1.1 第二版）

| 现象（用户实测） | 根因 | 修法 |
|---|---|---|
| 启动器自检段 `[2]`~`[5]` **全是空的**，而桌宠明明在跑 | 桌宠是往"自己的当前目录\runtime\pet.out.log"写日志；在 `v1\启动桌宠.bat` 这条路径下工作目录是 `v1\`，日志落在 `v1\runtime\`，而启动器只看 `<根>\runtime\` | 启动器用 `:findlog` 在**两个候选目录**里轮询 12 秒（v1.1 的 `-NoWait` 与 `-Diag` 都受益）；顺带修掉 `%PETDIR%runtime` 少了反斜杠导致候选 2 显示成 `v1runtime` 的拼接 bug |
| **在不同高度右键，菜单会被窗口裁掉**（越靠下越严重） | 菜单固定约 **160px** 高（5 个按钮 × (20px 行高 + 10px 内边距) + 内边距），而窗口只比角色大一点：`size=320` 时头顶以上只剩 **104px**。菜单物理上放不下。另外旧代码用写死常量 `innerWidth - 140` / `innerHeight - 120` 夹取，和真实尺寸也对不上 | 两件事一起做：① `pointer.js` 新增纯函数 `placeMenu()` —— 量真实尺寸、下方放不下就翻到光标上方、两轴都夹进窗口（**已加单测**，覆盖整条对角线）；② `main.js` 新增 `anchorWindow()/releaseWindow()`：菜单打开时**临时把窗口撑高到刚好装下**（以角色脚底为锚点，她自己不跳），关闭时立刻还原。设置面板的临时放大也改用同一套逻辑（原来那段写死的 580x660 夹取一并删除） |
| 托盘图标在你自己的会话里也是 `err=5` | 待定性（见下） | 兜底已生效：气泡提示 + `Ctrl+Alt+S/Q` |

> ⚠️ 关于上表第 1 条：这也解释了为什么 v1 文档里"用户双击时 `NIM_ADD err=5`、agent 启动时 ok=1"
> 那个观察**不可靠** —— 两次读的可能不是同一个文件。

---

## 1. 🟡 仍未解决（按用户决定处理）

### 1.1 【已降级为已知限制】托盘图标不出现（`Shell_NotifyIcon` → `ACCESS_DENIED`）

**决定（用户 2026-10-01 指示）**：**这个版本不再排查托盘**，降级为"已知限制"写进文档，
保留以后修改的可能。同时要求：**不要每次启动都提示一遍**。

**已实现**：
* 提示改为**只提示一次** —— `main.js` 的 `notice()` 用 localStorage
  （`presage-pet.tray-notice-shown`）记账，同一个 profile 里第二次启动不再弹；
  日志里会写 `托盘提示已提示过，跳过（避免每次启动都弹）`。
* 兜底入口保持不变且已实测可用：右键菜单（含设置/退出）+ 全局热键
  `Ctrl+Alt+S`（设置）/ `Ctrl+Alt+Q`（退出），日志 `[hotkey] …=ok`。

**事实记录（供以后需要时接手）**：

| 证据 | 值 | 说明 |
|---|---|---|
| `NIM_ADD` 不带图标的最小注册 | `ok=0 err=5`（ACCESS_DENIED） | 桌宠日志，你自己的会话里也一样 |
| 窗口站 / 桌面 | `WinSta0` / `Default` | 与 Explorer 一致，**排除**窗口站假设 |
| 提权 | `[env] 提权=否` | **排除**提权 |
| 图标句柄 / 结构体 | 句柄有效（exe 资源 id=32512）、`cbSize=976`、已 `SetLastError(0)` | 排除句柄/尺寸 |
| **我的沙箱会话里 `explorer.exe` 数量** | **0** | ⚠️ 见下 |

### 🔑 一个把之前的结论全部推翻的发现

**我这个沙箱会话里根本没有 `explorer.exe`**（shell 不在），
所以"托盘注册被拒"在我这边是**必然**的 —— `Shell_NotifyIcon` 需要通知区宿主，
没有 shell 就返回 ACCESS_DENIED。用 `tools/tray_min_probe.ps1`（只调
`Shell_NotifyIconW`，不带 Tauri/WebView2）在本会话实测同样是 `err=5`。

**这意味着**：v1 文档里所有"我在沙箱里测到 `err=5`，所以是环境问题"的推理，
只能证明**我的会话**没有 shell，**不能**直接推广到你的会话。这条得撤回到"未定性"。

**但同时发现一条反向证据**：`HKCU\Control Panel\NotifyIconSettings` 里存在

```
子项 8587569681505809175
  ExecutablePath : …\laopu_ds\v1\presage-pet.exe
  InitialTooltip : 普瑞塞斯 · 桌宠
```

这个键**只在 `Shell_NotifyIcon(NIM_ADD)` 成功时**才会被 shell 写入。
也就是说：**这台机器上至少成功注册过一次**。所以你"看不到图标"更可能是
**被收进了隐藏区（任务栏那个 `^` 里）**，而不是注册失败。

**请你确认两件事（各 10 秒）**：
1. 任务管理器里 `explorer.exe` 是否在跑（进程名就写 `explorer.exe`）；
2. 点任务栏的 `^`（显示隐藏的图标）—— 普瑞塞斯的图标是不是在那儿。

（如果确实在隐藏区：那"托盘不可用"这件事就已经解决了 —— 把它的图标拖到任务栏
可见区即可，`IsPromoted` 那个值就是干这个的。）

**如果确认 Explorer 在跑、隐藏区里也没有**，再按下面排序排查：
1. 安全软件 / `gpedit.msc → 用户配置 → 管理模板 → 开始菜单和任务栏`；
2. `HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer` 里的
   `NoTrayItemsDisplay` 之类的项（本次检查过：**没有**这类策略）；
3. 换一个 Windows 本地账户试同一 exe；
4. 重启 explorer.exe 后再启动一次桌宠。

### 1.2 抠图残留（手臂与身体之间的浅灰缝）

**现象**：某些帧角色两侧有未扣净的浅灰竖条，逐帧闪烁。
**根因**（v1 已定性，不变）：那是"被角色围住的白色背景"，flood fill 从画布边界到不了；
视频压缩后背景浅灰(≈244)与白色特征(≈251)像素分布**重叠**，颜色上分不干净。
**代码**：`tools/build_sprites.py` 的 `key_white()`（含完整决策注释）。
**正解**：**从源素材解决** —— 导出带 alpha 的 webm/png 序列，或用纯色幕布（如纯绿 `#00FF00`）。

### 1.3 任务栏图标（`skipTaskbar` 无效）

窗口仍出现在任务栏。代码：`app/src-tauri/src/main.rs` 里 `w.set_skip_taskbar(true)`。
**下一步**：直接设扩展样式 `WS_EX_TOOLWINDOW`（清 `WS_EX_APPWINDOW`）。
链接期警告 `.rsrc merge failure: multiple non-default manifests` 与此无关。

### 1.4 `celebrate` 用难过脸弹跳

需要一张笑脸立绘。文件名带 `happy` / `开心` / `笑` / `smile` 会被管线自动识别。

---

## 2. v1.1 新增的工具（排障用，别删）

| 工具 | 用途 |
|---|---|
| `tools/measure_sprites.py` | 量每条精灵图真实的非透明包围盒 → 布局参数的**唯一依据**（`h/cell`、`bottom_gap`） |
| `tools/see_pet.py` | 抓**屏幕**（DWM 合成结果）里桌宠窗口的像素，并给出逐段占比 —— 肉眼看"她到底在不在" |
| `tools/set_size.mjs` | 通过 CDP 让运行中的桌宠改尺寸，并回报 `clipped` / `bubbleTop` |
| `tools/geom_probe.mjs` | CDP 读整页几何（`innerWidth/Height`、`#pet-hit`、`.pet-layer`、`bubble` 的 rect） |
| `tools/win_watch.ps1` / `win_probe.ps1` | 按"用户的启动方式"（`cmd /c bat`）启动并连续抓图 |

**一条重要区别**（v1 浪费过很多时间的地方）：
`PrintWindow` 对分层（透明）窗口**不可信** —— 它返回的画面和屏幕上看到的不是一回事。
判断"她有没有画出来"要用 `tools/see_pet.py`（BitBlt 屏幕）或让用户截图。

---

## 3. 环境与验证方式（重要）

```powershell
# 构建
$env:PYTHONIOENCODING = "utf-8"      # 否则 build_web.py 在 GBK 控制台报错
python tools\build_web.py            # 前端语法门禁 + 装配 app/dist
cd app\src-tauri; cargo build --release   # 约 1 分钟（release 必须重跑，前端是编进 exe 的）

# 测试（112 → 115 项，全绿）
node app\test\logic.test.mjs        # 47
node app\test\codex.test.mjs        # 19
node app\test\interactions.test.mjs # 11
node app\test\dsh.test.mjs          # 13
node app\test\lines.test.mjs        # 13
node app\test\usage-view.test.mjs   # 13

# 启动（自己测的时候必须重定向输出，否则命令挂住）
Start-Process -FilePath "$PWD\v1\presage-pet.exe" -WorkingDirectory "$PWD\v1" `
  -RedirectStandardOutput "$PWD\runtime\pet.out.log" -RedirectStandardError "$PWD\runtime\pet.err.log"

# 日志
v1\runtime\pet.out.log                # exe 的 stdout（工作目录 = v1）
%LOCALAPPDATA%\PresagePet\pet.log     # 总是可写的那一份
```

### ⚠️ 在 DSH 沙箱里跑桌宠时，WebView2 profile 与 TEMP 相关的坑

DSH 的沙箱**不允许 `msedgewebview2.exe` 子进程在工作区之外创建 profile 目录**。
在那里失败的样子是 `HRESULT 0x8000FFFF「灾难性故障」` ——
和"profile 被写坏"**长得一模一样**，极容易误判。实测对照：

| profile 位置 | 沙箱内 |
|---|---|
| `<工作区>\runtime\wv2-*` | ✅ 能起 |
| `<工作区>\v1\runtime\wv2-*` | ✅ 能起 |
| `%TEMP%\wv2-*` | ❌ 0x8000FFFF |
| `%LOCALAPPDATA%\PresagePet\wv2-*` | ❌ 0x8000FFFF |

所以：**自己在沙箱里测的时候，`WEBVIEW2_USER_DATA_FOLDER` 必须指到工作区内**。
用户双击 `启动桌宠.bat` 时用的是 `runtime\webview2`（在工作区内），不受这条限制。

**用户环境要点**：Windows · 显示缩放 **200%** · 混合显卡（NVIDIA + 集显）·
非管理员 · **没有 PowerShell 7**（只有 5.1）· MinGW-w64 在 `~/.mingw64/mingw64/bin`。
