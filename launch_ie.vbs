' iMedical LIS - Native 32-bit IE Launcher
Dim ie, url
If WScript.Arguments.Count > 0 Then
    url = WScript.Arguments(0)
Else
    url = "http://192.168.31.111:9111/iMedicalLIS/login/form/Index.aspx"
End If

' Strip custom protocol prefix if called from browser via lis-ie:// or lis-ie:
If InStr(LCase(url), "lis-ie://") = 1 Then
    url = Mid(url, 10)
ElseIf InStr(LCase(url), "lis-ie:") = 1 Then
    url = Mid(url, 8)
End If

' Remove any surrounding quotes
url = Replace(url, """", "")

On Error Resume Next
Set ie = CreateObject("InternetExplorer.Application")
If Err.Number <> 0 Then
    MsgBox "Failed to launch native IE: " & Err.Description, 16, "Error"
    WScript.Quit
End If

ie.Visible = True
ie.Navigate url
