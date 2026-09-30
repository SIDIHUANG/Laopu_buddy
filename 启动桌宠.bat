@echo off
rem ============================================================
rem  根目录的入口：转发到交付包里的启动器
rem
rem  为什么只做转发：桌宠的成品在 v1\ 里（release exe + WebView2Loader.dll
rem  + 启动器）。这里再维护一份逻辑只会两边不一致 ——
rem  实测就发生过：v1\ 里的启动器修好了 timeout/编码两个 bug，
rem  根目录这份还是旧的。
rem
rem  想改启动逻辑请改 v1\启动桌宠.bat（那是唯一实现）。
rem ============================================================
cd /d "%~dp0"
if not exist "v1\启动桌宠.bat" (
  echo [x] 找不到 v1\启动桌宠.bat
  echo     请确认交付包 v1\ 完整（presage-pet.exe / WebView2Loader.dll / 启动桌宠.bat）
  pause
  exit /b 1
)
call "v1\启动桌宠.bat"