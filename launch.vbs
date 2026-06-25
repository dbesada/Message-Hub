' Message Hub Launcher
' Starts the Flask server if not already running, then opens the app in Chrome app-mode.

Dim oShell, oHTTP, bRunning

Set oShell = CreateObject("WScript.Shell")
Set oHTTP  = CreateObject("MSXML2.ServerXMLHTTP")

bRunning = False
On Error Resume Next
oHTTP.open "GET", "http://localhost:3000/", False
oHTTP.setTimeouts 300, 300, 1500, 1500
oHTTP.send
If oHTTP.status = 200 Then bRunning = True
On Error GoTo 0

If Not bRunning Then
    ' Start server in background (hidden window)
    oShell.Run "python C:\AI\quo-webapp\server.py", 0, False
    WScript.Sleep 2500
End If

' Open in Brave app-mode (no address bar / tabs — feels like a native app)
oShell.Run """C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"" --app=http://localhost:3000 --window-size=1280,820", 1, False
