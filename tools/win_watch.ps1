param(
  [string]$Launcher = "bat",
  [string]$OutDir = "",
  [int[]]$SampleSeconds = @(3, 6, 10, 14, 20, 30, 45, 60),
  [int]$ClickAtSecond = 0,
  [int]$TriggerBridgeAtSecond = 0
)
# Reproduce the *user's* launch path and watch the pet window over time.
# "bat" mode runs the real launcher through cmd.exe /c exactly like a double click.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root ("runtime\probe-" + $Launcher) }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Add-Type -Namespace W2 -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr hwnd, int idx);
[DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr hwnd, IntPtr hrgn);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int val, int size);
public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lp);
public struct RECT { public int Left, Top, Right, Bottom; }
public struct POINT { public int X, Y; }
'@

function Enum-Windows {
  $list = New-Object System.Collections.ArrayList
  $cb = [W2.Native+EnumWindowsProc]{
    param($hwnd, $lp)
    $p2 = 0
    [void][W2.Native]::GetWindowThreadProcessId($hwnd, [ref]$p2)
    $sb = New-Object System.Text.StringBuilder 512
    [void][W2.Native]::GetWindowTextW($hwnd, $sb, 512)
    $cn = New-Object System.Text.StringBuilder 512
    [void][W2.Native]::GetClassNameW($hwnd, $cn, 512)
    $r = New-Object W2.Native+RECT
    [void][W2.Native]::GetWindowRect($hwnd, [ref]$r)
    [void]$list.Add([pscustomobject]@{
      Hwnd = $hwnd; Pid = $p2; Title = $sb.ToString(); Class = $cn.ToString()
      Visible = [W2.Native]::IsWindowVisible($hwnd)
      ExStyle = [W2.Native]::GetWindowLongW($hwnd, -20)
      Style = [W2.Native]::GetWindowLongW($hwnd, -16)
      L = $r.Left; T = $r.Top; R = $r.Right; B = $r.Bottom
    })
    return $true
  }
  [void][W2.Native]::EnumWindows($cb, [IntPtr]::Zero)
  return $list
}

function Analyze([IntPtr]$hwnd, [string]$path) {
  $r = New-Object W2.Native+RECT
  if (-not [W2.Native]::GetWindowRect($hwnd, [ref]$r)) { return $null }
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { return $null }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][W2.Native]::PrintWindow($hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc); $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

  # find the vertical distribution of the *character* colours (dark purple hair)
  # and of the bubble (light grey). We report per-band non-transparent ratio.
  $bands = 10
  $bandRatio = @()
  for ($b = 0; $b -lt $bands; $b++) { $bandRatio += 0 }
  $opaque = 0; $total = 0
  $darkPx = 0
  for ($y = 0; $y -lt $h; $y += 3) {
    $bi = [int][math]::Floor($y * $bands / $h)
    for ($x = 0; $x -lt $w; $x += 3) {
      $p = $bmp.GetPixel($x, $y)
      $total++
      if ($p.A -gt 16) {
        $opaque++
        $bandRatio[$bi]++
        # very dark sprite pixels (hair)
        if ($p.R -lt 90 -and $p.G -lt 90 -and $p.B -lt 110) { $darkPx++ }
      }
    }
  }
  $bmp.Dispose()
  $bandPct = @()
  foreach ($v in $bandRatio) { $bandPct += [math]::Round(100.0 * $v / [math]::Max(1, ($w/3) * ($h/3/$bands)), 1) }
  return [pscustomobject]@{
    File = (Split-Path -Leaf $path); W = $w; H = $h
    OpaquePct = [math]::Round(100.0 * $opaque / [math]::Max(1,$total), 2)
    DarkPx = $darkPx
    Bands = ($bandPct -join ',')
  }
}

[void][W2.Native]::SetProcessDPIAware()

Get-Process presage-pet -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 700

$logDir = Join-Path $root 'v1\runtime'
Remove-Item (Join-Path $logDir 'pet.out.log'), (Join-Path $logDir 'pet.err.log') -ErrorAction SilentlyContinue
$webviewProfile = Join-Path $logDir 'webview2'
$freshProfile = Join-Path $root 'runtime\wv2-fresh'

if ($Launcher -eq 'bat') {
  # exactly what a double click does: cmd /c "<path>\<bat>"
  # The launcher file name is Chinese; build it from code points so this script
  # stays pure ASCII and survives being read as ANSI by Windows PowerShell 5.1.
  $batName = [string]([char]0x542F + [char]0x52A8 + [char]0x684C + [char]0x5BA0) + '.bat'
  $bat = Join-Path $root ('v1\' + $batName)
  Write-Host "[probe] cmd /c `"$bat`"  (hidden console, like double click but detached)"
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$bat`"" -WorkingDirectory (Split-Path $bat) -WindowStyle Minimized | Out-Null
} elseif ($Launcher -eq 'exe-nodir') {
  Write-Host "[probe] double-click equivalent: explorer-start exe (cwd = exe dir, no env var)"
  $exe = Join-Path $root 'v1\presage-pet.exe'
  Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) | Out-Null
} elseif ($Launcher -eq 'exe-freshprofile') {
  $exe = Join-Path $root 'v1\presage-pet.exe'
  Remove-Item -Recurse -Force $freshProfile -ErrorAction SilentlyContinue
  $env:WEBVIEW2_USER_DATA_FOLDER = $freshProfile
  Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) | Out-Null
}

$startTicks = (Get-Date).Ticks
$summary = New-Object System.Collections.ArrayList
foreach ($secRaw in $SampleSeconds) {
  $sec = [int]$secRaw
  $targetTicks = [int64]($startTicks + ([int64]$sec * [int64]10000000))
  while ($true) {
    $remainMs = [double](($targetTicks - (Get-Date).Ticks) / 10000.0)
    if ($remainMs -le 0) { break }
    Start-Sleep -Milliseconds ([int][math]::Min(400.0, [math]::Max(1.0, $remainMs)))
  }
  $proc = Get-Process presage-pet -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $proc) { Write-Host "[probe] t=${sec}s PROCESS GONE"; break }
  $wins = Enum-Windows | Where-Object { $_.Pid -eq $proc.Id -and $_.Class -eq 'Tauri Window' }
  $main = $wins | Select-Object -First 1
  if (-not $main) { Write-Host "[probe] t=${sec}s no pet window"; continue }
  $png = Join-Path $OutDir ("t{0:D2}.png" -f $sec)
  $stat = Analyze $main.Hwnd $png
  $rgn = ''
  Write-Host ("[probe] t={0,3}s pid={1} mem={2}MB vis={3} icon={4} rect=({5},{6})-({7},{8}) ex=0x{9:X} | opaque={10}% dark={11}" -f `
    $sec, $proc.Id, [math]::Round($proc.WorkingSet64/1MB,1), $main.Visible, [W2.Native]::IsIconic($main.Hwnd), `
    $main.L, $main.T, $main.R, $main.B, $main.ExStyle, $stat.OpaquePct, $stat.DarkPx)
  Write-Host ("            bands(top to bottom) = {0}" -f $stat.Bands)
  [void]$summary.Add($stat)

  # what is under the character's centre? (is something covering it?)
  $cx = [int](($main.L + $main.R) / 2)
  $cy = [int]($main.T + ($main.B - $main.T) * 0.85)
  $pt = New-Object W2.Native+POINT
  $pt.X = $cx; $pt.Y = $cy
  $under = [W2.Native]::WindowFromPoint($pt)
  $uinfo = Enum-Windows | Where-Object { $_.Hwnd -eq $under } | Select-Object -First 1
  if ($uinfo) { Write-Host "            WindowFromPoint($cx,$cy) -> pid=$($uinfo.Pid) class='$($uinfo.Class)' title='$($uinfo.Title)'" }
  else { Write-Host "            WindowFromPoint($cx,$cy) -> hwnd=$under" }
}

Write-Host ""
Write-Host "==== pet.out.log (last 25) ===="
$ol = Join-Path $logDir 'pet.out.log'
if (Test-Path $ol) { Get-Content $ol -Encoding UTF8 -Tail 25 } else { Write-Host '(no stdout log)' }
Write-Host ""
Write-Host "==== pet.err.log ===="
$el = Join-Path $logDir 'pet.err.log'
if (Test-Path $el) { $c = Get-Content $el -Encoding UTF8; if ($c) { $c | Select-Object -Last 25 } else { Write-Host '(empty)' } } else { Write-Host '(none)' }

Write-Host ""
Write-Host "[probe] screenshots in $OutDir  (leaving the pet running: $((Get-Process presage-pet -ErrorAction SilentlyContinue) -ne $null))"
