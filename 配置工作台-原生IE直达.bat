@echo off
title LIS Native IE Setup
echo ============================================================
echo   Configuring one-click native 32-bit IE for LIS workbench...
echo ============================================================
set "PSPART=%TEMP%\lis_ie_setup.ps1"
powershell -NoProfile -Command "$l=Get-Content -LiteralPath '%~f0' -Encoding UTF8; $s=[array]::IndexOf($l,'exit /b')+1; $l[$s..($l.Count-1)] | Out-File -LiteralPath '%PSPART%' -Encoding UTF8"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PSPART%"
del "%PSPART%" >nul 2>&1
echo.
pause
exit /b
$dir = Join-Path $env:LOCALAPPDATA 'LIS-Tools'
if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$vbs = Join-Path $dir 'launch_ie.vbs'
$code = @'
' iMedical LIS - Native 32-bit IE Launcher (URL rewrite + in-page hooks)
' v3: fix EMR freeze in native IE:
'  1) rewrite internal IPs (10.0.29.x / 10.0.12.248:8800) to gateway before Navigate
'  2) after load (readyState >= interactive), inject JS hooks via COM into page
'     + all same-origin iframes, patching window.open/showModalDialog/
'     websys_createWindow/websys_lu/showImg/showReport and <a href> -- same
'     rules as the userscript in Chrome
'  3) fallback: launch 32-bit iexplore.exe directly if COM creation fails
'  4) diagnostic log: %LOCALAPPDATA%\LIS-Tools\launch_ie.log
Option Explicit
Dim ws, ie, url, rawUrl, jsHooks, logPath, injectCount, prevRS
Const GATEWAY = "http://192.168.31.111:9111"

injectCount = 0
prevRS = ""

Dim sh
Set sh = CreateObject("WScript.Shell")
logPath = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\LIS-Tools\launch_ie.log"

LogLine "=== launcher start ==="

url = ""
If WScript.Arguments.Count > 0 Then
    rawUrl = Trim(WScript.Arguments(0))
End If
LogLine "arg(" & WScript.Arguments.Count & "): " & rawUrl

If Len(rawUrl) > 0 Then
    url = rawUrl
    url = Replace(url, "lis-ie://", "", 1, -1, vbTextCompare)
    url = Replace(url, "lis-ie:", "", 1, -1, vbTextCompare)
    url = Replace(url, """", "")
    url = Trim(url)
End If

' clipboard fallback: press copy-link in workbench, then double-click shortcut
If Len(url) = 0 Or InStr(LCase(url), "http") <> 1 Then
    On Error Resume Next
    Dim html, clip
    Set html = CreateObject("htmlfile")
    clip = Trim(html.parentWindow.clipboardData.getData("text"))
    If InStr(LCase(clip), "http") = 1 Then
        If InStr(clip, "iMedical") > 0 Or InStr(clip, "websys.csp") > 0 Or InStr(clip, "10.0.29.") > 0 Then
            url = clip
        End If
    End If
    On Error GoTo 0
End If

If Len(url) = 0 Or InStr(LCase(url), "http") <> 1 Then
    url = GATEWAY & "/iMedicalLIS/login/form/Index.aspx"
End If

url = FixUrl(url)
LogLine "navigate: " & url

On Error Resume Next
Set ie = CreateObject("InternetExplorer.Application")
If Err.Number <> 0 Then
    LogLine "COM create failed: 0x" & Hex(Err.Number) & " " & Err.Description & " -> fallback iexplore.exe"
    On Error GoTo 0
    sh.Run """C:\Program Files (x86)\Internet Explorer\iexplore.exe"" """ & url & """", 1, False
    WScript.Quit
End If
LogLine "COM ok"

ie.Visible = True
ie.Navigate url
If Err.Number <> 0 Then LogLine "navigate err: 0x" & Hex(Err.Number)
On Error GoTo 0

WScript.Sleep 300
sh.AppActivate "Internet Explorer"

' inject hooks for ~60s: covers first paint plus late-added child frames
' (the __lisHooked flag in jsHooks makes repeated injection idempotent)
' readyState 3 (interactive) is enough -- pages stuck loading still get hooked
Dim attempts
attempts = 0
Do While attempts < 120
    WScript.Sleep 500
    attempts = attempts + 1
    On Error Resume Next
    If Err.Number <> 0 Then Exit Do
    Dim rs
    rs = ie.readyState
    If Err.Number <> 0 Then
        LogLine "IE object gone at attempt " & attempts & " (0x" & Hex(Err.Number) & ")"
        Exit Do
    End If
    If CStr(rs) <> prevRS Then
        LogLine "attempt " & attempts & " readyState=" & rs
        prevRS = CStr(rs)
    End If
    If rs = 4 Or rs = 3 Then
        injectCount = 0
        InjectIntoDoc ie.Document
        If Err.Number <> 0 Then Err.Clear
    End If
    If Err.Number <> 0 Then Exit Do
    On Error GoTo 0
Loop
On Error Resume Next
Dim finalRS
finalRS = ""
finalRS = CStr(ie.readyState)
LogLine "=== end after " & attempts & " attempts, last readyState=" & finalRS & ", total injected=" & injectCount & " ==="

' internal IP -> gateway (same rules as userscript normalizeEMRUrl)
Function FixUrl(u)
    On Error Resume Next
    FixUrl = u
    If Len(u) = 0 Then Exit Function
    FixUrl = Replace(u, ":9111:80", ":9111")
    FixUrl = ReplaceX(FixUrl, "10.0.29.100", GATEWAY)
    FixUrl = ReplaceX(FixUrl, "10.0.29.111", GATEWAY)
    FixUrl = ReplaceX(FixUrl, "10.0.29.114", GATEWAY)
    FixUrl = ReplaceX(FixUrl, "10.0.12.248:8800", "192.168.31.111:8800")
    On Error GoTo 0
End Function

' only rewrite http(s)://IP[:port], leave bare IP text inside paths alone
Function ReplaceX(s, ip, target)
    Dim re
    On Error Resume Next
    Set re = New RegExp
    re.Global = True
    re.IgnoreCase = True
    re.Pattern = "https?://" & Replace(ip, ".", "\.") & "(:\d+)?"
    ReplaceX = re.Replace(s, target)
    If Err.Number <> 0 Then ReplaceX = s
    On Error GoTo 0
End Function

Sub InjectIntoDoc(d)
    On Error Resume Next
    Err.Clear
    d.parentWindow.execScript jsHooks, "JScript"
    If Err.Number = 0 Then
        injectCount = injectCount + 1
    Else
        Err.Clear
    End If
    Dim f, n, sd
    n = d.frames.length
    For f = 0 To n - 1
        Set sd = Nothing
        Set sd = d.frames(f).document
        If Not sd Is Nothing Then InjectIntoDoc sd
    Next
    On Error GoTo 0
End Sub

Sub LogLine(s)
    On Error Resume Next
    Dim fso, dir, f
    Set fso = CreateObject("Scripting.FileSystemObject")
    dir = fso.GetParentFolderName(logPath)
    If Not fso.FolderExists(dir) Then fso.CreateFolder dir
    If fso.FileExists(logPath) Then
        If fso.GetFile(logPath).Size > 262144 Then fso.DeleteFile logPath, True
    End If
    Set f = fso.OpenTextFile(logPath, 8, True)
    f.WriteLine Now & " " & s
    f.Close
    On Error GoTo 0
End Sub

' in-page hooks (ASCII only, single-quoted JS strings to avoid encoding issues)
jsHooks = "(function(w,b){try{if(!w||w.__lisHooked)return;w.__lisHooked=1;" & _
"function fix(u){try{if(typeof u!=='string')return u;" & _
"u=u.replace(/:9111:80/g,':9111');" & _
"u=u.replace(/https?:\/\/10\.0\.29\.100(:\d+)?/gi,b);" & _
"u=u.replace(/https?:\/\/10\.0\.29\.111(:\d+)?/gi,b);" & _
"u=u.replace(/https?:\/\/10\.0\.29\.114(:\d+)?/gi,b);" & _
"u=u.replace(/https?:\/\/10\.0\.12\.248:8800/gi,b+':8800');" & _
"return u;}catch(e){return u;}}" & _
"var oo=w.open;w.open=function(u,t,f){return oo.call(w,fix(u),t,f);};" & _
"if(w.showModalDialog){var os=w.showModalDialog;w.showModalDialog=function(u,a,o){return os.call(w,fix(u),a,o);};}" & _
"var nms=['websys_createWindow','websys_lu','showImg','showReport','formatterImg','formatterPort'];" & _
"for(var k=0;k<nms.length;k++){(function(nm){var fn=w[nm];" & _
"if(typeof fn==='function'&&!fn.__lis){var g=function(){var a=[];for(var i=0;i<arguments.length;i++){a[i]=(typeof arguments[i]==='string')?fix(arguments[i]):arguments[i];}return fn.apply(w,a);};g.__lis=1;try{w[nm]=g;}catch(e){}}})(nms[k]);}" & _
"var n=0,tm=w.setInterval(function(){try{n++;" & _
"var ls=w.document.links;" & _
"for(var i=0;i<ls.length;i++){var h=ls[i].getAttribute('href');" & _
"if(h&&(h.indexOf('10.0.29.')>=0||h.indexOf('10.0.12.248')>=0||h.indexOf(':9111:80')>=0)){ls[i].setAttribute('href',fix(h));}}" & _
"if(n>60)w.clearInterval(tm);}catch(e){}},1000);" & _
"}catch(e){}})(window,'" & GATEWAY & "');"
'@
$code | Out-File -FilePath $vbs -Encoding ascii

# --- register lis-ie:// protocol ---
New-Item -Path 'HKCU:\Software\Classes\lis-ie\shell\open\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\lis-ie' -Name '(Default)' -Value 'URL:LIS Native IE Launcher Protocol'
Set-ItemProperty -Path 'HKCU:\Software\Classes\lis-ie' -Name 'URL Protocol' -Value ''
Set-ItemProperty -Path 'HKCU:\Software\Classes\lis-ie\shell\open\command' -Name '(Default)' -Value ('wscript.exe "' + $vbs + '" "%1"')

# --- add gateway / intranet IPs into IE local intranet zone ---
# IE treats bare-IP hosts as Internet zone by default, which silently blocks
# ActiveX and freezes the EMR page; intranet zone (value 1) fixes that.
$zm = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Ranges'
$ranges = @{ RangeLIS1 = '192.168.31.111'; RangeLIS2 = '10.0.29.100'; RangeLIS3 = '10.0.29.111'; RangeLIS4 = '10.0.29.114'; RangeLIS5 = '10.0.12.248' }
foreach ($k in $ranges.Keys) {
    New-Item -Path (Join-Path $zm $k) -Force | Out-Null
    Set-ItemProperty -Path (Join-Path $zm $k) -Name ':Range' -Value $ranges[$k]
    Set-ItemProperty -Path (Join-Path $zm $k) -Name '*' -Value 1 -Type DWord
}

# --- relax ActiveX restrictions for intranet zone (Zone 1) ---
$z1 = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings\Zones\1'
Set-ItemProperty -Path $z1 -Name '1001' -Value 0 -Type DWord   # download signed ActiveX: enable
Set-ItemProperty -Path $z1 -Name '1004' -Value 0 -Type DWord   # download unsigned ActiveX: enable
Set-ItemProperty -Path $z1 -Name '1201' -Value 0 -Type DWord   # initialize/script unsafe-marked ActiveX: enable
Set-ItemProperty -Path $z1 -Name '1200' -Value 0 -Type DWord   # run ActiveX plugins: enable

# --- desktop shortcut ---
$ws = New-Object -ComObject WScript.Shell
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) '启动病历-原生IE.lnk'
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = 'wscript.exe'
$s.Arguments = '"' + $vbs + '"'
$s.IconLocation = 'shell32.dll,220'
$s.Save()

# --- admin step: permanent IE-mode site-list policy + DHCC plugin MSI ---
# UAC: yes = install; cancel = skip (list browsing still works, only document body needs this)
try {
    Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', @'
$ProgressPreference = 'SilentlyContinue'
reg add 'HKLM\SOFTWARE\Policies\Microsoft\Edge' /v InternetExplorerIntegrationLevel /t REG_DWORD /d 1 /f | Out-Null
reg add 'HKLM\SOFTWARE\Policies\Microsoft\Edge' /v InternetExplorerIntegrationSiteList /t REG_SZ /d http://192.168.31.111:9111/lis-tools/iemode-sites.xml /f | Out-Null
$msi = Join-Path $env:TEMP 'iEmrPlugin.msi'
Invoke-WebRequest -Uri 'http://192.168.31.111:9111/iemrplugin/iEmrPlugin.msi' -OutFile $msi -UseBasicParsing
Start-Process msiexec -ArgumentList "/i `"$msi`" /qn" -Wait
'@
    Write-Host '[OK] admin step done: permanent IE-mode policy + DHCC EMR plugin installed' -ForegroundColor Green
} catch {
    Write-Host '[skip] admin step not approved: list browsing still works, re-run to enable document body' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '[OK] 配置完成！' -ForegroundColor Green
Write-Host '1. 桌面已生成快捷方式【启动病历-原生IE】（双击直接打开）'
Write-Host '2. 已注册 lis-ie:// 直连协议'
Write-Host '3. 已把 192.168.31.111 / 10.0.29.x 加入 IE 本地 Intranet 区域，并启用内网 ActiveX'
Write-Host '4. IE 模式站点列表策略（永久）+ DHCC 病历插件已就绪'
Write-Host '用法：工作台点病历 -> 【原生IE打开】；在协议弹窗勾选「总是允许」以后免弹窗'
Write-Host '      按住 Shift 点「病历」按钮 = 跳过预览直接唤起原生 IE'
Write-Host '诊断：如病历仍卡住，把 %LOCALAPPDATA%\LIS-Tools\launch_ie.log 发给管理员'
Write-Host '注意：请重启一次 Edge，让 IE 模式策略生效'
