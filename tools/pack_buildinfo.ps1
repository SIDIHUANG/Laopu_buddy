param([string]$Root = (Split-Path -Parent $PSScriptRoot))
# 生成 v1\BUILD.txt：记录包内每个文件的字节数与 SHA256，方便核对版本。
# 单独成脚本是因为在 pwsh 里内联写容易踩引号/中文的坑（实测踩过）。
#
# ⚠️ 必须在**所有拷贝动作之后**跑（先 Copy-Item exe/dll，再跑这个）。
#    实测踩过：先生成 BUILD.txt、后覆盖 exe → 清单里的哈希是旧的，
#    等于这张"版本核对表"本身在骗人（自检时才发现 13 个里 1 个不符）。
#    所以下面加了两道：脚本开头提示顺序，结尾**回读清单并逐个核对**哈希。
$ErrorActionPreference = 'Stop'
$out = Join-Path $Root 'v1\BUILD.txt'
$commit = (& git -C $Root rev-parse --short HEAD) 2>$null
$files = @(
  'v1\presage-pet.exe', 'v1\WebView2Loader.dll', 'v1\启动桌宠.bat', '启动桌宠.bat',
  'v1\tools\pet_bridge.mjs', 'v1\tools\usage.mjs',
  'v1\app\src\protocol.js', 'v1\app\src\lines.js', 'v1\app\src\usage-view.js',
  'v1\app\src\adapters\codex.js', 'v1\app\src\adapters\dsh.js',
  'v1\OPEN-ISSUES.md', 'v1\V1-BASELINE.md'
)
$L = New-Object System.Collections.ArrayList
[void]$L.Add('普瑞塞斯桌宠 v1.1  -  BUILD.txt')
[void]$L.Add("生成时间 : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
# 把 HEAD 上的 tag 也写进来：核对版本时"tag 名"比"短 sha"好认得多
$tagsAtHead = (& git -C $Root tag --points-at HEAD) 2>$null
if ($tagsAtHead) {
  [void]$L.Add("基线 tag : $($tagsAtHead -join ', ')")
  [void]$L.Add("git 提交 : $commit")
} else {
  [void]$L.Add("git 提交 : $commit（HEAD 上没有 tag）")
}
[void]$L.Add('')
[void]$L.Add('【自包含】双击 v1\启动桌宠.bat 即可，不需要工程根目录。')
[void]$L.Add('  包内必须包含 tools\ 与 app\src\ —— 桥接会 import 后者。')
[void]$L.Add('  这两块由 tools\pack_v1.ps1 从工程同步；缺了桥接会 ERR_MODULE_NOT_FOUND，')
[void]$L.Add('  桌宠表现为「永远 idle、零事件」（v1.1 实测踩到）。')
[void]$L.Add('  根目录 启动桌宠.bat 是同一份逻辑的工程版，两个入口等价。')
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
[void]$L.Add('自检 : node tools\bridge_deps_probe.mjs v1    （包内桥接依赖是否齐全）')
[void]$L.Add('日志 : v1\runtime\pet.out.log  /  v1\runtime\bridge.log  /  %LOCALAPPDATA%\PresagePet\pet.log')
[void]$L.Add('热键 : Ctrl+Alt+S 设置   Ctrl+Alt+Q 退出（托盘不可用时的兜底）')
[void]$L.Add('已知 : 托盘图标在本机被系统拒绝注册（ACCESS_DENIED），已降级为已知限制，')
[void]$L.Add('       只提示一次。入口请用右键菜单或上面两个热键，详见 OPEN-ISSUES.md 1.1。')
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
