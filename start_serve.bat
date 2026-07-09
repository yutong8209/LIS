@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo =========================================
echo   iMedicalLIS 脚本服务器（含质控依赖）
echo =========================================
echo   地址:     http://localhost:8765/
echo   脚本:     http://localhost:8765/iMedicalLIS-enhancer.user.js
echo   SheetJS:  http://localhost:8765/vendor/xlsx.full.min.js
echo.
echo   用途: Tampermonkey 更新脚本 + 质控导出 Excel
echo   关闭本窗口即停止服务
echo =========================================
echo.

where python >nul 2>&1
if %errorlevel%==0 (
  python serve.py
  goto :end
)

where python3 >nul 2>&1
if %errorlevel%==0 (
  python3 serve.py
  goto :end
)

where py >nul 2>&1
if %errorlevel%==0 (
  py -3 serve.py
  goto :end
)

echo [错误] 未找到 Python。
echo 请先安装 Python 3: https://www.python.org/downloads/
echo 安装时勾选 "Add python.exe to PATH"
echo.
pause
exit /b 1

:end
echo.
pause
