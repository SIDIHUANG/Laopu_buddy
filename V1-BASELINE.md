# 普瑞塞斯桌宠 · v1 基线

## 📌 下次开工指引（新对话第一件事就看这里）

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

# 测试（112 项，全绿）
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

> ### ⚠️ 2026-10-01 重大线索：用户是**以管理员身份**运行 bat 的
>
> 用户实测反馈："我还是用管理员模式点的启动桌宠.bat"。
> **提权进程注册通知区图标会被系统拒绝** ✓ —— 这解释了为什么**开发机（沙箱令牌）**
> 和**用户机（管理员令牌）** 测出来**都是 `GetLastError=5`(ACCESS_DENIED)**：
> **两边都没用正常权限跑过** ✗。
>
> **下一步第一件事**：去掉 bat 的"以管理员身份运行"兼容性勾选，正常双击一次，
> 再看 `[2] 托盘注册结果` 是否变成 `注册成功`。
> 若正常权限下**仍然** err=5，再按下面 1~5 的步骤继续查 ✓。
>
> 顺带：**问题 2（画面消失）也极可能是同一个原因** ✓ —— WebView2 的 GPU 进程
> 无法在提权进程里正常沙箱化 → 画布 GPU 合成失败 ✓，而 DOM（气泡文字）软件渲染照常 ✓，
> 于是表现为"她消失、只剩 +n 条" ✗✓。


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

**现象**（用户实测）：双击 `启动桌宠.bat` → 她出现 → **随后消失** ✗，桌面上只剩「+n 条」悬浮文字；
任务管理器里进程仍在 ✓。用户补充：「**你用命令启动就正常，我点 bat 就不行，还有红条**」。

**当前掌握的证据**：
- **用户是"以管理员身份运行"bat 的** ✗✓ ← **首要原因**（见问题 1 里的说明）：
  WebView2 的 GPU 进程无法在提权进程里正常沙箱化 → 画布合成失败，DOM 文字照常 ✓
- 在开发机上**无法复现** ✗：用同样的 `v1\presage-pet.exe` + 同样的 `v1\runtime\webview2` profile
  + 同样的工作目录，`PrintWindow` 抓到的画面是完整的（她 + 气泡 + 计数）✓
- 用 `cmd /c 启动桌宠.bat` 复现时也**正常**：`boot ok states=12` ✓、`hitmask filled=505` ✓、
  `pet.err.log` 为空 ✓ → **画布确实有内容** ✓
- **验证顺序**：先让用户**去掉管理员模式**跑一次 ✓（最省事、最可能直接解决 ✓），
  若仍消失，再用 `v1\诊断-关GPU启动.bat` 验证 GPU 合成假设 ✓

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
14. **一定要先问"你是怎么启动的"** —— 这次绕了极远的路 ✗：用户一直是**以管理员身份**`
    运行 bat ✓，而提权会同时（a）让 `Shell_NotifyIcon` 被拒 ✓（b）打掉 WebView2 的 GPU 合成 ✓。
    一个"权限"问题伪装成了两个互不相干的 bug ✗✓。
    → **下次排查任何"系统接口被拒"或"画不出来"时，第一步先确认是不是提权运行** ✓。
    → 待办：让程序启动时检测自身是否提权，并在日志/气泡里明确提示 ✓
      （`OpenProcessToken` + `GetTokenInformation(TokenElevation)`，加在 `main.rs` 的 `logln` 初始化附近 ✓）。
