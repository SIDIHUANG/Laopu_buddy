//! 原生对话框。
//!
//! 为什么 v2 需要它：v1 把"缺 WebView2Loader.dll / profile 坏了"的提示写在了
//! `启动桌宠.bat` 里（`echo` + `pause`）。去掉 bat 之后，这些提示必须由 exe
//! 自己给出来 —— 而 exe 是 **GUI 子系统**，没有 stdout（`println!` 会 panic），
//! 所以唯一能"让用户看见"的通道就是 Windows 自己的对话框。
//!
//! 这一条是"双击 exe 可用"的关键：缺 DLL 时双击的表现是**毫无反应**
//! （`0xC0000135`，Windows 连错误框都不弹），用户只会以为程序坏了。

/// 弹一个错误框（带 MB_ICONERROR）。
pub fn error(title: &str, body: &str) {
    message(title, body, 0x0000_0010 /* MB_ICONERROR */);
}

pub fn info(title: &str, body: &str) {
    message(title, body, 0x0000_0040 /* MB_ICONINFORMATION */);
}

#[cfg(windows)]
fn message(title: &str, body: &str, flags: u32) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_SETFOREGROUND, MB_TOPMOST};
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    unsafe {
        // MB_TOPMOST：桌宠是置顶窗口，普通对话框可能被压在它下面（用户实测过"闪一下"）
        MessageBoxW(
            std::ptr::null_mut(),
            wide(body).as_ptr(),
            wide(title).as_ptr(),
            flags | MB_TOPMOST | MB_SETFOREGROUND,
        );
    }
}

#[cfg(not(windows))]
fn message(title: &str, body: &str, _flags: u32) {
    eprintln!("[{title}] {body}");
}
