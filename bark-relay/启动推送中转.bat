@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
rem 启动 LIS Bark 推送中转（前台运行，Ctrl+C 停止）
rem 若想登录自启，请用「安装开机自启.bat」建计划任务；手动前台运行无需保持窗口

set "PY1=%LocalAppData%\Programs\Python\Python312\python.exe"
set "PY2=%LocalAppData%\Programs\Python\Python311\python.exe"
set "PY3=%LocalAppData%\Programs\Python\Python310\python.exe"
set "PY="
if exist "%PY1%" set "PY=%PY1%"
if not defined PY if exist "%PY2%" set "PY=%PY2%"
if not defined PY if exist "%PY3%" set "PY=%PY3%"
if not defined PY set "PY=python"

echo ================================================
echo   LIS Bark relay
echo   config: %~dp0notify_config.json  (fill bark_key)
echo   run :   "%PY%" bark_relay.py
echo   stop:   Ctrl+C
echo ================================================
"%PY%" bark_relay.py
pause
