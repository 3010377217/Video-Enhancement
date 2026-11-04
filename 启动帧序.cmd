@echo off
setlocal
set "APP_DIR=%~dp0desktop-release"
if exist "%APP_DIR%\FrameSequence-0.2.0-Windows.exe" (
  start "" /D "%APP_DIR%" "%APP_DIR%\FrameSequence-0.2.0-Windows.exe"
  exit /b 0
)
if exist "%APP_DIR%\win-unpacked\FrameSequence.exe" (
  start "" /D "%APP_DIR%\win-unpacked" "%APP_DIR%\win-unpacked\FrameSequence.exe"
  exit /b 0
)
echo Desktop build not found.
echo Run npm run desktop:portable from the frontend directory first.
pause
