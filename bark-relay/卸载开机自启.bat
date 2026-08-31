@echo off
setlocal
rem 卸载计划任务并停止 relay 进程（按端口 8766 精确结束，不误杀其它 python）
set "TASK=LIS-BarkRelay"
%SystemRoot%\System32\schtasks.exe /Delete /F /TN "%TASK%" 2>nul
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8766 " ^| findstr "LISTENING"') do taskkill /F /PID %%p >nul 2>&1
echo == 已删除计划任务 %TASK%，端口 8766 残留进程已尝试结束 ==
pause
