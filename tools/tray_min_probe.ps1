# Minimal probe: call Shell_NotifyIconW only (no Tauri, no WebView2) and report
# the result plus whether this session has a shell (explorer.exe).
#
# Goal (OPEN-ISSUES 1.1 step 1): take "tray registration denied" out of the
# project's scope. If even this minimal NIM_ADD returns err=5, the denial comes
# from the session / notification-area environment, not from the pet's code.
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -Namespace Tray -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern IntPtr CreateWindowExW(int exStyle, string cls, string title, int style,
  int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern ushort RegisterClassW(ref WNDCLASS wc);
[DllImport("shell32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool Shell_NotifyIconW(uint msg, ref NOTIFYICONDATAW data);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern IntPtr GetModuleHandleW(string name);
[DllImport("user32.dll")]
public static extern IntPtr GetProcessWindowStation();
[DllImport("user32.dll")]
public static extern IntPtr GetThreadDesktop(uint tid);
[DllImport("kernel32.dll")]
public static extern uint GetCurrentThreadId();
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool GetUserObjectInformationW(IntPtr h, int idx, System.Text.StringBuilder buf, int len, out int need);

public delegate IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct WNDCLASS {
  public uint style; public WndProc lpfnWndProc; public int cbClsExtra; public int cbWndExtra;
  public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground;
  public string lpszMenuName; public string lpszClassName;
}

[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct NOTIFYICONDATAW {
  public uint cbSize; public IntPtr hWnd; public uint uID; public uint uFlags;
  public uint uCallbackMessage; public IntPtr hIcon;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string szTip;
  public uint dwState; public uint dwStateMask;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string szInfo;
  public uint uTimeoutOrVersion;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string szInfoTitle;
  public uint dwInfoFlags; public Guid guidItem; public IntPtr hBalloonIcon;
}
'@

$NIM_ADD = 0
$NIM_DELETE = 2
# 注意用 -2147483648 而不是 0x80000000：P/Invoke 的 int style 是有符号的，
# 传 0x80000000 会溢出成 0 → CreateWindowExW 返回 NULL（err=203 无效句柄）。
$WS_POPUP = [int]-2147483648

$proc = [Tray.Native+WndProc] { param($h, $m, $w, $l) return [IntPtr]::Zero }

$wc = New-Object Tray.Native+WNDCLASS
$wc.lpfnWndProc = $proc
$wc.hInstance = [Tray.Native]::GetModuleHandleW($null)
$wc.lpszClassName = 'TrayMinProbe'
[void][Tray.Native]::RegisterClassW([ref]$wc)

$hwnd = [Tray.Native]::CreateWindowExW(0, 'TrayMinProbe', 'TrayMinProbe', $WS_POPUP, 0, 0, 0, 0,
  [IntPtr]::Zero, [IntPtr]::Zero, $wc.hInstance, [IntPtr]::Zero)
Write-Host ("[probe] hidden window hwnd = {0}" -f $hwnd)
if ($hwnd -eq [IntPtr]::Zero) {
  Write-Host ("[probe] CreateWindowExW failed, err={0}" -f [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
}

$sb = New-Object System.Text.StringBuilder 128
$need = 0
[void][Tray.Native]::GetUserObjectInformationW([Tray.Native]::GetProcessWindowStation(), 2, $sb, 256, [ref]$need)
$ws = $sb.ToString()
$sb2 = New-Object System.Text.StringBuilder 128
[void][Tray.Native]::GetUserObjectInformationW([Tray.Native]::GetThreadDesktop([Tray.Native]::GetCurrentThreadId()), 2, $sb2, 256, [ref]$need)
$dt = $sb2.ToString()
Write-Host ("[probe] windowstation={0} desktop={1}" -f $ws, $dt)
$exp = @(Get-Process explorer -ErrorAction SilentlyContinue)
Write-Host ("[probe] explorer.exe in this session = {0}" -f $exp.Count)
Write-Host ("[probe] my SessionId = {0}" -f (Get-Process -Id $PID).SessionId)
if ($exp.Count -gt 0) { Write-Host ("[probe] explorer SessionId = {0}" -f ($exp | Select-Object -First 1).SessionId) }

# 1) minimal registration, no icon
$d = New-Object Tray.Native+NOTIFYICONDATAW
$d.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][Tray.Native+NOTIFYICONDATAW])
$d.hWnd = $hwnd
$d.uID = 1
$d.uFlags = 1 -bor 4          # NIF_MESSAGE | NIF_TIP
$d.uCallbackMessage = 0x8001
$d.szTip = 'minimal probe'
$ok1 = [Tray.Native]::Shell_NotifyIconW($NIM_ADD, [ref]$d)
$err1 = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
Write-Host ("[probe] NIM_ADD (no icon)      ok={0} err={1}" -f [int]$ok1, $err1)

# 2) registration WITH a known-good system icon
$d2 = New-Object Tray.Native+NOTIFYICONDATAW
$d2.cbSize = $d.cbSize
$d2.hWnd = $hwnd
$d2.uID = 2
$d2.uFlags = 1 -bor 4 -bor 2   # NIF_MESSAGE | NIF_TIP | NIF_ICON
$d2.uCallbackMessage = 0x8002
$d2.szTip = 'minimal probe with icon'
$d2.hIcon = [System.Drawing.SystemIcons]::Application.Handle
$ok2 = [Tray.Native]::Shell_NotifyIconW($NIM_ADD, [ref]$d2)
$err2 = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
Write-Host ("[probe] NIM_ADD (system icon)  ok={0} err={1} hicon={2}" -f [int]$ok2, $err2, $d2.hIcon)

if ($ok1) { [void][Tray.Native]::Shell_NotifyIconW($NIM_DELETE, [ref]$d) }
if ($ok2) { [void][Tray.Native]::Shell_NotifyIconW($NIM_DELETE, [ref]$d2) }

Write-Host ""
if ((-not $ok1) -and (-not $ok2)) {
  Write-Host "[probe] RESULT: even the minimal registration is denied here."
  Write-Host "[probe]         => the denial comes from the session / notification-area"
  Write-Host "[probe]            environment, NOT from the pet's code."
} else {
  Write-Host "[probe] RESULT: minimal registration succeeded in this session."
  Write-Host "[probe]         => the pet's own call path needs another look."
}
