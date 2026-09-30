<#
普瑞塞斯桌宠 · 一键构建

为什么需要这个脚本：我们用 GNU 工具链（**免管理员**，不必装几个 GB 的 VS Build Tools），
但 rustup 不会把 MinGW 的 binutils 放进 PATH —— cargo 自己链接时会加，而某些 crate 的
构建脚本（例如 parking_lot_core）会**直接调用 `dlltool`**，于是报
`error calling dlltool 'dlltool.exe': program not found`。
这里把工具链的 self-contained 目录补进 PATH 即可。

用法：
  pwsh -File tools/build_app.ps1             # 只构建
  pwsh -File tools/build_app.ps1 --release   # 发布构建
#>
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$toolchain = Join-Path $env:USERPROFILE '.rustup\toolchains\stable-x86_64-pc-windows-gnu'
$selfContained = Join-Path $toolchain 'lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained'

# 完整 MinGW-w64（提供 as/ar/dlltool）。rustup 的 rust-mingw 只有 dlltool，没有汇编器，
# rustc 的 raw-dylib 链接会因此失败。详见 README「坑 2」。
$mingwBin = Get-ChildItem (Join-Path $env:USERPROFILE '.mingw64') -Recurse -Directory -Filter 'bin' -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'dlltool.exe') } | Select-Object -First 1

$env:Path = (@(
    if ($mingwBin) { $mingwBin.FullName }
    $cargoBin
    $selfContained
  ) -join ';') + ";$env:Path"

if (-not $mingwBin) {
  Write-Warning '没找到完整 MinGW-w64（~/.mingw64），GNU 构建很可能在 dlltool 处失败。见 README「坑 2」。'
}

foreach ($tool in @('cargo.exe', 'rustc.exe')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "找不到 $tool。请先安装 Rust：https://rustup.rs （并用 --default-toolchain stable-x86_64-pc-windows-gnu）"
  }
}
if (-not (Test-Path (Join-Path $selfContained 'dlltool.exe'))) {
  Write-Warning "self-contained 目录里没有 dlltool.exe，GNU 构建可能失败：$selfContained"
}

# 先把前端装配进 dist（Tauri 在编译期就把前端嵌进去，必须先有）
Write-Host '[1/2] 装配前端 dist ...' -ForegroundColor Cyan
& python (Join-Path $root 'tools\build_web.py')
if ($LASTEXITCODE -ne 0) { throw 'build_web.py 失败' }

Write-Host '[2/2] cargo build ...' -ForegroundColor Cyan
Push-Location (Join-Path $root 'app\src-tauri')
try {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & cargo build @args
  $code = $LASTEXITCODE
  "{0}  ({1:N1} 分钟)" -f $(if ($code -eq 0) { '构建成功' } else { "构建失败 exit=$code" }), $sw.Elapsed.TotalMinutes | Write-Host
  if ($code -ne 0) { exit $code }
  Get-ChildItem 'target\debug\*.exe' -ErrorAction SilentlyContinue |
    ForEach-Object { "产出: {0}  {1:N2} MB" -f $_.Name, ($_.Length / 1MB) }
} finally {
  Pop-Location
}
