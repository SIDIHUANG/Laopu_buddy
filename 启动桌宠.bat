@echo off
rem ============================================================================
rem  普瑞塞斯桌宠 · v1.1 启动器（**唯一实现**，工程根目录版）
rem
rem  包内版（v1\启动桌宠.bat）由 tools/pack_v1.ps1 从这份生成，两者只差三处：
rem    PETDIR 指向包自身 / 日志候选 2 / 只对工程版成立的注释。
rem  别手工维护两份逻辑 —— v1 时期就是这么漂移出 bug 的。
rem
rem  这份启动器做五件事，每一件都是被真实故障逼出来的：
rem
rem  1) 自定位校验。%~dp0 是"本文件所在目录"，正常一定对；但被 `call` 从别的
rem     目录按绝对路径调起来时，历史上出现过它解析成**调用方目录**（实测变成
rem     C:\Windows\），于是 PETDIR 跟着错、跑去 C:\Windows 找 exe，
rem     报的错还完全指错方向。所以这里先判别，再往下走。
rem
rem  2) 用 `start "" /b exe` 直接启动，不经过 PowerShell。老版本用
rem     `powershell -Command Start-Process ... -RedirectStandardOutput`，
rem     进程树里多一层 powershell.exe，用户双击时控制台一闪、桌宠跟着抖动。
rem     直接 start 的进程树里只有桌宠自己，和"手动双击 exe"完全一致。
rem
rem  3) 固定的、可自愈的 WebView2 profile（runtime\webview2）。
rem     profile 一旦被写坏（进程被强杀/磁盘满/断电），之后每次启动都会以
rem     HRESULT 0x8000FFFF「灾难性故障」直接失败 —— 用户看到"闪一下就没、
rem     日志空白"。所以：有 .boot-failed 标记就先删 profile；启动后 12 秒进程
rem     不在就判定失败，删掉 profile 再试一次。用户永远不用手工删目录。
rem
rem  4) 不依赖任何环境变量 / 工作目录 / PATH，也不要管理员权限。
rem     提权会同时打掉托盘注册与 WebView2 合成，所以下面明确提示不要提权。
rem
rem  5) 启动后自检，并把日志转成 GBK 打印（UTF-8 直出在 cmd 里是花屏）。
rem     看不到桌宠时，把这一段整块发出去就能定位，不用靠截图猜。
rem
rem  已知坑（别改回去）：
rem    * 不要用 `timeout /t` —— stdin 被重定向时它会直接中断整个批处理；
rem      用 `ping -n N 127.0.0.1 >nul` 代替。
rem    * 不要用 `chcp 65001` —— 本文件用系统代码页（GBK）保存，会全乱码。
rem    * 缺 WebView2Loader.dll 会让双击 exe **静默秒退**（0xC0000135），
rem      所以第 2 步必须替用户查出来。
rem    * **不要假设日志一定在 %LOGDIR%** —— 桌宠往"自己的当前目录\runtime\
rem      pet.out.log"写，某些调用方式下工作目录会变成 v1\，日志就落到
rem      v1\runtime\。v1.1 第一版因此让自检段 [2]~[5] 全空（用户实测抓到），
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

rem %~dp0 末尾自带反斜杠
set "ROOT=%~dp0"
set "PETDIR=%ROOT%v1"
if not exist "%PETDIR%\presage-pet.exe" set "PETDIR=%ROOT%"
set "PET=%PETDIR%\presage-pet.exe"
set "V1RUNTIME=%ROOT%v1\runtime"

rem ---------------------------------------------------------------------------
rem  1. 自定位校验 + 文件齐全性
rem ---------------------------------------------------------------------------
if not exist "%PET%" (
  echo [x] 找不到 presage-pet.exe
  echo     脚本所在目录 : %ROOT%
  echo     期望 exe     : %PET%
  echo     当前目录     : %CD%
  echo     如果"期望 exe"看起来不像本文件旁边的路径，说明 %%~dp0 没解析对：
  echo     请改为**双击**本文件，或先 cd 到它所在目录再执行。
  echo     另外请确认交付包完整（presage-pet.exe / WebView2Loader.dll / 启动桌宠.bat）。
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
rem 桥接的 stdout/stderr **必须重定向到文件**：
rem   1) 否则它写到启动器那个控制台，控制台一关，node 写 stdout 失败就可能退出
rem      （用户实测：桥接死了，而桌宠那边只表现为"一直不进入 working、零事件"）；
rem   2) 出问题时我们才有东西可看 —— v1.1 之前它写控制台，日志里只有
rem      上一次留下的 9MB 刷屏，根本查不出它为什么死。
rem 启动后再用 /health 确认一次，把结论写进日志，而不是靠 netstat 猜。
set "BLOG=%LOGDIR%\bridge.log"
netstat -ano | findstr /r /c:"127.0.0.1:8792 .*LISTENING" > nul
if not errorlevel 1 (
  echo [i] 桥接已在运行
  goto after_bridge
)
echo [i] 启动桥接（余额 / 台词库）...
rem 先清掉上一轮的日志，避免新旧混在一起
del /q "%BLOG%" >nul 2>nul
rem 用 PowerShell 的 -WindowStyle Hidden 启动：**没有控制台窗口**，输出进日志。
rem 之前用 `start /min cmd /c node …` 会留下一个最小化的 presage-bridge 控制台 ——
rem 用户实测反馈"多了一个进程窗口，关掉自检窗口后它还在"。改成隐藏启动。
rem 注意：-PassThru 拿到的是 powershell 自己的 PID、不是 node 的，所以**桥接 PID 由
rem 桥接自己写**进 --pidfile（见 pet_bridge.mjs）；桌宠退出时按它精确收尾。
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%NODE%' -ArgumentList @('%BRIDGE%','--out','%LOGDIR%\events','--port','8792','--pidfile','%LOGDIR%\bridge.pid') -WorkingDirectory '%PETDIR%' -WindowStyle Hidden -RedirectStandardOutput '%BLOG%' -RedirectStandardError '%LOGDIR%\bridge.err.log'" >nul 2>nul
ping -n 4 127.0.0.1 > nul
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $r = Invoke-WebRequest 'http://127.0.0.1:8792/health' -UseBasicParsing -TimeoutSec 4; $j = $r.Content | ConvertFrom-Json; Write-Host ('[i] 桥接就绪 ok=' + $j.ok + ' DSH 会话=' + $j.dsh.sessions + ' 已产事件=' + $j.produced) } catch { Write-Host '[x] 桥接没有起来（/health 无响应）—— 详见 runtime\bridge.log' }" 2>nul
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
echo [4b] 设置窗口 / 桥接（第一现场；**这是自检那一刻的快照** —— 若你在自检之后才开设置，空着是正常的）:
findstr /c:"[settings]" "%GBK%" 2>nul
findstr /c:"[跳过" /c:"ERR_MODULE_NOT_FOUND" "%LOGDIR%\bridge.log" 2>nul
echo.
echo [5] pet.err.log 末尾（(空) 或没有输出 = 正常）:
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
