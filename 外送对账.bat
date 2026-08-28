@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ==========================================
echo   外送少收分析
echo ==========================================
echo   · 机构汇总表 = 固定基准
echo   · LIS 导出日期建议比机构单更宽
echo   · 只统计：机构有、医院没有 → 可能少收
echo   · 不统计：医院有、机构没有
echo   · 弹窗请 Ctrl 多选：机构 .xlsx + LIS .csv
echo ==========================================
echo.

set "PY="
where python >nul 2>&1 && set "PY=python"
if not defined PY (
  where py >nul 2>&1 && set "PY=py -3"
)
if not defined PY (
  where python3 >nul 2>&1 && set "PY=python3"
)

if not defined PY (
  echo [错误] 未找到 Python 3。
  echo 请安装: https://www.python.org/downloads/
  echo 安装时勾选 "Add python.exe to PATH"
  echo.
  pause
  exit /b 1
)

echo 使用: %PY%
echo.

REM 检查依赖
%PY% -c "import pandas, openpyxl" 2>nul
if errorlevel 1 (
  echo 正在安装依赖 pandas openpyxl ...
  %PY% -m pip install --user pandas openpyxl
  if errorlevel 1 (
    echo 安装失败，请手动执行:
    echo   %PY% -m pip install pandas openpyxl
    echo.
    pause
    exit /b 1
  )
)

REM 默认少收模式（不要加 --双向）
%PY% "%~dp0外送对账.py"
set RC=%errorlevel%

echo.
if !RC! equ 0 (
  echo 完成。结果一般为「外送少收分析_时间戳.xlsx」
  echo 默认在「下载」文件夹或你刚才选择的路径。
  echo.
  set "LATEST="
  for /f "delims=" %%F in ('dir /b /o-d "%USERPROFILE%\Downloads\外送少收分析*.xlsx" 2^>nul') do (
    if not defined LATEST set "LATEST=%USERPROFILE%\Downloads\%%F"
  )
  if defined LATEST (
    if exist "!LATEST!" (
      echo 打开: !LATEST!
      start "" "!LATEST!"
    )
  )
) else (
  echo 未完成（退出码 !RC!）。若取消了选文件会如此；请重新双击再选。
)

echo.
pause
exit /b !RC!
