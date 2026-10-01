@echo off
rem ============================================================================
rem  普瑞塞斯桌宠 v2 · **可选**启动入口（正常用法是直接双击 presage-pet.exe）
rem
rem  这份 bat 存在的唯一理由：有些场景必须通过 bat 启动（脚本化、快捷方式
rem  指向 bat、某些启动器只认 bat）。它**不含任何逻辑** —— 不查 DLL、不设
rem  profile、不起桥接、不做单实例判断，那五件事 v2 全部由 exe 自己完成。
rem
rem  所以它不会像 v1 那样出现"两份启动逻辑各自漂移"的问题（v1 实测：
rem  v1\ 里修好了、根目录那份还是旧的，两个入口现象不同）。
rem
rem  已知坑（别改回去）：
rem    * 不要用 timeout /t —— stdin 被重定向时它会直接中断整个批处理。
rem    * 不要用 chcp 65001 —— 本文件用系统代码页（GBK）保存，会全乱码。
rem    * 不要在这里加"缺 WebView2Loader.dll 就提示" —— exe 自己会弹框说，
rem      两处都写就又变成"两份逻辑"。
rem ============================================================================
setlocal
set "HERE=%~dp0"
set "PET=%HERE%presage-pet.exe"

if /i "%~1"=="-Diag" goto diag
if /i "%~1"=="--diag" goto diag

if not exist "%PET%" (
  echo [x] 找不到 presage-pet.exe
  echo     本文件所在目录: %HERE%
  echo     请确认交付包完整（exe 必须和本 bat 在同一目录）。
  pause
  exit /b 1
)

rem 工作目录就用 exe 所在目录：exe 自己也锚定那里，这里只是保持一致。
cd /d "%HERE%"
"%PET%"
rem exe 是 GUI 程序，双击时它立刻就返回了；如果用户是从 cmd 里敲的，
rem 这里等一下让他能看到 exe 的对话框结果（最多 15 秒）。
ping -n 2 127.0.0.1 >nul
exit /b 0

:diag
rem 诊断：exe 自己写 runtime\diag.txt 并打开记事本。这里只做转发。
if not exist "%PET%" (
  echo [x] 找不到 presage-pet.exe（目录: %HERE%）
  pause
  exit /b 1
)
cd /d "%HERE%"
"%PET%" --diag
exit /b 0
