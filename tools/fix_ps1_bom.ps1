# fix_ps1_bom.ps1 -- restore UTF-8 BOM on PowerShell scripts.
#
# WHY THIS FILE IS PURE ASCII (do not translate it to Chinese):
#   Windows PowerShell 5.1 decodes a .ps1 WITHOUT a BOM using the system ANSI
#   code page (GBK on this machine). Any non-ASCII character in such a file --
#   even inside a comment -- can break the parser, and NO self-repair code
#   inside the broken script can run, because parsing fails first.
#   Therefore the repair tool itself must be readable under every encoding:
#   ASCII bytes decode identically as UTF-8, GBK and Latin-1.
#
# WHEN YOU NEED IT:
#   The Chinese-commented tooling (pack_v2.ps1, pack_buildinfo_v2.ps1,
#   test_v2_exe.ps1) must be saved as "UTF-8 with BOM". Some editors and
#   patch/automation tools strip the BOM. If one of those scripts suddenly
#   reports syntax errors at nonsense positions, run this.
#
# USAGE:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\fix_ps1_bom.ps1
#   powershell ... -File tools\fix_ps1_bom.ps1 -Path tools\my_script.ps1
#   powershell ... -File tools\fix_ps1_bom.ps1 -All -Root C:\some\repo

param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string[]]$Path,
  [switch]$All
)

$ErrorActionPreference = 'Stop'
$utf8Bom = New-Object System.Text.UTF8Encoding($true)

if ($All) {
  $Path = @(Get-ChildItem -Path $Root -Recurse -Filter '*.ps1' -File -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty FullName)
} elseif (-not $Path) {
  $Path = @(
    (Join-Path $Root 'tools\pack_v2.ps1'),
    (Join-Path $Root 'tools\pack_buildinfo_v2.ps1'),
    (Join-Path $Root 'tools\test_v2_exe.ps1')
  )
}

$fixed = 0
$ok = 0
foreach ($p in $Path) {
  if (-not (Test-Path $p)) { Write-Host "[skip] not found : $p"; continue }
  $full = (Resolve-Path $p).Path
  $bytes = [System.IO.File]::ReadAllBytes($full)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  if ($hasBom) { Write-Host "[ok]   BOM present: $full"; $ok++; continue }

  # Only add a BOM when the content really is UTF-8; otherwise we would
  # silently pretend a GBK file is UTF-8 and make things worse.
  $strict = New-Object System.Text.UTF8Encoding($false, $true)
  try {
    $text = $strict.GetString($bytes)
  } catch {
    Write-Host "[FAIL] $full is NOT valid UTF-8 -- do not BOM it."
    Write-Host "       Re-save it explicitly (VS Code: 'UTF-8 with BOM')."
    continue
  }
  $hasNonAscii = $false
  foreach ($b in $bytes) { if ($b -gt 0x7F) { $hasNonAscii = $true; break } }
  # ASCII-only files are safe without a BOM, but adding one is harmless and
  # makes the rule uniform -- so we still do it, just say why.
  [System.IO.File]::WriteAllBytes($full, $utf8Bom.GetPreamble() + $bytes)
  Write-Host ("[fix]  BOM added   : {0}{1}" -f $full, $(if ($hasNonAscii) { '' } else { '  (ASCII only)' }))
  $fixed++
}

Write-Host ''
Write-Host ("fixed={0}  already-ok={1}" -f $fixed, $ok)
if ($fixed -gt 0) {
  Write-Host 'Re-run the original command now; the Chinese comments will decode correctly.'
}
