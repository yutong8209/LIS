@echo off
chcp 936 >nul
title 启用 LIS 工作台一键唤醒原生 IE 病历
echo ============================================================
echo   正在为当前电脑配置【工作台一键唤醒原生 32 位 IE 病历】...
echo ============================================================
echo.

set "TARGET_DIR=%LOCALAPPDATA%\LIS-Tools"
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
set "VBS_PATH=%TARGET_DIR%\launch_ie.vbs"

:: 写入纯净 VBS 启动脚本
(
echo ' iMedical LIS - Native 32-bit IE Launcher
echo Dim ie, url
echo If WScript.Arguments.Count ^> 0 Then
echo     url = WScript.Arguments^(0^)
echo Else
echo     url = "http://192.168.31.111:9111/iMedicalLIS/login/form/Index.aspx"
echo End If
echo If InStr^(LCase^(url^), "lis-ie://"^) = 1 Then
echo     url = Mid^(url, 10^)
echo ElseIf InStr^(LCase^(url^), "lis-ie:"^) = 1 Then
echo     url = Mid^(url, 8^)
echo End If
echo url = Replace^(url, Chr^(34^), ""^)
echo On Error Resume Next
echo Set ie = CreateObject^("InternetExplorer.Application"^)
echo If Err.Number ^<^> 0 Then
echo     MsgBox "Failed to launch native IE: " ^& Err.Description, 16, "Error"
echo     WScript.Quit
echo End If
echo ie.Visible = True
echo ie.Navigate url
) > "%VBS_PATH%"

:: 注册 lis-ie:// 协议（仅注册当前用户 HKCU，免管理员权限，不弹 UAC 警告）
reg add "HKCU\Software\Classes\lis-ie" /ve /d "URL:LIS Native IE Launcher Protocol" /f >nul
reg add "HKCU\Software\Classes\lis-ie" /v "URL Protocol" /d "" /f >nul
powershell -NoProfile -Command "Set-ItemProperty -Path 'HKCU:\Software\Classes\lis-ie\shell\open\command' -Name '(Default)' -Value ('wscript.exe "' + $env:LOCALAPPDATA + '\LIS-Tools\launch_ie.vbs" "%1"')" >nul

:: 在桌面创建快捷方式（方便直接双击使用）
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\启动病历-原生IE.lnk'); $s.TargetPath = 'wscript.exe'; $s.Arguments = '""' + $env:LOCALAPPDATA + '\LIS-Tools\launch_ie.vbs""'; $s.IconLocation = 'shell32.dll,220'; $s.Save()" 2>nul

echo [OK] 配置完成！
echo.
echo 1. 桌面已生成快捷方式：【启动病历-原生IE】（双击直接打开）
echo 2. 系统已注册 lis-ie:// 直连协议
echo 3. 现在在 LIS 工作台点击【原生IE打开】，即可直接调出该患者病历！
echo.
pause
