@echo off
setlocal
cd /d "%~dp0"
title Stop Agentic Trading Games Demo

if not exist "%~dp0runtime\node.exe" goto missing
if not exist "%~dp0stop-demo.mjs" goto missing

"%~dp0runtime\node.exe" "%~dp0stop-demo.mjs"
set "DEMO_EXIT=%ERRORLEVEL%"
echo.
echo Press any key to close this window.
pause >nul
exit /b %DEMO_EXIT%

:missing
echo The demo files are not all available.
echo Run STOP_DEMO from the extracted demo folder, not from inside the ZIP.
echo.
echo Press any key to close this window.
pause >nul
exit /b 1
