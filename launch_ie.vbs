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
    url = Replace(url, """", "")
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
