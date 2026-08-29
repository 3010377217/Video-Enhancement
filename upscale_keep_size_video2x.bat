@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem =========================================================
rem  Video2X / Real-CUGAN: 2x upscale, then resize to source
rem
rem  Usage: upscale_keep_size_video2x.bat <input_video> [noise_level]
rem  Example: upscale_keep_size_video2x.bat "D:\videos\anime.mp4" 0
rem =========================================================

set "SRC=%~f1"
set "NOISE=%~2"
if "%NOISE%"=="" set "NOISE=0"

if "%SRC%"=="" (
    echo Usage: %~nx0 ^<input_video^> [noise_level]
    echo noise_level: 0, 1, 2, or 3. Default: 0.
    exit /b 1
)
if not exist "%SRC%" (
    echo Input file not found: %SRC%
    exit /b 1
)

set "NOISE_OK="
for %%N in (0 1 2 3) do if "%NOISE%"=="%%N" set "NOISE_OK=1"
if not defined NOISE_OK (
    echo Invalid noise level: %NOISE%
    echo Choose one of: 0, 1, 2, 3.
    exit /b 1
)

set "APPDIR=%~dp0"
set "VIDEO2X=%APPDIR%video2x\video2x.exe"
set "BASENAME=%~n1"
set "SRCDIR=%~dp1"
set "WORK=%APPDIR%_cugan_keep_%BASENAME%"
set "UPSCALED=%WORK%\upscaled.mkv"

if not exist "%VIDEO2X%" (
    echo Video2X was not found: %VIDEO2X%
    echo Install the Windows package into the project's video2x folder first.
    exit /b 1
)
where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo ffmpeg was not found in PATH.
    exit /b 1
)
where ffprobe >nul 2>&1
if errorlevel 1 (
    echo ffprobe was not found in PATH.
    exit /b 1
)
if exist "%WORK%" (
    echo Temporary directory already exists: %WORK%
    echo Wait for the previous job to finish, or remove that directory before retrying.
    exit /b 1
)

for /f "tokens=1,2 delims=x" %%A in ('ffprobe -v error -select_streams v:0 -show_entries stream^=width^,height -of csv^=p^=0:s^=x "%SRC%"') do (
    set "WIDTH=%%A"
    set "HEIGHT=%%B"
)
if "%WIDTH%"=="" goto :probe_fail
if "%HEIGHT%"=="" goto :probe_fail
for /f "delims=" %%A in ('ffprobe -v error -select_streams v:0 -count_frames -show_entries stream^=nb_read_frames -of csv^=p^=0 "%SRC%"') do set "SRC_FRAMES=%%A"

set "OUTFILE=%SRCDIR%%BASENAME%_cugan2x_keep_%WIDTH%x%HEIGHT%.mp4"
mkdir "%WORK%"

echo.
echo Source : %SRC%
echo Size   : %WIDTH%x%HEIGHT%
echo Model  : Real-CUGAN models-se, 2x, noise %NOISE%
echo Output : %OUTFILE%
echo.
echo [1/2] Video2X Real-CUGAN 2x upscale...
"%VIDEO2X%" -i "%SRC%" -o "%UPSCALED%" -p realcugan -s 2 --noise-level=%NOISE% --realcugan-model models-se -c libx264 -e crf=18
set "VIDEO2X_RC=%ERRORLEVEL%"
if not exist "%UPSCALED%" goto :stage1_fail
ffprobe -v error -select_streams v:0 -show_entries stream^=width -of csv^=p^=0 "%UPSCALED%" >nul 2>&1
if not "%ERRORLEVEL%"=="0" goto :stage1_fail
if not "%VIDEO2X_RC%"=="0" echo Warning: Video2X returned exit %VIDEO2X_RC%, but the intermediate video is readable. Continuing.
for /f "delims=" %%A in ('ffprobe -v error -select_streams v:0 -count_frames -show_entries stream^=nb_read_frames -of csv^=p^=0 "%UPSCALED%"') do set "UPSCALED_FRAMES=%%A"
set "PAD_FRAMES=0"
if defined SRC_FRAMES if defined UPSCALED_FRAMES call :compute_pad
set "VIDEO_FILTER=scale=%WIDTH%:%HEIGHT%:flags=lanczos"
if not "%PAD_FRAMES%"=="0" set "VIDEO_FILTER=tpad=stop_mode=clone:stop=%PAD_FRAMES%,scale=%WIDTH%:%HEIGHT%:flags=lanczos"
set "FRAME_LIMIT="
if defined SRC_FRAMES set "FRAME_LIMIT=-frames:v %SRC_FRAMES%"

echo [2/2] Resize to original dimensions with Lanczos...
echo Intermediate frames: %UPSCALED_FRAMES%; source frames: %SRC_FRAMES%; padding: %PAD_FRAMES%
ffmpeg -y -i "%UPSCALED%" -map 0:v:0 -map 0:a? -map_metadata 0 -vf "%VIDEO_FILTER%" %FRAME_LIMIT% -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a copy -movflags +faststart "%OUTFILE%"
if not "%ERRORLEVEL%"=="0" goto :fail
if not exist "%OUTFILE%" goto :stage2_fail

rd /s /q "%WORK%"
echo.
echo Done! Output: %OUTFILE%
pause
exit /b 0

:probe_fail
echo Failed to read the source video dimensions.
exit /b 1

:stage1_fail
echo Video2X did not create the 2x intermediate video.
goto :fail

:stage2_fail
echo FFmpeg did not create the final video.
goto :fail

:fail
echo.
echo Processing failed. The temporary file was kept here for diagnosis:
echo %WORK%
pause
exit /b 1

:compute_pad
set /a PAD_FRAMES=SRC_FRAMES-UPSCALED_FRAMES
if %PAD_FRAMES% LSS 0 set "PAD_FRAMES=0"
exit /b 0
