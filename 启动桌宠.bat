@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  双击这个文件启动普瑞塞斯桌宠
rem
rem  为什么强调"你自己双击"：托盘图标依赖 Shell_NotifyIcon，
rem  受限令牌（通过代理/沙箱启动的进程）下这个调用会直接返回
rem  ACCESS_DENIED(5)，表现是"进程起来了、窗口也正常，但通知区没有图标"。
rem  由你双击启动时用的是正常令牌，注册才会被系统接受。
rem
rem  日志写在 runtime\pet.out.log —— 里面有一行
rem  "[tray] Shell_NotifyIcon 注册成功"，那就是托盘成功的铁证。
rem ============================================================

set "PET=app\src-tauri\target\debug\presage-pet.exe"
set "LOGDIR=%CD%\runtime"
set "WEBVIEW2_USER_DATA_FOLDER=%LOGDIR%\webview2"

if not exist "%LOGDIR%" mkdir "%LOGDIR%"
if not exist "%LOGDIR%\events" mkdir "%LOGDIR%\events"

if not exist "%PET%" (
  echo [x] 找不到 %PET%
  echo     请先构建：python tools\build_web.py  ^&^&  cargo build
  pause
  exit /b 1
)

rem 已经在跑就别开第二个（否则会有两只桌宠抢同一个位置）
tasklist /fi "imagename eq presage-pet.exe" 2>nul | findstr /i "presage-pet.exe" >nul
if not errorlevel 1 (
  echo [i] 桌宠已经在运行，不重复启动。
  echo     要测试托盘请先退出它（托盘菜单里的"退出普瑞塞斯"，或任务管理器结束进程）。
  timeout /t 5 > nul
  exit /b 0
)

rem 桥接提供 /usage（余额）与台词库接口；找不到 node 也不影响桌宠本体
rem （DSH 状态感知是零安装的轮询，不依赖桥接）。
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE%" (
  netstat -ano | findstr /r /c:"127.0.0.1:8792 .*LISTENING" > nul
  if errorlevel 1 (
    echo [i] 启动桥接（余额 / 台词库）...
    start "presage-bridge" /min "%NODE%" "tools\pet_bridge.mjs"
    timeout /t 2 > nul
  ) else (
    echo [i] 桥接已在运行
  )
) else (
  echo [i] 没找到 node，跳过桥接
)

echo [i] 启动桌宠... 日志：runtime\pet.out.log
start "" /b cmd /c ""%PET%" > "%LOGDIR%\pet.out.log" 2> "%LOGDIR%\pet.err.log""

timeout /t 6 > nul
echo.
findstr /c:"Shell_NotifyIcon" "%LOGDIR%\pet.out.log" 2>nul
echo.
echo 若上面看不到"注册成功"，请把这几行发给开发者。
echo 若注册成功但看不到图标：设置 - 个性化 - 任务栏 - 其他系统托盘图标，打开"普瑞塞斯"。
timeout /t 10 > nul
