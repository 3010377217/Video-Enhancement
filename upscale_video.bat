@echo off
rem ============================================
rem  Anime video upscaler (Real-ESRGAN + FFmpeg)
rem  Usage:  upscale_video.bat <input_video> [scale]
rem  Example: upscale_video.bat "D:\video\anime.mp4" 2
rem  scale defaults to 2 if omitted
rem ============================================

set "SRC=%~1"
set "SCALE=%~2"
if "%SCALE%"=="" set "SCALE=2"
if "%SRC%"=="" (
    echo Usage: upscale_video.bat ^<input_video^> [scale]
    exit /b 1
)

set "BASENAME=%~n1"
set "SRCDIR=%~dp1"
set "WORK=%~dp0_work_%BASENAME%"
set "OUTDIR=%~dp0_upscaled_%BASENAME%"
set "EXE=%~dp0realesrgan-ncnn-vulkan.exe"
set "FMT=jpg"

echo [1/4] Reading frame rate...
ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "%SRC%" > "%~dp0_fps.txt"
set /p FPS=<"%~dp0_fps.txt"
del "%~dp0_fps.txt"
echo     FPS: %FPS%
if "%FPS%"=="" (
    echo     Failed to read frame rate. Check the input file.
    goto :fail
)

echo [2/4] Extracting frames...
mkdir "%WORK%\frames" 2>nul
ffmpeg -y -i "%SRC%" -qscale:v 2 "%WORK%\frames\frame_%%08d.%FMT%" >nul 2>&1
if errorlevel 1 goto :fail

echo [3/4] Real-ESRGAN upscaling x%SCALE%...
mkdir "%OUTDIR%" 2>nul
"%EXE%" -i "%WORK%\frames" -o "%OUTDIR%" -n realesr-animevideov3 -s %SCALE% -f %FMT%
if errorlevel 1 goto :fail

echo [4/4] Reassembling video + audio...
ffmpeg -y -framerate %FPS% -i "%OUTDIR%\frame_%%08d.%FMT%" -i "%SRC%" -map 0:v -map 1:a? -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a copy "%SRCDIR%%BASENAME%_x%SCALE%.mp4"
if errorlevel 1 goto :fail

rd /s /q "%WORK%"
rd /s /q "%OUTDIR%"
echo.
echo Done! Output: %SRCDIR%%BASENAME%_x%SCALE%.mp4
pause
exit /b 0

:fail
echo.
echo Error! Please check the messages above.
pause
exit /b 1
