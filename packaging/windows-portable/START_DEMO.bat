@echo off
setlocal
cd /d "%~dp0"
title Agentic Trading Games Demo

if not exist "%~dp0runtime\node.exe" goto missing
if not exist "%~dp0launcher.mjs" goto missing
if not exist "%~dp0package.json" goto missing
if not exist "%~dp0src\server.js" goto missing
if not exist "%~dp0src\db.js" goto missing
if not exist "%~dp0src\platform.js" goto missing
if not exist "%~dp0src\games.js" goto missing
if not exist "%~dp0src\random.js" goto missing
if not exist "%~dp0public\index.html" goto missing
if not exist "%~dp0public\instructor.html" goto missing
if not exist "%~dp0public\styles.css" goto missing
if not exist "%~dp0public\app.js" goto missing
if not exist "%~dp0public\instructor.js" goto missing
if not exist "%~dp0app-data.mjs" goto missing

"%~dp0runtime\node.exe" --use-system-ca --no-warnings=ExperimentalWarning "%~dp0launcher.mjs"
set "DEMO_EXIT=%ERRORLEVEL%"
if "%DEMO_EXIT%"=="0" exit /b 0

echo.
echo The demo did not start. Read the message above.
echo Take a picture of this window and send it to the person who gave you the ZIP file.
echo.
echo Press any key to close this window.
pause >nul
exit /b %DEMO_EXIT%

:missing
echo ================================================================
echo THE DEMO FILES ARE NOT ALL AVAILABLE
echo ================================================================
echo Do not run START_DEMO from inside the ZIP file.
echo Right-click the ZIP, choose Extract All, and run this file from
echo the new extracted folder.
echo.
echo Press any key to close this window.
pause >nul
exit /b 1
