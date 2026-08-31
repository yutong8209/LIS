@echo off
chcp 65001 >nul
rem 卸载 LIS Bark 推送中转计划任务并停止进程
set "TASK=LIS-BarkRelay"
schtasks /End /TN "%TASK%" 2>nul
schtasks /Delete /F /TN "%TASK%"
echo 已删除计划任务 %TASK%
taskkill /F /FI "IMAGENAME eq pythonw.exe" /FI "WINDOWTITLE eq *" >nul 2>&1
echo （如仍有残留进程，可在任务管理器结束 pythonw.exe）
pause
