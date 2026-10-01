//! v2 桥接管理：exe **自己**把 `tools/pet_bridge.mjs` 拉起来、盯着它、退出时收掉它。
//!
//! 这一段就是 docs/设计备注-去掉bat启动器.md 里的「方案 A」，也是 v2 存在的理由：
//! 用户要的是"双击一个 exe 就完事"，而不是"双击 bat，bat 再去起 exe 和 node"。
//!
//! ## 三条必须记住的约束（v1 的笔记里踩过，别再犯）
//!
//! 1. **exe 是 GUI 子系统**（`#![windows_subsystem = "windows"]`）。
//!    `std::process::Command` 默认**继承 stdio**，而 GUI 父进程没有可继承的
//!    控制台 —— 于是 spawn 一个控制台程序（node.exe）会**弹出黑窗口**。
//!    所以必须：`creation_flags(CREATE_NO_WINDOW)` + stdout/stderr 显式重定向到文件。
//! 2. **子进程输出不能丢**。v1 把桥接输出写到控制台，启动器一关它写 stdout 失败
//!    就可能退出；用户那边只表现为"桌宠一直不进入 working、零事件"，极难查。
//!    所以这里固定重定向到 `runtime\bridge.log` / `runtime\bridge.err.log`。
//! 3. **找不到 node 必须优雅降级** —— 桌宠本体照跑，只是没有 live 事件。
//!    绝不能因为"没有 node"就启动失败（用户机器上不一定装了 node）。
//!
//! ## 与 v1 的差别（为什么能删掉一堆绕路代码）
//!
//! v1 是启动器用 `powershell Start-Process -WindowStyle Hidden` 起桥接，
//! 拿不到 node 的真实 PID，只好让桥接自己写 `--pidfile`，退出时再
//! `taskkill /PID … /FI "IMAGENAME eq node.exe"`。v2 里 `Child` 句柄就在手上，
//! 直接 `kill()` 即可 —— pidfile、taskkill、镜像名过滤那一整套都不再需要。

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 桥接进程句柄。`Mutex` 保护是因为它由 setup 里的线程写入、由退出回调读取。
static BRIDGE: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<Child>> {
    BRIDGE.get_or_init(|| Mutex::new(None))
}

/// 桥接是否由**本进程**启动（退出时才需要收尾；复用别人起的桥接不能杀）。
static SPAWNED_BY_US: OnceLock<Mutex<bool>> = OnceLock::new();

fn spawned_by_us() -> &'static Mutex<bool> {
    SPAWNED_BY_US.get_or_init(|| Mutex::new(false))
}

const PORT: u16 = 8792;

// --------------------------------------------------------------------------- //
// 极简 HTTP：只为了 GET /health。
//
// 为什么自己写而不用 reqwest：这一条只需要"发一个 GET、读回一段 JSON"，
// 引一个带 TLS/异步运行时的 crate 不值得（release 体积与构建风险都上升）。
// WinHTTP 是系统自带的，零额外依赖。
// --------------------------------------------------------------------------- //

/// `GET http://127.0.0.1:<PORT>/health`，返回响应体。
fn http_get(path: &str, timeout_ms: u32) -> Option<String> {
    #[cfg(windows)]
    {
        // 模块路径是 Win32::Networking::WinHttp（**不是** Win32::Net::WinHttp ——
        // feature 名与模块路径并不逐字对应，这里各写错一次才对上）。
        use windows_sys::Win32::Networking::WinHttp::*;

        fn wide(s: &str) -> Vec<u16> {
            s.encode_utf16().chain(std::iter::once(0)).collect()
        }
        unsafe {
            let agent = wide("PresagePet");
            let session = WinHttpOpen(
                agent.as_ptr(),
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                std::ptr::null(),
                std::ptr::null(),
                0,
            );
            if session.is_null() {
                return None;
            }
            let host = wide("127.0.0.1");
            let connect = WinHttpConnect(session, host.as_ptr(), PORT, 0);
            if connect.is_null() {
                WinHttpCloseHandle(session);
                return None;
            }
            let verb = wide("GET");
            let target = wide(path);
            let request = WinHttpOpenRequest(
                connect,
                verb.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
            );
            if request.is_null() {
                WinHttpCloseHandle(connect);
                WinHttpCloseHandle(session);
                return None;
            }
            // 超时：解析/连接/发送/接收各给 timeout_ms。默认超时是 30 秒以上，
            // 而这段代码在启动路径上跑 —— 必须短，否则"双击后半天不出窗口"。
            WinHttpSetTimeouts(session, timeout_ms as i32, timeout_ms as i32, timeout_ms as i32, timeout_ms as i32);
            let mut out = None;
            if WinHttpSendRequest(request, std::ptr::null(), 0, std::ptr::null_mut(), 0, 0, 0) != 0
                && WinHttpReceiveResponse(request, std::ptr::null_mut()) != 0
            {
                let mut body: Vec<u8> = Vec::new();
                loop {
                    let mut buf = [0u8; 4096];
                    let mut read = 0u32;
                    if WinHttpReadData(request, buf.as_mut_ptr() as *mut _, buf.len() as u32, &mut read) == 0 {
                        break;
                    }
                    if read == 0 {
                        break;
                    }
                    body.extend_from_slice(&buf[..read as usize]);
                    // /health 的响应只有几百字节，做个上限防呆
                    if body.len() > 64 * 1024 {
                        break;
                    }
                }
                if !body.is_empty() {
                    out = Some(String::from_utf8_lossy(&body).to_string());
                }
            }
            WinHttpCloseHandle(request);
            WinHttpCloseHandle(connect);
            WinHttpCloseHandle(session);
            out
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (path, timeout_ms);
        None
    }
}

/// 桥接是否已经在跑（可能在别的进程里跑着，比如用户还留着 v1 的会话）。
///
/// 判据是 `/health` 有响应**且** `ok` 为真：只看端口通不够 ——
/// 8792 上完全可能是别的东西（用户机器上什么都有）。
pub fn health() -> Option<serde_json::Value> {
    let body = http_get("/health", 1500)?;
    let v: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    Some(v)
}

pub fn is_running() -> bool {
    matches!(health(), Some(v) if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false))
}

// --------------------------------------------------------------------------- //
// 找 node
// --------------------------------------------------------------------------- //

/// 按顺序找 node.exe：
///   1. `PRESAGE_NODE` —— 显式覆盖，排障/自动化用
///   2. PATH 上的 node.exe —— 用户自己装的（`C:\Program Files\nodejs\` 通常会进 PATH）
///   3. DSH 自带的那份 —— 开发机上常见，但**不能假设**（用户机器上可能没有）
///   4. 几个常见安装位置 —— 最后兜底
///
/// 找不到就返回 `None`，由调用方走降级路径（不阻止桌宠启动）。
///
/// `PRESAGE_NODE` 的三个取值语义（第 1 条是"显式覆盖"，第 3 条是"显式关掉"）：
///   * 指向一个存在的文件 → 就用它，不走回退
///   * 指向不存在的文件   → 记一行日志，**继续走回退**（手滑写错路径不该让桥接消失）
///   * `none` / `off` / `0` → **明确不要桥接**，回退链整段跳过
///
/// 最后那条为什么值得有：它让"找不到 node 会怎样"这条降级路径**可以被测**。
/// 本机 `C:\Program Files\nodejs\node.exe` 是真实存在的，光是把 PATH 收窄测不出来
/// （而且 `ProgramFiles` 环境变量**无法被子进程覆盖** —— 实测 cmd 探针里
/// `$env:ProgramFiles=...` 与 `EnvironmentVariables["ProgramFiles"]=...` 都不生效，
/// Windows 会用机器上的真实值把它填回去）。所以与其去动系统目录，不如留一个开关。
fn find_node() -> Option<PathBuf> {
    if let Some(v) = std::env::var_os("PRESAGE_NODE") {
        let raw = v.to_string_lossy().to_string();
        let low = raw.trim().to_ascii_lowercase();
        if matches!(low.as_str(), "none" | "off" | "0" | "false") {
            crate::logln("[bridge] PRESAGE_NODE=none → 明确不要桥接，回退链整段跳过");
            return None;
        }
        let p = PathBuf::from(v);
        if p.is_file() {
            return Some(p);
        }
        crate::logln(format!(
            "[bridge] PRESAGE_NODE 指向的不是文件：{}（继续按 PATH/常见位置找）",
            p.display()
        ));
    }

    // PATH：不用 `where.exe`（要 spawn 一个进程），自己走一遍环境变量更直接、更快。
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join("node.exe");
            if cand.is_file() {
                crate::logln(format!("[bridge] PATH 上找到 node={}", cand.display()));
                return Some(cand);
            }
        }
    }

    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let home = PathBuf::from(profile);
        cands.push(home.join(".dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"));
    }
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        cands.push(PathBuf::from(pf).join("nodejs").join("node.exe"));
    }
    if let Some(pf) = std::env::var_os("ProgramFiles(x86)") {
        cands.push(PathBuf::from(pf).join("nodejs").join("node.exe"));
    }
    if let Some(la) = std::env::var_os("LOCALAPPDATA") {
        cands.push(PathBuf::from(la).join("Programs").join("nodejs").join("node.exe"));
    }
    // 走"常见安装位置"这条回退时必须留痕：否则自动化测试里
    // "把 PATH 里的 node 拿掉"会被这条悄悄兜住，测试看起来失败、原因却看不出来
    // （实测踩到：一个"降级路径"的用例其实什么都没测到）。
    let path_env = std::env::var("PATH").unwrap_or_default();
    crate::logln(format!(
        "[bridge] PATH 上没有 node.exe（PATH={}）→ 试常见安装位置：{}",
        if path_env.len() > 200 { format!("{}…（共 {} 字符）", &path_env[..200], path_env.chars().count()) } else { path_env },
        cands.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(" | ")
    ));
    cands.into_iter().find(|p| p.is_file())
}

/// 桥接脚本位置：`<root>\tools\pet_bridge.mjs`。
///
/// v1 的 bat 还考虑过"包内没有 tools，就往上找一级"，那是为了兼容两种目录布局。
/// v2 的交付包结构固定（见 tools/pack_v2.ps1），所以只认这一处，
/// 找不到就明确写日志 —— 比"猜另一个路径"更容易排查。
fn bridge_script(root: &Path) -> Option<PathBuf> {
    let p = root.join("tools").join("pet_bridge.mjs");
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// 启动桥接。**幂等**：已经在跑（或已经由本进程起过）就直接返回。
///
/// 参数 `runtime` 是日志/events 目录；`root` 是 exe 所在目录（桥接的工作目录）。
pub fn ensure_started(root: &Path, runtime: &Path) {
    if is_running() {
        crate::logln("[bridge] /health 已通 → 复用正在运行的桥接，不重复启动");
        return;
    }

    let Some(node) = find_node() else {
        // 优雅降级：这是**预期内**的情况（用户机器上未必有 node），
        // 所以只写一行日志，不弹窗、不阻止桌宠启动。
        crate::logln(
            "[bridge] 没找到 node.exe（PRESAGE_NODE / PATH / DSH 自带 / 常见安装位置都试过）\
             → 跳过桥接：桌宠本体正常，只是没有 live 事件与余额播报",
        );
        return;
    };
    // 找到哪个 node 要写清楚：自动化测试与排障都靠这一行区分
    // "到底走了哪条回退路径"（实测：只看有没有 bridge.log，会误判成"PATH 里的 node"）。
    crate::logln(format!("[bridge] 用 node={}", node.display()));

    let Some(script) = bridge_script(root) else {
        crate::logln(format!(
            "[bridge] 找不到 {} → 跳过桥接",
            root.join("tools").join("pet_bridge.mjs").display()
        ));
        return;
    };

    let events = runtime.join("events");
    let _ = std::fs::create_dir_all(&events);
    let out_log = runtime.join("bridge.log");
    let err_log = runtime.join("bridge.err.log");
    // 清掉上一轮日志：否则新旧混在一起，"这一轮桥接说了什么"又要靠时间戳猜
    // （v1 被一个 9MB 的刷屏日志坑过）。
    let _ = std::fs::remove_file(&out_log);
    let _ = std::fs::remove_file(&err_log);

    let (Ok(f_out), Ok(f_err)) = (
        std::fs::File::create(&out_log),
        std::fs::File::create(&err_log),
    ) else {
        crate::logln(format!("[bridge] 日志文件建不出来（{}）→ 跳过桥接", runtime.display()));
        return;
    };

    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .arg("--out")
        .arg(&events)
        .arg("--port")
        .arg(PORT.to_string())
        // 工作目录固定成 exe 目录：桥接内部按相对路径找 app/src、roles 之类时
        // 才有一致的基准（v1 的 bat 用 `start /d` 干的就是这件事）。
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(f_out))
        .stderr(Stdio::from(f_err));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 0x08000000 = CREATE_NO_WINDOW。
        // 没有这一条，GUI 父进程 spawn node.exe 会**弹一个黑窗口**（v1 实测）。
        // 顺带把桥接从"能被 Ctrl+C 一起带走"的组里摘出来（它有自己的收尾）。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.spawn() {
        Ok(child) => {
            let pid = child.id();
            if let Ok(mut g) = slot().lock() {
                *g = Some(child);
            }
            if let Ok(mut f) = spawned_by_us().lock() {
                *f = true;
            }
            crate::logln(format!(
                "[bridge] 已启动 PID {pid}（无窗口）node={} script={}",
                node.display(),
                script.display()
            ));
            // 短轮询确认它真的起来了。**不能只 spawn 就当成功** —— v1 的教训：
            // 桥接因为 `ERR_MODULE_NOT_FOUND` 立刻退出，而桌宠那边只表现为
            // "一直不进入 working"，没人会想到是桥接死了。
            let started = Instant::now();
            for i in 1..=8 {
                std::thread::sleep(Duration::from_millis(500));
                match health() {
                    Some(v) => {
                        crate::logln(format!(
                            "[bridge] 就绪（第 {i} 次轮询，{:.1}s）ok={} DSH 会话={} 已产事件={}",
                            started.elapsed().as_secs_f32(),
                            v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false),
                            v.pointer("/dsh/sessions").map(|x| x.to_string()).unwrap_or_else(|| "-".into()),
                            v.get("produced").map(|x| x.to_string()).unwrap_or_else(|| "-".into()),
                        ));
                        return;
                    }
                    None => {
                        // 进程提前死了就直接说清楚，不用把 8 次轮询等完
                        let mut exited = None;
                        if let Ok(mut g) = slot().lock() {
                            if let Some(c) = g.as_mut() {
                                if let Ok(Some(st)) = c.try_wait() {
                                    exited = Some(st.code());
                                    *g = None;
                                }
                            }
                        }
                        // 每次失败的轮询都留痕：上面那段"进程已退出"曾经出现过
                        // "日志里既没有就绪、也没有退出、也没有超时"的情况，
                        // 没有逐次留痕就只能猜（教训：诊断代码本身要能被诊断）。
                        match exited {
                            Some(code) => {
                                crate::logln(format!(
                                    "[bridge] 进程已退出（第 {i} 次轮询，code={code:?}）→ 详见 bridge.err.log / bridge.log"
                                ));
                                return;
                            }
                            None => crate::logln(format!(
                                "[bridge] 第 {i} 次轮询 /health 无响应（进程仍在）"
                            )),
                        }
                    }
                }
            }
            crate::logln(
                "[bridge] 4 秒内 /health 一直没通（进程可能还在起，也可能崩了）\
                 → 详见 runtime\\bridge.err.log；桌宠本体不受影响",
            );
        }
        Err(e) => {
            crate::logln(format!("[bridge] 启动失败：{e} → 桌宠本体不受影响"));
        }
    }
}

/// 退出时收掉**我们自己**起的桥接。
///
/// 只杀自己起的：用户可能同时开着 v1（它的桥接也监听 8792），
/// 或者手工起过一个桥接用于排障 —— 那些不该被 v2 的退出带下去。
/// 这正是 v1 文档里反复强调的"绝不能按名字杀 node"的同一条道理。
pub fn shutdown() {
    if !spawned_by_us().lock().map(|g| *g).unwrap_or(false) {
        crate::logln("[exit] 桥接不是本次启动的 → 不收尾（避免误杀别人的 node）");
        return;
    }
    let Ok(mut g) = slot().lock() else {
        return;
    };
    let Some(mut child) = g.take() else {
        return;
    };
    let pid = child.id();
    match child.kill() {
        Ok(()) => crate::logln(format!("[exit] 收尾：已结束桥接进程 PID {pid}")),
        Err(e) => {
            // 进程可能已经自己退了 —— 这不是错误，别吓得用户以为出问题了
            crate::logln(format!("[exit] 结束桥接 PID {pid} 时返回：{e}"));
        }
    }
    let _ = child.wait();
}

/// `--diag` 用：不启动、不打扰，只报告桥接当前状态（含 /health 原文）。
pub fn diag_lines() -> Vec<String> {
    let mut out = Vec::new();
    out.push(format!("node.exe        : {}", find_node().map(|p| p.display().to_string()).unwrap_or_else(|| "（没找到）".into())));
    match health() {
        Some(v) => out.push(format!("GET /health     : {v}")),
        None => out.push("GET /health     : 无响应（桥接没在跑）".into()),
    }
    out
}

/// 给 `--diag` 报告用的：把桥接日志尾部拼进来。
pub fn log_tail(runtime: &Path, name: &str, lines: usize) -> Vec<String> {
    let p = runtime.join(name);
    let Ok(text) = std::fs::read_to_string(&p) else {
        return vec![format!("（{name} 不存在或读不了）")];
    };
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    all[start..].iter().map(|s| s.to_string()).collect()
}
