@echo off
setlocal
set "GITEXE=D:\Tools\PortableGit\cmd\git.exe"
if not exist "%GITEXE%" set "GITEXE=F:\AI\comfui\ComfyUI-aki-v3\git\cmd\git.exe"
"%GITEXE%" -C "%~dp0" %*
