@echo off
echo =========================================
echo   停止本机 8765 端口上的 serve.py
echo =========================================
echo.

set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8765" ^| findstr "LISTENING"') do (
  set FOUND=1
  echo 结束进程 PID %%p ...
  taskkill /f /pid %%p >nul 2>&1 && (echo   已停止。) || (echo   停止失败，可能需要管理员权限运行。)
)

if %FOUND%==0 (
  echo 8765 端口没有监听进程 —— serve.py 本来就没在运行。
)

echo.
echo 完成。验证：浏览器打开 http://localhost:8765/ 应无法连接。
echo.
pause
