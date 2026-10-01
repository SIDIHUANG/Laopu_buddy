# 设计备注：让 exe 自己搞定一切，去掉 .bat 启动器

> **状态：只讨论，未实施。** 写给下一次对话 / 未来的自己。
> 记录时间：v1.1 基线（tag `v1.1-baseline`，提交 `58e6e04`）之后。
> 用户原话的点：*"能不能不要 bat 启动？……直觉是一个 exe 文件完成全部比较直觉？包括以后 release"*

---

## 0. 结论先说

用户的直觉**成立**，而且分两个层次，答案是相反的：

| 目标 | 可行性 | 建议 |
|---|---|---|
| **A. 去掉 `.bat`**（桥接仍由 node 跑，但由 exe 自己隐藏启动） | ✅ 完全可以，而且**应该做** | 优先做，收益立竿见影 |
| **B. 去掉 node**（真正"一个 exe 全包"） | ⚠️ 可行但要重写桥接 | 作为 release 目标另立一档，别和 A 混在一起 |

**关键：B 不是 A 的前提。** 先把 A 做了，用户体验就已经是"双击一个 exe"。

---

## 1. 为什么现在有 bat（历史原因，不是设计意图）

v1 时期桥接必须由启动器拉起，于是"启动器"逐渐变成唯一入口，并被迫承担了一堆
本不该它管的事（都是被真实故障逼出来的，每条见 `启动桌宠.bat` 注释与 `OPEN-ISSUES.md`）：

1. 定位 exe 与 `WebView2Loader.dll`，缺 DLL 要提前报错（否则双击 exe 静默秒退 `0xC0000135`）
2. 单实例检查
3. 设置 `WEBVIEW2_USER_DATA_FOLDER`；profile 坏了要删掉重建（`0x8000FFFF`）
4. 隐藏启动桥接（`-WindowStyle Hidden`，因为 `start /min` 会留下最小化控制台）
5. 等 12 秒判断桌宠是否真的起来了，失败就重试
6. 自检：把 UTF-8 日志转 GBK 打印（否则中文花屏）
7. 桥接的 PID 传递（`--pidfile`）

**其中 1/3/4/5/7 都更适合由 exe 自己做**：它在进程内部，信息本来就完整。

---

## 2. 必须知道的约束（决定"怎么做"，别凭直觉写）

| 约束 | 说明 | 后果 |
|---|---|---|
| **exe 是 GUI 子系统** | `main.rs:25` `#![windows_subsystem = "windows"]` | **spawn 控制台程序（node.exe）会弹黑窗口**，除非加 `CREATE_NO_WINDOW` |
| **exe 没有 stdout/stderr** | 同上，文件头注释里记着"`println!` 会 panic" | 子进程输出**不能继承**，必须重定向到文件 |
| **沙箱/权限** | 用户机器非管理员 | 不要依赖需要提权的操作 |
| **node 可能不存在** | 用户机器上 node 在 `C:\Program Files\nodejs\`；但**不能假设** | 找不到 node 必须**优雅降级**（桌宠本体照跑，只是没有 live 事件），不能因此启动失败 |

> 坑记在这里防止重犯：`std::process::Command` 默认**继承** stdio。
> 对 GUI 子系统的父进程来说没有可继承的控制台 → 必须显式
> `.creation_flags(CREATE_NO_WINDOW)` + `.stdout(File)` / `.stderr(File)`。

---

## 3. 方案 A：exe 自己起桥接（推荐先做）

### 3.1 做什么

把 `启动桌宠.bat` 里第 3、4、7 条搬进 Rust，在 `setup()` 或 `main()` 早期执行：

```
1) 判断要不要起：GET http://127.0.0.1:8792/health 通 → 已经在跑，直接用（别起第二个）
2) 找 node：按顺序试
     - 环境变量 PRESAGE_NODE（显式覆盖，排障用）
     - PATH 上的 node.exe
     - 常见安装位置
   都找不到 → 记日志 + 让前端显示"当前无 live 数据源"，但**不阻止桌宠启动**
3) spawn：Command::new(node)
     .arg(bridge_path).arg("--out").arg(events_dir).arg("--port").arg("8792")
     .creation_flags(CREATE_NO_WINDOW)
     .stdout(File::create(runtime/bridge.log))
     .stderr(File::create(runtime/bridge.err.log))
   保存 Child 句柄
4) 短轮询 /health（比如 8 次 × 500ms），把结论写进日志
5) 退出时 child.kill() —— **不再需要 --pidfile / taskkill 那套绕路**
```

### 3.2 能删掉什么（收益）

- `启动桌宠.bat` 和 `v1\启动桌宠.bat`（**两份实现 + `pack_v1.ps1` 的替换逻辑**）都可以删
- `tools\pack_v1.ps1` 里"生成包内启动器 + 自检"整段可以删（不再有第二份 bat）
- 桥接的 `--pidfile`（`pet_bridge.mjs`）可以删；`kill_bridge_if_ours()` 那套
  "读 PID 文件 + `QueryFullProcessImageNameW` + `taskkill /FI`"可以简化成 `child.kill()`
- 用户机器上"双击 bat → 里面再起 exe 和 node"变成"双击 exe"

### 3.3 但要保留/搬走的 bat 职责

| 原职责 | 搬去哪 |
|---|---|
| 缺 `WebView2Loader.dll` 的提示 | exe 里没法自查（它自己就加载失败了）→ **保留一个极简的排查说明**，或靠 Windows 的错误对话框 |
| 日志 GBK 转换 + 自检段 | 可以做成 exe 的一个开关：`presage-pet.exe --diag`（打开一个控制台窗口打印自检） |
| WebView2 profile 坏了重建 | 更适合 exe：启动失败时自己删 profile 重启一次（现在 bat 做的事） |
| 单实例检查 | exe 里做（可用命名互斥体，比 `tasklist` 可靠） |

### 3.4 验证方式（没有这些就别声称做完）

- `Get-Process | Where MainWindowTitle -like '*presage-bridge*'` 应为 0（**无控制台窗口**）
- 启动后 `/health` 返回 `ok=true`
- 退出桌宠后：`bridge.log` 里有结束记录、端口释放、**没有 node 残留**
- 故意把 node 改名/移出 PATH → 桌宠**仍能启动**，只是没有 live 数据
- 连点两次 exe → 只有一个实例、一个桥接

---

## 4. 方案 B：把桥接搬进 exe（"一个 exe 全包"）

### 4.1 桥接现在到底做什么（决定工作量）

`tools/pet_bridge.mjs` 不是"一个小 HTTP 服务"，它做四件事：

1. **tail Codex rollout**（`~/.codex/sessions/**/rollout-*.jsonl`）+ 新鲜度过滤
   → 用 `app/src/adapters/codex.js` 的 `normalizeCodex`
2. **轮询 DSH 会话投影**（`~/.dsh/storages/session_projcache/sessions`）
   → 用 `app/src/adapters/dsh.js`
3. **用量采集**（ccswitch / dsh / deepseek 三路，含 **DeepSeek 官方余额 API 调用**）
   → `tools/usage.mjs`
4. **HTTP 服务**：`/health` `/events`(SSE) `/recent` `/lines`(GET/POST) `/usage` `/usage/config`

### 4.2 路线选择

| 路线 | 说明 | 代价 |
|---|---|---|
| B1. 把 1~4 用 Rust 重写 | 真正单文件 | 适配器逻辑（尤其 Codex rollout 的格式演进）是**最容易变**的部分，重写它意味着以后格式一变要改两处 |
| B2. **内嵌一个 JS 引擎**跑**同一份** `pet_bridge.mjs` | 逻辑单源，不必双维护 | 要 embed（如 QuickJS/deno_core 类方案），体积和复杂度上升，还需要把 `app/src/*.js` 一起打进去 |
| B3. 内嵌 **Node 单文件可执行**（node SEA / `bun build --compile` 之类）作为 sidecar | 把桥接打成一个小 exe 随包分发，仍由主 exe 隐藏启动 | 不是"一个 exe"，但**没有 node 依赖**了；体积可控 |

> **倾向 B3 或 B2**：桥接的价值在于"它是 JS、和前端共用适配器代码"（`app/src/adapters/*`
> 被 `pet_bridge.mjs` 和前端**同时** import）。用 Rust 重写会把这份共享拆成两份，
> 直接违背当初"逻辑单源"的设计意图。

### 4.3 release 之后的形态（如果做 B）

```
普瑞塞斯桌宠.exe        ← 双击即用，自己搞定一切
WebView2Loader.dll      ← 仍然必须随包（缺了 0xC0000135 静默秒退）
（可选）桥接 sidecar
README / 已知限制
```

---

## 5. 建议的推进顺序

1. **先做 A**（exe 自己隐藏启动桥接 + 自己收尾）。做完用户体验就已经是"双击一个 exe"，
   而且能删掉两份 bat 和一堆绕路代码。
2. A 稳定后，**再评估 B**。评估的第一个问题是"愿不愿意让桥接不再是 JS"——
   如果答案是"不愿意"，那就走 B2/B3 而不是 B1。
3. 每步都要保留**降级路径**：找不到 node / 桥接起不来时，桌宠本体必须照常可用。

---

## 6. 待确认的开放问题

- [ ] `CREATE_NO_WINDOW` + 重定向这套在 GUI 子系统父进程下到底表现如何（**必须在真机验**，
      沙箱里没有 explorer.exe，WebView2 都起不来）
- [ ] 用户机器上 node 的实际位置与版本（现在只从 DSH 自带和 PATH 两处找）
- [ ] 如果走 B3：用什么工具打 sidecar（node SEA / bun compile），体积多少，是否要签名
- [ ] 去掉 bat 之后，"自检段"这个已经很好用的排障入口怎么保留
      （倾向：`presage-pet.exe --diag` 打开控制台打印同样的内容）
- [ ] `v1\` 交付包在去掉 bat 之后的结构（可能只剩 exe + dll + 文档 + sidecar）

---

## 7. 一句话记给下一个对话

> **"不要 bat"是明确值得做的（方案 A，低风险）；"不要 node"是另一个量级的事（方案 B），
> 别把两者混在一起谈。做 A 的时候注意：exe 是 GUI 子系统，
> spawn 控制台子进程必须 `CREATE_NO_WINDOW`，且输出要重定向到文件。**
