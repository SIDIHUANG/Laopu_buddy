//! v2 预检：在 Tauri / WebView2 起来**之前**把「双击 exe 就能用」所需的
//! 一切准备好。
//!
//! 这个模块存在的理由（v1 的真实痛点，见 docs/设计备注-去掉bat启动器.md）：
//! v1 把这几件事写在了 `启动桌宠.bat` 里 —— 定位 WebView2Loader.dll、设
//! `WEBVIEW2_USER_DATA_FOLDER`、profile 坏了重建、单实例检查、启动后自检。
//! 于是「双击 exe」是**不可用**的，用户必须双击 bat，而 bat 又被迫承担
//! 一堆它本来不该管的事（每一条都是被真实故障逼出来的）。
//!
//! v2 的做法：这些事 exe 在进程内部做，信息本来就完整，也不需要第二份实现
//! 去跟它同步。派生出的两条硬约束（写在代码里免得下次重犯）：
//!
//!   * 工作目录一律**锚到 exe 所在目录**，不依赖启动方式。
//!     v1 因为依赖"当前目录"，`v1\启动桌宠.bat` 与根目录 bat 的日志会落到
//!     两个地方，自检段因此读到空文件（用户实测抓到过）。
//!   * 环境变量只在这里设一次，且**先于** `tauri::Builder::build()` —— WebView2
//!     Loader 是在那个时刻读 `WEBVIEW2_USER_DATA_FOLDER` 的。

use std::path::{Path, PathBuf};

/// 预检结果。给日志 / `--diag` 报告用，免得各处再算一遍。
#[derive(Clone, Debug)]
pub struct Preflight {
    pub exe: PathBuf,
    /// 一切相对路径的基准（= exe 所在目录）
    pub root: PathBuf,
    /// `<root>\runtime` —— 日志、WebView2 profile、桥接、events 都在这里
    pub runtime: PathBuf,
    /// WebView2 的 user data folder（本次实际使用的那个）
    pub profile: PathBuf,
    /// profile 是不是从 `WEBVIEW2_USER_DATA_FOLDER` 继承来的（排障要看这个：
    /// 用户环境里如果残留了这个变量，我们用的 profile 就不是默认那个）
    pub profile_from_env: bool,
    /// 上一次启动失败的标记文件是否存在（存在 → 本次先删 profile 重建）
    pub had_fail_mark: bool,
    /// `WebView2Loader.dll` 是否与 exe 同目录（缺了会 0xC0000135 静默秒退）
    pub loader_ok: bool,
    /// WebView2 Evergreen 运行时是否在注册表里（缺了要提示安装 Runtime）
    pub wv2_runtime: bool,
    /// 命令行开关
    pub diag: bool,
    pub version: bool,
}

/// exe 所在目录。
///
/// 为什么要用它当基准：用户可能从任何地方启动（双击、快捷方式、别的程序的
/// "打开方式"、计划任务），而这些情况下**当前目录各不相同**。exe 自己的位置
/// 反而是唯一稳定的锚点。
pub fn exe_dir() -> PathBuf {
    if let Ok(p) = std::env::current_exe() {
        if let Some(dir) = p.parent() {
            return dir.to_path_buf();
        }
    }
    // 理论上到不了这里（Windows 上 current_exe 一定有父目录）。
    // 兜底用当前目录，总比 panic 好 —— 桌宠本体还能跑。
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// 允许用环境变量换一个"根"（排障 / 自动化测试用）。
///
/// 注意：它**只影响我们自己的目录推导**，不影响 Tauri 的资源加载（资源是
/// 编进 exe 的，本来就跟目录无关）。给这条的理由是"要把整个工作目录搬到
/// 别处跑一次对照实验"时不用改代码。
fn root_override() -> Option<PathBuf> {
    std::env::var_os("PRESAGE_ROOT").map(PathBuf::from)
}

/// WebView2 user data folder 的判定。
///
/// 顺序（不可颠倒）：
///   1. `WEBVIEW2_USER_DATA_FOLDER` 已经存在 → **照用不动**。
///      理由：它可能是调用方（自动化测试脚本、排障脚本）显式指定的；
///      而且 WebView2 自己的行为也是"这个变量优先于 API 参数"。
///   2. 否则用默认 `<root>\runtime\webview2`。
///
/// 默认值必须是**固定**目录（v1 的结论）：profile 一旦被强杀写坏，
/// 之后每次启动都会以 `0x8000FFFF 灾难性故障` 失败；固定目录才能做到
/// "下次启动自动删掉重建"，随机目录只会把垃圾越攒越多。
fn resolve_profile(root: &Path) -> (PathBuf, bool) {
    if let Some(v) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
        if !v.is_empty() {
            return (PathBuf::from(v), true);
        }
    }
    (root.join("runtime").join("webview2"), false)
}

fn has_webview2_runtime() -> bool {
    #[cfg(windows)]
    {
        // 实现在 registry_probe（键名 + 三个安装位置都写在那边）
        crate::registry_probe::has_webview2_runtime()
    }
    #[cfg(not(windows))]
    {
        true
    }
}

/// 命令行参数解析。
///
/// 支持 `--diag` / `-Diag` 与 `--version` / `-v`，其余参数一律忽略
/// （双击启动时没有参数；带别的参数也不能因此启动失败）。
fn parse_args() -> (bool, bool) {
    let mut diag = false;
    let mut version = false;
    for a in std::env::args().skip(1) {
        let a = a.to_ascii_lowercase();
        match a.as_str() {
            "--diag" | "-diag" | "/diag" => diag = true,
            "--version" | "-v" | "/v" => version = true,
            _ => {}
        }
    }
    (diag, version)
}

/// 预检主流程。**必须在 `tauri::generate_context!()` / `build()` 之前调用**。
pub fn run() -> Preflight {
    let (diag, version) = parse_args();
    let exe = std::env::current_exe().unwrap_or_default();
    let root = root_override().unwrap_or_else(exe_dir);
    let runtime = root.join("runtime");

    // 目录：全部先建好。任何一步失败都不阻止启动（后面用它的地方会自己降级）。
    let _ = std::fs::create_dir_all(&runtime);
    let _ = std::fs::create_dir_all(runtime.join("events"));

    // 上一次启动失败的标记（由 main 在 build 失败时写）→ 本次先删 profile。
    // 这就是 v1 bat 里"profile 坏了自动重建"那一段，搬进 exe。
    let fail_mark = runtime.join(".boot-failed");
    let had_fail_mark = fail_mark.exists();
    let (profile, profile_from_env) = resolve_profile(&root);
    if had_fail_mark {
        let _ = std::fs::remove_file(&fail_mark);
        if !profile_from_env {
            // 只删我们自己的固定目录；用户显式指定的目录不擅自删
            let _ = std::fs::remove_dir_all(&profile);
        }
    }
    let _ = std::fs::create_dir_all(&profile);
    unsafe {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &profile);
    }

    // WebView2Loader.dll 必须在 exe 旁边。缺了的表现是**双击毫无反应**
    // （0xC0000135 STATUS_DLL_NOT_FOUND，Windows 连对话框都不给），
    // 所以在这里提前说清楚（v1 是 bat 替用户查的）。
    let loader_ok = root.join("WebView2Loader.dll").exists();

    let wv2_runtime = has_webview2_runtime();

    // current_exe 成功时 parent 一定存在，这里只是把 exe 目录记进日志方便核对。
    Preflight { exe, root, runtime, profile, profile_from_env, had_fail_mark, loader_ok, wv2_runtime, diag, version }
}

/// 单实例判定：全局命名互斥体。
///
/// 为什么比 v1 bat 里的 `tasklist | findstr` 好：
///   * 没有竞态 —— 两个进程同时启动，也只有一个能拿到互斥体；
///     `tasklist` 那种写法在"上一次刚退出、进程还没完全消失"时会误判。
///   * 名字里带 **exe 路径的哈希** —— 同一台机器上同时跑 v1 与 v2
///     （或在两份目录里各放一份）互不影响。按名字一刀切会把这种情况锁死，
///     而"对照实验"恰恰经常需要两份同时跑。
///
/// 返回 `None` 表示"已经有实例在跑"。
pub fn single_instance() -> Option<InstanceGuard> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
        use windows_sys::Win32::System::Threading::CreateMutexW;
        let key = root_key();
        let name: Vec<u16> = format!("Global\\PresagePet.SingleInstance.{key}")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            // 不请求所有权（bInheritHandle=FALSE / 不 WaitForSingleObject）：
            // 我们要的只是"这个名字是否已存在"，句柄留着直到进程退出。
            let h = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
            if h.is_null() {
                // 建不出来（极端情况）→ 不能因此拒绝启动，当作"没有别的实例"
                return Some(InstanceGuard { handle: std::ptr::null_mut() });
            }
            if GetLastError() == ERROR_ALREADY_EXISTS {
                // 我们拿到的是**已存在**的那个互斥体的句柄：
                // 直接丢掉会让它立刻关闭，所以什么都不做、返回 None 让 main 退出。
                return None;
            }
            return Some(InstanceGuard { handle: h });
        }
    }
    #[cfg(not(windows))]
    {
        Some(InstanceGuard { handle: std::ptr::null_mut() })
    }
}

/// 互斥体句柄的持有者。掉线（进程退出）时由系统回收 —— 不需要显式释放，
/// 但保留 `Drop` 让所有权清晰、也避免"句柄泄漏"的静态检查告警。
pub struct InstanceGuard {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
    #[cfg(not(windows))]
    handle: *mut std::ffi::c_void,
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            if !self.handle.is_null() {
                windows_sys::Win32::Foundation::CloseHandle(self.handle);
            }
        }
    }
}

/// 由 exe 路径算出的稳定短标识（FNV-1a 64 位）。
///
/// 用哈希而不是完整路径：互斥体名字里塞长路径容易踩到名字长度/转义问题，
/// 而且路径本身带用户目录，不必要地泄漏到全局命名空间里。
fn root_key() -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let s = exe_dir().to_string_lossy().to_lowercase();
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// 上一次启动是否留下了失败标记。
pub fn mark_boot_failed(runtime: &Path, reason: &str) {
    let _ = std::fs::write(runtime.join(".boot-failed"), reason);
}

pub fn clear_boot_failed(runtime: &Path) {
    let _ = std::fs::remove_file(runtime.join(".boot-failed"));
}
