param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)
<#
  把根目录的启动器同步成 v1\ 交付包里的**独立版**。

  背景：v1 时期有两份启动逻辑各自修 bug，结果"改好了一份、另一份还是旧的"，
  用户双击哪个入口现象都不一样。所以现在**只有一份实现**（根目录
  `启动桌宠.bat`），v1\ 里那份由这个脚本**生成**，区别只有三处：
    * PETDIR  = 包自己所在的目录（%~dp0），不再向上找根目录
    * V1RUNTIME = 上一级（完整工程）的 runtime，作为日志候选 2
    * 若干只对根目录版成立的注释
  这样既能"整包拷走独立运行"，又不会出现两份逻辑漂移。

  用法：  powershell -NoProfile -ExecutionPolicy Bypass -File tools/pack_v1.ps1
#>
$ErrorActionPreference = 'Stop'
$gbk = [System.Text.Encoding]::GetEncoding(936)
$utf8 = New-Object System.Text.UTF8Encoding($false)

$srcPath = Join-Path $Root '启动桌宠.bat'
$outDir = Join-Path $Root 'v1'
$outPath = Join-Path $outDir '启动桌宠.bat'

if (-not (Test-Path $srcPath)) { throw "找不到根启动器: $srcPath" }
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

# 源文件是 GBK，读进来再按 UTF-8 处理，避免 powershell -File 把中文读成乱码
$t = [System.IO.File]::ReadAllText($srcPath, $gbk)
$orig = $t

$t = $t.Replace(
  'rem  普瑞塞斯桌宠 · v1.1 启动器（**唯一实现**；v1\ 里那份只负责转发到这里）',
  'rem  普瑞塞斯桌宠 · v1.1 启动器（**v1\ 交付包自带，可整包拷走独立运行**）')

# PETDIR：根版是"先找 v1\、找不到就用根目录"；包内版直接就是包自己。
# 注意根版里这两行被"自定位守卫"隔开了，所以分开替换并逐行校验 ——
# 之前把它们当成一个连续块替换，守卫一插进去就静默失配（pack 自检当场抓到了）。
$repl = @(
  @{ from = 'set "PETDIR=%ROOT%v1"'; to = 'rem 包内版本：exe 就在本文件旁边（%~dp0），不再向上找根目录。' },
  @{ from = 'if not exist "%PETDIR%\presage-pet.exe" set "PETDIR=%ROOT%"'; to = 'set "PETDIR=%ROOT%"' }
)
foreach ($r in $repl) {
  if (-not $t.Contains($r.from)) { throw "pack_v1: 找不到待替换行 -> $($r.from)" }
  $t = $t.Replace($r.from, $r.to)
}

$t = $t.Replace(
  'set "V1RUNTIME=%ROOT%v1\runtime"',
  "rem 日志候选 2：上一级（完整工程）的 runtime，方便在工程里调试包内 exe。`r`n" +
  'for %%d in ("%ROOT%..") do set "V1RUNTIME=%%~fd\runtime"')

$t = $t.Replace("rem 注意：%ROOT% 末尾**自带**反斜杠，所以这里是 %ROOT%v1 而不是 %ROOT%\v1。`r`n", '')
$t = $t.Replace("rem 写成 %PETDIR%runtime 会得到 `"…\v1runtime`"（少一个反斜杠）—— v1.1 第二版踩过。`r`n", '')
$t = $t.Replace(
  'rem     脚本可能在 PETDIR\tools\（完整工程）或 ROOT\tools\（只带了 tools\ 的包）。',
  'rem     包内版本：脚本就在 %PETDIR%\tools\（随包分发）。')

$t = $t.Replace("`r`n", "`n").Replace("`n", "`r`n")
if ($t -eq $orig) { throw 'pack_v1: 一处都没替换成功，根启动器的结构可能变了' }
$check = $t          # 自检对象 = 真正要写出去的内容（不要在下面重新回读覆盖它）
[System.IO.File]::WriteAllBytes($outPath, $gbk.GetBytes($t))

$problems = @()
if ($check.Contains('%ROOT%v1')) { $problems += '还残留 %ROOT%v1（PETDIR 没换掉）' }
if ($check.Contains([char]0xFFFD)) { $problems += '编码转换出现替换字符' }
if (([regex]::Matches($check, "(?<!`r)`n")).Count -gt 0) { $problems += '存在裸 LF（.bat 必须 CRLF）' }
foreach ($needle in @('set "PETDIR=%ROOT%"', ':findlog', ':launch_once', 'set "V1RUNTIME=')) {
  if (-not $check.Contains($needle)) { $problems += "缺少关键行: $needle" }
}

$size = (Get-Item $outPath).Length
Write-Host ("[pack] {0}  ({1} bytes)" -f $outPath, $size)
if ($problems.Count) {
  Write-Host "[pack] 自检失败："
  $problems | ForEach-Object { Write-Host "   - $_" }
  exit 1
}
Write-Host "[pack] 自检通过：PETDIR 指向包自身、日志双候选、关键标签齐全、GBK+CRLF"
exit 0
