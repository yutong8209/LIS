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

rem 最小化窗口后台运行 serve.py，输出重定向到 serve.log（覆盖旧日志）
start "LIS-serve" /min cmd /c "%PY% serve.py > serve.log 2>&1"

rem 等 2 秒把启动横幅落进日志，回显给用户（若 Python 是商店假占位符，
rem 这里会直接看到 "Python was not found..." 一类报错）
timeout /t 2 >nul
echo --- serve.log 开头 ---
type serve.log
echo -----------------------
echo.
echo 已尝试后台启动。验证：浏览器打开 http://localhost:8765/iMedicalLIS-enhancer.user.js
echo 能看到脚本源码即为成功；停止请双击 stop_serve.bat。
echo.
pause
