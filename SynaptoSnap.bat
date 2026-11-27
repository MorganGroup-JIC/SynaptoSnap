@echo off
rem Starts SynaptoSnap. tools\launch.ps1 serves the app to this computer only (http://localhost:47321/) and opens
rem it in Edge, where it can be installed as an app: its own window, a sharp taskbar icon, and it starts offline.
rem Without PowerShell, the app opens as a file in an Edge window, as before.
where powershell >nul 2>nul && (
  start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tools\launch.ps1"
  exit /b
)
set "APP=%~dp0index.html"
set "URL=file:///%APP:\=/%"
where msedge >nul 2>nul && (start "" msedge --app="%URL%" & exit /b)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app="%URL%" & exit /b)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app="%URL%" & exit /b)
start "" "%APP%"
