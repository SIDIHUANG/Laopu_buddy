# 普瑞塞斯桌宠 · v2（exe 启动版）

> **一句话：把 `启动桌宠.bat` 干掉 —— 双击 `presage-pet.exe` 就是全部。**
> 桥接、WebView2 profile、单实例、日志、退出收尾，全部由 exe 自己在进程内完成。
>
> 这一版**没有动前端逻辑**（`v2/app/src/*.js` 与 v1.1 逐字节相同），
> 改的是"谁负责启动"这件事。v1.1 基线本身**原样保留**（`V1-BASELINE.md`、
> `app/`、`启动桌宠.bat` 都没被覆盖）。

- 基线日期：2026-10-01 · 版本：v2
- 交付包：`v2\`（exe 46 MB + `WebView2Loader.dll` + `tools\` + `app\src\`）
- 用法：**双击 `v2\presage-pet.exe`**
- 诊断：`v2\presage-pet.exe --diag`（或用 `v2\诊断-导出报告.bat`）→ 写 `v2\runtime\diag.txt` 并打开记事本

---

## 0. 先读这一节：哪些是**本机实测**，哪些还是**只有代码级证据**

一份基线最大的价值是"下次能信它"。所以证据等级分开写，**别把 (B) 当 (A) 用**。

### (A) 在本会话里跑出来的实测结果

`tools\test_v2_exe.ps1` 把"双击 exe 就能用"拆成 37 条可判定的检查，全部自动跑：

| 验收项 | 结果 | 判据（日志/命令原文） |
|---|---|---|
| 双击 exe → 进程起来 | ✅ 0.0s 内 | `Get-Process presage-pet` |
| **不需要设任何环境变量** | ✅ | 脚本显式 `Remove-Item Env:\WEBVIEW2_USER_DATA_FOLDER` 后再启动 |
| 日志落在 **exe 旁边的 `runtime\`** | ✅ | `v2\runtime\pet.out.log`（不再跟"谁启动的"跑） |
| exe 自己设 WebView2 profile | ✅ | 日志 `[boot] WebView2 profile=…\v2\runtime\webview2（默认…）` |
| 主窗口真的建出来 | ✅ | `hwnd=1509750 title=普瑞塞斯` |
| `pet.err.log` 无 panic | ✅ | 不存在或 0 字节 |
| 前端 `boot ok` + 几何自检 | ✅ | `[geom:boot] OK … 裁掉=0px 出屏=0px bubble=none` |
| **桥接由 exe 自己无窗口拉起** | ✅ | 日志 `[bridge] 已启动 PID 20320（无窗口）` + `[bridge] 就绪（第 1 次轮询，0.5s）ok=true DSH 会话=2` |
| 桥接 `/health` 通 | ✅ | `ok=true dsh.sessions=2 produced=404` |
| 桥接进程**没有可见控制台窗口** | ✅ | 该 node 进程 `MainWindowHandle = 0`（"无黑框"的机器判据） |
| 桥接的**父进程就是桌宠** | ✅ | `ParentProcessId == 桌宠 PID`（证明不是别处遗留的） |
| `bridge.err.log` 干净 | ✅ | 0 字节 |
| **第二次双击不会起第二个实例** | ✅ | 日志 `[boot] 已有实例在运行 → 本次不启动`；桥接数量不变；提示框关掉后第二实例自己退出 |
| **退出时自己收掉桥接** | ✅ | 日志 `[exit] 收尾：已结束桥接进程 PID 20320`；随后 8792 端口释放、无 node 残留 |
| **profile 坏了自动重建** | ✅ | 故意写坏 profile + 放 `.boot-failed` 标记 → 日志 `[boot] 发现上次的启动失败标记 → 已先删除 WebView2 profile 重建`，仍然 `boot ok`，标记被消费掉 |
| `--diag` 装完即自证 | ✅ | 产出 `runtime\diag.txt`；报告里 `WebView2Loader.dll : 在 exe 旁边 ✓`、`WebView2 运行时 : 已安装 ✓`、`提权=否` |
| **找不到 node 时优雅降级** | ✅ | 用 exe 自己的开关 `PRESAGE_NODE=none`（明确不要桥接）+ PATH/USERPROFILE 收窄 → 桌宠照跑、`boot ok`，日志 `没找到 node.exe … 跳过桥接`，不生成 `bridge.log`，也**不写** `.boot-failed` |
| 前端回归测试 | ✅ 121/121（50+19+11+13+13+13+2） | `node v2\app\test\*.test.mjs` |
| **她真的画出来了**（整只，没有被裁） | ✅ **抓图确认** | `runtime\v2-desktop.png` / `runtime\v2-see.png`：屏幕上是完整的她 + 气泡；日志 `[geom:boot] … 裁掉=0px 出屏=0px`；`[hitmask] filled=714/4096 (17.4%)`（画布**有内容**，不是 0） |
| 托盘图标 | ⚠️ 仍旧 `err=5`（本会话实测） | 见下方第 0.1 节：与 v1 相同，属环境级限制 |

> 关于"她画出来了"这条：v1 的坑是**只看了日志就收工**，漏掉了"画面到底画出来没有"。
> 所以这次抓了两张屏幕位图（DWM 合成结果，不是 `PrintWindow` —— 后者对分层窗口不可信）：
> `v2-desktop.png` 是整屏 1280×800，能看到她完整地站在 DSH 窗口前面；
> `v2-see.png` 是桌宠窗口那块 680×624。两张都在 `runtime\` 里，可以自己打开核对。
> 另外 `[hitmask] filled` 这个数字是"画布真的被画上了"的机器判据（0 = 空的）。

> 关于最后那条降级用例：**怎么造出"这台没有 node"是个坑**，试过三条路才走通 ——
> 只收窄 PATH 不行（回退链里有"常见安装位置"，而本机 `C:\Program Files\nodejs\node.exe`
> 确实存在）；`USERPROFILE` 只能砍掉"DSH 自带"那一条；`ProgramFiles` 环境变量
> **根本没法被子进程覆盖**（cmd 探针实测 `$env:` 与 `EnvironmentVariables[]` 两种写法
> 都不生效，连 `_NEW` 写法也一样），而临时给 `C:\Program Files\nodejs` 改名需要管理员权限。
> 所以最后给 exe 加了一个**正经的开关** `PRESAGE_NODE=none`（"我就是要关掉桥接"），
> 一条命令同时解决了"可测"和"用户可控"。

复现方式：

```powershell
# 前端（v1 与 v2 各自一份，互不干扰）
$env:PYTHONIOENCODING = "utf-8"; python tools\build_web_v2.py
# 原生壳
$env:Path = "$env:USERPROFILE\.mingw64\mingw64\bin;$env:USERPROFILE\.cargo\bin;" + $env:Path
cd v2\app\src-tauri; cargo build --release; cd ..\..
# 装配 + 自检（含"跑一遍包内 exe --diag"）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\pack_v2.ps1
# 验收（37 条）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\test_v2_exe.ps1
```

### (B) 只有代码级证据 / 只有你自己的机器能给答案

| 待确认 | 为什么我这边定不了 | 你怎么确认（10 秒） |
|---|---|---|
| **她到底有没有画出来** | ✅ **已经抓图确认**（见上表；`runtime\v2-desktop.png`） | 不用再确认了；异常时看 `--diag` 报告里 `[geom:boot]` 的 `裁掉=0 出屏=0` |
| 双击时**有没有黑框一闪** | 我没有"双击"这个动作（脚本启动路径已确认无窗口，但双击这一下只有你能看） | 亲眼看一次；机器判据是"桥接 node 进程 `MainWindowHandle=0`"（已验证） |
| 托盘图标 | 与 v1 相同：本机 `Shell_NotifyIcon → err=5`，属环境级限制（v1 已降级为已知限制，未变） | 见 `OPEN-ISSUES.md`（v1 那份）1.1 |

### 🆕 0.1 一个可能对你有用的发现：托盘注册**与路径有关**

同一次会话里，同一个 exe：

| exe 所在位置 | `NIM_ADD` 结果 |
|---|---|
| `…\laopu_ds\v2\`（桌面下的中文路径） | `ok=0 err=5`（ACCESS_DENIED） |
| `%TEMP%\presage-v2-nonode\`（纯英文短路径） | **`ok=1 err=0`（注册成功！）** |

v1 文档里那句"我这个会话没有 shell，所以必然 err=5"因此**又被推翻一次** ——
不是"这个会话不行"，而是与**exe 所在路径**（或某个按路径生效的通知区策略）有关。
**这条仍未定性，我不下结论**（v1 的教训：别把推测写成结论）。

> 低成本的一次对照实验：把整个 `v2\` 包拷到 `D:\presage\` 这类纯英文短路径下，
> 再双击一次，看托盘有没有图标。如果有了，就说明与代码无关。

### (C) 明确**没做**的事（不是漏了）

| 项 | 状态 |
|---|---|
| 去掉 node 依赖（把桥接搬进 exe） | **没做，也不该在这个版本做** —— 那是设计备注里的「方案 B」，另一个量级。理由见 `docs/设计备注-去掉bat启动器.md` 第 4 节：桥接的价值在于"它是 JS、和前端共用 `app/src/adapters/*`"，重写成 Rust 会把这份共享拆成两份 |
| 打 sidecar（node SEA / bun compile） | 同上，留作 release 阶段另立一档 |
| 托盘、任务栏图标、抠图残留、celebrate 难过脸 | 沿用 v1 的已知限制，本版**没有碰** |

---

## 1. 交付包结构（`v2\`）

```
v2\
├── presage-pet.exe          ← 双击这个。46 MB，前端与素材已编进二进制
├── WebView2Loader.dll       ← 必须随包！只拷 exe 会 0xC0000135 静默秒退
├── 启动桌宠.bat             ← 可选入口（不含任何逻辑，只转发给 exe）
├── 诊断-导出报告.bat        ← 可选入口（= exe --diag）
├── BUILD.txt                ← 字节数 + SHA256 清单（含回读自查）
├── README-V2.txt / V2-BASELINE.md / OPEN-ISSUES.md
├── tools\pet_bridge.mjs     ← 桥接（exe 自己拉起它，仍然是 JS：逻辑单源）
├── tools\usage.mjs
├── app\src\{protocol,lines,usage-view}.js + adapters\{codex,dsh}.js
│                            ← 桥接 import 的那几个模块；缺了桥接 ERR_MODULE_NOT_FOUND
└── runtime\                 ← exe 自己在旁边建：日志 / profile / 桥接输出 / diag
```

**为什么包里还留着一份 `启动桌宠.bat`**：有些场景只认 bat（脚本化、快捷方式指向
bat、某些启动器）。它的内容只有 `cd /d %~dp0` + `presage-pet.exe` —— **零逻辑**，
所以不会像 v1 那样出现"两份启动逻辑各自漂移"（v1 实测：`v1\` 里修好了、
根目录那份还是旧的，两个入口现象不同）。

---

## 2. v1.1 的 bat 职责搬去哪了

设计备注里列的 7 条 bat 职责，逐条对账（**这是本次改动的核心**）：

| # | v1 的 bat 职责 | v2 去哪了 |
|---|---|---|
| 1 | 定位 exe 与 `WebView2Loader.dll`，缺 DLL 提前报错 | **exe 自己查**（`preflight.rs`）→ 缺了弹**原生错误框**（GUI 子系统没有 stdout，这是唯一能"让用户看见"的通道） |
| 2 | 单实例检查（`tasklist` + `findstr`） | **exe：命名互斥体**（`preflight::single_instance`）。比 `tasklist` 可靠：没有"上一次刚退出、进程还没消失"的竞态。**名字里带 exe 路径哈希** → v1 与 v2 可以同时跑（对照实验需要） |
| 3 | 设 `WEBVIEW2_USER_DATA_FOLDER`；profile 坏了删掉重建 | **exe：`preflight::run()` 在 `build()` 之前设**；`runtime\.boot-failed` 标记 + build 失败时自动删 profile 重试一次 |
| 4 | 隐藏启动桥接（`-WindowStyle Hidden`） | **exe：`bridge::ensure_started`** —— `CREATE_NO_WINDOW` + stdout/stderr 重定向到 `bridge.log` / `bridge.err.log` |
| 5 | 等 12 秒判断桌宠起没起来，失败重试 | **exe：`build()` 返回 Err 就地重试**（同一进程内，也不需要 12 秒的盲等） |
| 6 | 自检：把 UTF-8 日志转 GBK 打印 | **exe：`--diag`** → 写 `runtime\diag.txt`（UTF-8，记事本正确显示）+ 打开记事本。顺带解决 v1 那条"cmd 是 GBK、日志是 UTF-8 → 中文花屏"的坑（那个坑只属于控制台） |
| 7 | 桥接 PID 传递（`--pidfile`）+ 退出时 `taskkill /FI` | **整段删除**：`Child` 句柄就在 exe 手里，直接 `kill()`。见 `bridge::shutdown` |
| + | —— | **v2 新增**：`--version`（对话框显示版本与路径）、WebView2 Runtime 检测、日志改锚 **exe 目录** |

> 顺带删掉的东西：`read_bridge_pid()` / `kill_bridge_if_ours()`（v1 的
> "读 pidfile + `QueryFullProcessImageNameW` + `taskkill /FI`"那一整套绕路）、
> `tools\pack_v1.ps1` 里"生成包内启动器 + 文本替换自检"整段。

---

## 3. 三条必须记住的硬约束（改代码前先读）

1. **exe 是 GUI 子系统**（`#![windows_subsystem = "windows"]`）。
   `std::process::Command` 默认**继承 stdio**，而 GUI 父进程没有可继承的控制台
   → spawn `node.exe` 会**弹出黑窗口**。必须
   `.creation_flags(CREATE_NO_WINDOW)` + `.stdout(File)` / `.stderr(File)`。
2. **exe 没有 stdout/stderr**（`println!` 会 panic）。所以：
   * 一切日志走 `logln`（写文件 + 忽略 stdout 错误）；
   * 一切"必须让用户看见"的提示走 `dialogs.rs`（原生 MessageBox）。
3. **找不到 node 必须优雅降级**：桌宠本体照跑，只是没有 live 事件。
   实测路径：`PRESAGE_NODE` → PATH → DSH 自带 → `Program Files\nodejs` 等常见位置。

另外两条环境级的坑（本次实测踩到，写在这里省下一次的时间）：

4. **Windows PowerShell 5.1 读不带 BOM 的 `.ps1` 会当 GBK 解析** ——
   中文注释一旦出现，脚本直接语法错误（报的还是完全不相干的位置）。
   `tools\pack_v2.ps1` / `pack_buildinfo_v2.ps1` / `test_v2_exe.ps1` 都必须**存成 UTF-8 with BOM**。
   （用户机器上只有 PowerShell 5.1，没有 pwsh 7。）
5. **别用 `Start-Process -PassThru` 跑这个 exe**：在本会话里它会**永久挂住**
   （等一个永不结束的进程句柄）。脚本里统一用
   `[System.Diagnostics.Process]::Start`。另外 `Start-Process` 不带重定向时，
   桌宠的 stderr 会**继承到父控制台**（实测看到 `[boot]` 行串进了脚本输出）。

---

## 4. 代码地图（v2 新增/改动的部分）

| 文件 | 职责 |
|---|---|
| `v2\app\src-tauri\src\preflight.rs` | **新**：exe 目录锚定、建 runtime、WebView2 profile 判定与自愈、缺 DLL/Runtime 检测、单实例互斥体、命令行开关 |
| `v2\app\src-tauri\src\bridge.rs` | **新**：找 node（含 `PRESAGE_NODE=none` 关掉桥接）、`CREATE_NO_WINDOW` spawn、WinHTTP 查 `/health`、轮询就绪、退出收尾、幂等 |
| `v2\app\src-tauri\src\dialogs.rs` | **新**：原生 MessageBox（GUI 子系统唯一的"说话"通道） |
| `v2\app\src-tauri\src\registry_probe.rs` | **新**：查 WebView2 Runtime 是否安装 |
| `v2\app\src-tauri\src\main.rs` | 改：`main()` 改成"预检 → 开关 → 单实例 → 起桥接 → 建 Tauri（失败自愈一次）→ run"；`logln` 的日志路径改成 `runtime_dir()`；删掉 pidfile/taskkill 那一段 |
| `v2\app\src-tauri\Cargo.toml` | 改：包名 `presage-pet-v2`（与 v1 构建缓存隔离）、`[[bin]] name = "presage-pet"`、新增 `Win32_Networking_WinHttp` 与 `Win32_System_Registry` |
| `tools\build_web_v2.py` | **新**：装配 `v2\app\dist`（与 v1 的 `build_web.py` 同逻辑、不同基准目录，两边互不干扰） |
| `tools\pack_v2.ps1` | **新**：装配 v2 包 + 桥接依赖 import 静态校验 + 跑包内 `--diag` 自证 |
| `tools\pack_buildinfo_v2.ps1` | **新**：`v2\BUILD.txt` 清单 + 回读哈希自查 |
| `tools\test_v2_exe.ps1` | **新**：37 条自动验收（本文档第 0 节那张表就是它的输出） |

**为什么 v2 的源码放在 `v2\app\` 而不是原地改 `app\`**：用户明确要求"不要草草覆盖
既有基线"。所以 v1 的源码树 `app\`、根目录 `启动桌宠.bat`、`v1\` 交付包**一个字没动**，
`git status` 里它们仍然干净；v2 是一份独立的副本。代价是前端 js 有两份拷贝 ——
这次的 v2 改动**完全没碰前端**，所以两份目前逐字节相同，没有漂移。

---

## 5. 与 v1.1 的行为差异（用户能感觉到的）

| 场景 | v1.1 | v2 |
|---|---|---|
| 启动 | 双击 `启动桌宠.bat`（会开一个控制台窗口，里面打印自检段） | **双击 `presage-pet.exe`**，没有控制台 |
| 桌宠已在运行时再双击 | bat 打印"已经在运行"并停 8 秒 | exe 弹一个提示框（点确定即退，不启动第二个） |
| 缺 `WebView2Loader.dll` | bat 提示 + `pause` | exe 弹原生错误框（说得更具体） |
| 缺 WebView2 Runtime | bat 只会在启动失败后让你去猜 | exe **直接弹框**并给出官方下载地址 |
| 排障 | 双击 bat，等 20 秒，看自检段 | `presage-pet.exe --diag` → 报告文件 + 记事本（UTF-8 不乱码） |
| 重复实例的判定 | `tasklist` 按进程名 | 命名互斥体（无竞态；名字含路径哈希，v1/v2 可并存） |
| 退出收尾 | pidfile + `taskkill /FI "IMAGENAME eq node.exe"` | 直接 `Child::kill()`（只杀自己起的那一个） |

---

## 6. 日志与诊断位置（v2）

| 文件 | 内容 |
|---|---|
| `v2\runtime\pet.out.log` | 原生 + 前端日志（**锚定 exe 目录**，与启动方式无关） |
| `v2\runtime\pet.err.log` | stderr（应为空或不生成） |
| `v2\runtime\bridge.log` | 桥接 stdout（每轮启动前清空，不会像 v1 那样攒到 9 MB） |
| `v2\runtime\bridge.err.log` | 桥接 stderr |
| `v2\runtime\diag.txt` | `--diag` 报告 |
| `v2\runtime\.boot-failed` | 上次启动失败的标记（下次启动会先删 profile，然后自己消失） |
| `%LOCALAPPDATA%\PresagePet\pet.log` | 与 v1 相同的"总是可写"兜底日志 |

---

## 7. 一句话记给下一个对话

> **v2 = v1.1 的功能 + "exe 自己搞定一切"。**
> 双击 `v2\presage-pet.exe` 即可；bat 已经降级成不含逻辑的可选入口。
> 桥接**仍然是 node + 同一份 `pet_bridge.mjs`**（没有去掉 node 依赖，那是另一档事）。
> 改启动逻辑时记住：GUI 子系统 → `CREATE_NO_WINDOW` + 重定向；
> 没有 stdout → 用户提示走 `dialogs.rs`；找不到 node → 降级不要失败。
