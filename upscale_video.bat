@echo off
rem ============================================
rem  Anime video upscaler (Real-ESRGAN + FFmpeg)
rem  Chunked mode: processes the video in small
rem  batches so disk usage stays low (only one
rem  batch of frames is on disk at a time).
rem
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
set "APPDIR=%~dp0"
set "APPDIR_FS=%APPDIR:\=/%"
set "WORK=%APPDIR%_work_%BASENAME%"
set "EXE=%APPDIR%realesrgan-ncnn-vulkan.exe"
set "FMT=jpg"
set "MODEL=realesr-animevideov3"
rem frames per chunk - lower it if disk space is tight
set "CHUNK=1500"
set "SEGLIST=%APPDIR%_segs_%BASENAME%.txt"
set "OUTFILE=%SRCDIR%%BASENAME%_x%SCALE%.mp4"

del "%APPDIR%_fps.txt" 2>nul
del "%APPDIR%_t.txt" 2>nul
del "%APPDIR%_seg_*.mp4" 2>nul

echo [1/4] Reading frame rate...
ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "%SRC%" > "%APPDIR%_fps.txt"
set /p FPS=<"%APPDIR%_fps.txt"
del "%APPDIR%_fps.txt"
echo     FPS: %FPS%
if "%FPS%"=="" (
    echo     Failed to read frame rate. Check the input file.
    goto :fail
)

rem split "num/den" into FN/FD (plain integers are handled too)
for /f "tokens=1,2 delims=/" %%a in ("%FPS%") do (
    set "FN=%%a"
    set "FD=%%b"
)
if "%FD%"=="" set "FD=1"

set "CHUNK_N=1"
echo [2/4] Processing in chunks of %CHUNK% frames...
if exist "%SEGLIST%" del "%SEGLIST%"

:loop
set /a START_IDX=(%CHUNK_N%-1)*%CHUNK%

rem start time (seconds) = START_IDX / (FN/FD), floating point
powershell -NoProfile -Command "$s=%START_IDX%; $d=[double]%FD%/%FN%; [Console]::WriteLine(([double]$s*$d).ToString('0.000000',[System.Globalization.CultureInfo]::InvariantCulture))" > "%APPDIR%_t.txt"
set /p STIME=<"%APPDIR%_t.txt"

rem extract this chunk's frames
mkdir "%WORK%\frames" 2>nul
ffmpeg -y -ss %STIME% -i "%SRC%" -frames:v %CHUNK% -qscale:v 2 "%WORK%\frames\frame_%%08d.%FMT%" >nul 2>&1
if errorlevel 1 goto :fail

rem count extracted frames
set "CNT=0"
for /f %%c in ('dir /b "%WORK%\frames" 2^>nul ^| "%SystemRoot%\System32\find.exe" /c /v ""') do set "CNT=%%c"
if "%CNT%"=="0" goto :done

echo     chunk %CHUNK_N%: %CNT% frames @ %STIME%s

rem upscale this chunk
mkdir "%WORK%\up" 2>nul
"%EXE%" -i "%WORK%\frames" -o "%WORK%\up" -n %MODEL% -s %SCALE% -f %FMT%
if errorlevel 1 goto :fail

rem encode this chunk into a segment
ffmpeg -y -framerate %FPS% -i "%WORK%\up\frame_%%08d.%FMT%" -c:v libx264 -crf 18 -pix_fmt yuv420p "%APPDIR%_seg_%CHUNK_N%.mp4" >nul 2>&1
if errorlevel 1 goto :fail
echo file '%APPDIR_FS%_seg_%CHUNK_N%.mp4'>> "%SEGLIST%"

rem free this chunk's frames right away
rd /s /q "%WORK%"

set /a CHUNK_N+=1
goto :loop

:done
set /a LAST=%CHUNK_N%-1
echo [3/4] Concatenating %LAST% segments + audio...
ffmpeg -y -f concat -safe 0 -i "%SEGLIST%" -i "%SRC%" -map 0:v -map 1:a? -c:v copy -c:a aac -b:a 160k -shortest "%OUTFILE%"
if errorlevel 1 goto :fail

rem cleanup
del "%SEGLIST%" 2>nul
for /l %%s in (1,1,%LAST%) do del "%APPDIR%_seg_%%s.mp4" 2>nul
del "%APPDIR%_t.txt" 2>nul
rd /s /q "%WORK%" 2>nul
echo.
echo Done! Output: %OUTFILE%
pause
exit /b 0

:fail
echo.
echo Error! Please check the messages above.
rd /s /q "%WORK%" 2>nul
del "%SEGLIST%" 2>nul
pause
exit /b 1
