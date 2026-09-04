<# :
@echo off
chcp 936 >nul
title 启用 LIS 工作台一键唤醒原生 IE 病历
echo ============================================================
echo   正在为当前电脑配置【工作台一键唤醒原生 32 位 IE 病历】...
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((Get-Content -LiteralPath '%~f0') -join [Environment]::NewLine)"
echo.
pause
exit /b
#>
$dir = Join-Path $env:LOCALAPPDATA 'LIS-Tools'
if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$vbs = Join-Path $dir 'launch_ie.vbs'
$code = @'
' iMedical LIS - Native 32-bit IE Launcher
Dim ie, ws, url, rawUrl
url = ""
If WScript.Arguments.Count > 0 Then
    rawUrl = Trim(WScript.Arguments(0))
End If
If Len(rawUrl) > 0 Then
    url = rawUrl
    url = Replace(url, "lis-ie://", "", 1, -1, 1)
    url = Replace(url, "lis-ie:", "", 1, -1, 1)
    url = Replace(url, Chr(34), "")
    url = Trim(url)
End If
If Len(url) = 0 Or InStr(LCase(url), "http") <> 1 Then
    On Error Resume Next
    Dim html, clip
    Set html = CreateObject("htmlfile")
    clip = Trim(html.parentWindow.clipboardData.getData("text"))
    If InStr(LCase(clip), "http://") = 1 Or InStr(LCase(clip), "https://") = 1 Then
        If InStr(clip, "iMedical") > 0 Or InStr(clip, "websys.csp") > 0 Then
            url = clip
        End If
    End If
    On Error GoTo 0
End If
If Len(url) = 0 Or InStr(LCase(url), "http") <> 1 Then
    url = "http://192.168.31.111:9111/iMedicalLIS/login/form/Index.aspx"
End If
On Error Resume Next
Set ie = CreateObject("InternetExplorer.Application")
If Err.Number <> 0 Then
    MsgBox "Failed to launch native IE: " & Err.Description, 16, "Error"
    WScript.Quit
End If
ie.Visible = True
ie.Navigate url
Set ws = CreateObject("WScript.Shell")
WScript.Sleep 300
ws.AppActivate "Internet Explorer"
'@
$code | Out-File -FilePath $vbs -Encoding ascii
New-Item -Path 'HKCU:\Software\Classes\lis-ie\shell\open\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\lis-ie' -Name '(Default)' -Value 'URL:LIS Native IE Launcher Protocol'
Set-ItemProperty -Path 'HKCU:\Software\Classes\lis-ie' -Name 'URL Protocol' -Value ''
Set-ItemProperty -Path 'HKCU:\Software\Classes\lis-ie\shell\open\command' -Name '(Default)' -Value ('wscript.exe "' + $vbs + '" "%1"')
$ws = New-Object -ComObject WScript.Shell
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) '启动病历-原生IE.lnk'
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = 'wscript.exe'
$s.Arguments = '"' + $vbs + '"'
$s.IconLocation = 'shell32.dll,220'
$s.Save()

Write-Host "[OK] 配置成功！" -ForegroundColor Green
Write-Host ""
Write-Host "1. 桌面已生成快捷方式：【启动病历-原生IE】（双击直接打开）"
Write-Host "2. 系统已注册 lis-ie:// 直连协议"
Write-Host "3. 现在在 LIS 工作台点击【⚡ 原生IE打开】，即可直接调出该患者病历！"
Write-Host ""
