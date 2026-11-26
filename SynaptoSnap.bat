@echo off
rem Opens SynaptoSnap in its own window (Edge app mode), falling back to the default browser.
set "APP=%~dp0index.html"
set "URL=file:///%APP:\=/%"
where msedge >nul 2>nul && (start "" msedge --app="%URL%" & exit /b)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app="%URL%" & exit /b)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app="%URL%" & exit /b)
start "" "%APP%"
