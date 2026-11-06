@echo off
setlocal
set "APP_DIR=%~dp0desktop-release"
rem Launch the highest-numbered portable build (sorted by file name, newest first).
for /f "delims=" %%F in ('dir /b /o-n "%APP_DIR%\FrameSequence-*-Windows.exe" 2^>nul') do (
  start "" /D "%APP_DIR%" "%APP_DIR%\%%F"
  exit /b 0
)
if exist "%APP_DIR%\win-unpacked\FrameSequence.exe" (
  start "" /D "%APP_DIR%\win-unpacked" "%APP_DIR%\win-unpacked\FrameSequence.exe"
  exit /b 0
)
echo Desktop build not found.
echo Run npm run desktop:portable from the frontend directory first.
pause
