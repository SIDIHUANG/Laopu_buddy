@echo off
rem 普瑞塞斯桌宠 v2 · 一键导出诊断报告
rem
rem 等价于：presage-pet.exe --diag
rem 会写 v2\runtime\diag.txt 并用记事本打开（UTF-8，中文不会花屏）。
rem 看不到桌宠 / 桌宠闪一下就没 时，把报告整份发出去即可。
setlocal
set "HERE=%~dp0"
cd /d "%HERE%"
if not exist "%HERE%presage-pet.exe" (
  echo [x] 找不到 presage-pet.exe（目录: %HERE%）
  pause
  exit /b 1
)
"%HERE%presage-pet.exe" --diag
exit /b 0
