@echo off
chcp 65001 >nul
rem 启动 LIS Bark 推送中转（前台窗口，测试/排障用，关窗即停）
rem 正式使用请双击「安装开机自启.bat」装成计划任务，无需保持窗口
cd /d "%~dp0"
set "PY=%LocalAppData%\Programs\Python\Python312\python.exe"
if not exist "%PY%" set "PY=python"
echo == LIS Bark 推送中转（前台模式，关窗即停）==
echo 配置文件: %~dp0notify_config.json  （含 bark_key，请勿放进 nginx 网络目录）
"%PY%" bark_relay.py
pause
