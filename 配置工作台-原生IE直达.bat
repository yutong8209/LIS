<# :
@echo off
title LIS Native IE Setup
echo ============================================================
echo   Configuring one-click native 32-bit IE for LIS workbench...
echo ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((Get-Content -LiteralPath '%~f0' -Encoding UTF8) -join [Environment]::NewLine)"
echo.
pause
exit /b
#>
$dir = Join-Path $env:LOCALAPPDATA 'LIS-Tools'
if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$vbs = Join-Path $dir 'launch_ie.vbs'
$code = @'
' iMedical LIS - Native 32-bit IE Launcher (URL rewrite + in-page hooks)
' v2: fix EMR freeze in native IE:
'  1) rewrite internal IPs (10.0.29.x / 10.0.12.248:8800) to gateway before Navigate
'  2) after load, inject JS hooks via COM into page + all same-origin iframes,
'     patching window.open/showModalDialog/websys_createWindow/websys_lu/
'     showImg/showReport and <a href> -- same rules as the userscript in Chrome
'  3) fallback: launch 32-bit iexplore.exe directly if COM creation fails
Option Explicit
Dim ws, ie, url, rawUrl, jsHooks
Const GATEWAY = "http://192.168.31.111:9111"

url = ""
If WScript.Arguments.Count > 0 Then
    rawUrl = Trim(WScript.Arguments(0))
End If

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

On Error Resume Next
Set ie = CreateObject("InternetExplorer.Application")
If Err.Number <> 0 Then
    On Error GoTo 0
    Set ws = CreateObject("WScript.Shell")
    ws.Run """C:\Program Files (x86)\Internet Explorer\iexplore.exe"" """ & url & """", 1, False
    WScript.Quit
End If
On Error GoTo 0

ie.Visible = True
ie.Navigate url

Set ws = CreateObject("WScript.Shell")
WScript.Sleep 300
ws.AppActivate "Internet Explorer"

' inject hooks for ~40s: covers first paint plus late-added child frames
' (the __lisHooked flag in jsHooks makes repeated injection idempotent)
Dim attempts
attempts = 0
Do While attempts < 80
    WScript.Sleep 500
    attempts = attempts + 1
    On Error Resume Next
    If Err.Number <> 0 Then Exit Do
    If ie.readyState = 4 Then
        InjectIntoDoc ie.Document
    End If
    If Err.Number <> 0 Then Exit Do
    On Error GoTo 0
Loop

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
    d.parentWindow.execScript jsHooks, "JScript"
    Dim f, n, sd
    n = d.frames.length
    For f = 0 To n - 1
        Set sd = Nothing
        Set sd = d.frames(f).document
        If Not sd Is Nothing Then InjectIntoDoc sd
    Next
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

Write-Host ''
Write-Host '[OK] 配置完成！' -ForegroundColor Green
Write-Host '1. 桌面已生成快捷方式【启动病历-原生IE】（双击直接打开）'
Write-Host '2. 已注册 lis-ie:// 直连协议'
Write-Host '3. 已把 192.168.31.111 / 10.0.29.x 加入 IE 本地 Intranet 区域，并启用内网 ActiveX'
Write-Host '   （修复病历页在 IE 里因 ActiveX 被拦截而卡住不动的问题）'
Write-Host '4. 现在在 LIS 工作台点击【原生IE打开】即可直接调出该患者病历'
Write-Host '注意：请重启 IE 或注销重登一次，让区域与 ActiveX 设置生效'
