@echo off
cd /d "%~dp0"

echo =========================================
echo   iMedicalLIS 脚本服务器 —— 后台启动
echo =========================================
echo   窗口最小化到任务栏（标题 LIS-serve），日志写入 serve.log
echo   停止：双击 stop_serve.bat，或直接关掉那个最小化窗口
echo =========================================
echo.

set PY=
where python >nul 2>&1 && set PY=python
if not defined PY (where python3 >nul 2>&1 && set PY=python3)
if not defined PY (where py >nul 2>&1 && set PY=py -3)
if not defined PY (
  echo [错误] 未找到 Python。
  echo 请先安装 Python 3: https://www.python.org/downloads/
  echo 安装时勾选 "Add python.exe to PATH"
  echo.
  pause
  exit /b 1
)

rem PYTHONUNBUFFERED=1：Python 输出重定向到文件时默认块缓冲，启动横幅会长期压在
rem 缓冲区里不落盘，serve.log 看起来是"空的"（实际服务可能正在正常运行）。
rem 设为无缓冲后日志实时可见，报错也当场可读。
set PYTHONUNBUFFERED=1

start "LIS-serve" /min cmd /c "%PY% serve.py > serve.log 2>&1"

timeout /t 2 >nul
echo --- 运行状态自检 ---
netstat -ano | findstr ":8765" | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo [OK] 8765 端口监听中，serve.py 已在后台运行。
) else (
  echo [未监听] serve 未就绪或启动失败，见下方日志。
)
echo.
echo --- serve.log ---
type serve.log 2>nul
echo -------------------
echo.
echo 验证：浏览器（建议无痕窗口）打开 http://localhost:8765/iMedicalLIS-enhancer.user.js
echo 停止请双击 stop_serve.bat。
echo.
pause
