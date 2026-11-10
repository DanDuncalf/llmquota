' Launch the LLM quota dashboard hidden and wait for it to exit.
'
' Used as the scheduled-task action. Waiting keeps the task in the Running
' state so its restart policy can revive the service, while window style 0
' keeps the console invisible.
Option Explicit

Dim fso, sh, root, rc
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
rc = sh.Run("cmd.exe /c """ & root & "\scripts\run-service.cmd""", 0, True)
WScript.Quit rc
