@echo off
chcp 65001 >nul
rem 安装 LIS Bark 推送中转为计划任务（登录自启）并立即启动
rem 卸载：双击「卸载开机自启.bat」
cd /d "%~dp0"
set "TASK=LIS-BarkRelay"
set "PYW=%LocalAppData%\Programs\Python\Python312\pythonw.exe"
if not exist "%PYW%" (
  echo [!] 未找到 pythonw.exe（%PYW%），改用 PATH 中的 pythonw
  set "PYW=pythonw.exe"
)
echo == 安装计划任务 %TASK%（登录自启）==
schtasks /Create /F /TN "%TASK%" /SC ONLOGON /TR "\"%PYW%\" \"%~dp0bark_relay.py\""
if errorlevel 1 (
  echo [!] 计划任务创建失败，请右键「以管理员身份运行」本脚本重试
  pause
  exit /b 1
)
echo == 立即启动 ==
schtasks /Run /TN "%TASK%"
timeout /t 2 /nobreak >nul
echo == 自检（应输出含 "configured" 的 JSON）==
curl -s -m 4 http://127.0.0.1:8766/healthz
echo.
echo 完成。userscript 会经 nginx http://192.168.31.111:9111/notify 使用本服务。
pause
