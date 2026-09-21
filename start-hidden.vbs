' Claude Code Task Board - start the server with no console window (for Windows Task Scheduler).
' Usage: wscript.exe "<this file>" ["<path to node.exe>"]
' Without the second argument, "node" from PATH is used. Output is appended to server.log next to this file.
' NOTE: keep this file ASCII-only - wscript reads .vbs as the system ANSI codepage, so UTF-8 text breaks parsing.
Option Explicit
Dim fso, shell, here, nodeExe, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)

If WScript.Arguments.Count > 0 Then
  nodeExe = WScript.Arguments(0)
Else
  nodeExe = "node"
End If

' cmd /c wraps the whole command in one more pair of quotes, because cmd strips the outermost pair.
' shell.Run(cmd, 0, False): 0 = hidden window, False = do not wait for it to finish.
cmd = "cmd /c """ & "cd /d " & Q(here) & " && " & Q(nodeExe) & " server.mjs --tailscale >> server.log 2>&1" & """"
shell.Run cmd, 0, False

Function Q(s)
  Q = """" & s & """"
End Function
