' Windowless launcher for take-profit-watch.mjs. Node has no nodew.exe and Task
' Scheduler pops a console for node.exe even hidden; WScript.Shell.Run with
' intWindowStyle = 0 shows nothing at all.
'
' Paths resolve at runtime from this file's own location, so the repo can live
' anywhere. If node is not installed in the default location, set NODE_EXE
' below to its full path.
Dim sh, fso, here, nodeExe, target, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
target = fso.BuildPath(here, "take-profit-watch.mjs")

nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
If Not fso.FileExists(nodeExe) Then
  nodeExe = "node"   ' fall back to whatever is on PATH
End If

cmd = """" & nodeExe & """ --experimental-sqlite """ & target & """"
sh.Run cmd, 0, False
