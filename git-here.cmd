@echo off
setlocal
set "GITEXE=D:\Tools\PortableGit\cmd\git.exe"
if not exist "%GITEXE%" set "GITEXE=F:\AI\comfui\ComfyUI-aki-v3\git\cmd\git.exe"
set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
"%GITEXE%" -C "%REPO%" %*
