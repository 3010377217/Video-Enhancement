@echo off
rem ============================================
rem  Anime video frame interpolator to 120hz
rem  Chunked 2x pass on an already-60hz video:
rem  60hz -> 120hz. Keeps disk usage low,
rem  independent of video length.
rem
rem  Usage:  interp120_video.bat <input_60hz_video>
rem  Example: interp120_video.bat "D:\video\anime_60hz.mp4"
rem ============================================

set "SRC=%~1"
if "%SRC%"=="" (
    echo Usage: interp120_video.bat ^<input_60hz_video^>
    exit /b 1
)

set "BASENAME=%~n1"
rem strip a trailing _60hz so the output is <name>_120hz.mp4
if "%BASENAME:~-5%"=="_60hz" set "BASENAME=%BASENAME:~0,-5%"
set "SRCDIR=%~dp1"
set "APPDIR=%~dp0"
set "APPDIR_FS=%APPDIR:\=/%"
set "RIFE=%APPDIR%rife-ncnn-vulkan-20221029-windows\rife-ncnn-vulkan.exe"
set "RIFEMODEL=%APPDIR%rife-ncnn-vulkan-20221029-windows\rife-v4.6"
set "WORK=%APPDIR%_rife_work_%BASENAME%"
set "FMT=jpg"
rem frames per chunk - lower it if disk space is tight
set "CHUNK=1000"
set "SEGLIST=%APPDIR%_segs_%BASENAME%.txt"
set "OUT=%SRCDIR%%BASENAME%_120hz.mp4"

del "%APPDIR%_fps.txt" 2>nul
del "%APPDIR%_t.txt" 2>nul
del "%SEGLIST%" 2>nul
del "%APPDIR%_seg_*.mp4" 2>nul
del "%APPDIR%_concat_%BASENAME%.mp4" 2>nul
del "%APPDIR%_audio_%BASENAME%.m4a" 2>nul
rd /s /q "%WORK%" 2>nul

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
set /a FN2=%FN%*2
echo     Interpolating 2x to %FN2%/%FD% fps, writing 120hz.

set "CHUNK_N=1"
echo [2/4] Interpolating in chunks of %CHUNK% frames...
if exist "%SEGLIST%" del "%SEGLIST%"

:loop
set /a START_IDX=(%CHUNK_N%-1)*%CHUNK%

rem start time (seconds) = (START_IDX + 0.5) / (FN/FD)
powershell -NoProfile -Command "$s=%START_IDX%+0.5; $d=[double]%FD%/%FN%; [Console]::WriteLine(([double]$s*$d).ToString('0.000000',[System.Globalization.CultureInfo]::InvariantCulture))" > "%APPDIR%_t.txt"
set /p STIME=<"%APPDIR%_t.txt"

rem extract this chunk's frames
mkdir "%WORK%\in" 2>nul
ffmpeg -y -ss %STIME% -i "%SRC%" -frames:v %CHUNK% -qscale:v 2 "%WORK%\in\f_%%08d.%FMT%" >nul 2>&1
if errorlevel 1 goto :fail

rem count extracted frames
set "CNT=0"
for /f %%c in ('dir /b "%WORK%\in" 2^>nul ^| "%SystemRoot%\System32\find.exe" /c /v ""') do set "CNT=%%c"
if "%CNT%"=="0" goto :done

echo     chunk %CHUNK_N%: %CNT% frames @ %STIME%s

rem interpolate this chunk (2x frame count)
mkdir "%WORK%\out" 2>nul
"%RIFE%" -i "%WORK%\in" -o "%WORK%\out" -m "%RIFEMODEL%" -j 5:8:5 -f "%%08d.%FMT%"
if errorlevel 1 goto :fail

rem encode this chunk into a segment at 2x fps
ffmpeg -y -start_number 1 -framerate %FN2%/%FD% -i "%WORK%\out\%%08d.%FMT%" -c:v libx264 -crf 18 -pix_fmt yuv420p "%APPDIR%_seg_%CHUNK_N%.mp4" >nul 2>&1
if errorlevel 1 goto :fail
echo file '%APPDIR_FS%_seg_%CHUNK_N%.mp4'>> "%SEGLIST%"

rem free this chunk's frames right away
rd /s /q "%WORK%"

set /a CHUNK_N+=1
goto :loop

:done
set /a LAST=%CHUNK_N%-1
echo [3/4] Concatenating %LAST% segments + audio...
ffmpeg -y -f concat -safe 0 -i "%SEGLIST%" -c:v copy "%APPDIR%_concat_%BASENAME%.mp4"
if errorlevel 1 goto :fail

rem extract audio once
ffmpeg -y -i "%SRC%" -vn -acodec copy "%APPDIR%_audio_%BASENAME%.m4a" >nul 2>&1

rem 120hz: copy concatenated video, add audio
ffmpeg -y -i "%APPDIR%_concat_%BASENAME%.mp4" -i "%APPDIR%_audio_%BASENAME%.m4a" -map 0:v -map 1:a -c:v copy -c:a copy -shortest "%OUT%"
if errorlevel 1 goto :fail

rem cleanup
del "%SEGLIST%" 2>nul
for /l %%s in (1,1,%LAST%) do del "%APPDIR%_seg_%%s.mp4" 2>nul
del "%APPDIR%_t.txt" 2>nul
del "%APPDIR%_concat_%BASENAME%.mp4" 2>nul
del "%APPDIR%_audio_%BASENAME%.m4a" 2>nul
rd /s /q "%WORK%" 2>nul
echo.
echo Done! Output: %OUT%
pause
exit /b 0

:fail
echo.
echo Error! Please check the messages above.
rd /s /q "%WORK%" 2>nul
del "%SEGLIST%" 2>nul
pause
exit /b 1
