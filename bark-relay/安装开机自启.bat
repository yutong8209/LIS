@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
rem 安装 LIS Bark 推送中转为计划任务（登录自启）并立即启动
rem 卸载：双击「卸载开机自启.bat」

set "TASK=LIS-BarkRelay"
set "PYW1=%LocalAppData%\Programs\Python\Python312\pythonw.exe"
set "PYW2=%LocalAppData%\Programs\Python\Python311\pythonw.exe"
set "PYW3=%LocalAppData%\Programs\Python\Python310\pythonw.exe"
set "PYW="
if exist "%PYW1%" set "PYW=%PYW1%"
if not defined PYW if exist "%PYW2%" set "PYW=%PYW2%"
if not defined PYW if exist "%PYW3%" set "PYW=%PYW3%"
if not defined PYW set "PYW=pythonw.exe"

echo == 安装计划任务 %TASK%（登录自启）==
schtasks /Create /F /TN "%TASK%" /SC ONLOGON /TR "\"%PYW%\" \"%~dp0bark_relay.py\""
if errorlevel 1 (
  echo [x] 创建失败。ONLOGON 用户任务一般无需管理员，若仍失败请右键「以管理员身份运行」重试
  pause
  exit /b 1
)
echo == 立即启动 ==
schtasks /Run /TN "%TASK%"
timeout /t 2 /nobreak >nul
echo == 自检（应输出含 "configured" 的 JSON）==
curl -s -m 4 http://127.0.0.1:8766/healthz
echo.
pause
