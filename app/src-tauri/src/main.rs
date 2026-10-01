// 普瑞塞斯桌宠 · Tauri 2 外壳
//
// 分层约定：Rust 侧只做「native 才能做的事」——
//   透明窗口 / 点击穿透 / 命中检测 / 窗口层级。
//   动画状态机、仲裁、气泡队列在前端（JS），便于在浏览器里直接调试。
//
// 点击穿透的实现要点（对应评估文档 Q10）：
//   1. 命中检测必须在 Rust 侧：窗口一旦进入穿透状态，WebView 收不到任何鼠标事件，
//      前端无法感知光标重新进入，所以只能由 native 以约 60Hz 轮询。
//   2. 遮罩由前端推送：只有前端知道精灵图的 alpha 与气泡的 DOM 布局。
//      推送的是**归一化格子**（64×64），与 DPI 无关。
//   3. 迟滞切换：进入命中区立刻可交互；离开后等 220ms 才切回穿透。
//      否则快速划过边缘会「吞掉」第一次点击，且悬停光标会闪烁。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 不要控制台窗口：桌宠是纯 GUI 程序，用户双击 exe 时不该弹出一个黑框
// （实测用户截图：双击后跟着一个 cmd 黑框，很不像成品）。
// 代价是 println! 没有去处，所以日志改为**同时写文件**（见 logln），
// 排查不再依赖有没有控制台可以重定向。
#![windows_subsystem = "windows"]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

// --------------------------------------------------------------------------- //
// 原生托盘：直接调 Shell_NotifyIconW
//
// 为什么不只用 Tauri 的 TrayIconBuilder：在这里它**创建成功**（进程里能枚举到
// `tray_icon_app` 窗口），但通知区始终看不到图标 —— 512/128/32 三种尺寸都试过。
// 最可能的原因是 tray-icon 内部用 CreateIconIndirect 从 RGBA 造的 HICON 无效，
// 于是 Shell_NotifyIcon 直接返回失败（窗口还在、图标没登记），而且不报错。
// 这里用 exe 自带的图标资源（失败则退回系统兜底图标）保证句柄一定有效，
// **并把 NIM_ADD 的返回值打到日志里** —— 这样成功/失败是确定的，不用再猜。
// --------------------------------------------------------------------------- //
#[cfg(windows)]
mod native_tray {
    use std::sync::OnceLock;
    use tauri::Manager; // get_webview_window 来自这个 trait，模块内也要引入
    use windows_sys::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Shell::{
        Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    const WM_TRAY: u32 = WM_APP + 1;
    const CMD_TOGGLE: usize = 1;
    const CMD_SETTINGS: usize = 2;
    const CMD_QUIT: usize = 3;

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    /// 托盘窗口句柄，删除图标时要用
    static TRAY_HWND: OnceLock<isize> = OnceLock::new();

    /// 给外部（热键线程）取 AppHandle。
    ///
    /// 为什么不用闭包捕获：热键线程是在 setup 之后才 spawn 的独立线程，
    /// 用 OnceLock 取比把 AppHandle 拷进闭包更好读，也免得忘了 clone。
    pub fn app_handle() -> Option<tauri::AppHandle> {
        APP.get().cloned()
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        if msg == WM_TRAY {
            match (lp as u32) & 0xffff {
                // 左键不做事：用户明确要求"托盘上只放一个 logo、只提供右键菜单"。
                // （以前左键会唤起桌宠窗口，容易在拖动桌宠时误触。）
                WM_LBUTTONUP => {}
                WM_RBUTTONUP | WM_CONTEXTMENU => show_menu(hwnd),
                _ => {}
            }
            return 0;
        }
        if msg == WM_COMMAND {
            match wp & 0xffff {
                CMD_TOGGLE => {
                    if let Some(app) = APP.get() {
                        if let Some(w) = app.get_webview_window("main") {
                            let vis = w.is_visible().unwrap_or(true);
                            if vis { let _ = w.hide(); } else { let _ = w.show(); let _ = w.set_focus(); }
                            crate::logln(format!("[tray] 显示/隐藏 → {}", !vis));
                        }
                    }
                }
                CMD_SETTINGS => {
                    if let Some(app) = APP.get() {
                        crate::open_settings_window(app);
                    }
                }
                CMD_QUIT => {
                    if let Some(app) = APP.get() {
                        crate::logln("[tray] 退出");
                        app.exit(0);
                    }
                }
                _ => {}
            }
            return 0;
        }
        DefWindowProcW(hwnd, msg, wp, lp)
    }

    unsafe fn show_menu(hwnd: HWND) {
        let menu = CreatePopupMenu();
        AppendMenuW(menu, MF_STRING, CMD_TOGGLE, wide("显示 / 隐藏桌宠").as_ptr());
        AppendMenuW(menu, MF_STRING, CMD_SETTINGS, wide("设置…").as_ptr());
        AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
        AppendMenuW(menu, MF_STRING, CMD_QUIT, wide("退出普瑞塞斯").as_ptr());
        let mut pt = POINT { x: 0, y: 0 };
        GetCursorPos(&mut pt);
        // 经典要求：弹出菜单前把窗口设为前台，否则点别处菜单不消失
        SetForegroundWindow(hwnd);
        let cmd = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON,
            pt.x,
            pt.y,
            0,
            hwnd,
            std::ptr::null(),
        ) as usize;
        DestroyMenu(menu);
        if cmd != 0 {
            // 借用同一个 WM_COMMAND 分支，避免逻辑写两份
            wndproc(hwnd, WM_COMMAND, cmd, 0);
        }
    }

    /// 建一个隐藏窗口 + 注册托盘图标；返回是否注册成功
    pub fn install(app: &tauri::AppHandle) -> bool {
        let _ = APP.set(app.clone());
        unsafe {
            let hinst = GetModuleHandleW(std::ptr::null());
            let class = wide("PresageTrayWindow");
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(wndproc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: hinst,
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class.as_ptr(),
            };
            RegisterClassW(&wc);
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                wide("PresageTray").as_ptr(),
                WS_POPUP,
                0, 0, 0, 0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                hinst,
                std::ptr::null_mut(),
            );
            if hwnd.is_null() {
                crate::logln("[tray] 隐藏窗口创建失败");
                return false;
            }
            let _ = TRAY_HWND.set(hwnd as isize);

            // 图标：优先 exe 自带的资源，失败退回系统兜底图标 ——
            // 关键是句柄**必须有效**，否则 Shell_NotifyIcon 会静默失败。
            // exe 的图标资源 id 不一定是 1（实测 LoadImage(id=1) 就取不到），
            // 所以挨个常见 id 试：资源管理器里能看到 exe 图标，说明资源确实在。
            let mut hicon: HICON = std::ptr::null_mut();
            let mut from = "系统兜底 IDI_APPLICATION";
            for id in [1usize, 2, 3, 101, 32512] {
                let h = LoadIconW(hinst, id as *const u16);
                if !h.is_null() {
                    hicon = h;
                    from = "exe 资源";
                    crate::logln(format!("[tray] 用 exe 图标资源 id={id}"));
                    break;
                }
            }
            if hicon.is_null() {
                hicon = LoadIconW(std::ptr::null_mut(), IDI_APPLICATION);
            }
            crate::logln(format!(
                "[tray] 图标句柄来源={} 有效={}",
                from,
                !hicon.is_null()
            ));
            // 提权会让 Shell_NotifyIcon 直接返回 ACCESS_DENIED，而且顺带打掉
            // WebView2 的合成。v1 文档里把"提权"当成过结论又推翻过一次，
            // 所以这里不再猜：直接把令牌里的提权状态打出来。
            crate::logln(format!("[env] {}", crate::elevation_report()));

            let tip = wide("普瑞塞斯 · 桌宠");
            let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
            nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
            nid.hWnd = hwnd;
            nid.uID = 1;
            nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
            nid.uCallbackMessage = WM_TRAY;
            nid.hIcon = hicon;
            for (i, c) in tip.iter().take(127).enumerate() {
                nid.szTip[i] = *c;
            }
            crate::logln(format!(
                "[tray] 诊断 cbSize={} hwnd={:?} hicon={:?}",
                nid.cbSize, nid.hWnd, nid.hIcon
            ));

            // ---- 诊断：窗口站 / 桌面 ----
            // Shell_NotifyIcon 返回 ACCESS_DENIED 的一个经典原因就是
            // "调用进程的窗口站/桌面与 shell 不是同一个"。
            // 这里把名字打出来（纯 ASCII 前缀，任何代码页都能读）。
            {
                use windows_sys::Win32::System::StationsAndDesktops::{
                    GetProcessWindowStation, GetThreadDesktop, GetUserObjectInformationW, UOI_NAME,
                };
                use windows_sys::Win32::System::Threading::GetCurrentThreadId;
                let mut get = |h: HANDLE| -> String {
                    let mut buf = [0u16; 128];
                    let mut need = 0u32;
                    let ok = GetUserObjectInformationW(
                        h,
                        UOI_NAME,
                        buf.as_mut_ptr() as *mut std::ffi::c_void,
                        (buf.len() * 2) as u32,
                        &mut need,
                    );
                    if ok == 0 { return "?".into(); }
                    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                    String::from_utf16_lossy(&buf[..n])
                };
                let ws = get(GetProcessWindowStation());
                let dt = get(GetThreadDesktop(GetCurrentThreadId()));
                crate::logln(format!("[tray] diag windowstation={ws} desktop={dt}"));
            }

            // ---- 诊断：把 NIM_ADD 的失败范围缩到最小 ----
            // 先不带图标试：如果"只有图标"那版失败、这版成功，问题就锁在 HICON 上。
            let mut probe: NOTIFYICONDATAW = std::mem::zeroed();
            probe.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
            probe.hWnd = hwnd;
            probe.uID = 99; // 探测用，不占正文的 id
            probe.uFlags = NIF_MESSAGE | NIF_TIP;
            probe.uCallbackMessage = WM_TRAY;
            for (i, c) in tip.iter().take(127).enumerate() {
                probe.szTip[i] = *c;
            }
            let ok_probe = {
                // 必须先清零：GetLastError 只有在"调用前清零"时才可信，
                // 否则读到的是之前某个 API 留下的旧值（我第一版就踩了这个坑）。
                windows_sys::Win32::Foundation::SetLastError(0);
                Shell_NotifyIconW(NIM_ADD, &probe)
            };
            let err_probe = windows_sys::Win32::Foundation::GetLastError();
            crate::logln(format!(
                "[tray] diag NIM_ADD without-icon ok={ok_probe} err={err_probe}"
            ));
            if ok_probe != 0 {
                let _ = Shell_NotifyIconW(NIM_DELETE, &probe);
            }

            // 完整版：图标 + 消息 + 提示
            for attempt in 1..=5 {
                let ok = {
                    windows_sys::Win32::Foundation::SetLastError(0);
                    Shell_NotifyIconW(NIM_ADD, &nid)
                };
                if ok != 0 {
                    crate::logln(format!("[tray] Shell_NotifyIcon 注册成功（第 {attempt} 次尝试）"));
                    return true;
                }
                let err = windows_sys::Win32::Foundation::GetLastError();
                crate::logln(format!(
                    "[tray] Shell_NotifyIcon 第 {attempt} 次失败，GetLastError={err}"
                ));
                std::thread::sleep(std::time::Duration::from_millis(600));
            }
            crate::logln("[tray] Shell_NotifyIcon 五次都失败（图标不会出现在通知区）");
            false
        }
    }

    #[allow(dead_code)]
    pub fn remove() {
        if let Some(h) = TRAY_HWND.get() {
            unsafe {
                let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
                nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
                nid.hWnd = *h as HWND;
                nid.uID = 1;
                Shell_NotifyIconW(NIM_DELETE, &nid);
            }
        }
    }
}

/// 独立的设置窗口。返回是否**确实**创建成功了。
///
/// 为什么要返回 bool：v1.1 之前失败只写日志，界面上表现为"点设置没反应"，
/// 而用户只看到"闪一下"。前端需要知道失败才能退回窗口内面板（见 open_settings）。
///
/// 为什么要独立窗口（用户明确要求）：设置面板以前塞在桌宠窗口里，
/// 一打开就得把窗口从 340×470 放大到 580×660 —— 无论怎么调位置，
/// 都会出现"桌宠被盖住/被挤走"的问题，用户看不到自己调的大小和透明度。
/// 独立普通窗口（可拖动、可缩放）后，桌宠窗口**完全不动**。
///
/// ⚠️ 关键约束（v1.1 实测踩到，用户报"设置页面会闪一下后消失"）：
/// `main` 窗口是用**配置**建的（`tauri.conf.json` 里带了
/// `additionalBrowserArgs: "--disable-gpu"`），而这里是用 builder 建的 ——
/// 如果不显式传，它会拿到 **wry 的默认参数**，于是同一个进程里出现两个
/// "browser arguments 不同"的 WebView。WebView2 对此直接拒绝：
///
///     HRESULT(0x8007139F)「组或资源的状态不是执行请求操作的正确状态。」
///
/// 日志里表现为 `[settings] 创建窗口失败：… 0x8007139F`，界面表现就是
/// "闪一下然后没有"。所以这里必须把主窗口那套参数**照抄一遍**。
/// 参见 wry 的说明：不同 browser arguments 必须配不同 data directory。
const MAIN_ADDITIONAL_BROWSER_ARGS: &str = "--disable-gpu";

fn open_settings_window(app: &AppHandle) -> bool {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return true;
    }
    // 注意：**不能**把查询串写进 WebviewUrl::App —— Tauri 会把整串当文件路径，
    // 于是去找 "index.html?view=settings" 这个文件，找不到 → 页面一片空白（实测踩到）。
    // 正确做法：正常加载 index.html，窗口就绪后再 eval 让页面切进设置模式。
    match tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("普瑞塞斯 · 设置")
    .inner_size(560.0, 660.0)
    .min_inner_size(420.0, 400.0)
    .resizable(true)
    .decorations(true)
    // 也要置顶：桌宠窗口是 always-on-top，否则设置窗口会被它压住
    // （用户实测截图里"设置面板中间冒出一小块东西"，其实就是被盖住的桌宠窗口）
    .always_on_top(true)
    .skip_taskbar(false)
    // 与 main 窗口保持完全一致的浏览器参数（见函数头注释，少这一行就是 0x8007139F）
    .additional_browser_args(MAIN_ADDITIONAL_BROWSER_ARGS)
    // 窗口底色：页面加载前是窗口背景，默认白色会闪一下（用户实测"先白屏再呈现"）
    .background_color(tauri::window::Color(27, 30, 36, 255))
    .build()
    {
        Ok(w) => {
            logln("[settings] 独立设置窗口已创建");
            // 顺手把桌宠窗口里可能开着的窗口内面板关掉，免得两个面板同时出现
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.eval(
                    "window.PresagePet && window.PresagePet.settings \
                     && window.PresagePet.settings.close && window.PresagePet.settings.close()",
                );
            }
            let w2 = w.clone();
            std::thread::spawn(move || {
                // 页面 boot 要 1~2 秒（拉 manifest / 皮肤 / 词库），所以不能只等一次就 eval：
                // 交给页面自己重试，直到 openSettingsView 可用（最多约 9 秒）。
                std::thread::sleep(Duration::from_millis(600));
                let js = "(function t(n){ \
                    if (window.PresagePet && window.PresagePet.openSettingsView) { \
                        window.PresagePet.openSettingsView(); \
                    } else if (n < 30) { setTimeout(function(){ t(n + 1); }, 300); } \
                    else { console.warn('openSettingsView 一直不可用'); } \
                })(0)";
                match w2.eval(js) {
                    Ok(()) => logln("[settings] 已请求切换到设置视图"),
                    Err(e) => logln(format!("[settings] 切换视图失败：{e}")),
                }
            });
        }
        Err(e) => {
            logln(format!("[settings] 创建窗口失败：{e}"));
            return false;
        }
    }
    true
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    // 两个坑叠在一起：
    //  1) 建窗口必须在主线程上做；
    //  2) 而 `run_on_main_thread` 是**阻塞发送** —— 直接在 IPC 处理线程里调用，
    //     它会和主线程互等，于是前端的 Promise 既不 resolve 也不 reject
    //     （表现："点了没反应、也不报错"）。
    // 所以从旁路线程发起，命令立刻返回，主线程随后被唤醒去建窗口。
    //
    // v1.1 追加：窗口建失败时**告诉前端**，让它退回"窗口内面板"。
    // 之前失败只写日志，用户看到的是"闪一下然后什么都没有"，等于点设置没反应。
    std::thread::spawn(move || {
        let handle = app.clone();
        let handle2 = app.clone();
        if let Err(e) = app.run_on_main_thread(move || {
            let ok = open_settings_window(&handle);
            if !ok {
                logln("[settings] 独立窗口不可用，让前端退回窗口内面板");
                if let Some(main) = handle2.get_webview_window("main") {
                    let _ = main.eval(
                        "window.PresagePet && window.PresagePet.fallbackSettings \
                         && window.PresagePet.fallbackSettings('独立设置窗口创建失败')",
                    );
                }
            }
        }) {
            logln(format!("[settings] 派发到主线程失败：{e}"));
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.eval(
                    "window.PresagePet && window.PresagePet.fallbackSettings \
                     && window.PresagePet.fallbackSettings('派发到主线程失败')",
                );
            }
        }
    });
}

/// 从 `runtime\bridge.pid` 读出桥接进程的 PID。
///
/// PID 由**桥接自己**写（`pet_bridge.mjs --pidfile`）—— 因为启动器是用
/// `powershell Start-Process -WindowStyle Hidden` 隐藏拉起它的，
/// `-PassThru` 拿到的是 powershell 自己的 PID，不是 node 的；
/// 按那个 PID 收尾会杀错进程。只有进程自己知道自己的 PID。
fn read_bridge_pid() -> Option<u32> {
    // 工作目录就是 exe 所在目录（启动器用 start /d 指定），日志也写在它下面
    let path = std::path::PathBuf::from("runtime").join("bridge.pid");
    let text = std::fs::read_to_string(&path).ok()?;
    text.trim().parse::<u32>().ok()
}

/// 退出时收掉由启动器拉起的桥接进程。
///
/// 为什么需要（用户实测反馈）："点击桌宠退出后这个 bridge 仍然没有关闭" ——
/// 留下一个看不见的后台 node 进程，用户既不知道它在跑，也不知道怎么收。
///
/// 安全措施（很重要）：**绝不能**用 `taskkill /im node.exe` 一类的按名字杀 ——
/// 用户的机器上还有别的 node（我自己的诊断工具就是 node）。
/// 这里两条都用上：
///   1) 先按 PID 查进程，确认**镜像名是 node.exe** 才动手；
///   2) 交给 `taskkill /PID <pid> /FI "IMAGENAME eq node.exe" /F`，
///      让 taskkill 再做一次镜像名过滤。
/// 任何一步不对就只写日志、不杀。
fn kill_bridge_if_ours() {
    let Some(pid) = read_bridge_pid() else {
        return; // 没有 PID 文件（比如桌宠不是启动器拉起的）→ 什么都不做
    };
    unsafe {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return; // 进程已经不在了
        }
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
        windows_sys::Win32::Foundation::CloseHandle(h);
        if ok == 0 {
            return;
        }
        let name = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
        if !name.ends_with("node.exe") {
            logln(format!("[exit] PID {pid} 不是 node.exe（{name}），不收尾"));
            return;
        }
    }
    logln(format!("[exit] 收尾：结束桥接进程 PID {pid}"));
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/FI", "IMAGENAME eq node.exe", "/F"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let _ = std::fs::remove_file(std::path::PathBuf::from("runtime").join("bridge.pid"));
}

/// 把外观改动转发给**桌宠窗口**。
///
/// 为什么需要：设置跑在独立窗口里，前端的 `applyAppearance` 里的 `win`
/// 指的是**设置窗口自己** —— 于是"大小"滑块调的是设置页本身（用户实测抓到的笑话）。
/// 这里由 Rust 把 patch 转给 main 窗口，让桌宠去改自己。
#[tauri::command]
fn apply_pet_appearance(app: AppHandle, patch: serde_json::Value) {
    let json = patch.to_string().replace('\\', "\\\\").replace('\'', "\\'");
    if let Some(main) = app.get_webview_window("main") {
        let js = format!(
            "window.PresagePet && window.PresagePet.applyAppearanceFromSettings \
             && window.PresagePet.applyAppearanceFromSettings('{json}')"
        );
        if let Err(e) = main.eval(js) {
            logln(format!("[settings] 转发外观失败：{e}"));
        } else {
            logln(format!("[settings] 外观已转发给桌宠：{json}"));
        }
    }
}

/// 托盘图标（隐藏图标栏里那个小图标）。
///
/// 为什么必须有：桌宠窗口可以整块点击穿透、也常常被拖到屏幕边缘，
/// 一旦"点不到/找不到窗口"，用户就没有任何入口能打开设置或退出。
/// 托盘是最后一道可靠的入口，所以菜单里必须同时有设置和退出。
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "toggle", "显示 / 隐藏桌宠", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出普瑞塞斯", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &settings, &quit])?;

    let mut builder = TrayIconBuilder::with_id("presage-tray")
        .tooltip("普瑞塞斯 · 桌宠")
        .menu(&menu)
        // 左键直接唤起窗口，右键才出菜单（和常见桌宠一致）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => {
                open_settings_window(app);
            }
            "toggle" => {
                if let Some(w) = app.get_webview_window("main") {
                    let visible = w.is_visible().unwrap_or(true);
                    if visible {
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    logln(format!("[tray] 显示/隐藏 → {}", !visible));
                }
            }
            "quit" => {
                logln("[tray] 退出");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });

    // 托盘图标要用**最小标准尺寸**：Windows 通知区按 16/32px 渲染。
    // 512 与 128 都试过、系统侧托盘窗口（tray_icon_app）也确实建起来了，
    // 但通知区里看不到 —— 换成 32×32 这个最标准的尺寸再试。
    match tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")) {
        Ok(img) => {
            logln(format!("[tray] 图标 {}x{} 已加载", img.width(), img.height()));
            builder = builder.icon(img);
        }
        Err(e) => {
            logln(format!("[tray] 从 PNG 建图标失败：{e}，退回默认窗口图标"));
            if let Some(icon) = app.default_window_icon() {
                logln(format!("[tray] 默认图标 {}x{}", icon.width(), icon.height()));
                builder = builder.icon(icon.clone());
            } else {
                logln("[tray] 没有可用的默认图标（图标会是空的）");
            }
        }
    }
    // 必须保住返回值：TrayIcon 一旦被 drop，托盘图标就会消失。
    // 这里是有意的"泄漏一个应用级对象"，比塞进 state 再到处取更不容易出错。
    let tray = builder.build(app)?;
    std::mem::forget(tray);
    logln("[tray] 托盘图标已就绪（右键：设置 / 显示隐藏 / 退出）");
    Ok(())
}

/// 只切换 WS_EX_TRANSPARENT，不碰 WS_EX_LAYERED。
/// 实测：Tauri 的 set_ignore_cursor_events(false) 不会清掉 TRANSPARENT，
/// 于是「切回可交互」名义上成功、窗口实际仍然完全穿透。
/// 而 WS_EX_TRANSPARENT 单独一位就足够实现整窗穿透（逐像素命中由我们的遮罩负责）。
/// 切换点击穿透。
///
/// **必须同时设 WS_EX_LAYERED**：只设 WS_EX_TRANSPARENT 是不生效的。
/// 依据是 Tauri 底层 tao 的实现（tao-0.37.1/src/platform_impl/windows/window_state.rs:282）：
///     if self.contains(WindowFlags::IGNORE_CURSOR_EVENT) {
///         style_ex |= WS_EX_TRANSPARENT | WS_EX_LAYERED;
///     }
/// 之前我只切了 TRANSPARENT 那一位，于是"样式位对了、点击却照样被挡住"——
/// 这是被用户实际使用抓出来的（我当时的验证只看了样式位，没验点击行为）。
/// 切回可交互时**保留 LAYERED**：去掉它会让窗口重绘一次、可能闪一下。
#[cfg(windows)]
fn set_click_through(window: &tauri::WebviewWindow, on: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_TRANSPARENT,
    };
    let Ok(hwnd) = window.hwnd() else { return };
    let raw = hwnd.0;
    unsafe {
        let ex = GetWindowLongPtrW(raw, GWL_EXSTYLE);
        let want = if on {
            ex | WS_EX_TRANSPARENT as isize | WS_EX_LAYERED as isize
        } else {
            ex & !(WS_EX_TRANSPARENT as isize)
        };
        if want != ex {
            SetWindowLongPtrW(raw, GWL_EXSTYLE, want);
        }
        logln(format!("[pointer] click_through={on} EX=0x{want:06X}"));
    }
}

#[cfg(not(windows))]
fn set_click_through(window: &tauri::WebviewWindow, on: bool) {
    let _ = window.set_ignore_cursor_events(on);
}

/// 光标轮询间隔（约 60Hz）
const POLL_MS: u64 = 16;
/// 离开命中区后多久切回穿透（迟滞）
const LEAVE_DELAY_MS: u64 = 220;

/// 命中遮罩：窗口被切成 cols×rows 个格子，非 0 表示该格有可见内容（可交互）。
/// 64×64=4KB，60Hz 读取毫无压力。
#[derive(Default)]
struct HitMask {
    cols: usize,
    rows: usize,
    bits: Vec<u8>,
}

impl HitMask {
    fn hit(&self, nx: f64, ny: f64) -> Option<bool> {
        if self.cols == 0 || self.rows == 0 || self.bits.len() < self.cols * self.rows {
            return None; // 遮罩还没到
        }
        if !(0.0..1.0).contains(&nx) || !(0.0..1.0).contains(&ny) {
            return Some(false);
        }
        let cx = ((nx * self.cols as f64) as usize).min(self.cols - 1);
        let cy = ((ny * self.rows as f64) as usize).min(self.rows - 1);
        Some(self.bits[cy * self.cols + cx] != 0)
    }

    /// 填充格子的归一化包围盒——用来核对「遮罩覆盖的位置」是否就是角色所在处
    fn bbox(&self) -> Option<(f64, f64, f64, f64)> {
        if self.cols == 0 || self.rows == 0 || self.bits.len() < self.cols * self.rows {
            return None;
        }
        let (mut c0, mut r0, mut c1, mut r1) = (usize::MAX, usize::MAX, 0usize, 0usize);
        for r in 0..self.rows {
            for c in 0..self.cols {
                if self.bits[r * self.cols + c] != 0 {
                    c0 = c0.min(c);
                    r0 = r0.min(r);
                    c1 = c1.max(c);
                    r1 = r1.max(r);
                }
            }
        }
        if c0 == usize::MAX {
            return None;
        }
        Some((
            c0 as f64 / self.cols as f64,
            r0 as f64 / self.rows as f64,
            (c1 + 1) as f64 / self.cols as f64,
            (r1 + 1) as f64 / self.rows as f64,
        ))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PointerMode {
    /// 按命中遮罩动态切换
    Auto,
    /// 强制穿透（逃生用，自动回退）
    Passthrough,
    /// 强制可交互（逃生用，自动回退）
    Interactive,
}

struct Shared {
    mask: Mutex<HitMask>,
    mode: Mutex<PointerMode>,
    /// 上一次报告的填充量，用来抑制日志刷屏（遮罩每 500ms 会重推一次）
    last_filled: Mutex<Option<usize>>,
}

/// 前端推送命中遮罩。前端在「状态切换 / 气泡变化 / 窗口尺寸变化」时调用。
#[tauri::command]
fn set_hitmask(shared: tauri::State<'_, Arc<Shared>>, cols: u32, rows: u32, bits: Vec<u8>) {
    let filled = bits.iter().filter(|b| **b != 0).count();
    {
        let mut m = shared.mask.lock().unwrap();
        m.cols = cols as usize;
        m.rows = rows as usize;
        m.bits = bits;
    }
    // stdout 被重定向到 runtime/pet.out.log —— 这是排查 native 侧问题最直接的通道。
    // 只在填充量明显变化时打印：遮罩每 500ms 会重推一次，全打会刷屏。
    let mut last = shared.last_filled.lock().unwrap();
    let significant = match *last {
        None => true,
        Some(prev) => filled.abs_diff(prev) > 40,
    };
    if significant {
        *last = Some(filled);
        let bbox = shared.mask.lock().unwrap().bbox();
        logln(format!(
            "[hitmask] {}x{} filled={}/{} ({:.1}%) bbox={:?}",
            cols, rows, filled, cols * rows,
            if cols * rows == 0 { 0.0 } else { filled as f64 / (cols * rows) as f64 * 100.0 },
            bbox
        ));
    }
    drop(last);
}

/// 设置指针模式。seconds > 0 时到点自动回退到 auto。
#[tauri::command]
fn set_pointer_mode(
    app: AppHandle,
    shared: tauri::State<'_, Arc<Shared>>,
    mode: String,
    seconds: u64,
) {
    let parsed = match mode.as_str() {
        "passthrough" => PointerMode::Passthrough,
        "interactive" => PointerMode::Interactive,
        _ => PointerMode::Auto,
    };
    *shared.mode.lock().unwrap() = parsed;

    // 逃生开关必须能自动回退，否则「强制穿透」之后用户再也点不到窗口了
    if parsed != PointerMode::Auto && seconds > 0 {
        let shared = Arc::clone(&shared);
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(seconds));
            *shared.mode.lock().unwrap() = PointerMode::Auto;
            if let Some(w) = app2.get_webview_window("main") {
                set_click_through(&w, false);
            }
        });
    }
}

/// 前端把诊断信息打到 native 的 stdout（= runtime/pet.out.log）。
/// 页面没有可读的输出通道，排查前端问题时这是最直接的一条。
#[tauri::command]
fn front_log(msg: String) {
    logln(format!("[front] {msg}"));
}

/// 运行时配置：让数据源/桥接地址可以用环境变量切换，不必重新构建。
///   PRESAGE_SOURCE=live|demo     （默认 demo，便于无 Agent 时也能看动画）
///   PRESAGE_BRIDGE=http://127.0.0.1:8792
#[tauri::command]
fn runtime_config() -> serde_json::Value {
    // 默认 live：桌面应用本该吃真实数据；演示数据要显式指定（浏览器预览用 ?source=demo）。
    // 默认 demo 的后果是"看起来在动、其实是假的剧本"，且很难察觉。
    let source = std::env::var("PRESAGE_SOURCE").unwrap_or_else(|_| "live".to_string());
    let bridge = std::env::var("PRESAGE_BRIDGE")
        .unwrap_or_else(|_| "http://127.0.0.1:8792".to_string());
    // 必须留痕：数据源没生效时，症状是"桌宠在动但内容是假的"，
    // 光看状态日志分辨不出来（demo 会推一套很像真事的剧本）。实测踩过。
    logln(format!("[config] source={source} bridge={bridge}"));
    serde_json::json!({ "source": source, "bridge": bridge })
}

/// 一条会立刻落盘的日志。
///
/// stdout 被重定向到文件时是**块缓冲**：不显式 flush 就可能一直看不到输出，
/// 让人误以为"进程没起来/没出错"（实测踩过）。所有 native 日志都走这里。
fn logln(msg: impl AsRef<str>) {    use std::io::Write;
    let text = msg.as_ref();
    // 注意：GUI 子系统下没有 stdout，`println!` 写失败会 **panic**（实测：
    // 换 windows_subsystem="windows" 后程序启动即死）。所以这里必须用
    // writeln! 并忽略错误，日志以文件为准。
    let _ = writeln!(std::io::stdout(), "{text}");
    let _ = std::io::stdout().flush();
    // 同时落一份日志文件：不管怎么启动（双击 exe / .bat / 计划任务 / 快捷方式），
    // 排查都不依赖"有没有控制台能重定向"。
    // 两个位置都写：当前目录下的 runtime\（.bat 启动时命中），以及 LOCALAPPDATA（总是可写）。
    let mut targets: Vec<std::path::PathBuf> = Vec::new();
    targets.push(std::path::PathBuf::from("runtime").join("pet.out.log"));
    if let Ok(base) = std::env::var("LOCALAPPDATA") {
        targets.push(std::path::PathBuf::from(base).join("PresagePet").join("pet.log"));
    }
    for p in targets {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
            let _ = writeln!(f, "{text}");
        }
    }
}

fn cursor_geometry(app: &AppHandle, shared: &Shared) -> Option<(f64, f64, Option<bool>, (i32, i32, u32, u32))> {
    let w = app.get_webview_window("main")?;
    let cursor = app.cursor_position().ok()?; // 物理像素
    let pos = w.outer_position().ok()?;
    let size = w.outer_size().ok()?;
    if size.width == 0 || size.height == 0 {
        return None;
    }
    let x = cursor.x - pos.x as f64;
    let y = cursor.y - pos.y as f64;
    let nx = x / size.width as f64;
    let ny = y / size.height as f64;
    let mask = shared.mask.lock().unwrap();
    let hit = mask.hit(nx, ny);
    Some((nx, ny, hit, (pos.x, pos.y, size.width, size.height)))
}

fn start_pointer_watch(app: AppHandle, shared: Arc<Shared>) {
    std::thread::spawn(move || {
        let mut ignoring = false;
        let mut left_at: Option<Instant> = None;
        let mut last_log = Instant::now() - Duration::from_secs(10);
        // 启动时先设为可交互，避免遮罩到达前窗口点不到
        if let Some(w) = app.get_webview_window("main") {
            set_click_through(&w, false);
        }
        loop {
            std::thread::sleep(Duration::from_millis(POLL_MS));
            let mode = *shared.mode.lock().unwrap();
            let geo = cursor_geometry(&app, &shared);
            // 调试：光标在窗口内时按 500ms 节流打印几何（核对遮罩与坐标）
            if let Some((nx, ny, hit, (wx, wy, ww, wh))) = geo {
                if (0.0..1.0).contains(&nx) && (0.0..1.0).contains(&ny)
                    && last_log.elapsed() > Duration::from_millis(500) {
                    last_log = Instant::now();
                    let bbox = shared.mask.lock().unwrap().bbox();
                    logln(format!(
                        "[cursor] win=({wx},{wy}) {ww}x{wh} n=({nx:.3},{ny:.3}) hit={hit:?} mask_bbox={bbox:?}"
                    ));
                } else if last_log.elapsed() > Duration::from_millis(3000) {
                    // 光标在窗外也要能看到：否则"全穿透"到底是正确行为还是坏了，无从判断
                    last_log = Instant::now();
                    logln(format!(
                        "[cursor-out] win=({wx},{wy}) {ww}x{wh} n=({nx:.3},{ny:.3}) → 穿透"
                    ));
                }
            } else if last_log.elapsed() > Duration::from_millis(5000) {
                last_log = Instant::now();
                logln("[cursor-none] 拿不到光标或窗口几何（cursor_position/outer_position 失败）");
            }
            let want = match mode {
                PointerMode::Passthrough => true,
                PointerMode::Interactive => false,
                PointerMode::Auto => match geo.map(|g| g.2) {
                    Some(Some(true)) => {
                        left_at = None; // 回到命中区，立刻可交互
                        false
                    }
                    Some(Some(false)) => {
                        let since = *left_at.get_or_insert_with(Instant::now);
                        if since.elapsed() < Duration::from_millis(LEAVE_DELAY_MS) {
                            ignoring // 迟滞窗口内保持现状，不吞掉边缘点击
                        } else {
                            true
                        }
                    }
                    _ => false, // 遮罩未就绪或拿不到窗口，先保持可交互
                },
            };
            if want != ignoring {
                ignoring = want;
                logln(format!("[pointer] ignore_cursor_events = {ignoring}"));
                use std::io::Write;
                let _ = std::io::stdout().flush();
                if let Some(w) = app.get_webview_window("main") {
                    set_click_through(&w, ignoring);
                }
            }
        }
    });
}

/// 当前进程是否以管理员令牌运行。
///
/// 为什么要打这条日志：v1 文档里"提权是根因"曾经被当成结论、又被一次实测推翻，
/// 来回浪费了两轮。托盘返回 ACCESS_DENIED 时，第一个要问的就是"我到底提权了没有"，
/// 而这个答案必须来自令牌本身，不能靠猜"是不是右键以管理员运行"。
fn elevation_report() -> String {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        // 注意模块归属（编译期实测，别凭记忆写）：
        //   OpenProcessToken 在 Win32::System::Threading
        //   GetTokenInformation / TokenElevation / TOKEN_ELEVATION / TOKEN_QUERY 在 Win32::Security
        use windows_sys::Win32::Security::{
            GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return "提权=未知（OpenProcessToken 失败）".into();
            }
            let mut elev: TOKEN_ELEVATION = std::mem::zeroed();
            let mut ret = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                &mut elev as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut ret,
            );
            let _ = CloseHandle(token);
            if ok == 0 {
                return "提权=未知（GetTokenInformation 失败）".into();
            }
            if elev.TokenIsElevated != 0 {
                "提权=是 ← 这是托盘被拒 / 画面异常的已知诱因，请改用普通双击启动".into()
            } else {
                "提权=否".into()
            }
        }
    }
    #[cfg(not(windows))]
    {
        "提权=不适用".into()
    }
}

/// 托盘不可用时的兜底提示 + 键盘逃生入口。
///
/// 背景（OPEN-ISSUES 问题 1.1）：
///   * 这台机器上 `Shell_NotifyIcon` 返回 ACCESS_DENIED（提权=否，已排除提权），
///     托盘图标永远不出现；这一条已**降级为已知限制**，不再继续查；
///   * 而"托盘右键菜单"是 v1 唯一的可靠入口 —— 托盘没了，用户就只能靠
///     桌宠的右键菜单，可那需要他先精确点到角色身上。
/// 所以这里补两件事：
///   1) 托盘注册失败时，让前端提示一次（只一次：是否已提示由前端用
///      localStorage 记账，见 main.js 的 `notice()`）；
///   2) 注册一个**全局**热键 Ctrl+Alt+Q（退出）与 Ctrl+Alt+S（设置），
///      这样即使窗口被拖到屏幕外/整块穿透，用户也一定退得掉。
#[cfg(windows)]
fn install_escape_hatches(app: &AppHandle, tray_ok: bool) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

    const HK_QUIT: i32 = 0xA11;
    const HK_SETTINGS: i32 = 0xA12;

    if tray_ok {
        return;
    }
    // 让前端在 boot 完成后提示一次。前端可能还没起来，所以少量重试；
    // eval 成功即停 —— 否则会在每次重试里再弹一遍（会变成骚扰）。
    let w = app.get_webview_window("main");
    std::thread::spawn(move || {
        let Some(w) = w else { return };
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(500));
            let js = "window.PresagePet && window.PresagePet.notice \
                      && window.PresagePet.notice('托盘图标被系统拒绝注册：右键我 → 设置/退出；\
或按 Ctrl+Alt+S 设置、Ctrl+Alt+Q 退出')";
            if w.eval(js).is_ok() {
                logln("[tray] 已请求前端提示（是否真的显示由前端记账，只会显示一次）");
                return;
            }
        }
    });

    std::thread::spawn(move || unsafe {
        // 注册失败不影响主功能：只是没有快捷键兜底
        let q = RegisterHotKey(std::ptr::null_mut(), HK_QUIT, (MOD_CONTROL | MOD_ALT | MOD_NOREPEAT) as u32, 'Q' as u32);
        let s = RegisterHotKey(std::ptr::null_mut(), HK_SETTINGS, (MOD_CONTROL | MOD_ALT | MOD_NOREPEAT) as u32, 'S' as u32);
        logln(format!(
            "[hotkey] Ctrl+Alt+Q 退出={} Ctrl+Alt+S 设置={}",
            if q != 0 { "ok" } else { "失败" },
            if s != 0 { "ok" } else { "失败" }
        ));
        let mut msg: MSG = std::mem::zeroed();
        // 这个线程只服务热键消息，退出时机跟着进程走
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            if msg.message != WM_HOTKEY {
                continue;
            }
            let app = native_tray::app_handle();
            let Some(app) = app else { continue };
            match msg.wParam as i32 {
                HK_QUIT => {
                    logln("[hotkey] Ctrl+Alt+Q → 退出");
                    app.exit(0);
                }
                HK_SETTINGS => {
                    logln("[hotkey] Ctrl+Alt+S → 设置");
                    crate::open_settings_window(&app);
                }
                _ => {}
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // 托盘先建：窗口可以穿透、可以被拖到角落，托盘是用户最后的可靠入口。
            // 用原生 Shell_NotifyIcon 实现（Tauri 那个在这里创建成功但通知区不显示）。
            #[cfg(windows)]
            {
                let tray_ok = native_tray::install(app.handle());
                // 托盘不可用时补上兜底：提示 + 全局热键（见函数注释）
                install_escape_hatches(app.handle(), tray_ok);
            }
            #[cfg(not(windows))]
            {
                if let Err(e) = setup_tray(app) {
                    logln(format!("[tray] 创建失败：{e}"));
                }
            }
            let shared = Arc::new(Shared {
                mask: Mutex::new(HitMask::default()),
                mode: Mutex::new(PointerMode::Auto),
                last_filled: Mutex::new(None),
            });
            app.manage(Arc::clone(&shared));

            if let Some(w) = app.get_webview_window("main") {
                // 配置里写了 skipTaskbar=true 但实测无效（窗口仍进任务栏，
                // 扩展样式是 WS_EX_APPWINDOW 而非 WS_EX_TOOLWINDOW），这里显式再设一次。
                let _ = w.set_skip_taskbar(true);

                // PRESAGE_SELFTEST=1 时，页面加载后跑一次内置交互自检
                // （沙箱里 OS 级输入合成不可靠，用它验证前端这条链）
                if std::env::var("PRESAGE_SELFTEST").is_ok() {
                    let mode = std::env::var("PRESAGE_SELFTEST").unwrap_or_default();
                    let w2 = w.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(6000));
                        logln(format!("[selftest] triggering frontend interaction self-test mode={mode}"));
                        let js = format!(
                            "window.PresagePet && window.PresagePet.selfTest(5, '{}')",
                            mode.replace('\'', "")
                        );
                        let _ = w2.eval(js);
                    });
                }
            }

            start_pointer_watch(app.handle().clone(), shared);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_hitmask, set_pointer_mode, front_log, runtime_config, open_settings,
            apply_pet_appearance
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // 退出时收掉启动器拉起的桥接进程（见 kill_bridge_if_ours 的说明）。
            // 放在 RunEvent::Exit 而不是 Drop/panic hook：用户点"退出"走的就是这条路。
            #[cfg(windows)]
            if let tauri::RunEvent::Exit = event {
                kill_bridge_if_ours();
            }
            #[cfg(not(windows))]
            let _ = event;
        });
}
