@echo off
rem ============================================
rem  Video Enhancement 工具箱 - Web 界面启动器
rem  启动后浏览器自动打开，仅本机可访问
rem ============================================
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 python，请先安装 Python 3.10+ 并勾选 Add to PATH。
    pause
    exit /b 1
)

if not exist "%~dp0vue.global.prod.js" (
    echo [提示] 未找到 vue.global.prod.js，正在尝试下载...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'https://unpkg.com/vue@3.5.13/dist/vue.global.prod.js' -OutFile '%~dp0vue.global.prod.js' -TimeoutSec 60; Write-Host '下载完成' } catch { Write-Host ('下载失败: ' + $_.Exception.Message) }"
    if not exist "%~dp0vue.global.prod.js" (
        echo [错误] vue.global.prod.js 下载失败，请手动下载后放到本目录：
        echo        https://unpkg.com/vue@3.5.13/dist/vue.global.prod.js
        pause
        exit /b 1
    )
)

python webui.py
if errorlevel 1 (
    echo.
    echo [错误] webui.py 运行失败，请查看上面的报错信息。
    pause
)
