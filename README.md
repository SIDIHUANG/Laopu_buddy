# 普瑞塞斯桌宠（Presage Pet）

一个常驻桌面的普瑞塞斯（明日方舟）Q 版挂件：**看钱**（DeepSeek / Codex 的用量与余额）+
**看活**（DSH 与 Codex 谁在思考、谁在等你、谁完成了），并把状态翻译成动画和气泡。

**独立应用，不依赖 DSH 是否打开。**

![状态总览](assets/preview/all_states_motion.png)

---

## 现在能跑到什么程度

| 模块 | 状态 |
|---|---|
| 素材管线（去水印 / 抠白底 / 抽帧 / 程序化 / 精灵图 / 逐状态裁剪 / 镜像 / 九宫格 UI） | ✅ 已验证 |
| 协议契约 `AGENT_LINK_PROTOCOL v1` | ✅ 已落地并被实现消费 |
| 运行时核心（仲裁 / 气泡队列 / 懒加载 / 四种播放语义） | ✅ 62 项单测通过 |
| Codex 状态感知（tail rollout → adapter → 状态机） | ✅ 在 6 份真实日志上回放验证 |
| **DSH 状态感知（零安装：轮询会话投影快照）** | ✅ 在本机当前会话上活体验证 |
| 开发期实时通道（桥接进程 + SSE） | ✅ 端到端验证 |
| **点击穿透**（60Hz 命中检测 + 迟滞切换） | ✅ 已按扩展样式翻转验证 |
| **拖拽（自绘移动 + 提拉形变）+ 位置记忆** | ✅ 窗口位移与 lift 状态均已验证 |
| **气泡皮肤**（用户素材九宫格，尾巴压住角色头顶） | ✅ 已目视确认 |
| **气泡堆积治理**（最多 2 条 + 新回合收走旧通知） | ✅ 已实现并单测 |
| **点击互动 / 彩蛋注册表** | ✅ 框架就绪（内置自检已验证链路），素材待补 |
| 状态数 | ✅ 12 个（含底部/右侧/左侧三种探头） |
| **DSH 桥接插件（通道 B，增强项）** | ⚠️ 已写好，**尚未安装**（装了延迟更低，但不装也能用） |
| **用量 / 余额数据层**（CC Switch 只读账本 + DeepSeek 余额 + 本地用量） | ✅ 真实数据已验证 |
| **设置页**（提供方配置 + 台词库开关） | ✅ 已目视确认 |
| **台词库**（9 类 · 按事件绑定 · 去重 · 整活向降权） | ✅ 已在运行时触发验证 |

---

## 目录结构

```
avatar_baseline/   源素材（5 张立绘 + 3 段 AI 视频，只读）
assets/            管线产出：manifest.json + states/*.png（每状态一条 strip）+ preview/
tools/             素材管线、桥接进程、诊断与测试脚本
app/               前端（零构建 ES 模块）+ src-tauri/（Tauri 2 外壳）
dsh-bridge/        DSH 桥接插件
docs/              AGENT_LINK_PROTOCOL.md —— 全项目唯一接口契约
runtime/events/    开发期事件落盘位置
```

---

## 快速开始

```powershell
# 1) 生成精灵图（需要 ffmpeg，见下方「环境」）
python tools/build_sprites.py

# 2) 装配前端
python tools/build_web.py

# 3) 浏览器里看它动（demo 源，自己推进状态）
python -m http.server 8791 --directory app/dist
#    打开 http://127.0.0.1:8791/?debug=1

# 4) 接真实 Agent（Codex rollout + DSH 会话投影，均零安装）
node tools/pet_bridge.mjs
#    打开 http://127.0.0.1:8791/?source=live&debug=1

# 5) 构建并运行桌面应用（默认 demo 源；PRESAGE_SOURCE=live 接真实 Agent）
pwsh -File tools/build_app.ps1
#    $env:PRESAGE_SOURCE = 'live'   # 让应用吃真实事件而不是演示事件
#    $env:PRESAGE_SELFTEST = '1'    # 顺带跑一次交互自检（点击 + 拖拽）
```

### 浏览器预览的快捷键

| 键 | 作用 |
|---|---|
| `1`–`7` | 强制切到 idle / thinking / waiting / error / celebrate / doze / sleep |
| `0` | 解除强制 |
| `a` / `e` / `d` | 注入审批请求 / 错误 / 完成事件 |

---

## 环境（Windows，实测踩过的坑）

**不需要管理员权限。** 用 GNU 工具链而不是 MSVC，可以跳过几个 GB 的 VS Build Tools。

```powershell
# Rust：装 GNU 工具链
winget install Rustlang.Rustup
rustup default stable-x86_64-pc-windows-gnu
```

### 坑 1：crates.io 直连会长时间停滞

实测直连 20 分钟只下到 176/416 个包且不报错、就这么卡着。写入 `~/.cargo/config.toml`：

```toml
[source.crates-io]
replace-with = 'rsproxy-sparse'

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[registries.rsproxy]
index = "sparse+https://rsproxy.cn/index/"

[net]
git-fetch-with-cli = true
```

换镜像后同样的构建几分钟走完。

### 坑 2：GNU 工具链缺 binutils，`dlltool` 用不了

会依次遇到两个错误：

```
error calling dlltool 'dlltool.exe': program not found
# 把它加进 PATH 之后，变成：
error: dlltool could not create import library ... dlltool.exe: CreateProcess
```

原因：rustup 的 `rust-mingw` 组件只给 `dlltool.exe` / `ld.exe` / `gcc` 包装器，
**不含 `as`、`ar`**。而 rustc 在 `raw-dylib` 链接模式下要调 `dlltool` 生成导入库，
dlltool 又需要汇编器 —— 于是失败。`windows-sys`、`parking_lot_core` 都会触发。

解决：装一份完整 MinGW-w64，并把它的 `bin` 放在 PATH **最前面**。

```powershell
$url = "https://gh-proxy.com/https://github.com/brechtsanders/winlibs_mingw/releases/download/16.2.0posix-14.0.0-ucrt-r2/winlibs-x86_64-posix-seh-gcc-16.2.0-mingw-w64ucrt-14.0.0-r2.zip"
curl.exe -L --retry 8 -C - -o "$env:USERPROFILE\winlibs.zip" $url
Expand-Archive "$env:USERPROFILE\winlibs.zip" "$env:USERPROFILE\.mingw64" -Force
```

> 直连 GitHub Releases 实测只有 **57 KB/s**（261 MB 要 76 分钟），
> 经 `gh-proxy.com` 可到 **~15 MB/s**（17 秒）。
> `tools/build_app.ps1` 会自动探测 `~/.mingw64/*/bin` 并加进 PATH。

### 坑 3：脚本执行策略

`tools/build_app.ps1` 可能被执行策略拦住：

```
无法加载文件 ...build_app.ps1。未对文件进行数字签名。
```

用 `powershell -ExecutionPolicy Bypass -File tools/build_app.ps1`，或者把脚本内容直接粘进会话执行。

### 坑 3：ffmpeg

本机没装独立 ffmpeg，但**剪映自带**一个，管线会自动探测：

```
%LOCALAPPDATA%\JianyingPro\Apps\<版本>\ffmpeg.exe
```

也可用环境变量 `PRESAGE_FFMPEG` 指定。注意剪映这个构建 `--disable-ffprobe`，
所以本项目不依赖 ffprobe（mp4 规格是直接解析 box 结构拿到的）。

### 坑 4：素材是白底带水印的 AI 图
管线用「**从画布边界 flood fill 连通背景**」而不是亮度阈值来抠白底——
这样角色内部的白色（领结、眼睛高光）不会被抠穿。水印按「浅灰 + 低饱和」精确清除，
实测五张图水印位置完全一致，且都在纯背景区域，不会伤到角色。

### 坑 5：Tauri 启动即崩 `Failed to setup app: 拒绝访问。(os error 5)`

WebView2 需要在 `%LOCALAPPDATA%\<identifier>` 下建立用户数据目录。在被沙箱/ACL 限制的
开发环境里这一步会被拒，应用直接 panic。验证时可把数据目录指到可写位置：

```powershell
$env:WEBVIEW2_USER_DATA_FOLDER = "$pwd\runtime\webview2"
```

普通桌面环境下不会遇到，**不需要**把它写进产品配置。

### 坑 6：PowerShell 写文件会带 BOM

`Set-Content -Encoding UTF8` 在 Windows PowerShell 5.1 下会写入 **UTF-8 BOM**，
而 `tauri.conf.json` 的解析器会因此报 `expected value at line 1 column 1`，
构建静默失败、跑的还是旧二进制。**改配置请用编辑器/`edit` 工具，不要用 `Set-Content`。**

---

## 已知问题

| 问题 | 状态 |
|---|---|
| `skipTaskbar: true` 未生效——窗口仍出现在任务栏（扩展样式是 `WS_EX_APPWINDOW` 而非 `WS_EX_TOOLWINDOW`，配置与运行时 `set_skip_taskbar` 都试过） | 待修 |
| 探头素材（1280×720 宽画幅）目前按普通状态渲染；要做成"贴着屏幕下边缘探出来"还需要把窗口对齐到屏幕边缘，并在贴边时切换成贴边版素材 | 待做 |
| 链接期警告 `linker stderr: .rsrc merge failure: multiple non-default manifests` | 待查（不影响运行） |
| 用量/余额数据层与设置页尚未实现 | 待做 |
| DSH 桥接插件已写好但未安装（安装需重载 DSH，会中断会话） | 待确认 |


---

## 设计要点（都踩过坑）

1. **上层永不接触任何 Agent 的原始日志格式。** DSH 的会话日志是 zstd 压缩的、
   Codex 的是明文 JSONL、将来还有别的——差异全封在 adapter 里。
2. **`seq` 由事件的产生者分配，绝不沿用源日志行号。** Codex 的 `ordinal` 按会话分文件、
   各自从 0 开始，直接拿来做全局去重会让第二个会话的事件被整段丢弃。
3. **循环接缝要靠播放语义解决，不靠挑帧。** 早期版本为了"闭合循环"去挑首尾最像的窗口，
   结果系统性选中了**最不动的 0.67 秒**（sleep 段只保留 6% 运动量，抽出来就是张固定图）。
   现在改为整段均匀采样 + `pingpong` 往返播放，往复运动天然无缝。
4. **新鲜度衰减是保险丝。** 任何"活跃"状态超过 45 秒无新事件强制回落 idle，
   防止 Agent 崩溃导致宠物永久转圈。超过 5 分钟无事件则播 `doze` 趴下、再进 `sleep` 打呼。
5. **等待类状态不可被覆盖。** 多个 Agent 同时等你时，动画只演最高优先级，
   但气泡全部保留，并合并成「DSH 和 Codex 都在等你」。
6. **忙优先于庆祝。** 宠物是状态显示器，新工作开始时演庆祝会误导人。
7. **Codex 没有审批事件（已实测确认）。** 扫描 22 份真实日志（约 1.1 万行），
   `approval`/`permission` 关键字只出现在配置字段与命令文本里，不存在事件。
   所以 Codex 侧**不上报**"等待审批"——宁可不报，也不要猜错让你白跑一趟。
8. **比例要按素材画幅统一，不能按内容包围盒。** 按包围盒会让每个姿势都填满格子：
   驼背、躺姿这些包围盒更小的姿势被放大，切状态时大小就跳。按画幅缩放后，
   各状态角色占屏尺寸实测集中在 198~218px（极差 20px）。
   少数本身就是放大构图的素材（`sleep.png`）再用 `SCALE_TWEAK` 手调。
9. **点击穿透要自己管 `WS_EX_TRANSPARENT`。** Tauri 的 `set_ignore_cursor_events(false)`
   只加不减：调用它之后窗口会**永远保持穿透**，日志说成功、实际点不到。
   现在由 Rust 直接读写这一位（`set_click_through`），实测透明区穿透、角色区可交互。
10. **忙碌组内要防抖。** 一个 200ms 的工具调用不该让动画闪一下键盘又闪回去；
    800ms 停留才提交。但「等待/出错」永远立即生效。
11. **气泡用九宫格素材，且必须 `box-sizing: border-box`。** 否则 `max-width` 只算内容盒，
    加上 border-image 的左右边框后整体超出窗口、左边缘被截断（实测踩到过）。
    尾巴位置由素材自动量出（`tailRatio`），前端据此平移，让尾巴对准角色头顶。
12. **拖拽和点击要分开。** 若 `mousedown` 直接 `startDragging`，OS 的拖拽循环会吞掉点击，
    彩蛋与气泡就都点不了了。现在是"位移超过 4px 才算拖拽，否则抬起算一次点击"。
13. **不要用 Tauri 的 `startDragging()` 做拖拽。** 它在 Windows 上会进入 OS 的模态拖拽循环，
    期间 WebView 的 `requestAnimationFrame` 被卡住 —— 症状是「窗口能拖，但提拉动画完全不动」。
    现在由前端按指针位移自己调 `setPosition`：渲染循环照常跑，形变才看得见。
14. **气泡的显示位是稀缺资源。** 规划不当就会"命令一多堆满头顶"。现在的策略是：
    最多同时显示 2 条（等待类优先占位），其余折叠成 `+N`；**新回合开始时把上一轮的完成/错误
    通知收进折叠历史**（旧通知已经过时）；出错不再永久常驻（60 秒后折叠）。
15. **气泡要压到角色头顶。** 压多少不写死：按**最高状态的实际内容高度**算一次
    （`on_screen_px`），得出头顶距画布頂的距离，再压进去 12px。
    用固定值而不是跟随当前状态，是为了避免切状态时气泡上下飘。
    实测 `尾巴压住头顶=34px`、尾巴与画布中线偏差 `0px`。
16. **DSH 感知可以零安装。** DSH 会把会话投影快照实时写到
    `~/.dsh/storages/session_projcache/sessions/<session>.json`（亚秒级刷新），
    里面就有回合开关、正在跑的工具、**正在等你回答**、以及用量。
    这是设计里承诺的「轮询保底」通道，实测在本机当前会话上跑通 —— 不需要装任何东西。
17. **前端语法错误要拦在装配阶段。** ES 模块的语法错误**在浏览器里才知道**，
    而 Tauri 把 dist 在编译期嵌进 exe —— 一个变量重名就能让角色整块不渲染、却一路构建成功
    （实测踩过一次：新增的 `step` 与帧间隔的 `step` 重名）。
    现在 `tools/build_web.py` 会用 `node --check` 逐个校验 + 静态检查模块引用，不通过就不产出 dist。
18. **启动失败必须写日志。** `boot().catch()` 原来只把错误写进 DOM，native 日志一片空白，
    桌面窗口"什么都没有"却完全查不出原因。现在启动失败会打 `BOOT-FAILED` 加完整栈。
    另外 `index.html` 里还有一段**内联的早期错误通道**：模块图加载/求值失败时，
    `main.js` 里的处理器根本还没注册，必须由页面最前面的脚本兜住。
19. **native 日志要逐条 flush。** Rust 的 stdout 重定向到文件时是**块缓冲**，
    不显式 flush 就看不到输出，会让人误判成"进程没起来/没报错"。所有日志都走 `logln()`。
20. **声明位置就是正确性。** `bridgeUrl` 曾在第 328 行声明、第 206 行使用 ——
    设置页一引用就触发 TDZ，**整个前端不启动**。配置类变量一律在函数开头定下来。
21. **台词不能顶掉事实。** 气泡标题放台词（保留状态色），正文仍然放事实
    （"要执行 git push" / "命令返回非零退出码"）。否则有了性格、丢了信息。
22. **用量数据层放在桥接进程，不放在页面里。** 页面是 WebView，跨域会被 CORS 挡；
    桥接进程本来就在本机跑，顺带做网络查询最省事，而且**密钥不出本机**
    （只存 `runtime/usage.json`，页面只拿余额数字，不拿密钥）。
23. **词库不写死在程序里。** 台词落在 `runtime/lines.json`，设置页可以逐类增删、
    一键恢复默认；内置词库只作为**种子**。这样"改一句话"不需要改代码、更不需要重新构建。
24. **气泡里的字号要比外面小。** Windows 的"文本大小"辅助功能会整体放大文字
    （本机实测放大到约 1.26 倍，13px 的汉字实际占到 16.4px），
    结果一句台词要折三行。现在气泡标题 11.5px、正文 10.5px，并收窄了左右描边以腾出正文宽度。
25. **一次只显示一条气泡。** 两条挤在一起既不好看、也看不清台词；其余折叠成 `+N`。
    另外把 `codex` 这类小标签从标题行挪到正文行右下角 —— 它在标题行会占掉约 45px，
    直接导致台词多折一行。

---

## 台词库

词库在 `app/src/lines.js`，按事件绑定：

| 类别 | 绑定 | 触发时机 |
|---|---|---|
| `lowBalance` | 余额阈值 | 用量事件里余额低于阈值（默认 5），充回来自动解除 |
| `working` | 任务进行中 | 进入 working 时按 35% 概率 |
| `done` | 任务完成 | 回合正常结束 |
| `waiting` | 等待确认 | 收到审批/提问事件 |
| `clickArt` / `clickFun` | 点击 | 每次点击二选一，**整活向权重 0.6**（彩蛋而非主旋律） |
| `error` | 出错 | 错误事件 |
| `idle` | 长时间空闲 | 进入趴下（doze）时 |
| `provider` | 切换数据源 | 设置页保存后 |

**不重复**：每类记住最近 4 条，抽签时排除；一类用完一轮再重置。
**可关闭**：设置页有开关，关掉就只说事实不说台词（偏好存 localStorage）。

**可自定义**：设置页 →「台词库」，逐类展开即可增删，或一键「恢复默认」。
改动落到 `runtime/lines.json`，**改完立即生效、不用重启**（也可以直接手改这个文件）。
某类有自定义内容时**以自定义为准**（不是追加）；清空自定义即回到内置词库。
想加一个新类别的话，才需要在 `app/src/lines.js` 的 `CATEGORIES` 里加一项。

接口：`GET /lines`（读生效词库）、`POST /lines`（`{category, action: add|remove|reset, text}`）。

---

## 用量 / 余额

数据层在 `tools/usage.mjs`（桥接进程里跑），三条来源：

| 提供方 | 来源 | 需要配置吗 |
|---|---|---|
| `ccswitch` | **只读** CC Switch 的 sqlite 账本（`proxy_request_logs` / `usage_daily_rollups`） | 不需要，开箱就有真实用量与花费 |
| `deepseek` | 官方 `/user/balance` | 需要 api-key（可选） |
| `codex` / `dsh` | 各自 adapter 的 `usage/update` 事件 | 不需要 |

设置页：右键 → 设置。窗口会自动放大到 580×660，关掉恢复原尺寸。
接口：`GET /usage`（读）、`POST /usage/config`（写，白名单字段）。

26. **验证要验"用户看得见的结果"，不要验"自己实现的机制"。** 点击穿透这一条我栽过：
    只设 `WS_EX_TRANSPARENT`，然后去读那个样式位"验证通过"——然而**单独设它是无效的**，
    必须同时有 `WS_EX_LAYERED`（依据：tao 的 `window_state.rs:282`）。
    结果就是"样式位对了、点击照样被挡住"。现在用 `WindowFromPoint` 验：
    **问系统"这个点上点击会落到哪个窗口"**，这才是用户实际感受的那件事。
27. **"静默回落"是最危险的一类 bug。** `runtime_config` 调用失败被 catch 吞掉后
    回落到演示源，表现是"桌宠在动、内容是假的"——而演示剧本和真实事件长得几乎一样，
    光看状态日志分辨不出来（用户先发现的）。现在：native 与页面**各自把数据源写进日志**、
    默认值改成 live、启动失败打完整栈。
28. **同级气泡必须是"新的优先"。** 原来写的是 `a.ts - b.ts`（最早的优先），
    于是点出来的台词里最旧那条永远占着唯一显示位，新点击只能进 `+N`——
    "点击对话卡住"就是这个。而且**定序要用单调序号而不是时间戳**：
    同一毫秒内的多次推送时间戳相同，排序会退化成插入序（单测抓到过）。
29. **历史日志不是"当前状态"。** Codex 的 rollout 是历史文件，桥接启动时会从头读；
    不过滤的话几天前的报错会被当成实时事件，而**旧报错优先级(80)高于"工作中"(65)**，
    正好把当前工作状态压住。现在文件级 + 事件级都有新鲜度窗口（默认 15 分钟）。

30. **保险丝要看"通道是否还活着"，不能只看"有没有事件"。** 新鲜度衰减原本是
    "活跃状态 45 秒无事件 → 回落 idle"，但**长任务期间本来就没有事件**
    （DSH 投影的 seq 不变 → 桥接不发事件 → 工具还在跑）。实测症状：
    跑几分钟的命令会让 `working` 打回 `idle`，跑到 5 分钟还会进 `doze`。
    现在判据是「无事件 **且** 该 Agent 心跳也停了」，并要求"有工具在跑时不打瞌睡"。
31. **抠图的种子不能撒在"触边的非背景色"上。** 探头素材里有一条触边的黑线，
    落在它上面的 flood 种子会把"黑"当背景色，**顺着黑线灌进角色身体**，
    把整个人抠没（只剩眼睛和领结）。现在先求边界主色，只从接近主色的点起灌。
32. **有些瑕疵是源素材格式的问题，不该用启发式硬扛。** 手臂与身体之间的缝隙是
    "被围住的白色背景"，flood 从边界到不了。我试过按连通块中位亮度判（白嘴与缝
    连成一块时会把嘴一起抠掉）和按逐像素亮度判（领结/高光的抗锯齿边缘被咬出麻点），
    **都不可靠**——根因是视频压缩后背景浅灰(≈244)与白色特征(≈251)的像素分布重叠。
    可靠解法是导出时用可精确抠图的背景（带 alpha 的 webm/png，或纯色幕布），
    所以这里选择保住特征、接受灰条，并把原因写进注释。

33. **HTML 元素的顺序会决定 `getElementById` 能不能拿到。** `<dialog id="settings">` 被我放在了
    `<script type="module">` **之后** —— 模块执行时它还没被解析，`getElementById` 返回 null，
    于是"右键有菜单、点设置毫无反应"，而且**不报错**（用户实测抓到）。
    现在对话框/正文/状态栏都是**惰性查找**，与标签顺序无关。
34. **先做用户看得见的事，再做装饰性的事。** 设置页原来是 `await 调整窗口尺寸` 之后才
    `showModal()`；一旦尺寸那个 Promise 不落地，对话框就永远不出现、也不报错。
    现在顺序反过来：先弹对话框，尺寸调整 fire-and-forget。
35. **托盘是"点不到窗口"时的最后一道入口。** 桌宠窗口可以整块点击穿透、也常被拖到屏幕边缘，
    没有托盘的话用户可能既打不开设置也退不掉。菜单里必须有设置与退出
    （左键唤起窗口，右键出菜单）。注意 `TrayIcon` 一旦被 drop 图标就会消失，
    要显式保住它（这里用 `mem::forget` 有意泄漏一个应用级对象）。

---

## 外观设置

设置页 →「外观」，拖动即时生效、存在 localStorage（纯本机表现偏好）：

| 项 | 范围 | 说明 |
|---|---|---|
| 大小 | 100–360 px | 同时改角色、画布、窗口尺寸，气泡叠放位置会跟着重算 |
| 透明度 | 30%–100% | 作用于角色画布 |
| 总在最前 | 开/关 | Tauri `setAlwaysOnTop` |
| 空白处点击穿透 | 开/关 | 关掉后整个窗口都会挡住桌面（调试时有用） |

**靠边探头**：窗口贴到屏幕左/右/下边缘（20px 内）时自动播一次探头动画
（`peek_left` / `peek_right` / `peek`），并在松手时**吸附**到最近边缘（60px 内）。
语义：右边缘→往左探、左边缘→往右探、正下方→往上探。冷却 8 秒，离开边缘后可再次触发。

---

## 视觉调参入口

手感类参数都提到了文件顶部，改一个数就能调，不用翻实现：

手感类参数都提到了文件顶部，改一个数就能调，不用翻实现：

| 想调什么 | 改哪里 |
|---|---|
| 被拎起来的幅度（拉长 / 收窄 / 倾斜 / 升高 / 摆动） | `app/src/renderer.js` 顶部 `LIFT` |
| 画布上方留给提拉的空白 | 同文件 `HEADROOM`（默认 0.34，即 200×268 的画布） |
| 状态切换的淡化快慢 | `app/src/renderer.js` 顶部 `FADE_MS` |
| 气泡压进头顶多少、右移多少 | `app/src/main.js` 里 `BUBBLE_TUNE` |
| 气泡最多显示几条 | `app/src/main.js` 调 `bubbles.visibleSummary(2)` 的参数 |
| 动画速度 / 帧数 / 循环方式 | `tools/build_sprites.py` 的 `STATE_CONFIG`，重跑管线 |
| 某状态的显示大小 | 同文件 `SCALE_TWEAK` |
| 彩蛋规则 | `app/src/interactions.js` 的 `registerDefaults()` |

> 提拉幅度和 `HEADROOM` 是一对：角色被拎起来时顶部会上移约
> `(stretchY + liftY) × 画布宽 ≈ 26%`，留白不够就会**把头顶裁掉**（实测踩过，
> 所以画布比精灵格高 34%，支点也放在画布底部而不是精灵格底部）。

---

## 扩展点：加彩蛋 / 加素材不用改核心代码

**加一个状态**：把素材丢进 `avatar_baseline/`，在 `tools/build_sprites.py` 的
`STATE_CONFIG` 加一行（文件名可用关键词自动发现），重跑管线即可。
源画幅特殊时还有三个逐状态开关：`CROPS`（先裁到角色）、`FLIPS`（镜像出另一侧）、
`ANCHOR_OVERRIDE`（换归一化方式）。

**加一个彩蛋**：在 `app/src/interactions.js` 的 `registerDefaults()` 里加一条规则，
例如「连点 20 次晕」：

```js
this.register({ id: 'dizzy', type: 'clickCount', count: 20, windowMs: 8000,
  play: 'egg_dizzy', durationMs: 3000 });
```

`play` 指向的状态若还没有素材，会被安静跳过（只留一行日志），
所以规则可以先登记、素材后补。判定是**延后聚合**的：停手 350ms 后统一判定、
取满足条件里次数最高的那条——否则"双击打招呼"会在第 2 下抢先命中并进入冷却，
"连点 5 下"就永远不可达。

---

## 调试手段

| 手段 | 用法 |
|---|---|
| 前端日志通道 | 页面调 `frontLog()` → native stdout（`runtime/pet.out.log`），排查前端问题最直接 |
| 内置交互自检 | 设 `PRESAGE_SELFTEST=1` 启动，6 秒后页面自动派发 5 次合成点击走完整处理链 |
| 布局诊断 | 气泡变化时打印窗口/画布/气泡几何、尾巴压住头顶多少 px、尾巴与画布中线的偏差 |
| 强制状态 | 浏览器预览里按 `1`–`7` 切换状态、`0` 解除、`a`/`e`/`d` 注入事件 |
| 真实日志回放 | `node tools/replay_rollout.mjs 6` 把真实 rollout 灌进状态机并打印时间线 |
| 素材预览 | `tools/preview_video.py`（逐帧总览）、`tools/preview_bubble.py`（九宫格渲染）、`tools/report_scales.py`（占比核对） |


---

## 版权

普瑞塞斯的形象版权属于鹰角网络 / Hypergryph。本项目的角色素材为**基于参考图的 AI 生成内容**，
**仅供个人学习与研究使用，不得用于任何商业用途**。请勿分发角色素材。
