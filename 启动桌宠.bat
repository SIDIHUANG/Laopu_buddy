@echo off
rem ============================================================================
rem  普瑞塞斯桌宠 · v1.1 启动器（**唯一实现**；v1\ 里那份只负责转发到这里）
rem
rem  这份启动器只做四件事，每一件都是被真实故障逼出来的：
rem
rem  1) 用 `start "" /b exe` 直接启动，不经过 PowerShell。
rem     为什么：老版本用 `powershell -Command Start-Process ... -RedirectStandardOutput`
rem     启动，进程树里多了一层 powershell.exe。用户双击时能看到控制台一闪，
rem     桌宠跟着抖动甚至不再绘制（多一层进程抢前台/抢合成）。直接 start 的
rem     进程树里只有桌宠自己，和"手动双击 exe"完全一致。
rem
rem  2) 用一个**固定的、可自愈的** profile 目录：runtime\webview2
rem     为什么要固定：WebView2 的 profile 一旦被写坏（进程被强杀、磁盘满、
rem     断电），之后每次启动都会以 HRESULT 0x8000FFFF「灾难性故障」直接失败，
rem     用户看到的就是"双击后闪一下就没、日志里什么都没有"。
rem     所以这里：
rem       a) 若上一轮留下了失败标记 (.boot-failed)，先把旧 profile 整个删掉；
rem       b) 启动后 12 秒内进程不在，就判定这次启动失败，删掉 profile 再试一次。
rem     这样用户永远不用手工删目录。要干净对比请传 -IsolateProfile。
rem
rem  3) 不需要管理员权限，也不依赖任何环境变量 / 工作目录 / PATH。
rem     所有路径都由 %~dp0 推导，所以「双击 bat / 快捷方式 / 计划任务 /
rem     从任意目录 cmd 调用」四种方式行为一致。提权会同时打掉托盘注册
rem     和 WebView2 合成（历史问题 1 与 2），所以下面显式提示不要提权。
rem
rem  4) 启动后自检，并把日志转成 GBK 打印（UTF-8 直出在 cmd 里是花屏）。
rem     看不到桌宠时，把这一段整块发出去就能定位，不用再靠截图猜。
rem
rem  已知坑（别改回去）：
rem    * 不要用 `timeout /t` —— stdin 被重定向时它会直接中断整个批处理；
rem      用 `ping -n N 127.0.0.1 >nul` 代替。
rem    * 不要用 `chcp 65001` —— 本文件用系统代码页（GBK）保存，
rem      两者不一致时中文全是乱码。
rem    * 缺 WebView2Loader.dll 会让双击 exe **静默秒退**（0xC0000135），
rem      所以第 1 步必须替用户查出来。
rem    * **不要假设日志一定在 %LOGDIR%** —— 桌宠是往"自己的当前目录\runtime\
rem      pet.out.log"写的，某些调用方式下工作目录会变成 v1\，日志就落到
rem      v1\runtime\。v1.1 第一版因此让自检段 [2]~[5] 全是空的（用户实测抓到），
rem      所以下面用 :findlog 在两个候选目录里轮询。
rem    * node 不能只认 DSH 自带的那份 —— 必须回落到 PATH 上的 node。
rem ============================================================================

rem ---------------------------------------------------------------------------
rem  参数： -Diag（详细信息 + 停住 30 秒）  -IsolateProfile  -NoWait
rem ---------------------------------------------------------------------------
set "WANT_DIAG=0"
set "WANT_ISOLATE=0"
set "WANT_NOWAIT=0"
:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="-Diag"           set "WANT_DIAG=1"
if /i "%~1"=="-IsolateProfile" set "WANT_ISOLATE=1"
if /i "%~1"=="-NoWait"         set "WANT_NOWAIT=1"
shift
goto parse_args
:args_done

set "ROOT=%~dp0"
set "PETDIR=%ROOT%v1"
if not exist "%PETDIR%\presage-pet.exe" set "PETDIR=%ROOT%"
set "PET=%PETDIR%\presage-pet.exe"
rem 注意：%ROOT% 末尾**自带**反斜杠，所以这里是 %ROOT%v1 而不是 %ROOT%\v1。
rem 写成 %PETDIR%runtime 会得到 "…\v1runtime"（少一个反斜杠）—— v1.1 第二版踩过。
set "V1RUNTIME=%ROOT%v1\runtime"

rem ---------------------------------------------------------------------------
rem  1. 文件齐全性
rem ---------------------------------------------------------------------------
if not exist "%PET%" (
  echo [x] 找不到 presage-pet.exe
  echo     应该在: %PET%
  echo     请确认交付包完整（presage-pet.exe / WebView2Loader.dll / 启动桌宠.bat）。
  pause
  exit /b 1
)
set "LOADER="
for %%d in ("%PETDIR%") do set "LOADER=%%~fd\WebView2Loader.dll"
if not exist "%LOADER%" (
  echo [x] 缺少 WebView2Loader.dll（必须和 exe 放在同一个目录）
  echo     查找位置: %LOADER%
  echo     缺它的症状是：双击 exe 什么都不发生，任务管理器里闪一下就没。
  pause
  exit /b 1
)

rem ---------------------------------------------------------------------------
rem  2. 重复实例：先问再启动，避免"点了没反应"（其实是第二个实例自己退了）
rem ---------------------------------------------------------------------------
tasklist /fi "imagename eq presage-pet.exe" 2>nul | findstr /i "presage-pet.exe" >nul
if not errorlevel 1 (
  echo [i] 桌宠已经在运行（没有重复启动）。
  echo     要重新启动请先退出它：托盘图标右键 - 退出普瑞塞斯，
  echo     或在本窗口执行:  taskkill /im presage-pet.exe /f
  if "%WANT_NOWAIT%"=="0" ping -n 8 127.0.0.1 > nul
  exit /b 0
)

set "LOGDIR=%ROOT%runtime"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" 2>nul
if not exist "%LOGDIR%\events" mkdir "%LOGDIR%\events" 2>nul

rem ---------------------------------------------------------------------------
rem  3. WebView2 profile：固定 + 可自愈
rem ---------------------------------------------------------------------------
set "WV2=%LOGDIR%\webview2"
set "FAILMARK=%LOGDIR%\.boot-failed"
if "%WANT_ISOLATE%"=="1" set "WV2=%LOGDIR%\webview2-test"

if exist "%FAILMARK%" (
  echo [i] 上次启动失败过：先清理 WebView2 profile 再启动...
  rmdir /s /q "%WV2%" 2>nul
  del /q "%FAILMARK%" 2>nul
)
if not exist "%WV2%" mkdir "%WV2%" 2>nul
set "WEBVIEW2_USER_DATA_FOLDER=%WV2%"

rem 写权限自检：profile 目录不可写时 WebView2 只会报"灾难性故障"，
rem 在这里提前说清楚，省得用户对着一个空白日志猜。
echo probe> "%WV2%\.write-test" 2>nul
if not exist "%WV2%\.write-test" (
  echo [x] WebView2 profile 目录不可写: %WV2%
  echo     请确认该目录没有被安全软件锁住，或手工删除后重试。
  pause
  exit /b 1
)
del /q "%WV2%\.write-test" 2>nul

rem ---------------------------------------------------------------------------
rem  4. 桥接（余额 / 台词库）。找不到 node 就跳过 —— 桌宠没它也能跑，
rem     只是没有余额播报与自定义台词。
rem     脚本可能在 PETDIR\tools\（完整工程）或 ROOT\tools\（只带了 tools\ 的包）。
rem ---------------------------------------------------------------------------
set "BRIDGE="
if exist "%PETDIR%\tools\pet_bridge.mjs" set "BRIDGE=%PETDIR%\tools\pet_bridge.mjs"
if not defined BRIDGE if exist "%ROOT%tools\pet_bridge.mjs" set "BRIDGE=%ROOT%tools\pet_bridge.mjs"
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" for %%n in (node.exe) do set "NODE=%%~$PATH:n"
if not exist "%NODE%" (
  echo [i] 没有找到 node，跳过桥接（桌宠本体不受影响，只是没有余额播报）
  goto after_bridge
)
if not defined BRIDGE (
  echo [i] 没找到 tools\pet_bridge.mjs，跳过桥接
  goto after_bridge
)
netstat -ano | findstr /r /c:"127.0.0.1:8792 .*LISTENING" > nul
if errorlevel 1 (
  echo [i] 启动桥接（余额 / 台词库）...
  start "presage-bridge" /min /d "%PETDIR%" "%NODE%" "%BRIDGE%" --out "%LOGDIR%\events" --port 8792
  ping -n 3 127.0.0.1 > nul
) else (
  echo [i] 桥接已在运行
)
:after_bridge

rem ---------------------------------------------------------------------------
rem  5. 启动桌宠本体
rem ---------------------------------------------------------------------------
echo ============================================================================
echo   普瑞塞斯桌宠 v1.1
echo ----------------------------------------------------------------------------
echo   请不要用「以管理员身份运行」！
echo     提权会导致： (a) 托盘图标注册被系统拒绝
echo                  (b) 透明窗口的 GPU 合成失效（她就画不出来了）
echo   日志： %LOGDIR%\pet.out.log   与   %%LOCALAPPDATA%%\PresagePet\pet.log
echo ----------------------------------------------------------------------------

if "%WANT_DIAG%"=="1" set "PRESAGE_SELFTEST=geom"
del /q "%LOGDIR%\pet.out.log" "%LOGDIR%\pet.err.log" >nul 2>nul
del /q "%V1RUNTIME%\pet.out.log" "%V1RUNTIME%\pet.err.log" >nul 2>nul
echo [i] 正在启动...

rem /b = 不新建窗口；路径后不加东西 = 不等待。批处理随后自己退出，
rem 桌宠就是独立进程（和双击 exe 一样，不会有父控制台在退出时把它带走）。
call :launch_once
ping -n 13 127.0.0.1 > nul

rem 启动失败（进程不在）→ 清掉可能损坏的 profile，重试一次
tasklist /fi "imagename eq presage-pet.exe" 2>nul | findstr /i "presage-pet.exe" >nul
if errorlevel 1 (
  echo.
  echo [!] 12 秒后进程不在 —— 判定启动失败，清理 profile 后重试一次...
  echo failed %DATE% %TIME%> "%FAILMARK%"
  rmdir /s /q "%WV2%" 2>nul
  if not exist "%WV2%" mkdir "%WV2%" 2>nul
  del /q "%LOGDIR%\pet.out.log" "%LOGDIR%\pet.err.log" >nul 2>nul
  del /q "%V1RUNTIME%\pet.out.log" "%V1RUNTIME%\pet.err.log" >nul 2>nul
  call :launch_once
  ping -n 13 127.0.0.1 > nul
  tasklist /fi "imagename eq presage-pet.exe" 2>nul | findstr /i "presage-pet.exe" >nul
  if not errorlevel 1 (
    del /q "%FAILMARK%" 2>nul
    echo [i] 重试成功（profile 之前是坏的，已自动重建）。
  ) else (
    echo [x] 重试仍然失败。请把下面这一整段发出去。
  )
)

if "%WANT_NOWAIT%"=="1" exit /b 0

rem 日志可能在两处之一（见文件头"已知坑"）：轮询着找，别假设。
echo [i] 正在等日志...
call :findlog

if not defined LOGFILE (
  echo [i] 没有找到 pet.out.log（两个候选目录都没有）
  echo     桌宠正常都会写一份；请改看:  %%LOCALAPPDATA%%\PresagePet\pet.log
  echo     候选1: %LOGDIR%\pet.out.log
  echo     候选2: %V1RUNTIME%\pet.out.log
)
if defined LOGFILE powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-Content -Encoding UTF8 '%LOGFILE%' | Set-Content -Encoding Default '%LOGDIR%\pet.out.gbk.log'" >nul 2>nul
set "GBK=%LOGDIR%\pet.out.gbk.log"

echo.
echo ==================== 自检（看不到桌宠时把这一段发出去）====================
echo [1] 进程（有输出=活着；活着却看不到她 = 位置/渲染问题）:
tasklist /fi "imagename eq presage-pet.exe" 2>nul | findstr /i "presage-pet.exe"
echo.
echo [2] 托盘注册结果:
findstr /c:"Shell_NotifyIcon" "%GBK%" 2>nul
echo.
echo [3] 关键状态（几何自检里 裁掉=0 / 出屏=0 / 气泡出框=0 才算正常）:
findstr /c:"source=" /c:"boot ok" /c:"BOOT-FAILED" /c:"REJECT" /c:"外观 " /c:"提权" "%GBK%" 2>nul
echo.
echo [4] 几何 / 素材 / 报错:
findstr /c:"[geom:" /c:"hitmask" /c:"ERROR" "%GBK%" 2>nul
echo.
echo [5] pet.err.log 末尾:
set "ERRLOG=%LOGDIR%\pet.err.log"
if not exist "%ERRLOG%" if exist "%V1RUNTIME%\pet.err.log" set "ERRLOG=%V1RUNTIME%\pet.err.log"
if exist "%ERRLOG%" powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "if ((Get-Item '%ERRLOG%').Length -gt 0) { Get-Content -Encoding UTF8 -Tail 12 '%ERRLOG%' } else { '(空)' }"
echo.
echo 完整日志: %LOGFILE%
echo （总是可读的那一份: %%LOCALAPPDATA%%\PresagePet\pet.log）
echo ============================================================================
if "%WANT_DIAG%"=="1" (
  echo.
  echo [i] 详细模式：窗口停在这里 30 秒方便截图...
  ping -n 31 127.0.0.1 > nul
  exit /b 0
)
ping -n 14 127.0.0.1 > nul
exit /b 0

rem ---------------------------------------------------------------------------
rem  子过程
rem ---------------------------------------------------------------------------
:launch_once
start "" /b "%PET%"
exit /b 0

rem  在两个候选目录里轮询 pet.out.log，找到就把**带引号**的路径写进 LOGFILE
:findlog
set "LOGFILE="
for /l %%i in (1,1,12) do (
  if not defined LOGFILE if exist "%LOGDIR%\pet.out.log" set "LOGFILE="%LOGDIR%\pet.out.log""
  if not defined LOGFILE if exist "%V1RUNTIME%\pet.out.log" set "LOGFILE="%V1RUNTIME%\pet.out.log""
  if not defined LOGFILE ping -n 2 127.0.0.1 > nul
)
exit /b 0
