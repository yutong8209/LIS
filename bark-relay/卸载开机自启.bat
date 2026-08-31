@echo off
chcp 65001 >nul
rem 卸载 LIS Bark 推送中转计划任务并停止进程
set "TASK=LIS-BarkRelay"
schtasks /End /TN "%TASK%" 2>nul
schtasks /Delete /F /TN "%TASK%"
echo 已删除计划任务 %TASK%
rem 8.10.0: 不再 taskkill 所有 pythonw.exe（会误杀其它 python 程序）。
rem 仅当端口 8766 仍被监听时，按 PID 精确结束残留的 relay 进程。
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8766 " ^| findstr "LISTENING"') do taskkill /F /PID %%p >nul 2>&1
echo （如仍有残留进程，可在任务管理器按端口 8766 找到并结束）
pause
