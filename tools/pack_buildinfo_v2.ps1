param([string]$Root = (Split-Path -Parent $PSScriptRoot))
# 生成 v2\BUILD.txt：记录包内每个文件的字节数与 SHA256，方便核对版本。
#
# ⚠️ 必须在**所有拷贝动作之后**跑（先拷 exe/dll，再跑这个）。
#    v1 踩过：先生成清单、后覆盖 exe → 清单里的哈希是旧的，
#    等于这张"版本核对表"本身在骗人。所以结尾会**回读清单逐个核对**。
#
# 与 pack_buildinfo.ps1 的差别：基准目录换成 v2\，文件清单换成 v2 的形态
# （没有"包内启动器"这一项 —— v2 的启动逻辑在 exe 里）。
$ErrorActionPreference = 'Stop'
$out = Join-Path $Root 'v2\BUILD.txt'
$commit = (& git -C $Root rev-parse --short HEAD) 2>$null
$files = @(
  'v2\presage-pet.exe', 'v2\WebView2Loader.dll', 'v2\启动桌宠.bat', 'v2\诊断-导出报告.bat',
  'v2\tools\pet_bridge.mjs', 'v2\tools\usage.mjs',
  'v2\app\src\protocol.js', 'v2\app\src\lines.js', 'v2\app\src\usage-view.js',
  'v2\app\src\adapters\codex.js', 'v2\app\src\adapters\dsh.js',
  'v2\V2-BASELINE.md', 'v2\OPEN-ISSUES.md', 'v2\README-V2.txt'
)
$L = New-Object System.Collections.ArrayList
[void]$L.Add('普瑞塞斯桌宠 v2（exe 启动版）  -  BUILD.txt')
[void]$L.Add("生成时间 : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
$tagsAtHead = (& git -C $Root tag --points-at HEAD) 2>$null
if ($tagsAtHead) {
  [void]$L.Add("基线 tag : $($tagsAtHead -join ', ')")
  [void]$L.Add("git 提交 : $commit")
} else {
  [void]$L.Add("git 提交 : $commit（HEAD 上没有 tag）")
}
[void]$L.Add('')
[void]$L.Add('【启动方式】**双击 presage-pet.exe 即可**，不需要任何 .bat。')
[void]$L.Add('  exe 自己会做完这些事（v1.1 是由 启动桌宠.bat 做的）：')
[void]$L.Add('    * 定位自己所在目录，把日志/profile/桥接都放在 exe 旁边的 runtime\')
[void]$L.Add('    * 单实例检查（命名互斥体；第二次双击只弹一句提示）')
[void]$L.Add('    * 设 WebView2 profile（runtime\webview2）；上次启动失败过就先删掉重建')
[void]$L.Add('    * 查 WebView2Loader.dll 与 WebView2 Runtime，缺哪个直接弹框说清楚')
[void]$L.Add('    * 隐藏启动桥接（node tools\pet_bridge.mjs，无窗口 + 输出进 runtime\bridge.log）')
[void]$L.Add('    * 退出时自己收掉桥接进程')
[void]$L.Add('  包内的 启动桌宠.bat 只是"可选入口"（给必须走 bat 的场景），不含任何逻辑。')
[void]$L.Add('  包内必须包含 tools\ 与 app\src\ —— 桥接会 import 后者。')
[void]$L.Add('')
[void]$L.Add('文件                                      字节数         SHA256')
foreach ($f in $files) {
  $full = Join-Path $Root $f
  if (Test-Path $full) {
    [void]$L.Add(('{0,-40} {1,10}  {2}' -f $f, (Get-Item $full).Length, (Get-FileHash $full -Algorithm SHA256).Hash))
  } else {
    [void]$L.Add(('{0,-40} {1,10}  {2}' -f $f, '-', '(缺失)'))
  }
}
[void]$L.Add('')
[void]$L.Add('自检 : node tools\bridge_deps_probe.mjs v2    （包内桥接依赖是否齐全）')
[void]$L.Add('       v2\presage-pet.exe --diag               （导出诊断报告 runtime\diag.txt）')
[void]$L.Add('日志 : v2\runtime\pet.out.log  /  v2\runtime\bridge.log  /  %LOCALAPPDATA%\PresagePet\pet.log')
[void]$L.Add('热键 : Ctrl+Alt+S 设置   Ctrl+Alt+Q 退出（托盘不可用时的兜底）')
[void]$L.Add('已知 : 托盘图标在本机被系统拒绝注册（ACCESS_DENIED），与 v1.1 相同，')
[void]$L.Add('       属环境级限制；入口请用右键菜单或上面两个热键。')
[System.IO.File]::WriteAllLines($out, $L, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[build] $out ($((Get-Item $out).Length) bytes, $($files.Count) 个文件)"

# ---- 回读清单自查：任何一条哈希/字节数不符就直接失败，绝不留下假清单 ----
$bad = @()
foreach ($line in [System.IO.File]::ReadAllLines($out, (New-Object System.Text.UTF8Encoding($false)))) {
  if ($line -match '^(\S+)\s+(\d+)\s+([0-9A-F]{64})$') {
    $rel = $Matches[1]; $size = [int]$Matches[2]; $hash = $Matches[3]
    $full = Join-Path $Root $rel
    if (-not (Test-Path $full)) { $bad += "$rel 不见了" ; continue }
    if ((Get-Item $full).Length -ne $size -or (Get-FileHash $full -Algorithm SHA256).Hash -ne $hash) {
      $bad += "$rel 与清单不符（清单生成后有文件被覆盖？）"
    }
  }
}
if ($bad.Count) {
  Write-Host '[build] 自查失败：'
  $bad | ForEach-Object { Write-Host "   - $_" }
  Write-Host '[build] 提示：先 Copy-Item exe/dll，再跑这个脚本。'
  exit 1
}
Write-Host '[build] 自查通过：清单里每条哈希/字节数都与实物一致'
