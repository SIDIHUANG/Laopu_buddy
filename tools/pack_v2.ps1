<#
  装配 v2 交付包（v2\）：
    1) 从 v2\app\src-tauri\target\release\ 拷 exe 与 WebView2Loader.dll
    2) 拷桥接依赖的 js（v2\
       app\src\ 的那几个模块，桥接会 import）与 tools\pet_bridge.mjs / usage.mjs
    3) 包内 js 的相对 import 逐个校验 —— "拷走之后才发现缺文件"是 v1.1 踩过的坑
       （桥接 ERR_MODULE_NOT_FOUND → 桌宠表现为"永远 idle、零事件"）
    4) 生成 BUILD.txt（字节数 + SHA256），并**回读校验**

  与 v1 的 tools/pack_v1.ps1 的最大区别：
    * 不再生成"包内启动器" —— v2 里启动逻辑在 exe 内部，
      包里的 启动桌宠.bat 只是一份**手写的**可选入口（不参与任何逻辑），
      所以没有"两份 bat 逻辑漂移"的风险，也不需要文本替换自检。
    * 装配完直接跑**包内 exe 的 --diag**：这是 v2 才有的能力，
      等于"装完就能自证"（v1 只能靠人肉双击看现象）。

  用法：  powershell -NoProfile -ExecutionPolicy Bypass -File tools/pack_v2.ps1

  ⚠️ **本文件必须存成 UTF-8 with BOM**（开头 `EF BB BF`）。
     Windows PowerShell 5.1 读**不带 BOM** 的 .ps1 会按系统 ANSI（GBK）解码，
     中文注释与字符串立刻变乱码，脚本会报一堆"位置完全不相干"的语法错误；
     而且**任何写在脚本内部的自我修复代码都来不及执行** —— 解析阶段就死了
     （这一点我实测确认过：加在脚本里的补 BOM 逻辑根本没机会跑）。
     用户机器上只有 PowerShell 5.1，所以这是硬要求，不是洁癖。
     恢复办法（任选）：
       * 用 VS Code / Notepad++ 把编码改成 "UTF-8 with BOM" 再保存；
       * 或跑一次 tools/fix_ps1_bom.ps1（那个脚本是**纯 ASCII**，
         所以任何情况下都能被正确解析，它就是为这种时刻准备的）。
#>
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [switch]$SkipDiag
)
$ErrorActionPreference = 'Stop'

$rel = Join-Path $Root 'v2\app\src-tauri\target\release'
$pkg = Join-Path $Root 'v2'
$problems = @()

# 防呆：绝不允许把 v2 装进 v1 里面。
# 这个脚本会 `Copy-Item -Recurse` 整个 app\，如果目标落在 v1\ 下，
# 下次再装 v1 时 robocopy /E 会把 v2 的副本一起卷进去（几十 MB 的递归拷贝）。
$pkgFull = [System.IO.Path]::GetFullPath($pkg)
$v1Full = [System.IO.Path]::GetFullPath((Join-Path $Root 'v1'))
if ($pkgFull.StartsWith($v1Full, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "包装目录不能放在 v1\ 里面（v1 是冻结基线，且递归拷贝会互相污染）：$pkgFull"
}

if (-not (Test-Path (Join-Path $rel 'presage-pet.exe'))) {
  throw "找不到 $rel\presage-pet.exe —— 先构建：cd v2\app\src-tauri; cargo build --release"
}

# ---------------------------------------------------------------------------
# 1. exe + WebView2Loader.dll
#    DLL 必须随包：只拷 exe 会 0xC0000135 **静默秒退**（v1 的记录，仍然成立）。
# ---------------------------------------------------------------------------
foreach ($f in @('presage-pet.exe', 'WebView2Loader.dll')) {
  $from = Join-Path $rel $f
  if (-not (Test-Path $from)) {
    if ($f -eq 'presage-pet.exe') { throw "缺 $from" }
    # DLL 有时不在 release 目录（取决于 tauri 版本把 loader 放哪）
    $alt = Get-ChildItem -Path (Join-Path $Root 'v2\app\src-tauri\target') -Recurse -Filter 'WebView2Loader.dll' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $alt) { throw "找不到 WebView2Loader.dll（release 目录和 target 下都没有）" }
    $from = $alt.FullName
  }
  Copy-Item $from (Join-Path $pkg $f) -Force
  Write-Host ("[pack] {0,-22} {1,12} bytes" -f $f, (Get-Item (Join-Path $pkg $f)).Length)
}

# ---------------------------------------------------------------------------
# 2. 桥接：tools\ + 它 import 的那几个前端模块
# ---------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path (Join-Path $pkg 'tools') | Out-Null
foreach ($f in @('pet_bridge.mjs', 'usage.mjs')) {
  Copy-Item (Join-Path $Root "tools\$f") (Join-Path $pkg "tools\$f") -Force
  Write-Host ("[pack] tools\{0,-16} {1,12} bytes" -f $f, (Get-Item (Join-Path $pkg "tools\$f")).Length)
}
$needed = @('protocol.js', 'lines.js', 'usage-view.js',
            'adapters\codex.js', 'adapters\dsh.js')
foreach ($r in $needed) {
  $from = Join-Path $Root "v2\app\src\$r"
  $to = Join-Path $pkg "app\src\$r"
  if (-not (Test-Path $from)) { throw "pack_v2: 桥接依赖缺失 $from" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
  # 原地打包（pkg == v2\）时源和目标就是同一个文件 —— Copy-Item 会直接报
  # "Cannot overwrite the item … with itself"（实测踩到）。先比绝对路径再拷。
  if ([System.IO.Path]::GetFullPath($from) -ne [System.IO.Path]::GetFullPath($to)) {
    Copy-Item $from $to -Force
    Write-Host ("[pack] app\src\{0,-18} {1,12} bytes" -f $r, (Get-Item $to).Length)
  } else {
    Write-Host ("[pack] app\src\{0,-18} 原地（源即目标，跳过拷贝）" -f $r)
  }
}

# ---------------------------------------------------------------------------
# 3. 包内 js 的相对 import 必须全部能解析
#    （静态文本检查：不 spawn 子进程，受限环境里也能跑）
# ---------------------------------------------------------------------------
$utf8 = New-Object System.Text.UTF8Encoding($false)
Get-ChildItem (Join-Path $pkg 'app\src') -Recurse -Filter '*.js' -File | ForEach-Object {
  $txt = [System.IO.File]::ReadAllText($_.FullName, $utf8)
  foreach ($m in [regex]::Matches($txt, "from\s+'([^']+)'")) {
    $spec = $m.Groups[1].Value
    if ($spec.StartsWith('node:')) { continue }
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $_.DirectoryName $spec))
    if (-not (Test-Path $resolved)) { $problems += "包内 js 引用不到: $($_.Name) -> $spec" }
  }
}
# pet_bridge.mjs 自己也 import 这些
$bridgeTxt = [System.IO.File]::ReadAllText((Join-Path $pkg 'tools\pet_bridge.mjs'), $utf8)
foreach ($m in [regex]::Matches($bridgeTxt, "from\s+'([^']+)'")) {
  $spec = $m.Groups[1].Value
  if ($spec.StartsWith('node:')) { continue }
  $resolved = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $pkg 'tools') $spec))
  if (-not (Test-Path $resolved)) { $problems += "pet_bridge.mjs 引用不到: $spec" }
}

# ---------------------------------------------------------------------------
# 4. 文档：v2 只带自己的基线文档（v1 的那些留在 v1\ 里，避免两处说法打架）
#    ⚠️ 包内那份必须叫 OPEN-ISSUES.md，内容取自工程的 OPEN-ISSUES-V2.md ——
#       如果照原名拷 v1 的 OPEN-ISSUES.md，包里就会出现"v2 的包装着 v1 的问题清单"，
#       比没有文档更糟（v1.1 就因为"两份文档互相打架"绕过远路）。
# ---------------------------------------------------------------------------
$docMap = @(
  @{ Src = 'V2-BASELINE.md';   Dst = 'V2-BASELINE.md' },
  @{ Src = 'OPEN-ISSUES-V2.md'; Dst = 'OPEN-ISSUES.md' },
  @{ Src = 'README-V2.txt';     Dst = 'README-V2.txt' }
)
foreach ($d in $docMap) {
  $from = Join-Path $Root $d.Src
  if (-not (Test-Path $from)) { $problems += "缺少文档 $($d.Src)"; continue }
  Copy-Item $from (Join-Path $pkg $d.Dst) -Force
  Write-Host ("[pack] {0,-22} {1,12} bytes" -f $d.Dst, (Get-Item (Join-Path $pkg $d.Dst)).Length)
}

# ---------------------------------------------------------------------------
# 5. BUILD.txt（清单）
# ---------------------------------------------------------------------------
& (Join-Path $Root 'tools\pack_buildinfo_v2.ps1') -Root $Root

# ---------------------------------------------------------------------------
# 6. 装完就自证：跑包内 exe 的 --diag（v2 新增的能力）
#    --diag 只写报告、不开窗、不 spawn 桥接，所以在自动化里跑很安全。
# ---------------------------------------------------------------------------
if (-not $SkipDiag) {
  $exe = Join-Path $pkg 'presage-pet.exe'
  Write-Host '[pack] 自检：包内 exe --diag ...'
  # 用 .NET 的 Process.Start 而不是 Start-Process：
  # 实测 `Start-Process -PassThru` 在 DSH 会话里会**永久挂住**（等一个永不结束的
  # 进程句柄），整个打包就卡在那儿不动了。.NET 这条路能正常拿到退出状态。
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = '--diag'
  $psi.WorkingDirectory = $pkg
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  if (-not $proc.WaitForExit(20000)) {
    $problems += '--diag 20 秒内没有退出'
    try { $proc.Kill() } catch { }
  }
  Start-Sleep -Milliseconds 800
  $diag = Join-Path $pkg 'runtime\diag.txt'
  if (Test-Path $diag) {
    $head = [System.IO.File]::ReadAllLines($diag, $utf8) | Select-Object -First 12
    Write-Host ("[pack] --diag 报告已生成（{0} bytes）：" -f (Get-Item $diag).Length)
    $head | ForEach-Object { Write-Host "        $_" }
    # 关键判据：报告里必须同时说 DLL 在、WebView2 在
    $txt = [System.IO.File]::ReadAllText($diag, $utf8)
    if ($txt -notmatch 'WebView2Loader\.dll\s*: 在 exe 旁边') { $problems += '--diag 报告说 WebView2Loader.dll 不在 exe 旁边' }
    if ($txt -notmatch 'WebView2 运行时\s*: 已安装') { $problems += '--diag 报告说没检测到 WebView2 运行时' }
  } else {
    $problems += "--diag 没有产出 runtime\diag.txt（exe 可能没跑起来）"
  }
}

if ($problems.Count) {
  Write-Host '[pack] 自检失败：'
  $problems | ForEach-Object { Write-Host "   - $_" }
  exit 1
}
Write-Host '[pack] 自检通过：exe+DLL 就位、桥接依赖齐全（含 import 解析）、BUILD.txt 哈希一致、--diag 可跑'
exit 0
