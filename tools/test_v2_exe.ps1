<#
  v2 验收：把「双击 exe 就能用」拆成一条条可判定的检查，全部自动跑一遍。

  为什么要有这个脚本（而不是"我手动点两下看看"）：
    v1 的教训是**测试通过不等于测试有效**，而且"涉及'看得见'的功能必须抓图
    或肉眼看"。所以这里的做法是：
      * 能用机器判定的（进程、窗口、日志、/health、收尾、自愈）→ 断言
      * 只能靠肉眼/真机的（她到底画出来没有、托盘）→ 明确列成"未覆盖"，
        绝不写成"已通过"

  ⚠️ 三个环境坑（都实测踩到，写在这里免得下次重犯）：
    1) 本会话里 `Start-Process -PassThru` 会**永久挂住**（pwsh 在 DSH 里等一个
       永不结束的进程句柄）。所以统一用 .NET 的
       `[System.Diagnostics.Process]::Start`。这不影响结论 —— 被测的仍是
       "从零启动 exe" 这条路径。
    2) 别拿模态对话框当测试入口（`--version` 会弹框并**一直等**，脚本会卡住）。
    3) **不要连着跑好几遍**，也不要在跑的过程中 `Stop-Process` 打断它再接着跑。
       本会话我这么干过，后果是：上一轮留下的 TIME_WAIT 8792 + 没清干净的 node
       让 `Get-BridgeProcs` 抓到**别的实例**，于是断言报出"PID 对不上"的假红，
       而我一度以为是产品有竞态，白追了一个多小时。
       → 见 docs\验证纪律-别追不存在的bug.md。要重跑就先跑本脚本的 :cleanup
         （下面「清场」那一段的逻辑），或者干脆换一个"全新解压的副本"再跑。

  用法：
      powershell -NoProfile -ExecutionPolicy Bypass -File tools/test_v2_exe.ps1
      powershell ... -File tools/test_v2_exe.ps1 -PkgDir <包目录>   # 默认 v2\
#>
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string]$PkgDir = '',
  [switch]$KeepRunning
)
$ErrorActionPreference = 'Stop'

if (-not $PkgDir) { $PkgDir = Join-Path $Root 'v2' }
$exe = Join-Path $PkgDir 'presage-pet.exe'
if (-not (Test-Path $exe)) { throw "找不到 $exe —— 先构建并跑 tools\pack_v2.ps1" }
$runtime = Join-Path $PkgDir 'runtime'
$petLog = Join-Path $runtime 'pet.out.log'
$petErr = Join-Path $runtime 'pet.err.log'
$diag = Join-Path $runtime 'diag.txt'

$script:results = New-Object System.Collections.ArrayList
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  [void]$script:results.Add([pscustomobject]@{ Name = $name; Ok = $ok; Detail = $detail; Info = $false })
  Write-Host ("[{0}] {1}{2}" -f $mark, $name, $(if ($detail) { "  -- $detail" } else { '' }))
}
function Check-Info([string]$name, [string]$detail) {
  [void]$script:results.Add([pscustomobject]@{ Name = $name; Ok = $true; Detail = $detail; Info = $true })
  Write-Host ("[INFO] {0}  -- {1}" -f $name, $detail)
}

# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
Add-Type -Namespace V2T -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@

function StartApp {
  param([string]$Exe, [string]$WorkDir, [string[]]$ArgList = @())
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.WorkingDirectory = $WorkDir
  if ($ArgList.Count -gt 0) { $psi.Arguments = ($ArgList -join ' ') }
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  return [System.Diagnostics.Process]::Start($psi)
}

function Get-PetProcs { @(Get-Process -Name 'presage-pet' -ErrorAction SilentlyContinue) }
function Get-PetPid { $p = Get-PetProcs; if ($p.Count -gt 0) { return $p[0].Id } return 0 }

# 桥接进程的判定：**不能用 WMI 的 CommandLine**。
#
# 实测（本机、本会话）：`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`
# 能列出别的 node.exe，却**看不到**由桌宠 spawn 出来的那个（CommandLine 取不到）。
# 所以改用两条可靠依据：
#   1) 父进程 PID == 桌宠 PID（Win32_Process.ParentProcessId，这个属性可读）
#   2) 兜底：正在监听 8792 的进程 PID
# 注意：仍然**不按进程名**杀 node —— 用户机器上还有别的 node（v1 的核心安全线）。
function Find-BridgePids {
  $petPid = Get-PetPid
  $pids = @()
  if ($petPid -gt 0) {
    $pids = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
              Where-Object { $_.ParentProcessId -eq $petPid } | Select-Object -ExpandProperty ProcessId)
  }
  if ($pids.Count -eq 0) {
    $pids = @(Get-NetTCPConnection -LocalPort 8792 -State Listen -ErrorAction SilentlyContinue |
              Select-Object -ExpandProperty OwningProcess -Unique)
  }
  return @($pids | Where-Object { $_ })
}
function Get-BridgeProcs {
  @(Find-BridgePids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Where-Object { $_ })
}

function Stop-PetGracefully {
  # 优先用真正的"用户退出"路径：全局热键 Ctrl+Alt+Q
  # （它走 app.exit(0) → RunEvent::Exit → bridge::shutdown()，正是要验的那条）。
  $procs = Get-PetProcs
  if ($procs.Count -eq 0) { return }
  [V2T.Native]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)   # Ctrl down
  [V2T.Native]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)   # Alt down
  [V2T.Native]::keybd_event(0x51, 0, 0, [UIntPtr]::Zero)   # Q down
  Start-Sleep -Milliseconds 80
  [V2T.Native]::keybd_event(0x51, 0, 2, [UIntPtr]::Zero)
  [V2T.Native]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [V2T.Native]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
  for ($i = 0; $i -lt 40; $i++) {
    if ((Get-PetProcs).Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  }
  # 热键没生效（比如被别的程序抢了）→ 退回 WM_CLOSE，再不行才强杀
  foreach ($p in Get-PetProcs) {
    if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $p.CloseMainWindow() | Out-Null }
  }
  for ($i = 0; $i -lt 20; $i++) {
    if ((Get-PetProcs).Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  }
  Get-PetProcs | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Wait-For([scriptblock]$cond, [int]$seconds, [int]$stepMs = 250) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $cond) { return $true }
    Start-Sleep -Milliseconds $stepMs
  }
  return [bool](& $cond)
}
# ⚠️ 读日志必须用**共享读**：exe 用追加模式一直开着 pet.out.log，
# 直接 [IO.File]::ReadAllText 会抛"文件正由另一进程使用"（实测踩到 ——
# 会让一批检查项莫名其妙全红，而原因跟被测功能毫无关系）。
function Read-Shared([string]$path) {
  if (-not (Test-Path $path)) { return '' }
  try {
    $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
    $t = $sr.ReadToEnd()
    $sr.Close(); $fs.Close()
    return $t
  } catch { return '' }
}
function Get-LogTail([string]$path, [int]$n = 80) {
  $t = Read-Shared $path
  if (-not $t) { return @() }
  $all = $t -split "`r?`n"
  return @($all | Where-Object { $_ -ne '' } | Select-Object -Last $n)
}
function LogHas([string]$pattern, [int]$n = 0) {
  # 默认**读整篇日志**，而不是"最后 n 行"。
  #
  # 为什么改（实测踩到，值得记）：原来默认只看最后 400 行，于是出现过一次
  # 自相矛盾的现场 —— 断言说"整篇日志没有 [bridge] 就绪"，可同一时刻换一种方式
  # 读同一个文件，那行明明在里面（她一直在打 [cursor-out]/[hitmask]，后面的行
  # 会把前面挤出窗口）。这种"窗口太小"造成的红比不测更糟：它会让人去改本来没坏的代码。
  # 3 次隔离复现都证明那一行是一次就写成、立刻可读的（就绪/已启动各 1 条）。
  # 现在 $n>0 才是"只看最后 n 行"，默认 0 = 全文。
  $j = if ($n -gt 0) { Get-LogTail $petLog $n } else { (Read-Shared $petLog) -split "`r?`n" }
  return (($j | Where-Object { $_ -ne '' }) -join "`n") -match $pattern
}
function Health() {
  try {
    $r = Invoke-WebRequest 'http://127.0.0.1:8792/health' -UseBasicParsing -TimeoutSec 3
    return ($r.Content | ConvertFrom-Json)
  } catch { return $null }
}
function Reset-Logs { Remove-Item $petLog, $petErr -Force -ErrorAction SilentlyContinue }
function Kill-StaleBridges {
  # 结果导向的清理：谁在听 8792 就收谁 —— 判据是端口，不是进程名。
  $pids = @(Get-NetTCPConnection -LocalPort 8792 -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($id in $pids) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  }
}

# ---------------------------------------------------------------------------
Write-Host '============================================================'
Write-Host " v2 exe 启动验收   pkg=$PkgDir"
Write-Host '============================================================'

# 清场（必须干净：复用别人的桥接会让"exe 自己起桥接"这条验不出来 —— 实测踩到）
Get-PetProcs | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Kill-StaleBridges
Start-Sleep -Seconds 2
Check '清场：没有残留的桌宠/桥接' ((Get-PetProcs).Count -eq 0 -and (Get-BridgeProcs).Count -eq 0)

# ---------------------------------------------------------------------------
Write-Host "`n--- 1. --diag：装完就能自证（不用开窗口） ---"
Remove-Item $diag -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $runtime '.boot-failed') -Force -ErrorAction SilentlyContinue
$d = StartApp -Exe $exe -WorkDir $PkgDir -ArgList @('--diag')
$null = $d.WaitForExit(25000)
Check '--diag 自己退出了（没有卡住）' $d.HasExited
Start-Sleep -Milliseconds 600
Check '--diag 产出 runtime\diag.txt' (Test-Path $diag)
if (Test-Path $diag) {
  $dt = [System.IO.File]::ReadAllText($diag, [System.Text.Encoding]::UTF8)
  Check '--diag 说 WebView2Loader.dll 在 exe 旁边' ($dt -match 'WebView2Loader\.dll\s*: 在 exe 旁边')
  Check '--diag 说 WebView2 运行时已安装' ($dt -match 'WebView2 运行时\s*: 已安装')
  Check '--diag 报告的 exe 路径就是被点的那一个' ($dt -match [regex]::Escape($exe))
  Check '--diag 说提权=否（提权会打掉托盘与 GPU 合成）' ($dt -match '提权\s*: 提权=否')
  Check '--diag 不启动桌宠窗口' ((Get-PetProcs).Count -eq 0 -and $d.HasExited) "残留进程=$((Get-PetProcs).Count)"
} else {
  Check '--diag 内容检查' $false '报告不存在'
}
Start-Sleep -Seconds 1

# ---------------------------------------------------------------------------
Write-Host "`n--- 2. 双击 exe（无参数、不设任何环境变量） ---"
Remove-Item Env:\WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
Remove-Item Env:\PRESAGE_NODE -ErrorAction SilentlyContinue
Reset-Logs
$t0 = Get-Date
$p1 = StartApp -Exe $exe -WorkDir $PkgDir
$alive = Wait-For { (Get-PetProcs).Count -ge 1 } 30
Check '双击后进程起来了' $alive ("{0:N1}s" -f ((Get-Date) - $t0).TotalSeconds)
Check '日志落在 exe 旁边的 runtime\pet.out.log（不依赖工作目录）' (Wait-For { Test-Path $petLog } 25)
Wait-For { (Get-LogTail $petLog 50).Count -gt 3 } 25 | Out-Null

Check '日志里的 WebView2 profile = exe 旁边的默认目录' (LogHas 'WebView2 profile=.*runtime\\webview2' 200) `
  ((Get-LogTail $petLog 200 | Where-Object { $_ -like '*WebView2 profile=*' } | Select-Object -First 1))
Check '日志有 [boot] 行（版本 + exe 路径）' (LogHas '\[boot\] 普瑞塞斯桌宠 v')

$script:hwnd = 0
$winOk = Wait-For {
  $h = (Get-PetProcs | ForEach-Object { $_.MainWindowHandle } | Where-Object { $_ -ne [IntPtr]::Zero } | Select-Object -First 1)
  if ($h) { $script:hwnd = $h; return $true }
  return $false
} 30
Check '主窗口已创建（有 HWND，且有标题）' $winOk ("hwnd=$($script:hwnd) title=" + ((Get-PetProcs | Select-Object -First 1).MainWindowTitle))

$errLen = if (Test-Path $petErr) { (Get-Item $petErr).Length } else { -1 }
# 注意 -1 = "只有一个实例在跑、没有第二个进程去抢这个文件"。
# 正常启动时 exe 自己创建 pet.err.log（空）；如果它压根没被创建，也算正常。
Check 'pet.err.log 不存在或为空（无 panic）' ($errLen -le 0) "size=$errLen（-1 = 没创建，也算通过）"

Check '前端 boot ok（页面真的跑起来了）' (Wait-For { LogHas 'boot ok' 500 } 30)
$geom = Get-LogTail $petLog 500 | Where-Object { $_ -match '\[geom:boot\]' } | Select-Object -Last 1
Check '几何自检 裁掉=0 / 出屏=0' ($geom -match '裁掉=0px' -and $geom -match '出屏=0px') $geom

# ---------------------------------------------------------------------------
Write-Host "`n--- 3. 桥接：完全由 exe 自己拉起（无窗口 + 输出进文件） ---"
$hOk = Wait-For { $null -ne (Health) } 25
Check '桥接 /health 通' $hOk
$hj = Health
if ($hj) { Check-Info 'bridge /health' ("ok={0} dsh.sessions={1} produced={2}" -f $hj.ok, $hj.dsh.sessions, $hj.produced) }

# 断言的两条纪律（都来自实战踩坑，见 docs\验证纪律-别追不存在的bug.md）：
#   ① 读**整篇**日志，不用"最后 n 行"窗口 —— 窗口太小会把目标行挤出去，
#      结果断言说"没有"，而同一时刻换种读法那行就在里面（本会话真的这样骗过我）。
#   ② 失败信息必须带上**原始证据**（把所有 [bridge] 行打出来），
#      这样一眼能分清"产品没写"还是"我没读到"。
$allLines = @((Read-Shared $petLog) -split "`r?`n" | Where-Object { $_ -ne '' })
$bridgeStarted = @($allLines | Where-Object { $_ -match '\[bridge\] 已启动 PID \d+（无窗口）' })
$bridgeReady = @($allLines | Where-Object { $_ -match '\[bridge\] 就绪' })
Write-Host ("  [诊断] 日志共 {0} 行；'已启动' {1} 条；'就绪' {2} 条" -f $allLines.Count, $bridgeStarted.Count, $bridgeReady.Count)
Check '日志有「[bridge] 已启动 PID …（无窗口）」' ($bridgeStarted.Count -ge 1) `
  $(if ($bridgeStarted.Count) { $bridgeStarted[-1] } else { '整篇日志没有这行；[bridge] 行 = ' + (@($allLines | Where-Object { $_ -match '\[bridge\]' }) -join ' || ') })
Check '日志有「[bridge] 就绪」' ($bridgeReady.Count -ge 1) `
  $(if ($bridgeReady.Count) { $bridgeReady[-1] } else { '整篇日志没有这行；[bridge] 行 = ' + (@($allLines | Where-Object { $_ -match '\[bridge\]' }) -join ' || ') })

Check '桥接进程存在，且只有一个' ((Get-BridgeProcs).Count -eq 1) "数量=$((Get-BridgeProcs).Count)"

# ★ 关键改动：桥接 PID **一律从产品自己的日志里取**，不再从进程表里猜。
#
# 为什么必须这样（本次的假红根因）：我原来用"父进程 == 桌宠 PID"去进程表里找桥接，
# 一旦环境里有上一轮残留的 node、或者 TIME_WAIT 让端口归属变味，就会抓到**别的实例**。
# 现场证据是 PID 直接对不上：
#     测试报 "退出前 bridge pid=21660"，而产品日志里写的是 "已启动 PID 21256"
# —— 那时我却去怀疑产品有竞态，白追一个多小时。
# 判据换成"产品写下来的 PID"之后，测试与产品引用的一定是**同一个进程**，
# 这种张冠李戴从结构上就不可能再发生。
$bridgePid = 0
if ($bridgeStarted.Count) {
  [void][int]::TryParse(($bridgeStarted[-1] -replace '.*已启动 PID (\d+).*', '$1'), [ref]$bridgePid)
}
Check '能从日志里解析出桥接 PID（后续断言都以它为准）' ($bridgePid -gt 0) "pid=$bridgePid"
if ($bridgePid -gt 0) {
  Check-Info 'bridge PID（取自产品日志）' $bridgePid
  $bproc = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue
  Check '这个 PID 确实是一个活着的 node 进程' (($null -ne $bproc) -and ($bproc.ProcessName -eq 'node')) `
    "进程=$($bproc.ProcessName)"
  $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$bridgePid" -ErrorAction SilentlyContinue).CommandLine
  if ($cl) {
    Check '桥接命令行指向**包内**的 pet_bridge.mjs' ($cl -match [regex]::Escape($PkgDir)) $cl
  } else {
    Check-Info '桥接命令行' '（本会话 WMI 读不到该进程的 CommandLine —— 见 Find-BridgePids 的注释）'
  }
  if ($bproc) {
    Check '桥接没有可见控制台窗口（MainWindowHandle=0）' ($bproc.MainWindowHandle -eq [IntPtr]::Zero)
  }
  $ppid_ = (Get-CimInstance Win32_Process -Filter "ProcessId=$bridgePid" -ErrorAction SilentlyContinue).ParentProcessId
  if ($ppid_) {
    Check '桥接的父进程就是桌宠（证明是 exe 自己拉起的，不是别处遗留的）' ($ppid_ -eq (Get-PetPid)) "父=$ppid_ 桌宠=$(Get-PetPid)"
  }
}
Check 'bridge.log 已生成且非空' ((Test-Path (Join-Path $runtime 'bridge.log')) -and ((Get-Item (Join-Path $runtime 'bridge.log')).Length -gt 0))
$be = Join-Path $runtime 'bridge.err.log'
$beLen = if (Test-Path $be) { (Get-Item $be).Length } else { -1 }
Check 'bridge.err.log 不存在或为空' ($beLen -le 0) "size=$beLen"

# ---------------------------------------------------------------------------
Write-Host "`n--- 4. 第二次双击 → 不会起第二个实例 ---"
$petPidBefore = Get-PetPid
$bridgeCountBefore = (Get-BridgeProcs).Count
# 第二实例到底"做了什么"，用**数日志行**来判定，不要用"它还活着吗"。
#
# 为什么（这条实测踩到过，值得记住）：
#   第一次写这个检查时我用的是「进程数==2 且 第二实例仍活着」—— 隐含假设
#   "那个提示框一定会挂在那儿等用户点确定"。结果在发行包那次验收里它**自己退了**
#   （MessageBox 被环境收掉），于是检查红了，而**被测行为完全正确**。
#   一个依赖"模态框还在不在"的断言本身就是不稳定的。
# 稳定判据：数 `[boot] 普瑞塞斯桌宠 …` 这一行出现了几次。
#   第二实例一定会先打印它（在单实例检查之前），所以：
#     次数从 1 变 2  => 第二实例确实跑起来了（否则我们根本没测到东西）—— 防"假绿"
#     同时出现「已有实例在运行 → 本次不启动」 => 它走的是正确的分支
$bootBefore = @(Get-LogTail $petLog 800 | Where-Object { $_ -match '\[boot\] 普瑞塞斯桌宠' }).Count
$p2 = StartApp -Exe $exe -WorkDir $PkgDir
Start-Sleep -Seconds 6
$bootAfter = @(Get-LogTail $petLog 800 | Where-Object { $_ -match '\[boot\] 普瑞塞斯桌宠' }).Count
Check '第二实例确实启动了（否则下面的检查等于没测）' ($bootAfter -gt $bootBefore) `
  "boot 行 $bootBefore -> $bootAfter"
Check '第二实例走的是「已有实例」分支（没有第二个桌宠在跑）' (LogHas '\[boot\] 已有实例在运行')
Check '桌宠进程始终只有 1 个（第二实例没有变成第二个她）' `
  (@(Get-PetProcs | Where-Object { $_.Id -ne $p2.Id }).Count -eq 1) `
  "除第二实例外还有 $(@(Get-PetProcs | Where-Object { $_.Id -ne $p2.Id }).Count) 个"
Check '原桌宠进程没被顶掉' ($null -ne (Get-Process -Id $petPidBefore -ErrorAction SilentlyContinue)) "pid=$petPidBefore"
Check '第二次双击没有起第二个桥接' ((Get-BridgeProcs).Count -eq $bridgeCountBefore) `
  "现在=$((Get-BridgeProcs).Count) 之前=$bridgeCountBefore"
# 关掉那个提示框（相当于用户点了"确定"）—— 它可能已经自己退了，两种都接受
if (-not $p2.HasExited) {
  $p2.CloseMainWindow() | Out-Null
  if (-not $p2.WaitForExit(5000)) { Stop-Process -Id $p2.Id -Force -ErrorAction SilentlyContinue }
}
Check '提示框关掉（或它已自行消失）后，第二实例不留下僵尸进程' `
  (Wait-For { $null -eq (Get-Process -Id $p2.Id -ErrorAction SilentlyContinue) } 10)
Start-Sleep -Seconds 1

# ---------------------------------------------------------------------------
Write-Host "`n--- 5. 退出时 exe 自己收掉桥接 ---"
# 断言全部以 `$bridgePid`（**产品日志里写下的那个 PID**）为准，不看进程表里的"某个 node"。
# 这样"收尾日志的 PID"与"我检查的 PID"必然是同一个 —— 从结构上杜绝张冠李戴。
Stop-PetGracefully
Check '桌宠进程已退出（走 Ctrl+Alt+Q / 关闭窗口这条真路径）' ((Get-PetProcs).Count -eq 0)
if ($bridgePid -gt 0) {
  Check 'exe 收尾掉了它自己启动的那个桥接 PID' `
    (Wait-For { $null -eq (Get-Process -Id $bridgePid -ErrorAction SilentlyContinue) } 20) `
    "该 PID=$bridgePid"
  $exitAll = @((Read-Shared $petLog) -split "`r?`n" | Where-Object { $_ -match '\[exit\]' })
  $exitLine = @($exitAll | Where-Object { $_ -match "\[exit\] 收尾：已结束桥接进程 PID $bridgePid" })
  Check '日志有「[exit] 收尾：已结束桥接进程 PID <同一个 PID>」' ($exitLine.Count -ge 1) `
    $(if ($exitLine.Count) { $exitLine[-1] } else { "整篇日志的 [exit] 行 = " + ($exitAll -join ' || ') })
}
Check '没有残留的 pet_bridge 进程' ((Get-BridgeProcs).Count -eq 0) "还有 $((Get-BridgeProcs).Count) 个"
Check '8792 端口已释放（/health 不再响应）' (Wait-For { $null -eq (Health) } 15)

# ---------------------------------------------------------------------------
Write-Host "`n--- 6. 找不到 node → 优雅降级（桌宠照跑，只是没有 live 事件） ---"
#
# 为什么要在**孤立副本**里做这一步（而不是原地改 PATH）：
#   1) 子进程继承的是**父进程的环境块**，所以"我在 pwsh 里改了 PATH"确实会传下去；
#      但如果被测的就是"包在真实的没有 node 的机器上会怎样"，原地测会污染主包
#      （留下一个 .boot-failed、清掉日志），而且主包的 runtime 里还留着第一个实例。
#   2) 孤立副本还能顺手证明"整包拷走就能跑"（v1 的包曾经拷走就废）。
$savedPath = $env:PATH
$tmpPkg = Join-Path $env:TEMP 'presage-v2-nonode'
if (Test-Path $tmpPkg) { Remove-Item $tmpPkg -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tmpPkg | Out-Null
Copy-Item (Join-Path $PkgDir 'presage-pet.exe') $tmpPkg -Force
Copy-Item (Join-Path $PkgDir 'WebView2Loader.dll') $tmpPkg -Force
Copy-Item (Join-Path $PkgDir 'tools') $tmpPkg -Recurse -Force
Copy-Item (Join-Path $PkgDir 'app') $tmpPkg -Recurse -Force
$tmpExe = Join-Path $tmpPkg 'presage-pet.exe'
$tmpLog = Join-Path $tmpPkg 'runtime\pet.out.log'

# 怎么把"这台真的没有 node"造出来？
#
# **试过但行不通**的办法（写下来免得下次再试一遍）：
#   * 只把 PATH 收窄 → 不管用：exe 的回退链里有"常见安装位置"，而本机
#     `C:\Program Files\nodejs\node.exe` 确实存在，它（正确地）找到了 node。
#     一个"看起来失败"的检查其实什么都没测到。
#   * 把 USERPROFILE 指到空目录 → 只能砍掉"DSH 自带 node"那一条。
#   * 覆盖 `ProgramFiles` → **根本覆盖不了**：cmd 探针实测，
#     `$env:ProgramFiles='X'` 和 `$psi.EnvironmentVariables['ProgramFiles']='X'`
#     （连 `_NEW` 写法）都不生效，Windows 会把机器上的真实值填回去。
#   * 临时把 `C:\Program Files\nodejs` 改名 → 需要管理员权限，被系统拒绝。
#
# 所以用 exe **自己提供**的开关：`PRESAGE_NODE=none`（明确不要桥接，回退链整段跳过）。
# 这不是为测试造的旁路 —— 它同时是给用户的正常能力：
# "我就是不想让桌宠启桥接"只需要设这一个变量。
$savedNode = $env:PRESAGE_NODE
$savedPath6 = $env:PATH
$savedHome6 = $env:USERPROFILE
$env:PRESAGE_NODE = 'none'
$env:PATH = "$env:SystemRoot\system32;$env:SystemRoot"
$emptyRoot = Join-Path $env:TEMP 'presage-nonode-root'
New-Item -ItemType Directory -Force -Path $emptyRoot | Out-Null
$env:USERPROFILE = $emptyRoot
# 清掉可能残留的 bridge.log：要验的是"这次没启动桥接"
Remove-Item (Join-Path $tmpPkg 'runtime\bridge.log') -Force -ErrorAction SilentlyContinue
$p3 = StartApp -Exe $tmpExe -WorkDir $tmpPkg
Check '找不到 node 时桌宠仍然启动（不阻断）' (Wait-For { $null -ne (Get-Process -Id $p3.Id -ErrorAction SilentlyContinue) } 30)
Check '日志明确说「没找到 node.exe … 跳过桥接」' (Wait-For { (Read-Shared $tmpLog) -match '没找到 node\.exe' } 25) `
  ((Get-LogTail $tmpLog 300 | Where-Object { $_ -like '*没找到 node*' } | Select-Object -First 1))
Check '日志也说明了是 PRESAGE_NODE=none 让它跳过的' ((Read-Shared $tmpLog) -match 'PRESAGE_NODE=none')
Check '无桥接时前端仍然 boot ok' (Wait-For { (Read-Shared $tmpLog) -match 'boot ok' } 30)
# 判据按 **PID** 而不是"进程表里有没有 pet_bridge"：
# 否则环境里任何残留的桥接都会让这条假红（本会话踩过）。
Check '降级时没有起桥接进程' `
  (($null -eq $p3) -or (@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ParentProcessId -eq $p3.Id }).Count -eq 0)) `
  "该桌宠 PID=$($p3.Id) 的子进程里没有 node"
Check '降级时没有生成 bridge.log（桥接压根没被启动）' (-not (Test-Path (Join-Path $tmpPkg 'runtime\bridge.log')))
Check '降级时也没有留下 .boot-failed（不是"启动失败"，只是没有桥接）' `
  (-not (Test-Path (Join-Path $tmpPkg 'runtime\.boot-failed')))
Check '降级时窗口照常建出来（只是没有 live 数据源）' `
  (@(Get-PetProcs | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }).Count -ge 1)
Stop-PetGracefully
Wait-For { (Get-PetProcs).Count -eq 0 } 20 | Out-Null
$env:PATH = $savedPath6
$env:USERPROFILE = $savedHome6
if ($null -eq $savedNode) { Remove-Item Env:\PRESAGE_NODE -ErrorAction SilentlyContinue } else { $env:PRESAGE_NODE = $savedNode }

# ---------------------------------------------------------------------------
Write-Host "`n--- 7. profile 坏了 → 自动删掉重建（自愈） ---"
$wv2 = Join-Path $runtime 'webview2'
Kill-StaleBridges
New-Item -ItemType Directory -Force -Path $wv2 | Out-Null
[System.IO.File]::WriteAllText((Join-Path $wv2 'Local State'), 'NOT JSON {{{ broken', [System.Text.Encoding]::UTF8)
New-Item -ItemType Directory -Force -Path (Join-Path $wv2 'EBWebView') | Out-Null
[System.IO.File]::WriteAllBytes((Join-Path $wv2 'EBWebView\junk.bin'), (New-Object byte[] 4096))
# v1 bat 那套失败标记：模拟"上次启动失败过"
[System.IO.File]::WriteAllText((Join-Path $runtime '.boot-failed'), 'simulated failure', [System.Text.Encoding]::UTF8)
Reset-Logs

$p4 = StartApp -Exe $exe -WorkDir $PkgDir
Check '带 .boot-failed 标记启动仍然成功' (Wait-For { (Get-PetProcs).Count -ge 1 } 30)
Check '日志说「发现上次的启动失败标记 → 已先删除 … 重建」' (Wait-For { LogHas '发现上次的启动失败标记' 200 } 20) `
  ((Get-LogTail $petLog 200 | Where-Object { $_ -like '*失败标记*' } | Select-Object -First 1))
Check '失败标记已被消费掉（不会每次都删 profile）' (-not (Test-Path (Join-Path $runtime '.boot-failed')))
Check '重建 profile 后前端仍然 boot ok' (Wait-For { LogHas 'boot ok' 500 } 30)
Check 'profile 目录里重新长出了 WebView2 结构' (Test-Path (Join-Path $wv2 'EBWebView'))

# ---------------------------------------------------------------------------
if (-not $KeepRunning) {
  Stop-PetGracefully
  Wait-For { (Get-PetProcs).Count -eq 0 } 20 | Out-Null
  Kill-StaleBridges
}

# ---------------------------------------------------------------------------
Write-Host "`n============================================================"
$fail = @($script:results | Where-Object { -not $_.Ok })
$pass = @($script:results | Where-Object { $_.Ok -and -not $_.Info })
Write-Host (" 通过 {0} 项，失败 {1} 项" -f $pass.Count, $fail.Count)
if ($fail.Count) {
  Write-Host ' 失败项：'
  $fail | ForEach-Object { Write-Host ("   - {0}  ({1})" -f $_.Name, $_.Detail) }
}
Write-Host ''
Write-Host ' 未覆盖（必须真人/真机肉眼确认，脚本不替你签字）：'
Write-Host '   * 双击那一下的体感（本脚本用 Process.Start 起进程，不是真的鼠标双击）'
Write-Host '     —— 有没有黑框闪过；机器判据是"桥接 node 进程 MainWindowHandle=0"（已验证）'
Write-Host '   * 托盘图标是否出现（本机在桌面路径下 err=5，换个纯英文短路径又 ok=1；'
Write-Host '     见 OPEN-ISSUES.md 1.1。属环境级限制，与代码无关）'
Write-Host ''
Write-Host ' 已经肉眼确认过、不用再验的：'
Write-Host '   * 她整只画出来了、没被裁 —— runtime\v2-desktop.png / runtime\v2-see.png'
Write-Host '     （佐证：几何自检 裁掉=0 出屏=0；hitmask filled≠0）'
Write-Host '============================================================'
if ($fail.Count) { exit 1 }
exit 0
