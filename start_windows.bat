@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
set "NPM_LOG=%~dp0npm-install.log"
set "BROWSER_LOG=%~dp0chromium-install.log"

echo ================================================================
echo   HTML to FIG Studio - Windows launcher
echo ================================================================
echo Working folder: %CD%
echo.

if not exist "package.json" goto package_missing
where node.exe >nul 2>&1
if errorlevel 1 goto node_missing
where npm.cmd >nul 2>&1
if errorlevel 1 goto npm_missing
where npx.cmd >nul 2>&1
if errorlevel 1 goto npm_missing

echo Node.js:
node.exe --version
if errorlevel 1 goto node_missing
echo npm:
call npm.cmd --version
if errorlevel 1 goto npm_missing
echo.

call npm.cmd ls --depth=0 >nul 2>&1
if errorlevel 1 goto install_deps
goto install_browser

:install_deps
echo [1/2] Installing npm dependencies...
echo Download requires internet access.
echo Full log: "%NPM_LOG%"
call npm.cmd ci --no-audit --no-fund --loglevel=verbose >"%NPM_LOG%" 2>&1
if errorlevel 1 goto npm_failed
echo npm dependencies installed successfully.
echo.

:install_browser
if defined PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH goto start_server
echo [2/2] Checking/Installing Chromium for Playwright...
echo Full log: "%BROWSER_LOG%"
call npx.cmd playwright install chromium >"%BROWSER_LOG%" 2>&1
if errorlevel 1 goto browser_failed
echo Chromium is ready.
echo.

:start_server
echo Starting local web server...
call npm.cmd start
if errorlevel 1 goto server_failed
echo Server stopped.
pause
exit /b 0

:node_missing
echo [ERROR] Node.js was not found or could not start.
echo Install Node.js LTS from https://nodejs.org/ and restart this launcher.
pause
exit /b 1

:npm_missing
echo [ERROR] npm.cmd or npx.cmd was not found or could not start.
echo Repair/reinstall Node.js LTS (which includes npm) from https://nodejs.org/.
pause
exit /b 1

:package_missing
echo [ERROR] package.json was not found in "%CD%".
echo Extract the WHOLE ZIP file, then run start_windows.bat inside the extracted folder.
pause
exit /b 1

:npm_failed
echo.
echo [ERROR] npm install failed. The error details are printed below.
echo Log: "%NPM_LOG%"
echo -----------------------------------------------------------
type "%NPM_LOG%"
echo -----------------------------------------------------------
echo Please send the last lines mentioning npm error / ERR_ / EPERM / ENOTFOUND / ETIMEDOUT.
pause
exit /b 1

:browser_failed
echo.
echo [ERROR] Playwright Chromium installation failed.
echo Log: "%BROWSER_LOG%"
echo -----------------------------------------------------------
type "%BROWSER_LOG%"
echo -----------------------------------------------------------
pause
exit /b 1

:server_failed
echo.
echo [ERROR] The server could not start. Read the messages above.
echo Check if port 4318 is already in use.
pause
exit /b 1
