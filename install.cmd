@echo off
rem ai-pack - Windows entry point for cmd.exe and PowerShell (.\install.cmd). Needs Node.js 18+ (https://nodejs.org).
where node >nul 2>nul || (echo ai-pack needs Node.js 18 or newer: https://nodejs.org  or: winget install OpenJS.NodeJS.LTS & exit /b 1)
node "%~dp0install.mjs" %*
exit /b %errorlevel%
