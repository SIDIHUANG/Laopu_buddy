//! 注册表查询：WebView2 Evergreen 运行时是否已安装。
//!
//! 为什么值得单独一个文件：**缺 WebView2 Runtime 才是"双击毫无反应"的另一个
//! 常见原因**（和缺 `WebView2Loader.dll` 长得一样）。v1 的诊断要靠用户看 bat
//! 的输出，v2 里 exe 自己就能说清楚，还顺手把官方安装地址写进报告。
//!
//! 键名说明（官方文档给的 client GUID）：
//!   `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` —— Evergreen Runtime
//! 三个位置都要看：64 位机器上的 WOW6432Node（32 位安装）、原生 64 位、
//! 以及 HKCU（非管理员按用户安装时写这里）。

#[cfg(windows)]
pub fn has_webview2_runtime() -> bool {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ,
    };

    const SUB: &str =
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const SUB64: &str =
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn open(hive: HKEY, sub: &str) -> bool {
        unsafe {
            let mut h: HKEY = std::ptr::null_mut();
            let rc = RegOpenKeyExW(hive, wide(sub).as_ptr(), 0, KEY_READ, &mut h);
            if rc == 0 {
                RegCloseKey(h);
                true
            } else {
                false
            }
        }
    }

    open(HKEY_LOCAL_MACHINE, SUB)
        || open(HKEY_LOCAL_MACHINE, SUB64)
        || open(HKEY_CURRENT_USER, SUB)
        || open(HKEY_CURRENT_USER, SUB64)
}

#[cfg(not(windows))]
pub fn has_webview2_runtime() -> bool {
    true
}
