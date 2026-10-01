# 未解决问题汇总 · v2

> 项目根：`C:\Users\Asus\Desktop\dsh_test\laopu_ds`
> v2 = v1.1 + 「exe 自己搞定一切，去掉 .bat 启动器」。v1.1 的问题清单**仍然有效**，
> 见 [V1-BASELINE.md](V1-BASELINE.md) 与 [OPEN-ISSUES.md](OPEN-ISSUES.md)（v1 那份）。
> 本文档只写 **v2 视角的新增 / 变化 / 仍未定性**。

---

## 0. v2 修掉的（v1 设计备注里列为「方案 A」的那一批）

| # | v1 的问题 | v2 的做法 | 实测证据 |
|---|---|---|---|
| 1 | 必须双击 `启动桌宠.bat`；bat 里再起 exe 和 node | exe 自己起桥接 | 日志 `[bridge] 已启动 PID 15484（无窗口）` + `[bridge] 就绪（第 1 次轮询，0.5s）ok=true` |
| 2 | bat 拉起桥接会留下一个最小化控制台 | `CREATE_NO_WINDOW` + 重定向到文件 | 该 node 进程 `MainWindowHandle = 0`（机器判据） |
| 3 | 两份启动逻辑（根目录 / `v1\`）会各自漂移 | 只剩 exe 一份；包内 bat **零逻辑** | `tools\pack_v2.ps1` 不再做文本替换生成启动器 |
| 4 | 桥接 PID 靠 `--pidfile` + `taskkill /FI` 绕路 | `Child` 句柄直接 `kill()` | 日志 `[exit] 收尾：已结束桥接进程 PID 15484`；随后 8792 释放、无 node 残留 |
| 5 | 日志跟着"谁启动的"跑，自检段会读到空文件 | 日志**锚定 exe 目录** | 未设任何环境变量启动后，`v2\runtime\pet.out.log` 有内容 |
| 6 | 单实例用 `tasklist`（有竞态） | 命名互斥体（名字含 exe 路径哈希） | 第二次双击日志 `[boot] 已有实例在运行 → 本次不启动` |
| 7 | `WEBVIEW2_USER_DATA_FOLDER` 由 bat 设；profile 坏了要 bat 删 | exe 在 `build()` 之前自己设；失败自动删重建一次 | `.boot-failed` 场景实测：删 profile → 仍然 `boot ok` |
| 8 | 自检要靠 bat 打印（且 UTF-8→GBK 转换，中文易花屏） | `presage-pet.exe --diag` 出报告文件，记事本直接看 | `runtime\diag.txt` |
| 9 | 缺 WebView2 Runtime 只能靠猜 | exe 查注册表，缺了**弹框 + 官方下载地址** | 报告里 `WebView2 运行时 : 已安装 ✓` |

**验收脚本**：`tools\test_v2_exe.ps1`（自动跑一遍，含上面每一条）。

---

## 1. 🟡 仍未解决（沿用 v1 的决定，v2 没有碰）

### 1.1 托盘图标（`Shell_NotifyIcon` → `ACCESS_DENIED`）

v1 已降级为**已知限制**，v2 未改。但 v2 里多了一条**有价值的对照证据**：

```
（v2 包内 exe，桌面路径 C:\Users\Asus\Desktop\dsh_test\laopu_ds\v2\）
[tray] diag NIM_ADD without-icon ok=0 err=5
[tray] Shell_NotifyIcon 五次都失败（图标不会出现在通知区）

（同一个 exe 拷到 %TEMP%\presage-v2-nonode\ 下运行，同一次会话）
[tray] diag NIM_ADD without-icon ok=1 err=0
[tray] Shell_NotifyIcon 注册成功（第 1 次尝试）
```

**两次都是"我这个会话"**，差别只有 exe 所在目录。这条把 v1 文档里那句
"我的会话没有 shell，所以必然 err=5"**又推翻了一次** —— 不是"这个会话不行"，
而是**与路径/某个按路径生效的策略有关**（通知区策略、
`HKCU\Control Panel\NotifyIconSettings` 里的历史记录、或安全软件的按路径放行）。
v1 里也发现过 `NotifyIconSettings` 存在指向 `v1\presage-pet.exe` 的键
（那个键只在注册成功时才写入）。

> **这条对你有用**：如果桌面上的 `v2\presage-pet.exe` 双击后**托盘有图标**，
> 那说明是路径相关的策略，与代码无关；如果**没有**，可以试着把整个 `v2\` 包
> 拷到 `D:\presage\` 这类纯英文短路径下再跑一次 —— 这是零成本的一次对照实验。
> **仍未定性，不下结论**（v1 的教训：不要把推测写成结论）。### 1.2 抠图残留 / 任务栏图标 / `celebrate` 难过脸

与 v1 完全相同，本版未动。见 v1 的 `OPEN-ISSUES.md` 1.2 / 1.3 / 1.4。
任务栏图标的下一步仍然是设扩展样式 `WS_EX_TOOLWINDOW`（清 `WS_EX_APPWINDOW`），
代码位置 `v2\app\src-tauri\src\main.rs` 里 `w.set_skip_taskbar(true)` 那一处。

---

## 2. v2 自己带来的新东西（需要盯着的）

### 2.1 `WebView2Loader.dll` 与 WebView2 Runtime 的提示是**弹框**

去掉了 bat 之后，这两类致命错误只能靠原生对话框告诉用户（GUI 子系统没有 stdout）。
代价：**自动化脚本里不能跑会弹框的路径**（`--version` 就是弹框，会一直等）。
所以 `--diag` 刻意设计成**不弹框、不开窗**，可以在打包脚本里安全地跑。

### 2.2 重试一次 profile 的边界

现在的逻辑是：`build()` 失败 → 写 `.boot-failed` → 删 profile → 再试一次 → 还失败就弹框退出。
**没有验证过的分支**：如果第二次失败，`.boot-failed` 会留在磁盘上，
于是**下一次启动也会先删一次 profile**。这是有意的（失败过就该重建），
但如果失败原因是"WebView2 运行时坏了"这种删 profile 治不好的问题，
用户会看到"每次都重建 profile 但还是起不来"。真实场景里表现为启动慢一点，
不会更糟 —— 但这条**只在代码级成立，没有真机复现**。

### 2.3 构建环境的两条坑（已写进 `V2-BASELINE.md` 第 3 节）

* Windows PowerShell 5.1 读**无 BOM** 的 `.ps1` 会当 GBK 解析 → 中文注释直接语法错误。
  `pack_v2.ps1` / `pack_buildinfo_v2.ps1` / `test_v2_exe.ps1` 必须 **UTF-8 with BOM**。
  用编辑器改完之后**记得补 BOM**（这次踩到两次）。
* `Start-Process -PassThru` 在 DSH 会话里会挂住 → 脚本统一用
  `[System.Diagnostics.Process]::Start`。

### 2.4 前端有**两份拷贝**（v1 一份、v2 一份）

本次 v2 改动**完全没碰前端**，所以 `v2\app\src` 与 `app\src` 目前逐字节相同。
以后如果改了前端，**两边要一起改**（或者决定"v2 从此独立演进，v1 冻结"）。
这是"不覆盖 v1 基线"的直接代价，写在这里提醒。

### 2.6 🔴 v1 的 `tools\pack_v1.ps1` 现在**跑不了**了（锚点失配，只影响"可复现性"）

**结论：`v1\` 这个已经包好的交付包本身没问题；坏掉的是"能不能再从根目录重新生成一份 v1 启动器"。**

`pack_v1.ps1` 的第一处替换要找这句（写死在脚本里）：

```
'rem  普瑞塞斯桌宠 · v1.1 启动器（**唯一实现**；v1\ 里那份只负责转发到这里）'
```

而根目录 `启动桌宠.bat` 里现在是：

```
'rem  普瑞塞斯桌宠 · v1.1 启动器（**唯一实现**，工程根目录版）'
```

`Contains` = False → `$t -eq $orig` → 脚本直接 `throw '一处都没替换成功'`。
时间戳也印证了这个顺序：根 bat `10-01 09:56:35`、`v1\启动桌宠.bat` `10-01 10:03:06`
（更新），说明 v1 那份是 10:03 从**当时那版**根 bat 生成的，之后根 bat 又被改了措辞。

**已确认不受影响的部分**（都做过实测）：

| 检查 | 结果 |
|---|---|
| `v1\` 里的文件是否齐全 | ✅ 齐全（exe / dll / bat / tools / `app\src` 那 5 个） |
| 包内桥接依赖能否解析 | ✅ `node tools\bridge_deps_probe.mjs v1` → 5/5 ok |
| v1 跑起来是否用包内路径 | ✅ `v1\runtime\bridge.log` 里 `事件目录 = …\v1\runtime\events` |
| 包内 bat 指向包外的引用 | 只有"日志候选 2 = 上一级 runtime"（空路径时静默跳过）+ 两行 `del`，无害 |

**这条更好的修法是"从根上删掉这个耦合"**（也是 v2 已经做到的）：
包里那份 bat 不再由脚本**文本替换生成**，而是**手写的零逻辑入口**，
于是"模板一改、生成器就失配"这种情况在 v2 里不可能发生。
如果以后要修 v1，两个选项：① 把 `pack_v1.ps1` 里的锚点改成现行措辞（治标）；
② 让 v1 也改用手写包内 bat（治本，但要动已冻结的基线，不建议）。

> 📌 这条值得写进 skill：**"用文本替换从一个模板生成另一个脚本"是很脆的耦合** ——
> 模板里一个标点被改，生成器就静默/显式失效，而且失效点离改动点很远，很难联想。

### 2.7 环境变量开关一览（v2 新增了两个）

| 变量 | 作用 |
|---|---|
| `PRESAGE_NODE` | 指定桥接用哪个 node.exe；**设成 `none` / `off` / `0` = 不要桥接**（回退链整段跳过）。指向不存在的文件时会记日志并继续走回退 |
| `PRESAGE_ROOT` | 换一个"根目录"（默认 = exe 所在目录）。排障/对照实验用 |
| `WEBVIEW2_USER_DATA_FOLDER` | 存在就**照用不动**（兼容自动化脚本）；不设时 exe 用 `<exe目录>\runtime\webview2` |
| `PRESAGE_SELFTEST` | 沿用 v1：让前端跑一次内置交互自检 |
| `PRESAGE_SOURCE` / `PRESAGE_BRIDGE` | 沿用 v1：`live`/`demo` 与桥接地址 |

### 2.7b ℹ️ 冷启动那一次：启动后第一个回合可能不演 thinking（已定性，不修）

**结论：已知限制，一次会话最多命中一次，不修。** 触发条件很窄 ——
**在桌宠启动后那几秒内结束的第一个回合**，她可能全程站着不动。

#### 怎么发现的（第一现场实测，不是推理）

| 项 | 值 | 来源 |
|---|---|---|
| 她启动（桥接 `agent/hello`） | **15:45:02.570** | `release验收\presage-pet-v2\runtime\events\dsh.jsonl` seq=1 |
| 第一轮「你好」 | **15:45:29.966 → 15:45:32.049（2.1s）** | DSH rollout `session.v4.jsonl.zstd` 的 `turn/start`·`turn/end` 自带时间戳 |
| 那一轮产生的协议事件 | **只有一条 `usage/update`**，**没有 `turn/start`** | 同一份 `dsh.jsonl` |
| 她的状态迁移 | `state → idle（上一状态 -）` → 停 **238.6s** → 才 `state → thinking` | `release验收\...\runtime\pet.out.log` |

也就是说：**她 15:45:02 就起来了（比第一轮早 27 秒），却整轮没有状态迁移。**

#### 机理（代码级）

DSH 通道是**快照轮询 + 边沿检测**，不是事件流：

* `v2\tools\pet_bridge.mjs` `scanDsh()` 每 500ms 读一遍会话投影；
* `v2\app\src\adapters\dsh.js` `deriveFromProjection()` 只在
  `turnOpen` 由 **false → true** 时合成 `turn/start`（`dsh.js` 第 95 行附近）；
* 若桥接**第一次读到该会话时那个回合已经结束**，基线 `turnOpen` 直接就是 `false`，
  那条上升沿**从未被观测到** → `turn/start` 永远不会补发 → 她不动。

#### 为什么确定"不是短回合系统性漏采"

桥接自身在**同一个会话**上连续采到过更短的回合：你发的那条 `1`（turn 6）
**全长只有几秒**，却被正常采到 —— `16:07:01.847 turn/start {turnId:"turn-6"}`
（`dsh.jsonl` seq=81）→ `pet.out.log` 随即 `state → thinking（上一状态 idle 持续 12.8s）`。

> **判据（用来复现或排除）**：她**已经在跑**时，任意短回合（一个 `1` 就够）
> **必然**演 thinking；只有**启动后第一个回合**可能不演。
> 首次「你好」正好落在启动后 27 秒内，所以命中了。

#### ⚠️ 仍然没分清的一点（别把推测当结论）

投影文件在回合进行中**到底有没有被刷新**、还是「回合结束才写一次」，
我**没有测出来**（投影文件的历史 mtime 不可回溯，那两个 runtime 目录也已被覆盖）。
这一点决定了「在基线那一拍补发一次 `turn/start`」这个 3 行修法**能不能真的修好** ——
说不定修的是另一种情形。既然不修，就不再追；但结论只能收在
**「已定性为冷启动一次性现象」**，不能写成「根因是基线竞态」。

### 2.8 ✅ 发行形态（已实测可用）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\release_v2.ps1
# -> release\presage-pet-v2-<时间戳>.zip   44.52 MB 目录 / 25.72 MB 压缩包 / 15 个条目
```

把压缩包**解压到中文路径**（`…\release测试\presage-pet-v2`）后跑
`tools\test_v2_exe.ps1 -PkgDir <该目录>`：**47 项全绿**。
这比"在 `v2\` 里跑通"更强 —— 同时证明了白名单没漏文件、中文路径不影响运行、整包拷走就能用。

`release_v2.ps1` 有五道自检：白名单齐全 / 包内 import 全部可解析 /
无 `target`·`runtime`·`dist` / 包内 exe `--diag` 报告正确 / 压缩包清单与白名单一致。

---

## 3. 下一步（按性价比）

1. **人工确认两件事**（各 10 秒，见 `V2-BASELINE.md` 第 0 节 (B)）：
   双击发行包里的 `presage-pet.exe` → 有没有黑框闪过；托盘图标是否出现。
2. 托盘那条唯一还没做的对照实验：把**发行包**解压到 `D:\presage\`（纯英文短路径）
   再双击一次。C 盘那次通了、桌面中文路径没通，但同路径也会摇摆，
   所以这条**仍未定性**（见 1.1）。
3. 想继续推进"一个 exe 全包"的话，走设计备注里的**方案 B**（B2 内嵌 JS 引擎
   或 B3 sidecar），并先回答"愿不愿意让桥接不再是 JS"这个问题。
4. 写 skill 时建议保留 `target\`（本次刻意没删）：`deps\` 里每个 269 MB 的 debug exe
   对应一次真实的源码版本，`build\` 是各依赖 build.rs 的输出，`incremental\` 是引擎状态 ——
   解释"为什么 cargo 会把 1.4 GB 塞在一个 44 MB 的程序旁边"时，这些是**可引用的实物**。
