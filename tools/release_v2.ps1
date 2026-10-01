<#
  装配 v2 的 **release 压缩包**（只含运行必需的文件）。

  为什么要有这个脚本，而不是"手工挑文件压缩"：
    * v2\ 是**整棵源码树**（自带 1424 MB 的 Rust 构建缓存、运行态 runtime\、
      以及 dist\ / test\ / native 源码这些"构建期才需要"的东西）。
      直接压缩 v2\ 会做出一个 1.5 GB 的包，而真正必需的是 ~56 MB。
    * v1 时期已经踩过一次"包内缺了桥接依赖 → 拷走就废（永远 idle）"，
      所以这里用**机器判定**而不是人眼核对：逐个校验包内 js 的相对 import 都能解析。

  与 tools/pack_v2.ps1 的分工（两者都保留，别混）：
    pack_v2.ps1     -> 装配**开发/自测包**（v2\ 原地 = 完整源码树 + 交付物），
                       用来在工程里跑测试、跑 --diag。
    release_v2.ps1  -> 装配**发布包**（只含运行必需），产出 dist\ 目录 + .zip。
    前者是"开发用的"，后者是"发出去用的"。

  用法：
      powershell -NoProfile -ExecutionPolicy Bypass -File tools/release_v2.ps1
      powershell ... -File tools/release_v2.ps1 -SkipZip        # 只要目录
      powershell ... -File tools/release_v2.ps1 -OutDir D:\out # 换输出位置
#>
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string]$OutDir = '',
  [switch]$SkipZip
)
$ErrorActionPreference = 'Stop'

# ⚠️ 本文件必须存成 UTF-8 with BOM（PowerShell 5.1 会把无 BOM 的 .ps1 当 GBK 读，
#    中文注释会让脚本在解析阶段就报一堆"位置完全不相干"的语法错误）。
#    丢了就跑一次 tools/fix_ps1_bom.ps1（那个脚本是纯 ASCII，永远能解析）。

$pkg = Join-Path $Root 'v2'
$exe = Join-Path $pkg 'presage-pet.exe'
if (-not (Test-Path $exe)) {
  throw "找不到 $exe —— 先跑 tools\pack_v2.ps1（它会从构建产物拷进来）"
}

# 版本号从 exe 里拿不到（--version 会弹模态框，脚本里不能用），
# 所以用时间戳做包名，并用 BUILD.txt 里的哈希做身份凭据。
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
if (-not $OutDir) { $OutDir = Join-Path $Root 'release' }
# 刻意的选择：**目录名固定、压缩包名带时间戳**。
#   release\v2\                          <- 固定，随时打开看/拷，不用去猜今天那个时间戳
#   release\presage-pet-v2-<时间戳>.zip   <- 带时间戳，多次装配不会互相覆盖
# 固定目录名让"每次装配先清空"变成一句无脑的 Remove-Item，不会误删别的产物。
$stage = Join-Path $OutDir 'v2'
$zip = Join-Path $OutDir "presage-pet-v2-$stamp.zip"

$problems = @()
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Write-Host '============================================================'
Write-Host " v2 release 装配   -> $stage"
Write-Host '============================================================'

# ---------------------------------------------------------------------------
# 1. 必要文件清单（**白名单**，不是"排除法"）
#
#    为什么用白名单：排除法一旦漏写一条，就会把 1424 MB 的构建缓存打进包里，
#    或者反过来漏掉某个桥接依赖（后者的后果更隐蔽：包能用，但永远 idle）。
#    白名单还起**文档**作用 —— 看这一张表就知道包由什么构成。
# ---------------------------------------------------------------------------
$files = @(
  # 可执行体（DLL 必须与 exe 同目录，缺了双击毫无反应 0xC0000135）
  'presage-pet.exe',
  'WebView2Loader.dll',
  # 可选入口（零逻辑，只是给必须走 bat 的场景）+ 一键诊断
  '启动桌宠.bat',
  '诊断-导出报告.bat',
  # 桥接本体（exe 自己拉起它）
  'tools\pet_bridge.mjs',
  'tools\usage.mjs',
  # 桥接 import 的前端模块 —— 少了任何一个，桥接 ERR_MODULE_NOT_FOUND 直接退，
  # 桌宠表现为"永远 idle、零事件"（v1 实测踩到过）
  'app\src\protocol.js',
  'app\src\lines.js',
  'app\src\usage-view.js',
  'app\src\adapters\codex.js',
  'app\src\adapters\dsh.js',
  # 文档
  'README-V2.txt',
  'V2-BASELINE.md',
  'OPEN-ISSUES.md',
  'BUILD.txt'
)

foreach ($rel in $files) {
  $from = Join-Path $pkg $rel
  if (-not (Test-Path $from)) { $problems += "缺文件: v2\$rel"; continue }
  $to = Join-Path $stage $rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
  Copy-Item $from $to -Force
}
if ($problems.Count) {
  Write-Host '[release] 装配失败：'
  $problems | ForEach-Object { Write-Host "   - $_" }
  exit 1
}

# ---------------------------------------------------------------------------
# 2. 包内 js 的相对 import 必须全部能解析（机器判定，不靠人眼）
#    pet_bridge.mjs 的 import 是 '../app/src/...'，所以在 tools\ 与 app\src\ 上各查一遍。
# ---------------------------------------------------------------------------
$utf8 = New-Object System.Text.UTF8Encoding($false)
$jsFiles = @(Get-ChildItem (Join-Path $stage 'app\src') -Recurse -Filter '*.js' -File)
$jsFiles += Get-Item (Join-Path $stage 'tools\pet_bridge.mjs')
$jsFiles += Get-Item (Join-Path $stage 'tools\usage.mjs')
$importCount = 0
foreach ($f in $jsFiles) {
  $txt = [System.IO.File]::ReadAllText($f.FullName, $utf8)
  foreach ($m in [regex]::Matches($txt, "from\s+'([^']+)'")) {
    $spec = $m.Groups[1].Value
    if ($spec.StartsWith('node:')) { continue }
    $importCount++
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $f.DirectoryName $spec))
    if (-not (Test-Path $resolved)) {
      $problems += "包内 $($f.Name) 引用不到 -> $spec"
    }
  }
}
Write-Host ("[release] import 解析检查：{0} 条引用，全部可解析 = {1}" -f $importCount, ($problems.Count -eq 0))

# ---------------------------------------------------------------------------
# 3. 必须**不**出现的东西（防止白名单写错、或 v2\ 里被塞了新东西）
# ---------------------------------------------------------------------------
foreach ($forbidden in @('target', 'runtime', 'dist', 'test', 'src-tauri', '.git')) {
  $p = Join-Path $stage $forbidden
  if (Test-Path $p) { $problems += "包里不该有 $forbidden（白名单漏了？）" }
}

# ---------------------------------------------------------------------------
# 4. 自证：跑包内 exe 的 --diag
#    --diag 不弹框、不开窗、不 spawn 桥接，所以自动化里跑很安全；
#    而 --version 是模态对话框，**千万别**在脚本里用它当探针（会永远等）。
# ---------------------------------------------------------------------------
$stageExe = Join-Path $stage 'presage-pet.exe'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $stageExe
$psi.Arguments = '--diag'
$psi.WorkingDirectory = $stage
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)
if (-not $proc.WaitForExit(25000)) {
  $problems += '--diag 25 秒内没退出'
  try { $proc.Kill() } catch { }
}
Start-Sleep -Milliseconds 800
$diag = Join-Path $stage 'runtime\diag.txt'
if (Test-Path $diag) {
  $dt = [System.IO.File]::ReadAllText($diag, $utf8)
  if ($dt -notmatch 'WebView2Loader\.dll\s*: 在 exe 旁边') { $problems += '包内 --diag 说 DLL 不在 exe 旁边' }
  if ($dt -notmatch 'WebView2 运行时\s*: 已安装') { $problems += '包内 --diag 说没检测到 WebView2 运行时' }
  if ($dt -notmatch "root\s*:\s*" + [regex]::Escape($stage)) { $problems += '包内 --diag 报的 root 不是这个 release 目录' }
} else {
  $problems += '包内 --diag 没产出 runtime\diag.txt'
}
# --diag 会建 runtime\（日志 + diag.txt）—— 那是运行态，不能进发布包
if (Test-Path (Join-Path $stage 'runtime')) {
  Remove-Item (Join-Path $stage 'runtime') -Recurse -Force
  Write-Host '[release] 已清掉自证过程产生的 runtime\（发布包不带运行态）'
}

# ---------------------------------------------------------------------------
# 5. 打包 + 结果
# ---------------------------------------------------------------------------
$totalBytes = (Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ''
Write-Host '--- 包内容 ---'
Get-ChildItem $stage -Recurse -File | Sort-Object FullName | ForEach-Object {
  Write-Host ('  {0,-40} {1,10} KB' -f $_.FullName.Replace("$stage\",''), [math]::Round($_.Length/1KB,1))
}
Write-Host ('  {0,-40} {1,10} MB' -f '（合计，未压缩）', [math]::Round($totalBytes/1MB,2))

if (-not $SkipZip) {
  if (Test-Path $zip) { Remove-Item $zip -Force }
  # Compress-Archive 是 PowerShell 5.1 就有的，不引第三方
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
  $zmb = [math]::Round((Get-Item $zip).Length/1MB,2)
  Write-Host ''
  Write-Host ('[release] 压缩包: {0}' -f $zip)
  Write-Host ('          压缩后: {0} MB（未压缩 {1} MB）' -f $zmb, [math]::Round($totalBytes/1MB,2))
  # 自检：压缩包里必须能列出全部预期文件
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $za = [System.IO.Compression.ZipFile]::OpenRead($zip)
  $names = @($za.Entries | ForEach-Object { $_.FullName -replace '/', '\' })
  $za.Dispose()
  foreach ($rel in $files) {
    if ($names -notcontains $rel) { $problems += "压缩包里缺 $rel" }
  }
  if ($names -match 'target\\|runtime\\|dist\\') { $problems += '压缩包里混进了 target/runtime/dist' }
  Write-Host ("[release] 压缩包清单自检：{0} 个条目" -f $names.Count)
}

Write-Host ''
if ($problems.Count) {
  Write-Host '[release] 失败：'
  $problems | ForEach-Object { Write-Host "   - $_" }
  exit 1
}

# ---------------------------------------------------------------------------
# 6. release\RELEASE.txt —— 给"发布这一步"用的一页清单
#
#    为什么不写进 V2-BASELINE.md：zip 每次装配都会变（时间戳 + 内容），
#    写进基线文档就变成"文档里躺着一个必然过期的哈希"，反而误导。
#    放在 release\ 里，它就是"这一批产物自己的身份证"，跟产物同生共死。
# ---------------------------------------------------------------------------
$exeHash = (Get-FileHash (Join-Path $stage 'presage-pet.exe') -Algorithm SHA256).Hash
$zipHash = if (Test-Path $zip) { (Get-FileHash $zip -Algorithm SHA256).Hash } else { '(未打包)' }
$rl = New-Object System.Collections.ArrayList
[void]$rl.Add('普瑞塞斯桌宠 v2 · RELEASE')
[void]$rl.Add("生成时间 : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
[void]$rl.Add('解压目录 : release\v2')
if (Test-Path $zip) { [void]$rl.Add("压缩包   : release\$(Split-Path $zip -Leaf)") }
[void]$rl.Add('')
[void]$rl.Add('用户怎么用：解压 -> 双击 presage-pet.exe（不需要 .bat，不需要安装）')
[void]$rl.Add('包内不能少：presage-pet.exe 与 WebView2Loader.dll 必须同目录；')
[void]$rl.Add('           tools\ 与 app\src\ 是桥接要 import 的，缺了会「永远 idle、零事件」')
[void]$rl.Add('包内不含  ：target\(构建缓存) dist\(已编进 exe) runtime\(exe 自己重建) 源码树其余部分')
[void]$rl.Add('')
[void]$rl.Add("presage-pet.exe SHA256 : $exeHash")
if (Test-Path $zip) { [void]$rl.Add("zip             SHA256 : $zipHash") }
[void]$rl.Add('')
[void]$rl.Add('版本核对：v2\BUILD.txt 里有全部 14 个文件的字节数与 SHA256')
[void]$rl.Add('自检命令：node tools\bridge_deps_probe.mjs <解压目录>   （桥接依赖是否齐全）')
[void]$rl.Add('          <解压目录>\presage-pet.exe --diag              （导出诊断报告）')
[void]$rl.Add('')
[void]$rl.Add('已知限制（与 v1.1 相同，本版未改）：')
[void]$rl.Add('  * 托盘图标可能被系统拒绝注册、或藏在 ^ 隐藏区 -> 用右键菜单或 Ctrl+Alt+S / Ctrl+Alt+Q')
[void]$rl.Add('  * 抠图残留 / 任务栏图标 / celebrate 用难过脸 -> 见 OPEN-ISSUES.md')
[System.IO.File]::WriteAllLines((Join-Path $OutDir 'RELEASE.txt'), $rl, $utf8)

Write-Host ''
Write-Host '============================================================'
Write-Host '[release] 通过：'
Write-Host ('  目录  : {0}' -f $stage)
if (Test-Path $zip) { Write-Host ('  压缩包: {0}' -f $zip) }
Write-Host ('  清单  : {0}\RELEASE.txt' -f $OutDir)
Write-Host ('  exe   : SHA256 {0}' -f $exeHash)
Write-Host '  自检项：白名单文件齐全 / 包内 import 全部可解析 / 无 target·runtime·dist /'
Write-Host '          包内 exe --diag 能跑且报告正确 / 压缩包清单与白名单一致'
Write-Host '============================================================'
exit 0
